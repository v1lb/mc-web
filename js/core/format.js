import { ascii, startsWith } from './bytes.js';

export const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

export const FORMAT_LABEL = {
  JPEG: 'JPEG', PNG: 'PNG', WEBP: 'WebP', GIF: 'GIF', HEIC: 'HEIC/HEIF', AVIF: 'AVIF', MP4: 'MP4', MOV: 'MOV', UNKNOWN: 'unknown',
};

export const isVideo = (format) => format === 'MP4' || format === 'MOV';

const VIDEO_BRANDS = [
  'isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'mp71', 'avc1', 'M4V ', 'M4VH', 'M4VP',
  '3gp4', '3gp5', '3gp6', '3gp7', '3gp8', '3gp9', '3g2a', '3g2b', '3g2c', 'MSNV', 'XAVC', 'mmp4', 'f4v ', 'CAEP',
];

/** The format comes from the file signature, never from the extension or MIME type. */
export function detectFormat(d) {
  const at = (off, s) => startsWith(d, ascii(s), off);
  if (d.length >= 3 && d[0] === 0xFF && d[1] === 0xD8 && d[2] === 0xFF) return 'JPEG';
  if (startsWith(d, PNG_SIGNATURE)) return 'PNG';
  if (at(0, 'GIF87a') || at(0, 'GIF89a')) return 'GIF';
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'WEBP';
  if (at(4, 'ftyp')) {
    if (at(8, 'avif') || at(8, 'avis')) return 'AVIF';
    if (['heic', 'heix', 'heim', 'heis', 'hevc'].some((b) => at(8, b))) return 'HEIC';
    if (at(8, 'mif1') || at(8, 'msf1')) {
      for (let i = 16; i <= 28; i += 4) if (at(i, 'avif') || at(i, 'avis')) return 'AVIF';
      return 'HEIC';
    }
    if (at(8, 'qt  ')) return 'MOV';
    if (VIDEO_BRANDS.some((b) => at(8, b))) return 'MP4';
    return 'UNKNOWN';
  }
  if (at(4, 'moov') || at(4, 'mdat') || at(4, 'wide')) return 'MOV';
  return 'UNKNOWN';
}

/** Output type of a cleaned copy: every format keeps its own container. */
export function cleanOutput(format) {
  switch (format) {
    case 'JPEG': return { mime: 'image/jpeg', ext: 'jpg' };
    case 'WEBP': return { mime: 'image/webp', ext: 'webp' };
    case 'HEIC': return { mime: 'image/heic', ext: 'heic' };
    case 'AVIF': return { mime: 'image/avif', ext: 'avif' };
    case 'GIF': return { mime: 'image/gif', ext: 'gif' };
    case 'MP4': return { mime: 'video/mp4', ext: 'mp4' };
    case 'MOV': return { mime: 'video/quicktime', ext: 'mov' };
    default: return { mime: 'image/png', ext: 'png' };
  }
}
