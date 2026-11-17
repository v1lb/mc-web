// Full metadata cleaning without recompression. Each format keeps its own container and pixel data;
// the result is verified by an independent check before it is returned.

import { FormatError } from './bytes.js';
import { stripJpeg, isStrippedJpeg } from './jpeg.js';
import { stripPng, isCleanPng } from './png.js';
import { stripWebp, isCleanWebp } from './webp.js';
import { stripHeif, isCleanHeif } from './heif.js';
import { stripGif, isCleanGif } from './gif.js';

const CLEANERS = {
  JPEG: [stripJpeg, isStrippedJpeg],
  PNG: [stripPng, isCleanPng],
  WEBP: [stripWebp, isCleanWebp],
  HEIC: [stripHeif, isCleanHeif],
  AVIF: [stripHeif, isCleanHeif],
  GIF: [stripGif, isCleanGif],
};

/** Returns cleaned bytes. Throws FormatError when the structure is not understood or the check fails. */
export function cleanImage(d, format) {
  const entry = CLEANERS[format];
  if (!entry) throw new FormatError('UNSUPPORTED_IMAGE');
  const [strip, isClean] = entry;
  let out;
  try { out = strip(d); } catch (e) {
    // A malformed file can push an offset out of bounds (RangeError): for the caller it is a format problem.
    if (e instanceof FormatError) throw e;
    throw new FormatError('MALFORMED');
  }
  if (!out.length) throw new FormatError('EMPTY_RESULT');
  if (!isClean(out)) throw new FormatError('CLEAN_CHECK_FAILED');
  return out;
}
