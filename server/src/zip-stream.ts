import { Readable } from "node:stream";

// --- Streaming ZIP writer --------------------------------------------------
// A tiny, dependency-free ZIP archiver that streams to a Readable, so the HTTP
// "download every track on its own" endpoint can pack N captured Ogg files
// into one .zip without a temp file and without adding an npm dependency
// (adding deps can purge node_modules / the prebuilt mediasoup-worker).
//
// Entries are stored uncompressed (method 0 / STORE) — the captures are already
// Opus, so deflating them would only burn CPU for ~no size win. Because we
// stream the data before we know each file's size/CRC, we use ZIP data
// descriptors (general-purpose bit 3): the local header carries zeroed
// crc/sizes and the real values follow the data. The central directory at the
// end carries the real values too, which is what extractors actually read.
//
// No ZIP64: offsets/sizes are 32-bit, fine for recordings (Opus voice is
// ~8 KB/s; even long stereo music casts stay well under 4 GB per track).

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

// Incremental CRC-32. Pass the running value (start with 0) and a chunk; the
// returned value is the CRC of everything fed so far.
export function crc32(running: number, buf: Buffer): number {
  let c = (running ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buf.length; i++) {
    c = (CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  // File name inside the archive. Caller is responsible for uniqueness.
  name: string;
  // Lazily opened so we don't hold a file handle per entry up front; called
  // exactly once, in order, when this entry's turn to stream comes.
  open: () => NodeJS.ReadableStream;
}

// 1980-01-01 00:00 in DOS date/time (year-1980<<9 | month<<5 | day). Fixed so
// the archive is deterministic and we never need a clock.
const DOS_DATE = 0x21; // (0<<9) | (1<<5) | 1
const DOS_TIME = 0;
// bit 3: sizes/CRC in a trailing data descriptor; bit 11: UTF-8 file names.
const FLAGS = 0x0808;

async function* zipChunks(entries: ZipEntry[]): AsyncGenerator<Buffer> {
  const central: Array<{ nameBuf: Buffer; crc: number; size: number; offset: number }> = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed to extract (2.0)
    local.writeUInt16LE(FLAGS, 6);
    local.writeUInt16LE(0, 8); // compression method: store
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    // crc32 (14), compressed size (18), uncompressed size (22): deferred -> 0
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    const localOffset = offset;
    yield local;
    offset += local.length;
    yield nameBuf;
    offset += nameBuf.length;

    let crc = 0;
    let size = 0;
    for await (const chunk of entry.open() as AsyncIterable<Buffer | string>) {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      crc = crc32(crc, buf);
      size += buf.length;
      yield buf;
      offset += buf.length;
    }

    const dd = Buffer.alloc(16);
    dd.writeUInt32LE(0x08074b50, 0); // data descriptor signature
    dd.writeUInt32LE(crc >>> 0, 4);
    dd.writeUInt32LE(size, 8); // compressed size (== uncompressed for STORE)
    dd.writeUInt32LE(size, 12); // uncompressed size
    yield dd;
    offset += dd.length;

    central.push({ nameBuf, crc, size, offset: localOffset });
  }

  const cdStart = offset;
  let cdSize = 0;
  for (const e of central) {
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0); // central directory header signature
    h.writeUInt16LE(20, 4); // version made by
    h.writeUInt16LE(20, 6); // version needed
    h.writeUInt16LE(FLAGS, 8);
    h.writeUInt16LE(0, 10); // method: store
    h.writeUInt16LE(DOS_TIME, 12);
    h.writeUInt16LE(DOS_DATE, 14);
    h.writeUInt32LE(e.crc >>> 0, 16);
    h.writeUInt32LE(e.size, 20); // compressed size
    h.writeUInt32LE(e.size, 24); // uncompressed size
    h.writeUInt16LE(e.nameBuf.length, 28);
    h.writeUInt16LE(0, 30); // extra length
    h.writeUInt16LE(0, 32); // comment length
    h.writeUInt16LE(0, 34); // disk number start
    h.writeUInt16LE(0, 36); // internal attributes
    h.writeUInt32LE(0, 38); // external attributes
    h.writeUInt32LE(e.offset, 42); // relative offset of local header
    yield h;
    yield e.nameBuf;
    cdSize += h.length + e.nameBuf.length;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  eocd.writeUInt16LE(0, 4); // number of this disk
  eocd.writeUInt16LE(0, 6); // disk with central directory
  eocd.writeUInt16LE(central.length, 8); // entries on this disk
  eocd.writeUInt16LE(central.length, 10); // total entries
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20); // comment length
  yield eocd;
}

// Build a Readable that emits a valid .zip of the given entries. The returned
// stream emits "error" if an entry's source stream fails mid-archive.
export function createZipStream(entries: ZipEntry[]): Readable {
  return Readable.from(zipChunks(entries));
}
