import { useRef, useCallback, useEffect } from "react";
import { io, type Socket } from "socket.io-client";
import { Device } from "mediasoup-client";
import type { Transport, Producer, Consumer } from "mediasoup-client/types";
import { forceOpusParams } from "../lib/sdp-munger";
import { applySpeakerToContext } from "../lib/audio-devices";
import { playCue } from "../lib/sounds";
import { formatMessage, RateLimiter, META_SEP, type ChatMessage } from "../lib/chat";
import {
  announce_joined,
  announce_left,
  announce_music_started,
  announce_music_stopped,
  announce_chat_hint,
  announce_a_participant,
  announce_recording_started,
  announce_recording_stopped,
  announce_recording_unavailable,
  announce_recording_failed,
  announce_streaming_started,
  announce_streaming_stopped,
  announce_streaming_failed,
  announce_streaming_failed_reason,
  announce_mic_muted,
  announce_mic_unmuted,
  announce_share_started,
  announce_share_stopped,
  announce_share_started_you,
  announce_share_stopped_you,
  share_stream_name,
} from "../paraglide/messages.js";
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

// iOS/iPadOS Safari (iPadOS now reports as "MacIntel" + touch). WebKit's audio
// stack is behind the "sample rate keeps breaking" reports: it fights a forced
// AudioContext/getUserMedia sample rate that doesn't match the current hardware
// route, and it drops the whole context into an "interrupted" state on any route
// change (Bluetooth/headset connect, the session flipping to voice-chat when a
// peer joins, Siri, backgrounding).
const isIOS =
  typeof navigator !== "undefined" &&
  (/iP(hone|ad|od)/.test(navigator.userAgent) ||
    // iPadOS 13+ reports a desktop "Macintosh" UA; a touch-capable Mac is one.
    (/Mac/.test(navigator.userAgent) && navigator.maxTouchPoints > 1));

// Mic constraints. On iOS we drop the sample-rate hint: forcing a rate the
// current route can't honour (e.g. a Bluetooth headset locked to 16 kHz) yields
// garbled/pitched capture. WebRTC/Opus negotiates its own rate regardless.
// The selected mic is `ideal`, not `exact`, so a remembered-but-unplugged
// device falls back to the default instead of failing the join.
function micConstraints(channelCount: 1 | 2, deviceId?: string): MediaTrackConstraints {
  return {
    channelCount,
    ...(isIOS ? {} : { sampleRate: 48000 }),
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    ...(deviceId ? { deviceId: { ideal: deviceId } } : {}),
  };
}

// Shared AudioContext — single output buffer for all peers (lower latency than
// one per peer). On iOS we let it adopt the device-native rate instead of pinning
// 48 kHz, so WebKit doesn't resample/fight the hardware on every route change;
// other browsers honour the pin cleanly.
const sharedAudioContext = new AudioContext({
  ...(isIOS ? {} : { sampleRate: 48000 }),
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

// Keep the shared context running. iOS needs a user gesture to start it, and it
// also drops to "suspended" or the WebKit-only "interrupted" state whenever the
// audio route changes / the tab backgrounds — and without re-resuming, audio dies
// until a reload (this is what "keeps fucking up" mid-call). So we resume on the
// first AND every gesture, on each statechange, and when the tab refocuses.
function resumeSharedContext() {
  const state = sharedAudioContext.state as string;
  if (state === "suspended" || state === "interrupted") {
    // iOS rejects resume() while still interrupted (e.g. mid phone call); the
    // statechange/visibility/gesture retries pick it up once it's allowed again.
    sharedAudioContext.resume().catch(() => {});
  }
}
document.addEventListener("touchstart", resumeSharedContext);
document.addEventListener("click", resumeSharedContext);
sharedAudioContext.addEventListener("statechange", resumeSharedContext);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") resumeSharedContext();
});

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
  // Remote ICE candidates that arrived before their peer connection had a
  // remote description (or before it existed at all) — applied after
  // setRemoteDescription instead of being dropped (addIceCandidate throws
  // without a remote description, and a lost host candidate can stall ICE).
  const pendingCandidatesRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  // Monotonic per-peer offer counter: a queued offer handler bails when a
  // newer offer from the same peer arrived while it waited in the transition
  // chain — answering the superseded one would consume the newer session's
  // queued candidates and build a dead connection.
  const offerSeqRef = useRef<Map<string, number>>(new Map());
  const modeRef = useRef<RoomMode>("p2p");
  // Producers announced while the SFU transports were still being built —
  // consumed at the end of setupSfu instead of being silently dropped.
  const pendingProducersRef = useRef<Array<{ peerId: string; producerId: string; source: string }>>(
    [],
  );
  // P2P↔SFU transitions (and reconnect rebuilds) are serialized through this
  // promise chain so an in-flight transition always finishes tearing down /
  // building up before the next starts — overlapping async handlers could
  // otherwise re-add stale connections after a newer teardown already ran.
  const transitionChainRef = useRef<Promise<void>>(Promise.resolve());
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
    // Shared system/tab audio gets its OWN destination so it's produced as a
    // separate stereo "share" track — the voice track (outDest) stays mono.
    shareDest: MediaStreamAudioDestinationNode | null;
    micStream: MediaStream | null;
  } | null>(null);
  // Audio share (system / tab audio produced as its own stereo "share" track)
  const displayStreamRef = useRef<MediaStream | null>(null);
  // The local stereo "share" producer (SFU), separate from the voice producer.
  const musicProducerRef = useRef<Producer | null>(null);
  // Other peers' incoming share streams: producerId -> owner peerId, so we can
  // tear down a share "music" tile when its owner stops sharing or leaves.
  const shareOwnersRef = useRef<Map<string, string>>(new Map());
  // Local anti-spam guard for instant "thunk" feedback (the server enforces the
  // same 5-per-10s budget authoritatively).
  const chatLimiterRef = useRef(new RateLimiter());
  // The first received chat message carries a one-time hint that Alt+1..0
  // reads recent messages aloud even with the chat panel closed.
  const chatHintGivenRef = useRef(false);

  const store = useRoomStore;

  // Queue `fn` behind any in-flight mode transition. The chain itself never
  // breaks (failures are surfaced to the caller's promise, then swallowed for
  // the next link), so one failed transition can't wedge all later ones.
  const runTransition = useCallback(<T>(fn: () => Promise<T>): Promise<T> => {
    const run = transitionChainRef.current.then(fn);
    transitionChainRef.current = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }, []);

  const emit = useCallback(
    <T>(event: string, data?: unknown): Promise<T> =>
      new Promise((resolve, reject) => {
        const socket = socketRef.current;
        if (!socket) return reject(new Error("No socket"));
        // The timeout matters beyond slow servers: if the socket drops while
        // an ack is pending, socket.io NEVER invokes the callback — an
        // un-timed-out emit inside a queued transition would leave the
        // transition chain pending forever and block the reconnect rejoin.
        socket
          .timeout(10_000)
          .emit(event, data, (err: Error | null, res: T & { ok: boolean; error?: string }) => {
            if (err) return reject(err);
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
    // Share streams are keyed in peerAudiosRef too; drop their owner mapping so
    // a re-consume (mode switch / reconnect) rebuilds it cleanly.
    shareOwnersRef.current.clear();
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
      shareDest: null,
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

  // --- Device selection (set in the lobby or via the in-call settings) ---
  const micDeviceId = useRoomStore((s) => s.micDeviceId);
  const speakerDeviceId = useRoomStore((s) => s.speakerDeviceId);

  // All incoming audio plays through the shared context, so the speaker pick
  // is one setSinkId there — it covers every peer, current and future.
  useEffect(() => {
    applySpeakerToContext(sharedAudioContext, speakerDeviceId);
  }, [speakerDeviceId]);

  // Mid-call mic switch: re-acquire the mic on the new device and reroute it
  // into the outgoing graph. Senders/producers never see the swap — they
  // always carry outDest's track. Guarded by a prev-ref so it only runs on an
  // actual change; before a call (no local stream) join() picks the device up.
  const prevMicDeviceRef = useRef(micDeviceId);
  useEffect(() => {
    if (prevMicDeviceRef.current === micDeviceId) return;
    prevMicDeviceRef.current = micDeviceId;
    if (!localStreamRef.current) return;
    let cancelled = false;
    void (async () => {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: micConstraints(2, micDeviceId),
        });
      } catch (err) {
        console.error("[mic] device switch failed:", err);
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      // Carry an active mute onto the fresh track before it can leak audio.
      if (store.getState().isMuted) stream.getAudioTracks().forEach((t) => (t.enabled = false));
      const old = localStreamRef.current;
      localStreamRef.current = stream;
      connectMicToGraph(stream);
      old?.getTracks().forEach((t) => t.stop());
    })();
    return () => {
      cancelled = true;
    };
  }, [micDeviceId, connectMicToGraph, store]);

  // --- P2P: create a peer connection ---
  const ensureLocalStream = useCallback(async () => {
    const existing = localStreamRef.current;
    const track = existing?.getAudioTracks()[0];
    if (track && track.readyState === "live") return existing!;

    // Re-acquire mic (on the user's selected device, if any)
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: micConstraints(1, useRoomStore.getState().micDeviceId),
    });
    localStreamRef.current = stream;
    connectMicToGraph(stream);
    return stream;
  }, [connectMicToGraph]);

  const createP2pConnection = useCallback(
    async (peerId: string, isOfferer: boolean) => {
      const socket = socketRef.current;
      if (!socket) return;

      // If we already have a connection to this peer (a re-offer, or a mode
      // switch re-establishing the mesh), tear it down first so the peer map
      // never ends up pointing at a stale/duplicate RTCPeerConnection — ICE
      // candidates are routed by peer id, and a dead PC in the map silently
      // sinks them so ICE never completes.
      const stale = p2pConnectionsRef.current.get(peerId);
      if (stale) {
        stale.close();
        p2pConnectionsRef.current.delete(peerId);
      }

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
        // Respect deafen / per-peer volume on a (re)built P2P pipeline too —
        // otherwise an SFU→P2P switch resets everyone to full volume and a
        // deafened listener starts hearing audio again.
        pipeline.gainNode.gain.value = effectiveGain(peerId);
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
    [ensureLocalStream, connectMicToGraph, ensureOutGraph, effectiveGain],
  );

  // Apply candidates that were queued for a peer while its connection had no
  // remote description yet. Call right after setRemoteDescription.
  const flushPendingCandidates = useCallback(async (peerId: string, pc: RTCPeerConnection) => {
    const pending = pendingCandidatesRef.current.get(peerId);
    pendingCandidatesRef.current.delete(peerId);
    if (!pending) return;
    for (const candidate of pending) {
      await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch((err) => {
        console.error("[p2p] queued addIceCandidate failed:", err);
      });
    }
  }, []);

  // --- P2P: tear down all connections ---
  const teardownP2p = useCallback(() => {
    for (const pc of p2pConnectionsRef.current.values()) {
      pc.close();
    }
    p2pConnectionsRef.current.clear();
    pendingCandidatesRef.current.clear();
    cleanupAllPeerAudio();
  }, [cleanupAllPeerAudio]);

  // --- SFU: tear down mediasoup transports ---
  const teardownSfu = useCallback(() => {
    producerRef.current?.close();
    producerRef.current = null;
    musicProducerRef.current?.close();
    musicProducerRef.current = null;
    sendTransportRef.current?.close();
    sendTransportRef.current = null;
    recvTransportRef.current?.close();
    recvTransportRef.current = null;
    pendingProducersRef.current = [];
    // Candidates queued here can only be trailing ones from a dead P2P epoch
    // (a new P2P session's candidates can't arrive before its offer) — drop
    // them so they never flush into a future session's connection.
    pendingCandidatesRef.current.clear();
    cleanupAllPeerAudio();
  }, [cleanupAllPeerAudio]);

  // --- SFU: consume a producer ---
  const consumeProducer = useCallback(
    async (peerId: string, producerId: string, source: string = "voice") => {
      const device = deviceRef.current;
      const recvTransport = recvTransportRef.current;
      if (!device || !recvTransport) {
        // SFU setup is still in flight — queue it for the end of setupSfu
        // (dropping it would permanently silence this producer for us).
        pendingProducersRef.current.push({ peerId, producerId, source });
        return;
      }

      const res = await emit<ConsumeResult>("consume", {
        producerId,
        rtpCapabilities: device.rtpCapabilities,
      });

      const consumer = await recvTransport.consume({
        id: res.consumerId,
        producerId: res.producerId,
        kind: res.kind as "audio",
        rtpParameters: res.rtpParameters as Parameters<
          typeof recvTransport.consume
        >[0]["rtpParameters"],
      });

      if ("playoutDelayHint" in consumer.track) {
        (consumer.track as unknown as Record<string, number>).playoutDelayHint = 0;
      }

      const pipeline = createAudioPipeline(consumer.track);

      // A "share" is a peer casting system/tab audio as a SEPARATE stereo
      // producer (their voice stays its own mono track). Represent it as its
      // own "music stream" participant keyed by the producer id, so a peer that
      // produces BOTH voice and a share never collides in the peer/audio maps.
      // Stereo is preserved end-to-end by createAudioPipeline.
      if (source === "share") {
        const ownerName =
          store.getState().peers.get(peerId)?.displayName ?? announce_a_participant();
        store.getState().addPeer(producerId, share_stream_name({ name: ownerName }));
        store.getState().setPeerMusic(producerId, true);
        shareOwnersRef.current.set(producerId, peerId);
        peerAudiosRef.current.set(producerId, { ...pipeline, consumer });
        pipeline.gainNode.gain.value = effectiveGain(producerId);
        return;
      }

      peerAudiosRef.current.set(peerId, { ...pipeline, consumer });

      // Flag a music-caster peer (e.g. Ecobox) so the UI shows it as a media
      // source. Stereo is preserved end-to-end by createAudioPipeline. The
      // first time we learn this peer casts music, announce + log it — a
      // re-consume (mode switch / reconnect) finds isMusic already set, so it
      // never re-announces.
      if (source === "music") {
        if (!store.getState().peers.get(peerId)?.isMusic) {
          const name = store.getState().peers.get(peerId)?.displayName ?? announce_a_participant();
          store.getState().announceEvent(announce_music_started({ name }));
        }
        store.getState().setPeerMusic(peerId, true);
      }

      // Start at the correct gain: respects deafen, and ducks immediately if a
      // voice is already active when this (music) producer joins.
      pipeline.gainNode.gain.value = effectiveGain(peerId);
    },
    [emit, store, effectiveGain],
  );

  // Produce the shared system/tab audio as a SEPARATE stereo, hi-fi "share"
  // track (the router's 256 kbps ceiling lets it negotiate full quality). The
  // voice producer is untouched, so voice stays mono/64k. SFU-only — an active
  // share forces the room onto the SFU server-side. Idempotent.
  const produceShare = useCallback(async () => {
    const sendTransport = sendTransportRef.current;
    const device = deviceRef.current;
    const g = outGraphRef.current;
    if (!sendTransport || !device || !g?.shareDest) return;
    if (musicProducerRef.current && !musicProducerRef.current.closed) return;
    const track = g.shareDest.stream.getAudioTracks()[0];
    if (!track) return;
    musicProducerRef.current = await sendTransport.produce({
      track,
      codecOptions: {
        opusStereo: true,
        opusDtx: false,
        opusFec: true,
        opusMaxPlaybackRate: 48000,
        opusMaxAverageBitrate: 256000,
      },
      codec: device.rtpCapabilities.codecs?.find((c) => c.mimeType.toLowerCase() === "audio/opus"),
      appData: { source: "share" },
      // shareDest is an app-owned, long-lived Web Audio track reused across the
      // session; mediasoup-client must NOT stop it when this producer closes
      // (default stopTracks:true would kill it, so a later re-produce sends a
      // dead track and no RTP flows).
      stopTracks: false,
    });
  }, []);

  // Tear down an incoming peer's share "music stream" (they stopped, or left).
  const removeShareStream = useCallback(
    (producerId: string) => {
      const pa = peerAudiosRef.current.get(producerId);
      if (pa) {
        destroyAudioPipeline(pa);
        peerAudiosRef.current.delete(producerId);
      }
      shareOwnersRef.current.delete(producerId);
      store.getState().removePeer(producerId);
    },
    [store],
  );

  // --- SFU: set up transports and produce ---
  const setupSfuInner = useCallback(
    async (rtpCapabilities: Record<string, unknown>) => {
      // Re-acquires the mic if its track died (e.g. iOS killed it during the
      // outage that preceded a reconnect) — producing from a dead source
      // would silently send silence for the rest of the session.
      const localStream = await ensureLocalStream();
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

      sendTransport.on("produce", async ({ kind, rtpParameters, appData }, callback, errback) => {
        try {
          // Forward the track's source ("voice" default, or "share" for a
          // stereo audio share) so the server tags/routes it correctly.
          const res = await emit<{ producerId: string }>("produce", {
            kind,
            rtpParameters,
            source: (appData as { source?: string })?.source,
          });
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
        codec: device.rtpCapabilities.codecs?.find(
          (c) => c.mimeType.toLowerCase() === "audio/opus",
        ),
        // outDest is an app-owned, long-lived Web Audio track reused for the
        // whole session and across P2P↔SFU switches; mediasoup-client must NOT
        // stop it when this producer closes (default stopTracks:true would kill
        // it, so the next produce sends a dead track and no RTP flows).
        stopTracks: false,
      });
      producerRef.current = producer;

      // If we were already sharing audio (a mode switch into SFU, or a
      // reconnect mid-share), rebuild the separate stereo share producer too.
      if (store.getState().isSharingAudio) await produceShare();

      // Consume any producers announced while the transports were still being
      // built (their new-producer events arrived too early and were queued).
      while (pendingProducersRef.current.length > 0) {
        const pending = pendingProducersRef.current.shift()!;
        await consumeProducer(pending.peerId, pending.producerId, pending.source).catch((err) => {
          console.error("[sfu] queued consume failed:", err);
        });
      }
    },
    [
      emit,
      connectMicToGraph,
      ensureLocalStream,
      ensureOutGraph,
      produceShare,
      consumeProducer,
      store,
    ],
  );

  // setupSfu never leaves a half-built SFU behind on failure — a live-but-
  // broken sendTransport would arm the switch-to-sfu idempotency guard and
  // block the next rebuild from ever running.
  const setupSfu = useCallback(
    async (rtpCapabilities: Record<string, unknown>) => {
      try {
        await setupSfuInner(rtpCapabilities);
      } catch (err) {
        teardownSfu();
        throw err;
      }
    },
    [setupSfuInner, teardownSfu],
  );

  // --- Main join ---
  const join = useCallback(
    async (
      roomName: string,
      displayName: string,
      opts?: { disableP2p?: boolean; isPublic?: boolean },
    ) => {
      // Acquire stereo audio + build the outgoing graph BEFORE connecting so
      // it's ready the moment we (re)join. The mic, AudioContext and outgoing
      // track are reused for the whole session and survive reconnects, so a
      // network blip never re-prompts for the mic or rebuilds the send chain.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: micConstraints(2, store.getState().micDeviceId),
      });
      localStreamRef.current = stream;
      connectMicToGraph(stream);

      const socket = io({ transports: ["websocket"] });
      socketRef.current = socket;

      // (Re)join the room and (re)build all media from the server's response.
      // Runs on the initial join AND on every reconnect; it never registers
      // socket handlers (those are attached once, below, and persist across
      // reconnects).
      const joinAndSetup = async () => {
        const joinRes = await emit<{
          ok: boolean;
          rtpCapabilities: Record<string, unknown>;
          peers: Array<{
            peerId: string;
            displayName: string;
            muted?: boolean;
            producers: Array<{ producerId: string; source: string }>;
          }>;
          mode: RoomMode;
          recording: { recordingId: string } | null;
          streaming?: boolean;
          voiceActive?: boolean;
          messages: ChatMessage[];
        }>("join", {
          roomName,
          displayName,
          disableP2p: opts?.disableP2p,
          // List this room in the lobby's public directory (sticky server-side).
          isPublic: opts?.isPublic,
          // On a reconnect mid-share, re-pin SFU so the share rebuilds.
          sharing: store.getState().isSharingAudio,
        });

        store.getState().setRoom(roomName, displayName, socket.id!);
        store.getState().setMode(joinRes.mode);
        modeRef.current = joinRes.mode;

        // Seed the current duck state BEFORE consuming, so a music peer that's
        // being talked over starts ducked instead of blasting at full volume
        // until the next talk-start/stop transition.
        isVoiceActiveRef.current = !!joinRes.voiceActive;

        // Seed chat history (de-duped in the store, silent — no chime/announce).
        for (const m of joinRes.messages ?? []) store.getState().addMessage(m);

        // Sync recording state — it may have started/stopped while we were away.
        store
          .getState()
          .setRecording(
            !!joinRes.recording,
            joinRes.recording ? joinRes.recording.recordingId : null,
          );
        // Likewise the room-wide live-streaming state.
        store.getState().setStreaming(!!joinRes.streaming);

        // Reconcile the peer list: drop anyone who left while we were
        // disconnected, add newcomers. addPeer resets per-peer state, so only
        // add peers we don't already track (keeps volume/mute across a rejoin).
        const present = new Set(joinRes.peers.map((p) => p.peerId));
        for (const id of [...store.getState().peers.keys()]) {
          if (!present.has(id)) store.getState().removePeer(id);
        }
        for (const peer of joinRes.peers) {
          if (!store.getState().peers.has(peer.peerId)) {
            store.getState().addPeer(peer.peerId, peer.displayName);
          }
          // Server truth for mute state — a late joiner (or a reconnect that
          // missed the peer-muted events) renders existing mutes correctly.
          store.getState().setPeerMuted(peer.peerId, !!peer.muted);
        }

        // Producers queued before this ack (stale modeRef during a rejoin) are
        // all covered by the join snapshot below — draining them too would
        // consume them twice and double that peer's audio.
        pendingProducersRef.current = [];

        if (joinRes.mode === "p2p") {
          // P2P: we're the newcomer, so we offer to every existing peer (they
          // wait for the offer in the p2p-signal handler).
          for (const peer of joinRes.peers) {
            await createP2pConnection(peer.peerId, true);
          }
        } else {
          // SFU mode: set up transports, then consume existing producers.
          await setupSfu(joinRes.rtpCapabilities);
          for (const peer of joinRes.peers) {
            for (const prod of peer.producers) {
              await consumeProducer(peer.peerId, prod.producerId, prod.source);
            }
          }
        }
      };

      // socket.io fires "connect" on the first connection AND on every
      // reconnection — each reconnect gets a NEW socket id, so the server has
      // already dropped our old peer and we must rejoin from scratch. Without
      // this, a transient drop silently left us in a room the server no longer
      // knew about: the call appeared to "drop", and a forced-SFU room (e.g.
      // ?p2p=off) could fall back to P2P for the peers that stayed.
      let hasJoined = false;
      let resolveReady!: () => void;
      let rejectReady!: (err: unknown) => void;
      const ready = new Promise<void>((res, rej) => {
        resolveReady = res;
        rejectReady = rej;
      });

      socket.on("connect", async () => {
        store.getState().setConnected(true);
        try {
          // Serialized with the mode-switch handlers so a rejoin never
          // interleaves with an in-flight P2P↔SFU transition.
          await runTransition(async () => {
            if (hasJoined) {
              console.log("[ws] reconnected — rejoining room");
              // The old transports / peer connections are dead; rebuild them.
              teardownP2p();
              teardownSfu();
            }
            await joinAndSetup();
          });
          if (!hasJoined) {
            hasJoined = true;
            resolveReady();
          }
        } catch (err) {
          if (hasJoined) console.error("[ws] rejoin failed:", err);
          else rejectReady(err);
        }
      });

      socket.on("disconnect", () => {
        store.getState().setConnected(false);
      });

      // --- Socket event handlers (attached once; persist across reconnects) ---
      socket.on(
        "peer-joined",
        ({ peerId, displayName: name }: { peerId: string; displayName: string }) => {
          store.getState().addPeer(peerId, name);
          store.getState().announce(announce_joined({ name }));
          const joinTs = Date.now();
          store.getState().addMessage({
            id: `sys-join-${peerId}-${joinTs}`,
            sender: name,
            text: "",
            ts: joinTs,
            kind: "join",
          });
          playCue(sharedAudioContext, "join");
          // In P2P mode, the new peer will send us an offer — we wait for it
        },
      );

      socket.on("peer-left", ({ peerId }: { peerId: string }) => {
        const name = store.getState().peers.get(peerId)?.displayName ?? announce_a_participant();
        const wasMusic = !!store.getState().peers.get(peerId)?.isMusic;
        // Clean up P2P connection if any
        const pc = p2pConnectionsRef.current.get(peerId);
        if (pc) {
          pc.close();
          p2pConnectionsRef.current.delete(peerId);
        }
        pendingCandidatesRef.current.delete(peerId);
        // Clean up audio
        const peerAudio = peerAudiosRef.current.get(peerId);
        if (peerAudio) {
          destroyAudioPipeline(peerAudio);
          peerAudiosRef.current.delete(peerId);
        }
        // Drop any share "music stream" tiles this peer owned (they may have
        // left mid-share, without a stop-share/share-stopped first).
        for (const [producerId, owner] of shareOwnersRef.current) {
          if (owner === peerId) removeShareStream(producerId);
        }
        store.getState().removePeer(peerId);
        if (wasMusic) {
          // A music caster (e.g. Ecobox) going away reads as the music
          // stopping, not as a participant leaving.
          store.getState().announceEvent(announce_music_stopped({ name }));
        } else {
          store.getState().announce(announce_left({ name }));
          const leaveTs = Date.now();
          store.getState().addMessage({
            id: `sys-leave-${peerId}-${leaveTs}`,
            sender: name,
            text: "",
            ts: leaveTs,
            kind: "leave",
          });
        }
        playCue(sharedAudioContext, "leave");
      });

      // --- Recording (room-wide; the server forces SFU while recording) ---
      socket.on("recording-started", ({ recordingId, by }: { recordingId: string; by: string }) => {
        // Two near-simultaneous starts can broadcast this twice for the same
        // recording — announce it only once.
        const s = store.getState();
        if (s.isRecording && s.recordingId === recordingId) return;
        s.setRecording(true, recordingId);
        s.announceEvent(announce_recording_started({ name: by }));
      });

      socket.on("recording-stopped", () => {
        // Keep recordingId so the download link stays available after stopping.
        store.getState().setRecording(false);
        store.getState().announceEvent(announce_recording_stopped());
      });

      // The finished recording was cleaned up server-side (TTL) — drop the link.
      socket.on("recording-expired", () => {
        store.getState().setRecording(false, null);
        store.getState().announceEvent(announce_recording_unavailable());
      });

      // --- Live streaming (room-wide; the server forces SFU while streaming) ---
      socket.on("streaming-started", ({ by }: { by: string }) => {
        const s = store.getState();
        if (s.isStreaming) return; // de-dupe near-simultaneous starts
        s.setStreaming(true);
        s.announceEvent(announce_streaming_started({ name: by }));
      });

      socket.on("streaming-stopped", () => {
        if (!store.getState().isStreaming) return;
        store.getState().setStreaming(false);
        store.getState().announceEvent(announce_streaming_stopped());
      });

      // The server's mixer died on its own (bad Icecast target, unreachable, …).
      // `error` is the server's already-classified, human-readable reason — keep
      // it so the Streaming panel can show what to fix, and read it aloud.
      socket.on("streaming-failed", ({ error }: { error?: string } = {}) => {
        const s = store.getState();
        s.setStreaming(false);
        const reason = error?.trim() || "";
        s.setStreamError(reason || null);
        s.announceEvent(
          reason ? announce_streaming_failed_reason({ reason }) : announce_streaming_failed(),
        );
      });

      // P2P signaling relay
      socket.on(
        "p2p-signal",
        async ({
          fromPeerId,
          type,
          payload,
        }: {
          fromPeerId: string;
          type: "offer" | "answer" | "ice-candidate";
          payload: RTCSessionDescriptionInit | RTCIceCandidateInit;
        }) => {
          if (type === "offer") {
            // Candidates already queued for this peer belong to a previous
            // session — a session's candidates always arrive after its offer —
            // so clear them NOW, at offer arrival; everything queued from this
            // point on belongs to the session this offer starts.
            pendingCandidatesRef.current.delete(fromPeerId);
            const seq = (offerSeqRef.current.get(fromPeerId) ?? 0) + 1;
            offerSeqRef.current.set(fromPeerId, seq);
            // Serialized behind any in-flight transition: answering immediately
            // could build a pipeline that a queued teardown then destroys.
            void runTransition(async () => {
              // Re-checked at run time — ignore offers from a stale P2P epoch
              // (relayed just before a switch-to-sfu), and offers superseded by
              // a newer one from the same peer while this waited in the chain.
              if (modeRef.current !== "p2p") return;
              if (offerSeqRef.current.get(fromPeerId) !== seq) return;
              // We received an offer — create connection as answerer
              const pc = await createP2pConnection(fromPeerId, false);
              if (!pc) return;
              await pc.setRemoteDescription(
                new RTCSessionDescription(payload as RTCSessionDescriptionInit),
              );
              await flushPendingCandidates(fromPeerId, pc);
              const answer = await pc.createAnswer();
              answer.sdp = forceOpusParams(answer.sdp!);
              await pc.setLocalDescription(answer);
              socket.emit("p2p-signal", {
                targetPeerId: fromPeerId,
                type: "answer",
                payload: answer,
              });
            }).catch((err) => console.error("[p2p] offer handling failed:", err));
          } else if (type === "answer") {
            const pc = p2pConnectionsRef.current.get(fromPeerId);
            if (pc) {
              await pc.setRemoteDescription(
                new RTCSessionDescription(payload as RTCSessionDescriptionInit),
              );
              await flushPendingCandidates(fromPeerId, pc);
            }
          } else if (type === "ice-candidate") {
            const pc = p2pConnectionsRef.current.get(fromPeerId);
            if (pc?.remoteDescription) {
              await pc.addIceCandidate(new RTCIceCandidate(payload as RTCIceCandidateInit));
            } else {
              // No remote description yet (its offer/answer is still being
              // processed) — addIceCandidate would throw and lose the
              // candidate. Queue it; flushed right after setRemoteDescription.
              const pending = pendingCandidatesRef.current.get(fromPeerId) ?? [];
              pending.push(payload as RTCIceCandidateInit);
              pendingCandidatesRef.current.set(fromPeerId, pending);
            }
          }
        },
      );

      // Switch to SFU (3+ peers)
      socket.on(
        "switch-to-sfu",
        ({ rtpCapabilities }: { rtpCapabilities: Record<string, unknown> }) => {
          console.log("[mode] switching to SFU");
          // Mode flips synchronously (event arrival order = server truth) so
          // other handlers route correctly even while the rebuild is queued.
          modeRef.current = "sfu";
          store.getState().setMode("sfu");
          void runTransition(async () => {
            // Already on a live SFU (e.g. our own join response said "sfu" and
            // this broadcast raced it) — rebuilding would duplicate transports
            // and producers, so peers would hear us twice.
            if (sendTransportRef.current && !sendTransportRef.current.closed) return;
            teardownP2p();
            await setupSfu(rtpCapabilities);
            // The server will send new-producer events for all existing producers after they also set up
          }).catch((err) => console.error("[mode] switch to SFU failed:", err));
        },
      );

      // Switch to P2P (back to 2 peers)
      socket.on("switch-to-p2p", ({ peerIds }: { peerIds: string[] }) => {
        console.log("[mode] switching to P2P");
        // Mode flips synchronously so an offer arriving right behind this
        // event isn't dropped by the p2p-signal handler's mode guard.
        modeRef.current = "p2p";
        store.getState().setMode("p2p");
        void runTransition(async () => {
          teardownSfu();

          // Re-establish the mesh. Only the lower-id peer initiates; the higher-id
          // peer waits for the offer and builds its side in the p2p-signal handler
          // (same convention as the initial join). Previously BOTH sides called
          // createP2pConnection here, which raced with the incoming offer also
          // creating one — the peer map could end up pointing at the orphaned PC,
          // so ICE candidates went to a dead connection and the call silently
          // dropped on every SFU→P2P switch (stopping a recording, or a caster
          // leaving).
          const myId = socket.id!;
          for (const peerId of peerIds) {
            if (peerId !== myId && myId < peerId) {
              await createP2pConnection(peerId, true);
            }
          }
        }).catch((err) => console.error("[mode] switch to P2P failed:", err));
      });

      // SFU: new producer available
      socket.on(
        "new-producer",
        async ({
          peerId,
          producerId,
          source,
        }: {
          peerId: string;
          producerId: string;
          source?: string;
        }) => {
          if (modeRef.current !== "sfu") return;
          try {
            await consumeProducer(peerId, producerId, source ?? "voice");
          } catch (err) {
            console.error("[sfu] consume failed:", err);
          }
        },
      );

      // Auto-ducking: server says whether anyone is talking right now.
      socket.on("duck", ({ active }: { active: boolean }) => {
        applyDuck(active);
      });

      // A peer started sharing system/tab audio — announce it + play a cue.
      // Their stereo "share" stream arrives separately via new-producer.
      socket.on(
        "share-started",
        ({ displayName: name }: { peerId: string; displayName: string }) => {
          store.getState().announceEvent(announce_share_started({ name }));
          playCue(sharedAudioContext, "share-start");
        },
      );

      // A peer stopped sharing — tear down their share "music stream" tile(s),
      // announce it, and play a cue.
      socket.on(
        "share-stopped",
        ({ peerId, displayName: name }: { peerId: string; displayName: string }) => {
          for (const [producerId, owner] of shareOwnersRef.current) {
            if (owner === peerId) removeShareStream(producerId);
          }
          store.getState().announceEvent(announce_share_stopped({ name }));
          playCue(sharedAudioContext, "share-stop");
        },
      );

      socket.on("peer-muted", ({ peerId }: { peerId: string }) => {
        store.getState().setPeerMuted(peerId, true);
      });

      socket.on("peer-unmuted", ({ peerId }: { peerId: string }) => {
        store.getState().setPeerMuted(peerId, false);
      });

      // Incoming chat (including the echo of our own messages): render it, chime
      // a distinct cue, and announce it on the polite ARIA region.
      socket.on("chat-message", (msg: ChatMessage) => {
        store.getState().addMessage(msg);
        let announcement = formatMessage(msg, Date.now());
        // First message of the session: tell SR users once that Alt+1..0 reads
        // the recent messages aloud even while the chat panel is closed.
        if (!chatHintGivenRef.current) {
          chatHintGivenRef.current = true;
          announcement += `${META_SEP}${announce_chat_hint()}`;
        }
        store.getState().announce(announcement);
        playCue(sharedAudioContext, "message");
      });

      // Resolve once the first connect → join → media setup has completed (or
      // reject if that initial join fails), so callers can flip to "joined".
      await ready;
    },
    [
      emit,
      consumeProducer,
      setupSfu,
      createP2pConnection,
      connectMicToGraph,
      teardownP2p,
      teardownSfu,
      applyDuck,
      removeShareStream,
      runTransition,
      flushPendingCandidates,
      store,
    ],
  );

  const mute = useCallback(async () => {
    // Silence the mic track (feeds the voice graph only); any shared system
    // audio is a separate track/producer, so it keeps flowing. The server
    // pauses just the VOICE producer, so muting never cuts the music.
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (track) track.enabled = false;

    if (modeRef.current === "sfu" && producerRef.current) {
      producerRef.current.pause();
    }
    await emit("producer-pause", {}).catch(() => {});
    store.getState().setMuted(true);
    store.getState().announceEvent(announce_mic_muted());
    playCue(sharedAudioContext, "mute");
  }, [emit, store]);

  const unmute = useCallback(async () => {
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (track) track.enabled = true;

    if (modeRef.current === "sfu" && producerRef.current) {
      producerRef.current.resume();
    }
    await emit("producer-resume", {}).catch(() => {});
    store.getState().setMuted(false);
    store.getState().announceEvent(announce_mic_unmuted());
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

  // --- Audio share: cast system/tab audio as a SEPARATE stereo producer ---
  // The shared audio gets its own destination (shareDest) and its own stereo
  // "share" producer, so the voice track stays mono/64k and is never touched.
  const detachSharedAudio = useCallback(() => {
    const g = outGraphRef.current;
    g?.displaySource?.disconnect();
    g?.shareDest?.disconnect();
    if (g) {
      g.displaySource = null;
      g.shareDest = null;
    }
    displayStreamRef.current?.getTracks().forEach((t) => t.stop());
    displayStreamRef.current = null;
  }, []);

  const stopAudioShare = useCallback(async () => {
    if (!store.getState().isSharingAudio) return;
    // Close our stereo share producer, then detach the shared-audio nodes.
    if (musicProducerRef.current) {
      if (!musicProducerRef.current.closed) musicProducerRef.current.close();
      musicProducerRef.current = null;
    }
    detachSharedAudio();
    store.getState().setSharingAudio(false);
    // Tell the server: drop us from the sharer set (may release the SFU pin)
    // and close the server-side producer so peers' tiles disappear.
    await emit("stop-share").catch(() => {});
    // Local feedback; peers get theirs via the share-stopped broadcast.
    store.getState().announceEvent(announce_share_stopped_you());
    playCue(sharedAudioContext, "share-stop");
  }, [store, detachSharedAudio, emit]);

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
          // Exclude this page's own playback (the other participants) from
          // system-audio capture, so they don't get looped back and doubled.
          // Chrome 140+ on Windows/macOS; ignored elsewhere.
          restrictOwnAudio: true,
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
        'No audio was shared. When choosing what to share, tick "Share system audio" (entire screen) or "Share tab audio" (Chrome tab). On Firefox/Safari this is not supported.',
      );
      return;
    }

    // Discard the video track — we don't need to send any video
    displayStream.getVideoTracks().forEach((t) => t.stop());

    // Route the shared audio into its OWN destination (not the voice graph), so
    // it becomes a separate stereo producer and the voice track stays mono.
    const g = ensureOutGraph();
    const shareDest = sharedAudioContext.createMediaStreamDestination();
    const displaySource = sharedAudioContext.createMediaStreamSource(new MediaStream(audioTracks));
    displaySource.connect(shareDest);
    g.displaySource = displaySource;
    g.shareDest = shareDest;
    displayStreamRef.current = displayStream;

    // Fire when the user hits the browser's "Stop sharing" UI
    audioTracks[0].addEventListener("ended", () => {
      stopAudioShare();
    });

    store.getState().setSharingAudio(true);

    // A stereo producer must be routed by the server, so pin the room to SFU.
    // If we're already on the SFU, produce now; otherwise the resulting
    // switch-to-sfu rebuilds the SFU and setupSfu produces the share (it sees
    // isSharingAudio). Either way produceShare is idempotent.
    const wasSfu = modeRef.current === "sfu";
    await emit("start-share").catch(() => {});
    if (wasSfu) await produceShare();

    // Local feedback; peers get theirs via the share-started broadcast.
    store.getState().announceEvent(announce_share_started_you());
    playCue(sharedAudioContext, "share-start");
  }, [store, ensureOutGraph, stopAudioShare, produceShare, emit]);

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
      store.getState().announceEvent(announce_recording_failed());
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

  // --- Live streaming to Icecast ---
  // Like recording, this is server-side and room-wide: the server taps every
  // participant's stream off the SFU, mixes it, and pushes it to the Icecast
  // target supplied here. Starting it forces the room out of P2P. Throws (with
  // the server's reason) so the settings UI can surface a bad target.
  const startStreaming = useCallback(async () => {
    if (store.getState().isStreaming) return;
    store.getState().setStreamError(null); // drop any stale failure before retrying
    const { host, port, mount, username, password, format, bitrateKbps } =
      store.getState().streamConfig;
    await emit("start-streaming", {
      host: host.trim(),
      port,
      mount: mount.trim(),
      username: username.trim() || "source",
      password,
      format,
      bitrateKbps,
    });
    // The server also broadcasts streaming-started; reflect it immediately so
    // the button flips without waiting for the echo.
    store.getState().setStreaming(true);
  }, [emit, store]);

  const stopStreaming = useCallback(async () => {
    if (!store.getState().isStreaming) return;
    try {
      await emit("stop-streaming");
    } catch (err) {
      console.error("[streaming] failed to stop:", err);
    }
    store.getState().setStreaming(false);
  }, [emit, store]);

  const toggleStreaming = useCallback(async () => {
    if (store.getState().isStreaming) await stopStreaming();
    else await startStreaming();
  }, [startStreaming, stopStreaming, store]);

  // Live mic-gain control: persists the value and ramps the outgoing gain node.
  const setMicGain = useCallback(
    (gain: number) => {
      store.getState().setMicGain(gain);
      const g = outGraphRef.current;
      if (g) g.micGain.gain.setTargetAtTime(gain, sharedAudioContext.currentTime, GAIN_RAMP);
    },
    [store],
  );

  // Send a chat message. Returns why it didn't go out so the caller can keep
  // the text in the box ("empty"/"rate_limited" — never cleared on failure).
  // A blocked send plays the "thunk" cue; the delivered message comes back via
  // the `chat-message` echo, which is what renders/announces/chimes it.
  const sendChatMessage = useCallback(
    async (text: string): Promise<{ ok: boolean; reason?: "empty" | "rate_limited" }> => {
      const trimmed = text.trim();
      if (!trimmed) return { ok: false, reason: "empty" };
      if (!chatLimiterRef.current.tryConsume()) {
        playCue(sharedAudioContext, "thunk");
        return { ok: false, reason: "rate_limited" };
      }
      try {
        await emit("chat-message", { text: trimmed });
        return { ok: true };
      } catch {
        // Server rejected (its budget was also spent via the API, or transient).
        playCue(sharedAudioContext, "thunk");
        return { ok: false, reason: "rate_limited" };
      }
    },
    [emit],
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
      g.shareDest?.disconnect();
      outGraphRef.current = null;
    }
    musicProducerRef.current = null;
    shareOwnersRef.current.clear();
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
    startStreaming,
    stopStreaming,
    toggleStreaming,
    setPeerVolume,
    setMicGain,
    sendChatMessage,
    peerAudiosRef,
  };
}
