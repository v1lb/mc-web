// Minimal bounded CBOR decoder for C2PA assertions. Maps become plain objects with string keys.

import { utf8 } from './bytes.js';

const MAX_DEPTH = 32;
const MAX_ITEMS = 100000;

export function decodeCbor(d, start = 0, length = d.length - start) {
  const end = start + length;
  let pos = start;
  let items = 0;
  const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const need = (n) => { if (pos + n > end) throw new Error('cbor: truncated'); };
  const arg = (info) => {
    if (info < 24) return info;
    if (info === 24) { need(1); return d[pos++]; }
    if (info === 25) { need(2); pos += 2; return view.getUint16(pos - 2); }
    if (info === 26) { need(4); pos += 4; return view.getUint32(pos - 4); }
    if (info === 27) { need(8); pos += 8; return view.getUint32(pos - 8) * 0x100000000 + view.getUint32(pos - 4); }
    if (info === 31) return -1;
    throw new Error('cbor: bad length');
  };
  const chunked = (major) => {
    const parts = [];
    for (;;) {
      need(1);
      if (d[pos] === 0xFF) { pos++; break; }
      const b = d[pos++];
      if (b >> 5 !== major) throw new Error('cbor: bad chunk');
      const n = arg(b & 31);
      if (n < 0) throw new Error('cbor: nested indefinite');
      need(n);
      parts.push(d.subarray(pos, pos + n));
      pos += n;
    }
    const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  };
  const item = (depth) => {
    if (depth > MAX_DEPTH || ++items > MAX_ITEMS) throw new Error('cbor: too complex');
    need(1);
    const b = d[pos++];
    const major = b >> 5, info = b & 31;
    if (major === 7) {
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22 || info === 23) return null;
      if (info === 25) { need(2); pos += 2; return halfFloat(view.getUint16(pos - 2)); }
      if (info === 26) { need(4); pos += 4; return view.getFloat32(pos - 4); }
      if (info === 27) { need(8); pos += 8; return view.getFloat64(pos - 8); }
      if (info === 24) { need(1); pos++; return null; }
      if (info < 20) return null;
      throw new Error('cbor: unexpected break');
    }
    const n = arg(info);
    switch (major) {
      case 0: return n;
      case 1: return -1 - n;
      case 2: { if (n < 0) return chunked(2); need(n); pos += n; return d.subarray(pos - n, pos); }
      case 3: { if (n < 0) return utf8(chunked(3)); need(n); pos += n; return utf8(d, pos - n, n); }
      case 4: {
        const out = [];
        if (n < 0) { for (;;) { need(1); if (d[pos] === 0xFF) { pos++; break; } out.push(item(depth + 1)); } }
        else for (let i = 0; i < n; i++) out.push(item(depth + 1));
        return out;
      }
      case 5: {
        const out = {};
        const pair = () => { const k = item(depth + 1); const v = item(depth + 1); if (typeof k === 'string' || typeof k === 'number') out[k] = v; };
        if (n < 0) { for (;;) { need(1); if (d[pos] === 0xFF) { pos++; break; } pair(); } }
        else for (let i = 0; i < n; i++) pair();
        return out;
      }
      default: return item(depth + 1); // tag: the tagged value itself
    }
  };
  return item(0);
}

function halfFloat(h) {
  const e = (h >> 10) & 31, f = h & 1023, sign = h & 0x8000 ? -1 : 1;
  if (e === 0) return sign * f * 2 ** -24;
  if (e === 31) return f ? NaN : sign * Infinity;
  return sign * (f + 1024) * 2 ** (e - 25);
}
