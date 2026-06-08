import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { z } from "zod";
import type { DtlsParameters, MediaKind, RtpCapabilities, RtpParameters } from "mediasoup/types";
import {
  getOrCreateRoom,
  createPeer,
  createWebRtcTransport,
  removePeer,
  type Room,
  type Peer,
} from "./room-manager.js";
import { decideMode } from "./recording-util.js";
import type { RecordingManager } from "./recording.js";

// --- Validation schemas ---
const roomNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_-]+$/, "Room name must be alphanumeric, hyphens, or underscores");

const displayNameSchema = z
  .string()
  .min(1)
  .max(256)
  .transform((s) => s.replace(/[<>"'&]/g, ""));

const joinSchema = z.object({
  roomName: roomNameSchema,
  displayName: displayNameSchema,
  // A "caster" is a send-only media source (e.g. Ecobox streaming music). It
  // produces a stereo track but never consumes or sets up P2P, so its presence
  // forces the room onto the SFU.
  role: z.enum(["caster"]).optional(),
  // Explicitly disable P2P for this room (the `?p2p=off` room URL param). Pins
  // the room to the SFU even with <=2 peers; sticky once any joiner sets it.
  disableP2p: z.boolean().optional(),
});

function closeSfuResources(peer: Peer) {
  peer.sendTransport?.close();
  peer.sendTransport = null;
  peer.recvTransport?.close();
  peer.recvTransport = null;
  peer.producers.clear();
  peer.consumers.clear();
}

export function createSignalingServer(httpServer: HttpServer, recordingManager: RecordingManager) {
  const io = new Server(httpServer, {
    cors: { origin: "*" },
    transports: ["websocket"],
    pingInterval: 5000,
    pingTimeout: 10000,
  });

  // When a finished recording is auto-discarded (TTL), tell the room so
  // clients can hide the now-dead download link.
  recordingManager.onExpire = (roomName, recordingId) => {
    io.to(roomName).emit("recording-expired", { recordingId });
  };

  // The room must be pinned to the SFU when the server has to see/route the
  // media itself: while recording, or while a send-only "music caster" peer
  // (Ecobox) is present (a caster produces but never sets up P2P). P2P can also
  // be disabled outright for the room via the `?p2p=off` URL param.
  function shouldForceSfu(room: Room): boolean {
    return recordingManager.isRecording(room.name) || room.casters.size > 0 || room.disableP2p;
  }

  // Auto-ducking: the room's AudioLevelObserver watches VOICE producers only
  // (music producers are never added — see the produce handler), so it fires
  // 'volumes' when someone talks and 'silence' when nobody does. We broadcast a
  // `duck` event on each transition; listeners ramp the music peer's gain down
  // while a voice is active. Wired once per room.
  function wireDucking(room: Room) {
    if (room.observerWired) return;
    room.observerWired = true;
    room.audioLevelObserver.on("volumes", () => {
      if (room.voiceActive) return;
      room.voiceActive = true;
      io.to(room.name).emit("duck", { active: true });
    });
    room.audioLevelObserver.on("silence", () => {
      if (!room.voiceActive) return;
      room.voiceActive = false;
      io.to(room.name).emit("duck", { active: false });
    });
  }

  // --- Evaluate room mode and trigger switches ---
  // A recording (or an active music caster) forces SFU and prevents the usual
  // downgrade to P2P, so the server keeps seeing the media.
  function applyModeDecision(room: Room) {
    const decision = decideMode(room.peers.size, room.mode, shouldForceSfu(room));
    if (decision.action === "none") return;

    room.mode = decision.mode;
    if (decision.action === "switch-to-sfu") {
      console.log(`[room:${room.name}] switching to SFU (${room.peers.size} peers)`);
      io.to(room.name).emit("switch-to-sfu", {
        rtpCapabilities: room.router.rtpCapabilities,
      });
    } else {
      console.log(`[room:${room.name}] switching to P2P (${room.peers.size} peers)`);
      for (const peer of room.peers.values()) {
        closeSfuResources(peer);
      }
      const peerIds = Array.from(room.peers.keys());
      io.to(room.name).emit("switch-to-p2p", { peerIds });
    }
  }

  io.on("connection", (socket) => {
    console.log(`[ws] connected: ${socket.id}`);
    let currentRoom: Room | null = null;
    let currentPeer: Peer | null = null;

    socket.on("join", async (data: unknown, cb: (res: unknown) => void) => {
      try {
        const { roomName, displayName, role, disableP2p } = joinSchema.parse(data);
        console.log(`[ws] ${socket.id} joined ${roomName} as "${displayName}"${role ? ` (${role})` : ""}${disableP2p ? " (p2p disabled)" : ""}`);
        const room = await getOrCreateRoom(roomName);
        wireDucking(room);
        const peer = createPeer(room, socket.id, displayName);

        // Register a caster / P2P-disable BEFORE deciding the mode, so the join
        // response (and the new peer's own setup) already reflects the
        // forced-SFU room. disableP2p is sticky for the room's lifetime.
        if (role === "caster") room.casters.add(socket.id);
        if (disableP2p) room.disableP2p = true;

        currentRoom = room;
        currentPeer = peer;

        await socket.join(roomName);

        // Notify existing peers
        socket.to(roomName).emit("peer-joined", {
          peerId: socket.id,
          displayName,
        });

        // Send existing peers to the new joiner. Each producer carries its
        // `source` ("voice" | "music") so a late joiner can label/treat the
        // music caster as a media source without waiting for a new-producer event.
        const existingPeers = Array.from(room.peers.entries())
          .filter(([id]) => id !== socket.id)
          .map(([id, p]) => ({
            peerId: id,
            displayName: p.displayName,
            producers: Array.from(p.producers.values()).map((prod) => ({
              producerId: prod.id,
              source: (prod.appData?.source as string) ?? "voice",
            })),
          }));

        // Determine mode: 3+ peers => SFU; an active recording or music caster
        // also forces SFU even with <=2 peers.
        const decision = decideMode(room.peers.size, room.mode, shouldForceSfu(room));

        cb({
          ok: true,
          rtpCapabilities: room.router.rtpCapabilities,
          peers: existingPeers,
          mode: decision.mode,
          recording: recordingManager.isRecording(room.name)
            ? { recordingId: recordingManager.getRecording(room.name)!.id }
            : null,
        });

        if (decision.action === "switch-to-sfu") {
          // A new peer pushed the room into SFU — switch everyone else over.
          applyModeDecision(room);
        }
      } catch (err) {
        cb({ ok: false, error: err instanceof Error ? err.message : "Invalid input" });
      }
    });

    // --- P2P signaling relay ---
    socket.on("p2p-signal", (data: unknown) => {
      if (!currentRoom) return;
      const parsed = z
        .object({
          targetPeerId: z.string(),
          type: z.enum(["offer", "answer", "ice-candidate"]),
          payload: z.any(),
        })
        .safeParse(data);
      if (!parsed.success) return;

      const { targetPeerId, type, payload } = parsed.data;
      io.to(targetPeerId).emit("p2p-signal", {
        fromPeerId: socket.id,
        type,
        payload,
      });
    });

    // --- SFU transport/produce/consume (same as before) ---
    socket.on("create-transport", async (data: unknown, cb: (res: unknown) => void) => {
      try {
        if (!currentRoom || !currentPeer) {
          cb({ ok: false, error: "Not in a room" });
          return;
        }

        const { direction } = z.object({ direction: z.enum(["send", "recv"]) }).parse(data);
        const { transport, params } = await createWebRtcTransport(currentRoom);

        if (direction === "send") {
          currentPeer.sendTransport = transport;
        } else {
          currentPeer.recvTransport = transport;
        }

        cb({ ok: true, params });
      } catch (err) {
        cb({ ok: false, error: err instanceof Error ? err.message : "Transport creation failed" });
      }
    });

    socket.on("connect-transport", async (data: unknown, cb: (res: unknown) => void) => {
      try {
        if (!currentPeer) {
          cb({ ok: false, error: "Not in a room" });
          return;
        }

        const { direction, dtlsParameters } = z
          .object({
            direction: z.enum(["send", "recv"]),
            dtlsParameters: z.any() as z.ZodType<DtlsParameters>,
          })
          .parse(data);

        const transport =
          direction === "send" ? currentPeer.sendTransport : currentPeer.recvTransport;

        if (!transport) {
          cb({ ok: false, error: "Transport not found" });
          return;
        }

        await transport.connect({ dtlsParameters });
        cb({ ok: true });
      } catch (err) {
        cb({ ok: false, error: err instanceof Error ? err.message : "Connect failed" });
      }
    });

    socket.on("produce", async (data: unknown, cb: (res: unknown) => void) => {
      try {
        if (!currentRoom || !currentPeer?.sendTransport) {
          cb({ ok: false, error: "No send transport" });
          return;
        }

        const { kind, rtpParameters, source } = z
          .object({
            kind: z.enum(["audio", "video"]) as z.ZodType<MediaKind>,
            rtpParameters: z.any() as z.ZodType<RtpParameters>,
            // "music" for a caster's stereo track, "voice" (default) for mics.
            source: z.enum(["voice", "music"]).optional(),
          })
          .parse(data);

        const producer = await currentPeer.sendTransport.produce({
          kind,
          rtpParameters,
          appData: { source: source ?? "voice" },
        });

        currentPeer.producers.set(producer.id, producer);

        // Feed VOICE producers into the audio-level observer so talking ducks
        // the music. Music producers are deliberately excluded so the music
        // never ducks itself. (Closed producers auto-remove themselves.)
        if (producer.kind === "audio" && (source ?? "voice") !== "music") {
          void currentRoom.audioLevelObserver
            .addProducer({ producerId: producer.id })
            .catch((err) => console.error("[duck] addProducer failed:", err));
        }

        // If the room is being recorded, start capturing this producer too.
        // Not awaited — the produce callback should return promptly, and the
        // recorder spins up in the background.
        if (recordingManager.isRecording(currentRoom.name)) {
          void recordingManager
            .addProducer(currentRoom.name, { producerId: producer.id, peerId: socket.id })
            .catch((err) => console.error("[recording] addProducer failed:", err));
        }

        // Notify all other peers that a new producer is available
        socket.to(currentRoom.name).emit("new-producer", {
          peerId: socket.id,
          producerId: producer.id,
          kind: producer.kind,
          source: (producer.appData?.source as string) ?? "voice",
        });

        cb({ ok: true, producerId: producer.id });
      } catch (err) {
        cb({ ok: false, error: err instanceof Error ? err.message : "Produce failed" });
      }
    });

    socket.on("consume", async (data: unknown, cb: (res: unknown) => void) => {
      try {
        if (!currentRoom || !currentPeer?.recvTransport) {
          cb({ ok: false, error: "No recv transport" });
          return;
        }

        const { producerId, rtpCapabilities } = z
          .object({
            producerId: z.string(),
            rtpCapabilities: z.any() as z.ZodType<RtpCapabilities>,
          })
          .parse(data);

        if (!currentRoom.router.canConsume({ producerId, rtpCapabilities })) {
          cb({ ok: false, error: "Cannot consume" });
          return;
        }

        const consumer = await currentPeer.recvTransport.consume({
          producerId,
          rtpCapabilities,
          paused: false,
        });

        currentPeer.consumers.set(consumer.id, consumer);

        cb({
          ok: true,
          consumerId: consumer.id,
          producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        });
      } catch (err) {
        cb({ ok: false, error: err instanceof Error ? err.message : "Consume failed" });
      }
    });

    socket.on("producer-pause", async (_data: unknown, cb: (res: unknown) => void) => {
      if (!currentPeer) return cb({ ok: false });
      for (const producer of currentPeer.producers.values()) {
        await producer.pause();
      }
      if (currentRoom) {
        socket.to(currentRoom.name).emit("peer-muted", { peerId: socket.id });
      }
      cb({ ok: true });
    });

    socket.on("producer-resume", async (_data: unknown, cb: (res: unknown) => void) => {
      if (!currentPeer) return cb({ ok: false });
      for (const producer of currentPeer.producers.values()) {
        await producer.resume();
      }
      if (currentRoom) {
        socket.to(currentRoom.name).emit("peer-unmuted", { peerId: socket.id });
      }
      cb({ ok: true });
    });

    // --- Recording ---
    socket.on("start-recording", async (_data: unknown, cb: (res: unknown) => void) => {
      try {
        if (!currentRoom) {
          cb({ ok: false, error: "Not in a room" });
          return;
        }
        const room = currentRoom;

        if (recordingManager.isRecording(room.name)) {
          cb({ ok: true, recordingId: recordingManager.getRecording(room.name)!.id });
          return;
        }

        // Snapshot producers that already exist (only present if the room was
        // already in SFU). In P2P there are none yet — applyModeDecision below
        // forces SFU, and each peer's `produce` then registers via addProducer.
        const producers: { producerId: string; peerId: string }[] = [];
        for (const [peerId, peer] of room.peers) {
          for (const producerId of peer.producers.keys()) {
            producers.push({ producerId, peerId });
          }
        }

        const rec = await recordingManager.start(room.name, room.router, producers);
        // Force SFU if we're in P2P so the server can see the media.
        applyModeDecision(room);

        io.to(room.name).emit("recording-started", {
          recordingId: rec.id,
          by: currentPeer?.displayName ?? "Someone",
        });
        cb({ ok: true, recordingId: rec.id });
      } catch (err) {
        cb({ ok: false, error: err instanceof Error ? err.message : "Failed to start recording" });
      }
    });

    socket.on("stop-recording", async (_data: unknown, cb: (res: unknown) => void) => {
      try {
        if (!currentRoom) {
          cb({ ok: false, error: "Not in a room" });
          return;
        }
        const room = currentRoom;
        // Finalize (not discard): captures stop, but the file stays
        // downloadable until its TTL / a new recording / room exit.
        const rec = await recordingManager.finalize(room.name);
        io.to(room.name).emit("recording-stopped", { recordingId: rec?.id ?? null });
        // Recording no longer pins SFU — fall back to P2P if <=2 peers remain.
        applyModeDecision(room);
        cb({ ok: true });
      } catch (err) {
        cb({ ok: false, error: err instanceof Error ? err.message : "Failed to stop recording" });
      }
    });

    socket.on("disconnect", (reason) => {
      console.log(`[ws] disconnected: ${socket.id} (${reason})`);
      if (currentRoom && currentPeer) {
        const room = currentRoom;
        socket.to(room.name).emit("peer-left", { peerId: socket.id });

        // Stop capturing this peer's producers (the already-recorded audio
        // stays on disk and is still included in downloads).
        if (recordingManager.isRecording(room.name)) {
          for (const producerId of currentPeer.producers.keys()) {
            void recordingManager.removeProducer(room.name, producerId).catch(() => {});
          }
        }
        // If this was the last peer, the room is about to be destroyed — drop
        // any recording (active or finished-but-downloadable) and its files.
        if (room.peers.size <= 1 && recordingManager.getRecording(room.name)) {
          void recordingManager.discard(room.name).catch(() => {});
        }

        // Drop this peer from the caster set before removePeer (which may
        // destroy the room) so the mode decision below no longer forces SFU
        // once the music caster is gone.
        room.casters.delete(socket.id);

        removePeer(room, socket.id);

        // Check if we should switch modes (won't downgrade while recording).
        if (room.peers.size > 0) {
          applyModeDecision(room);
        }
      }
    });
  });

  return io;
}
