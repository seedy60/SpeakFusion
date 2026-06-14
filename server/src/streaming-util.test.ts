import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildIcecastUrl,
  buildStreamArgs,
  classifyStreamError,
  contentTypeFor,
  type IcecastConfig,
} from "./streaming-util.js";

const BASE: IcecastConfig = {
  host: "stream.example.com",
  port: 8000,
  mount: "/sonicroom",
  username: "source",
  password: "hackme",
  format: "mp3",
  bitrateKbps: 128,
};

describe("buildIcecastUrl", () => {
  it("builds icecast://user:pass@host:port/mount", () => {
    assert.equal(
      buildIcecastUrl(BASE),
      "icecast://source:hackme@stream.example.com:8000/sonicroom",
    );
  });

  it("normalizes a mount without a leading slash", () => {
    assert.equal(buildIcecastUrl({ ...BASE, mount: "live" }).endsWith(":8000/live"), true);
  });

  it("percent-encodes credentials with reserved characters", () => {
    const url = buildIcecastUrl({ ...BASE, username: "a@b", password: "p:@/ss" });
    assert.equal(url, "icecast://a%40b:p%3A%40%2Fss@stream.example.com:8000/sonicroom");
  });
});

describe("contentTypeFor", () => {
  it("maps formats to Icecast content types", () => {
    assert.equal(contentTypeFor("mp3"), "audio/mpeg");
    assert.equal(contentTypeFor("opus"), "application/ogg");
  });
});

describe("buildStreamArgs", () => {
  it("bounds the Icecast connection with an rw_timeout just before the URL", () => {
    const args = buildStreamArgs([], BASE);
    const i = args.indexOf("-rw_timeout");
    assert.ok(i >= 0, "has -rw_timeout");
    assert.ok(Number(args[i + 1]) > 0, "timeout is a positive microsecond value");
    // It must sit immediately before the output URL (it's a protocol option).
    assert.equal(args[i + 2], buildIcecastUrl(BASE));
  });

  it("always includes a silent stereo anchor and ends at the icecast URL", () => {
    const args = buildStreamArgs([], BASE);
    assert.ok(args.includes("anullsrc=channel_layout=stereo:sample_rate=48000"));
    assert.equal(args.at(-1), buildIcecastUrl(BASE));
    // anchor-only: no amix, the anchor is mapped straight through
    const filter = args[args.indexOf("-filter_complex") + 1];
    assert.ok(!filter.includes("amix"));
    assert.ok(args.includes("-map"));
    assert.equal(args[args.indexOf("-map") + 1], "[a0]");
  });

  it("amixes the anchor plus one input per producer SDP, normalize=0", () => {
    const args = buildStreamArgs(["/tmp/s/a.sdp", "/tmp/s/b.sdp"], BASE);
    // each SDP is an -i input, plus the anchor input
    const inputs = args.filter((_, i) => args[i - 1] === "-i");
    assert.deepEqual(inputs, [
      "anullsrc=channel_layout=stereo:sample_rate=48000",
      "/tmp/s/a.sdp",
      "/tmp/s/b.sdp",
    ]);
    const filter = args[args.indexOf("-filter_complex") + 1];
    assert.ok(filter.includes("amix=inputs=3:normalize=0"));
    assert.equal(args[args.indexOf("-map") + 1], "[out]");
    // SDP inputs are protocol-whitelisted for file/udp/rtp
    assert.ok(args.includes("-protocol_whitelist"));
    assert.ok(args.some((a) => a === "file,udp,rtp"));
  });

  it("encodes mp3 with libmp3lame and the right content type", () => {
    const args = buildStreamArgs(["/tmp/s/a.sdp"], { ...BASE, format: "mp3", bitrateKbps: 192 });
    assert.equal(args[args.indexOf("-c:a") + 1], "libmp3lame");
    assert.equal(args[args.indexOf("-b:a") + 1], "192k");
    assert.equal(args[args.indexOf("-f") + 1] === "lavfi", true); // first -f is the anchor format
    assert.ok(args.includes("mp3"));
    assert.equal(args[args.indexOf("-content_type") + 1], "audio/mpeg");
  });

  it("encodes opus with libopus into ogg with the right content type", () => {
    const args = buildStreamArgs(["/tmp/s/a.sdp"], { ...BASE, format: "opus", bitrateKbps: 96 });
    assert.equal(args[args.indexOf("-c:a") + 1], "libopus");
    assert.equal(args[args.indexOf("-b:a") + 1], "96k");
    assert.ok(args.includes("ogg"));
    assert.equal(args[args.indexOf("-content_type") + 1], "application/ogg");
  });

  it("advertises a stream name (custom or default)", () => {
    assert.equal(
      buildStreamArgs([], BASE)[buildStreamArgs([], BASE).indexOf("-ice_name") + 1],
      "SonicRoom",
    );
    const named = buildStreamArgs([], { ...BASE, name: "My Room" });
    assert.equal(named[named.indexOf("-ice_name") + 1], "My Room");
  });
});

describe("classifyStreamError", () => {
  const target = `${BASE.host}:${BASE.port}`;

  // Real ffmpeg/Icecast stderr lines (lowercased substrings are what we match).
  const cases: Array<[string, RegExp]> = [
    ["[tcp @ 0x55a] Connection to tcp://h:8000 failed: Connection refused", /refused by/i],
    ["Failed to resolve hostname stream.example.com: Name or service not known", /resolve host/i],
    ["[tcp @ 0x55a] Connection to tcp://10.0.0.1:8000 failed: Connection timed out", /timed out/i],
    ["Server returned 401 Unauthorized", /authentication failed/i],
    ["Server returned 403 Forbidden", /mount point/i],
    ["icecast: Mountpoint in use", /mount point/i],
    ["Network is unreachable", /unreachable/i],
  ];

  for (const [stderr, expected] of cases) {
    it(`maps "${stderr.slice(0, 32)}…" to an actionable message`, () => {
      const msg = classifyStreamError(stderr, BASE, 1, null);
      assert.match(msg, expected);
      assert.ok(msg.includes(BASE.host) || msg.includes(target));
    });
  }

  it("does NOT false-match digits inside ffmpeg hex pointers", () => {
    // "0x...401..." / "0x...403..." must not look like an HTTP auth/forbidden.
    const msg = classifyStreamError("[tcp @ 0x7f4013] some other failure", BASE, 1, null);
    assert.doesNotMatch(msg, /authentication/i);
    assert.doesNotMatch(msg, /mount point/i);
  });

  it("falls back to ffmpeg's last meaningful line for unknown failures", () => {
    const msg = classifyStreamError("warming up\n\nSomething weird happened", BASE, 1, null);
    assert.match(msg, /Something weird happened/);
  });

  it("describes how the process died when there is no stderr", () => {
    assert.match(classifyStreamError("", BASE, null, "SIGKILL"), /killed by SIGKILL/);
    assert.match(classifyStreamError("", BASE, 1, null), /exited with code 1/);
  });
});
