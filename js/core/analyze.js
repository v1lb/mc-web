// Builds the report for one file. Everything happens in memory on this device; nothing is uploaded.

import { FormatError, utf8 } from './bytes.js';
import { detectFormat, isVideo } from './format.js';
import { readExif } from './exif.js';
import { parsePngText, BAD_DATA } from './png.js';
import { extractPacket, parseXmp, KEY_CREATOR_TOOL, KEY_SOFTWARE_AGENT } from './xmp.js';
import { readIptc } from './iptc.js';
import { readC2pa } from './c2pa.js';
import { gifTexts } from './gif.js';
import { readVideo } from './mp4.js';
import { evaluateSignals } from './signals.js';

/** At most 16 MB of an image is read: enough for headers and text blocks before the pixel data. */
export const MAX_SCAN_BYTES = 16 * 1024 * 1024;

const xmpTools = (xmp) => [
  ...(xmp?.fields[KEY_CREATOR_TOOL] ? [{ label: 'XMP CreatorTool', value: xmp.fields[KEY_CREATOR_TOOL] }] : []),
  ...(xmp?.fields[KEY_SOFTWARE_AGENT] ? [{ label: 'XMP softwareAgent', value: xmp.fields[KEY_SOFTWARE_AGENT] }] : []),
];

async function analyzeVideo(file, name) {
  let video;
  try { video = await readVideo(file); } catch (e) {
    if (e instanceof FormatError) throw new FormatError('UNSUPPORTED_FORMAT');
    throw e;
  }
  const xmp = video.xmpPacket ? parseXmp(video.xmpPacket) : null;
  let c2pa = null;
  if (video.c2paBox) { try { c2pa = readC2pa(video.c2paBox, 'HEIC'); } catch { c2pa = null; } }
  const signals = evaluateSignals({
    toolFields: [...video.toolFields, ...xmpTools(xmp)], freeTextFields: video.freeTextFields, xmpFields: xmp?.fields ?? {},
    pngText: [], c2pa, fileName: name, hasGps: video.gps != null,
    hasAnyMetadata: video.hasPersonalData || (xmp?.items.length ?? 0) > 0, truncated: false,
  });
  return {
    report: {
      file: { name, mimeType: file.type ?? '', sizeBytes: file.size, format: video.format, scannedBytes: video.moovBytes, truncated: false },
      exifSections: video.sections, xmpItems: xmp?.items ?? [], pngTextItems: [], gps: video.gps, signals,
    },
    exif: null,
  };
}

/** [file] is a File or Blob. Returns { report, exif } where exif holds the parsed EXIF block for the editor. */
export async function analyzeFile(file, fileName = file.name ?? '') {
  const name = String(fileName).slice(0, 255);
  const head = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  if (isVideo(detectFormat(head))) return analyzeVideo(file, name);

  const truncated = file.size > MAX_SCAN_BYTES;
  const bytes = new Uint8Array(await file.slice(0, MAX_SCAN_BYTES).arrayBuffer());
  const format = detectFormat(bytes);
  if (format === 'UNKNOWN') throw new FormatError('UNSUPPORTED_FORMAT');

  const png = format === 'PNG' ? await parsePngText(bytes) : [];
  const packet = extractPacket(bytes, png);
  const xmp = packet ? parseXmp(packet) : null;
  const exif = readExif(bytes, format);
  // A C2PA parsing error must not break the analysis: then there is simply no manifest information.
  let c2pa = null;
  try { c2pa = readC2pa(bytes, format); } catch { c2pa = null; }

  // IPTC-IIM (APP13) repeats XMP in an older format; values already shown from XMP are not repeated.
  const iptcItems = format === 'JPEG' ? readIptc(bytes) : [];
  const xmpValues = new Set((xmp?.items ?? []).map((i) => i.value.trim()));
  const xmpItems = [...(xmp?.items ?? []), ...iptcItems.filter((i) => !xmpValues.has(i.value.trim()))];
  const pngItems = png.filter((e) => e.keyword !== 'XML:com.adobe.xmp')
    .map((e) => (e.text === BAD_DATA ? { label: e.keyword, value: '', format: 'BAD_DATA' } : { label: e.keyword, value: e.text }));
  if (format === 'GIF') for (const text of gifTexts(bytes).comments) pngItems.push({ label: 'Comment', value: text });

  const signals = evaluateSignals({
    toolFields: [...exif.toolFields, ...xmpTools(xmp)], freeTextFields: exif.freeTextFields, xmpFields: xmp?.fields ?? {},
    pngText: png, c2pa, fileName: name, hasGps: exif.gps != null,
    hasAnyMetadata: exif.hasData || xmpItems.length > 0 || pngItems.length > 0 || c2pa != null, truncated,
  });
  return {
    report: {
      file: { name, mimeType: file.type ?? '', sizeBytes: file.size, format, scannedBytes: bytes.length, truncated },
      exifSections: exif.sections, xmpItems, pngTextItems: pngItems, gps: exif.gps, signals,
    },
    exif,
  };
}
