import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createZipStream, crc32, type ZipEntry } from "./zip-stream.js";

function collect(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer | string) =>
      chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)),
    );
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

interface CentralEntry {
  name: string;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

// Parse the central directory (the authoritative index extractors read), so the
// tests verify what a real unzip tool would see.
function parseCentralDirectory(zip: Buffer): CentralEntry[] {
  // End of central directory: last 22 bytes (we never write an archive comment).
  const eocd = zip.length - 22;
  assert.equal(zip.readUInt32LE(eocd), 0x06054b50, "EOCD signature");
  const total = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16); // central directory offset

  const entries: CentralEntry[] = [];
  for (let i = 0; i < total; i++) {
    assert.equal(zip.readUInt32LE(p), 0x02014b50, "central header signature");
    const crc = zip.readUInt32LE(p + 16);
    const compressedSize = zip.readUInt32LE(p + 20);
    const uncompressedSize = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const localOffset = zip.readUInt32LE(p + 42);
    const name = zip.toString("utf8", p + 46, p + 46 + nameLen);
    entries.push({ name, crc, compressedSize, uncompressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

const entry = (name: string, data: Buffer): ZipEntry => ({
  name,
  open: () => Readable.from([data]),
});

describe("crc32", () => {
  it("matches known CRC-32 values", () => {
    assert.equal(crc32(0, Buffer.from("")), 0);
    // CRC-32 of "123456789" is the canonical 0xCBF43926 check value.
    assert.equal(crc32(0, Buffer.from("123456789")), 0xcbf43926);
  });

  it("is incremental — chunking does not change the result", () => {
    const whole = crc32(0, Buffer.from("hello world"));
    let part = crc32(0, Buffer.from("hello "));
    part = crc32(part, Buffer.from("world"));
    assert.equal(part, whole);
  });
});

describe("createZipStream", () => {
  it("produces a STORE-method zip with one entry per file", async () => {
    const a = Buffer.from("alice audio bytes");
    const b = Buffer.from([0, 1, 2, 3, 255, 254, 200, 7]);
    const zip = await collect(createZipStream([entry("01-alice.ogg", a), entry("02-bob.ogg", b)]));

    // first bytes are a local file header
    assert.equal(zip.readUInt32LE(0), 0x04034b50, "local file header signature");

    const central = parseCentralDirectory(zip);
    assert.deepEqual(
      central.map((e) => e.name),
      ["01-alice.ogg", "02-bob.ogg"],
    );

    // stored uncompressed: sizes equal the originals and CRCs match
    assert.equal(central[0].uncompressedSize, a.length);
    assert.equal(central[0].compressedSize, a.length);
    assert.equal(central[0].crc >>> 0, crc32(0, a));
    assert.equal(central[1].uncompressedSize, b.length);
    assert.equal(central[1].crc >>> 0, crc32(0, b));

    // each local header is a STORE entry pointing where the central dir says
    for (const e of central) {
      assert.equal(zip.readUInt32LE(e.localOffset), 0x04034b50);
      assert.equal(zip.readUInt16LE(e.localOffset + 8), 0, "compression method: store");
    }
  });

  it("streams the raw file bytes verbatim (no re-encode)", async () => {
    const data = Buffer.from("the exact opus payload");
    const zip = await collect(createZipStream([entry("track.ogg", data)]));
    const [e] = parseCentralDirectory(zip);

    // local header: 30 bytes + filename, then the stored data
    const nameLen = zip.readUInt16LE(e.localOffset + 26);
    const dataStart = e.localOffset + 30 + nameLen;
    assert.deepEqual(zip.subarray(dataStart, dataStart + data.length), data);
  });

  it("handles many entries and an empty file", async () => {
    const entries = [
      entry("01-a.ogg", Buffer.from("aaa")),
      entry("02-empty.ogg", Buffer.alloc(0)),
      entry("03-c.ogg", Buffer.from("cccc")),
    ];
    const central = parseCentralDirectory(await collect(createZipStream(entries)));
    assert.equal(central.length, 3);
    assert.equal(central[1].uncompressedSize, 0);
    assert.equal(central[1].crc, 0); // CRC of nothing is 0
  });

  it("emits an error if a source stream fails mid-archive", async () => {
    const boom: ZipEntry = {
      name: "bad.ogg",
      open: () =>
        new Readable({
          read() {
            this.destroy(new Error("disk gone"));
          },
        }),
    };
    await assert.rejects(collect(createZipStream([boom])), /disk gone/);
  });
});
