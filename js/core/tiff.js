// TIFF/EXIF structure: bounded parser and serializer. Values are kept as raw bytes in the file's byte order,
// so untouched tags (including maker notes) are written back exactly as they were read.

import { ascii, latin1, FormatError } from './bytes.js';

export const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];
const MAX_ENTRIES = 512;
const MAX_VALUE_BYTES = 8 * 1024 * 1024;

export const TAG = {
  EXIF_IFD: 0x8769, GPS_IFD: 0x8825, INTEROP_IFD: 0xA005, THUMB_OFFSET: 0x0201, THUMB_LENGTH: 0x0202,
  MAKE: 0x010F, MODEL: 0x0110, ORIENTATION: 0x0112, SOFTWARE: 0x0131, DATETIME: 0x0132, ARTIST: 0x013B,
  COPYRIGHT: 0x8298, IMAGE_DESCRIPTION: 0x010E,
  EXPOSURE_TIME: 0x829A, F_NUMBER: 0x829D, ISO: 0x8827, DATETIME_ORIGINAL: 0x9003, DATETIME_DIGITIZED: 0x9004,
  GPS_VERSION: 0, GPS_LAT_REF: 1, GPS_LAT: 2, GPS_LON_REF: 3, GPS_LON: 4, GPS_ALT_REF: 5, GPS_ALT: 6,
};

function reader(d, little) {
  const b = (i) => d[i] ?? 0;
  return {
    r16: (i) => (little ? b(i) | (b(i + 1) << 8) : (b(i) << 8) | b(i + 1)),
    r32: (i) => (little
      ? (b(i) | (b(i + 1) << 8) | (b(i + 2) << 16)) + b(i + 3) * 0x1000000
      : b(i) * 0x1000000 + ((b(i + 1) << 16) | (b(i + 2) << 8) | b(i + 3))),
  };
}

function readIfd(d, little, offset, seen) {
  const { r16, r32 } = reader(d, little);
  if (offset <= 0 || offset + 2 > d.length || seen.has(offset)) return null;
  seen.add(offset);
  const count = r16(offset);
  if (count > MAX_ENTRIES || offset + 2 + count * 12 > d.length) return null;
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    const e = offset + 2 + i * 12;
    const tag = r16(e);
    const type = r16(e + 2);
    const n = r32(e + 4);
    const size = (TYPE_SIZE[type] ?? 0) * n;
    if (!size || size > MAX_VALUE_BYTES) continue;
    const at = size <= 4 ? e + 8 : r32(e + 8);
    if (at < 0 || at + size > d.length) continue;
    entries.set(tag, { type, count: n, data: d.slice(at, at + size) });
  }
  const nextAt = offset + 2 + count * 12;
  return { entries, next: nextAt + 4 <= d.length ? r32(nextAt) : 0 };
}

/** [d] starts at the TIFF header ("II*\0" or "MM\0*"). Throws FormatError when it is not a TIFF. */
export function parseTiff(d) {
  if (d.length < 8) throw new FormatError('EXIF_SHORT');
  const little = d[0] === 0x49 && d[1] === 0x49;
  if (!little && !(d[0] === 0x4D && d[1] === 0x4D)) throw new FormatError('EXIF_ORDER');
  const { r16, r32 } = reader(d, little);
  if (r16(2) !== 42) throw new FormatError('EXIF_MAGIC');
  const seen = new Set();
  const first = readIfd(d, little, r32(4), seen);
  const t = { little, ifd0: first?.entries ?? new Map(), exif: null, gps: null, interop: null, ifd1: null, thumbnail: null };
  const pointer = (map, tag) => {
    const e = map?.get(tag);
    if (!e) return null;
    map.delete(tag);
    const at = e.type === 3 ? reader(e.data, little).r16(0) : reader(e.data, little).r32(0);
    return readIfd(d, little, at, seen)?.entries ?? null;
  };
  t.exif = pointer(t.ifd0, TAG.EXIF_IFD);
  t.gps = pointer(t.ifd0, TAG.GPS_IFD);
  t.interop = pointer(t.exif, TAG.INTEROP_IFD);
  if (first?.next) {
    const second = readIfd(d, little, first.next, seen);
    if (second) {
      t.ifd1 = second.entries;
      const off = second.entries.get(TAG.THUMB_OFFSET);
      const len = second.entries.get(TAG.THUMB_LENGTH);
      if (off && len) {
        const at = reader(off.data, little).r32(0);
        const n = len.type === 3 ? reader(len.data, little).r16(0) : reader(len.data, little).r32(0);
        if (at > 0 && n > 0 && at + n <= d.length) t.thumbnail = d.slice(at, at + n);
      }
      second.entries.delete(TAG.THUMB_OFFSET);
      second.entries.delete(TAG.THUMB_LENGTH);
      if (!t.thumbnail) t.ifd1 = null;
    }
  }
  return t;
}

export function emptyTiff() {
  return { little: false, ifd0: new Map(), exif: null, gps: null, interop: null, ifd1: null, thumbnail: null };
}

// --- Decoding values ---

/** Numbers for integer types, [numerator, denominator] pairs for rationals, a string for ASCII. */
export function values(entry, little) {
  const d = entry.data;
  const { r16, r32 } = reader(d, little);
  const out = [];
  switch (entry.type) {
    case 2: {
      let end = d.indexOf(0);
      if (end < 0) end = d.length;
      return latin1(d, 0, end);
    }
    case 1: case 7: for (let i = 0; i < d.length; i++) out.push(d[i]); break;
    case 6: for (let i = 0; i < d.length; i++) out.push((d[i] << 24) >> 24); break;
    case 3: for (let i = 0; i + 2 <= d.length; i += 2) out.push(r16(i)); break;
    case 8: for (let i = 0; i + 2 <= d.length; i += 2) out.push((r16(i) << 16) >> 16); break;
    case 4: for (let i = 0; i + 4 <= d.length; i += 4) out.push(r32(i)); break;
    case 9: for (let i = 0; i + 4 <= d.length; i += 4) out.push(r32(i) | 0); break;
    case 5: for (let i = 0; i + 8 <= d.length; i += 8) out.push([r32(i), r32(i + 4)]); break;
    case 10: for (let i = 0; i + 8 <= d.length; i += 8) out.push([r32(i) | 0, r32(i + 4) | 0]); break;
    case 11: case 12: {
      const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
      const step = entry.type === 11 ? 4 : 8;
      for (let i = 0; i + step <= d.length; i += step) out.push(step === 4 ? view.getFloat32(i, little) : view.getFloat64(i, little));
      break;
    }
    default: break;
  }
  return out;
}

export function numberOf(entry, little) {
  if (!entry) return NaN;
  const v = values(entry, little);
  if (typeof v === 'string') return Number(v.trim());
  const first = v[0];
  if (first == null) return NaN;
  if (Array.isArray(first)) return first[1] === 0 ? NaN : first[0] / first[1];
  return first;
}

// --- Building values ---

function writer(little) {
  return {
    w16(d, i, v) { if (little) { d[i] = v & 255; d[i + 1] = (v >>> 8) & 255; } else { d[i] = (v >>> 8) & 255; d[i + 1] = v & 255; } },
    w32(d, i, v) {
      const b = [Math.floor(v / 0x1000000) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
      if (little) b.reverse();
      d.set(b, i);
    },
  };
}

export function asciiEntry(text) {
  const data = new Uint8Array(text.length + 1);
  data.set(ascii(text));
  return { type: 2, count: data.length, data };
}

export function shortEntry(value, little) {
  const data = new Uint8Array(2);
  writer(little).w16(data, 0, value);
  return { type: 3, count: 1, data };
}

export function byteEntry(bytes) {
  return { type: 1, count: bytes.length, data: Uint8Array.from(bytes) };
}

export function rationalEntry(pairs, little) {
  const data = new Uint8Array(pairs.length * 8);
  const { w32 } = writer(little);
  pairs.forEach(([n, den], i) => { w32(data, i * 8, n); w32(data, i * 8 + 4, den); });
  return { type: 5, count: pairs.length, data };
}

/** A positive number as an unsigned rational with a sensible denominator. */
export function toRational(value) {
  if (!Number.isFinite(value) || value < 0) return [0, 1];
  if (value < 1 && value > 0) {
    const den = Math.round(1 / value);
    if (den > 0 && Math.abs(1 / den - value) / value < 1e-6) return [1, den];
  }
  for (const den of [1, 10, 100, 1000, 10000, 1000000]) {
    const n = Math.round(value * den);
    if (n <= 0xFFFFFFFF && Math.abs(n / den - value) <= 1e-9 * Math.max(1, value)) return [n, den];
  }
  return [Math.round(value * 1000000), 1000000];
}

// --- Serializing ---

const pad2 = (n) => n + (n & 1);

function ifdSize(map, extraEntries) {
  let data = 0;
  for (const e of map.values()) if (e.data.length > 4) data += pad2(e.data.length);
  return { table: 2 + (map.size + extraEntries) * 12 + 4, data };
}

/** Returns TIFF bytes (starting at the byte-order mark). */
export function serializeTiff(t) {
  const { w16, w32 } = writer(t.little);
  const ifd0 = t.ifd0 ?? new Map();
  const exif = t.exif && (t.exif.size || t.interop?.size) ? t.exif : null;
  const gps = t.gps?.size ? t.gps : null;
  const interop = exif && t.interop?.size ? t.interop : null;
  const ifd1 = t.ifd1 && t.thumbnail?.length ? t.ifd1 : null;

  const layout = [];
  let pos = 8;
  const place = (map, extra) => {
    const size = ifdSize(map, extra);
    const at = pos;
    pos += size.table + size.data;
    return at;
  };
  const at0 = place(ifd0, (exif ? 1 : 0) + (gps ? 1 : 0));
  const atExif = exif ? place(exif, interop ? 1 : 0) : 0;
  const atInterop = interop ? place(interop, 0) : 0;
  const atGps = gps ? place(gps, 0) : 0;
  const at1 = ifd1 ? place(ifd1, 2) : 0;
  const atThumb = ifd1 ? pos : 0;
  if (ifd1) pos += t.thumbnail.length;

  const out = new Uint8Array(pos);
  out[0] = out[1] = t.little ? 0x49 : 0x4D;
  w16(out, 2, 42);
  w32(out, 4, at0);

  const long = (v) => { const data = new Uint8Array(4); w32(data, 0, v); return { type: 4, count: 1, data }; };
  const write = (map, at, pointers, next) => {
    const all = new Map(map);
    for (const [tag, value] of pointers) all.set(tag, long(value));
    const tags = [...all.keys()].sort((a, b) => a - b);
    w16(out, at, tags.length);
    let dataAt = at + 2 + tags.length * 12 + 4;
    tags.forEach((tag, i) => {
      const e = all.get(tag);
      const p = at + 2 + i * 12;
      w16(out, p, tag); w16(out, p + 2, e.type); w32(out, p + 4, e.count);
      if (e.data.length <= 4) out.set(e.data, p + 8);
      else { w32(out, p + 8, dataAt); out.set(e.data, dataAt); dataAt += pad2(e.data.length); }
    });
    w32(out, at + 2 + tags.length * 12, next);
  };
  layout.push(() => write(ifd0, at0, [...(exif ? [[TAG.EXIF_IFD, atExif]] : []), ...(gps ? [[TAG.GPS_IFD, atGps]] : [])], at1));
  if (exif) layout.push(() => write(exif, atExif, interop ? [[TAG.INTEROP_IFD, atInterop]] : [], 0));
  if (interop) layout.push(() => write(interop, atInterop, [], 0));
  if (gps) layout.push(() => write(gps, atGps, [], 0));
  if (ifd1) {
    layout.push(() => write(ifd1, at1, [[TAG.THUMB_OFFSET, atThumb], [TAG.THUMB_LENGTH, t.thumbnail.length]], 0));
    out.set(t.thumbnail, atThumb);
  }
  layout.forEach((fn) => fn());
  return out;
}

/**
 * Patches that empty the GPS table in place, without moving any byte: values are zeroed and the entry count
 * becomes 0. Returns [[offset, bytes]] relative to the TIFF start; empty when there is no GPS.
 */
export function gpsPatches(d) {
  if (d.length < 8) throw new FormatError('EXIF_SHORT');
  const little = d[0] === 0x49 && d[1] === 0x49;
  if (!little && !(d[0] === 0x4D && d[1] === 0x4D)) throw new FormatError('EXIF_ORDER');
  const { r16, r32 } = reader(d, little);
  if (r16(2) !== 42) throw new FormatError('EXIF_MAGIC');
  const inside = (from, len) => from >= 0 && len >= 0 && from + len <= d.length;
  const ifd0 = r32(4);
  if (!inside(ifd0, 2)) throw new FormatError('EXIF_IFD0');
  const count0 = r16(ifd0);
  if (!inside(ifd0 + 2, count0 * 12)) throw new FormatError('EXIF_IFD0');
  let gps = -1;
  for (let i = 0; i < count0; i++) {
    const e = ifd0 + 2 + i * 12;
    if (r16(e) === TAG.GPS_IFD) gps = r32(e + 8);
  }
  if (gps < 0) return [];
  if (!inside(gps, 2)) throw new FormatError('EXIF_GPS');
  const count = r16(gps);
  if (count === 0) return [];
  if (!inside(gps + 2, count * 12 + 4)) throw new FormatError('EXIF_GPS');
  const patches = [];
  for (let i = 0; i < count; i++) {
    const e = gps + 2 + i * 12;
    const size = (TYPE_SIZE[r16(e + 2)] ?? 0) * r32(e + 4);
    if (size > 4) {
      const at = r32(e + 8);
      if (!inside(at, size)) throw new FormatError('EXIF_GPS');
      patches.push([at, new Uint8Array(size)]);
    }
  }
  patches.push([gps, new Uint8Array(2 + count * 12 + 4)]);
  return patches;
}
