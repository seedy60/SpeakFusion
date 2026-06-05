import { useRef, useCallback, useEffect } from "react";
import { io, type Socket } from "socket.io-client";
import { Device } from "mediasoup-client";
import type { Transport, Producer, Consumer } from "mediasoup-client/types";
import { forceOpusParams } from "../lib/sdp-munger";
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
  // P2P
  const p2pConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const modeRef = useRef<RoomMode>("p2p");
  // Audio share (system / tab audio mixed with mic)
  const displayStreamRef = useRef<MediaStream | null>(null);
  const mixContextRef = useRef<AudioContext | null>(null);
  const mixDestinationRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const mixMicSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const mixDisplaySourceRef = useRef<MediaStreamAudioSourceNode | null>(null);

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

  // --- Shared: clean up all peer audio ---
  const cleanupAllPeerAudio = useCallback(() => {
    for (const pa of peerAudiosRef.current.values()) {
      destroyAudioPipeline(pa);
    }
    peerAudiosRef.current.clear();
  }, []);

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
    return stream;
  }, []);

  const createP2pConnection = useCallback(
    async (peerId: string, isOfferer: boolean) => {
      const socket = socketRef.current;
      if (!socket) return;

      const localStream = await ensureLocalStream();

      const pc = new RTCPeerConnection({
        iceServers: ICE_SERVERS,
      });

      // Add local audio track
      const audioTrack = localStream.getAudioTracks()[0];
      pc.addTrack(audioTrack, localStream);

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
    [],
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
    async (peerId: string, producerId: string) => {
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
    },
    [emit],
  );

  // --- SFU: set up transports and produce ---
  const setupSfu = useCallback(
    async (rtpCapabilities: Record<string, unknown>) => {
      const localStream = localStreamRef.current;
      if (!localStream) return;

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

      // Produce audio
      const audioTrack = localStream.getAudioTracks()[0];
      const producer = await sendTransport.produce({
        track: audioTrack,
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
    [emit],
  );

  // --- Main join ---
  const join = useCallback(
    async (roomName: string, displayName: string) => {
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

      // Join room
      const joinRes = await emit<{
        ok: boolean;
        rtpCapabilities: Record<string, unknown>;
        peers: Array<{ peerId: string; displayName: string; producerIds: string[] }>;
        mode: RoomMode;
        recording: { recordingId: string } | null;
      }>("join", { roomName, displayName });

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
          for (const producerId of peer.producerIds) {
            await consumeProducer(peer.peerId, producerId);
          }
        }
      }

      // --- Socket event handlers ---
      socket.on("peer-joined", ({ peerId, displayName: name }: { peerId: string; displayName: string }) => {
        store.getState().addPeer(peerId, name);
        store.getState().announce(`${name} joined the room`);
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
      socket.on("new-producer", async ({ peerId, producerId }: { peerId: string; producerId: string }) => {
        if (modeRef.current === "sfu") {
          await consumeProducer(peerId, producerId);
        }
      });

      socket.on("peer-muted", ({ peerId }: { peerId: string }) => {
        store.getState().setPeerMuted(peerId, true);
      });

      socket.on("peer-unmuted", ({ peerId }: { peerId: string }) => {
        store.getState().setPeerMuted(peerId, false);
      });
    },
    [emit, consumeProducer, setupSfu, createP2pConnection, teardownP2p, teardownSfu, store],
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
  }, [emit, store]);

  const toggleMute = useCallback(async () => {
    if (store.getState().isMuted) await unmute();
    else await mute();
  }, [mute, unmute, store]);

  const toggleDeafen = useCallback(() => {
    const deafened = !store.getState().isDeafened;
    store.getState().setDeafened(deafened);
    for (const peerAudio of peerAudiosRef.current.values()) {
      peerAudio.gainNode.gain.value = deafened ? 0 : 1;
    }
  }, [store]);

  const setPeerVolume = useCallback(
    (peerId: string, volume: number) => {
      const peerAudio = peerAudiosRef.current.get(peerId);
      if (peerAudio) {
        peerAudio.gainNode.gain.value = volume;
      }
      store.getState().setPeerVolume(peerId, volume);
    },
    [store],
  );

  // --- Audio share: replace outgoing track in both P2P senders and the SFU producer ---
  const swapOutgoingAudioTrack = useCallback(async (track: MediaStreamTrack) => {
    for (const pc of p2pConnectionsRef.current.values()) {
      const sender = pc.getSenders().find((s) => s.track?.kind === "audio");
      if (sender) {
        try {
          await sender.replaceTrack(track);
        } catch (e) {
          console.error("[audio-share] replaceTrack failed on P2P sender", e);
        }
      }
    }
    if (producerRef.current) {
      try {
        await producerRef.current.replaceTrack({ track });
      } catch (e) {
        console.error("[audio-share] replaceTrack failed on SFU producer", e);
      }
    }
  }, []);

  const tearDownAudioShare = useCallback(() => {
    mixMicSourceRef.current?.disconnect();
    mixMicSourceRef.current = null;
    mixDisplaySourceRef.current?.disconnect();
    mixDisplaySourceRef.current = null;
    mixDestinationRef.current?.disconnect();
    mixDestinationRef.current = null;
    mixContextRef.current?.close().catch(() => {});
    mixContextRef.current = null;
    displayStreamRef.current?.getTracks().forEach((t) => t.stop());
    displayStreamRef.current = null;
  }, []);

  const stopAudioShare = useCallback(async () => {
    if (!store.getState().isSharingAudio) return;

    // Restore the raw mic track on all outgoing senders/producer
    const micTrack = localStreamRef.current?.getAudioTracks()[0];
    if (micTrack) {
      // Re-apply current mute state to the underlying track
      micTrack.enabled = !store.getState().isMuted;
      await swapOutgoingAudioTrack(micTrack);
    }

    tearDownAudioShare();
    store.getState().setSharingAudio(false);
  }, [store, swapOutgoingAudioTrack, tearDownAudioShare]);

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

    // Build the mixer graph
    const ctx = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
    const destination = ctx.createMediaStreamDestination();

    const micSource = ctx.createMediaStreamSource(localStreamRef.current);
    micSource.connect(destination);

    const displayAudioOnly = new MediaStream(audioTracks);
    const displaySource = ctx.createMediaStreamSource(displayAudioOnly);
    displaySource.connect(destination);

    mixContextRef.current = ctx;
    mixDestinationRef.current = destination;
    mixMicSourceRef.current = micSource;
    mixDisplaySourceRef.current = displaySource;
    displayStreamRef.current = displayStream;

    const mixedTrack = destination.stream.getAudioTracks()[0];

    // Fire when the user hits the browser's "Stop sharing" UI
    audioTracks[0].addEventListener("ended", () => {
      stopAudioShare();
    });

    await swapOutgoingAudioTrack(mixedTrack);
    store.getState().setSharingAudio(true);
  }, [store, swapOutgoingAudioTrack, stopAudioShare]);

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

  const leave = useCallback(() => {
    tearDownAudioShare();
    teardownP2p();
    teardownSfu();
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    socketRef.current?.disconnect();
    socketRef.current = null;
    deviceRef.current = null;
    store.getState().reset();
  }, [teardownP2p, teardownSfu, tearDownAudioShare, store]);

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
    peerAudiosRef,
  };
}
