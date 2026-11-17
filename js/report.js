// Report-level views of the data: the searchable metadata catalog and every export format.

import { t } from './i18n.js';
import { itemLabel, itemValue, sectionTitle, formatName, severityTag, signalTitle, signalDetail } from './texts.js';
import { hasAiEvidence, isLocationItem } from './core/privacy.js';
import { utf8Bytes, concat } from './core/bytes.js';

export const GROUPS = ['MAIN', 'CAMERA', 'LOCATION', 'EXIF', 'XMP', 'PNG', 'VIDEO'];
export const GROUP_MARKER = { MAIN: 'FILE', CAMERA: 'CAM', LOCATION: 'GPS', EXIF: 'EXIF', XMP: 'XMP', PNG: 'PNG', VIDEO: 'MP4' };
export const groupTitle = (group) => t(`group_${group.toLowerCase()}`);
const ENGLISH_CATEGORY = {
  MAIN: 'general file dates', CAMERA: 'camera lens exposure shutter', LOCATION: 'gps location latitude longitude altitude',
  EXIF: 'technical exif image software', XMP: 'xmp iptc metadata', PNG: 'png text comments', VIDEO: 'video mp4 mov quicktime container tags',
};

/** Every field the parsers extracted, with localized labels: [{ group, section, label, value, key }]. */
export function catalog(report) {
  const out = [];
  const record = (group, section, label, value, key = null) => out.push({ group, section, label, value, key });
  const items = (group, section, entries) => entries.forEach((i) => record(group, section, itemLabel(i), itemValue(i), i.key ?? null));
  const f = report.file;
  const fileSection = t('catalog_file_section');
  record('MAIN', fileSection, t('field_name'), f.name || t('common_unnamed'), 'file:name');
  record('MAIN', fileSection, t('field_format'), formatName(f.format), 'file:format');
  record('MAIN', fileSection, t('field_mime'), f.mimeType || t('common_unknown'), 'file:mime');
  record('MAIN', fileSection, t('field_size_bytes'), String(f.sizeBytes), 'file:size');
  record('MAIN', fileSection, t('field_scanned_bytes'), String(f.scannedBytes), 'file:scanned');
  record('MAIN', fileSection, t('field_partial'), t(f.truncated ? 'common_yes' : 'common_no'), 'file:partial');
  const groupOf = { CAMERA: 'CAMERA', EXPOSURE: 'CAMERA', DATES: 'MAIN', GPS: 'LOCATION', CONTAINER: 'VIDEO' };
  for (const section of report.exifSections) items(groupOf[section.key] ?? 'EXIF', sectionTitle(section), section.items);
  if (report.gps) {
    const section = t('catalog_coordinates_section');
    record('LOCATION', section, t('field_latitude'), String(report.gps.latitude), 'gps:latitude');
    record('LOCATION', section, t('field_longitude'), String(report.gps.longitude), 'gps:longitude');
    if (report.gps.altitudeMeters != null) record('LOCATION', section, t('field_altitude_m'), String(report.gps.altitudeMeters), 'gps:altitude');
  }
  items('XMP', t('report_xmp_iptc'), report.xmpItems);
  items('PNG', t('report_png_text'), report.pngTextItems);
  return out;
}

/** Case-insensitive search over label, value, section and group, plus the technical key and English group synonyms. */
export function filterCatalog(records, group, query) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return records.filter((r) => {
    if (group && r.group !== group) return false;
    const text = [ENGLISH_CATEGORY[r.group], GROUP_MARKER[r.group], groupTitle(r.group), r.section, r.label, r.value, r.key ?? ''].join(' ').toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

// --- Text report (clipboard, print) ---

const MAX_VALUE = 2000;

/** [{ heading: boolean, text }] in the interface language. */
export function reportBlocks(r) {
  const out = [];
  const heading = (text) => out.push({ heading: true, text });
  const line = (text) => out.push({ heading: false, text });
  const items = (list) => list.forEach((i) => line(`${itemLabel(i)}: ${itemValue(i).slice(0, MAX_VALUE)}`));
  heading(t('report_title'));
  heading(t('report_file'));
  const f = r.file;
  line(t('report_file_name', f.name || t('common_unnamed')));
  line(t('report_file_format', formatName(f.format)));
  line(t('report_file_mime', f.mimeType || t('common_unknown')));
  line(f.sizeBytes >= 0 ? t('report_file_size', f.sizeBytes) : t('report_file_size_unknown'));
  if (f.truncated) line(t('report_file_partial', f.scannedBytes));
  heading(t('report_ai_analysis'));
  line(t(hasAiEvidence(r) ? 'report_ai_found' : 'report_ai_not_found'));
  r.signals.forEach((s) => line(`[${severityTag(s.severity)}] ${signalTitle(s)}: ${signalDetail(s)}`));
  r.exifSections.forEach((section) => { heading(sectionTitle(section)); items(section.items); });
  if (r.xmpItems.length) { heading(t('report_xmp_iptc')); items(r.xmpItems); }
  if (r.pngTextItems.length) { heading(t('report_png_text')); items(r.pngTextItems); }
  if (r.gps) {
    heading(t('report_geolocation'));
    line(t('report_coordinates', r.gps.latitude, r.gps.longitude));
    if (r.gps.altitudeMeters != null) line(t('report_altitude', r.gps.altitudeMeters));
  }
  return out;
}

export const reportText = (r) => reportBlocks(r).map((b) => (b.heading ? `\n== ${b.text} ==` : b.text)).join('\n').trim();

// --- JSON (schema 2, the same as the Android app) ---

function itemsJson(list, withTexts) {
  return list.map((i) => {
    const o = { label: withTexts ? itemLabel(i) : i.label, value: withTexts ? itemValue(i) : i.value };
    if (i.key) o.key = i.key;
    if (i.format) o.format = i.format;
    if (withTexts && i.format) o.rawValue = i.value;
    return o;
  });
}

/**
 * [includeGps] = false removes every piece of location data: the "gps" block, the EXIF GPS section and GPS fields
 * of XMP/PNG. [withTexts] adds ready texts in the interface language (export, API); history keeps machine data only.
 */
export function reportJson(r, { includeGps = true, withTexts = false } = {}) {
  const exifSections = includeGps ? r.exifSections : r.exifSections.filter((s) => s.key !== 'GPS');
  const keep = (list) => (includeGps ? list : list.filter((i) => !isLocationItem(i)));
  const o = {
    schema: 2,
    generator: 'MetaCheck',
    file: { ...r.file },
    aiEvidence: hasAiEvidence(r),
    signals: r.signals.map((s) => ({
      severity: s.severity, kind: s.kind, ...(s.args?.length ? { args: s.args } : {}),
      title: withTexts ? signalTitle(s) : '', detail: withTexts ? signalDetail(s) : '',
    })),
    exif: exifSections.map((s) => ({ title: withTexts ? sectionTitle(s) : s.title, key: s.key, items: itemsJson(s.items, withTexts) })),
    xmp: itemsJson(keep(r.xmpItems), withTexts),
    pngText: itemsJson(keep(r.pngTextItems), withTexts),
  };
  if (includeGps && r.gps) {
    o.gps = { latitude: r.gps.latitude, longitude: r.gps.longitude };
    if (r.gps.altitudeMeters != null) o.gps.altitudeMeters = r.gps.altitudeMeters;
  }
  return o;
}

/** Reads a stored report back. Unknown or damaged input gives null. */
export function reportFromJson(o) {
  try {
    const items = (list) => (Array.isArray(list) ? list : []).map((i) => ({
      label: String(i.label ?? ''), value: String(i.rawValue ?? i.value ?? ''), ...(i.key ? { key: String(i.key) } : {}), ...(i.format ? { format: String(i.format) } : {}),
    }));
    const f = o.file ?? {};
    return {
      file: { name: String(f.name ?? ''), mimeType: String(f.mimeType ?? ''), sizeBytes: Number(f.sizeBytes ?? -1), format: String(f.format ?? 'UNKNOWN'),
        scannedBytes: Number(f.scannedBytes ?? 0), truncated: !!f.truncated },
      signals: (o.signals ?? []).map((s) => ({ severity: ['AI_EVIDENCE', 'CAUTION', 'INFO'].includes(s.severity) ? s.severity : 'INFO',
        kind: s.kind ?? null, args: Array.isArray(s.args) ? s.args.map(String) : [],
        ...(s.kind ? {} : { title: String(s.title ?? ''), detail: String(s.detail ?? '') }) })),
      exifSections: (o.exif ?? []).map((s) => ({ title: String(s.title ?? ''), key: s.key ?? null, items: items(s.items) })),
      xmpItems: items(o.xmp),
      pngTextItems: items(o.pngText),
      gps: o.gps && Number.isFinite(o.gps.latitude) && Number.isFinite(o.gps.longitude)
        ? { latitude: o.gps.latitude, longitude: o.gps.longitude, altitudeMeters: Number.isFinite(o.gps.altitudeMeters) ? o.gps.altitudeMeters : null } : null,
    };
  } catch { return null; }
}

// --- CSV: RFC 4180 quoting, UTF-8 BOM for Excel, protection against spreadsheet formula injection ---

function csvField(value) {
  const raw = String(value);
  const first = raw.trimStart()[0];
  const safe = ['=', '+', '-', '@'].includes(first) || raw.startsWith('\t') || raw.startsWith('\r') ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}

function csvBytes(header, rows) {
  const text = [header, ...rows.map((row) => row.map(csvField).join(','))].join('\r\n') + '\r\n';
  return concat([Uint8Array.of(0xEF, 0xBB, 0xBF), utf8Bytes(text)]);
}

export const metadataCsv = (records) => csvBytes('category,section,tag,value', records.map((r) => [groupTitle(r.group), r.section, r.label, r.value]));

export const historyCsv = (entries) => csvBytes('date_utc,filename,format,ai_metadata_evidence,gps_present',
  entries.map((e) => [new Date(e.createdAt).toISOString(), e.fileName, formatName(e.format), String(e.hasAiEvidence), String(e.hasGps)]));
