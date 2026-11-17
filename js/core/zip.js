// Minimal ZIP writer (stored, no compression): photos and videos are already compressed.

import { crc32, utf8Bytes, concat } from './bytes.js';

function dosTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return [time, day];
}

/** entries: [{ name, bytes: Uint8Array }]. Names must be unique. Returns a Blob. */
export function zipBlob(entries, date = new Date()) {
  const [time, day] = dosTime(date);
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, bytes } of entries) {
    const nameBytes = utf8Bytes(name);
    const crc = crc32(bytes);
    const local = new Uint8Array(30);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034B50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, 0, true);
    lv.setUint16(10, time, true); lv.setUint16(12, day, true); lv.setUint32(14, crc, true);
    lv.setUint32(18, bytes.length, true); lv.setUint32(22, bytes.length, true); lv.setUint16(26, nameBytes.length, true);
    const dir = new Uint8Array(46);
    const dv = new DataView(dir.buffer);
    dv.setUint32(0, 0x02014B50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 20, true); dv.setUint16(8, 0x0800, true);
    dv.setUint16(12, time, true); dv.setUint16(14, day, true); dv.setUint32(16, crc, true);
    dv.setUint32(20, bytes.length, true); dv.setUint32(24, bytes.length, true); dv.setUint16(28, nameBytes.length, true);
    dv.setUint32(42, offset, true);
    parts.push(local, nameBytes, bytes);
    central.push(dir, nameBytes);
    offset += 30 + nameBytes.length + bytes.length;
  }
  const directory = concat(central);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054B50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
  ev.setUint32(12, directory.length, true); ev.setUint32(16, offset, true);
  return new Blob([...parts, directory, end], { type: 'application/zip' });
}

/** "photo.jpg" → "photo (2).jpg" when the name is already taken. */
export function uniqueName(name, taken) {
  if (!taken.has(name)) { taken.add(name); return name; }
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})${ext}`;
    if (!taken.has(candidate)) { taken.add(candidate); return candidate; }
  }
}
