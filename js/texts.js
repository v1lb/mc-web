// Turns machine data of a report (keys, kinds, raw values) into texts in the interface language.

import { t, has, number } from './i18n.js';
import { FORMAT_LABEL } from './core/format.js';
import { C2PA_UNREADABLE } from './core/signals.js';

const EXIF_NAME_OVERRIDES = {
  FocalLengthIn35mmFilm: 'focal_length_in_35mm_film', DateTimeOriginal: 'datetime_original', DateTimeDigitized: 'datetime_digitized',
  DateTime: 'datetime', GPSDateStamp: 'gps_datestamp', GPSTimeStamp: 'gps_timestamp', SubSecTimeOriginal: 'subsec_time_original',
};
const snake = (name) => EXIF_NAME_OVERRIDES[name] ??
  name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z])([A-Z][a-z])/g, '$1_$2').toLowerCase();

const KEY_RESOURCES = {
  'xmp:xmp:CreatorTool': 'xmp_creator_tool', 'xmp:xmp:CreateDate': 'xmp_create_date', 'xmp:xmp:ModifyDate': 'xmp_modify_date',
  'xmp:dc:title': 'xmp_title', 'xmp:dc:creator': 'xmp_creator', 'xmp:dc:description': 'xmp_description', 'xmp:dc:rights': 'xmp_rights',
  'xmp:dc:subject': 'meta_keywords', 'xmp:photoshop:Headline': 'meta_headline', 'xmp:photoshop:Credit': 'meta_credit',
  'xmp:photoshop:Source': 'meta_source', 'xmp:Iptc4xmpCore:Location': 'meta_sublocation', 'xmp:photoshop:City': 'meta_city',
  'xmp:photoshop:State': 'meta_state', 'xmp:photoshop:Country': 'meta_country', 'xmp:tiff:Make': 'xmp_make', 'xmp:tiff:Model': 'xmp_model',
  'xmp:exif:GPSLatitude': 'xmp_gps_latitude', 'xmp:exif:GPSLongitude': 'xmp_gps_longitude', 'xmp:exif:GPSAltitude': 'xmp_gps_altitude',
  'xmp:Iptc4xmpExt:DigitalSourceType': 'xmp_digital_source_type', 'xmp:history_agents': 'xmp_history_agents',
  'iptc:ObjectName': 'xmp_title', 'iptc:Headline': 'meta_headline', 'iptc:Caption': 'xmp_description', 'iptc:Keywords': 'meta_keywords',
  'iptc:Byline': 'xmp_creator', 'iptc:Copyright': 'xmp_rights', 'iptc:Credit': 'meta_credit', 'iptc:Source': 'meta_source',
  'iptc:Sublocation': 'meta_sublocation', 'iptc:City': 'meta_city', 'iptc:State': 'meta_state', 'iptc:Country': 'meta_country',
  'video:duration': 'label_video_duration', 'video:codec': 'label_video_codec', 'video:created': 'label_video_created',
  'video:location': 'label_video_location', 'video:title': 'label_video_title',
};

export function itemLabel(item) {
  const key = item.key;
  if (key) {
    const resource = KEY_RESOURCES[key] ?? (key.startsWith('exif:') ? `exif_${snake(key.slice(5))}` : null);
    if (resource && has(resource)) return t(resource);
  }
  return item.label;
}

export function itemValue(item) {
  const raw = item.value;
  const n = Number(raw);
  switch (item.format) {
    case 'BAD_DATA': return t('value_bad_data');
    case 'BOOLEAN': return t(raw === 'true' ? 'common_yes' : 'common_no');
    case 'BYTES': return t('value_bytes', raw);
    case 'EXPOSURE_SECONDS':
      if (!Number.isFinite(n) || n <= 0) return raw;
      return n < 1 ? t('value_exposure_fraction', Math.round(1 / n)) : t('value_exposure_seconds', number(n, 1));
    case 'F_NUMBER': return Number.isFinite(n) ? t('value_f_number', number(n, 1)) : raw;
    case 'MILLIMETERS': return Number.isFinite(n) ? t('value_millimeters', number(n, 1)) : raw;
    case 'METERS': return Number.isFinite(n) ? t('value_meters', number(n, 1)) : raw;
    case 'ORIENTATION':
      return { 1: t('value_orientation_normal'), 3: t('value_orientation_180'), 6: t('value_orientation_90_cw'), 8: t('value_orientation_90_ccw') }[n]
        ?? t('value_orientation_code', n);
    default: return raw;
  }
}

export const sectionTitle = (section) => (section.key ? t(`section_${section.key.toLowerCase()}`) : section.title);
export const formatName = (format) => (format === 'UNKNOWN' ? t('format_unknown') : FORMAT_LABEL[format] ?? format);
export const severityTag = (severity) => t({ AI_EVIDENCE: 'severity_ai', CAUTION: 'severity_caution', INFO: 'severity_info' }[severity]);
export const severityEyebrow = (severity) => t({ AI_EVIDENCE: 'signal_eyebrow_ai', CAUTION: 'signal_eyebrow_caution', INFO: 'signal_eyebrow_info' }[severity]);

export function signalTitle(s) {
  const a = s.args ?? [];
  switch (s.kind) {
    case 'SD_PARAMETERS': return t('signal_sd_parameters_title');
    case 'COMFYUI_GRAPH': return t('signal_comfyui_title');
    case 'INVOKEAI_METADATA': return t('signal_invokeai_title');
    case 'AI_TOOL_FIELD': return t('signal_ai_tool_title', a[0]);
    case 'AI_MENTION_TEXT': return t('signal_ai_mention_title', a[0]);
    case 'IPTC_AI_SOURCE': return t('signal_iptc_title');
    case 'IPTC_AI_EDITED': return t('signal_iptc_edited_title');
    case 'C2PA_PRESENT': return t('signal_c2pa_title');
    case 'C2PA_AI_CREATED': return a[0] ? t('signal_c2pa_ai_title_generator', a[0]) : t('signal_c2pa_ai_title');
    case 'C2PA_AI_EDITED': return a[0] ? t('signal_c2pa_ai_edited_title_generator', a[0]) : t('signal_c2pa_ai_edited_title');
    case 'GENERATION_PARAMS': return t('signal_generation_params_title');
    case 'MESSENGER_COPY': return t('signal_messenger_title', a[0]);
    case 'SCREENSHOT': return t('signal_screenshot_title');
    case 'HAS_GPS': return t('signal_gps_title');
    case 'NO_METADATA': return t('signal_no_metadata_title');
    case 'PARTIAL_SCAN': return t('signal_partial_title');
    case 'NO_AI_TRACES': return t('signal_no_ai_title');
    default: return s.title ?? '';
  }
}

export function signalDetail(s) {
  const a = s.args ?? [];
  switch (s.kind) {
    case 'SD_PARAMETERS': return t('signal_sd_parameters_detail');
    case 'COMFYUI_GRAPH': return t('signal_comfyui_detail', a[0]);
    case 'INVOKEAI_METADATA': return t('signal_invokeai_detail', a[0]);
    case 'AI_TOOL_FIELD': return t('signal_ai_tool_detail', a[1], a[2]);
    case 'AI_MENTION_TEXT': return t('signal_ai_mention_detail', a[1], a[2]);
    case 'IPTC_AI_SOURCE': return t('signal_iptc_detail', a[0]);
    case 'IPTC_AI_EDITED': return t('signal_iptc_edited_detail', a[0]);
    case 'C2PA_PRESENT':
      if (a[1] === C2PA_UNREADABLE) return t('signal_c2pa_unreadable_detail');
      return a[0] ? t('signal_c2pa_detail_generator', a[0]) : t('signal_c2pa_detail');
    case 'C2PA_AI_CREATED': return t('signal_c2pa_ai_detail');
    case 'C2PA_AI_EDITED': return t('signal_c2pa_ai_edited_detail');
    case 'GENERATION_PARAMS': return t('signal_generation_params_detail', a[0]);
    case 'MESSENGER_COPY': return t('signal_messenger_detail', a[0]);
    case 'SCREENSHOT': return t('signal_screenshot_detail');
    case 'HAS_GPS': return t('signal_gps_detail');
    case 'NO_METADATA': return t('signal_no_metadata_detail');
    case 'PARTIAL_SCAN': return t('signal_partial_detail');
    case 'NO_AI_TRACES': return t('signal_no_ai_detail');
    default: return s.detail ?? '';
  }
}

const FAILURE_RESOURCES = {
  UNSUPPORTED_FORMAT: 'error_unsupported_format', UNSUPPORTED_IMAGE: 'failure_unsupported_image', EDIT_JPEG_ONLY: 'failure_edit_jpeg_only',
  WIPE_GPS_UNSUPPORTED: 'failure_wipe_gps_jpeg_png_only', GPS_NOT_REMOVED: 'failure_gps_not_removed', NO_DATE_TO_SHIFT: 'failure_no_date_to_shift',
  VIDEO_UNSUPPORTED: 'failure_video_unsupported', CLEAN_CHECK_FAILED: 'failure_clean_check_failed', EMPTY_RESULT: 'failure_empty_result',
  EDIT_UNVERIFIED: 'failure_edit_unverified', DECODE_FAILED: 'failure_decode_failed', ENCODE_FAILED: 'failure_encode_failed',
  PRO_REQUIRED: 'error_pro_required', BATCH_SIZE: 'failure_batch_size', OUT_OF_MEMORY: 'failure_out_of_memory',
};
const PATCH_FIELDS = { MAKE: 'patch_field_make', MODEL: 'patch_field_model', AUTHOR: 'patch_field_author', COPYRIGHT: 'patch_field_copyright',
  DESCRIPTION: 'patch_field_description', DATE_TAKEN: 'patch_field_date_taken', DATE_DIGITIZED: 'patch_field_date_digitized' };

export function patchIssueText(issue) {
  const field = t(PATCH_FIELDS[issue.field] ?? 'patch_field_unknown');
  const key = `patch_${issue.code.toLowerCase()}`;
  return ['TEXT_INVALID', 'TEXT_NOT_ASCII', 'DATE_FORMAT'].includes(issue.code) ? t(key, field) : t(key);
}

/** A message for any error thrown by the core or the browser. */
export function errorText(error) {
  if (error?.issues?.length) return patchIssueText(error.issues[0]);
  if (error?.code === 'DAILY_LIMIT') return t('error_daily_limit', error.limit);
  if (error?.code === 'TOO_LARGE') return t('web_too_large', error.limitMb);
  const resource = FAILURE_RESOURCES[error?.code];
  if (resource) return t(resource);
  if (error instanceof RangeError || /memory|allocation/i.test(String(error?.message))) return t('failure_out_of_memory');
  return t('error_operation_failed', t('error_generic'));
}

export const licenseErrorText = (code) => t({ NOT_ENABLED: 'license_error_not_enabled', MALFORMED: 'license_error_malformed',
  BAD_SIGNATURE: 'license_error_bad_signature', EXPIRED: 'license_error_expired' }[code] ?? 'license_error_malformed');

export const exposureKindText = (kind) => t(`privacy_kind_${kind.toLowerCase()}`);
export const exposureLevelText = (level) => t(`privacy_level_${level.toLowerCase()}`);
