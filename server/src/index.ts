import express from "express";
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createWorker } from "mediasoup";
import type { Worker } from "mediasoup/types";
import { workerSettings, numWorkers } from "./mediasoup-config.js";
import { setWorkers, getPublicRooms } from "./room-manager.js";
import { createSignalingServer } from "./signaling.js";
import { RecordingManager } from "./recording.js";
import { StreamManager } from "./streaming.js";
import { createZipStream } from "./zip-stream.js";
import {
  assertPublicAudioUrl,
  fetchPublicAudio,
  isAudioContentType,
  isAudioFileName,
  looksLikeStreamContentType,
  streamFallbackAudio,
} from "./audio-sources.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load local secrets/config from the repo-root .env (NOTY_* notification target,
// etc.) before anything reads process.env. tsx/Node don't auto-load it, and it's
// gitignored + hidden from the app UI on purpose; an absent file is fine (the
// .env-gated features simply stay off). Resolved from this file, not cwd, since
// `pnpm --filter server start` runs with the server package as cwd.
try {
  process.loadEnvFile(path.resolve(__dirname, "../../.env"));
} catch {
  /* no .env present — fine */
}

const PORT = parseInt(process.env.PORT || "3100", 10);
const AUDIO_LIBRARY_DIR = process.env.AUDIO_LIBRARY_DIR || "/var/lib/sonicroom/media";

async function main() {
  // Create mediasoup workers
  const workers: Worker[] = [];
  for (let i = 0; i < numWorkers; i++) {
    const worker = await createWorker(workerSettings);
    worker.on("died", () => {
      console.error(`Worker ${worker.pid} died, exiting...`);
      process.exit(1);
    });
    workers.push(worker);
  }
  setWorkers(workers);
  console.log(`Created ${workers.length} mediasoup worker(s)`);

  const app = express();
  app.use(express.json({ limit: "64kb" }));
  const httpServer = createServer(app);

  const recordingManager = new RecordingManager();
  const streamManager = new StreamManager();
  const { postChatMessage } = createSignalingServer(httpServer, recordingManager, streamManager);
  // Health check
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", workers: workers.length });
  });

  // Post a chat message into a live room from outside the browser (e.g. Ecobox
  // announcing the now-playing track). Body: { text, sender? }. Rate-limited
  // and validated identically to an in-room peer; 404 if the room isn't live.
  app.post("/api/rooms/:roomName/messages", (req, res) => {
    const body = (req.body ?? {}) as { text?: unknown; sender?: unknown };
    if (typeof body.text !== "string") {
      res.status(400).json({ error: "Body must include a string `text`" });
      return;
    }
    const sender = typeof body.sender === "string" ? body.sender : "System";
    const result = postChatMessage(req.params.roomName, sender, body.text);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.status(201).json({ ok: true, message: result.message });
  });

  // Public room directory for the lobby: the live, publicly-listed rooms and who
  // is currently in each. Private rooms are never included. Polled by the lobby
  // (the visitor isn't connected to a socket yet), so it's a plain GET.
  app.get("/api/public-rooms", (_req, res) => {
    res.json({ rooms: getPublicRooms() });
  });

  // Audio sources for the in-call music/file streamer. The managed library is
  // flat and audio-only; URL playback goes through this same-origin proxy so
  // Web Audio can consume sources whose origin does not provide CORS headers.
  app.get("/api/audio-library", async (_req, res) => {
    try {
      const entries = await readdir(AUDIO_LIBRARY_DIR, { withFileTypes: true });
      const files = entries
        .filter((entry) => entry.isFile() && isAudioFileName(entry.name))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
      res.json({ files });
    } catch (err) {
      console.error(`[audio-library] list failed: ${String(err)}`);
      res.status(500).json({ error: "Could not list server audio files" });
    }
  });

  app.get("/api/audio-library/:name", (req, res) => {
    if (!isAudioFileName(req.params.name)) {
      res.status(404).json({ error: "Audio file not found" });
      return;
    }
    res.sendFile(req.params.name, { root: AUDIO_LIBRARY_DIR, dotfiles: "deny" }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: "Audio file not found" });
    });
  });

  app.get("/api/audio-proxy", async (req, res) => {
    const raw = typeof req.query.url === "string" ? req.query.url : "";
    if (!raw) {
      res.status(400).json({ error: "Missing audio URL" });
      return;
    }

    // Validate up front: blocks private/SSRF targets for both the direct proxy
    // and the yt-dlp fallback, and gives a clean 400 for an unusable URL.
    try {
      await assertPublicAudioUrl(raw);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Audio URL failed" });
      return;
    }

    // Whether the failed direct fetch looked like a media stream (IPTV/HLS/DASH/
    // octet-stream) rather than a web page — routes the fallback to ffmpeg first.
    let preferFfmpeg = false;

    // 1) Direct path: a plain audio file or Icecast/HTTP radio stream. Kept for
    //    these because it preserves Range requests (seeking) with no transcode.
    try {
      const upstream = await fetchPublicAudio(raw, req.headers.range);
      const status = upstream.statusCode ?? 502;
      const contentType = upstream.headers["content-type"] || "";
      if (status >= 200 && status < 300 && isAudioContentType(contentType)) {
        res.status(status);
        res.setHeader("Content-Type", contentType);
        for (const header of [
          "accept-ranges",
          "content-length",
          "content-range",
          "icy-br",
          "icy-name",
        ]) {
          const value = upstream.headers[header];
          if (value) res.setHeader(header, value);
        }
        res.on("close", () => upstream.destroy());
        upstream.on("error", (err) => {
          console.error(`[audio-proxy] stream failed: ${String(err)}`);
          res.destroy(err);
        });
        upstream.pipe(res);
        return;
      }
      // Not directly playable (an HTML page, a player redirect, a hotlink block,
      // an IPTV `.ts`/octet-stream, …) — fall through to the transcoder. Note
      // whether it smelled like a media stream so the fallback prefers ffmpeg.
      preferFfmpeg = looksLikeStreamContentType(contentType);
      upstream.destroy();
    } catch (err) {
      console.error(`[audio-proxy] direct fetch failed, trying transcode fallback: ${String(err)}`);
    }

    // 2) Fallback: transcode to a progressive Opus/WebM stream the <audio>
    //    element can play. Direct media streams (IPTV `.ts`, HLS, DASH) go
    //    through ffmpeg; sites (YouTube, SoundCloud, …) through yt-dlp. No Range
    //    support here — it's a live transcode.
    try {
      const extracted = await streamFallbackAudio(raw, { preferFfmpeg });
      res.status(200);
      res.setHeader("Content-Type", extracted.contentType);
      res.setHeader("Cache-Control", "no-store");
      res.on("close", () => extracted.destroy());
      extracted.stream.on("error", (err) => {
        console.error(`[audio-proxy] transcode stream failed: ${String(err)}`);
        res.destroy(err instanceof Error ? err : new Error(String(err)));
      });
      extracted.stream.pipe(res);
    } catch (err) {
      console.error(`[audio-proxy] transcode fallback failed: ${String(err)}`);
      if (!res.headersSent) {
        res.status(502).json({ error: "Could not get audio from that URL" });
      } else {
        res.destroy();
      }
    }
  });

  // Recording download — mixes all participants' captured audio into a single
  // Ogg/Opus file and streams it. Works at any time while recording continues;
  // the capture processes are never interrupted. Keyed by the recording id
  // (a capability token handed to clients), not the room name.
  app.get("/api/recordings/:id/download", (req, res) => {
    const proc = recordingManager.mixByRecordingId(req.params.id);
    if (!proc || !proc.stdout) {
      res.status(404).json({ error: "No active recording with that id, or nothing captured yet" });
      return;
    }
    res.setHeader("Content-Type", "audio/ogg");
    res.setHeader("Content-Disposition", `attachment; filename="sonicroom-${req.params.id}.ogg"`);

    proc.stderr?.on("data", (d: Buffer) => console.error(`[mix] ${d.toString().trim()}`));
    proc.stdout.pipe(res);

    // If the client aborts the download, kill the mixing ffmpeg.
    const kill = () => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    };
    res.on("close", kill);
    proc.on("exit", (code) => {
      if (code) console.error(`[mix] ffmpeg exited with code ${code}`);
    });
  });

  // Per-track download — packs each participant's captured audio into its own
  // file inside one streamed .zip (no mixing). Includes tracks whose peer
  // already left, since their captures are kept on disk. Like the mix above,
  // works while still recording and never interrupts the live captures.
  app.get("/api/recordings/:id/tracks", (req, res) => {
    const tracks = recordingManager.tracksByRecordingId(req.params.id);
    if (!tracks || tracks.length === 0) {
      res.status(404).json({ error: "No recording with that id, or nothing captured yet" });
      return;
    }
    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="sonicroom-${req.params.id}-tracks.zip"`,
    );

    const zip = createZipStream(
      tracks.map((t) => ({ name: t.name, open: () => createReadStream(t.path) })),
    );
    zip.on("error", (err) => {
      console.error(`[tracks] zip error: ${String(err)}`);
      res.destroy(err instanceof Error ? err : new Error(String(err)));
    });
    // If the client aborts the download, stop reading the files.
    res.on("close", () => zip.destroy());
    zip.pipe(res);
  });

  // Serve built client in production
  const clientDist = path.resolve(__dirname, "../../client/dist");
  app.use(express.static(clientDist));
  app.get("/{*splat}", (_req, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });

  httpServer.listen(PORT, () => {
    console.log(`SonicRoom server listening on port ${PORT}`);
  });

  // Clean up recordings and live streams (ffmpeg processes, temp files) on
  // shutdown.
  const shutdown = (signal: string) => {
    console.log(`Received ${signal}, cleaning up recordings and streams...`);
    Promise.allSettled([recordingManager.stopAll(), streamManager.stopAll()]).finally(() =>
      process.exit(0),
    );
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
