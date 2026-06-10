import type {
  Router,
  WebRtcTransport,
  Producer,
  Consumer,
  Worker,
  AudioLevelObserver,
} from "mediasoup/types";
import { routerOptions, transportOptions } from "./mediasoup-config.js";
import type { ChatMessage } from "./chat-util.js";

export interface Peer {
  id: string;
  displayName: string;
  // Mirrors the client's mute toggle (set via producer-pause/-resume, which
  // fire in P2P mode too) so late joiners can render existing peers' state.
  muted: boolean;
  sendTransport: WebRtcTransport | null;
  recvTransport: WebRtcTransport | null;
  producers: Map<string, Producer>;
  consumers: Map<string, Consumer>;
}

export type RoomMode = "p2p" | "sfu";

export interface Room {
  name: string;
  router: Router;
  peers: Map<string, Peer>;
  mode: RoomMode;
  // P2P explicitly disabled for this room (via the `?p2p=off` room URL param).
  // Pins the room to the SFU even with <=2 peers; sticky for the room's
  // lifetime once any joiner sets it (see decideMode's forceSfu).
  disableP2p: boolean;
  // Peer ids of send-only "music caster" peers (e.g. Ecobox). While any are
  // present the room is forced to SFU (see decideMode's forceSfu).
  casters: Set<string>;
  // Peer ids currently sharing system/tab audio. Their share is a *separate*
  // stereo "share" producer (the voice track stays mono), which the server has
  // to route — so an active sharer forces SFU just like a caster does.
  sharers: Set<string>;
  // Watches VOICE producers only (music producers are never added) to drive
  // auto-ducking: when someone talks, listeners lower the music peer's volume.
  audioLevelObserver: AudioLevelObserver;
  // Latched ducking state so we only broadcast on transitions, and whether the
  // observer's events have been wired (done once per room in signaling).
  voiceActive: boolean;
  observerWired: boolean;
  // Rolling chat history (bounded to CHAT_HISTORY_MAX) so late joiners receive
  // recent messages on join. Newest last.
  messages: ChatMessage[];
}

const rooms = new Map<string, Room>();

let workers: Worker[] = [];
let workerIdx = 0;

export function setWorkers(w: Worker[]) {
  workers = w;
}

function getNextWorker(): Worker {
  const worker = workers[workerIdx % workers.length];
  workerIdx++;
  return worker;
}

export async function getOrCreateRoom(roomName: string): Promise<Room> {
  const existing = rooms.get(roomName);
  if (existing) return existing;

  const worker = getNextWorker();
  const router = await worker.createRouter(routerOptions);

  // -50 dBov ignores room/keyboard noise but catches normal speech; a short
  // interval keeps ducking responsive. Closed automatically with the router.
  const audioLevelObserver = await router.createAudioLevelObserver({
    maxEntries: 1,
    threshold: -50,
    interval: 300,
  });

  const room: Room = {
    name: roomName,
    router,
    peers: new Map(),
    mode: "p2p",
    disableP2p: false,
    casters: new Set(),
    sharers: new Set(),
    audioLevelObserver,
    voiceActive: false,
    observerWired: false,
    messages: [],
  };
  rooms.set(roomName, room);
  return room;
}

export function createPeer(room: Room, peerId: string, displayName: string): Peer {
  const peer: Peer = {
    id: peerId,
    displayName,
    muted: false,
    sendTransport: null,
    recvTransport: null,
    producers: new Map(),
    consumers: new Map(),
  };
  room.peers.set(peerId, peer);
  return peer;
}

export async function createWebRtcTransport(room: Room) {
  const transport = await room.router.createWebRtcTransport(transportOptions);

  // Reduce latency: set max incoming bitrate
  await transport.setMaxIncomingBitrate(1500000);

  return {
    transport,
    params: {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    },
  };
}

export function removePeer(room: Room, peerId: string) {
  const peer = room.peers.get(peerId);
  if (!peer) return;

  // Close all transports (this also closes producers/consumers)
  peer.sendTransport?.close();
  peer.recvTransport?.close();

  room.peers.delete(peerId);

  // If room is empty, destroy it
  if (room.peers.size === 0) {
    room.router.close();
    rooms.delete(room.name);
  }
}

export function getRooms() {
  return rooms;
}
