/**
 * Reads the *real* capture date stored inside the file, rather than the
 * file-system timestamps that Windows shows as "Date created / Date modified"
 * (those change whenever a file is copied, synced or re-saved).
 *
 *  - Photos: EXIF DateTimeOriginal / CreateDate (JPEG, HEIC, AVIF, TIFF, DNG...).
 *  - Videos (MP4 / MOV / M4V / 3GP): Apple's `com.apple.quicktime.creationdate`
 *    (local time + offset) if present, otherwise the `mvhd` creation time
 *    (UTC, which is what Windows 11 shows as "Media created").
 */
import { promises as fsp } from "fs";
import * as exifrNs from "exifr";
import { RawMeta } from "./types";
import { wallFromParts } from "./util";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const exifr: any = (exifrNs as any).default ?? exifrNs;

type FileHandle = Awaited<ReturnType<typeof fsp.open>>;

/* ------------------------------------------------------------------ photos */

const EXIF_RE = /^(\d{4})[:\-](\d{2})[:\-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/;

function wallFromExifString(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const m = EXIF_RE.exec(v.trim());
  if (!m) return undefined;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  if (y < 1970 || mo < 1 || mo > 12 || d < 1 || d > 31) return undefined; // rejects "0000:00:00 00:00:00"
  return wallFromParts(y, mo, d, h, mi, s);
}

export async function readPhotoMeta(path: string): Promise<RawMeta> {
  let fh: FileHandle | undefined;
  try {
    fh = await fsp.open(path, "r");
    const buf = Buffer.alloc(1024 * 1024); // EXIF lives at the start of the file
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const data = await exifr.parse(buf.subarray(0, bytesRead), {
      pick: ["DateTimeOriginal", "CreateDate", "DateTimeDigitized"],
      reviveValues: false, // keep the raw "YYYY:MM:DD HH:MM:SS" string: it is local wall-clock time, no zone
    });
    const wall =
      wallFromExifString(data?.DateTimeOriginal) ??
      wallFromExifString(data?.CreateDate) ??
      wallFromExifString(data?.DateTimeDigitized);
    return wall ? { wall, wallSource: "exif" } : {};
  } catch {
    return {};
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

/* ------------------------------------------------------------------ videos */

const MAC_EPOCH_OFFSET_S = 2_082_844_800; // seconds between 1904-01-01 and 1970-01-01
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/;

interface Box {
  type: string;
  start: number;
  contentStart: number;
  end: number;
}

/** Walk boxes inside an in-memory buffer. */
function* boxes(buf: Buffer, start: number, end: number): Generator<Box> {
  let pos = start;
  while (pos + 8 <= end) {
    let size = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    let header = 8;
    if (size === 1) {
      if (pos + 16 > end) return;
      size = Number(buf.readBigUInt64BE(pos + 8));
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header || pos + size > end) return;
    yield { type, start: pos, contentStart: pos + header, end: pos + size };
    pos += size;
  }
}

/** Read one box header straight from disk (used to skip huge atoms like `mdat` with a seek). */
async function readBoxHeader(fh: FileHandle, pos: number, limit: number): Promise<Box | null> {
  const b = Buffer.alloc(16);
  const { bytesRead } = await fh.read(b, 0, 16, pos);
  if (bytesRead < 8) return null;
  let size = b.readUInt32BE(0);
  const type = b.toString("latin1", 4, 8);
  let header = 8;
  if (size === 1) {
    if (bytesRead < 16) return null;
    size = Number(b.readBigUInt64BE(8));
    header = 16;
  } else if (size === 0) {
    size = limit - pos;
  }
  if (size < header) return null;
  return { type, start: pos, contentStart: pos + header, end: Math.min(pos + size, limit) };
}

function wallFromIsoWithOffset(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const s = v.trim();
  if (/Z$/i.test(s)) return undefined; // pure UTC: the mvhd value already covers this
  const m = ISO_RE.exec(s);
  if (!m) return undefined;
  const [y, mo, d, h, mi, sec] = m.slice(1).map(Number);
  if (y < 1970) return undefined;
  return wallFromParts(y, mo, d, h, mi, sec); // recording-local wall time; the offset is ignored on purpose
}

/** Extract `com.apple.quicktime.creationdate` from a `meta` box payload. */
function parseQuickTimeMeta(buf: Buffer): string | undefined {
  // QuickTime-style meta has no version/flags; ISO-style does. Detect by looking for 'hdlr'.
  const off = buf.length >= 8 && buf.toString("latin1", 4, 8) === "hdlr" ? 0 : 4;
  const keys: string[] = [];
  let ilst: Box | undefined;
  for (const b of boxes(buf, off, buf.length)) {
    if (b.type === "keys") {
      let p = b.contentStart + 4;
      const count = buf.readUInt32BE(p);
      p += 4;
      for (let i = 0; i < count && p + 8 <= b.end; i++) {
        const ks = buf.readUInt32BE(p);
        if (ks < 8) break;
        keys.push(buf.toString("utf8", p + 8, p + ks));
        p += ks;
      }
    } else if (b.type === "ilst") {
      ilst = b;
    }
  }
  const idx = keys.indexOf("com.apple.quicktime.creationdate") + 1;
  if (!idx || !ilst) return undefined;
  for (const item of boxes(buf, ilst.contentStart, ilst.end)) {
    if (buf.readUInt32BE(item.start + 4) !== idx) continue; // item "type" is the 1-based key index
    for (const d of boxes(buf, item.contentStart, item.end)) {
      if (d.type === "data") return buf.toString("utf8", d.contentStart + 8, d.end).replace(/\0+$/, "");
    }
  }
  return undefined;
}

async function readMetaBox(fh: FileHandle, box: Box): Promise<string | undefined> {
  const len = Math.min(box.end - box.contentStart, 512 * 1024);
  if (len < 16) return undefined;
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, box.contentStart);
  return parseQuickTimeMeta(buf.subarray(0, bytesRead));
}

async function parseMoov(fh: FileHandle, start: number, end: number, out: RawMeta): Promise<void> {
  let qtMeta: string | undefined;
  let udtaDay: string | undefined;
  let pos = start;
  for (let guard = 0; pos + 8 <= end && guard < 500; guard++) {
    const box = await readBoxHeader(fh, pos, end);
    if (!box) break;
    if (box.type === "mvhd") {
      const b = Buffer.alloc(12);
      await fh.read(b, 0, 12, box.contentStart);
      const secs = b[0] === 1 ? Number(b.readBigUInt64BE(4)) : b.readUInt32BE(4);
      const ms = (secs - MAC_EPOCH_OFFSET_S) * 1000;
      if (ms > Date.UTC(1990, 0, 1) && ms < Date.now() + 2 * 86_400_000) out.utcMs = ms;
    } else if (box.type === "meta") {
      qtMeta = qtMeta ?? (await readMetaBox(fh, box));
    } else if (box.type === "udta") {
      let p = box.contentStart;
      for (let g = 0; p + 8 <= box.end && g < 100; g++) {
        const child = await readBoxHeader(fh, p, box.end);
        if (!child) break;
        if (child.type === "\u00a9day") {
          const b = Buffer.alloc(Math.min(child.end - child.contentStart, 128));
          await fh.read(b, 0, b.length, child.contentStart);
          const n = b.length >= 4 ? b.readUInt16BE(0) : 0;
          udtaDay = b.toString("utf8", 4, 4 + n);
        } else if (child.type === "meta") {
          qtMeta = qtMeta ?? (await readMetaBox(fh, child));
        }
        p = child.end;
      }
    }
    pos = box.end;
  }
  const wall = wallFromIsoWithOffset(qtMeta) ?? wallFromIsoWithOffset(udtaDay);
  if (wall) {
    out.wall = wall;
    out.wallSource = "quicktime";
  }
}

export async function readVideoMeta(path: string): Promise<RawMeta> {
  let fh: FileHandle | undefined;
  try {
    fh = await fsp.open(path, "r");
    const { size } = await fh.stat();
    const out: RawMeta = {};
    let pos = 0;
    for (let guard = 0; pos + 8 <= size && guard < 5000; guard++) {
      const box = await readBoxHeader(fh, pos, size);
      if (!box) break;
      if (box.type === "moov") {
        await parseMoov(fh, box.contentStart, box.end, out);
        break;
      }
      pos = box.end; // seek past mdat etc. without reading it
    }
    return out;
  } catch {
    return {};
  } finally {
    await fh?.close().catch(() => undefined);
  }
}
