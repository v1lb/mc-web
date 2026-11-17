// Metadata studio: cleaning, the EXIF editor for JPEG and batch tools.

import { h, append, clear, icon, saveBlob, pickFiles, MEDIA_ACCEPT } from './dom.js';
import { state, actions } from './state.js';
import { cleanAndSave, removeGpsAndSave } from './report.js';
import { quotaText } from './app.js';
import { schematicMap } from './map.js';
import { t, fileSize } from '../i18n.js';
import { formatName, errorText, patchIssueText, itemValue } from '../texts.js';
import { analyzeFile } from '../core/analyze.js';
import { validatePatch, editableFields, shiftSeconds } from '../core/edit.js';
import { isVideo } from '../core/format.js';
import { hasLocationMarkers } from '../core/privacy.js';
import { entitlement, usedToday, perRun, FREE_DAILY_LIMIT, FREE_PER_RUN, PRO_PER_RUN } from '../store.js';
import { editFile, cleanBatch, shiftBatch, auditFolder, MAX_AUDIT_FILES } from '../ops.js';

const TEXT_FIELDS = [
  ['make', 'patch_field_make'], ['model', 'studio_field_camera_model'], ['author', 'patch_field_author'],
  ['copyright', 'patch_field_copyright'], ['description', 'patch_field_description'],
];
const NUMBER_FIELDS = [['iso', 'studio_field_iso'], ['aperture', 'studio_field_aperture'], ['exposureSeconds', 'studio_field_shutter']];

/** Form values kept while the visitor moves between tabs and pages. */
const form = { removeGps: false, values: {} };

async function chooseSource() {
  const [file] = await pickFiles({ accept: MEDIA_ACCEPT });
  if (file) actions.checkFile(file).then(() => actions.navigate('#/studio'));
}

function sourceCard(current) {
  const zone = h('section', { class: 'card source', dataset: { drop: 'source' } });
  zone.addEventListener('files', (e) => { if (e.detail[0]) actions.checkFile(e.detail[0]).then(() => actions.navigate('#/studio')); });
  if (!current?.file) {
    zone.append(h('p', { class: 'eyebrow' }, t('studio_source_eyebrow')), h('p', { class: 'card-lead' }, t('studio_source_none')),
      h('p', { class: 'muted' }, t('web_studio_drop')),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: chooseSource }, t('web_studio_choose')));
    return zone;
  }
  const f = current.report.file;
  zone.append(h('div', { class: 'card-row' },
    h('div', { class: 'source-info' },
      h('p', { class: 'eyebrow' }, t('studio_source_eyebrow')),
      h('p', { class: 'card-lead source-name', title: f.name }, f.name || t('common_unnamed')),
      h('p', { class: 'mono small muted' }, `${formatName(f.format)} · ${fileSize(f.sizeBytes)}`)),
    h('div', { class: 'row' },
      h('a', { class: 'btn btn-ghost', href: '#/report' }, t('studio_back_to_report')),
      h('button', { class: 'btn', type: 'button', onclick: chooseSource }, t('web_studio_choose')))));
  return zone;
}

// --- Cleaning ---

function stripTab(current) {
  if (!current?.file) return h('p', { class: 'empty' }, t('studio_batch_choose_files_first'));
  const { file, report } = current;
  const video = isVideo(report.file.format);
  return h('section', { class: 'card' },
    h('p', { class: 'eyebrow' }, t('studio_strip_eyebrow')),
    h('h2', {}, t('studio_strip_title')),
    h('p', {}, t('studio_strip_text')),
    video ? h('p', { class: 'note' }, t('web_studio_video_note')) : null,
    h('div', { class: 'row' },
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => cleanAndSave(file) }, t('studio_strip_save_copy'), video && !entitlement.isPro ? h('span', { class: 'tag' }, 'PRO') : null),
      !video && hasLocationMarkers(report) ? h('button', { class: 'btn', type: 'button', onclick: () => removeGpsAndSave(file) }, t('web_gps_only')) : null,
      navigator.canShare ? h('button', { class: 'btn', type: 'button', onclick: () => cleanAndSave(file, { share: true }) }, t('web_share_clean')) : null));
}

// --- EXIF editor ---

function buildPatch() {
  const v = form.values;
  const text = (key) => (v[key]?.trim() ? v[key].trim() : null);
  const num = (key) => (v[key]?.trim() ? Number(v[key].trim().replace(',', '.')) : null);
  const patch = { removeGps: form.removeGps, latitude: num('latitude'), longitude: num('longitude'),
    dateTaken: text('dateTaken'), dateDigitized: text('dateDigitized'), iso: num('iso'), aperture: num('aperture'), exposureSeconds: num('exposureSeconds') };
  for (const [key] of TEXT_FIELDS) patch[key] = text(key);
  for (const key of Object.keys(patch)) if (patch[key] == null || patch[key] === false) delete patch[key];
  return patch;
}

function pickOnGrid(apply) {
  let picked = null;
  const label = h('p', { class: 'mono' }, t('map_tap_to_pick'));
  actions.dialog(t('studio_grid_title'), (close) => [
    h('p', { class: 'muted' }, t('studio_grid_text')),
    h('div', { class: 'map-frame map-frame-wide' }, schematicMap({ onPick: (p) => {
      picked = p;
      label.textContent = t('studio_grid_point', p.latitude.toFixed(4), p.longitude.toFixed(4));
    } })),
    label,
    h('div', { class: 'row' }, h('button', { class: 'btn btn-primary', type: 'button', onclick: () => { if (picked) apply(picked); close(null); } }, t('studio_grid_use'))),
  ]);
}

function editTab(current, redraw) {
  if (!current?.file) return h('p', { class: 'empty' }, t('studio_batch_choose_files_first'));
  if (current.report.file.format !== 'JPEG') return h('p', { class: 'note' }, t('web_edit_jpeg_only'));
  const now = current.exif ? editableFields(current.exif) : {};
  const shown = (key) => {
    if (now[key] == null) return null;
    if (key === 'aperture') return itemValue({ value: now[key], format: 'F_NUMBER' });
    if (key === 'exposureSeconds') return itemValue({ value: now[key], format: 'EXPOSURE_SECONDS' });
    return now[key];
  };
  const errors = h('ul', { class: 'form-error', role: 'alert' });
  const field = (key, label, { placeholder = '', mode = 'text', mono = false } = {}) => {
    const input = h('input', { class: `input${mono ? ' mono' : ''}`, type: 'text', inputMode: mode, value: form.values[key] ?? '',
      placeholder: placeholder || t('studio_field_keep'), autocomplete: 'off', oninput: (e) => { form.values[key] = e.target.value; } });
    return h('label', { class: 'field' }, h('span', { class: 'label' }, label), input,
      shown(key) != null ? h('span', { class: 'hint mono' }, t('web_edit_current', shown(key))) : null);
  };
  const latitude = field('latitude', t('studio_field_latitude'), { mode: 'decimal', mono: true });
  const longitude = field('longitude', t('studio_field_longitude'), { mode: 'decimal', mono: true });
  const removeGps = h('input', { type: 'checkbox', checked: form.removeGps, onchange: (e) => { form.removeGps = e.target.checked; } });

  const save = async () => {
    clear(errors);
    const patch = buildPatch();
    if ([patch.latitude, patch.longitude, patch.iso, patch.aperture, patch.exposureSeconds].some((n) => n != null && !Number.isFinite(n))) {
      errors.append(h('li', {}, t('studio_check_numbers')));
      return;
    }
    const issues = validatePatch(patch);
    if (issues.length) { append(errors, issues.map((i) => h('li', {}, patchIssueText(i)))); return; }
    const result = await actions.run(() => editFile(current.file, patch));
    if (!result) return;
    saveBlob(result.blob, result.name);
    actions.toast(`${t('studio_msg_exif_saved')} ${t(result.verified ? 'studio_msg_verified' : 'studio_msg_not_verified')}`, result.verified ? 'ok' : 'error');
  };
  const copyFrom = async () => {
    const [other] = await pickFiles({ accept: 'image/*,.heic,.heif' });
    if (!other) return;
    try {
      const { exif } = await analyzeFile(other);
      const fields = exif ? editableFields(exif) : {};
      const count = Object.keys(fields).length;
      if (!count) { actions.toast(t('studio_copy_none')); return; }
      Object.assign(form.values, fields);
      form.removeGps = false;
      actions.toast(t('studio_copy_done', count), 'ok');
      redraw();
    } catch (e) { actions.toast(errorText(e), 'error'); }
  };
  const reset = () => { form.values = {}; form.removeGps = false; redraw(); };

  return h('div', { class: 'stack' },
    h('section', { class: 'card' },
      h('h2', {}, t('studio_edit_gps_title')),
      h('label', { class: 'check' }, removeGps, h('span', {}, t('studio_edit_remove_gps'))),
      h('div', { class: 'fields fields-2' }, latitude, longitude),
      h('button', { class: 'btn', type: 'button', onclick: () => pickOnGrid((p) => {
        form.values.latitude = p.latitude.toFixed(6); form.values.longitude = p.longitude.toFixed(6); form.removeGps = false; redraw();
      }) }, icon('pin'), t('studio_pick_on_grid'))),
    h('section', { class: 'card' },
      h('h2', {}, t('studio_edit_dates_title')),
      h('div', { class: 'fields fields-2' },
        field('dateTaken', t('studio_field_date_taken'), { placeholder: t('web_edit_date_placeholder'), mono: true }),
        field('dateDigitized', t('studio_field_date_digitized'), { placeholder: t('web_edit_date_placeholder'), mono: true }))),
    h('section', { class: 'card' },
      h('h2', {}, t('studio_edit_camera_title')),
      h('div', { class: 'fields fields-2' }, TEXT_FIELDS.map(([key, label]) => field(key, t(label)))),
      h('div', { class: 'fields fields-3' }, NUMBER_FIELDS.map(([key, label]) => field(key, t(label), { mode: 'decimal', mono: true })))),
    h('p', { class: 'muted small' }, t('studio_edit_note')),
    errors,
    h('div', { class: 'row' },
      h('button', { class: 'btn btn-primary', type: 'button', onclick: save }, t('studio_edit_save_copy')),
      h('button', { class: 'btn', type: 'button', onclick: copyFrom }, t('studio_copy_from_photo')),
      h('button', { class: 'btn btn-ghost', type: 'button', onclick: reset }, t('web_edit_reset'))));
}

// --- Batch ---

let audit = null;
let shift = { negative: false, hours: '', minutes: '' };

function batchTab(redraw) {
  const files = state.batchFiles;
  const limit = perRun();
  const run = files.slice(0, Math.max(0, limit));
  const progress = h('p', { class: 'mono small', role: 'status' });
  const errorList = h('div', {});
  const onProgress = (p) => { progress.textContent = t('studio_batch_progress', p.completed, p.total, p.succeeded, p.failed); };
  const showErrors = (errors) => {
    clear(errorList);
    if (!errors.length) return;
    errorList.append(h('p', { class: 'eyebrow eyebrow-signal' }, t('studio_batch_errors')),
      h('ul', { class: 'plain' }, errors.slice(0, 20).map((e) => h('li', { class: 'small' }, t('studio_batch_file_error', e.file, errorText(e.error))))));
  };
  const add = (list) => { state.batchFiles = [...files, ...list].slice(0, 500); audit = null; redraw(); };
  const zone = h('section', { class: 'card', dataset: { drop: 'batch' } });
  zone.addEventListener('files', (e) => add(e.detail));

  const start = async () => {
    if (!run.length) { if (files.length) { actions.toast(t('pro_limit_reached', usedToday())); actions.openPro(); } else actions.toast(t('studio_batch_choose_files_first')); return; }
    const result = await actions.run(() => cleanBatch(run, onProgress));
    if (!result) return;
    if (result.zip) saveBlob(result.zip, 'metacheck-clean.zip');
    actions.toast(t('studio_msg_batch_done', result.succeeded, result.failed), result.failed ? 'error' : 'ok');
    showErrors(result.errors);
    state.batchFiles = files.slice(run.length);
    if (!result.failed) redraw();
  };

  append(zone,
    h('h2', {}, t('studio_batch_title')),
    h('p', {}, t('studio_batch_text')),
    h('p', { class: 'muted small' }, t('studio_batch_free_note', FREE_PER_RUN, PRO_PER_RUN)),
    h('div', { class: 'row' },
      h('button', { class: 'btn', type: 'button', onclick: async () => add(await pickFiles({ accept: MEDIA_ACCEPT, multiple: true })) }, t('studio_batch_choose_photos')),
      files.length ? h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { state.batchFiles = []; audit = null; redraw(); } }, t('web_batch_clear')) : null),
    h('p', { class: 'mono' }, t('studio_batch_selected', files.length), files.length ? ` · ${t('studio_batch_run_size', run.length)}` : ''),
    files.length ? h('ul', { class: 'file-list' }, files.slice(0, 12).map((f, i) => h('li', { class: i < run.length ? '' : 'is-waiting' },
      h('span', { class: 'file-name' }, f.name), h('span', { class: 'mono small muted' }, fileSize(f.size)))),
    files.length > 12 ? h('li', { class: 'muted small' }, t('studio_audit_more', files.length - 12)) : null) : h('p', { class: 'muted' }, t('web_batch_drop')),
    !entitlement.isPro && files.length > run.length ? h('p', { class: 'note' }, t('web_batch_limit_free', run.length), ' ',
      h('button', { class: 'link', type: 'button', onclick: actions.openPro }, t('studio_batch_upgrade'))) : null,
    h('button', { class: 'btn btn-primary', type: 'button', onclick: start }, t('web_batch_start')),
    progress, errorList);

  // Folder audit
  const auditStatus = h('p', { class: 'mono small', role: 'status' });
  const runAudit = async () => {
    const list = await pickFiles({ directory: true, multiple: true });
    if (!list.length) return;
    const result = await actions.run(() => auditFolder(list, (n) => { auditStatus.textContent = t('studio_audit_running', n); }));
    if (!result) { auditStatus.textContent = t('studio_audit_failed'); return; }
    audit = result;
    state.batchFiles = result.findings.map((f) => f.file);
    redraw();
  };
  const tags = (f) => [f.location && ['studio_audit_tag_location', 'badge-signal'], f.serial && ['studio_audit_tag_serial', 'badge-caution'],
    f.person && ['studio_audit_tag_person', 'badge-caution'], f.risk === 0 && ['studio_audit_tag_other', '']].filter(Boolean);
  const auditCard = h('section', { class: 'card' },
    h('h2', {}, t('studio_audit_button')),
    h('p', {}, t('dash_audit_text')),
    h('p', { class: 'muted small' }, t('studio_audit_hint')),
    h('button', { class: 'btn', type: 'button', onclick: runAudit }, t('web_batch_folder')),
    auditStatus,
    audit ? [
      h('p', { class: 'card-lead' }, t('studio_audit_summary', audit.scanned)),
      audit.findings.length ? h('ul', { class: 'plain audit-summary' },
        h('li', {}, t('studio_audit_location', audit.findings.filter((f) => f.location).length)),
        h('li', {}, t('studio_audit_serial', audit.findings.filter((f) => f.serial).length)),
        h('li', {}, t('studio_audit_person', audit.findings.filter((f) => f.person).length)),
        h('li', {}, t('studio_audit_other', audit.findings.filter((f) => f.risk === 0).length))) : h('p', {}, t('studio_audit_clean_none')),
      audit.limited ? h('p', { class: 'note' }, t('studio_audit_limited', MAX_AUDIT_FILES)) : null,
      audit.findings.length ? [h('p', { class: 'eyebrow' }, t('studio_audit_list_title')), h('p', { class: 'muted small' }, t('studio_audit_list_hint'), ' ', t('studio_audit_selected')),
        h('ul', { class: 'file-list' }, audit.findings.slice(0, 30).map((f) => h('li', {},
          h('button', { class: 'link file-name', type: 'button', onclick: () => actions.checkFile(f.file) }, f.name),
          h('span', { class: 'badges' }, tags(f).map(([key, cls]) => h('span', { class: `badge ${cls}` }, t(key)))))),
        audit.findings.length > 30 ? h('li', { class: 'muted small' }, t('studio_audit_more', audit.findings.length - 30)) : null)] : null,
    ] : null);

  // Date shift
  const shiftStatus = h('p', { class: 'mono small', role: 'status' });
  const runShift = async () => {
    if (!entitlement.isPro) { actions.toast(t('studio_shift_pro')); actions.openPro(); return; }
    const seconds = shiftSeconds(shift.negative, shift.hours, shift.minutes);
    if (seconds == null) { actions.toast(t('studio_shift_invalid'), 'error'); return; }
    if (!files.length) { actions.toast(t('studio_batch_choose_files_first')); return; }
    const result = await actions.run(() => shiftBatch(files.slice(0, PRO_PER_RUN), seconds, (p) => { shiftStatus.textContent = t('studio_batch_progress', p.completed, p.total, p.succeeded, p.failed); }));
    if (!result) return;
    if (result.zip) saveBlob(result.zip, 'metacheck-dates.zip');
    actions.toast(t('studio_msg_shift_done', result.succeeded, result.failed), result.failed ? 'error' : 'ok');
    showErrors(result.errors);
  };
  const shiftCard = h('section', { class: 'card' },
    h('h2', {}, t('studio_shift_title'), entitlement.isPro ? null : h('span', { class: 'tag' }, 'PRO')),
    h('p', {}, t('studio_shift_text')),
    h('div', { class: 'fields fields-3' },
      h('label', { class: 'field' }, h('span', { class: 'label' }, '±'),
        h('select', { class: 'input', onchange: (e) => { shift.negative = e.target.value === '-'; } },
          h('option', { value: '+', selected: !shift.negative }, t('web_shift_later')), h('option', { value: '-', selected: shift.negative }, t('web_shift_earlier')))),
      h('label', { class: 'field' }, h('span', { class: 'label' }, t('studio_shift_hours')),
        h('input', { class: 'input mono', type: 'text', inputMode: 'numeric', value: shift.hours, placeholder: '0', oninput: (e) => { shift.hours = e.target.value; } })),
      h('label', { class: 'field' }, h('span', { class: 'label' }, t('studio_shift_minutes')),
        h('input', { class: 'input mono', type: 'text', inputMode: 'numeric', value: shift.minutes, placeholder: '0', oninput: (e) => { shift.minutes = e.target.value; } }))),
    h('button', { class: 'btn', type: 'button', onclick: runShift }, t('web_shift_run')),
    shiftStatus);

  return h('div', { class: 'stack' }, zone, h('div', { class: 'two-col' }, auditCard, shiftCard));
}

export function studioView() {
  const current = state.current;
  const tabs = [['strip', t('studio_tab_strip')], ['edit', t('studio_tab_edit')], ['batch', t('studio_tab_batch')]];
  const panel = h('div', { class: 'tab-panel' });
  const tabBar = h('div', { class: 'tabs', role: 'tablist' });
  const draw = () => {
    append(clear(tabBar),tabs.map(([id, label]) => h('button', { type: 'button', role: 'tab', class: `tab${state.studioTab === id ? ' is-on' : ''}`,
      'aria-selected': String(state.studioTab === id), onclick: () => { state.studioTab = id; draw(); } }, label)));
    clear(panel).append(state.studioTab === 'edit' ? editTab(current, draw) : state.studioTab === 'batch' ? batchTab(draw) : stripTab(current));
  };
  draw();
  return [
    h('header', { class: 'page-head' },
      h('p', { class: 'eyebrow', dataset: { quota: '' } }, quotaText()),
      h('h1', {}, t('studio_title')),
      h('p', { class: 'lead' }, t('studio_subtitle'))),
    sourceCard(current),
    tabBar, panel,
  ];
}
