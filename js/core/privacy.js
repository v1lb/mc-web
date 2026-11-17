// What the metadata tells about a person if the original file is shared, and report-level helpers.
// The weight is the contribution to the risk index (0–100): the exact place matters more than the phone model.

export const EXPOSURE_WEIGHT = {
  EXACT_LOCATION: 45, LOCATION_TAGS: 25, OWNER: 20, DEVICE_SERIAL: 15, PLACE_NAME: 15, AUTHOR: 10, AI_PROMPT: 10,
  CAPTURE_TIME: 8, DESCRIPTION: 6, DEVICE: 5, EDIT_HISTORY: 4, SOFTWARE: 2,
};

const MAX_VALUE = 80;
/** PNG blocks where generators keep the prompt. "Comment" is not here: ordinary editors write it too. */
const PROMPT_KEYWORDS = new Set(['parameters', 'prompt', 'workflow', 'dream', 'sd-metadata', 'invokeai_metadata']);

/** A field with coordinates or other GPS data (XMP exif:GPS*, PNG keywords like gps_*). */
export function isLocationItem(item) {
  const label = item.label.toLowerCase();
  const key = (item.key ?? '').toLowerCase();
  return label.includes('gpslatitude') || label.includes('gpslongitude') || label.includes('gpsaltitude') ||
    label.startsWith('gps:') || label.startsWith('gps_') || key.includes(':gps');
}

export const hasExifLocation = (r) => r.gps != null || r.exifSections.some((s) => s.key === 'GPS' && s.items.length > 0);
export const hasLocationMarkers = (r) => hasExifLocation(r) || [...r.xmpItems, ...r.pngTextItems].some(isLocationItem);

export const hasAiEvidence = (r) => r.signals.some((s) => s.severity === 'AI_EVIDENCE');
export const actionableSignalCount = (r) => r.signals.filter((s) => s.severity !== 'INFO').length;
/** The AI verdict is inconclusive: a truncated file, or a caution other than the GPS privacy warning. */
export const needsAiReview = (r) => !hasAiEvidence(r) &&
  (r.file.truncated || r.signals.some((s) => s.severity === 'CAUTION' && s.kind !== 'HAS_GPS'));

export function privacyExposure(report) {
  const fields = new Map();
  for (const item of [...report.exifSections.flatMap((s) => s.items), ...report.xmpItems]) {
    if (!item.key) continue;
    if (!fields.has(item.key)) fields.set(item.key, []);
    fields.get(item.key).push(item.value.trim());
  }
  const value = (...keys) => keys.flatMap((k) => fields.get(k) ?? []).find((v) => v) ?? null;
  const valuesOf = (...keys) => [...new Set(keys.map((k) => value(k)).filter(Boolean))].join(' · ') || null;

  const found = [];
  const add = (kind, raw) => { if (raw != null) found.push({ kind, value: raw.slice(0, MAX_VALUE) }); };

  if (report.gps) add('EXACT_LOCATION', `${report.gps.latitude.toFixed(5)}, ${report.gps.longitude.toFixed(5)}`);
  else if (hasLocationMarkers(report)) add('LOCATION_TAGS', '');
  add('OWNER', value('exif:CameraOwnerName'));
  add('DEVICE_SERIAL', valuesOf('exif:BodySerialNumber', 'exif:LensSerialNumber'));
  add('PLACE_NAME', valuesOf('xmp:Iptc4xmpCore:Location', 'iptc:Sublocation', 'xmp:photoshop:City', 'iptc:City',
    'xmp:photoshop:State', 'iptc:State', 'xmp:photoshop:Country', 'iptc:Country'));
  add('AUTHOR', valuesOf('exif:Artist', 'exif:Copyright', 'xmp:dc:creator', 'xmp:dc:rights', 'iptc:Byline', 'iptc:Copyright'));
  const hasPrompt = report.pngTextItems.some((i) => PROMPT_KEYWORDS.has(i.label.toLowerCase()) && i.value.trim()) ||
    report.signals.some((s) => ['SD_PARAMETERS', 'GENERATION_PARAMS', 'COMFYUI_GRAPH'].includes(s.kind));
  if (hasPrompt) add('AI_PROMPT', '');
  add('CAPTURE_TIME', value('exif:DateTimeOriginal', 'exif:DateTime', 'xmp:xmp:CreateDate', 'video:created'));
  add('DESCRIPTION', valuesOf('exif:ImageDescription', 'exif:UserComment', 'xmp:dc:description', 'xmp:dc:title', 'iptc:Caption',
    'iptc:ObjectName', 'xmp:photoshop:Headline', 'iptc:Headline', 'xmp:dc:subject', 'iptc:Keywords', 'video:title'));
  // "Apple iPhone 15", not "Apple Apple iPhone 15": the model often already includes the maker.
  const device = [value('exif:Make', 'xmp:tiff:Make'), value('exif:Model', 'xmp:tiff:Model')].filter(Boolean)
    .reduce((acc, part) => (acc.some((a) => part.toLowerCase().includes(a.toLowerCase())) ? [...acc.slice(1), part] : [...acc, part]), [])
    .join(' ');
  add('DEVICE', device || null);
  add('EDIT_HISTORY', value('xmp:history_agents'));
  add('SOFTWARE', valuesOf('exif:Software', 'xmp:xmp:CreatorTool'));

  const items = found.sort((a, b) => EXPOSURE_WEIGHT[b.kind] - EXPOSURE_WEIGHT[a.kind]);
  const score = Math.min(100, items.reduce((sum, i) => sum + EXPOSURE_WEIGHT[i.kind], 0));
  const level = !items.length ? 'NONE' : score < 20 ? 'LOW' : score < 45 ? 'MEDIUM' : 'HIGH';
  return { score, items, level };
}
