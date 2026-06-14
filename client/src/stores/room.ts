import { create } from "zustand";
import type { ChatMessage } from "../lib/chat";
import { getLocale, setLocale as applyParaglideLocale, type Locale } from "../lib/i18n";

// Keep the in-memory chat bounded; the server caps history too. Newest last.
const CHAT_MESSAGES_MAX = 200;

// Outgoing mic gain is a per-device preference, so it's persisted and survives
// reloads — and carries from the lobby's mic preview into the room.
const MIC_GAIN_KEY = "sonicroom:micGain";
export const MAX_MIC_GAIN = 4;

function loadMicGain(): number {
  try {
    const v = parseFloat(localStorage.getItem(MIC_GAIN_KEY) ?? "");
    if (Number.isFinite(v)) return Math.min(MAX_MIC_GAIN, Math.max(0, v));
  } catch {
    // localStorage unavailable (e.g. private mode) — fall back to unity.
  }
  return 1;
}

// Selected audio devices ("" = browser default). Per-device preferences like
// micGain: persisted, and carried from the lobby preview into the call.
const MIC_DEVICE_KEY = "sonicroom:micDeviceId";
const SPEAKER_DEVICE_KEY = "sonicroom:speakerDeviceId";

function loadString(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function saveString(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Persistence is best-effort; keep the in-memory value regardless.
  }
}

// Icecast streaming target. Persisted (incl. password) so the user configures
// it once and can re-stream without retyping — same "remember my settings"
// treatment as the mic/speaker choice. Sent to the server on start-streaming
// and never broadcast to other peers.
export type StreamFormat = "mp3" | "opus";
export interface StreamConfig {
  host: string;
  port: number;
  mount: string;
  username: string;
  password: string;
  format: StreamFormat;
  bitrateKbps: number;
}

const STREAM_CONFIG_KEY = "sonicroom:streamConfig";

export const DEFAULT_STREAM_CONFIG: StreamConfig = {
  host: "",
  port: 8000,
  mount: "/sonicroom",
  username: "source",
  password: "",
  format: "mp3",
  bitrateKbps: 160,
};

function loadStreamConfig(): StreamConfig {
  try {
    const raw = localStorage.getItem(STREAM_CONFIG_KEY);
    if (raw) return { ...DEFAULT_STREAM_CONFIG, ...(JSON.parse(raw) as Partial<StreamConfig>) };
  } catch {
    // Missing/corrupt/unavailable — fall back to defaults.
  }
  return { ...DEFAULT_STREAM_CONFIG };
}

export interface PeerState {
  peerId: string;
  displayName: string;
  isSpeaking: boolean;
  isMuted: boolean;
  volume: number; // 0-4
  // True for a send-only "music caster" peer (e.g. Ecobox): rendered with a
  // music icon and treated as a media source rather than a talking participant.
  isMusic: boolean;
}

export type RoomMode = "p2p" | "sfu";

interface RoomState {
  // Active UI language. Mirrors Paraglide's runtime locale so a change here
  // re-renders the tree (see main.tsx's App); the actual messages are resolved
  // by the generated m.*() functions, not from this field.
  locale: Locale;

  // Connection
  connected: boolean;
  roomName: string | null;
  displayName: string | null;
  localPeerId: string | null;
  mode: RoomMode;

  // Local controls
  isMuted: boolean;
  isDeafened: boolean;
  isPushToTalk: boolean;
  pttActive: boolean;
  isSharingAudio: boolean;
  // Outgoing (send-side) mic gain applied before the track reaches peers/SFU,
  // 0–MAX_MIC_GAIN. 1 = unity (raw mic). Lets a quiet/cheap mic be boosted for
  // everyone, independent of each listener's per-peer playback volume.
  micGain: number;
  // Selected input/output devices ("" = browser default). The lobby preview
  // and the in-call media graph both follow these (see DeviceSettings).
  micDeviceId: string;
  speakerDeviceId: string;

  // Recording (a recording belongs to the room; visible to everyone)
  isRecording: boolean;
  recordingId: string | null;

  // Live Icecast streaming (room-wide, like recording — everyone sees it's
  // live). `streamConfig` is this client's persisted Icecast target (the only
  // place the password lives); `isStreaming` is the room-wide live state.
  isStreaming: boolean;
  streamConfig: StreamConfig;
  // Last streaming failure reason (server-supplied), shown in the Streaming
  // panel. Set when the server reports the stream died (bad target, unreachable,
  // auth, …); cleared on a fresh start/stop. Null when there's nothing to show.
  streamError: string | null;

  // Latest screen-reader announcement (peer join/leave, recording, etc.).
  // `announceSeq` changes on every announce() so React re-renders even when
  // the same message repeats.
  announcement: string;
  announceSeq: number;

  // Peers
  peers: Map<string, PeerState>;

  // Chat messages in arrival order (newest last). Seeded with room history on
  // join, then appended as `chat-message` events arrive (including our own).
  messages: ChatMessage[];

  // Actions
  setLanguage: (locale: Locale) => void;
  setConnected: (connected: boolean) => void;
  setRoom: (roomName: string, displayName: string, localPeerId: string) => void;
  setMode: (mode: RoomMode) => void;
  setMuted: (muted: boolean) => void;
  setDeafened: (deafened: boolean) => void;
  setPttActive: (active: boolean) => void;
  togglePushToTalk: () => void;
  setSharingAudio: (sharing: boolean) => void;
  setMicGain: (gain: number) => void;
  setMicDeviceId: (deviceId: string) => void;
  setSpeakerDeviceId: (deviceId: string) => void;
  setRecording: (recording: boolean, recordingId?: string | null) => void;
  setStreaming: (streaming: boolean) => void;
  setStreamConfig: (config: StreamConfig) => void;
  setStreamError: (error: string | null) => void;
  announce: (message: string) => void;
  announceEvent: (message: string) => void;
  addMessage: (message: ChatMessage) => void;
  addPeer: (peerId: string, displayName: string) => void;
  removePeer: (peerId: string) => void;
  setPeerSpeaking: (peerId: string, speaking: boolean) => void;
  setPeerMuted: (peerId: string, muted: boolean) => void;
  setPeerVolume: (peerId: string, volume: number) => void;
  setPeerMusic: (peerId: string, isMusic: boolean) => void;
  reset: () => void;
}

export const useRoomStore = create<RoomState>((set) => ({
  locale: getLocale(),
  connected: false,
  roomName: null,
  displayName: null,
  localPeerId: null,
  mode: "p2p",
  isMuted: false,
  isDeafened: false,
  isPushToTalk: false,
  pttActive: false,
  isSharingAudio: false,
  micGain: loadMicGain(),
  micDeviceId: loadString(MIC_DEVICE_KEY),
  speakerDeviceId: loadString(SPEAKER_DEVICE_KEY),
  isRecording: false,
  recordingId: null,
  isStreaming: false,
  streamConfig: loadStreamConfig(),
  streamError: null,
  announcement: "",
  announceSeq: 0,
  peers: new Map(),
  messages: [],

  setLanguage: (locale) => {
    // reload:false — App re-renders in place on the store change below, so a
    // language switch (even mid-call) never tears down the connection.
    applyParaglideLocale(locale, { reload: false });
    document.documentElement.lang = locale;
    set({ locale });
  },
  setConnected: (connected) => set({ connected }),
  setRoom: (roomName, displayName, localPeerId) => set({ roomName, displayName, localPeerId }),
  setMode: (mode) => set({ mode }),
  setMuted: (isMuted) => set({ isMuted }),
  setDeafened: (isDeafened) => set({ isDeafened }),
  setPttActive: (pttActive) => set({ pttActive }),
  togglePushToTalk: () => set((s) => ({ isPushToTalk: !s.isPushToTalk })),
  setSharingAudio: (isSharingAudio) => set({ isSharingAudio }),
  setMicGain: (micGain) => {
    try {
      localStorage.setItem(MIC_GAIN_KEY, String(micGain));
    } catch {
      // Persistence is best-effort; keep the in-memory value regardless.
    }
    set({ micGain });
  },
  setMicDeviceId: (micDeviceId) => {
    saveString(MIC_DEVICE_KEY, micDeviceId);
    set({ micDeviceId });
  },
  setSpeakerDeviceId: (speakerDeviceId) => {
    saveString(SPEAKER_DEVICE_KEY, speakerDeviceId);
    set({ speakerDeviceId });
  },
  setRecording: (isRecording, recordingId) =>
    set((s) => ({
      isRecording,
      recordingId: recordingId !== undefined ? recordingId : s.recordingId,
    })),
  // Going live clears any stale failure from a previous attempt; a stop leaves
  // the last error untouched (stopping doesn't surface one). streaming-failed
  // sets the reason explicitly via setStreamError.
  setStreaming: (isStreaming) =>
    set(isStreaming ? { isStreaming, streamError: null } : { isStreaming }),
  setStreamConfig: (streamConfig) => {
    saveString(STREAM_CONFIG_KEY, JSON.stringify(streamConfig));
    set({ streamConfig });
  },
  setStreamError: (streamError) => set({ streamError }),
  announce: (message) => set((s) => ({ announcement: message, announceSeq: s.announceSeq + 1 })),

  // Room-event announcement (recording/share/music/mute…): speak it AND log it
  // into the chat history as a "system" entry, so chat is the single timeline
  // of everything that was ever announced (rule: announcements go to chat).
  // Bare announce() stays reserved for re-reading chat content that is already
  // in history (incoming messages, the Alt+number readback).
  announceEvent: (message) =>
    set((s) => {
      const ts = Date.now();
      const messages = [
        ...s.messages,
        {
          id: `sys-evt-${ts}-${s.announceSeq + 1}`,
          sender: "",
          text: message,
          ts,
          kind: "system" as const,
        },
      ];
      if (messages.length > CHAT_MESSAGES_MAX)
        messages.splice(0, messages.length - CHAT_MESSAGES_MAX);
      return { announcement: message, announceSeq: s.announceSeq + 1, messages };
    }),

  addMessage: (message) =>
    set((s) => {
      // De-dupe: the sender receives its own message via the room broadcast,
      // and join history may overlap with an in-flight message.
      if (s.messages.some((m) => m.id === message.id)) return s;
      const messages = [...s.messages, message];
      if (messages.length > CHAT_MESSAGES_MAX)
        messages.splice(0, messages.length - CHAT_MESSAGES_MAX);
      return { messages };
    }),

  addPeer: (peerId, displayName) =>
    set((state) => {
      const peers = new Map(state.peers);
      peers.set(peerId, {
        peerId,
        displayName,
        isSpeaking: false,
        isMuted: false,
        volume: 1,
        isMusic: false,
      });
      return { peers };
    }),

  removePeer: (peerId) =>
    set((state) => {
      const peers = new Map(state.peers);
      peers.delete(peerId);
      return { peers };
    }),

  setPeerSpeaking: (peerId, speaking) =>
    set((state) => {
      const peers = new Map(state.peers);
      const peer = peers.get(peerId);
      if (peer) peers.set(peerId, { ...peer, isSpeaking: speaking });
      return { peers };
    }),

  setPeerMuted: (peerId, muted) =>
    set((state) => {
      const peers = new Map(state.peers);
      const peer = peers.get(peerId);
      if (peer) peers.set(peerId, { ...peer, isMuted: muted });
      return { peers };
    }),

  setPeerVolume: (peerId, volume) =>
    set((state) => {
      const peers = new Map(state.peers);
      const peer = peers.get(peerId);
      if (peer) peers.set(peerId, { ...peer, volume });
      return { peers };
    }),

  setPeerMusic: (peerId, isMusic) =>
    set((state) => {
      const peers = new Map(state.peers);
      const peer = peers.get(peerId);
      if (peer) peers.set(peerId, { ...peer, isMusic });
      return { peers };
    }),

  reset: () =>
    set({
      connected: false,
      roomName: null,
      displayName: null,
      localPeerId: null,
      mode: "p2p",
      isMuted: false,
      isDeafened: false,
      isPushToTalk: false,
      pttActive: false,
      isSharingAudio: false,
      isRecording: false,
      recordingId: null,
      // Keep streamConfig (a persisted preference); only the live state resets.
      isStreaming: false,
      streamError: null,
      announcement: "",
      announceSeq: 0,
      peers: new Map(),
      messages: [],
    }),
}));
