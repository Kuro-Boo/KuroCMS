// KuroCMS admin ZIP utility. Concatenated by scripts/build-admin.js (no imports/
// exports — declarations are global within the combined admin bundle).
//
// A minimal, dependency-free ZIP implementation used by the Backup / Restore
// screen. Goals:
//   * STORE (no compression): media is already compressed; JSON overhead is
//     acceptable, and STORE keeps Worker/browser CPU near zero.
//   * Streaming WRITE via data descriptors — entries are written header → data →
//     descriptor with no seek-back, so the browser can pipe each entry straight
//     to disk (showSaveFilePicker) without buffering whole files in memory.
//   * Random-access READ via the central directory — restore reads from a
//     seekable File (showOpenFilePicker), so we never stream-parse; we slice each
//     entry's byte range on demand.
//   * ZIP64 is emitted per-entry when a size ≥ 4 GiB and for the archive when the
//     directory offset/size or entry count overflows 32-bit fields.

const ZIP_U32_MAX = 0xffffffff;
const ZIP_U16_MAX = 0xffff;

// ── CRC-32 (IEEE) ────────────────────────────────────────────────────────────
const ZIP_CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function zipCrc32Update(crc: number, data: Uint8Array): number {
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++) {
    c = (ZIP_CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ── little-endian byte buffer builder ────────────────────────────────────────
class ZipByteBuilder {
  private parts: number[] = [];
  u16(v: number): ZipByteBuilder {
    this.parts.push(v & 0xff, (v >>> 8) & 0xff);
    return this;
  }
  u32(v: number): ZipByteBuilder {
    this.parts.push(
      v & 0xff,
      (v >>> 8) & 0xff,
      (v >>> 16) & 0xff,
      (v >>> 24) & 0xff,
    );
    return this;
  }
  // 64-bit little-endian via Number (safe up to 2^53, far beyond realistic sizes).
  u64(v: number): ZipByteBuilder {
    const lo = v >>> 0;
    const hi = Math.floor(v / 0x100000000) >>> 0;
    this.u32(lo);
    this.u32(hi);
    return this;
  }
  bytes(b: Uint8Array): ZipByteBuilder {
    for (let i = 0; i < b.length; i++) this.parts.push(b[i]);
    return this;
  }
  build(): Uint8Array {
    return new Uint8Array(this.parts);
  }
}

interface ZipWriterEntry {
  nameBytes: Uint8Array;
  crc: number;
  size: number; // store: compressed == uncompressed
  offset: number; // local header offset
  zip64: boolean;
}

type ZipSink = (chunk: Uint8Array) => Promise<void> | void;

// Streaming ZIP writer. `sink` receives byte chunks in order; for Chromium pass
// `(c) => writable.write(c)` so chunks land on disk immediately.
class ZipWriter {
  private sink: ZipSink;
  private offset = 0;
  private entries: ZipWriterEntry[] = [];
  private enc = new TextEncoder();

  constructor(sink: ZipSink) {
    this.sink = sink;
  }

  private async put(bytes: Uint8Array): Promise<void> {
    await this.sink(bytes);
    this.offset += bytes.length;
  }

  // Add one file. `data` may be a whole Uint8Array (small, e.g. JSON) or a
  // ReadableStream (large media). `sizeHint` selects ZIP64 up front when known.
  async add(
    name: string,
    data: Uint8Array | ReadableStream<Uint8Array>,
    sizeHint?: number,
  ): Promise<void> {
    const nameBytes = this.enc.encode(name);
    const hint = data instanceof Uint8Array ? data.length : (sizeHint ?? 0);
    const zip64 = hint >= ZIP_U32_MAX;
    const offset = this.offset;

    await this.put(this.localHeader(nameBytes, zip64));

    let crc = 0;
    let size = 0;
    if (data instanceof Uint8Array) {
      crc = zipCrc32Update(0, data);
      size = data.length;
      await this.put(data);
    } else {
      const reader = data.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = value as Uint8Array;
        if (!chunk || chunk.length === 0) continue;
        crc = zipCrc32Update(crc, chunk);
        size += chunk.length;
        await this.put(chunk);
      }
    }

    await this.put(this.dataDescriptor(crc, size, zip64));
    this.entries.push({ nameBytes, crc, size, offset, zip64 });
  }

  // Local file header (general-purpose bit 3 set → crc/sizes follow the data).
  private localHeader(nameBytes: Uint8Array, zip64: boolean): Uint8Array {
    const extra = zip64
      ? new ZipByteBuilder().u16(0x0001).u16(16).u64(0).u64(0).build()
      : new Uint8Array(0);
    return new ZipByteBuilder()
      .u32(0x04034b50)
      .u16(zip64 ? 45 : 20) // version needed
      .u16(0x0008) // flags: bit 3 (data descriptor)
      .u16(0) // method: store
      .u16(0) // mod time
      .u16(0x0021) // mod date (1980-01-01, valid minimum)
      .u32(0) // crc (in descriptor)
      .u32(zip64 ? ZIP_U32_MAX : 0) // compressed size
      .u32(zip64 ? ZIP_U32_MAX : 0) // uncompressed size
      .u16(nameBytes.length)
      .u16(extra.length)
      .bytes(nameBytes)
      .bytes(extra)
      .build();
  }

  private dataDescriptor(
    crc: number,
    size: number,
    zip64: boolean,
  ): Uint8Array {
    const b = new ZipByteBuilder().u32(0x08074b50).u32(crc);
    if (zip64) b.u64(size).u64(size);
    else b.u32(size).u32(size);
    return b.build();
  }

  // Central directory + (ZIP64) end-of-central-directory records.
  async close(): Promise<void> {
    const cdOffset = this.offset;
    let cdSize = 0;
    for (const e of this.entries) {
      const rec = this.centralHeader(e);
      cdSize += rec.length;
      await this.put(rec);
    }

    const needZip64 =
      this.entries.length > ZIP_U16_MAX ||
      cdOffset >= ZIP_U32_MAX ||
      cdSize >= ZIP_U32_MAX ||
      this.entries.some((e) => e.zip64);

    if (needZip64) {
      const z64eocdOffset = this.offset;
      const count = this.entries.length;
      await this.put(
        new ZipByteBuilder()
          .u32(0x06064b50)
          .u64(44) // size of remaining record
          .u16(45)
          .u16(45)
          .u32(0) // this disk
          .u32(0) // disk with cd start
          .u64(count)
          .u64(count)
          .u64(cdSize)
          .u64(cdOffset)
          .build(),
      );
      await this.put(
        new ZipByteBuilder()
          .u32(0x07064b50)
          .u32(0)
          .u64(z64eocdOffset)
          .u32(1)
          .build(),
      );
    }

    const entriesField = Math.min(this.entries.length, ZIP_U16_MAX);
    await this.put(
      new ZipByteBuilder()
        .u32(0x06054b50)
        .u16(0) // this disk
        .u16(0) // disk with cd
        .u16(entriesField)
        .u16(entriesField)
        .u32(cdSize >= ZIP_U32_MAX ? ZIP_U32_MAX : cdSize)
        .u32(cdOffset >= ZIP_U32_MAX ? ZIP_U32_MAX : cdOffset)
        .u16(0) // comment length
        .build(),
    );
  }

  private centralHeader(e: ZipWriterEntry): Uint8Array {
    const offsetOverflow = e.offset >= ZIP_U32_MAX;
    const useZip64 = e.zip64 || offsetOverflow;
    let extra: Uint8Array = new Uint8Array(0);
    if (useZip64) {
      const eb = new ZipByteBuilder().u16(0x0001);
      // Field order: uncompressed, compressed, local-header offset.
      const fields = new ZipByteBuilder();
      fields.u64(e.size).u64(e.size);
      if (offsetOverflow) fields.u64(e.offset);
      const fb = fields.build();
      extra = eb.u16(fb.length).bytes(fb).build();
    }
    return new ZipByteBuilder()
      .u32(0x02014b50)
      .u16(45) // version made by
      .u16(useZip64 ? 45 : 20) // version needed
      .u16(0x0008) // flags: bit 3
      .u16(0) // method
      .u16(0) // mod time
      .u16(0x0021) // mod date
      .u32(e.crc)
      .u32(e.zip64 ? ZIP_U32_MAX : e.size) // compressed
      .u32(e.zip64 ? ZIP_U32_MAX : e.size) // uncompressed
      .u16(e.nameBytes.length)
      .u16(extra.length)
      .u16(0) // comment length
      .u16(0) // disk number start
      .u16(0) // internal attrs
      .u32(0) // external attrs
      .u32(offsetOverflow ? ZIP_U32_MAX : e.offset)
      .bytes(e.nameBytes)
      .bytes(extra)
      .build();
  }
}

// ── Reader (random access over a seekable Blob/File) ─────────────────────────
interface ZipReadEntry {
  name: string;
  size: number;
  crc: number;
  localOffset: number;
}

class ZipReader {
  private file: Blob;
  private dec = new TextDecoder();
  private list: ZipReadEntry[] | null = null;

  constructor(file: Blob) {
    this.file = file;
  }

  private async slice(start: number, end: number): Promise<Uint8Array> {
    const buf = await this.file.slice(start, end).arrayBuffer();
    return new Uint8Array(buf);
  }

  // Parse the central directory once and cache the entry list.
  async entries(): Promise<ZipReadEntry[]> {
    if (this.list) return this.list;
    const size = this.file.size;
    const tailLen = Math.min(size, 0xffff + 22);
    const tail = await this.slice(size - tailLen, size);
    const tv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);

    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tv.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error("ZIP: end-of-central-directory not found");

    let cdOffset = tv.getUint32(eocd + 16, true);
    let cdCount = tv.getUint16(eocd + 10, true);

    // ZIP64: resolve real offset/count when the classic fields are sentinels.
    if (cdOffset === ZIP_U32_MAX || cdCount === ZIP_U16_MAX) {
      let loc = -1;
      for (let i = eocd - 20; i >= 0; i--) {
        if (tv.getUint32(i, true) === 0x07064b50) {
          loc = i;
          break;
        }
      }
      if (loc >= 0) {
        const z64Offset = Number(tv.getBigUint64(loc + 8, true));
        const z = await this.slice(z64Offset, z64Offset + 56);
        const zv = new DataView(z.buffer, z.byteOffset, z.byteLength);
        cdCount = Number(zv.getBigUint64(24, true));
        cdOffset = Number(zv.getBigUint64(48, true));
      }
    }

    const cd = await this.slice(cdOffset, size);
    const dv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
    const out: ZipReadEntry[] = [];
    let p = 0;
    for (let n = 0; n < cdCount; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const crc = dv.getUint32(p + 16, true) >>> 0;
      let entrySize = dv.getUint32(p + 24, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      let localOffset = dv.getUint32(p + 42, true);
      const name = this.dec.decode(cd.subarray(p + 46, p + 46 + nameLen));

      // Walk the extra fields for the ZIP64 record when sizes/offset are sentinels.
      if (entrySize === ZIP_U32_MAX || localOffset === ZIP_U32_MAX) {
        let ep = p + 46 + nameLen;
        const extraEnd = ep + extraLen;
        while (ep + 4 <= extraEnd) {
          const id = dv.getUint16(ep, true);
          const len = dv.getUint16(ep + 2, true);
          let fp = ep + 4;
          if (id === 0x0001) {
            if (entrySize === ZIP_U32_MAX) {
              entrySize = Number(dv.getBigUint64(fp, true)); // uncompressed
              fp += 8;
              fp += 8; // skip compressed
            }
            if (localOffset === ZIP_U32_MAX) {
              localOffset = Number(dv.getBigUint64(fp, true));
            }
          }
          ep += 4 + len;
        }
      }

      out.push({ name, size: entrySize, crc, localOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    this.list = out;
    return out;
  }

  // Resolve where an entry's STORE data begins (after its local header).
  private async dataStart(entry: ZipReadEntry): Promise<number> {
    const lh = await this.slice(entry.localOffset, entry.localOffset + 30);
    const dv = new DataView(lh.buffer, lh.byteOffset, lh.byteLength);
    if (dv.getUint32(0, true) !== 0x04034b50) {
      throw new Error("ZIP: bad local header for " + entry.name);
    }
    const nameLen = dv.getUint16(26, true);
    const extraLen = dv.getUint16(28, true);
    return entry.localOffset + 30 + nameLen + extraLen;
  }

  // Lazy Blob slice of an entry's bytes (no full read until consumed).
  async blob(entry: ZipReadEntry): Promise<Blob> {
    const start = await this.dataStart(entry);
    return this.file.slice(start, start + entry.size);
  }

  async bytes(entry: ZipReadEntry): Promise<Uint8Array> {
    return new Uint8Array(await (await this.blob(entry)).arrayBuffer());
  }

  async text(entry: ZipReadEntry): Promise<string> {
    return this.dec.decode(await this.bytes(entry));
  }
}
