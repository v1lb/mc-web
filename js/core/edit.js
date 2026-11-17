// EXIF editing for JPEG and GPS-only removal. Every result is re-read and compared before it is offered for saving.

import { FormatError } from './bytes.js';
import { parseTiff, serializeTiff, emptyTiff, asciiEntry, shortEntry, byteEntry, rationalEntry, toRational, gpsPatches, values, TAG } from './tiff.js';
import { jpegExif, sanitizeJpeg, patchJpegExif } from './jpeg.js';
import { stripPngGps } from './png.js';
import { stripWebpGps } from './webp.js';
import { stripHeifGps } from './heif.js';
import { readExif } from './exif.js';

export const MAX_SHIFT_SECONDS = 366 * 24 * 3600;
const TEXT_FIELDS = [['make', 'MAKE', TAG.MAKE], ['model', 'MODEL', TAG.MODEL], ['author', 'AUTHOR', TAG.ARTIST],
  ['copyright', 'COPYRIGHT', TAG.COPYRIGHT], ['description', 'DESCRIPTION', TAG.IMAGE_DESCRIPTION]];
const DATE_FIELDS = [['dateTaken', 'DATE_TAKEN', TAG.DATETIME_ORIGINAL], ['dateDigitized', 'DATE_DIGITIZED', TAG.DATETIME_DIGITIZED]];

/** "YYYY:MM:DD HH:MM:SS" → UTC milliseconds, or null when the value is not a real date. */
export function parseExifDate(value) {
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value ?? '');
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  if (y < 1 || mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return null;
  const t = Date.UTC(y, mo - 1, d, h, mi, s);
  const back = new Date(t);
  if (y < 100) back.setUTCFullYear(y);
  return back.getUTCMonth() === mo - 1 && back.getUTCDate() === d ? back.getTime() : null;
}

export function formatExifDate(ms) {
  const t = new Date(ms);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(t.getUTCFullYear(), 4)}:${p(t.getUTCMonth() + 1)}:${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}`;
}

/** null when the date is empty or non-standard ("0000:00:00 00:00:00"). */
export function shiftDate(value, seconds) {
  const ms = parseExifDate(String(value).trim().slice(0, 19));
  return ms == null ? null : formatExifDate(ms + seconds * 1000);
}

/** Shift from form fields: sign, hours, minutes. null when the input is invalid. */
export function shiftSeconds(negative, hours, minutes) {
  const h = Number((hours ?? '').trim() || '0');
  const m = Number((minutes ?? '').trim() || '0');
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || m < 0 || m > 59) return null;
  const total = h * 3600 + m * 60;
  if (total === 0 || total > MAX_SHIFT_SECONDS) return null;
  return negative ? -total : total;
}

export const hasChanges = (p) => !!p.removeGps || ['latitude', 'longitude', 'dateTaken', 'dateDigitized', 'make', 'model', 'author',
  'copyright', 'description', 'iso', 'aperture', 'exposureSeconds'].some((k) => p[k] != null);

/** Problems in a patch as [{ code, field }]; texts are resolved by the interface. */
export function validatePatch(p) {
  const issues = [];
  const add = (code, field) => issues.push({ code, field });
  const inRange = (v, a, b) => Number.isFinite(v) && v >= a && v <= b;
  if (p.removeGps && (p.latitude != null || p.longitude != null)) add('GPS_REMOVE_AND_SET');
  if ((p.latitude == null) !== (p.longitude == null)) add('GPS_INCOMPLETE');
  if (p.latitude != null && !inRange(p.latitude, -90, 90)) add('LATITUDE_RANGE');
  if (p.longitude != null && !inRange(p.longitude, -180, 180)) add('LONGITUDE_RANGE');
  if (p.iso != null && !(Number.isInteger(p.iso) && p.iso >= 1 && p.iso <= 204800)) add('ISO_RANGE');
  if (p.aperture != null && !inRange(p.aperture, 0.5, 128)) add('APERTURE_RANGE');
  if (p.exposureSeconds != null && !inRange(p.exposureSeconds, 0.000001, 3600)) add('EXPOSURE_RANGE');
  for (const [key, field] of TEXT_FIELDS) {
    const v = p[key];
    if (v == null) continue;
    // eslint-disable-next-line no-control-regex
    if (v.length > 512 || /[\u0000-\u0008\u000b-\u001f]/.test(v)) add('TEXT_INVALID', field);
    // Text tags of EXIF are stored as ASCII.
    else if (/[^\u0000-~]/.test(v)) add('TEXT_NOT_ASCII', field);
  }
  for (const [key, field] of DATE_FIELDS) if (p[key] != null && parseExifDate(p[key]) == null) add('DATE_FORMAT', field);
  if (!hasChanges(p)) add('NO_CHANGES');
  return issues;
}

function dmsEntry(value, little) {
  const abs = Math.abs(value);
  const deg = Math.floor(abs);
  const minFloat = (abs - deg) * 60;
  const min = Math.floor(minFloat);
  const sec = Math.round((minFloat - min) * 60 * 10000);
  return rationalEntry([[deg, 1], [min, 1], [sec, 10000]], little);
}

function tiffOf(d) {
  const bytes = jpegExif(d);
  if (!bytes) return emptyTiff();
  try { return parseTiff(bytes); } catch { return emptyTiff(); }
}

function exifIfd(t) {
  if (!t.exif) {
    t.exif = new Map();
    t.exif.set(0x9000, { type: 7, count: 4, data: Uint8Array.of(0x30, 0x32, 0x33, 0x32) });
  }
  return t.exif;
}

function requireJpeg(d) {
  if (!(d[0] === 0xFF && d[1] === 0xD8)) throw new FormatError('EDIT_JPEG_ONLY');
}

/**
 * Returns a new JPEG with the patch applied. XMP, IPTC, comments, MPF frames and everything after the picture
 * are dropped: they would keep the old coordinates and dates next to the new ones.
 */
export function applyPatch(d, patch) {
  requireJpeg(d);
  const issues = validatePatch(patch);
  if (issues.length) { const e = new FormatError('INVALID_PATCH'); e.issues = issues; throw e; }
  const t = tiffOf(d);
  if (patch.removeGps) t.gps = null;
  if (patch.latitude != null) {
    // A fresh table: the altitude, time and direction of the old place must not stay next to the new point.
    t.gps = new Map();
    t.gps.set(TAG.GPS_VERSION, byteEntry([2, 3, 0, 0]));
    t.gps.set(TAG.GPS_LAT_REF, asciiEntry(patch.latitude < 0 ? 'S' : 'N'));
    t.gps.set(TAG.GPS_LAT, dmsEntry(patch.latitude, t.little));
    t.gps.set(TAG.GPS_LON_REF, asciiEntry(patch.longitude < 0 ? 'W' : 'E'));
    t.gps.set(TAG.GPS_LON, dmsEntry(patch.longitude, t.little));
  }
  for (const [key, , tag] of TEXT_FIELDS) if (patch[key] != null) t.ifd0.set(tag, asciiEntry(patch[key]));
  for (const [key, , tag] of DATE_FIELDS) if (patch[key] != null) exifIfd(t).set(tag, asciiEntry(patch[key]));
  if (patch.iso != null) {
    const data = new Uint8Array(4);
    new DataView(data.buffer).setUint32(0, patch.iso, t.little);
    exifIfd(t).set(TAG.ISO, patch.iso <= 0xFFFF ? shortEntry(patch.iso, t.little) : { type: 4, count: 1, data });
  }
  if (patch.aperture != null) exifIfd(t).set(TAG.F_NUMBER, rationalEntry([toRational(patch.aperture)], t.little));
  if (patch.exposureSeconds != null) exifIfd(t).set(TAG.EXPOSURE_TIME, rationalEntry([toRational(patch.exposureSeconds)], t.little));
  const out = sanitizeJpeg(d, serializeTiff(t));
  return { bytes: out, verified: verifyPatch(out, patch) };
}

function fieldOf(exif, key) {
  for (const s of exif.sections) for (const i of s.items) if (i.key === key) return i.value;
  return null;
}

function verifyPatch(out, p) {
  const exif = readExif(out, 'JPEG');
  const near = (a, b, eps) => a != null && Math.abs(Number(a) - b) <= eps;
  if (p.removeGps && (exif.gps || exif.sections.some((s) => s.key === 'GPS'))) return false;
  if (p.latitude != null && !(exif.gps && near(exif.gps.latitude, p.latitude, 1e-5) && near(exif.gps.longitude, p.longitude, 1e-5))) return false;
  const text = { make: 'exif:Make', model: 'exif:Model', author: 'exif:Artist', copyright: 'exif:Copyright', description: 'exif:ImageDescription',
    dateTaken: 'exif:DateTimeOriginal', dateDigitized: 'exif:DateTimeDigitized' };
  for (const [key, exifKey] of Object.entries(text)) {
    if (p[key] != null && (fieldOf(exif, exifKey) ?? '') !== p[key].trim()) return false;
  }
  if (p.iso != null && Number(fieldOf(exif, 'exif:PhotographicSensitivity')) !== p.iso) return false;
  if (p.aperture != null && !near(fieldOf(exif, 'exif:FNumber'), p.aperture, 1e-3 * p.aperture)) return false;
  if (p.exposureSeconds != null && !near(fieldOf(exif, 'exif:ExposureTime'), p.exposureSeconds, 1e-3 * p.exposureSeconds)) return false;
  return true;
}

/** Shifts the capture dates of a JPEG. Throws NO_DATE_TO_SHIFT when the photo has no date taken. */
export function shiftJpegDates(d, seconds) {
  requireJpeg(d);
  const t = tiffOf(d);
  const shiftIn = (map, tag) => {
    const e = map?.get(tag);
    const next = e && e.type === 2 ? shiftDate(values(e, t.little), seconds) : null;
    if (next) map.set(tag, asciiEntry(next));
    return next;
  };
  const taken = shiftIn(t.exif, TAG.DATETIME_ORIGINAL);
  if (!taken) throw new FormatError('NO_DATE_TO_SHIFT');
  shiftIn(t.exif, TAG.DATETIME_DIGITIZED);
  shiftIn(t.ifd0, TAG.DATETIME);
  const out = sanitizeJpeg(d, serializeTiff(t));
  return { bytes: out, verified: fieldOf(readExif(out, 'JPEG'), 'exif:DateTimeOriginal') === taken };
}

function patched(tiffBytes) {
  const out = tiffBytes.slice();
  for (const [at, bytes] of gpsPatches(tiffBytes)) out.set(bytes, at);
  return out;
}

/**
 * "Remove GPS only": the GPS table in EXIF is emptied in place (date, camera and settings stay), XMP and other
 * blocks that may repeat the coordinates are dropped. Supports JPEG, PNG, WebP, HEIC and AVIF.
 */
export function wipeGps(d, format) {
  let out;
  if (format === 'JPEG') {
    const tiff = jpegExif(d);
    out = sanitizeJpeg(tiff ? patchJpegExif(d, gpsPatches(tiff)) : d);
  } else if (format === 'PNG') out = stripPngGps(d, patched);
  else if (format === 'WEBP') out = stripWebpGps(d, patched);
  else if (format === 'HEIC' || format === 'AVIF') out = stripHeifGps(d);
  else throw new FormatError('WIPE_GPS_UNSUPPORTED');
  const exif = readExif(out, format);
  const verified = !exif.gps && !exif.sections.some((s) => s.key === 'GPS');
  if (!verified) throw new FormatError('GPS_NOT_REMOVED');
  return { bytes: out, verified };
}

/** Editor values that can be copied from another photo: { make, model, dateTaken, … } as strings. */
export function editableFields(exif) {
  const pick = (key) => fieldOf(exif, key);
  const out = {
    make: pick('exif:Make'), model: pick('exif:Model'), author: pick('exif:Artist'), copyright: pick('exif:Copyright'),
    description: pick('exif:ImageDescription'), dateTaken: pick('exif:DateTimeOriginal'), dateDigitized: pick('exif:DateTimeDigitized'),
    iso: pick('exif:PhotographicSensitivity'), aperture: pick('exif:FNumber'), exposureSeconds: pick('exif:ExposureTime'),
    latitude: exif.gps ? String(Number(exif.gps.latitude.toFixed(6))) : null,
    longitude: exif.gps ? String(Number(exif.gps.longitude.toFixed(6))) : null,
  };
  for (const k of Object.keys(out)) if (out[k] == null) delete out[k];
  return out;
}
