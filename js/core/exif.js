// EXIF reading: finds the TIFF block in each container and turns known tags into report fields.
// Labels are resolved by the interface from the stable key "exif:<TagName>".

import { ascii, indexOfSeq, latin1, utf8, cleanText } from './bytes.js';
import { parseTiff, values, numberOf } from './tiff.js';
import { jpegExif } from './jpeg.js';
import { pngExif } from './png.js';
import { webpExif } from './webp.js';
import { heifExif } from './heif.js';

export const EXIF_KEY = 'exif:';

// [tag name, IFD, tag id, kind]
const T = (name, ifd, id, kind = 'text') => ({ name, ifd, id, kind });
const GROUPS = [
  ['CAMERA', [
    T('Make', 'ifd0', 0x010F), T('Model', 'ifd0', 0x0110), T('LensMake', 'exif', 0xA433), T('LensModel', 'exif', 0xA434),
    T('BodySerialNumber', 'exif', 0xA431), T('LensSerialNumber', 'exif', 0xA435), T('CameraOwnerName', 'exif', 0xA430),
  ]],
  ['EXPOSURE', [
    T('FNumber', 'exif', 0x829D, 'F_NUMBER'), T('ExposureTime', 'exif', 0x829A, 'EXPOSURE_SECONDS'),
    T('PhotographicSensitivity', 'exif', 0x8827), T('FocalLength', 'exif', 0x920A, 'MILLIMETERS'),
    T('FocalLengthIn35mmFilm', 'exif', 0xA405), T('ExposureProgram', 'exif', 0x8822), T('ExposureMode', 'exif', 0xA402),
    T('ExposureBiasValue', 'exif', 0x9204), T('MeteringMode', 'exif', 0x9207), T('Flash', 'exif', 0x9209),
    T('WhiteBalance', 'exif', 0xA403), T('LightSource', 'exif', 0x9208), T('SceneCaptureType', 'exif', 0xA406),
    T('DigitalZoomRatio', 'exif', 0xA404), T('SubjectDistance', 'exif', 0x9206), T('BrightnessValue', 'exif', 0x9203),
    T('MaxApertureValue', 'exif', 0x9205),
  ]],
  ['IMAGE', [
    T('ImageWidth', 'ifd0', 0x0100), T('ImageLength', 'ifd0', 0x0101), T('PixelXDimension', 'exif', 0xA002),
    T('PixelYDimension', 'exif', 0xA003), T('Orientation', 'ifd0', 0x0112, 'ORIENTATION'), T('ColorSpace', 'exif', 0xA001),
    T('XResolution', 'ifd0', 0x011A), T('YResolution', 'ifd0', 0x011B), T('ResolutionUnit', 'ifd0', 0x0128),
    T('BitsPerSample', 'ifd0', 0x0102), T('Compression', 'ifd0', 0x0103), T('PhotometricInterpretation', 'ifd0', 0x0106),
    T('ExifVersion', 'exif', 0x9000, 'ascii'),
  ]],
  ['DATES', [
    T('DateTimeOriginal', 'exif', 0x9003), T('DateTimeDigitized', 'exif', 0x9004), T('DateTime', 'ifd0', 0x0132),
    T('OffsetTimeOriginal', 'exif', 0x9011), T('OffsetTime', 'exif', 0x9010), T('SubSecTimeOriginal', 'exif', 0x9291),
  ]],
  ['GPS', [
    T('GPSLatitudeRef', 'gps', 1), T('GPSLongitudeRef', 'gps', 3), T('GPSAltitude', 'gps', 6), T('GPSDateStamp', 'gps', 29),
    T('GPSTimeStamp', 'gps', 7, 'time'), T('GPSImgDirection', 'gps', 17), T('GPSSpeed', 'gps', 13), T('GPSSpeedRef', 'gps', 12),
    T('GPSSatellites', 'gps', 8), T('GPSProcessingMethod', 'gps', 27, 'comment'),
  ]],
  ['AUTHORSHIP', [
    T('Software', 'ifd0', 0x0131), T('Artist', 'ifd0', 0x013B), T('Copyright', 'ifd0', 0x8298),
    T('ImageDescription', 'ifd0', 0x010E), T('UserComment', 'exif', 0x9286, 'comment'),
  ]],
];

export const EMPTY_EXIF = Object.freeze({ sections: [], gps: null, toolFields: [], freeTextFields: [], orientation: 1, hasData: false, tiff: null });

const trimNumber = (n) => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(4))));

/** EXIF text with an 8-byte character code prefix (UserComment, GPSProcessingMethod). */
function commentText(data, little) {
  if (data.length < 8) return latin1(data);
  const code = latin1(data, 0, 8);
  const body = data.subarray(8);
  if (code.startsWith('UNICODE')) {
    try { return new TextDecoder(little ? 'utf-16le' : 'utf-16be').decode(body); } catch { return ''; }
  }
  if (code.startsWith('ASCII') || code === '\0\0\0\0\0\0\0\0') return utf8(body);
  return utf8(data);
}

function textOf(entry, tag, little) {
  if (tag.kind === 'comment') return commentText(entry.data, little).replace(/\0+$/, '');
  if (tag.kind === 'ascii') return latin1(entry.data).replace(/\0+$/, '');
  if (entry.type === 2) {
    let end = entry.data.indexOf(0);
    if (end < 0) end = entry.data.length;
    const raw = entry.data.subarray(0, end);
    // Formally ASCII, but cameras and editors write UTF-8 here.
    try { return new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { return latin1(raw); }
  }
  const v = values(entry, little);
  if (!v.length) return null;
  const numbers = v.slice(0, 16).map((x) => (Array.isArray(x) ? (x[1] === 0 ? null : x[0] / x[1]) : x));
  if (numbers.some((x) => x == null || !Number.isFinite(x))) return null;
  if (tag.kind === 'time' && numbers.length === 3) {
    return numbers.map((x, i) => (i < 2 ? String(Math.trunc(x)).padStart(2, '0') : trimNumber(x).padStart(2, '0'))).join(':');
  }
  return numbers.map(trimNumber).join(', ');
}

function dms(entry, little) {
  const v = entry && values(entry, little);
  if (!Array.isArray(v) || v.length < 3) return NaN;
  const [d, m, s] = v.map((x) => (Array.isArray(x) ? (x[1] === 0 ? (x[0] === 0 ? 0 : NaN) : x[0] / x[1]) : x));
  return d + m / 60 + s / 3600;
}

function readGps(t) {
  const g = t.gps;
  if (!g) return null;
  const refOf = (tag) => { const e = g.get(tag); return e ? String(values(e, t.little)).trim().toUpperCase() : ''; };
  let lat = dms(g.get(2), t.little);
  let lon = dms(g.get(4), t.little);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (refOf(1) === 'S') lat = -lat;
  if (refOf(3) === 'W') lon = -lon;
  // Range check: damaged files carry absurd coordinates.
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  let altitude = numberOf(g.get(6), t.little);
  if (Number.isFinite(altitude)) {
    const ref = g.get(5);
    if (ref && ref.data[0] === 1) altitude = -altitude;
  } else altitude = null;
  // Seven decimals are about a centimetre: enough, and free of binary rounding noise.
  const round = (n) => Number(n.toFixed(7));
  return { latitude: round(lat), longitude: round(lon), altitudeMeters: altitude };
}

/** Turns a parsed TIFF into report sections, the GPS point and the fields the signal engine looks at. */
export function exifFromTiff(t) {
  const sections = [];
  const text = {};
  for (const [section, tags] of GROUPS) {
    const items = [];
    for (const tag of tags) {
      const entry = t[tag.ifd]?.get(tag.id);
      if (!entry) continue;
      const key = EXIF_KEY + tag.name;
      if (['F_NUMBER', 'EXPOSURE_SECONDS', 'MILLIMETERS'].includes(tag.kind)) {
        const n = numberOf(entry, t.little);
        if (Number.isFinite(n)) items.push({ label: tag.name, value: String(n), key, format: tag.kind });
      } else if (tag.kind === 'ORIENTATION') {
        const n = numberOf(entry, t.little);
        if (Number.isFinite(n) && n !== 0) items.push({ label: tag.name, value: String(n), key, format: 'ORIENTATION' });
      } else {
        const value = cleanText(textOf(entry, tag, t.little));
        if (value) { items.push({ label: tag.name, value, key }); text[tag.name] = value; }
      }
    }
    if (items.length) sections.push({ title: section, key: section, items });
  }
  const field = (name, label) => (text[name] ? [{ label, value: text[name] }] : []);
  const gps = readGps(t);
  const orientation = numberOf(t.ifd0.get(0x0112), t.little);
  return {
    sections,
    gps,
    // Technical field names: they go into signal text as is, the same in every language.
    toolFields: field('Software', 'EXIF Software'),
    freeTextFields: [...field('ImageDescription', 'EXIF ImageDescription'), ...field('UserComment', 'EXIF UserComment'), ...field('Artist', 'EXIF Artist')],
    orientation: Number.isFinite(orientation) && orientation >= 1 && orientation <= 8 ? orientation : 1,
    hasData: gps != null || sections.length > 0,
    tiff: t,
  };
}

/** TIFF bytes of the EXIF block for the given format, or null. */
export function findExif(d, format) {
  let tiff = null;
  if (format === 'JPEG') tiff = jpegExif(d);
  else if (format === 'PNG') tiff = pngExif(d);
  else if (format === 'WEBP') tiff = webpExif(d);
  else if (format === 'HEIC' || format === 'AVIF') {
    tiff = heifExif(d);
    if (!tiff) {
      // Unusual layout or a truncated buffer: look for the Exif header directly.
      const at = indexOfSeq(d, ascii('Exif\0\0'), 0, Math.min(d.length, 4 * 1024 * 1024));
      if (at >= 0) tiff = d.subarray(at + 6);
    }
  }
  return tiff && tiff.length >= 8 ? tiff : null;
}

export function readExif(d, format) {
  try {
    const tiff = findExif(d, format);
    return tiff ? exifFromTiff(parseTiff(tiff)) : EMPTY_EXIF;
  } catch {
    // Unsupported layout or a damaged block: simply no EXIF data.
    return EMPTY_EXIF;
  }
}
