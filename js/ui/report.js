// Report page: verdict, privacy index, signals, metadata viewer, map and actions.

import { h, append, clear, icon, saveBlob } from './dom.js';
import { state, actions } from './state.js';
import { chooseAndCheck } from './app.js';
import { schematicMap, tileMap } from './map.js';
import { t, plural, fileSize, dateTime, number } from '../i18n.js';
import { formatName, signalTitle, signalDetail, severityEyebrow, exposureKindText, exposureLevelText } from '../texts.js';
import { catalog, filterCatalog, GROUPS, GROUP_MARKER, groupTitle, reportText, reportBlocks, reportJson, metadataCsv } from '../report.js';
import { hasAiEvidence, needsAiReview, actionableSignalCount, privacyExposure, hasLocationMarkers } from '../core/privacy.js';
import { isVideo } from '../core/format.js';
import { settings, saveSettings, entitlement, FREE_DAILY_LIMIT } from '../store.js';
import { cleanFile, removeGps } from '../ops.js';

const LONG_VALUE = 280;

// --- Actions ---

function announceClean(result) {
  const notes = [t('web_clean_done', result.name)];
  if (result.reencoded) notes.push(t('web_reencoded'));
  else if (result.removedBytes > 0) notes.push(t('web_clean_removed', fileSize(result.removedBytes)));
  else if (result.format === 'HEIC' || result.format === 'AVIF') notes.push(t('web_clean_same_size'));
  if (result.removedTracks) notes.push(t('web_video_tracks_removed', result.removedTracks));
  notes.push(t('studio_msg_share_copy'));
  actions.toast(notes.join(' · '), 'ok');
}

export async function cleanAndSave(file, { share = false } = {}) {
  const result = await actions.run(() => cleanFile(file));
  if (!result) return;
  if (share) {
    const shared = new File([result.blob], result.name, { type: result.blob.type });
    if (navigator.canShare?.({ files: [shared] })) {
      try { await navigator.share({ files: [shared] }); return; } catch (e) { if (e?.name === 'AbortError') return; }
    }
  }
  saveBlob(result.blob, result.name);
  announceClean(result);
}

export async function removeGpsAndSave(file) {
  const result = await actions.run(() => removeGps(file));
  if (!result) return;
  saveBlob(result.blob, result.name);
  if (result.removedBytes !== undefined) announceClean(result);
  else actions.toast(`${t('studio_msg_gps_removed')} ${t('studio_msg_share_copy')}`, 'ok');
}

function requirePro() {
  if (entitlement.isPro) return true;
  actions.toast(t('main_msg_export_pro_only'));
  actions.openPro();
  return false;
}

function printReport(report) {
  if (!requirePro()) return;
  const sheet = h('div', { class: 'print-sheet' }, reportBlocks(report).map((b, i) =>
    h(b.heading ? (i === 0 ? 'h1' : 'h2') : 'p', {}, b.text)), h('p', { class: 'print-foot' }, t('web_print_footer')));
  const host = document.getElementById('print-root');
  clear(host).append(sheet);
  window.print();
}

function exportJson(report) {
  if (!requirePro()) return;
  const json = JSON.stringify(reportJson(report, { withTexts: true }), null, 2);
  saveBlob(new Blob([json], { type: 'application/json' }), `${report.file.name || 'report'}.metacheck.json`);
  actions.toast(t('main_msg_json_saved'), 'ok');
}

async function copyReport(report) {
  try { await navigator.clipboard.writeText(reportText(report)); actions.toast(t('main_msg_report_copied'), 'ok'); }
  catch { actions.toast(t('main_msg_operation_failed'), 'error'); }
}

async function sendToApi(report) {
  if (!entitlement.isPro) { actions.toast(t('main_api_pro_only')); actions.openPro(); return; }
  let host;
  try { host = new URL(settings.apiEndpoint).host; } catch { actions.toast(t('api_error_bad_settings'), 'error'); return; }
  const ok = await actions.confirm({ title: t('main_api_confirm_title'), confirmLabel: t('main_api_send'),
    text: t(settings.apiSendGps ? 'main_api_confirm_text_with_gps' : 'main_api_confirm_text_without_gps', host || t('main_api_unknown_server')) });
  if (!ok) return;
  const body = JSON.stringify(reportJson(report, { includeGps: settings.apiSendGps, withTexts: true }));
  const headers = { 'Content-Type': 'application/json' };
  if (settings.apiKey && settings.apiHeaderName) headers[settings.apiHeaderName] = settings.apiKey;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  actions.toast(t('main_api_waiting'));
  let response;
  try {
    const res = await fetch(settings.apiEndpoint, { method: 'POST', headers, body, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal });
    response = { status: res.status, text: (await res.text()).slice(0, 4000) };
  } catch (e) {
    actions.toast(`${t(e?.name === 'AbortError' ? 'api_error_timeout' : 'api_error_request_failed')} ${t('web_api_cors')}`, 'error');
    return;
  } finally { clearTimeout(timer); }
  actions.dialog(t('main_api_dialog_title'), [h('p', { class: 'mono' }, t('web_api_test_sent', response.status)),
    h('pre', { class: 'pre' }, response.text || t('main_api_empty_response'))], [[t('common_close'), null, 'btn-primary']]);
}

// --- Blocks ---

function preview(current) {
  if (!current.previewUrl) return h('div', { class: 'preview preview-empty' }, icon('file', 32), h('span', {}, t('result_preview_not_stored')));
  const fallback = () => frame.replaceChildren(icon('file', 32), h('span', {}, t('result_preview_unavailable')));
  const frame = h('div', { class: 'preview' });
  if (isVideo(current.report.file.format)) {
    frame.append(h('video', { src: current.previewUrl, controls: true, preload: 'metadata', muted: true, onerror: () => { frame.classList.add('preview-empty'); fallback(); } }));
  } else {
    frame.append(h('img', { src: current.previewUrl, alt: t('result_preview_description', current.report.file.name), onerror: () => { frame.classList.add('preview-empty'); fallback(); } }));
  }
  return frame;
}

function fact(label, value) {
  return h('div', { class: 'fact' }, h('dt', {}, label), h('dd', {}, value));
}

function sidebar(current, exposure) {
  const { report, file } = current;
  const f = report.file;
  const video = isVideo(f.format);
  const canGps = file && hasLocationMarkers(report) && !video;
  return h('aside', { class: 'report-side' },
    preview(current),
    h('dl', { class: 'facts' },
      fact(t('field_name'), f.name || t('common_unnamed')),
      fact(t('field_format'), formatName(f.format)),
      fact(t('web_file_size'), f.sizeBytes >= 0 ? fileSize(f.sizeBytes) : '—'),
      fact(t('field_mime'), f.mimeType || t('common_unknown')),
      f.truncated ? fact(t('web_file_read'), fileSize(f.scannedBytes)) : null,
      current.fromHistory && current.createdAt ? fact(t('web_report_no'), dateTime(current.createdAt)) : null),
    h('div', { class: 'actions' },
      h('p', { class: 'eyebrow' }, t('result_section_actions')),
      file ? h('button', { class: 'btn btn-primary btn-block', type: 'button', onclick: () => cleanAndSave(file) },
        video ? t('gps_shield_action_video') : t('result_action_clean')) : null,
      canGps ? h('button', { class: 'btn btn-block', type: 'button', onclick: () => removeGpsAndSave(file) }, t('web_gps_only')) : null,
      file && !video ? h('a', { class: 'btn btn-block', href: '#/studio' }, t('result_action_edit')) : null,
      file ? null : h('p', { class: 'muted small' }, t('web_no_file_actions')),
      h('button', { class: 'btn btn-block', type: 'button', onclick: () => copyReport(report) }, t('result_action_copy')),
      h('button', { class: 'btn btn-block', type: 'button', onclick: () => printReport(report) }, t('result_action_pdf'), entitlement.isPro ? null : h('span', { class: 'tag' }, 'PRO')),
      h('button', { class: 'btn btn-block', type: 'button', onclick: () => exportJson(report) }, t('result_action_json'), entitlement.isPro ? null : h('span', { class: 'tag' }, 'PRO')),
      settings.apiEnabled ? h('button', { class: 'btn btn-block', type: 'button', onclick: () => sendToApi(report) }, t('result_action_api'), entitlement.isPro ? null : h('span', { class: 'tag' }, 'PRO')) : null),
    h('p', { class: 'muted small' }, t('result_footer_original')));
}

function verdict(report) {
  const ai = hasAiEvidence(report);
  const review = needsAiReview(report);
  const tone = ai ? 'signal' : review ? 'caution' : 'clean';
  return h('section', { class: `verdict verdict-${tone}` },
    h('p', { class: 'eyebrow' }, t('result_eyebrow_engine')),
    h('h2', { class: 'verdict-title' }, t(ai ? 'result_verdict_ai' : review ? 'result_verdict_attention' : 'result_verdict_clean')),
    h('p', { class: 'muted' }, t('result_metadata_only')),
    h('dl', { class: 'metrics' },
      h('div', {}, h('dt', {}, t('result_metric_signals')), h('dd', {}, String(actionableSignalCount(report)))),
      h('div', {}, h('dt', {}, t('result_metric_exif_groups')), h('dd', {}, String(report.exifSections.length))),
      h('div', {}, h('dt', {}, t('result_metric_format')), h('dd', {}, formatName(report.file.format)))),
    h('p', { class: 'small' }, t('result_disclaimer')));
}

function privacyCard(current, exposure) {
  const { file } = current;
  const count = exposure.items.length;
  const tone = { NONE: 'clean', LOW: 'clean', MEDIUM: 'caution', HIGH: 'signal' }[exposure.level];
  const meter = h('div', { class: 'meter', role: 'img', 'aria-label': t('privacy_score_description', exposure.score) }, h('span', { class: 'meter-fill' }));
  meter.firstChild.style.width = `${exposure.score}%`;
  return h('section', { class: `card privacy privacy-${tone}` },
    h('div', { class: 'privacy-head' },
      h('div', {},
        h('p', { class: 'eyebrow' }, t('privacy_title')),
        h('h3', {}, exposureLevelText(exposure.level)),
        h('p', { class: 'muted' }, count ? t('privacy_hint') : t('privacy_none_text'))),
      h('div', { class: `stamp stamp-${tone}`, 'aria-hidden': 'true' },
        h('span', {}, t('stamp_reveals')), h('strong', {}, count ? plural('stamp_facts', count) : t('stamp_nothing')))),
    count ? [meter, h('p', { class: 'mono small meter-caption' }, `${exposure.score} / 100`),
      h('ul', { class: 'exposures' }, exposure.items.map((item) => h('li', {},
        h('span', { class: 'exposure-kind' }, exposureKindText(item.kind)),
        h('span', { class: 'exposure-value mono' }, item.value || t('privacy_value_present')))))] : null,
    count && file ? h('div', { class: 'row' },
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => cleanAndSave(file) }, t('privacy_clean_save')),
      navigator.canShare ? h('button', { class: 'btn', type: 'button', onclick: () => cleanAndSave(file, { share: true }) }, t('privacy_clean_share')) : null) : null);
}

function gpsShield(current) {
  const { report, file } = current;
  if (!hasLocationMarkers(report)) return null;
  const video = isVideo(report.file.format);
  const point = report.gps != null;
  return h('section', { class: 'card shield' },
    h('p', { class: 'eyebrow eyebrow-caution' }, t('gps_shield_eyebrow')),
    h('h3', {}, t(point ? (video ? 'gps_shield_title_point_video' : 'gps_shield_title_point') : (video ? 'gps_shield_title_tags_video' : 'gps_shield_title_tags'))),
    h('p', {}, t(point ? 'gps_shield_text_point' : 'gps_shield_text_tags')),
    point ? h('p', { class: 'mono shield-point' }, `${report.gps.latitude.toFixed(6)}°, ${report.gps.longitude.toFixed(6)}°`) : h('p', { class: 'muted small' }, t('gps_shield_partial')),
    h('p', { class: 'muted small' }, t('gps_shield_not_tracking')),
    file ? [h('button', { class: 'btn btn-primary', type: 'button', onclick: () => (video ? cleanAndSave(file) : removeGpsAndSave(file)) },
      icon('shield'), t(video ? 'gps_shield_action_video' : 'gps_shield_action')),
    h('p', { class: 'muted small' }, video ? t('gps_shield_action_note_video') : t('gps_shield_action_note', FREE_DAILY_LIMIT))]
      : h('p', { class: 'muted small' }, t('gps_shield_open_original')));
}

function signals(report) {
  return h('section', {},
    h('p', { class: 'eyebrow section-eyebrow' }, t('result_section_signals')),
    h('ul', { class: 'signals' }, report.signals.map((s) => h('li', { class: `signal signal-${s.severity.toLowerCase()}` },
      h('p', { class: 'eyebrow' }, severityEyebrow(s.severity)),
      h('h3', {}, signalTitle(s)),
      h('p', {}, signalDetail(s))))));
}

function valueCell(value) {
  if (value.length <= LONG_VALUE) return h('td', { class: 'value' }, value);
  const text = h('span', {}, `${value.slice(0, LONG_VALUE)}…`);
  let open = false;
  const toggle = h('button', { class: 'link small', type: 'button', onclick: () => {
    open = !open;
    text.textContent = open ? value : `${value.slice(0, LONG_VALUE)}…`;
    toggle.textContent = t(open ? 'web_show_less' : 'web_show_more');
  } }, t('web_show_more'));
  return h('td', { class: 'value' }, text, ' ', toggle);
}

function metadataTab(report) {
  const records = catalog(report);
  let group = null;
  let query = '';
  const results = h('div', {});
  const found = h('span', { class: 'mono small' });
  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': t('viewer_title') });
  const search = h('input', { class: 'input', type: 'search', placeholder: t('viewer_search_placeholder'), 'aria-label': t('viewer_search_label'),
    oninput: (e) => { query = e.target.value; draw(); } });

  function draw() {
    const list = filterCatalog(records, group, query);
    found.textContent = t('viewer_found', list.length);
    append(clear(chips),
      h('button', { type: 'button', class: `chip${group == null ? ' is-on' : ''}`, 'aria-pressed': String(group == null), onclick: () => { group = null; draw(); } },
        t('viewer_group_all'), h('span', { class: 'chip-count' }, String(records.length))),
      GROUPS.filter((g) => records.some((r) => r.group === g)).map((g) =>
        h('button', { type: 'button', class: `chip${group === g ? ' is-on' : ''}`, 'aria-pressed': String(group === g), onclick: () => { group = g; draw(); } },
          groupTitle(g), h('span', { class: 'chip-count' }, String(records.filter((r) => r.group === g).length)))));
    clear(results);
    if (!list.length) {
      results.append(h('div', { class: 'empty' }, h('strong', {}, t('viewer_nothing_found')), h('span', {}, t('viewer_try_other_query')),
        h('button', { class: 'btn btn-small', type: 'button', onclick: () => { group = null; query = ''; search.value = ''; draw(); } }, t('viewer_reset_filters'))));
      return;
    }
    const sections = new Map();
    for (const r of list) {
      const id = `${r.group}\u0000${r.section}`;
      if (!sections.has(id)) sections.set(id, []);
      sections.get(id).push(r);
    }
    for (const rows of sections.values()) {
      results.append(h('section', { class: 'meta-section' },
        h('h3', { class: 'meta-title' }, h('span', { class: 'tag' }, GROUP_MARKER[rows[0].group]), rows[0].section),
        h('table', { class: 'table meta-table' }, h('tbody', {}, rows.map((r) => h('tr', {}, h('th', { scope: 'row' }, r.label), valueCell(r.value)))))));
    }
  }
  draw();
  const exportCsv = () => {
    saveBlob(new Blob([metadataCsv(filterCatalog(records, group, query))], { type: 'text/csv' }), `${report.file.name || 'metadata'}.csv`);
    actions.toast(t('main_msg_metadata_csv_saved'), 'ok');
  };
  return h('div', { class: 'tab-panel' },
    h('div', { class: 'viewer-head' }, h('div', {}, h('h2', {}, t('viewer_title')), h('p', { class: 'muted small' }, plural('viewer_field_count', records.length))),
      h('button', { class: 'btn btn-small', type: 'button', onclick: exportCsv }, t('viewer_export_csv'))),
    h('div', { class: 'viewer-tools' }, search, found),
    chips, results,
    h('p', { class: 'muted small' }, t('viewer_footer')));
}

function mapTab(report) {
  const gps = report.gps;
  if (!gps) return h('div', { class: 'tab-panel' }, h('div', { class: 'empty' }, icon('pin', 28), h('span', {}, t('result_no_gps'))));
  const coords = `${gps.latitude.toFixed(6)}, ${gps.longitude.toFixed(6)}`;
  const live = h('div', { class: 'map-live' });
  const showTiles = () => { saveSettings({ mapConsent: true }); clear(live).append(tileMap(gps)); };
  const consent = () => append(clear(live),
    h('p', { class: 'mono small' }, t('map_off')),
    h('p', { class: 'muted small' }, t('map_consent', t('web_map_provider'))),
    h('button', { class: 'btn', type: 'button', onclick: showTiles }, t('map_show', t('web_map_provider'))));
  consent();
  const copy = async () => {
    try { await navigator.clipboard.writeText(coords); actions.toast(t('web_copied_coordinates'), 'ok'); } catch { actions.toast(t('main_msg_operation_failed'), 'error'); }
  };
  return h('div', { class: 'tab-panel' },
    h('section', { class: 'card' },
      h('p', { class: 'eyebrow' }, t('result_eyebrow_geolocation')),
      h('dl', { class: 'metrics' },
        h('div', {}, h('dt', {}, t('result_lat_lon')), h('dd', { class: 'mono' }, coords)),
        gps.altitudeMeters != null ? h('div', {}, h('dt', {}, t('result_altitude')), h('dd', { class: 'mono' }, t('value_meters', number(gps.altitudeMeters, 1)))) : null),
      h('div', { class: 'row' },
        h('button', { class: 'btn', type: 'button', onclick: copy }, t('web_copy_coordinates')),
        h('a', { class: 'btn', target: '_blank', rel: 'noopener noreferrer',
          href: `https://www.openstreetmap.org/?mlat=${gps.latitude.toFixed(6)}&mlon=${gps.longitude.toFixed(6)}#map=15/${gps.latitude.toFixed(5)}/${gps.longitude.toFixed(5)}` }, t('result_open_in_maps')))),
    h('div', { class: 'map-pair' },
      h('figure', { class: 'map-frame' }, schematicMap({ point: gps }), h('figcaption', { class: 'mono small' }, t('web_map_schematic'))),
      h('figure', { class: 'map-frame' }, schematicMap({ point: gps, span: 40 }), h('figcaption', { class: 'mono small' }, '40° × 20°'))),
    h('section', { class: 'card' }, live),
    h('p', { class: 'muted small' }, t('result_map_privacy_note')));
}

export function reportView() {
  const current = state.current;
  const { report } = current;
  const exposure = privacyExposure(report);
  const tabs = [['analysis', t('result_tab_analysis')], ['metadata', t('result_tab_metadata')], ['map', t('result_tab_map')]];
  const panel = h('div', {});
  const tabBar = h('div', { class: 'tabs', role: 'tablist' });
  const drawTab = () => {
    append(clear(tabBar),tabs.map(([id, label]) => h('button', { type: 'button', role: 'tab', class: `tab${state.reportTab === id ? ' is-on' : ''}`,
      'aria-selected': String(state.reportTab === id), onclick: () => { state.reportTab = id; drawTab(); } },
    label, id === 'map' && report.gps ? h('span', { class: 'tab-dot', 'aria-hidden': 'true' }) : null)));
    clear(panel);
    if (state.reportTab === 'metadata') panel.append(metadataTab(report));
    else if (state.reportTab === 'map') panel.append(mapTab(report));
    else panel.append(h('div', { class: 'tab-panel' }, verdict(report), privacyCard(current, exposure), gpsShield(current), signals(report),
      h('button', { class: 'link', type: 'button', onclick: () => { state.reportTab = 'metadata'; drawTab(); } }, t('result_view_all_metadata'))));
  };
  drawTab();
  return [
    h('header', { class: 'report-head' },
      h('a', { class: 'btn btn-ghost btn-small', href: '#/' }, icon('back', 16), t('common_back')),
      h('div', { class: 'report-title' },
        h('p', { class: 'eyebrow' }, current.fromHistory ? t('web_from_history') : t('result_badge_local')),
        h('h1', { title: report.file.name }, report.file.name || t('common_unnamed'))),
      h('button', { class: 'btn', type: 'button', onclick: chooseAndCheck }, t('web_check_another'))),
    h('div', { class: 'report-grid' }, sidebar(current, exposure), h('div', { class: 'report-main' }, tabBar, panel)),
  ];
}
