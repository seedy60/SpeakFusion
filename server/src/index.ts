import express from "express";
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createWorker } from "mediasoup";
import type { Worker } from "mediasoup/types";
import { workerSettings, numWorkers } from "./mediasoup-config.js";
import { setWorkers } from "./room-manager.js";
import { createSignalingServer } from "./signaling.js";
import { RecordingManager } from "./recording.js";
import { StreamManager } from "./streaming.js";
import { createZipStream } from "./zip-stream.js";

const PORT = parseInt(process.env.PORT || "3100", 10);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
