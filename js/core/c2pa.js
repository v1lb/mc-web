// Content Credentials (C2PA), read offline: find the manifest store (JUMBF), parse c2pa.actions assertions and
// the claim. The signature and hashes are NOT verified: a manifest can be copied into another file.
//   JPEG: APP11 segments, long stores split across several; PNG: caBX chunk; WebP: RIFF "C2PA" chunk;
//   HEIC/AVIF/MP4: uuid box with the C2PA id. Otherwise the bytes are scanned for a "jumb" box.

import { u16, u32, u64, u32le, latin1, utf8, ascii, indexOfSeq, startsWith, concat } from './bytes.js';
import { decodeCbor } from './cbor.js';
import { walkJpeg } from './jpeg.js';
import { pngChunks } from './png.js';
import { webpChunks } from './webp.js';

export const TRAINED = 'trainedAlgorithmicMedia';
export const COMPOSITE_TRAINED = 'compositeWithTrainedAlgorithmicMedia';

const MAX_BOX_DEPTH = 16;
const MAX_NAME = 80;
const JUMB = ascii('jumb');
const C2PA_LABEL = ascii('c2pa');
export const C2PA_UUID = Uint8Array.of(0xD8, 0xFE, 0xC3, 0xD6, 0x1B, 0x0E, 0x48, 0x3C, 0x92, 0x97, 0x58, 0x28, 0x87, 0x7E, 0xC4, 0x81);

function boxes(d, from, to) {
  const out = [];
  let i = from;
  while (i + 8 <= to) {
    let size = u32(d, i);
    let header = 8;
    if (size === 1) { if (i + 16 > to) break; size = u64(d, i + 8); header = 16; }
    else if (size === 0) size = to - i;
    if (size < header || size > to - i) break;
    out.push({ type: latin1(d, i + 4, 4), start: i + header, end: i + size });
    i += size;
  }
  return out;
}

/** Label of a jumd description box: 16 bytes of type, a flags byte, then a zero-terminated string. */
function labelOf(d, superbox) {
  const desc = boxes(d, superbox.start, superbox.end)[0];
  if (!desc || desc.type !== 'jumd' || desc.end - desc.start < 17) return null;
  if (!(d[desc.start + 16] & 0x02)) return null;
  let p = desc.start + 17;
  const s = p;
  while (p < desc.end && d[p] !== 0) p++;
  return utf8(d, s, p - s);
}

function isStore(d) {
  try {
    const first = boxes(d, 0, d.length)[0];
    return !!first && first.type === 'jumb' && labelOf(d, first) === 'c2pa';
  } catch { return false; }
}

function jpegStore(d) {
  const parts = new Map();
  let segments;
  try { segments = walkJpeg(d, true).segments; } catch { return null; }
  for (const s of segments) {
    const start = s.start + 4;
    // CI "JP", En (2 bytes), Z (4 bytes), then box data.
    if (s.marker !== 0xEB || s.end - start < 8 || d[start] !== 0x4A || d[start + 1] !== 0x50) continue;
    const instance = u16(d, start + 2);
    const seq = u32(d, start + 4);
    let payload = start + 8;
    // Continuations repeat the box header (LBox, TBox and XLBox when LBox = 1).
    if (seq > 1) payload += u32(d, payload) === 1 ? 16 : 8;
    if (payload > s.end) continue;
    if (!parts.has(instance)) parts.set(instance, new Map());
    parts.get(instance).set(seq, d.subarray(payload, s.end));
  }
  for (const chunks of parts.values()) {
    const joined = concat([...chunks.keys()].sort((a, b) => a - b).map((k) => chunks.get(k)));
    if (isStore(joined)) return joined;
  }
  return null;
}

function pngStore(d) {
  const c = pngChunks(d).find((x) => x.type === 'caBX');
  const store = c && d.subarray(c.dataStart, c.dataEnd);
  return store && isStore(store) ? store : null;
}

function webpStore(d) {
  const c = webpChunks(d).find((x) => x.type === 'C2PA');
  const store = c && d.subarray(c.dataStart, c.dataEnd);
  return store && isStore(store) ? store : null;
}

/** Top-level ISO BMFF boxes: uuid C2PA → version/flags, purpose, offset, JUMBF. */
function isoBmffStore(d) {
  let i = 0;
  while (i + 8 <= d.length) {
    let size = u32(d, i);
    const type = latin1(d, i + 4, 4);
    let header = 8;
    if (size === 1) { if (i + 16 > d.length) return null; size = u64(d, i + 8); header = 16; }
    else if (size === 0) size = d.length - i;
    if (size < header || size > d.length - i) return null;
    if (type === 'uuid' && size >= header + 20 && startsWith(d, C2PA_UUID, i + header)) {
      let p = i + header + 20;
      const boxEnd = i + size;
      const purposeStart = p;
      while (p < boxEnd && d[p] !== 0) p++;
      const purpose = utf8(d, purposeStart, p - purposeStart);
      p++;
      if (purpose === 'manifest') p += 8;
      if (p < boxEnd) { const store = d.subarray(p, boxEnd); return isStore(store) ? store : null; }
    }
    i += size;
  }
  return null;
}

/** Fallback: the first "jumb" box whose description carries the c2pa label. */
function scanForStore(d) {
  let from = 0;
  for (let n = 0; n < 64; n++) {
    const at = indexOfSeq(d, JUMB, from);
    if (at < 4) return null;
    const start = at - 4;
    const len = u32(d, start);
    if (len >= 16 && len <= d.length - start) {
      const candidate = d.subarray(start, start + len);
      if (isStore(candidate)) return candidate;
    }
    from = at + 4;
  }
  return null;
}

function tree(d, box, depth) {
  if (depth > MAX_BOX_DEPTH) return { label: null, children: [], cbor: [] };
  const children = [];
  const cbor = [];
  for (const b of boxes(d, box.start, box.end).slice(1)) {
    if (b.type === 'jumb') children.push(tree(d, b, depth + 1));
    else if (b.type === 'cbor') { try { cbor.push(decodeCbor(d, b.start, b.end - b.start)); } catch { cbor.push(null); } }
  }
  return { label: labelOf(d, box), children, cbor };
}

const isMap = (v) => v != null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array);

function agentName(value) {
  let name = null;
  if (typeof value === 'string') name = value;
  else if (isMap(value)) name = [value.name, value.version].filter((x) => typeof x === 'string').join(' ');
  // eslint-disable-next-line no-control-regex
  name = name?.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, MAX_NAME);
  return name || null;
}

function generatorName(claim) {
  const v = claim.claim_generator_info;
  const info = isMap(v) ? v : Array.isArray(v) && isMap(v[0]) ? v[0] : null;
  const legacy = typeof claim.claim_generator === 'string' ? claim.claim_generator.trim() : '';
  return ((info && agentName(info)) || legacy || null)?.slice(0, MAX_NAME) ?? null;
}

export function parseStore(store) {
  const root = boxes(store, 0, store.length)[0];
  const manifests = tree(store, root, 0).children;
  if (!manifests.length) return { parsed: false, generator: null, sourceTypes: [], aiAgents: [] };
  const sourceTypes = [];
  const aiAgents = [];
  for (const manifest of manifests) {
    for (const assertion of manifest.children.filter((c) => c.label === 'c2pa.assertions').flatMap((c) => c.children)) {
      if (!assertion.label?.startsWith('c2pa.actions')) continue;
      for (const map of assertion.cbor.filter(isMap)) {
        for (const action of (Array.isArray(map.actions) ? map.actions : []).filter(isMap)) {
          const raw = action.digitalSourceType;
          const type = typeof raw === 'string' ? raw.slice(raw.lastIndexOf('/') + 1).trim() : '';
          if (!type) continue;
          if (!sourceTypes.includes(type)) sourceTypes.push(type);
          if (/AlgorithmicMedia/i.test(type)) {
            const agent = agentName(action.softwareAgent);
            if (agent && !aiAgents.includes(agent)) aiAgents.push(agent);
          }
        }
      }
    }
  }
  // The active manifest is the last one in the store.
  const claim = manifests[manifests.length - 1].children.find((c) => c.label?.startsWith('c2pa.claim'))?.cbor.find(isMap);
  return { parsed: true, generator: claim ? generatorName(claim) : null, sourceTypes, aiAgents: aiAgents.slice(0, 5) };
}

/** null: no C2PA in the file. { parsed: false }: a container was found but could not be read. */
export function readC2pa(d, format) {
  let store = null;
  if (format === 'JPEG') store = jpegStore(d);
  else if (format === 'PNG') store = pngStore(d);
  else if (format === 'WEBP') store = webpStore(d);
  else if (format === 'HEIC' || format === 'AVIF') store = isoBmffStore(d);
  store ??= scanForStore(d);
  if (!store) {
    return indexOfSeq(d, JUMB) >= 0 && indexOfSeq(d, C2PA_LABEL) >= 0 ? { parsed: false, generator: null, sourceTypes: [], aiAgents: [] } : null;
  }
  try { return parseStore(store); } catch { return { parsed: false, generator: null, sourceTypes: [], aiAgents: [] }; }
}
