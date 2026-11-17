// MP4/MOV cleaning without re-encoding: video and audio are copied byte for byte, only the file description changes.
//
// Removed: udta and meta tags at every level (©xyz location, phone model, software, author, iPhone keys); uuid boxes
// (XMP, C2PA) and every other top-level box except ftyp, moov and mdat; tracks other than video and audio (timecode,
// metadata tracks with GPS), whose data in mdat is replaced by zeros; creation and modification times in mvhd,
// tkhd and mdhd. Chunk offsets (stco/co64) are recomputed for the new mdat position.
// Fragmented and encrypted files are not supported: FormatError.

import { u32, u64, putU32, putU64, ascii, FormatError } from './bytes.js';
import { listTop, listBoxes, children, readBlob, trackInfo, readVideo, MAX_MOOV_BYTES } from './mp4.js';

const KEEP_TOP = new Set(['ftyp', 'moov', 'mdat']);
export const KEEP_HANDLERS = new Set(['vide', 'soun', 'auxv']);
const MOOV_KEEP = new Set(['mvhd', 'trak', 'iods']);
const TRAK_KEEP = new Set(['tkhd', 'edts', 'tref', 'mdia', 'tapt', 'load', 'clip', 'matt']);
const MDIA_KEEP = new Set(['mdhd', 'hdlr', 'minf', 'elng']);
const ALWAYS_DROP = new Set(['udta', 'meta', 'uuid', 'free', 'skip', 'wide', 'XMP_']);
const ZERO_CHUNK = new Uint8Array(1 << 20);

const fail = (reason) => { throw new FormatError('VIDEO_UNSUPPORTED', reason); };
const raw = (bytes) => ({ bytes, size: bytes.length });
const container = (type, kids) => ({ type, kids, size: 8 + kids.reduce((s, k) => s + k.size, 0) });
const boxBytes = (m, box) => m.slice(box.start, box.end);

/** Creation and modification times: 4 bytes each in version 0, 8 bytes each in version 1. */
function zeroTimes(box, header) {
  if (box.length < header + 4) fail('short header box');
  const v1 = box[header] === 1;
  if (box.length < header + 4 + (v1 ? 16 : 8)) fail('short header box');
  box.fill(0, header + 4, header + 4 + (v1 ? 16 : 8));
  return box;
}

function timesZero(m, box) {
  const p = m.subarray(box.payloadStart, Math.min(box.end, box.payloadStart + 20));
  if (!p.length) return false;
  return p[0] === 1 ? p.length >= 20 && u64(p, 4) === 0 && u64(p, 12) === 0 : p.length >= 12 && u32(p, 4) === 0 && u32(p, 8) === 0;
}

function readOffsets(type, p) {
  if (p.length < 8) fail(`short ${type}`);
  const count = u32(p, 4);
  const width = type === 'co64' ? 8 : 4;
  if (count > (p.length - 8) / width) fail(`bad ${type} count`);
  const out = new Array(count);
  for (let i = 0; i < count; i++) out[i] = width === 8 ? u64(p, 8 + i * 8) : u32(p, 8 + i * 4);
  return out;
}

function stblOf(m, trak) {
  const mdia = children(m, trak).find((b) => b.type === 'mdia');
  const minf = mdia && children(m, mdia).find((b) => b.type === 'minf');
  return minf && children(m, minf).find((b) => b.type === 'stbl');
}

function chunkOffsets(m, trak) {
  const table = stblOf(m, trak);
  const box = table && children(m, table).find((b) => b.type === 'stco' || b.type === 'co64');
  return box ? readOffsets(box.type, m.subarray(box.payloadStart, box.end)) : [];
}

/** Byte ranges [start, end) of a track's chunks from stco/co64, stsc and stsz. */
function chunkRanges(m, trak) {
  const table = stblOf(m, trak);
  if (!table) return [];
  const boxes = new Map(children(m, table).map((b) => [b.type, b]));
  const offsets = chunkOffsets(m, trak);
  if (!offsets.length) return [];
  if (boxes.has('stz2')) fail('stz2');
  const stsz = boxes.get('stsz') ?? fail('no stsz');
  const stsc = boxes.get('stsc') ?? fail('no stsc');
  const sz = m.subarray(stsz.payloadStart, stsz.end);
  const sc = m.subarray(stsc.payloadStart, stsc.end);
  if (sz.length < 12 || sc.length < 8) fail('short tables');
  const fixed = u32(sz, 4);
  const samples = u32(sz, 8);
  if (fixed === 0 && samples > (sz.length - 12) / 4) fail('bad stsz');
  const entries = u32(sc, 4);
  if (entries > (sc.length - 8) / 12) fail('bad stsc');
  const ranges = [];
  let sample = 0;
  for (let e = 0; e < entries; e++) {
    const first = u32(sc, 8 + e * 12);
    const perChunk = u32(sc, 12 + e * 12);
    const next = e + 1 < entries ? u32(sc, 8 + (e + 1) * 12) : offsets.length + 1;
    if (first < 1 || next <= first) fail('bad stsc order');
    for (let chunk = first; chunk < next && chunk <= offsets.length; chunk++) {
      let length = 0;
      for (let i = 0; i < perChunk; i++) {
        if (sample >= samples) fail('sample count');
        length += fixed !== 0 ? fixed : u32(sz, 12 + sample * 4);
        sample++;
      }
      const start = offsets[chunk - 1];
      if (length > 0) ranges.push([start, start + length]);
    }
  }
  return ranges;
}

function merge(ranges) {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else out.push([...r]);
  }
  return out;
}

function cleanStbl(m, stbl) {
  return container('stbl', children(m, stbl).flatMap((box) => {
    if (ALWAYS_DROP.has(box.type)) return [];
    // Encryption auxiliary data points into mdat with absolute offsets: not recomputed.
    if (box.type === 'saio' || box.type === 'saiz') fail('sample auxiliary info');
    if (box.type === 'stco' || box.type === 'co64') {
      const p = m.subarray(box.payloadStart, box.end);
      const offsets = readOffsets(box.type, p);
      const width = box.type === 'co64' ? 8 : 4;
      return [{ offsetsType: box.type, versionFlags: u32(p, 0), offsets, width, size: 16 + offsets.length * width }];
    }
    return [raw(boxBytes(m, box))];
  }));
}

function cleanMdia(m, mdia) {
  return container('mdia', children(m, mdia).flatMap((box) => {
    if (box.type === 'mdhd') return [raw(zeroTimes(boxBytes(m, box), box.header))];
    if (box.type === 'minf') {
      return [container('minf', children(m, box).flatMap((mi) => {
        if (ALWAYS_DROP.has(mi.type)) return [];
        return [mi.type === 'stbl' ? cleanStbl(m, mi) : raw(boxBytes(m, mi))];
      }))];
    }
    return MDIA_KEEP.has(box.type) ? [raw(boxBytes(m, box))] : [];
  }));
}

/** tref: references to kept tracks only; an empty tref is removed. */
function cleanTref(m, tref, keptIds) {
  const refs = children(m, tref).flatMap((ref) => {
    const ids = [];
    for (let i = ref.payloadStart; i + 4 <= ref.end; i += 4) if (keptIds.has(u32(m, i))) ids.push(u32(m, i));
    if (!ids.length) return [];
    const b = new Uint8Array(8 + ids.length * 4);
    putU32(b, 0, b.length);
    b.set(ascii(ref.type), 4);
    ids.forEach((id, i) => putU32(b, 8 + i * 4, id));
    return [raw(b)];
  });
  return refs.length ? [container('tref', refs)] : [];
}

function cleanTrak(m, trak, keptIds) {
  return container('trak', children(m, trak).flatMap((box) => {
    if (box.type === 'tkhd') return [raw(zeroTimes(boxBytes(m, box), box.header))];
    if (box.type === 'mdia') return [cleanMdia(m, box)];
    if (box.type === 'tref') return cleanTref(m, box, keptIds);
    return TRAK_KEEP.has(box.type) ? [raw(boxBytes(m, box))] : [];
  }));
}

function visit(node, action) {
  action(node);
  node.kids?.forEach((k) => visit(k, action));
}

function serialize(node, out, at) {
  if (node.bytes) { out.set(node.bytes, at); return at + node.size; }
  putU32(out, at, node.size);
  if (node.offsets) {
    out.set(ascii(node.offsetsType), at + 4);
    putU32(out, at + 8, node.versionFlags);
    putU32(out, at + 12, node.offsets.length);
    let p = at + 16;
    for (const o of node.offsets) { if (node.width === 8) putU64(out, p, o); else putU32(out, p, o); p += node.width; }
    return p;
  }
  out.set(ascii(node.type), at + 4);
  let p = at + 8;
  for (const k of node.kids) p = serialize(k, out, p);
  return p;
}

/**
 * Prepares the cleaned file. Everything is validated before the first byte is produced.
 * Returns { blob, outputBytes, removedTracks, zeroedBytes }; the blob is built from slices of the source,
 * so even a multi-gigabyte video is not loaded into memory.
 */
export async function cleanVideo(source, mime = 'video/mp4') {
  // The unrecognized tail of the file (camera trailers) is not copied at all.
  const { boxes: all } = await listTop(source);
  if (all.some((b) => ['moof', 'mfra', 'sidx', 'styp'].includes(b.type))) fail('fragmented');
  const moovs = all.filter((b) => b.type === 'moov');
  if (moovs.length !== 1) fail(`moov count ${moovs.length}`);
  const moovRef = moovs[0];
  if (moovRef.size > MAX_MOOV_BYTES) fail('moov too large');
  const top = all.filter((b) => KEEP_TOP.has(b.type));
  const mdats = top.filter((b) => b.type === 'mdat');
  if (!mdats.length) fail('no mdat');

  const m = await readBlob(source, moovRef.start, moovRef.size);
  const root = { start: 0, header: moovRef.header, end: m.length, payloadStart: moovRef.header };
  let moovChildren;
  try { moovChildren = children(m, root); } catch (e) { fail(e.message); }
  if (moovChildren.some((b) => b.type === 'mvex' || b.type === 'cmov')) fail('fragmented or compressed moov');

  let moov, zero, removedTracks;
  try {
    const tracks = moovChildren.filter((b) => b.type === 'trak').map((trak) => trackInfo(m, trak) ?? fail('track without handler'));
    const kept = tracks.filter((t) => KEEP_HANDLERS.has(t.handler));
    if (!kept.length) fail('no audio or video tracks');
    const keptIds = new Set(kept.map((t) => t.id));
    // Data of removed tracks (GPS, timecode) is overwritten with zeros. A kept track's chunk starting inside such
    // a range means the tables contradict each other: not worth the risk.
    const keptStarts = kept.flatMap((t) => chunkOffsets(m, t.box)).sort((a, b) => a - b);
    zero = merge(tracks.filter((t) => !KEEP_HANDLERS.has(t.handler)).flatMap((t) => chunkRanges(m, t.box)));
    for (const [from, to] of zero) if (keptStarts.some((s) => s >= from && s < to)) fail('overlapping tracks');
    removedTracks = tracks.length - kept.length;
    moov = container('moov', moovChildren.flatMap((box) => {
      if (box.type === 'mvhd') return [raw(zeroTimes(boxBytes(m, box), box.header))];
      if (box.type === 'iods') return [raw(boxBytes(m, box))];
      if (box.type === 'trak') {
        const info = tracks.find((t) => t.box === box);
        return KEEP_HANDLERS.has(info.handler) ? [cleanTrak(m, box, keptIds)] : [];
      }
      return [];
    }));
  } catch (e) {
    if (e instanceof FormatError && e.code === 'VIDEO_UNSUPPORTED') throw e;
    fail(e.message);
  }
  if (moov.size > 0xFFFFFFFF) fail('moov too large');

  // New chunk offsets: each must lie inside one of the kept mdat boxes.
  const newStart = new Map();
  let pos = 0;
  for (const box of top) { newStart.set(box, pos); pos += box === moovRef ? moov.size : box.size; }
  visit(moov, (node) => {
    if (!node.offsets) return;
    node.offsets = node.offsets.map((old) => {
      // An empty chunk may point exactly at the end of mdat.
      const mdat = mdats.find((b) => old >= b.payloadStart && old <= b.end) ?? fail('chunk outside mdat');
      const moved = newStart.get(mdat) + (old - mdat.start);
      if (node.offsetsType === 'stco' && moved > 0xFFFFFFFF) fail('offset overflow');
      return moved;
    });
  });

  const moovBytes = new Uint8Array(moov.size);
  serialize(moov, moovBytes, 0);
  const parts = [];
  let zeroedBytes = 0;
  for (const box of top) {
    if (box === moovRef) { parts.push(moovBytes); continue; }
    if (box.type !== 'mdat') { parts.push(source.slice(box.start, box.end)); continue; }
    let at = box.start;
    for (const [from, to] of zero) {
      const a = Math.max(from, box.payloadStart), b = Math.min(to, box.end);
      if (a >= b) continue;
      if (a > at) parts.push(source.slice(at, a));
      for (let left = b - a; left > 0; left -= ZERO_CHUNK.length) parts.push(left >= ZERO_CHUNK.length ? ZERO_CHUNK : ZERO_CHUNK.subarray(0, left));
      zeroedBytes += b - a;
      at = b;
    }
    if (at < box.end) parts.push(source.slice(at, box.end));
  }
  const blob = new Blob(parts, { type: mime });
  if (blob.size !== pos) fail('size mismatch');
  return { blob, outputBytes: pos, removedTracks, zeroedBytes };
}

function structureClean(m, root) {
  for (const child of children(m, root)) {
    if (!MOOV_KEEP.has(child.type)) return false;
    if (child.type === 'mvhd' && !timesZero(m, child)) return false;
    if (child.type !== 'trak') continue;
    const info = trackInfo(m, child);
    if (!info || !KEEP_HANDLERS.has(info.handler)) return false;
    for (const t of children(m, child)) {
      if (!TRAK_KEEP.has(t.type)) return false;
      if (t.type === 'tkhd' && !timesZero(m, t)) return false;
      if (t.type !== 'mdia') continue;
      for (const md of children(m, t)) {
        if (!MDIA_KEEP.has(md.type)) return false;
        if (md.type === 'mdhd' && !timesZero(m, md)) return false;
        if (md.type !== 'minf') continue;
        for (const mi of children(m, md)) {
          if (ALWAYS_DROP.has(mi.type)) return false;
          if (mi.type === 'stbl' && children(m, mi).some((b) => ALWAYS_DROP.has(b.type))) return false;
        }
      }
    }
  }
  return true;
}

/**
 * Independent check of the finished file: only ftyp/moov/mdat, no tags or extra tracks in moov, creation time
 * zeroed, and the metadata reader finds nothing personal.
 */
export async function isCleanVideo(blob) {
  try {
    const { boxes: top, end } = await listTop(blob);
    const moovs = top.filter((b) => b.type === 'moov');
    if (end !== blob.size || top.some((b) => !KEEP_TOP.has(b.type)) || moovs.length !== 1 || moovs[0].size > MAX_MOOV_BYTES) return false;
    const m = await readBlob(blob, moovs[0].start, moovs[0].size);
    const root = { start: 0, header: moovs[0].header, end: m.length, payloadStart: moovs[0].header };
    return structureClean(m, root) && !(await readVideo(blob)).hasPersonalData;
  } catch { return false; }
}
