// Pure helpers for live Icecast streaming. Kept separate from the StreamManager
// (which owns mediasoup/ffmpeg/process state) so the argument and URL builders
// are trivially unit-testable. Streaming reuses recording-util's PortAllocator,
// SDP builders and MixInput type — the two pipelines are otherwise independent
// (each taps the SFU with its own consumers), so a room can record, stream,
// both, or neither.

export type StreamFormat = "mp3" | "opus";

export interface IcecastConfig {
  host: string;
  port: number;
  // Mount point, always normalized to a leading "/", e.g. "/sonicroom".
  mount: string;
  username: string;
  password: string;
  format: StreamFormat;
  bitrateKbps: number;
  // Optional human-readable stream name advertised to listeners.
  name?: string;
}

// MIME / content-type Icecast advertises for each output format.
export function contentTypeFor(format: StreamFormat): string {
  return format === "opus" ? "application/ogg" : "audio/mpeg";
}

// Build the icecast:// URL ffmpeg connects to. The username and password are
// percent-encoded so credentials with "@" / ":" don't corrupt the authority.
// The whole thing is passed to ffmpeg as a single argv element (spawn, no
// shell), so there's no shell-injection surface; we still validate host/mount
// upstream (signaling) to keep the URL well-formed.
export function buildIcecastUrl(cfg: IcecastConfig): string {
  const mount = cfg.mount.startsWith("/") ? cfg.mount : `/${cfg.mount}`;
  const user = encodeURIComponent(cfg.username);
  const pass = encodeURIComponent(cfg.password);
  return `icecast://${user}:${pass}@${cfg.host}:${cfg.port}${mount}`;
}

// Build the ffmpeg args for the live room mixer. Inputs are SDP files (one per
// currently-active producer) describing the RTP mediasoup pushes to a local
// UDP port. A permanent silent stereo "anchor" (anullsrc) is mixed in as input
// 0 so:
//   - the filtergraph always has a continuous 48 kHz stereo clock, and
//   - the Icecast source stays connected (streaming silence) even when there
//     are zero active producers (room quiet / everyone muted / pre-SFU).
// Per producer input: upmix to stereo (amix adopts the first input's layout)
// and aresample async=1 to paper over small timing gaps. normalize=0 keeps
// every voice at full level instead of dividing by the input count.
//
// Only *active* (unmuted, present) producers are ever passed in: a paused
// producer sends no RTP, which would stall amix, so the manager rebuilds the
// mixer without it rather than feeding amix a silent-but-open input.
export function buildStreamArgs(sdpPaths: string[], cfg: IcecastConfig): string[] {
  const args: string[] = ["-hide_banner", "-loglevel", "warning"];

  // Input 0: silent stereo anchor.
  args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
  // Inputs 1..N: one RTP stream per active producer, described by its SDP.
  for (const sdp of sdpPaths) {
    args.push("-protocol_whitelist", "file,udp,rtp", "-fflags", "+genpts", "-f", "sdp", "-i", sdp);
  }

  const total = sdpPaths.length + 1; // + anchor
  const parts: string[] = [];
  const labels: string[] = [];
  for (let i = 0; i < total; i++) {
    const label = `a${i}`;
    labels.push(`[${label}]`);
    parts.push(
      `[${i}:a]aformat=channel_layouts=stereo:sample_rates=48000,aresample=async=1[${label}]`,
    );
  }
  // With only the anchor, amix=inputs=1 is pointless — just map the anchor.
  const filter =
    total === 1
      ? `${parts[0]}`
      : `${parts.join(";")};${labels.join("")}amix=inputs=${total}:normalize=0[out]`;
  const outLabel = total === 1 ? "[a0]" : "[out]";
  args.push("-filter_complex", filter, "-map", outLabel);

  const bitrate = `${cfg.bitrateKbps}k`;
  if (cfg.format === "opus") {
    args.push("-c:a", "libopus", "-b:a", bitrate, "-f", "ogg");
  } else {
    args.push("-c:a", "libmp3lame", "-b:a", bitrate, "-f", "mp3");
  }

  args.push("-content_type", contentTypeFor(cfg.format));
  args.push("-ice_name", cfg.name && cfg.name.trim() ? cfg.name.trim() : "SonicRoom");
  // Bound a hung Icecast connection: if a connect/handshake/write stalls for
  // this long, ffmpeg gives up with "Connection timed out" instead of blocking
  // for the OS default (~minutes). 10 s never trips a healthy source (which
  // writes audio continuously) but fails a dead target fast. Must sit right
  // before the output URL — it's a protocol option, invalid before lavfi inputs.
  args.push("-rw_timeout", String(ICECAST_RW_TIMEOUT_US));
  args.push(buildIcecastUrl(cfg));
  return args;
}

// ffmpeg AVIO read/write timeout for the Icecast connection, in microseconds.
const ICECAST_RW_TIMEOUT_US = 10_000_000;

// Map the tail of the mixer ffmpeg's stderr (plus how it exited) to a short,
// actionable message for whoever started the stream. ffmpeg's own wording
// ("Connection timed out", "Server returned 401 Unauthorized", …) is accurate
// but cryptic and easy to miss in the logs; this says what to actually fix.
// Matching is on lowercased substrings, and deliberately avoids bare numbers
// like "401"/"403" — ffmpeg prefixes every log line with a hex pointer (e.g.
// "[tcp @ 0x62d8…]") that could contain those digits and false-match.
export function classifyStreamError(
  stderr: string,
  cfg: IcecastConfig,
  code?: number | null,
  signal?: string | null,
): string {
  const text = stderr.toLowerCase();
  const target = `${cfg.host}:${cfg.port}`;
  const has = (...needles: string[]) => needles.some((n) => text.includes(n));

  if (has("unauthorized", "authentication", "bad password"))
    return `Authentication failed — check the source username and password for ${target}.`;
  if (has("forbidden", "mountpoint", "mount in use", "source already connected"))
    return `The mount point ${cfg.mount} was rejected — it may already be in use or not permitted on ${cfg.host}.`;
  if (has("connection refused"))
    return `Connection refused by ${target} — make sure Icecast is running and the port is correct.`;
  if (has("name or service not known", "failed to resolve", "could not resolve", "no such host"))
    return `Could not resolve host "${cfg.host}" — check the hostname.`;
  if (has("network is unreachable", "no route to host", "unreachable"))
    return `${target} is unreachable — check the address and your network connection.`;
  if (has("timed out", "timeout", "etimedout"))
    return `Connection to ${target} timed out — check the host and port and that the server is reachable.`;
  if (has("invalid data", "could not write header", "muxer does not support"))
    return `${cfg.host} rejected the stream — check the mount, format, and that it's an Icecast2 server.`;

  // No recognized signature: surface ffmpeg's own last meaningful line if there
  // is one, otherwise describe how the process died.
  const lastLine = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  if (lastLine) return `Streaming to ${target} failed: ${lastLine}`;
  if (signal) return `Streaming to ${target} stopped (ffmpeg killed by ${signal}).`;
  return `Streaming to ${target} failed (ffmpeg exited with code ${code ?? "unknown"}).`;
}
