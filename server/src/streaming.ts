import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir as fsMkdir, writeFile as fsWriteFile, rm as fsRm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PortAllocator, buildSdp, sdpParamsFromRtp } from "./recording-util.js";
import { buildStreamArgs, classifyStreamError, type IcecastConfig } from "./streaming-util.js";
import type {
  SpawnedProcess,
  RtpConsumer,
  RtpPlainTransport,
  RecordingRouter,
  ProducerInfo,
} from "./recording.js";

// Streaming reuses the same structural mediasoup/process/fs interfaces as
// recording (see recording.ts), so the real Router/PlainTransport/Consumer and
// child_process satisfy it and tests can drive it with the same fakes.
export type StreamRouter = RecordingRouter;

export interface StreamDeps {
  spawn: (command: string, args: string[]) => SpawnedProcess;
  mkdir: (dir: string) => Promise<void>;
  writeFile: (file: string, data: string) => Promise<void>;
  rm: (dir: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  tmpRoot: string;
  ports: PortAllocator;
  ffmpegPath: string;
  rtpListenIp: string;
  // ms to wait after (re)spawning the mixer ffmpeg (so it binds its UDP ports)
  // before resuming the consumers, to avoid losing the first packets.
  resumeDelayMs: number;
  // ms to coalesce a burst of producer changes (e.g. a P2P→SFU switch where
  // everyone produces at once) into a single mixer rebuild — each rebuild is a
  // brief Icecast reconnect, so we don't want one per producer.
  rebuildDebounceMs: number;
  // ms to wait after the very first mixer spawn before declaring the stream up.
  // Long enough for ffmpeg to fail fast on a bad target (refused/auth/DNS) so
  // start() can reject with the real reason; short enough not to stall the UI.
  startupGraceMs: number;
  log: (msg: string) => void;
}

// One producer feed: its dedicated RTP transport/consumer/port and the SDP file
// the mixer reads. `active` is false while the producer is paused (peer muted)
// — an inactive feed is kept (transport/port stay allocated) but excluded from
// the mixer, since a paused producer sends no RTP and would stall amix.
interface ProducerFeed {
  producerId: string;
  peerId: string;
  label?: string;
  source?: string;
  port: number;
  sdpPath: string;
  transport: RtpPlainTransport;
  consumer: RtpConsumer;
  resumed: boolean;
  active: boolean;
}

export interface RoomStream {
  id: string;
  dir: string;
  router: StreamRouter;
  config: IcecastConfig;
  feeds: Map<string, ProducerFeed>;
  mixer: SpawnedProcess | null;
  // Bumped on every mixer (re)spawn; an exit from an older generation (a mixer
  // we deliberately killed during a rebuild) is ignored.
  mixerGen: number;
  building: boolean;
  rebuildPending: boolean;
  rebuildHandle: unknown;
  closing: boolean;
  // Tail of the current mixer's stderr (last few lines). Reset on every spawn so
  // it only ever describes the mixer that's running now; read to explain an exit.
  stderrTail: string[];
  // False until the initial startup grace window elapses without the mixer
  // dying. While false, a mixer exit is a *startup* failure (surfaced through
  // start()'s rejection), not a mid-stream crash (surfaced through onStop).
  started: boolean;
  // The classified reason the initial mixer died during startup, if it did.
  startupError: string | null;
}

// How many trailing ffmpeg stderr lines to keep for diagnosing an exit.
const STDERR_TAIL_MAX = 12;

function safeId(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function createDefaultStreamDeps(overrides: Partial<StreamDeps> = {}): StreamDeps {
  return {
    spawn: (command, args) => nodeSpawn(command, args, { stdio: ["ignore", "pipe", "pipe"] }),
    mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => undefined),
    writeFile: (file, data) => fsWriteFile(file, data),
    rm: (dir) => fsRm(dir, { recursive: true, force: true }),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    setTimer: (fn, ms) => {
      const t = setTimeout(fn, ms);
      (t as { unref?: () => void }).unref?.();
      return t;
    },
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    // A dedicated UDP range, distinct from recording's (50000–50998) and the
    // WebRTC media range (40000–40100), so the two capture pipelines never
    // collide on a port. Loopback only — no firewall change needed.
    tmpRoot: path.join(os.tmpdir(), "sonicroom-streams"),
    ports: new PortAllocator(51000, 51998),
    ffmpegPath: process.env.FFMPEG_PATH || "ffmpeg",
    rtpListenIp: "127.0.0.1",
    resumeDelayMs: 250,
    rebuildDebounceMs: 500,
    startupGraceMs: 1500,
    log: (msg) => console.log(`[streaming] ${msg}`),
    ...overrides,
  };
}

export class StreamManager {
  private readonly deps: StreamDeps;
  private readonly streams = new Map<string, RoomStream>();

  // Set by the signaling layer so the manager can tell the room when a stream
  // stops on its own (the mixer ffmpeg died — bad Icecast credentials, server
  // unreachable, mount in use, …). `reason` is "error" for an unexpected exit.
  onStop?: (roomName: string, reason: "error", message: string) => void;

  constructor(deps: Partial<StreamDeps> = {}) {
    this.deps = createDefaultStreamDeps(deps);
  }

  // True while actively streaming — this is what pins the room to SFU.
  isStreaming(roomName: string): boolean {
    return this.streams.has(roomName);
  }

  getStream(roomName: string): RoomStream | undefined {
    return this.streams.get(roomName);
  }

  // Begin streaming a room to Icecast. Creates one feed per existing producer,
  // then spawns the mixer. Idempotent: a second start while already streaming
  // returns the existing stream (the config is NOT changed mid-stream — stop
  // and start again to retarget).
  async start(
    roomName: string,
    router: StreamRouter,
    producers: ProducerInfo[],
    config: IcecastConfig,
  ): Promise<RoomStream> {
    const existing = this.streams.get(roomName);
    if (existing) return existing;

    const id = `str_${randomUUID()}`;
    const dir = path.join(this.deps.tmpRoot, id);

    const stream: RoomStream = {
      id,
      dir,
      router,
      config,
      feeds: new Map(),
      mixer: null,
      mixerGen: 0,
      building: false,
      rebuildPending: false,
      rebuildHandle: null,
      closing: false,
      stderrTail: [],
      started: false,
      startupError: null,
    };
    // Claim the slot before the first await so a concurrent start()/addProducer
    // sees the room as streaming.
    this.streams.set(roomName, stream);
    try {
      await this.deps.mkdir(dir);
    } catch (err) {
      this.streams.delete(roomName);
      throw err;
    }
    this.deps.log(
      `started ${id} for room "${roomName}" -> ${config.host}:${config.port}${config.mount} ` +
        `(${config.format} ${config.bitrateKbps}k, ${producers.length} producer(s))`,
    );

    for (const info of producers) {
      await this.createFeed(stream, info);
    }
    await this.buildMixer(roomName, stream);

    // Give ffmpeg a moment to fail fast on an unreachable/refused/unauthorized
    // target. If it dies during this window we reject with the real reason (the
    // exit handler recorded it instead of firing onStop) rather than reporting
    // success and then quietly dropping the stream a second later. Slow failures
    // (a connect that times out past this window) still surface afterwards via
    // onStop → streaming-failed.
    if (this.deps.startupGraceMs > 0) await this.deps.sleep(this.deps.startupGraceMs);
    if (stream.startupError) {
      const reason = stream.startupError;
      await this.stop(roomName);
      throw new Error(reason);
    }
    stream.started = true;
    return stream;
  }

  // Add a producer to a live stream (a new speaker, a share, a caster, or a
  // producer that came online after a P2P→SFU switch). No-op unless streaming.
  async addProducer(roomName: string, info: ProducerInfo): Promise<void> {
    const stream = this.streams.get(roomName);
    if (!stream || stream.closing) return;
    if (stream.feeds.has(info.producerId)) return;
    await this.createFeed(stream, info);
    this.scheduleRebuild(roomName, stream);
  }

  // Stop feeding a producer (it closed / its peer left). Closes the feed and
  // releases its port, then rebuilds the mixer without it.
  async removeProducer(roomName: string, producerId: string): Promise<void> {
    const stream = this.streams.get(roomName);
    if (!stream) return;
    const feed = stream.feeds.get(producerId);
    if (!feed) return;
    stream.feeds.delete(producerId);
    this.closeFeed(feed);
    this.scheduleRebuild(roomName, stream);
  }

  // Mark a producer paused/unpaused (peer mute/unmute). A paused producer sends
  // no RTP and would stall amix, so we keep the feed allocated but drop it from
  // the mixer until it resumes. No-op if nothing actually changed.
  setProducerActive(roomName: string, producerId: string, active: boolean): void {
    const stream = this.streams.get(roomName);
    if (!stream) return;
    const feed = stream.feeds.get(producerId);
    if (!feed || feed.active === active) return;
    feed.active = active;
    this.scheduleRebuild(roomName, stream);
  }

  // Stop streaming a room: kill the mixer, close every feed, release ports and
  // remove the working directory. Idempotent.
  async stop(roomName: string): Promise<void> {
    const stream = this.streams.get(roomName);
    if (!stream) return;
    stream.closing = true;
    this.streams.delete(roomName);

    if (stream.rebuildHandle) this.deps.clearTimer(stream.rebuildHandle);
    if (stream.mixer) {
      try {
        stream.mixer.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      stream.mixer = null;
    }
    for (const feed of stream.feeds.values()) this.closeFeed(feed);
    stream.feeds.clear();

    try {
      await this.deps.rm(stream.dir);
    } catch (err) {
      this.deps.log(`failed to remove ${stream.dir}: ${String(err)}`);
    }
    this.deps.log(`stopped ${stream.id} for room "${roomName}"`);
  }

  // Best-effort teardown of every stream (server shutdown).
  async stopAll(): Promise<void> {
    await Promise.all(Array.from(this.streams.keys()).map((name) => this.stop(name)));
  }

  // --- internals ----------------------------------------------------------

  // Create the RTP transport/consumer/port and write the SDP for one producer.
  // The consumer starts paused; buildMixer resumes it once the mixer has bound
  // the port. On any failure the partial resources are cleaned up and the feed
  // is simply skipped (one bad producer can't sink the whole stream).
  private async createFeed(stream: RoomStream, info: ProducerInfo): Promise<void> {
    const { deps } = this;
    let port: number | undefined;
    let transport: RtpPlainTransport | undefined;
    let consumer: RtpConsumer | undefined;
    try {
      port = deps.ports.allocate();
      transport = await stream.router.createPlainTransport({
        listenInfo: { protocol: "udp", ip: deps.rtpListenIp },
        rtcpMux: true,
        comedia: false,
      });
      await transport.connect({ ip: deps.rtpListenIp, port });

      consumer = await transport.consume({
        producerId: info.producerId,
        rtpCapabilities: stream.router.rtpCapabilities,
        paused: true,
      });

      const sdp = buildSdp(sdpParamsFromRtp(consumer.rtpParameters, port));
      const base = `${safeId(info.peerId)}__${safeId(info.producerId)}`;
      const sdpPath = path.join(stream.dir, `${base}.sdp`);
      await deps.writeFile(sdpPath, sdp);

      stream.feeds.set(info.producerId, {
        producerId: info.producerId,
        peerId: info.peerId,
        label: info.label,
        source: info.source,
        port,
        sdpPath,
        transport,
        consumer,
        resumed: false,
        active: true,
      });
      deps.log(`feeding producer ${info.producerId} (peer ${info.peerId}) on port ${port}`);
    } catch (err) {
      try {
        consumer?.close();
      } catch {
        /* ignore */
      }
      try {
        transport?.close();
      } catch {
        /* ignore */
      }
      if (port !== undefined) deps.ports.release(port);
      deps.log(`failed to feed producer ${info.producerId}: ${String(err)}`);
    }
  }

  private closeFeed(feed: ProducerFeed): void {
    try {
      feed.consumer.close();
    } catch {
      /* ignore */
    }
    try {
      feed.transport.close();
    } catch {
      /* ignore */
    }
    this.deps.ports.release(feed.port);
  }

  // Coalesce a burst of producer changes into a single mixer rebuild.
  private scheduleRebuild(roomName: string, stream: RoomStream): void {
    if (stream.closing) return;
    if (stream.rebuildHandle) this.deps.clearTimer(stream.rebuildHandle);
    stream.rebuildHandle = this.deps.setTimer(() => {
      stream.rebuildHandle = null;
      void this.buildMixer(roomName, stream);
    }, this.deps.rebuildDebounceMs);
  }

  // (Re)spawn the mixer ffmpeg over the current set of active feeds, then resume
  // any not-yet-resumed consumers once it has had a chance to bind its ports.
  // Re-entrant calls (a change arriving mid-build) are folded into one more
  // pass via rebuildPending instead of spawning overlapping mixers.
  private async buildMixer(roomName: string, stream: RoomStream): Promise<void> {
    if (stream.closing) return;
    if (stream.building) {
      stream.rebuildPending = true;
      return;
    }
    stream.building = true;
    try {
      do {
        stream.rebuildPending = false;

        if (stream.mixer) {
          try {
            stream.mixer.kill("SIGKILL");
          } catch {
            /* ignore */
          }
          stream.mixer = null;
        }

        const sdpPaths = [...stream.feeds.values()].filter((f) => f.active).map((f) => f.sdpPath);
        const args = buildStreamArgs(sdpPaths, stream.config);
        // Fresh tail for the new mixer — don't blame it for the old one's lines.
        stream.stderrTail.length = 0;
        const gen = ++stream.mixerGen;
        const mixer = this.deps.spawn(this.deps.ffmpegPath, args);
        stream.mixer = mixer;
        this.deps.log(`mixing ${sdpPaths.length} active feed(s) for room "${roomName}"`);

        mixer.stderr?.on("data", (d: Buffer) => {
          const chunk = d.toString();
          for (const raw of chunk.split("\n")) {
            const line = raw.trim();
            if (!line) continue;
            this.deps.log(`ffmpeg[mix]: ${line}`);
            stream.stderrTail.push(line);
          }
          if (stream.stderrTail.length > STDERR_TAIL_MAX)
            stream.stderrTail.splice(0, stream.stderrTail.length - STDERR_TAIL_MAX);
        });
        mixer.on("exit", (code, signal) => {
          // Ignore the exit of a mixer we deliberately replaced or tore down.
          if (gen !== stream.mixerGen || stream.closing) return;
          const reason = classifyStreamError(
            stream.stderrTail.join("\n"),
            stream.config,
            code,
            signal,
          );
          stream.mixer = null;
          if (!stream.started) {
            // Startup failure: start() is awaiting the grace window and will
            // throw this, so the user who clicked Start sees the real reason.
            // The room was never told streaming-started, so don't fire onStop.
            stream.startupError = reason;
            this.deps.log(`startup failed for room "${roomName}": ${reason}`);
            return;
          }
          this.deps.log(`mixer exited for room "${roomName}": ${reason}`);
          // Tear the stream down and notify the room (e.g. bad Icecast target).
          void this.stop(roomName).finally(() => this.onStop?.(roomName, "error", reason));
        });

        // Let the freshly-spawned mixer bind its UDP ports before media flows.
        if (this.deps.resumeDelayMs > 0) await this.deps.sleep(this.deps.resumeDelayMs);
        if (stream.closing || gen !== stream.mixerGen) break;
        for (const feed of stream.feeds.values()) {
          if (feed.resumed) continue;
          try {
            await feed.consumer.resume();
            feed.resumed = true;
          } catch (err) {
            this.deps.log(`failed to resume feed ${feed.producerId}: ${String(err)}`);
          }
        }
      } while (stream.rebuildPending && !stream.closing);
    } finally {
      stream.building = false;
    }
  }
}
