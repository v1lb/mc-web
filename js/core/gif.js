// GIF cleaning without recompression: comment and application extensions (XMP, vendor blocks) are dropped,
// frames and the animation loop counter stay. Everything after the trailer is cut off.

import { latin1, concat, FormatError } from './bytes.js';

const KEEP_APPS = new Set(['NETSCAPE2.0', 'ANIMEXTS1.0']);

function subBlocksEnd(d, p) {
  for (;;) {
    if (p >= d.length) throw new FormatError('GIF_TRUNCATED');
    const n = d[p];
    p += 1 + n;
    if (n === 0) return p;
  }
}

function walk(d) {
  if (d.length < 13 || !/^GIF8[79]a$/.test(latin1(d, 0, 6))) throw new FormatError('GIF_SIGNATURE');
  let p = 13;
  if (d[10] & 0x80) p += 3 * (1 << ((d[10] & 7) + 1));
  const blocks = [{ start: 0, end: p, keep: true }];
  for (;;) {
    if (p >= d.length) throw new FormatError('GIF_TRUNCATED');
    const start = p;
    const id = d[p];
    if (id === 0x3B) { blocks.push({ start, end: p + 1, keep: true }); return blocks; }
    if (id === 0x2C) {
      const flags = d[p + 9];
      p += 10;
      if (flags & 0x80) p += 3 * (1 << ((flags & 7) + 1));
      p = subBlocksEnd(d, p + 1);
      blocks.push({ start, end: p, keep: true });
    } else if (id === 0x21) {
      const label = d[p + 1];
      const end = subBlocksEnd(d, p + 2);
      let keep = label === 0xF9; // graphic control: frame delay and transparency
      if (label === 0xFF) keep = d[p + 2] === 11 && KEEP_APPS.has(latin1(d, p + 3, 11));
      blocks.push({ start, end, keep });
      p = end;
    } else {
      throw new FormatError('GIF_BLOCK');
    }
  }
}

export function stripGif(d) {
  return concat(walk(d).filter((b) => b.keep).map((b) => d.subarray(b.start, b.end)));
}

export function isCleanGif(d) {
  try {
    const blocks = walk(d);
    return blocks.every((b) => b.keep) && blocks[blocks.length - 1].end === d.length;
  } catch { return false; }
}

/** Text of comment extensions and the XMP application block, for the report. */
export function gifTexts(d) {
  const out = { comments: [], xmp: false };
  try {
    for (const b of walk(d)) {
      if (d[b.start] !== 0x21) continue;
      if (d[b.start + 1] === 0xFE) {
        let p = b.start + 2;
        let text = '';
        while (d[p]) { text += latin1(d, p + 1, d[p]); p += 1 + d[p]; }
        if (text.trim()) out.comments.push(text.slice(0, 2000));
      } else if (d[b.start + 1] === 0xFF && latin1(d, b.start + 3, 11) === 'XMP DataXMP') out.xmp = true;
    }
  } catch { /* damaged file: whatever was read so far */ }
  return out;
}
