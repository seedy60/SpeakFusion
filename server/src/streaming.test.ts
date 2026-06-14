import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { RtpParameters, RtpCapabilities } from "mediasoup/types";
import { StreamManager, type StreamDeps } from "./streaming.js";
import type {
  SpawnedProcess,
  RecordingRouter,
  RtpPlainTransport,
  RtpConsumer,
} from "./recording.js";
import { PortAllocator } from "./recording-util.js";
import type { IcecastConfig } from "./streaming-util.js";

// --- Fakes (same shape as recording.test.ts) ------------------------------

class FakeProcess extends EventEmitter implements SpawnedProcess {
  pid = 1;
  stdout = new EventEmitter() as unknown as NodeJS.ReadableStream;
  stderr = new EventEmitter() as unknown as NodeJS.ReadableStream;
  killed = false;
  lastSignal: NodeJS.Signals | number | undefined;
  constructor(
    public command: string,
    public args: string[],
  ) {
    super();
  }
  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    this.lastSignal = signal;
    return true;
  }
}

const RTP: RtpParameters = {
  codecs: [
    {
      mimeType: "audio/opus",
      payloadType: 100,
      clockRate: 48000,
      channels: 2,
      parameters: { minptime: 10 },
      rtcpFeedback: [],
    },
  ],
  encodings: [{ ssrc: 111 }],
  headerExtensions: [],
  rtcp: {},
} as unknown as RtpParameters;

class FakeConsumer implements RtpConsumer {
  kind = "audio";
  rtpParameters = RTP;
  closed = false;
  resumed = false;
  constructor(public id: string) {}
  async resume() {
    this.resumed = true;
  }
  close() {
    this.closed = true;
  }
}

class FakeTransport implements RtpPlainTransport {
  closed = false;
  connected?: { ip: string; port: number };
  consumer?: FakeConsumer;
  constructor(public id: string) {}
  async connect(params: { ip: string; port: number }) {
    this.connected = params;
  }
  async consume(params: { producerId: string }) {
    this.consumer = new FakeConsumer(`consumer-${params.producerId}`);
    return this.consumer;
  }
  close() {
    this.closed = true;
  }
}

class FakeRouter implements RecordingRouter {
  rtpCapabilities = { codecs: [], headerExtensions: [] } as unknown as RtpCapabilities;
  transports: FakeTransport[] = [];
  async createPlainTransport() {
    const t = new FakeTransport(`transport-${this.transports.length}`);
    this.transports.push(t);
    return t;
  }
}

const CONFIG: IcecastConfig = {
  host: "stream.example.com",
  port: 8000,
  mount: "/sonicroom",
  username: "source",
  password: "hackme",
  format: "mp3",
  bitrateKbps: 128,
};

interface Harness {
  manager: StreamManager;
  router: FakeRouter;
  spawned: FakeProcess[];
  rmCalls: string[];
  writes: { file: string; data: string }[];
  ports: PortAllocator;
  timers: Array<{ fn: () => void; ms: number }>;
}

// `failMixerWith` makes every spawned mixer die on the next microtask, emitting
// the given stderr line first — used to drive the startup-failure path (start()
// rejects with the classified reason during its grace window).
function makeHarness(opts: { failMixerWith?: string } = {}): Harness {
  const spawned: FakeProcess[] = [];
  const rmCalls: string[] = [];
  const writes: { file: string; data: string }[] = [];
  const router = new FakeRouter();
  const ports = new PortAllocator(51000, 51020, 2);
  const timers: Array<{ fn: () => void; ms: number }> = [];

  const deps: Partial<StreamDeps> = {
    spawn: (command, args) => {
      const p = new FakeProcess(command, args);
      spawned.push(p);
      if (opts.failMixerWith !== undefined) {
        queueMicrotask(() => {
          p.stderr.emit("data", Buffer.from(opts.failMixerWith!));
          p.emit("exit", 1, null);
        });
      }
      return p;
    },
    mkdir: async () => {},
    writeFile: async (file, data) => {
      writes.push({ file, data });
    },
    rm: async (dir) => {
      rmCalls.push(dir);
    },
    sleep: async () => {},
    setTimer: (fn, ms) => {
      const entry = { fn, ms };
      timers.push(entry);
      return entry;
    },
    clearTimer: (handle) => {
      const i = timers.indexOf(handle as { fn: () => void; ms: number });
      if (i >= 0) timers.splice(i, 1);
    },
    tmpRoot: "/tmp/test-stream",
    ports,
    ffmpegPath: "ffmpeg",
    rtpListenIp: "127.0.0.1",
    resumeDelayMs: 0,
    rebuildDebounceMs: 500,
    log: () => {},
  };

  return { manager: new StreamManager(deps), router, spawned, rmCalls, writes, ports, timers };
}

// Let any queued microtasks (buildMixer's awaits) settle.
async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

// Fire all pending debounce timers (and any they schedule), then settle.
async function runTimers(h: Harness) {
  while (h.timers.length) {
    const t = h.timers.shift()!;
    t.fn();
    await flush();
  }
}

const PRODUCERS = [
  { producerId: "p1", peerId: "alice" },
  { producerId: "p2", peerId: "bob" },
];

// All spawned processes are mixers (streaming has no per-feed ffmpeg). The live
// mixer always carries the silent anchor.
function mixers(h: Harness): FakeProcess[] {
  return h.spawned.filter((p) => p.args.some((a) => a.includes("anullsrc")));
}
function lastMixer(h: Harness): FakeProcess {
  const m = mixers(h);
  return m[m.length - 1];
}
function sdpInputs(p: FakeProcess): string[] {
  return p.args.filter((a, i) => p.args[i - 1] === "-i" && a.endsWith(".sdp"));
}

describe("StreamManager.start", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it("creates one feed per producer and spawns a single mixer to Icecast", async () => {
    const stream = await h.manager.start("room1", h.router, PRODUCERS, CONFIG);

    // one transport/consumer/SDP per producer
    assert.equal(stream.feeds.size, 2);
    assert.equal(h.router.transports.length, 2);
    assert.equal(h.writes.length, 2);
    assert.ok(h.writes.every((w) => w.file.endsWith(".sdp")));
    assert.equal(h.ports.size, 2);

    // exactly one mixer, ending at the icecast URL, with both SDP inputs
    assert.equal(mixers(h).length, 1);
    const mix = lastMixer(h);
    assert.ok(mix.args.at(-1)!.startsWith("icecast://source:hackme@stream.example.com:8000"));
    assert.equal(sdpInputs(mix).length, 2);

    // consumers were created paused, then resumed once the mixer was up
    assert.ok(h.router.transports.every((t) => t.consumer?.resumed));
    assert.equal(h.manager.isStreaming("room1"), true);
  });

  it("is idempotent — a second start returns the same stream", async () => {
    const s1 = await h.manager.start("room1", h.router, PRODUCERS, CONFIG);
    const s2 = await h.manager.start("room1", h.router, PRODUCERS, CONFIG);
    assert.equal(s1, s2);
    assert.equal(mixers(h).length, 1);
  });

  it("starts with no producers (streaming forces a P2P→SFU switch first)", async () => {
    const stream = await h.manager.start("room1", h.router, [], CONFIG);
    assert.equal(stream.feeds.size, 0);
    // still spawns a mixer — the silent anchor keeps the Icecast source alive
    assert.equal(mixers(h).length, 1);
    assert.equal(sdpInputs(lastMixer(h)).length, 0);
    assert.equal(h.manager.isStreaming("room1"), true);
  });
});

describe("StreamManager.addProducer / removeProducer", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it("adds a feed and rebuilds the mixer (debounced)", async () => {
    await h.manager.start("room1", h.router, [], CONFIG);
    assert.equal(mixers(h).length, 1);

    await h.manager.addProducer("room1", { producerId: "p9", peerId: "carol" });
    // feed exists immediately; mixer rebuild is deferred to the debounce timer
    assert.equal(h.manager.getStream("room1")!.feeds.size, 1);
    assert.equal(mixers(h).length, 1);

    await runTimers(h);
    // rebuilt: a new mixer that now includes carol's SDP, old one killed
    assert.equal(mixers(h).length, 2);
    assert.equal(sdpInputs(lastMixer(h)).length, 1);
    assert.equal(mixers(h)[0].killed, true);
    assert.equal(mixers(h)[0].lastSignal, "SIGKILL");
  });

  it("coalesces a burst of additions into one rebuild", async () => {
    await h.manager.start("room1", h.router, [], CONFIG);
    await h.manager.addProducer("room1", { producerId: "p1", peerId: "a" });
    await h.manager.addProducer("room1", { producerId: "p2", peerId: "b" });
    await h.manager.addProducer("room1", { producerId: "p3", peerId: "c" });
    await runTimers(h);
    // one extra mixer spawn for the whole burst, with all three inputs
    assert.equal(mixers(h).length, 2);
    assert.equal(sdpInputs(lastMixer(h)).length, 3);
  });

  it("does not double-feed the same producer", async () => {
    await h.manager.start("room1", h.router, [], CONFIG);
    await h.manager.addProducer("room1", { producerId: "p9", peerId: "carol" });
    await h.manager.addProducer("room1", { producerId: "p9", peerId: "carol" });
    assert.equal(h.manager.getStream("room1")!.feeds.size, 1);
  });

  it("is a no-op when the room is not being streamed", async () => {
    await h.manager.addProducer("ghost", { producerId: "p1", peerId: "x" });
    assert.equal(h.spawned.length, 0);
    assert.equal(h.manager.isStreaming("ghost"), false);
  });

  it("removes a feed, releases its port, and rebuilds without it", async () => {
    await h.manager.start("room1", h.router, PRODUCERS, CONFIG);
    assert.equal(h.ports.size, 2);

    await h.manager.removeProducer("room1", "p1");
    assert.equal(h.ports.size, 1);
    assert.equal(h.manager.getStream("room1")!.feeds.size, 1);

    await runTimers(h);
    assert.equal(sdpInputs(lastMixer(h)).length, 1);
    assert.ok(!sdpInputs(lastMixer(h)).some((s) => s.includes("alice__p1")));
  });
});

describe("StreamManager.setProducerActive", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it("drops a muted (paused) producer from the mix, then folds it back on unmute", async () => {
    await h.manager.start("room1", h.router, PRODUCERS, CONFIG);

    // mute p1 -> excluded from the next mixer, but the feed/port stays
    h.manager.setProducerActive("room1", "p1", false);
    await runTimers(h);
    assert.equal(h.ports.size, 2); // feed kept allocated
    assert.equal(sdpInputs(lastMixer(h)).length, 1);
    assert.ok(sdpInputs(lastMixer(h)).some((s) => s.includes("bob__p2")));

    // unmute p1 -> back in the mix
    h.manager.setProducerActive("room1", "p1", true);
    await runTimers(h);
    assert.equal(sdpInputs(lastMixer(h)).length, 2);
  });

  it("ignores a no-op activity change (no rebuild scheduled)", async () => {
    await h.manager.start("room1", h.router, PRODUCERS, CONFIG);
    h.manager.setProducerActive("room1", "p1", true); // already active
    assert.equal(h.timers.length, 0);
  });
});

describe("StreamManager.stop / stopAll", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it("kills the mixer, closes feeds, releases ports and removes the dir", async () => {
    const stream = await h.manager.start("room1", h.router, PRODUCERS, CONFIG);
    await h.manager.stop("room1");

    assert.equal(h.manager.isStreaming("room1"), false);
    assert.ok(lastMixer(h).killed);
    assert.equal(h.ports.size, 0);
    assert.deepEqual(h.rmCalls, [stream.dir]);
    assert.ok(h.router.transports.every((t) => t.closed && t.consumer?.closed));
  });

  it("is a no-op for an unknown room", async () => {
    await h.manager.stop("nope");
    assert.equal(h.rmCalls.length, 0);
  });

  it("stopAll tears down every room", async () => {
    await h.manager.start("room1", h.router, PRODUCERS, CONFIG);
    await h.manager.start("room2", h.router, [{ producerId: "p3", peerId: "dave" }], CONFIG);
    await h.manager.stopAll();
    assert.equal(h.manager.isStreaming("room1"), false);
    assert.equal(h.manager.isStreaming("room2"), false);
    assert.equal(h.ports.size, 0);
  });
});

describe("StreamManager startup failure", () => {
  it("rejects start() with the classified reason when the mixer dies immediately", async () => {
    const h = makeHarness({ failMixerWith: "Server returned 401 Unauthorized" });
    const stopped: string[] = [];
    h.manager.onStop = (room) => stopped.push(room);

    await assert.rejects(
      h.manager.start("room1", h.router, PRODUCERS, CONFIG),
      /authentication failed/i,
    );

    // Fully torn down, and the room is NOT told streaming-failed — it was never
    // told streaming-started; the starter gets the reason via the rejection.
    assert.equal(h.manager.isStreaming("room1"), false);
    assert.equal(h.ports.size, 0);
    assert.deepEqual(stopped, []);
    assert.deepEqual(h.rmCalls.length, 1); // working dir cleaned up
  });
});

describe("StreamManager mixer crash", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it("tears down the stream and notifies onStop when the mixer exits on its own", async () => {
    const stopped: Array<{ room: string; reason: string }> = [];
    h.manager.onStop = (room, reason) => stopped.push({ room, reason });

    await h.manager.start("room1", h.router, PRODUCERS, CONFIG);
    // simulate ffmpeg dying (e.g. bad Icecast credentials)
    lastMixer(h).emit("exit", 1, null);
    await flush();

    assert.equal(h.manager.isStreaming("room1"), false);
    assert.deepEqual(stopped, [{ room: "room1", reason: "error" }]);
    assert.equal(h.ports.size, 0);
  });

  it("ignores the exit of a mixer that was replaced during a rebuild", async () => {
    const stopped: string[] = [];
    h.manager.onStop = (room) => stopped.push(room);

    await h.manager.start("room1", h.router, [], CONFIG);
    const firstMixer = lastMixer(h);
    await h.manager.addProducer("room1", { producerId: "p1", peerId: "a" });
    await runTimers(h); // rebuild -> firstMixer killed, new mixer is current

    // the old (killed) mixer firing its exit must NOT tear down the stream
    firstMixer.emit("exit", null, "SIGKILL");
    await flush();
    assert.equal(h.manager.isStreaming("room1"), true);
    assert.deepEqual(stopped, []);
  });
});
