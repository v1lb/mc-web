// WebP (RIFF) cleaning without recompression: EXIF, XMP and every unknown chunk are dropped,
// pixel chunks (VP8/VP8L/ALPH/animation) are copied byte for byte.

import { u32le, putU32le, latin1, concat, ascii, startsWith, FormatError } from './bytes.js';

const IMAGE_CHUNKS = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF', 'ICCP']);
const FLAG_EXIF = 0x08;
const FLAG_XMP = 0x04;

const isWebp = (d) => d.length >= 20 && latin1(d, 0, 4) === 'RIFF' && latin1(d, 8, 4) === 'WEBP';

export function webpChunks(d, strict = false) {
  const out = [];
  if (!isWebp(d)) { if (strict) throw new FormatError('WEBP_SIGNATURE'); return out; }
  let p = 12;
  while (p + 8 <= d.length) {
    const type = latin1(d, p, 4);
    const size = u32le(d, p + 4);
    const end = p + 8 + size;
    if (end > d.length) { if (strict) throw new FormatError('WEBP_TRUNCATED'); break; }
    out.push({ type, start: p, dataStart: p + 8, dataEnd: end, end: Math.min(d.length, end + (size & 1)) });
    p = end + (size & 1);
  }
  return out;
}

export function webpExif(d) {
  const c = webpChunks(d).find((x) => x.type === 'EXIF');
  if (!c) return null;
  const at = startsWith(d, ascii('Exif\0\0'), c.dataStart) ? c.dataStart + 6 : c.dataStart;
  return d.subarray(at, c.dataEnd);
}

function rebuild(d, keep, flagsOff, patchExif) {
  const parts = [d.slice(0, 12)];
  let pixels = 0;
  for (const c of webpChunks(d, true)) {
    if (!keep(c.type)) continue;
    const bytes = d.slice(c.start, c.end);
    if (c.type === 'VP8X' && bytes.length > 8) bytes[8] &= ~flagsOff;
    if (c.type === 'EXIF' && patchExif) {
      const offset = startsWith(bytes, ascii('Exif\0\0'), 8) ? 14 : 8;
      bytes.set(patchExif(bytes.slice(offset, 8 + (c.dataEnd - c.dataStart))), offset);
    }
    parts.push(bytes);
    if (['VP8 ', 'VP8L', 'ANMF'].includes(c.type)) pixels++;
  }
  if (!pixels) throw new FormatError('WEBP_NO_IMAGE');
  const out = concat(parts);
  putU32le(out, 4, out.length - 8);
  return out;
}

export const stripWebp = (d) => rebuild(d, (type) => IMAGE_CHUNKS.has(type), FLAG_EXIF | FLAG_XMP, null);

/** GPS-only removal: XMP goes away (it may repeat the coordinates), the GPS table in EXIF is emptied. */
export const stripWebpGps = (d, patchExif) => rebuild(d, (type) => type !== 'XMP ', FLAG_XMP, patchExif);

export function isCleanWebp(d) {
  try {
    const chunks = webpChunks(d, true);
    return chunks.length > 0 && chunks[chunks.length - 1].end === d.length && chunks.every((c) =>
      IMAGE_CHUNKS.has(c.type) && !(c.type === 'VP8X' && (d[c.dataStart] & (FLAG_EXIF | FLAG_XMP))));
  } catch { return false; }
}
