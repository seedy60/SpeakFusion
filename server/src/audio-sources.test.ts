import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildAudioTranscodeArgs,
  buildFfmpegStreamArgs,
  buildYtDlpArgs,
  isAudioContentType,
  isAudioFileName,
  isPrivateAddress,
  looksLikeDirectStream,
  looksLikeStreamContentType,
} from "./audio-sources.js";

const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe("isAudioFileName", () => {
  it("allows supported root-level audio files", () => {
    assert.equal(isAudioFileName("show.mp3"), true);
    assert.equal(isAudioFileName("MIX.OPUS"), true);
  });

  it("rejects paths, hidden files and unrelated extensions", () => {
    assert.equal(isAudioFileName("../show.mp3"), false);
    assert.equal(isAudioFileName(".secret.mp3"), false);
    assert.equal(isAudioFileName("notes.txt"), false);
  });
});

describe("isPrivateAddress", () => {
  it("blocks local and private addresses", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "192.168.1.2", "::1", "fd00::1", "fe80::1"]) {
      assert.equal(isPrivateAddress(address), true, address);
    }
  });

  it("allows public addresses", () => {
    assert.equal(isPrivateAddress("1.1.1.1"), false);
    assert.equal(isPrivateAddress("2606:4700:4700::1111"), false);
  });
});

describe("isAudioContentType", () => {
  it("allows audio responses and rejects general proxy content", () => {
    assert.equal(isAudioContentType("audio/mpeg"), true);
    assert.equal(isAudioContentType("application/ogg; charset=binary"), true);
    assert.equal(isAudioContentType("application/octet-stream"), false);
    assert.equal(isAudioContentType("text/html"), false);
  });
});

describe("buildYtDlpArgs", () => {
  it("extracts best audio to stdout without a cache or playlist", () => {
    const args = buildYtDlpArgs("https://www.youtube.com/watch?v=abc");
    assert.equal(after(args, "-f"), "bestaudio/best");
    assert.equal(after(args, "-o"), "-");
    assert.ok(args.includes("--no-playlist"));
    assert.ok(args.includes("--no-cache-dir"));
  });

  it("passes the URL after `--` so a hostile '-…' URL is never read as a flag", () => {
    const args = buildYtDlpArgs("-malicious");
    assert.equal(args.at(-2), "--");
    assert.equal(args.at(-1), "-malicious");
  });
});

describe("buildAudioTranscodeArgs", () => {
  it("drops video and emits a progressive Opus/WebM stream to stdout", () => {
    const args = buildAudioTranscodeArgs();
    assert.ok(args.includes("-vn"));
    assert.equal(after(args, "-c:a"), "libopus");
    assert.equal(after(args, "-f"), "webm");
    assert.equal(args.at(-1), "pipe:1");
  });
});

describe("looksLikeDirectStream", () => {
  it("matches IPTV / HLS / DASH / raw media URLs (ignoring query + port)", () => {
    for (const url of [
      "http://stream.example.com:8080/u/p/2902375.ts",
      "https://cdn.example.com/live/stream.m3u8?token=abc",
      "https://example.com/manifest.mpd",
      "https://example.com/song.mp3",
    ]) {
      assert.equal(looksLikeDirectStream(url), true, url);
    }
  });

  it("does not match site pages (which need yt-dlp extraction)", () => {
    for (const url of [
      "https://www.youtube.com/watch?v=abc",
      "https://youtu.be/abc",
      "https://soundcloud.com/artist/track",
      "not a url",
    ]) {
      assert.equal(looksLikeDirectStream(url), false, url);
    }
  });
});

describe("looksLikeStreamContentType", () => {
  it("matches media-stream types so extension-less IPTV URLs go to ffmpeg", () => {
    for (const ct of [
      "video/mp2t",
      "application/octet-stream",
      "application/vnd.apple.mpegurl",
      "application/dash+xml; charset=utf-8",
    ]) {
      assert.equal(looksLikeStreamContentType(ct), true, ct);
    }
  });

  it("does not match web pages or plain audio", () => {
    assert.equal(looksLikeStreamContentType("text/html"), false);
    assert.equal(looksLikeStreamContentType("application/json"), false);
    // audio/* is served by the direct proxy, not treated as a transcode stream.
    assert.equal(looksLikeStreamContentType("audio/mpeg"), false);
  });
});

describe("buildFfmpegStreamArgs", () => {
  it("opens the URL with a restricted protocol set and emits Opus/WebM", () => {
    const args = buildFfmpegStreamArgs("http://host/live/123.ts");
    // No `file:` etc. — a hostile playlist can't make ffmpeg read local disk.
    assert.equal(after(args, "-protocol_whitelist"), "http,https,tcp,tls,crypto");
    assert.equal(after(args, "-i"), "http://host/live/123.ts");
    assert.ok(args.includes("-vn"));
    assert.equal(after(args, "-c:a"), "libopus");
    assert.equal(args.at(-1), "pipe:1");
  });
});
