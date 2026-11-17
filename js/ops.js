// File operations behind the buttons: cleaning, GPS removal, editing, batches. Plan limits are enforced here.

import { analyzeFile } from './core/analyze.js';
import { cleanImage } from './core/clean.js';
import { cleanVideo, isCleanVideo } from './core/mp4clean.js';
import { applyPatch, wipeGps, shiftJpegDates } from './core/edit.js';
import { detectFormat, isVideo, cleanOutput } from './core/format.js';
import { FormatError } from './core/bytes.js';
import { zipBlob, uniqueName } from './core/zip.js';
import { privacyExposure, hasLocationMarkers } from './core/privacy.js';
import { entitlement, checkQuota, recordClean, perRun, PRO_PER_RUN } from './store.js';

/** Images are processed in memory; above this size the browser tab may run out of it. */
export const MAX_IMAGE_BYTES = 80 * 1024 * 1024;
export const MAX_AUDIT_FILES = 1000;
export const MAX_AUDIT_DEPTH = 3;

const fail = (code, extra = {}) => { throw Object.assign(new Error(code), { code, ...extra }); };

function baseName(name) {
  const clean = (name || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120);
  const dot = clean.lastIndexOf('.');
  return dot > 0 ? clean.slice(0, dot) : clean;
}

async function imageBytes(file) {
  if (file.size > MAX_IMAGE_BYTES) fail('TOO_LARGE', { limitMb: 80 });
  return new Uint8Array(await file.arrayBuffer());
}

async function formatOf(file) {
  return detectFormat(new Uint8Array(await file.slice(0, 32).arrayBuffer()));
}

/** Last resort for files whose structure the cleaners do not understand: the browser decodes and saves again. */
async function reencode(file, format) {
  let bitmap;
  try { bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { fail('DECODE_FAILED'); }
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close?.();
  const jpeg = format === 'JPEG';
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, jpeg ? 'image/jpeg' : 'image/png', jpeg ? 0.95 : undefined));
  if (!blob || !blob.size) fail('ENCODE_FAILED');
  return { blob, ext: jpeg ? 'jpg' : 'png' };
}

/**
 * Cleaned copy of one file. Returns { blob, name, format, reencoded, removedBytes, removedTracks }.
 * Video is a Pro feature and does not count towards the free daily limit.
 */
export async function cleanFile(file, { countQuota = true } = {}) {
  const format = await formatOf(file);
  if (format === 'UNKNOWN') fail('UNSUPPORTED_FORMAT');
  const out = cleanOutput(format);
  const name = `${baseName(file.name)}_clean.${out.ext}`;
  if (isVideo(format)) {
    if (!entitlement.isPro) fail('PRO_REQUIRED');
    const result = await cleanVideo(file, out.mime);
    if (!(await isCleanVideo(result.blob))) fail('CLEAN_CHECK_FAILED');
    return { blob: result.blob, name, format, reencoded: false, removedBytes: file.size - result.outputBytes, removedTracks: result.removedTracks };
  }
  if (countQuota) checkQuota();
  let result;
  try {
    const bytes = cleanImage(await imageBytes(file), format);
    result = { blob: new Blob([bytes], { type: out.mime }), name, format, reencoded: false, removedBytes: file.size - bytes.length, removedTracks: 0 };
  } catch (e) {
    if (!(e instanceof FormatError)) throw e;
    const { blob, ext } = await reencode(file, format);
    result = { blob, name: `${baseName(file.name)}_clean.${ext}`, format, reencoded: true, removedBytes: 0, removedTracks: 0 };
  }
  if (countQuota && !entitlement.isPro) recordClean();
  return result;
}

/** Copy without location data; everything else stays. */
export async function removeGps(file) {
  const format = await formatOf(file);
  if (isVideo(format)) return cleanFile(file);
  checkQuota();
  const { bytes } = wipeGps(await imageBytes(file), format);
  if (!entitlement.isPro) recordClean();
  const out = cleanOutput(format);
  return { blob: new Blob([bytes], { type: out.mime }), name: `${baseName(file.name)}_nogps.${out.ext}`, format };
}

export async function editFile(file, patch) {
  checkQuota();
  const { bytes, verified } = applyPatch(await imageBytes(file), patch);
  if (!entitlement.isPro) recordClean();
  return { blob: new Blob([bytes], { type: 'image/jpeg' }), name: `${baseName(file.name)}_edited.jpg`, verified };
}

async function batch(files, progress, work) {
  const taken = new Set();
  const entries = [];
  const errors = [];
  for (let i = 0; i < files.length; i++) {
    progress({ completed: i, total: files.length, current: files[i].name, succeeded: entries.length, failed: errors.length });
    try {
      const { bytes, name } = await work(files[i]);
      entries.push({ name: uniqueName(name, taken), bytes });
    } catch (error) { errors.push({ file: files[i].name, error }); }
    await new Promise((resolve) => setTimeout(resolve)); // let the page repaint
  }
  progress({ completed: files.length, total: files.length, current: '', succeeded: entries.length, failed: errors.length });
  return { zip: entries.length ? zipBlob(entries) : null, succeeded: entries.length, failed: errors.length, errors };
}

/**
 * Batch cleaning into one ZIP. Free: up to 5 photos per run within the daily limit, every cleaned photo counts.
 * Pro: up to 50 per run. Videos are skipped in a batch on the free plan.
 */
export async function cleanBatch(files, progress = () => {}) {
  if (!files.length || files.length > PRO_PER_RUN) fail('BATCH_SIZE');
  if (!entitlement.isPro && files.length > perRun()) fail(perRun() === 0 ? 'DAILY_LIMIT' : 'PRO_REQUIRED', { limit: 10 });
  const result = await batch(files, progress, async (file) => {
    const cleaned = await cleanFile(file, { countQuota: false });
    return { bytes: new Uint8Array(await cleaned.blob.arrayBuffer()), name: cleaned.name.replace('_clean.', '.') };
  });
  if (!entitlement.isPro && result.succeeded) recordClean(result.succeeded);
  return result;
}

/** Shifts the capture date of several JPEG photos (Pro): the camera clock or time zone was set wrong. */
export async function shiftBatch(files, seconds, progress = () => {}) {
  if (!entitlement.isPro) fail('PRO_REQUIRED');
  if (!files.length || files.length > PRO_PER_RUN) fail('BATCH_SIZE');
  return batch(files, progress, async (file) => ({ bytes: shiftJpegDates(await imageBytes(file), seconds).bytes, name: file.name }));
}

const MEDIA_NAME = /\.(jpe?g|png|webp|gif|heic|heif|avif)$/i;

/**
 * Reads every photo of a chosen folder and reports what each one gives away. Changes nothing.
 * Returns { scanned, findings (riskiest first), limited }.
 */
export async function auditFolder(files, progress = () => {}) {
  const photos = files.filter((f) => (f.type.startsWith('image/') || MEDIA_NAME.test(f.name)) &&
    (f.webkitRelativePath || f.name).split('/').length - 1 <= MAX_AUDIT_DEPTH + 1);
  const limited = photos.length > MAX_AUDIT_FILES;
  const findings = [];
  let scanned = 0;
  for (const file of photos.slice(0, MAX_AUDIT_FILES)) {
    try {
      const { report } = await analyzeFile(file);
      scanned++;
      const kinds = new Set(privacyExposure(report).items.map((i) => i.kind));
      if (kinds.size) {
        const finding = { file, name: file.name, location: hasLocationMarkers(report), serial: kinds.has('DEVICE_SERIAL'),
          person: kinds.has('OWNER') || kinds.has('AUTHOR') };
        finding.risk = (finding.location ? 4 : 0) + (finding.serial ? 2 : 0) + (finding.person ? 1 : 0);
        findings.push(finding);
      }
    } catch { /* not an image after all: skipped */ }
    if (scanned % 5 === 0) { progress(scanned); await new Promise((resolve) => setTimeout(resolve)); }
  }
  findings.sort((a, b) => b.risk - a.risk);
  return { scanned, findings, limited };
}
