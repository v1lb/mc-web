// IPTC-IIM from JPEG: APP13 "Photoshop 3.0", resource 8BIM 0x0404, record 2 datasets.
// Keywords, city, country, headline, caption and author written by Lightroom, Photoshop and photo desks.

import { u8, u16, u32, latin1 } from './bytes.js';
import { jpegSegmentsOf } from './jpeg.js';

export const IPTC_KEY = 'iptc:';
const DATASETS = [[5, 'ObjectName'], [105, 'Headline'], [120, 'Caption'], [25, 'Keywords'], [80, 'Byline'], [116, 'Copyright'],
  [110, 'Credit'], [115, 'Source'], [92, 'Sublocation'], [90, 'City'], [95, 'State'], [101, 'Country']];
const NAMES = new Map(DATASETS);
const MAX_VALUES = 64;
const MAX_VALUE_LENGTH = 2000;

function resource0404(d, from, end) {
  let p = from;
  while (p + 12 <= end) {
    if (latin1(d, p, 4) !== '8BIM') return null;
    const id = u16(d, p + 4);
    const nameLen = u8(d, p + 6);
    let q = p + 7 + nameLen;
    if ((1 + nameLen) % 2 !== 0) q++;
    if (q + 4 > end) return null;
    const size = u32(d, q);
    q += 4;
    if (q + size > end) return null;
    if (id === 0x0404) return d.subarray(q, q + size);
    p = q + size + (size & 1);
  }
  return null;
}

function decodeValue(bytes, utf8Marked) {
  if (utf8Marked) return new TextDecoder().decode(bytes);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return new TextDecoder('windows-1252').decode(bytes); }
}

function parseIim(d) {
  let utf8Marked = false;
  const found = new Map();
  let p = 0, count = 0;
  while (p + 5 <= d.length && count < MAX_VALUES * 4) {
    if (d[p] !== 0x1C) break;
    const record = d[p + 1], dataset = d[p + 2], len = u16(d, p + 3);
    if (len & 0x8000) break;
    const start = p + 5;
    if (start + len > d.length) break;
    const value = d.subarray(start, start + len);
    if (record === 1 && dataset === 90) utf8Marked = len === 3 && value[0] === 0x1B && value[1] === 0x25 && value[2] === 0x47;
    else if (record === 2 && NAMES.has(dataset)) {
      const list = found.get(dataset) ?? [];
      if (list.length < MAX_VALUES) list.push(value);
      found.set(dataset, list);
    }
    count++;
    p = start + len;
  }
  const result = [];
  for (const [dataset, name] of DATASETS) {
    const texts = [...new Set((found.get(dataset) ?? []).map((b) => decodeValue(b, utf8Marked).replace(/\0/g, '').trim()).filter(Boolean))];
    if (texts.length) result.push([name, texts]);
  }
  return result;
}

/** Report fields with the key "iptc:<name>"; repeatable datasets are joined with a comma. */
export function readIptc(d) {
  try {
    for (const seg of jpegSegmentsOf(d, 'iptc')) {
      const iim = resource0404(d, seg.start + 4 + 14, seg.end);
      if (iim) return parseIim(iim).map(([name, texts]) => ({ label: name, value: texts.join(', ').slice(0, MAX_VALUE_LENGTH), key: IPTC_KEY + name }));
    }
  } catch { /* damaged block: no IPTC */ }
  return [];
}
