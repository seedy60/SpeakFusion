import type { WorkerSettings, RouterOptions, WebRtcTransportOptions } from "mediasoup/types";
import os from "node:os";

const numCores = os.cpus().length;

export const workerSettings: WorkerSettings = {
  logLevel: "warn",
  rtcMinPort: 40000,
  rtcMaxPort: 40100,
};

export const numWorkers = Math.max(1, numCores);

export const routerOptions: RouterOptions = {
  mediaCodecs: [
    {
      kind: "audio",
      mimeType: "audio/opus",
      clockRate: 48000,
      channels: 2,
      parameters: {
        useinbandfec: 1,
        usedtx: 0,
        maxplaybackrate: 48000,
        maxaveragebitrate: 64000,
        minptime: 10,
        ptime: 10,
      },
    },
  ],
};

export const transportOptions: WebRtcTransportOptions = {
  // UDP only. We deliberately don't advertise TCP ICE candidates: the firewall
  // only opens this range for UDP, and TCP fallback is already handled by the
  // shared coturn (TURN over 3478/tcp, TURNS over 5349/tls). Advertising
  // unreachable TCP candidates just made ICE slower (clients probed dead
  // candidates before relaying via coturn anyway).
  listenInfos: [
    {
      protocol: "udp",
      ip: "0.0.0.0",
      announcedAddress: process.env.ANNOUNCED_IP || undefined,
    },
    {
      protocol: "udp",
      ip: "::",
      announcedAddress: process.env.ANNOUNCED_IP6 || undefined,
    },
  ],
  initialAvailableOutgoingBitrate: 600000,
  enableUdp: true,
  enableTcp: false,
  preferUdp: true,
  iceConsentTimeout: 20,
};
