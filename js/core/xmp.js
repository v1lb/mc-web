// XMP extraction and parsing. No XML parser on purpose (no entity expansion); the scan is linear:
// every value is looked up inside a bounded window and the number of matches per field is capped.

import { ascii, indexOfSeq, utf8 } from './bytes.js';

export const MAX_PACKET = 512 * 1024;
export const KEY_SOFTWARE_AGENT = 'stEvt:softwareAgent';
export const KEY_CREATOR_TOOL = 'xmp:CreatorTool';
export const KEY_DIGITAL_SOURCE_TYPE = 'Iptc4xmpExt:DigitalSourceType';
export const XMP_KEY = 'xmp:';
export const KEY_HISTORY_AGENTS = 'xmp:history_agents';

const START = ascii('<x:xmpmeta');
const END = ascii('</x:xmpmeta>');
const MAX_ATTR_SCAN = 4 * 1024;
const MAX_ELEMENT_SCAN = 16 * 1024;
const MAX_MATCHES = 64;
const MAX_ATTEMPTS = 1024;

const KNOWN = [
  KEY_CREATOR_TOOL, 'xmp:CreateDate', 'xmp:ModifyDate', 'dc:title', 'dc:creator', 'dc:description', 'dc:rights', 'dc:subject',
  'photoshop:Headline', 'photoshop:Credit', 'photoshop:Source', 'Iptc4xmpCore:Location', 'photoshop:City', 'photoshop:State',
  'photoshop:Country', 'tiff:Make', 'tiff:Model', 'exif:GPSLatitude', 'exif:GPSLongitude', 'exif:GPSAltitude',
  KEY_DIGITAL_SOURCE_TYPE,
];

export function extractPacket(d, pngText = []) {
  const fromPng = pngText.find((e) => e.keyword === 'XML:com.adobe.xmp')?.text;
  if (fromPng && fromPng.trim()) return fromPng;
  const s = indexOfSeq(d, START);
  if (s < 0) return null;
  const e = indexOfSeq(d, END, s, Math.min(d.length, s + MAX_PACKET));
  if (e < 0) return null;
  return utf8(d, s, e + END.length - s);
}

const decode = (s) => s.replace(/\s+/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, '&').slice(0, 500);
const isNameChar = (c) => /[:_A-Za-z0-9]/.test(c);
const isSpace = (c) => c === ' ' || c === '\n' || c === '\t' || c === '\r';

function indexIn(s, needle, from, end) {
  const at = s.indexOf(needle, from);
  return at >= 0 && at + needle.length <= end ? at : -1;
}

function attributeValues(packet, name, out) {
  let from = 0, matches = 0, attempts = 0;
  while (matches < MAX_MATCHES && attempts++ < MAX_ATTEMPTS) {
    const at = packet.indexOf(name, from);
    if (at < 0) return;
    from = at + name.length;
    if (at > 0 && isNameChar(packet[at - 1])) continue;
    let i = from;
    while (i < packet.length && isSpace(packet[i])) i++;
    if (packet[i] !== '=') continue;
    i++;
    while (i < packet.length && isSpace(packet[i])) i++;
    if (packet[i] !== '"') continue;
    const start = i + 1;
    const end = indexIn(packet, '"', start, Math.min(packet.length, start + MAX_ATTR_SCAN));
    if (end < 0) continue;
    matches++;
    const value = decode(packet.substring(start, end));
    if (value.trim()) out.push(value);
    from = end + 1;
  }
}

function innerTexts(s, start, end) {
  const parts = [];
  let i = start, chunk = start;
  while (i < end) {
    if (s[i] === '<') {
      if (i > chunk) parts.push(s.substring(chunk, i));
      const gt = indexIn(s, '>', i + 1, end);
      if (gt < 0) { chunk = end; break; }
      i = gt + 1; chunk = i;
    } else i++;
  }
  if (chunk < end) parts.push(s.substring(chunk, end));
  return parts.map((p) => decode(p).trim()).filter(Boolean).join(', ');
}

function elementValues(packet, name, out) {
  const open = `<${name}`, close = `</${name}>`;
  let from = 0, matches = 0, attempts = 0;
  while (matches < MAX_MATCHES && attempts++ < MAX_ATTEMPTS) {
    const at = packet.indexOf(open, from);
    if (at < 0) return;
    from = at + open.length;
    const next = packet[from];
    if (next === undefined) return;
    if (next !== '>' && !isSpace(next)) continue;
    const windowEnd = Math.min(packet.length, from + MAX_ELEMENT_SCAN);
    const tagEnd = indexIn(packet, '>', from, windowEnd);
    if (tagEnd < 0 || packet[tagEnd - 1] === '/') continue;
    const closeAt = indexIn(packet, close, tagEnd + 1, windowEnd);
    if (closeAt < 0) continue;
    matches++;
    const text = innerTexts(packet, tagEnd + 1, closeAt);
    if (text.trim()) out.push(text);
    from = closeAt + close.length;
  }
}

export function valuesOf(packet, name) {
  const out = [];
  attributeValues(packet, name, out);
  elementValues(packet, name, out);
  return out;
}

/** { items: report fields in display order, fields: name → value for the signal engine }. */
export function parseXmp(packet) {
  const fields = {};
  const items = [];
  for (const name of KNOWN) {
    const value = valuesOf(packet, name)[0];
    if (value == null) continue;
    fields[name] = value;
    items.push({ label: name, value, key: XMP_KEY + name });
  }
  const agents = [...new Set(valuesOf(packet, KEY_SOFTWARE_AGENT))].slice(0, 10);
  if (agents.length) {
    fields[KEY_SOFTWARE_AGENT] = agents.join(', ');
    items.push({ label: KEY_SOFTWARE_AGENT, value: agents.join(', '), key: KEY_HISTORY_AGENTS });
  }
  return { items, fields };
}
