// MP4/MOV metadata without third-party libraries: moov/udta (QuickTime ©xyz, ©mak…), moov/meta (mdta keys from
// iPhone and Android), 3GPP loci, XMP and C2PA in uuid boxes, creation time in mvhd. The file is read through
// Blob slices: headers and moov only, never the whole video.

import { u16, u32, u64, s32, latin1, utf8, utf16be, fourcc, startsWith, cleanText, FormatError } from './bytes.js';
import { C2PA_UUID } from './c2pa.js';

export const MAX_MOOV_BYTES = 64 * 1024 * 1024;
const MAX_UUID_BYTES = 16 * 1024 * 1024;
const MAX_TEXT = 500;
const MAX_BOXES = 200000;
/** Seconds between 1904-01-01 (the QuickTime epoch) and 1970-01-01. */
export const EPOCH_1904 = 2082844800;
export const XMP_UUID = Uint8Array.of(0xBE, 0x7A, 0xCF, 0xCB, 0x97, 0xA9, 0x42, 0xE8, 0x9C, 0x71, 0x99, 0x94, 0x91, 0xE3, 0xAF, 0xAC);

export async function readBlob(blob, position, length) {
  if (position < 0 || length < 0 || position + length > blob.size) throw new FormatError('MP4_EOF');
  return new Uint8Array(await blob.slice(position, position + length).arrayBuffer());
}

/** Top-level boxes. Lenient: the list ends at the first broken header (camera trailers). Returns { boxes, end }. */
export async function listTop(blob) {
  const boxes = [];
  let pos = 0;
  while (blob.size - pos >= 8) {
    const head = await readBlob(blob, pos, Math.min(16, blob.size - pos));
    let size = u32(head, 0);
    const type = fourcc(head, 4);
    let header = 8;
    if (size === 1) { if (head.length < 16) break; size = u64(head, 8); header = 16; }
    else if (size === 0) size = blob.size - pos;
    if (size < header || size > blob.size - pos) break;
    boxes.push({ type, start: pos, header, end: pos + size, size, payloadStart: pos + header, payloadSize: size - header });
    if (boxes.length > MAX_BOXES) throw new FormatError('MP4_TOO_MANY_BOXES');
    pos += size;
  }
  return { boxes, end: pos };
}

/** Boxes inside an in-memory buffer. Strict mode throws on a broken header. */
export function listBoxes(d, from, to, lenient = false) {
  const boxes = [];
  let pos = from;
  while (pos < to) {
    if (to - pos < 8) { if (lenient) break; throw new FormatError('MP4_TRAILING'); }
    let size = u32(d, pos);
    const type = fourcc(d, pos + 4);
    let header = 8;
    if (size === 1) {
      if (to - pos < 16) { if (lenient) break; throw new FormatError('MP4_LARGESIZE'); }
      size = u64(d, pos + 8); header = 16;
    } else if (size === 0) size = to - pos;
    if (size < header || size > to - pos) { if (lenient) break; throw new FormatError('MP4_BOX_SIZE', type); }
    boxes.push({ type, start: pos, header, end: pos + size, size, payloadStart: pos + header, payloadSize: size - header });
    if (boxes.length > MAX_BOXES) throw new FormatError('MP4_TOO_MANY_BOXES');
    pos += size;
  }
  return boxes;
}

export const children = (d, box, skip = 0) => listBoxes(d, box.payloadStart + skip, box.end);

const FIELD = {
  MAKE: ['exif:Make', 'CAMERA'], MODEL: ['exif:Model', 'CAMERA'], DATE_TAKEN: ['exif:DateTimeOriginal', 'DATES'],
  LOCATION: ['video:location', 'GPS'], SOFTWARE: ['exif:Software', 'AUTHORSHIP'], ARTIST: ['exif:Artist', 'AUTHORSHIP'],
  COPYRIGHT: ['exif:Copyright', 'AUTHORSHIP'], TITLE: ['video:title', 'AUTHORSHIP'], DESCRIPTION: ['exif:ImageDescription', 'AUTHORSHIP'],
};

/** QuickTime/iTunes tag names and mdta keys → report field. */
const NAMES = {
  '©mak': 'MAKE', 'com.apple.quicktime.make': 'MAKE', 'com.android.manufacturer': 'MAKE',
  '©mod': 'MODEL', 'com.apple.quicktime.model': 'MODEL', 'com.android.model': 'MODEL',
  '©day': 'DATE_TAKEN', 'com.apple.quicktime.creationdate': 'DATE_TAKEN',
  '©xyz': 'LOCATION', 'com.apple.quicktime.location.ISO6709': 'LOCATION',
  '©swr': 'SOFTWARE', '©too': 'SOFTWARE', '©enc': 'SOFTWARE', 'com.apple.quicktime.software': 'SOFTWARE', encoder: 'SOFTWARE',
  '©ART': 'ARTIST', '©aut': 'ARTIST', auth: 'ARTIST', 'com.apple.quicktime.author': 'ARTIST', 'com.apple.quicktime.artist': 'ARTIST',
  '©cpy': 'COPYRIGHT', cprt: 'COPYRIGHT', 'com.apple.quicktime.copyright': 'COPYRIGHT',
  '©nam': 'TITLE', titl: 'TITLE', 'com.apple.quicktime.title': 'TITLE',
  '©des': 'DESCRIPTION', '©cmt': 'DESCRIPTION', '©inf': 'DESCRIPTION', dscp: 'DESCRIPTION', desc: 'DESCRIPTION',
  'com.apple.quicktime.description': 'DESCRIPTION', 'com.apple.quicktime.comment': 'DESCRIPTION',
};

const clean = (raw) => cleanText(raw, MAX_TEXT);
const validPoint = (lat, lon) => lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180 && !(lat === 0 && lon === 0);

function degrees(value, degreeDigits) {
  const sign = value[0] === '-' ? -1 : 1;
  const body = value.slice(1);
  const dot = body.indexOf('.');
  const intLen = dot < 0 ? body.length : dot;
  const number = Number(body);
  if (!Number.isFinite(number)) return null;
  let result;
  if (intLen === degreeDigits) result = number;
  else if (intLen === degreeDigits + 2) {
    const deg = Number(body.slice(0, degreeDigits));
    result = deg + (number - deg * 100) / 60;
  } else if (intLen === degreeDigits + 4) {
    const deg = Number(body.slice(0, degreeDigits));
    const min = Number(body.slice(degreeDigits, degreeDigits + 2));
    result = deg + min / 60 + (number - deg * 10000 - min * 100) / 3600;
  } else return null;
  return sign * result;
}

/** ISO 6709 from phones: "+41.8902+012.4923+050.000/". Degree-minute forms from some cameras are supported too. */
export function parseIso6709(text) {
  const m = /^([+-][0-9]+(?:\.[0-9]+)?)([+-][0-9]+(?:\.[0-9]+)?)([+-][0-9]+(?:\.[0-9]+)?)?/.exec(text.trim());
  if (!m) return null;
  const lat = degrees(m[1], 2);
  const lon = degrees(m[2], 3);
  if (lat == null || lon == null || !validPoint(lat, lon)) return null;
  const alt = m[3] != null && Number.isFinite(Number(m[3])) ? Number(m[3]) : null;
  return { latitude: lat, longitude: lon, altitudeMeters: alt };
}

export function formatDuration(seconds) {
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const two = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/** Collects tags by section without repeats. */
class Collector {
  constructor() { this.bySection = new Map(); this.tool = []; this.freeText = []; this.gps = null; }
  add(section, item) {
    if (!this.bySection.has(section)) this.bySection.set(section, new Map());
    const id = `${item.key ?? item.label}=${item.value}`;
    if (!this.bySection.get(section).has(id)) this.bySection.get(section).set(id, item);
  }
  items(section) { return [...(this.bySection.get(section)?.values() ?? [])]; }
  named(name, value) {
    const field = NAMES[name];
    if (!field) { this.raw(name, value); return; }
    if (field === 'LOCATION') { this.location(value, parseIso6709(value)); return; }
    const [key, section] = FIELD[field];
    this.add(section, { label: name, value, key });
    const label = `MP4 ${name}`;
    if (field === 'SOFTWARE') this.tool.push({ label, value });
    if (field === 'DESCRIPTION' || field === 'TITLE' || field === 'ARTIST') this.freeText.push({ label, value });
  }
  location(text, point) {
    this.add('GPS', { label: 'Location', value: text.slice(0, MAX_TEXT), key: 'video:location' });
    if (!this.gps && point && validPoint(point.latitude, point.longitude)) this.gps = point;
  }
  raw(label, value) { this.add('CONTAINER', { label: label.slice(0, 120), value }); }
  rawBytes(label, bytes) { this.add('CONTAINER', { label: label.slice(0, 120), value: String(bytes), format: 'BYTES' }); }
}

/** Value of a "data" box: type (1 UTF-8, 2 UTF-16, 21/22 integer, 23/24 float), locale, data. */
function dataValue(d, box) {
  if (box.payloadSize < 8 || box.payloadSize > MAX_UUID_BYTES) return null;
  const p = d.subarray(box.payloadStart, box.end);
  const type = u32(p, 0) & 0xFFFFFF;
  const len = p.length - 8;
  const view = new DataView(p.buffer, p.byteOffset, p.byteLength);
  switch (type) {
    case 1: case 4: return clean(utf8(p, 8, len));
    case 2: case 5: return clean(utf16be(p, 8, len));
    case 21: case 22:
      if (len === 1) return String(type === 21 ? view.getInt8(8) : p[8]);
      if (len === 2) return String(type === 21 ? view.getInt16(8) : u16(p, 8));
      if (len === 4) return String(type === 21 ? s32(p, 8) : u32(p, 8));
      if (len === 8) return String(view.getBigInt64(8));
      return null;
    case 23: return len === 4 ? String(view.getFloat32(8)) : null;
    case 24: return len === 8 ? String(view.getFloat64(8)) : null;
    case 0: return clean(utf8(p, 8, len));
    default: return null;
  }
}

/** QuickTime tag text: [length u16][language u16][text], or a nested "data" box (iTunes style). */
function quickTimeText(d, box) {
  const p = d.subarray(box.payloadStart, box.end);
  if (p.length >= 16 && fourcc(p, 4) === 'data') {
    const data = listBoxes(d, box.payloadStart, box.end, true).find((b) => b.type === 'data');
    return data ? dataValue(d, data) : null;
  }
  if (p.length < 4) return null;
  const len = u16(p, 0);
  if (len === 0 || 4 + len > p.length) return null;
  return clean(utf8(p, 4, len));
}

/** 3GPP (titl, auth, dscp, cprt): FullBox, language u16, UTF-8 or UTF-16 with a BOM. */
function threeGppText(p) {
  if (p.length < 7) return null;
  const body = p.subarray(6);
  const text = body.length >= 2 && body[0] === 0xFE && body[1] === 0xFF ? utf16be(body, 2) : utf8(body);
  const nul = text.indexOf('\0');
  return clean(nul < 0 ? text : text.slice(0, nul));
}

/** loci: FullBox, language, place name, role, then longitude, latitude, altitude as 16.16 fixed point. */
function readLoci(p, tags) {
  if (p.length < 7) return;
  let i = 6;
  let name;
  if (p[i] === 0xFE && p[i + 1] === 0xFF) {
    let e = i + 2;
    while (e + 1 < p.length && !(p[e] === 0 && p[e + 1] === 0)) e += 2;
    name = utf16be(p, i + 2, e - i - 2); i = e + 2;
  } else {
    let e = i;
    while (e < p.length && p[e] !== 0) e++;
    name = utf8(p, i, e - i); i = e + 1;
  }
  i += 1;
  const cleaned = clean(name);
  if (cleaned) tags.raw('loci', cleaned);
  if (i + 12 > p.length) return;
  const lon = s32(p, i) / 65536, lat = s32(p, i + 4) / 65536, alt = s32(p, i + 8) / 65536;
  const sign = (n, digits) => (n < 0 ? '-' : '+') + Math.abs(n).toFixed(digits);
  tags.location(`${sign(lat, 6)}${sign(lon, 6)}${sign(alt, 1)}/`, { latitude: lat, longitude: lon, altitudeMeters: alt });
}

/** meta: QuickTime (hdlr mdta + keys + ilst) or iTunes (hdlr mdir + ilst with ©xxx). */
function readMeta(d, meta, tags) {
  // In MP4 meta is a FullBox (4 bytes of version and flags), in QuickTime a plain container.
  const skip = meta.payloadSize >= 8 && fourcc(d, meta.payloadStart + 4) === 'hdlr' ? 0 : 4;
  let kids;
  try { kids = listBoxes(d, meta.payloadStart + skip, meta.end); } catch { return; }
  const keys = [];
  const keysBox = kids.find((b) => b.type === 'keys');
  if (keysBox) {
    const p = d.subarray(keysBox.payloadStart, keysBox.end);
    if (p.length >= 8) {
      const count = u32(p, 4);
      let i = 8;
      for (let n = 0; n < count && i + 8 <= p.length; n++) {
        const size = u32(p, i);
        if (size < 8 || i + size > p.length) break;
        keys.push(utf8(p, i + 8, size - 8));
        i += size;
      }
    }
  }
  for (const box of kids) {
    if (box.type === 'ilst') {
      for (const item of listBoxes(d, box.payloadStart, box.end, true)) {
        // In a QuickTime ilst the item type is the key number (from 1), in iTunes four letters.
        const index = u32(d, item.start + 4);
        const name = keys.length && index >= 1 && index <= keys.length ? keys[index - 1] : item.type;
        const data = listBoxes(d, item.payloadStart, item.end, true).find((b) => b.type === 'data');
        const value = data ? dataValue(d, data) : null;
        if (value != null) tags.named(name, value); else tags.rawBytes(name, item.size);
      }
    } else if (!['hdlr', 'keys', 'free', 'XMP_'].includes(box.type)) tags.rawBytes(`meta ${box.type}`, box.size);
  }
}

/** udta: QuickTime tags (©xxx), 3GPP (loci, auth…), nested meta/ilst, Adobe XMP_. */
function readUdta(d, udta, tags, onXmp) {
  // Lenient: QuickTime writers end udta with a 32-bit zero terminator, which is not a box.
  const kids = listBoxes(d, udta.payloadStart, udta.end, true);
  for (const child of kids) {
    if (child.payloadSize > MAX_UUID_BYTES) { tags.rawBytes(`udta ${child.type}`, child.size); continue; }
    if (child.type === 'meta') readMeta(d, child, tags);
    else if (child.type === 'XMP_') onXmp(utf8(d, child.payloadStart, child.payloadSize));
    else if (child.type === 'loci') readLoci(d.subarray(child.payloadStart, child.end), tags);
    else if (child.type.startsWith('©') || child.type in NAMES) {
      const text = quickTimeText(d, child) ?? threeGppText(d.subarray(child.payloadStart, child.end));
      if (text != null) tags.named(child.type, text); else tags.rawBytes(`udta ${child.type}`, child.size);
    } else tags.rawBytes(`udta ${child.type}`, child.size);
  }
}

/** A moov track: id, handler (vide, soun, meta…) and the codec of the first stsd entry. */
export function trackInfo(d, trak) {
  let id = -1, width = 0, height = 0, handler = null, entry = null;
  for (const child of children(d, trak)) {
    if (child.type === 'tkhd') {
      const p = d.subarray(child.payloadStart, Math.min(child.end, child.payloadStart + 96));
      const idAt = p[0] === 1 ? 20 : 12;
      if (p.length >= idAt + 4) id = u32(p, idAt);
      // Width and height are the last 8 bytes of tkhd, 16.16 fixed point.
      if (p.length >= 8 && child.payloadSize <= 96) { width = u32(p, p.length - 8) >>> 16; height = u32(p, p.length - 4) >>> 16; }
    } else if (child.type === 'mdia') {
      for (const m of children(d, child)) {
        if (m.type === 'hdlr' && m.payloadSize >= 12) handler = fourcc(d, m.payloadStart + 8);
        else if (m.type === 'minf') {
          const stbl = children(d, m).find((b) => b.type === 'stbl');
          const stsd = stbl && children(d, stbl).find((b) => b.type === 'stsd');
          if (stsd && stsd.payloadSize >= 16) entry = fourcc(d, stsd.payloadStart + 12);
        }
      }
    }
  }
  return handler ? { box: trak, id, handler, sampleEntry: entry, width, height } : null;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
function exifDateUtc(epochSeconds) {
  const t = new Date(epochSeconds * 1000);
  return `${pad(t.getUTCFullYear(), 4)}:${pad(t.getUTCMonth() + 1)}:${pad(t.getUTCDate())} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`;
}

/** Throws FormatError when the file has no readable moov. */
export async function readVideo(blob) {
  const { boxes: top } = await listTop(blob);
  const ftyp = top.find((b) => b.type === 'ftyp');
  let format = 'MOV';
  if (ftyp) format = ftyp.payloadSize >= 4 && fourcc(await readBlob(blob, ftyp.payloadStart, 4), 0) === 'qt  ' ? 'MOV' : 'MP4';
  const moovRef = top.find((b) => b.type === 'moov');
  if (!moovRef) throw new FormatError('MP4_NO_MOOV');
  if (moovRef.size > MAX_MOOV_BYTES) throw new FormatError('MP4_MOOV_TOO_LARGE');
  const moov = await readBlob(blob, moovRef.start, moovRef.size);
  const root = { type: 'moov', start: 0, header: moovRef.header, end: moov.length, size: moov.length, payloadStart: moovRef.header, payloadSize: moov.length - moovRef.header };

  const tags = new Collector();
  let xmp = null, c2pa = null;
  const onXmp = (text) => { xmp ??= text; };
  for (const box of top) {
    if (box.type === 'uuid') {
      if (box.payloadSize >= 16 && box.size <= MAX_UUID_BYTES) {
        const bytes = await readBlob(blob, box.start, box.size);
        if (startsWith(bytes, XMP_UUID, box.header) && xmp == null) xmp = utf8(bytes, box.header + 16);
        else if (startsWith(bytes, C2PA_UUID, box.header)) c2pa = bytes;
        else tags.rawBytes('uuid', bytes.length);
      } else tags.rawBytes(box.type, box.size);
    } else if (box.type === 'meta' || box.type === 'udta') {
      const bytes = await readBlob(blob, box.start, Math.min(box.size, MAX_UUID_BYTES));
      const local = { ...box, start: 0, end: bytes.length, payloadStart: box.header, payloadSize: bytes.length - box.header };
      if (box.type === 'meta') readMeta(bytes, local, tags); else readUdta(bytes, local, tags, onXmp);
    } else if (!['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide'].includes(box.type)) tags.rawBytes(box.type, box.size);
  }

  let created = null, durationSeconds = null;
  const tracks = [];
  for (const child of children(moov, root)) {
    if (child.type === 'mvhd') {
      const p = moov.subarray(child.payloadStart, Math.min(child.end, child.payloadStart + 32));
      if (p.length >= 20) {
        const v1 = p[0] === 1 && p.length >= 32;
        const creation = v1 ? u64(p, 4) : u32(p, 4);
        const timescale = v1 ? u32(p, 20) : u32(p, 12);
        const duration = v1 ? u64(p, 24) : u32(p, 16);
        if (creation > EPOCH_1904) created = creation - EPOCH_1904;
        if (timescale > 0 && duration >= 1 && duration < 2 ** 52) durationSeconds = duration / timescale;
      }
    } else if (child.type === 'trak') {
      const track = trackInfo(moov, child);
      if (track) tracks.push(track);
      for (const sub of children(moov, child)) {
        if (sub.type === 'udta') readUdta(moov, sub, tags, onXmp);
        else if (sub.type === 'meta') readMeta(moov, sub, tags);
      }
      if (track && track.handler !== 'vide' && track.handler !== 'soun') {
        tags.rawBytes(`trak ${track.handler}${track.sampleEntry ? ` · ${track.sampleEntry}` : ''}`, child.size);
      }
    } else if (child.type === 'udta') readUdta(moov, child, tags, onXmp);
    else if (child.type === 'meta') readMeta(moov, child, tags);
    else if (child.type === 'uuid') {
      if (startsWith(moov, XMP_UUID, child.payloadStart) && xmp == null) xmp = utf8(moov, child.payloadStart + 16, child.payloadSize - 16);
      else tags.rawBytes('moov uuid', child.size);
    }
  }

  const image = [];
  const video = tracks.find((t) => t.handler === 'vide');
  if (video) {
    if (video.width > 0 && video.height > 0) {
      image.push({ label: 'ImageWidth', value: String(video.width), key: 'exif:ImageWidth' });
      image.push({ label: 'ImageLength', value: String(video.height), key: 'exif:ImageLength' });
    }
    const codec = video.sampleEntry?.trim();
    if (codec) image.push({ label: 'Codec', value: codec, key: 'video:codec' });
  }
  if (durationSeconds != null) image.push({ label: 'Duration', value: formatDuration(durationSeconds), key: 'video:duration' });
  if (created != null) tags.add('DATES', { label: 'Created', value: exifDateUtc(created), key: 'video:created' });

  const sections = [];
  if (image.length) sections.push({ title: 'IMAGE', key: 'IMAGE', items: image });
  for (const key of ['CAMERA', 'DATES', 'GPS', 'AUTHORSHIP', 'CONTAINER']) {
    const items = tags.items(key);
    if (items.length) sections.push({ title: key, key, items });
  }
  return {
    format, sections, gps: tags.gps, toolFields: tags.tool, freeTextFields: tags.freeText, xmpPacket: xmp, c2paBox: c2pa,
    moovBytes: moovRef.size,
    /** Anything besides the technical stream parameters. */
    hasPersonalData: tags.gps != null || xmp != null || c2pa != null || sections.some((s) => s.key !== 'IMAGE' && s.items.length > 0),
  };
}
