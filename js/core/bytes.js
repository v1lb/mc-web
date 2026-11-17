// Byte helpers shared by every parser. All readers are bounds-safe: out-of-range reads return 0.

export const u8 = (d, i) => d[i] ?? 0;
export const u16 = (d, i) => ((d[i] ?? 0) << 8) | (d[i + 1] ?? 0);
export const u32 = (d, i) => (((d[i] ?? 0) * 0x1000000) + (((d[i + 1] ?? 0) << 16) | ((d[i + 2] ?? 0) << 8) | (d[i + 3] ?? 0)));
export const u64 = (d, i) => u32(d, i) * 0x100000000 + u32(d, i + 4);
export const u16le = (d, i) => (d[i] ?? 0) | ((d[i + 1] ?? 0) << 8);
export const u32le = (d, i) => ((d[i] ?? 0) | ((d[i + 1] ?? 0) << 8) | ((d[i + 2] ?? 0) << 16)) + (d[i + 3] ?? 0) * 0x1000000;
export const s32 = (d, i) => u32(d, i) | 0;

export function putU16(d, i, v) { d[i] = (v >>> 8) & 255; d[i + 1] = v & 255; }
export function putU32(d, i, v) {
  d[i] = Math.floor(v / 0x1000000) & 255; d[i + 1] = (v >>> 16) & 255; d[i + 2] = (v >>> 8) & 255; d[i + 3] = v & 255;
}
export function putU64(d, i, v) { putU32(d, i, Math.floor(v / 0x100000000)); putU32(d, i + 4, v % 0x100000000); }
export function putU32le(d, i, v) {
  d[i] = v & 255; d[i + 1] = (v >>> 8) & 255; d[i + 2] = (v >>> 16) & 255; d[i + 3] = Math.floor(v / 0x1000000) & 255;
}

export function ascii(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 255;
  return out;
}

export function latin1(d, start = 0, len = d.length - start) {
  const end = Math.min(d.length, start + Math.max(0, len));
  let s = '';
  for (let i = start; i < end; i += 8192) s += String.fromCharCode.apply(null, d.subarray(i, Math.min(end, i + 8192)));
  return s;
}

const utf8Decoder = new TextDecoder('utf-8');
export function utf8(d, start = 0, len = d.length - start) {
  return utf8Decoder.decode(d.subarray(start, Math.min(d.length, start + Math.max(0, len))));
}
export function utf16be(d, start = 0, len = d.length - start) {
  return new TextDecoder('utf-16be').decode(d.subarray(start, Math.min(d.length, start + Math.max(0, len))));
}
export const utf8Bytes = (s) => new TextEncoder().encode(s);

export const fourcc = (d, i) => latin1(d, i, 4);

export function startsWith(d, prefix, at = 0) {
  if (at < 0 || at + prefix.length > d.length) return false;
  for (let i = 0; i < prefix.length; i++) if (d[at + i] !== prefix[i]) return false;
  return true;
}

export function indexOfSeq(d, needle, from = 0, to = d.length) {
  const last = Math.min(to, d.length) - needle.length;
  const first = needle[0];
  outer: for (let i = Math.max(0, from); i <= last; i++) {
    if (d[i] !== first) continue;
    for (let j = 1; j < needle.length; j++) if (d[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

export function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

let crcTable = null;
export function crc32(d, start = 0, end = d.length, seed = 0) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = (seed ^ 0xFFFFFFFF) >>> 0;
  for (let i = start; i < end; i++) c = crcTable[(c ^ d[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** Drops control characters except newline and tab, trims and caps the length. */
export function cleanText(raw, max = 500) {
  if (raw == null) return null;
  let s = '';
  for (const ch of String(raw)) {
    const c = ch.codePointAt(0);
    if (ch === '\n' || ch === '\t' || !(c < 32 || (c >= 127 && c < 160))) s += ch;
  }
  s = s.trim().slice(0, max);
  return s || null;
}

/** zlib inflate with a hard output cap. null: damaged data or over the cap. */
export async function inflateBounded(bytes, max) {
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    const reader = stream.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > max) { reader.cancel().catch(() => {}); return null; }
      chunks.push(value);
    }
    return concat(chunks);
  } catch {
    return null;
  }
}

export class FormatError extends Error {
  constructor(code, detail) { super(detail ? `${code}: ${detail}` : code); this.code = code; this.detail = detail; }
}
