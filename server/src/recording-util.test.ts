import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RtpParameters } from "mediasoup/types";
import {
  PortAllocator,
  buildSdp,
  sdpParamsFromRtp,
  buildCaptureArgs,
  buildMixArgs,
  decideMode,
  computeDelayMs,
} from "./recording-util.js";

describe("PortAllocator", () => {
  it("hands out distinct ports within the range", () => {
    const a = new PortAllocator(50000, 50004, 2);
    const p1 = a.allocate();
    const p2 = a.allocate();
    const p3 = a.allocate();
    assert.equal(new Set([p1, p2, p3]).size, 3);
    for (const p of [p1, p2, p3]) {
      assert.ok(p >= 50000 && p <= 50004);
    }
    assert.equal(a.size, 3);
  });

  it("spaces ports by the step so RTP/RTCP pairs never collide", () => {
    // ffmpeg opens RTCP at port+1, so consecutive recorders must be >=2 apart.
    const a = new PortAllocator(50000, 50998, 2);
    const ports = [a.allocate(), a.allocate(), a.allocate()].sort((x, y) => x - y);
    assert.deepEqual(ports, [50000, 50002, 50004]);
    for (const p of ports) assert.equal(p % 2, 0);
  });

  it("reuses a released port and never double-allocates", () => {
    const a = new PortAllocator(50000, 50002, 2);
    const p1 = a.allocate();
    const p2 = a.allocate();
    a.release(p1);
    const p3 = a.allocate();
    assert.equal(p3, p1);
    assert.notEqual(p3, p2);
    assert.equal(a.size, 2);
  });

  it("throws when exhausted", () => {
    const a = new PortAllocator(50000, 50000, 2);
    a.allocate();
    assert.throws(() => a.allocate(), /no free ports/);
  });

  it("rejects an invalid range", () => {
    assert.throws(() => new PortAllocator(50001, 50000));
  });
});

describe("buildSdp", () => {
  it("produces a valid recvonly SDP with fmtp and ssrc", () => {
    const sdp = buildSdp({
      port: 50000,
      payloadType: 100,
      codec: "opus",
      clockRate: 48000,
      channels: 2,
      ssrc: 12345,
      fmtp: { minptime: 10, useinbandfec: 1 },
    });
    assert.ok(sdp.includes("m=audio 50000 RTP/AVP 100"));
    assert.ok(sdp.includes("a=rtpmap:100 opus/48000/2"));
    assert.ok(sdp.includes("a=fmtp:100 minptime=10;useinbandfec=1"));
    assert.ok(sdp.includes("a=ssrc:12345 cname:sonicroom"));
    assert.ok(sdp.includes("a=recvonly"));
    assert.ok(sdp.includes("c=IN IP4 127.0.0.1"));
    assert.ok(sdp.endsWith("\n"));
  });

  it("omits fmtp/ssrc lines when not provided", () => {
    const sdp = buildSdp({
      port: 50001,
      payloadType: 111,
      codec: "opus",
      clockRate: 48000,
      channels: 1,
    });
    assert.ok(!sdp.includes("a=fmtp"));
    assert.ok(!sdp.includes("a=ssrc"));
    assert.ok(sdp.includes("a=rtpmap:111 opus/48000/1"));
  });
});

describe("sdpParamsFromRtp", () => {
  it("derives codec/payload/ssrc from rtpParameters", () => {
    const rtp = {
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
      encodings: [{ ssrc: 999 }],
      headerExtensions: [],
      rtcp: {},
    } as unknown as RtpParameters;
    const p = sdpParamsFromRtp(rtp, 50005);
    assert.equal(p.port, 50005);
    assert.equal(p.payloadType, 100);
    assert.equal(p.codec, "opus");
    assert.equal(p.clockRate, 48000);
    assert.equal(p.channels, 2);
    assert.equal(p.ssrc, 999);
    assert.deepEqual(p.fmtp, { minptime: 10 });
  });

  it("throws when there is no codec", () => {
    const rtp = { codecs: [], encodings: [] } as unknown as RtpParameters;
    assert.throws(() => sdpParamsFromRtp(rtp, 50000));
  });
});

describe("buildCaptureArgs", () => {
  it("captures RTP from an SDP file to a copied Ogg with frequent flushing", () => {
    const args = buildCaptureArgs("/tmp/in.sdp", "/tmp/out.ogg");
    assert.ok(args.includes("-protocol_whitelist"));
    assert.equal(args[args.indexOf("-protocol_whitelist") + 1], "file,udp,rtp");
    assert.deepEqual(args.slice(args.indexOf("-i")), [
      "-i",
      "/tmp/in.sdp",
      "-c:a",
      "copy",
      "-flush_packets",
      "1",
      "-y",
      "/tmp/out.ogg",
    ]);
  });
});

describe("buildMixArgs", () => {
  it("copies a single zero-offset input straight to stdout", () => {
    const args = buildMixArgs([{ path: "/tmp/a.ogg", delayMs: 0 }]);
    assert.deepEqual(args, [
      "-hide_banner",
      "-loglevel",
      "warning",
      "-i",
      "/tmp/a.ogg",
      "-c:a",
      "copy",
      "-f",
      "ogg",
      "pipe:1",
    ]);
  });

  it("mixes multiple inputs with per-input delay and no volume normalization", () => {
    const args = buildMixArgs([
      { path: "/tmp/a.ogg", delayMs: 0 },
      { path: "/tmp/b.ogg", delayMs: 1500 },
    ]);
    const fc = args[args.indexOf("-filter_complex") + 1];
    assert.ok(fc.includes("[0:a]anull[a0]"));
    assert.ok(fc.includes("[1:a]adelay=1500:all=1[a1]"));
    assert.ok(fc.includes("amix=inputs=2:normalize=0[out]"));
    assert.deepEqual(args.slice(-2), ["ogg", "pipe:1"]);
    assert.ok(args.includes("libopus"));
  });

  it("re-encodes a single delayed input (cannot copy with a filter)", () => {
    const args = buildMixArgs([{ path: "/tmp/a.ogg", delayMs: 800 }]);
    assert.ok(args.includes("-filter_complex"));
    assert.ok(args.includes("libopus"));
  });

  it("throws when there are no inputs", () => {
    assert.throws(() => buildMixArgs([]));
  });
});

describe("decideMode", () => {
  it("requires SFU for 3+ peers", () => {
    assert.deepEqual(decideMode(3, "p2p", false), { mode: "sfu", action: "switch-to-sfu" });
    assert.deepEqual(decideMode(5, "sfu", false), { mode: "sfu", action: "none" });
  });

  it("uses P2P for <=2 peers when not recording", () => {
    assert.deepEqual(decideMode(2, "sfu", false), { mode: "p2p", action: "switch-to-p2p" });
    assert.deepEqual(decideMode(1, "p2p", false), { mode: "p2p", action: "none" });
  });

  it("forces SFU while recording even with <=2 peers", () => {
    assert.deepEqual(decideMode(2, "p2p", true), { mode: "sfu", action: "switch-to-sfu" });
    assert.deepEqual(decideMode(1, "sfu", true), { mode: "sfu", action: "none" });
  });

  it("never downgrades to P2P while recording", () => {
    const d = decideMode(2, "sfu", true);
    assert.equal(d.action, "none");
    assert.equal(d.mode, "sfu");
  });
});

describe("computeDelayMs", () => {
  it("returns the offset of a recorder from the recording start", () => {
    assert.equal(computeDelayMs(1000, 1000), 0);
    assert.equal(computeDelayMs(1000, 4500), 3500);
  });

  it("clamps negative offsets to zero", () => {
    assert.equal(computeDelayMs(5000, 4000), 0);
  });
});
