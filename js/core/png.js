// PNG chunks: bounded text parsing (tEXt / zTXt / iTXt) and cleaning by an allow-list.

import { u32, putU32, latin1, utf8, startsWith, concat, crc32, inflateBounded, ascii, FormatError } from './bytes.js';
import { PNG_SIGNATURE } from './format.js';

export const MAX_CHUNKS = 5000;
export const MAX_TEXT_CHUNK_BYTES = 1 << 20;
export const MAX_INFLATED_BYTES = 1 << 20;
export const MAX_ENTRIES = 64;
export const MAX_TEXT_CHARS = 20000;
/** Marker for a damaged or oversized block; the interface shows a localized note instead. */
export const BAD_DATA = '\u0000metacheck:bad-data\u0000';

/** Everything a PNG needs to be displayed. Any other chunk, including C2PA (caBX), counts as metadata. */
const ALLOWED = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'sRGB', 'gAMA', 'cHRM', 'iCCP', 'cICP', 'sBIT', 'pHYs', 'bKGD',
  'acTL', 'fcTL', 'fdAT']);

/** Chunks up to IEND. Stops quietly at the first malformed chunk (analysis must not throw). */
export function pngChunks(d) {
  const out = [];
  if (!startsWith(d, PNG_SIGNATURE)) return out;
  let pos = 8;
  while (out.length < MAX_CHUNKS && pos + 12 <= d.length) {
    const len = u32(d, pos);
    const type = latin1(d, pos + 4, 4);
    if (!/^[A-Za-z]{4}$/.test(type)) break;
    const end = pos + 12 + len;
    if (end > d.length) break;
    out.push({ type, start: pos, dataStart: pos + 8, dataEnd: pos + 8 + len, end });
    if (type === 'IEND') break;
    pos = end;
  }
  return out;
}

function cleanChars(s) {
  let out = '';
  for (let i = 0; i < s.length && out.length < MAX_TEXT_CHARS; i++) {
    const c = s.charCodeAt(i);
    if (c === 10 || c === 9 || !(c < 32 || (c >= 127 && c < 160))) out += s[i];
  }
  return out;
}

/** Position of the first zero byte in [from, to), or -1. Never looks past the chunk. */
function indexOfZero(d, from, to) {
  const at = d.subarray(from, to).indexOf(0);
  return at < 0 ? -1 : from + at;
}

async function decodeText(type, d, start, end) {
  const nul = indexOfZero(d, start, Math.min(end, start + 80));
  if (nul < 0 || nul === start) return null;
  const keyword = latin1(d, start, nul - start);
  const rest = nul + 1;
  if (type === 'tEXt') return { keyword, text: cleanChars(latin1(d, rest, end - rest)) };
  if (type === 'zTXt') {
    if (rest >= end || d[rest] !== 0) return null;
    const raw = await inflateBounded(d.subarray(rest + 1, end), MAX_INFLATED_BYTES);
    return { keyword, text: raw ? cleanChars(latin1(raw)) : BAD_DATA };
  }
  if (rest + 2 > end) return null;
  const compressed = d[rest];
  const method = d[rest + 1];
  const langEnd = indexOfZero(d, rest + 2, end);
  if (langEnd < 0) return null;
  const translatedEnd = indexOfZero(d, langEnd + 1, end);
  if (translatedEnd < 0) return null;
  const textStart = translatedEnd + 1;
  if (compressed === 0) return { keyword, text: cleanChars(utf8(d, textStart, end - textStart)) };
  if (compressed !== 1 || method !== 0) return null;
  const raw = await inflateBounded(d.subarray(textStart, end), MAX_INFLATED_BYTES);
  return { keyword, text: raw ? cleanChars(utf8(raw)) : BAD_DATA };
}

export async function parsePngText(d) {
  const out = [];
  for (const c of pngChunks(d)) {
    if (out.length >= MAX_ENTRIES) break;
    if ((c.type === 'tEXt' || c.type === 'zTXt' || c.type === 'iTXt') && c.dataEnd - c.dataStart <= MAX_TEXT_CHUNK_BYTES) {
      const entry = await decodeText(c.type, d, c.dataStart, c.dataEnd);
      if (entry) out.push(entry);
    }
  }
  return out;
}

export function pngExif(d) {
  const c = pngChunks(d).find((x) => x.type === 'eXIf');
  return c ? d.subarray(c.dataStart, c.dataEnd) : null;
}

function strictChunks(d) {
  if (!startsWith(d, PNG_SIGNATURE)) throw new FormatError('PNG_SIGNATURE');
  const chunks = pngChunks(d);
  if (!chunks.length || chunks[0].type !== 'IHDR' || chunks[chunks.length - 1].type !== 'IEND') throw new FormatError('PNG_TRUNCATED');
  return chunks;
}

/** Full cleaning without recompression: pixel data is copied byte for byte, everything after IEND is dropped. */
export function stripPng(d) {
  const parts = [PNG_SIGNATURE];
  for (const c of strictChunks(d)) if (ALLOWED.has(c.type)) parts.push(d.subarray(c.start, c.end));
  return concat(parts);
}

export function isCleanPng(d) {
  try {
    const chunks = strictChunks(d);
    return chunks.every((c) => ALLOWED.has(c.type)) && chunks[chunks.length - 1].end === d.length;
  } catch { return false; }
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  putU32(out, 0, data.length);
  out.set(ascii(type), 4);
  out.set(data, 8);
  putU32(out, 8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

/**
 * GPS-only removal: the GPS table inside eXIf is emptied by [patchExif] and text chunks that may repeat the
 * coordinates (the XMP packet, gps_* keywords) are dropped. Everything else stays.
 */
export function stripPngGps(d, patchExif) {
  const parts = [PNG_SIGNATURE];
  for (const c of strictChunks(d)) {
    if (c.type === 'eXIf') { parts.push(chunk('eXIf', patchExif(d.slice(c.dataStart, c.dataEnd)))); continue; }
    if (c.type === 'tEXt' || c.type === 'zTXt' || c.type === 'iTXt') {
      const nul = indexOfZero(d, c.dataStart, Math.min(c.dataEnd, c.dataStart + 80));
      const keyword = nul > 0 ? latin1(d, c.dataStart, nul - c.dataStart).toLowerCase() : '';
      if (keyword === 'xml:com.adobe.xmp' || keyword.includes('gps') || keyword.startsWith('raw profile')) continue;
    }
    parts.push(d.subarray(c.start, c.end));
  }
  return concat(parts);
}
