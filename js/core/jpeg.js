// JPEG marker walker, including entropy-coded data after SOS. The sanitizer keeps only the primary frame up to
// its EOI: phones append Motion Photo video (with its own geotag), MPF frames and vendor trailers after it.

import { ascii, startsWith, u16, concat, FormatError } from './bytes.js';
import { parseTiff, serializeTiff, emptyTiff, shortEntry, TAG } from './tiff.js';

const EXIF = ascii('Exif\0\0');
const XMP = ascii('http://ns.adobe.com/xap/1.0/\0');
const XMP_EXT = ascii('http://ns.adobe.com/xmp/extension/\0');
const PHOTOSHOP = ascii('Photoshop 3.0\0');
const MPF = ascii('MPF\0');
const ICC = ascii('ICC_PROFILE\0');
const ADOBE = ascii('Adobe');
const JFIF = ascii('JFIF\0');

const SOI = 0xD8, EOI = 0xD9, SOS = 0xDA, TEM = 0x01;

function kindOf(d, seg) {
  const at = seg.start + 4;
  const m = seg.marker;
  if (m === 0xE1 && startsWith(d, EXIF, at)) return 'exif';
  if (m === 0xE1 && (startsWith(d, XMP, at) || startsWith(d, XMP_EXT, at))) return 'xmp';
  if (m === 0xED && startsWith(d, PHOTOSHOP, at)) return 'iptc';
  if (m === 0xFE) return 'comment';
  if (m === 0xE2 && startsWith(d, MPF, at)) return 'mpf';
  if (m === 0xE2 && startsWith(d, ICC, at)) return 'icc';
  if (m === 0xE0 && startsWith(d, JFIF, at)) return 'jfif';
  if (m === 0xEE && startsWith(d, ADOBE, at)) return 'adobe';
  if ((m >= 0xE0 && m <= 0xEF)) return 'app';
  return 'image';
}

/**
 * Segments of the primary frame. [headerOnly] stops at the first SOS (enough for reading metadata, works on a
 * truncated buffer). Otherwise the whole frame is walked and [end] is the offset just past EOI.
 */
export function walkJpeg(d, headerOnly = false) {
  if (d.length < 4 || d[0] !== 0xFF || d[1] !== SOI) throw new FormatError('JPEG_SOI');
  const segments = [];
  let i = 2;
  let end = -1;
  while (i < d.length) {
    if (d[i] !== 0xFF) { if (headerOnly) break; throw new FormatError('JPEG_MARKER'); }
    let m = d[i + 1];
    while (m === 0xFF && i + 2 < d.length) { i++; m = d[i + 1]; }
    if (m === undefined) break;
    if (m === EOI) { end = i + 2; break; }
    if (m === TEM || (m >= 0xD0 && m <= 0xD7)) { segments.push({ marker: m, start: i, end: i + 2, kind: 'image' }); i += 2; continue; }
    if (m === SOI || m === 0x00) { if (headerOnly) break; throw new FormatError('JPEG_MARKER'); }
    const len = u16(d, i + 2);
    if (len < 2 || i + 2 + len > d.length) { if (headerOnly) break; throw new FormatError('JPEG_TRUNCATED'); }
    const seg = { marker: m, start: i, end: i + 2 + len };
    seg.kind = kindOf(d, seg);
    segments.push(seg);
    i = seg.end;
    if (m === SOS) {
      if (headerOnly) break;
      // Entropy data: 0xFF00 (byte stuffing) and RST0–7 belong to the scan.
      let j = i;
      for (;;) {
        j = d.indexOf(0xFF, j);
        if (j < 0 || j + 1 >= d.length) { j = d.length; break; }
        const next = d[j + 1];
        if (next === 0x00 || (next >= 0xD0 && next <= 0xD7)) { j += 2; continue; }
        if (next === 0xFF) { j += 1; continue; }
        break;
      }
      seg.end = j;
      i = j;
    }
  }
  return { segments, end, complete: end >= 0, trailer: end >= 0 && end < d.length };
}

/** EXIF payload as a TIFF byte array, or null. */
export function jpegExif(d) {
  try {
    const seg = walkJpeg(d, true).segments.find((s) => s.kind === 'exif');
    return seg ? d.subarray(seg.start + 10, seg.end) : null;
  } catch { return null; }
}

function exifHasThumbnail(tiffBytes) {
  try { return !!parseTiff(tiffBytes).thumbnail; } catch { return false; }
}

/** What the file carries besides the picture. Used to verify every cleaned copy. */
export function inspectJpeg(d) {
  const walk = walkJpeg(d);
  const f = { exif: false, exifThumbnail: false, xmp: false, iptc: false, comment: false, mpf: false, otherApp: false, trailer: walk.trailer };
  for (const s of walk.segments) {
    if (s.kind === 'exif') { f.exif = true; f.exifThumbnail ||= exifHasThumbnail(d.subarray(s.start + 10, s.end)); }
    else if (s.kind === 'xmp') f.xmp = true;
    else if (s.kind === 'iptc') f.iptc = true;
    else if (s.kind === 'comment') f.comment = true;
    else if (s.kind === 'mpf') f.mpf = true;
    else if (s.kind === 'app') f.otherApp = true;
  }
  f.hidden = f.xmp || f.iptc || f.comment || f.mpf || f.trailer || f.exifThumbnail;
  return f;
}

function exifSegment(tiffBytes) {
  const len = tiffBytes.length + 8;
  if (len > 0xFFFF) throw new FormatError('EXIF_TOO_LARGE');
  const head = new Uint8Array(10);
  head[0] = 0xFF; head[1] = 0xE1; head[2] = len >> 8; head[3] = len & 255; head.set(EXIF, 4);
  return concat([head, tiffBytes]);
}

function assemble(d, walk, keep, exifBytes) {
  const parts = [d.subarray(0, 2)];
  let exifPlaced = !exifBytes;
  walk.segments.forEach((s, index) => {
    // New EXIF goes right after the JFIF header, or first when there is none.
    if (!exifPlaced && !(index === 0 && s.kind === 'jfif')) { parts.push(exifSegment(exifBytes)); exifPlaced = true; }
    if (keep(s)) parts.push(d.subarray(s.start, s.end));
  });
  if (!exifPlaced) parts.push(exifSegment(exifBytes));
  parts.push(Uint8Array.of(0xFF, EOI));
  return concat(parts);
}

/**
 * Full cleaning without recompression: only the picture, its colour profile and the orientation stay.
 * Every other APPn segment, comments and everything after EOI are dropped.
 */
export function stripJpeg(d) {
  const walk = walkJpeg(d);
  let orientation = 1;
  const exif = walk.segments.find((s) => s.kind === 'exif');
  if (exif) {
    try {
      const t = parseTiff(d.subarray(exif.start + 10, exif.end));
      const e = t.ifd0.get(TAG.ORIENTATION);
      if (e) orientation = t.little ? e.data[0] | (e.data[1] << 8) : (e.data[0] << 8) | e.data[1];
    } catch { /* damaged EXIF: nothing to carry over */ }
  }
  let minimal = null;
  if (orientation >= 2 && orientation <= 8) {
    const t = emptyTiff();
    t.ifd0.set(TAG.ORIENTATION, shortEntry(orientation, t.little));
    minimal = serializeTiff(t);
  }
  const keep = (s) => s.kind === 'image' || s.kind === 'jfif' || s.kind === 'icc' || s.kind === 'adobe';
  return assemble(d, walk, keep, minimal);
}

/** True when the file holds nothing but the picture (an orientation-only EXIF is allowed). */
export function isStrippedJpeg(d) {
  try {
    const f = inspectJpeg(d);
    if (f.hidden || f.otherApp) return false;
    if (!f.exif) return true;
    const t = parseTiff(jpegExif(d));
    return !t.exif && !t.gps && !t.ifd1 && t.ifd0.size === 1 && t.ifd0.has(TAG.ORIENTATION);
  } catch { return false; }
}

/**
 * Keeps the picture and EXIF, drops XMP, IPTC, comments, MPF frames and the trailer: after an edit they would
 * still carry the old coordinates, dates or the original frame. [exifBytes]: undefined keeps the EXIF as is,
 * null removes it, bytes replace it.
 */
export function sanitizeJpeg(d, exifBytes) {
  const walk = walkJpeg(d);
  const drop = new Set(['xmp', 'iptc', 'comment', 'mpf']);
  if (exifBytes !== undefined) drop.add('exif');
  return assemble(d, walk, (s) => !drop.has(s.kind), exifBytes ?? null);
}

/** Applies in-place patches to the EXIF payload (same length), keeping every other byte. */
export function patchJpegExif(d, patches) {
  const out = d.slice();
  const seg = walkJpeg(d, true).segments.find((s) => s.kind === 'exif');
  if (!seg) return out;
  for (const [at, bytes] of patches) out.set(bytes, seg.start + 10 + at);
  return out;
}

/** XMP packet bytes from APP1 (standard packet only), or null. */
export function jpegSegmentsOf(d, kind) {
  try { return walkJpeg(d, true).segments.filter((s) => s.kind === kind); } catch { return []; }
}
