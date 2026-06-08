import { useRef, useCallback, useEffect } from "react";
import { io, type Socket } from "socket.io-client";
import { Device } from "mediasoup-client";
import type { Transport, Producer, Consumer } from "mediasoup-client/types";
import { forceOpusParams } from "../lib/sdp-munger";
import { playCue } from "../lib/sounds";
import { useRoomStore, type RoomMode } from "../stores/room";

interface ConsumeResult {
  ok: boolean;
  consumerId: string;
  producerId: string;
  kind: string;
  rtpParameters: Record<string, unknown>;
  error?: string;
}

interface PeerAudio {
  audioEl: HTMLAudioElement;
  gainNode: GainNode;
  sourceNode: MediaStreamAudioSourceNode;
  // SFU-only
  consumer?: Consumer;
}

// ICE servers — self-hosted coturn at turn.oriolgomez.com (shared with the
// games on the same VPS). STUN is tried first, so most P2P connections
// never hit the relay; TURN/TURNS only kick in for symmetric NATs and
// restrictive corporate/hotel networks. Credentials are visible to
// clients by design (WebRTC requires them in the browser); coturn's
// denied-peer-ip rules limit blast radius.
const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:turn.oriolgomez.com:3478" },
  { urls: "stun:stun.l.google.com:19302" },
  {
    urls: "turn:turn.oriolgomez.com:3478?transport=udp",
    username: "gamesturn",
    credential: "sin6V0gFokHz78gM0GDfXmat",
  },
  {
    urls: "turn:turn.oriolgomez.com:3478?transport=tcp",
    username: "gamesturn",
    credential: "sin6V0gFokHz78gM0GDfXmat",
  },
  {
    urls: "turns:turn.oriolgomez.com:5349?transport=tcp",
    username: "gamesturn",
    credential: "sin6V0gFokHz78gM0GDfXmat",
  },
];

// Shared AudioContext — single output buffer for all peers (lower latency than one per peer)
const sharedAudioContext = new AudioContext({
  sampleRate: 48000,
  latencyHint: "interactive",
});

// Auto-ducking: how loud the music stays while someone is talking, and the
// setTargetAtTime time-constants (seconds) for the gain ramps. Smaller = snappier.
// Attack (duck down when a voice starts) is fast; release (bring the music back
// when the voice stops) is a touch slower to avoid pumping between words.
const DUCK_FACTOR = 0.22;
const DUCK_ATTACK = 0.05;
const DUCK_RELEASE = 0.09;
const GAIN_RAMP = 0.03;

// Soft limiter sitting after the outgoing mic gain so boosting a quiet/cheap
// mic doesn't clip: transparent until peaks approach 0 dBFS, then ~20:1 with a
// fast attack. Adds ~5 ms of look-ahead latency, negligible for voice.
const MIC_LIMITER = { threshold: -3, knee: 0, ratio: 20, attack: 0.003, release: 0.25 };

// Resume shared context on first user interaction (iOS requirement)
function resumeSharedContext() {
  if (sharedAudioContext.state === "suspended") {
    sharedAudioContext.resume();
  }
}
document.addEventListener("touchstart", resumeSharedContext, { once: true });
document.addEventListener("click", resumeSharedContext, { once: true });

function createAudioPipeline(track: MediaStreamTrack): Omit<PeerAudio, "consumer"> {
  const stream = new MediaStream([track]);
  const audioEl = new Audio();
  audioEl.srcObject = stream;
  audioEl.autoplay = true;
  // iOS Safari requires webkit attributes
  (audioEl as unknown as Record<string, boolean>).playsInline = true;
  (audioEl as unknown as Record<string, string>).webkitPlaysinline = "true";
  // Mute the HTML element — audio is routed through the shared AudioContext
  audioEl.volume = 0;

  resumeSharedContext();

  const sourceNode = sharedAudioContext.createMediaStreamSource(stream);
  const gainNode = sharedAudioContext.createGain();
  gainNode.gain.value = 1;
  sourceNode.connect(gainNode);
  gainNode.connect(sharedAudioContext.destination);

  return { audioEl, gainNode, sourceNode };
}

function destroyAudioPipeline(pa: PeerAudio) {
  pa.consumer?.close();
  pa.audioEl.srcObject = null;
  pa.audioEl.pause();
  pa.sourceNode.disconnect();
  pa.gainNode.disconnect();
}

export function useMediasoup() {
  const socketRef = useRef<Socket | null>(null);
  const deviceRef = useRef<Device | null>(null);
  const sendTransportRef = useRef<Transport | null>(null);
  const recvTransportRef = useRef<Transport | null>(null);
  const producerRef = useRef<Producer | null>(null);
  const peerAudiosRef = useRef<Map<string, PeerAudio>>(new Map());
  const localStreamRef = useRef<MediaStream | null>(null);
  // True while the server reports someone is talking (drives music ducking).
  const isVoiceActiveRef = useRef(false);
  // P2P
  const p2pConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const modeRef = useRef<RoomMode>("p2p");
  // Outgoing audio graph: mic → micGain → limiter → outDest → outgoing track.
  // The track added to peers / produced to the SFU is always outDest's, so the
  // mic slider just rides `micGain` and shared system audio is mixed straight
  // into `outDest` (bypassing the gain/limiter so the music keeps its dynamics).
  const outGraphRef = useRef<{
    micSource: MediaStreamAudioSourceNode | null;
    micGain: GainNode;
    limiter: DynamicsCompressorNode;
    outDest: MediaStreamAudioDestinationNode;
    displaySource: MediaStreamAudioSourceNode | null;
    micStream: MediaStream | null;
  } | null>(null);
  // Audio share (system / tab audio mixed into the outgoing graph)
  const displayStreamRef = useRef<MediaStream | null>(null);

  const store = useRoomStore;

  const emit = useCallback(
    <T>(event: string, data?: unknown): Promise<T> =>
      new Promise((resolve, reject) => {
        const socket = socketRef.current;
        if (!socket) return reject(new Error("No socket"));
        socket.emit(event, data, (res: T & { ok: boolean; error?: string }) => {
          if (res.ok) resolve(res);
          else reject(new Error(res.error || "Unknown error"));
        });
      }),
    [],
  );

  // The gain a peer's audio should currently play at, composing the listener's
  // per-peer volume, deafen, and music auto-ducking (music drops while a voice
  // is active). Voice peers are unaffected by ducking.
  const effectiveGain = useCallback(
    (peerId: string): number => {
      const peer = store.getState().peers.get(peerId);
      if (!peer || store.getState().isDeafened) return 0;
      if (peer.isMusic && isVoiceActiveRef.current) return peer.volume * DUCK_FACTOR;
      return peer.volume;
    },
    [store],
  );

  // Server told us whether anyone is talking — ramp every music peer's gain.
  const applyDuck = useCallback(
    (active: boolean) => {
      isVoiceActiveRef.current = active;
      const now = sharedAudioContext.currentTime;
      const ramp = active ? DUCK_ATTACK : DUCK_RELEASE;
      for (const [peerId, pa] of peerAudiosRef.current) {
        if (!store.getState().peers.get(peerId)?.isMusic) continue;
        pa.gainNode.gain.setTargetAtTime(effectiveGain(peerId), now, ramp);
      }
    },
    [store, effectiveGain],
  );

  // --- Shared: clean up all peer audio ---
  const cleanupAllPeerAudio = useCallback(() => {
    for (const pa of peerAudiosRef.current.values()) {
      destroyAudioPipeline(pa);
    }
    peerAudiosRef.current.clear();
  }, []);

  // --- Outgoing audio graph (mic gain + soft limiter, + optional shared audio) ---
  // Built lazily and reused for the whole session. The produced/added track is
  // always `outDest`'s, so we never have to swap tracks on senders/producer.
  const ensureOutGraph = useCallback(() => {
    if (outGraphRef.current) return outGraphRef.current;
    // The mic now flows through the shared context, so it must be running
    // (it starts suspended on iOS until a user gesture).
    resumeSharedContext();
    const ctx = sharedAudioContext;
    const micGain = ctx.createGain();
    micGain.gain.value = store.getState().micGain;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = MIC_LIMITER.threshold;
    limiter.knee.value = MIC_LIMITER.knee;
    limiter.ratio.value = MIC_LIMITER.ratio;
    limiter.attack.value = MIC_LIMITER.attack;
    limiter.release.value = MIC_LIMITER.release;
    const outDest = ctx.createMediaStreamDestination();
    micGain.connect(limiter);
    limiter.connect(outDest);
    outGraphRef.current = {
      micSource: null,
      micGain,
      limiter,
      outDest,
      displaySource: null,
      micStream: null,
    };
    return outGraphRef.current;
  }, [store]);

  // (Re)route the raw mic into the outgoing graph. Idempotent for a given
  // stream; re-runs when the mic is re-acquired (track died / device change).
  const connectMicToGraph = useCallback(
    (stream: MediaStream) => {
      const g = ensureOutGraph();
      if (g.micStream === stream && g.micSource) return;
      g.micSource?.disconnect();
      g.micSource = sharedAudioContext.createMediaStreamSource(stream);
      g.micSource.connect(g.micGain);
      g.micStream = stream;
    },
    [ensureOutGraph],
  );

  // --- P2P: create a peer connection ---
  const ensureLocalStream = useCallback(async () => {
    const existing = localStreamRef.current;
    const track = existing?.getAudioTracks()[0];
    if (track && track.readyState === "live") return existing!;

    // Re-acquire mic
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 48000,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    localStreamRef.current = stream;
    connectMicToGraph(stream);
    return stream;
  }, [connectMicToGraph]);

  const createP2pConnection = useCallback(
    async (peerId: string, isOfferer: boolean) => {
      const socket = socketRef.current;
      if (!socket) return;

      const localStream = await ensureLocalStream();
      connectMicToGraph(localStream);

      const pc = new RTCPeerConnection({
        iceServers: ICE_SERVERS,
      });

      // Send the processed outgoing track (mic gain + limiter, + shared audio),
      // not the raw mic.
      const g = ensureOutGraph();
      pc.addTrack(g.outDest.stream.getAudioTracks()[0], g.outDest.stream);

      // ICE candidates → relay via server
      pc.onicecandidate = (e) => {
        if (e.candidate) {
          socket.emit("p2p-signal", {
            targetPeerId: peerId,
            type: "ice-candidate",
            payload: e.candidate.toJSON(),
          });
        }
      };

      // Remote track → audio pipeline
      pc.ontrack = (e) => {
        const remoteTrack = e.track;
        if ("playoutDelayHint" in remoteTrack) {
          (remoteTrack as unknown as Record<string, number>).playoutDelayHint = 0;
        }
        const pipeline = createAudioPipeline(remoteTrack);
        peerAudiosRef.current.set(peerId, pipeline);
      };

      p2pConnectionsRef.current.set(peerId, pc);

      if (isOfferer) {
        // Create offer with low-latency Opus params
        pc.createOffer().then(async (offer) => {
          offer.sdp = forceOpusParams(offer.sdp!);
          await pc.setLocalDescription(offer);
          socket.emit("p2p-signal", {
            targetPeerId: peerId,
            type: "offer",
            payload: offer,
          });
        });
      }

      return pc;
    },
    [ensureLocalStream, connectMicToGraph, ensureOutGraph],
  );

  // --- P2P: tear down all connections ---
  const teardownP2p = useCallback(() => {
    for (const pc of p2pConnectionsRef.current.values()) {
      pc.close();
    }
    p2pConnectionsRef.current.clear();
    cleanupAllPeerAudio();
  }, [cleanupAllPeerAudio]);

  // --- SFU: tear down mediasoup transports ---
  const teardownSfu = useCallback(() => {
    producerRef.current?.close();
    producerRef.current = null;
    sendTransportRef.current?.close();
    sendTransportRef.current = null;
    recvTransportRef.current?.close();
    recvTransportRef.current = null;
    cleanupAllPeerAudio();
  }, [cleanupAllPeerAudio]);

  // --- SFU: consume a producer ---
  const consumeProducer = useCallback(
    async (peerId: string, producerId: string, source: string = "voice") => {
      const device = deviceRef.current;
      const recvTransport = recvTransportRef.current;
      if (!device || !recvTransport) return;

      const res = await emit<ConsumeResult>("consume", {
        producerId,
        rtpCapabilities: device.rtpCapabilities,
      });

      const consumer = await recvTransport.consume({
        id: res.consumerId,
        producerId: res.producerId,
        kind: res.kind as "audio",
        rtpParameters: res.rtpParameters as Parameters<typeof recvTransport.consume>[0]["rtpParameters"],
      });

      if ("playoutDelayHint" in consumer.track) {
        (consumer.track as unknown as Record<string, number>).playoutDelayHint = 0;
      }

      const pipeline = createAudioPipeline(consumer.track);
      peerAudiosRef.current.set(peerId, { ...pipeline, consumer });

      // Flag a music-caster peer (e.g. Ecobox) so the UI shows it as a media
      // source. Stereo is preserved end-to-end by createAudioPipeline.
      if (source === "music") store.getState().setPeerMusic(peerId, true);

      // Start at the correct gain: respects deafen, and ducks immediately if a
      // voice is already active when this (music) producer joins.
      pipeline.gainNode.gain.value = effectiveGain(peerId);
    },
    [emit, store, effectiveGain],
  );

  // --- SFU: set up transports and produce ---
  const setupSfu = useCallback(
    async (rtpCapabilities: Record<string, unknown>) => {
      const localStream = localStreamRef.current;
      if (!localStream) return;
      connectMicToGraph(localStream);

      // Load device if needed
      let device = deviceRef.current;
      if (!device) {
        device = new Device();
        deviceRef.current = device;
      }
      if (!device.loaded) {
        await device.load({
          routerRtpCapabilities: rtpCapabilities as Parameters<
            typeof device.load
          >[0]["routerRtpCapabilities"],
        });
      }

      // Create send transport
      const sendRes = await emit<{ ok: boolean; params: Record<string, unknown> }>(
        "create-transport",
        { direction: "send" },
      );
      const sendTransport = device.createSendTransport({
        ...(sendRes.params as Parameters<typeof device.createSendTransport>[0]),
        iceServers: ICE_SERVERS,
      });

      sendTransport.on("connect", async ({ dtlsParameters }, callback, errback) => {
        try {
          await emit("connect-transport", { direction: "send", dtlsParameters });
          callback();
        } catch (e) {
          errback(e as Error);
        }
      });

      sendTransport.on("produce", async ({ kind, rtpParameters }, callback, errback) => {
        try {
          const res = await emit<{ producerId: string }>("produce", { kind, rtpParameters });
          callback({ id: res.producerId });
        } catch (e) {
          errback(e as Error);
        }
      });

      sendTransportRef.current = sendTransport;

      // Create recv transport
      const recvRes = await emit<{ ok: boolean; params: Record<string, unknown> }>(
        "create-transport",
        { direction: "recv" },
      );
      const recvTransport = device.createRecvTransport({
        ...(recvRes.params as Parameters<typeof device.createRecvTransport>[0]),
        iceServers: ICE_SERVERS,
      });

      recvTransport.on("connect", async ({ dtlsParameters }, callback, errback) => {
        try {
          await emit("connect-transport", { direction: "recv", dtlsParameters });
          callback();
        } catch (e) {
          errback(e as Error);
        }
      });

      recvTransportRef.current = recvTransport;

      // Produce the processed outgoing track (mic gain + limiter, + shared audio)
      const producer = await sendTransport.produce({
        track: ensureOutGraph().outDest.stream.getAudioTracks()[0],
        codecOptions: {
          opusStereo: false,
          opusDtx: false,
          opusFec: true,
          opusMaxPlaybackRate: 48000,
        },
        codec: device.rtpCapabilities.codecs?.find((c) => c.mimeType.toLowerCase() === "audio/opus"),
      });
      producerRef.current = producer;
    },
    [emit, connectMicToGraph, ensureOutGraph],
  );

  // --- Main join ---
  const join = useCallback(
    async (roomName: string, displayName: string, opts?: { disableP2p?: boolean }) => {
      const socket = io({ transports: ["websocket"] });
      socketRef.current = socket;

      await new Promise<void>((resolve) => socket.on("connect", resolve));
      store.getState().setConnected(true);

      // Get stereo audio first (needed for both modes)
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 2,
          sampleRate: 48000,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      localStreamRef.current = stream;
      // Build the outgoing graph and route the mic through it, so the gained +
      // limited track is what every peer / the SFU receives.
      connectMicToGraph(stream);

      // Join room
      const joinRes = await emit<{
        ok: boolean;
        rtpCapabilities: Record<string, unknown>;
        peers: Array<{
          peerId: string;
          displayName: string;
          producers: Array<{ producerId: string; source: string }>;
        }>;
        mode: RoomMode;
        recording: { recordingId: string } | null;
      }>("join", { roomName, displayName, disableP2p: opts?.disableP2p });

      store.getState().setRoom(roomName, displayName, socket.id!);
      store.getState().setMode(joinRes.mode);
      modeRef.current = joinRes.mode;

      // The room may already be recording when we join.
      if (joinRes.recording) {
        store.getState().setRecording(true, joinRes.recording.recordingId);
      }

      // Add existing peers to store
      for (const peer of joinRes.peers) {
        store.getState().addPeer(peer.peerId, peer.displayName);
      }

      if (joinRes.mode === "p2p") {
        // P2P: initiate connections to existing peers (we are the offerer)
        for (const peer of joinRes.peers) {
          await createP2pConnection(peer.peerId, true);
        }
      } else {
        // SFU mode
        await setupSfu(joinRes.rtpCapabilities);
        // Consume existing producers
        for (const peer of joinRes.peers) {
          for (const prod of peer.producers) {
            await consumeProducer(peer.peerId, prod.producerId, prod.source);
          }
        }
      }

      // --- Socket event handlers ---
      socket.on("peer-joined", ({ peerId, displayName: name }: { peerId: string; displayName: string }) => {
        store.getState().addPeer(peerId, name);
        store.getState().announce(`${name} joined the room`);
        playCue(sharedAudioContext, "join");
        // In P2P mode, the new peer will send us an offer — we wait for it
      });

      socket.on("peer-left", ({ peerId }: { peerId: string }) => {
        const name = store.getState().peers.get(peerId)?.displayName ?? "A participant";
        // Clean up P2P connection if any
        const pc = p2pConnectionsRef.current.get(peerId);
        if (pc) {
          pc.close();
          p2pConnectionsRef.current.delete(peerId);
        }
        // Clean up audio
        const peerAudio = peerAudiosRef.current.get(peerId);
        if (peerAudio) {
          destroyAudioPipeline(peerAudio);
          peerAudiosRef.current.delete(peerId);
        }
        store.getState().removePeer(peerId);
        store.getState().announce(`${name} left the room`);
        playCue(sharedAudioContext, "leave");
      });

      // --- Recording (room-wide; the server forces SFU while recording) ---
      socket.on("recording-started", ({ recordingId, by }: { recordingId: string; by: string }) => {
        store.getState().setRecording(true, recordingId);
        store.getState().announce(`Recording started by ${by}`);
      });

      socket.on("recording-stopped", () => {
        // Keep recordingId so the download link stays available after stopping.
        store.getState().setRecording(false);
        store.getState().announce("Recording stopped — still available to download");
      });

      // The finished recording was cleaned up server-side (TTL) — drop the link.
      socket.on("recording-expired", () => {
        store.getState().setRecording(false, null);
        store.getState().announce("Recording is no longer available");
      });

      // P2P signaling relay
      socket.on("p2p-signal", async ({ fromPeerId, type, payload }: {
        fromPeerId: string;
        type: "offer" | "answer" | "ice-candidate";
        payload: RTCSessionDescriptionInit | RTCIceCandidateInit;
      }) => {
        if (type === "offer") {
          // We received an offer — create connection as answerer
          const pc = await createP2pConnection(fromPeerId, false);
          if (!pc) return;
          await pc.setRemoteDescription(new RTCSessionDescription(payload as RTCSessionDescriptionInit));
          const answer = await pc.createAnswer();
          answer.sdp = forceOpusParams(answer.sdp!);
          await pc.setLocalDescription(answer);
          socket.emit("p2p-signal", {
            targetPeerId: fromPeerId,
            type: "answer",
            payload: answer,
          });
        } else if (type === "answer") {
          const pc = p2pConnectionsRef.current.get(fromPeerId);
          if (pc) {
            await pc.setRemoteDescription(new RTCSessionDescription(payload as RTCSessionDescriptionInit));
          }
        } else if (type === "ice-candidate") {
          const pc = p2pConnectionsRef.current.get(fromPeerId);
          if (pc) {
            await pc.addIceCandidate(new RTCIceCandidate(payload as RTCIceCandidateInit));
          }
        }
      });

      // Switch to SFU (3+ peers)
      socket.on("switch-to-sfu", async ({ rtpCapabilities }: { rtpCapabilities: Record<string, unknown> }) => {
        console.log("[mode] switching to SFU");
        teardownP2p();
        modeRef.current = "sfu";
        store.getState().setMode("sfu");

        await setupSfu(rtpCapabilities);

        // The server will send new-producer events for all existing producers after they also set up
      });

      // Switch to P2P (back to 2 peers)
      socket.on("switch-to-p2p", async ({ peerIds }: { peerIds: string[] }) => {
        console.log("[mode] switching to P2P");
        teardownSfu();
        modeRef.current = "p2p";
        store.getState().setMode("p2p");

        // Connect to the other peer (lower socket ID is offerer for determinism)
        const myId = socket.id!;
        for (const peerId of peerIds) {
          if (peerId !== myId) {
            const isOfferer = myId < peerId;
            await createP2pConnection(peerId, isOfferer);
          }
        }
      });

      // SFU: new producer available
      socket.on("new-producer", async ({ peerId, producerId, source }: { peerId: string; producerId: string; source?: string }) => {
        if (modeRef.current === "sfu") {
          await consumeProducer(peerId, producerId, source ?? "voice");
        }
      });

      // Auto-ducking: server says whether anyone is talking right now.
      socket.on("duck", ({ active }: { active: boolean }) => {
        applyDuck(active);
      });

      socket.on("peer-muted", ({ peerId }: { peerId: string }) => {
        store.getState().setPeerMuted(peerId, true);
      });

      socket.on("peer-unmuted", ({ peerId }: { peerId: string }) => {
        store.getState().setPeerMuted(peerId, false);
      });
    },
    [emit, consumeProducer, setupSfu, createP2pConnection, teardownP2p, teardownSfu, applyDuck, store],
  );

  const mute = useCallback(async () => {
    // Mute the local mic track directly. When audio sharing is active the
    // outgoing track is the mixer output, so we only want to silence the
    // mic — system audio should keep flowing.
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (track) track.enabled = false;

    const sharing = store.getState().isSharingAudio;

    // Only pause the producer/peer-mute signal when the mic is the
    // outgoing track. Pausing while sharing audio would also stop the
    // shared system audio.
    if (!sharing) {
      if (modeRef.current === "sfu" && producerRef.current) {
        producerRef.current.pause();
      }
      await emit("producer-pause", {}).catch(() => {});
    }
    store.getState().setMuted(true);
    store.getState().announce("Microphone muted");
    playCue(sharedAudioContext, "mute");
  }, [emit, store]);

  const unmute = useCallback(async () => {
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (track) track.enabled = true;

    const sharing = store.getState().isSharingAudio;
    if (!sharing) {
      if (modeRef.current === "sfu" && producerRef.current) {
        producerRef.current.resume();
      }
      await emit("producer-resume", {}).catch(() => {});
    }
    store.getState().setMuted(false);
    store.getState().announce("Microphone unmuted");
    playCue(sharedAudioContext, "unmute");
  }, [emit, store]);

  const toggleMute = useCallback(async () => {
    if (store.getState().isMuted) await unmute();
    else await mute();
  }, [mute, unmute, store]);

  const toggleDeafen = useCallback(() => {
    store.getState().setDeafened(!store.getState().isDeafened);
    // Recompute every peer's gain so un-deafen restores per-peer volume (and
    // any active music duck) instead of resetting everyone to 1.
    const now = sharedAudioContext.currentTime;
    for (const [peerId, peerAudio] of peerAudiosRef.current) {
      peerAudio.gainNode.gain.setTargetAtTime(effectiveGain(peerId), now, GAIN_RAMP);
    }
  }, [store, effectiveGain]);

  const setPeerVolume = useCallback(
    (peerId: string, volume: number) => {
      store.getState().setPeerVolume(peerId, volume);
      const peerAudio = peerAudiosRef.current.get(peerId);
      if (peerAudio) {
        peerAudio.gainNode.gain.setTargetAtTime(
          effectiveGain(peerId),
          sharedAudioContext.currentTime,
          GAIN_RAMP,
        );
      }
    },
    [store, effectiveGain],
  );

  // --- Audio share: mix system/tab audio into the persistent outgoing graph ---
  // The outgoing track never changes — we just connect/disconnect the display
  // branch — so there's no track-swapping on senders/producer.
  const detachSharedAudio = useCallback(() => {
    const g = outGraphRef.current;
    g?.displaySource?.disconnect();
    if (g) g.displaySource = null;
    displayStreamRef.current?.getTracks().forEach((t) => t.stop());
    displayStreamRef.current = null;
  }, []);

  const stopAudioShare = useCallback(async () => {
    if (!store.getState().isSharingAudio) return;
    detachSharedAudio();
    store.getState().setSharingAudio(false);
  }, [store, detachSharedAudio]);

  const startAudioShare = useCallback(async () => {
    if (store.getState().isSharingAudio) return;
    if (!localStreamRef.current) return;

    // Chrome requires `video: true` to expose system/tab audio. We discard
    // the video track immediately — we only want the audio.
    let displayStream: MediaStream;
    try {
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        } as MediaTrackConstraints,
      });
    } catch {
      // User cancelled the picker, or the browser refused
      return;
    }

    const audioTracks = displayStream.getAudioTracks();
    if (audioTracks.length === 0) {
      displayStream.getTracks().forEach((t) => t.stop());
      alert(
        "No audio was shared. When choosing what to share, tick \"Share system audio\" (entire screen) or \"Share tab audio\" (Chrome tab). On Firefox/Safari this is not supported.",
      );
      return;
    }

    // Discard the video track — we don't need to send any video
    displayStream.getVideoTracks().forEach((t) => t.stop());

    // Mix the shared audio straight into the outgoing destination, bypassing
    // the mic gain/limiter so the music keeps its full dynamics.
    const g = ensureOutGraph();
    const displaySource = sharedAudioContext.createMediaStreamSource(new MediaStream(audioTracks));
    displaySource.connect(g.outDest);
    g.displaySource = displaySource;
    displayStreamRef.current = displayStream;

    // Fire when the user hits the browser's "Stop sharing" UI
    audioTracks[0].addEventListener("ended", () => {
      stopAudioShare();
    });

    store.getState().setSharingAudio(true);
  }, [store, ensureOutGraph, stopAudioShare]);

  const toggleAudioShare = useCallback(async () => {
    if (store.getState().isSharingAudio) await stopAudioShare();
    else await startAudioShare();
  }, [store, startAudioShare, stopAudioShare]);

  // --- Recording ---
  // Recording is server-side: the server taps every participant's stream off
  // the SFU. Starting it forces the room out of P2P (the server can't see P2P
  // media). Download happens via /api/recordings/:id/download at any time.
  const startRecording = useCallback(async () => {
    if (store.getState().isRecording) return;
    try {
      const res = await emit<{ recordingId: string }>("start-recording");
      store.getState().setRecording(true, res.recordingId);
    } catch (err) {
      console.error("[recording] failed to start:", err);
      store.getState().announce("Could not start recording");
    }
  }, [emit, store]);

  const stopRecording = useCallback(async () => {
    if (!store.getState().isRecording) return;
    try {
      await emit("stop-recording");
    } catch (err) {
      console.error("[recording] failed to stop:", err);
    }
    // The server also broadcasts recording-stopped; mark stopped locally but
    // keep recordingId so the download link remains until the file expires.
    store.getState().setRecording(false);
  }, [emit, store]);

  const toggleRecording = useCallback(async () => {
    if (store.getState().isRecording) await stopRecording();
    else await startRecording();
  }, [startRecording, stopRecording, store]);

  // Live mic-gain control: persists the value and ramps the outgoing gain node.
  const setMicGain = useCallback(
    (gain: number) => {
      store.getState().setMicGain(gain);
      const g = outGraphRef.current;
      if (g) g.micGain.gain.setTargetAtTime(gain, sharedAudioContext.currentTime, GAIN_RAMP);
    },
    [store],
  );

  const leave = useCallback(() => {
    detachSharedAudio();
    teardownP2p();
    teardownSfu();
    // Tear down the outgoing graph (nodes live in the shared context, so just
    // disconnect them — the context itself is reused for the next room).
    const g = outGraphRef.current;
    if (g) {
      g.micSource?.disconnect();
      g.micGain.disconnect();
      g.limiter.disconnect();
      g.displaySource?.disconnect();
      outGraphRef.current = null;
    }
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    socketRef.current?.disconnect();
    socketRef.current = null;
    deviceRef.current = null;
    store.getState().reset();
  }, [teardownP2p, teardownSfu, detachSharedAudio, store]);

  useEffect(() => {
    return () => {
      leave();
    };
  }, [leave]);

  return {
    join,
    leave,
    mute,
    unmute,
    toggleMute,
    toggleDeafen,
    toggleAudioShare,
    toggleRecording,
    startRecording,
    stopRecording,
    setPeerVolume,
    setMicGain,
    peerAudiosRef,
  };
}
