// HEIC/HEIF/AVIF cleaning without recompression. Items cannot be removed without recomputing every offset,
// so metadata is overwritten in place and the file size stays the same: the Exif item becomes an empty TIFF,
// the XMP item an empty packet padded with spaces, other auxiliary items (mime, uri) zeros. Top-level boxes
// not needed to show the picture (uuid with C2PA or vendor tags, mpvd) turn into "free" boxes filled with zeros.

import { u16, u32, u64, latin1, utf8, ascii, FormatError } from './bytes.js';
import { gpsPatches } from './tiff.js';

const EMPTY_EXIF = Uint8Array.of(0, 0, 0, 0, 0x4D, 0x4D, 0, 0x2A, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0);
const EMPTY_XMP = ascii('<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"/><?xpacket end="w"?>');
const KEPT_BOXES = new Set(['ftyp', 'meta', 'mdat', 'free', 'skip', 'wide']);
const SEQUENCE_BOXES = new Set(['moov', 'moof', 'mfra']);
const MAX_METADATA_BYTES = 16 * 1024 * 1024;

function boxes(d, from, to) {
  const out = [];
  let p = from;
  while (p + 8 <= to && out.length < 10000) {
    let size = u32(d, p);
    const type = latin1(d, p + 4, 4);
    let header = 8;
    if (size === 1) { size = u64(d, p + 8); header = 16; }
    if (size === 0) size = to - p;
    if (size < header || p + size > to) throw new FormatError('HEIF_BOX', type);
    out.push({ type, start: p, header, end: p + size, dataStart: p + header });
    p += size;
  }
  return out;
}

function readItems(d, iinf) {
  const s = iinf.dataStart;
  const version = d[s];
  const first = s + 4 + (version === 0 ? 2 : 4);
  return boxes(d, first, iinf.end).filter((b) => b.type === 'infe').map((infe) => {
    const p = infe.dataStart;
    const v = d[p];
    let q = p + 4;
    const cString = () => {
      const start = q;
      while (q < infe.end && d[q] !== 0) q++;
      const text = utf8(d, start, q - start);
      q++;
      return text;
    };
    let id, type, contentType = null;
    if (v < 2) {
      id = u16(d, q); q += 4;
      cString();
      type = 'mime';
      if (q < infe.end) contentType = cString();
    } else {
      if (v === 2) { id = u16(d, q); q += 2; } else { id = u32(d, q); q += 4; }
      q += 2;
      type = latin1(d, q, 4); q += 4;
      cString();
      if (type === 'mime' && q < infe.end) contentType = cString();
    }
    const lower = (contentType ?? '').toLowerCase();
    const isExif = type === 'Exif';
    const isXmp = type === 'mime' && lower.includes('rdf+xml');
    const isMetadata = isExif || type === 'uri ' || (type === 'mime' && !lower.startsWith('image/'));
    return { id, type, isExif, isXmp, isMetadata };
  });
}

function sized(d, i, size) {
  if (size === 0) return 0;
  if (size === 4) return u32(d, i);
  if (size === 8) return u64(d, i);
  throw new FormatError('HEIF_FIELD_SIZE');
}

function readLocations(d, iloc, idatStart) {
  let p = iloc.dataStart;
  const version = d[p];
  p += 4;
  const offsetSize = (d[p] >> 4) & 15;
  const lengthSize = d[p] & 15;
  const baseOffsetSize = (d[p + 1] >> 4) & 15;
  const indexSize = version === 1 || version === 2 ? d[p + 1] & 15 : 0;
  p += 2;
  let count;
  if (version < 2) { count = u16(d, p); p += 2; } else { count = u32(d, p); p += 4; }
  const result = new Map();
  for (let n = 0; n < count; n++) {
    if (p > iloc.end) throw new FormatError('HEIF_ILOC');
    let id;
    if (version < 2) { id = u16(d, p); p += 2; } else { id = u32(d, p); p += 4; }
    let method = 0;
    if (version === 1 || version === 2) { method = u16(d, p) & 15; p += 2; }
    p += 2;
    const base = sized(d, p, baseOffsetSize); p += baseOffsetSize;
    const extents = u16(d, p); p += 2;
    const list = [];
    for (let e = 0; e < extents; e++) {
      p += indexSize;
      const off = sized(d, p, offsetSize); p += offsetSize;
      const len = sized(d, p, lengthSize); p += lengthSize;
      if (method === 0) list.push({ offset: base + off, length: len });
      else if (method === 1) {
        if (idatStart == null) throw new FormatError('HEIF_IDAT');
        list.push({ offset: idatStart + base + off, length: len });
      }
    }
    result.set(id, list);
  }
  return result;
}

function structure(d) {
  const top = boxes(d, 0, d.length);
  if (top[0]?.type !== 'ftyp') throw new FormatError('HEIF_FTYP');
  if (top.some((b) => SEQUENCE_BOXES.has(b.type))) throw new FormatError('HEIF_SEQUENCE');
  const meta = top.find((b) => b.type === 'meta');
  if (!meta) throw new FormatError('HEIF_META');
  if (meta.end - meta.start > MAX_METADATA_BYTES) throw new FormatError('HEIF_META');
  const children = boxes(d, meta.dataStart + 4, meta.end);
  const iinf = children.find((b) => b.type === 'iinf');
  const iloc = children.find((b) => b.type === 'iloc');
  if (!iloc) throw new FormatError('HEIF_ILOC');
  const idat = children.find((b) => b.type === 'idat');
  return { top, items: iinf ? readItems(d, iinf) : [], locations: readLocations(d, iloc, idat ? idat.dataStart : null) };
}

function buildPlan(d, gpsOnly) {
  const { top, items, locations } = structure(d);
  const length = d.length;
  const metadataIds = new Set(items.filter((i) => i.isMetadata).map((i) => i.id));
  // Image data must never be overwritten or hidden in a free box. Length 0 means "to the end of the file".
  const imageRanges = [];
  for (const [id, extents] of locations) {
    if (metadataIds.has(id)) continue;
    for (const e of extents) imageRanges.push([e.offset, e.length <= 0 ? length : e.offset + e.length]);
  }
  const touchesImage = (from, to) => imageRanges.some(([a, b]) => from < b && a < to);
  const targets = [];
  for (const item of items) {
    if (!item.isMetadata) continue;
    const extents = locations.get(item.id);
    if (!extents) continue;
    if (extents.some((e) => e.length <= 0)) throw new FormatError('HEIF_EXTENT');
    if (extents.some((e) => e.offset < 0 || e.offset + e.length > length)) throw new FormatError('HEIF_EXTENT');
    if (extents.some((e) => touchesImage(e.offset, e.offset + e.length))) throw new FormatError('HEIF_SHARED');
    const total = extents.reduce((sum, e) => sum + e.length, 0);
    if (total > MAX_METADATA_BYTES) throw new FormatError('HEIF_EXTENT');
    if (gpsOnly && item.isExif) {
      if (extents.length !== 1) throw new FormatError('HEIF_EXIF_SPLIT');
      const start = extents[0].offset;
      const payload = d.subarray(start, start + total);
      const tiff = 4 + u32(payload, 0);
      if (tiff < 4 || tiff + 8 > payload.length) throw new FormatError('HEIF_EXIF');
      for (const [at, bytes] of gpsPatches(payload.subarray(tiff))) targets.push({ offset: start + tiff + at, bytes });
      continue;
    }
    const fill = new Uint8Array(total);
    if (item.isExif && fill.length >= EMPTY_EXIF.length) fill.set(EMPTY_EXIF);
    if (item.isXmp) { fill.fill(0x20); if (fill.length >= EMPTY_XMP.length) fill.set(EMPTY_XMP); }
    let pos = 0;
    for (const e of extents) { targets.push({ offset: e.offset, bytes: fill.subarray(pos, pos + e.length) }); pos += e.length; }
  }
  const removable = top.filter((b) => !KEPT_BOXES.has(b.type) && !touchesImage(b.start, b.end));
  return { targets, removable };
}

function plan(d, gpsOnly) {
  try { return buildPlan(d, gpsOnly); } catch (e) {
    if (e instanceof FormatError) throw e;
    throw new FormatError('HEIF_MALFORMED');
  }
}

function matches(d, gpsOnly) {
  try {
    const p = plan(d, gpsOnly);
    return p.removable.length === 0 && p.targets.every((t) => t.bytes.every((b, i) => d[t.offset + i] === b));
  } catch { return false; }
}

function rewrite(d, gpsOnly) {
  const out = d.slice();
  const p = plan(out, gpsOnly);
  for (const t of p.targets) out.set(t.bytes, t.offset);
  for (const box of p.removable) {
    out.set(ascii('free'), box.start + 4);
    out.fill(0, box.dataStart, box.end);
  }
  if (!matches(out, gpsOnly)) throw new FormatError('HEIF_VERIFY');
  return out;
}

export const stripHeif = (d) => rewrite(d, false);
/** Only the GPS table of Exif is emptied; XMP and other embedded data are wiped whole (they may repeat it). */
export const stripHeifGps = (d) => rewrite(d, true);
export const isCleanHeif = (d) => matches(d, false);

/** Exif item payload as TIFF bytes, or null. Works on a truncated buffer when the item lies inside it. */
export function heifExif(d) {
  try {
    const { items, locations } = structure(d);
    const item = items.find((i) => i.isExif);
    const extent = item && locations.get(item.id)?.[0];
    if (!extent || extent.length < 12 || extent.offset + extent.length > d.length) return null;
    const payload = d.subarray(extent.offset, extent.offset + extent.length);
    const tiff = 4 + u32(payload, 0);
    return tiff + 8 <= payload.length ? payload.subarray(tiff) : null;
  } catch { return null; }
}
