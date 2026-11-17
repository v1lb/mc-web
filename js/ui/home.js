// Start page: drop zone, statistics and report history.

import { h, icon, saveBlob } from './dom.js';
import { state, actions } from './state.js';
import { chooseAndCheck, pasteAndCheck } from './app.js';
import { t, plural, dateTime } from '../i18n.js';
import { formatName } from '../texts.js';
import { historyCsv, reportFromJson } from '../report.js';
import { settings, entitlement, visibleHistory, deleteHistory, historyStats, usedToday, FREE_DAILY_LIMIT } from '../store.js';

function dropZone() {
  return h('section', { class: 'drop', 'aria-label': t('web_drop_title') },
    h('div', { class: 'drop-icon', 'aria-hidden': 'true' }, icon('upload', 30)),
    h('h2', { class: 'drop-title' }, h('span', { class: 'drop-idle' }, t('web_drop_title')), h('span', { class: 'drop-hot' }, t('web_drop_release'))),
    h('p', { class: 'mono drop-formats' }, t('web_drop_formats')),
    h('div', { class: 'row row-center' },
      h('button', { class: 'btn btn-primary btn-large', type: 'button', onclick: chooseAndCheck }, t('dash_choose_photo')),
      navigator.clipboard?.read ? h('button', { class: 'btn btn-large', type: 'button', onclick: pasteAndCheck, title: t('web_paste_hint') }, t('web_paste')) : null),
    h('p', { class: 'muted drop-hint' }, t('dash_scan_hint')));
}

function statTile(value, label) {
  return h('div', { class: 'stat' }, h('strong', { class: 'stat-value' }, String(value)), h('span', { class: 'stat-label' }, label));
}

function statistics() {
  const s = historyStats();
  const peak = Math.max(1, ...s.days);
  const bars = h('div', { class: 'spark', role: 'img', 'aria-label': `${t('web_stat_last_days')}: ${s.days.join(', ')}` },
    s.days.map((n) => { const bar = h('span', { class: `spark-bar${n ? '' : ' is-empty'}` }); bar.style.height = `${Math.max(6, (n / peak) * 100)}%`; return bar; }));
  return h('section', { class: 'card' },
    h('p', { class: 'eyebrow' }, t('dash_section_analytics')),
    h('div', { class: 'stats' }, statTile(s.total, t('dash_stat_total')), statTile(s.ai, t('dash_stat_ai')), statTile(s.gps, t('dash_stat_gps')), statTile(s.week, t('dash_stat_activity'))),
    bars,
    h('p', { class: 'muted small' }, t('dash_stat_note')));
}

function studioCard() {
  return h('section', { class: 'card card-row' },
    h('div', {},
      h('p', { class: 'eyebrow' }, t('dash_eyebrow_studio')),
      h('p', { class: 'card-lead' }, t('dash_studio_features')),
      h('p', { class: 'muted small' }, entitlement.isPro ? t('studio_quota_pro') : t('web_quota_left', Math.max(0, FREE_DAILY_LIMIT - usedToday()), FREE_DAILY_LIMIT))),
    h('a', { class: 'btn', href: '#/studio' }, t('dash_open_studio')));
}

function historyRow(entry) {
  const open = () => {
    const report = reportFromJson(entry.report);
    if (report) actions.openReport(report, { historyId: entry.id, fromHistory: true, createdAt: entry.createdAt });
    else actions.toast(t('main_msg_report_open_failed'), 'error');
  };
  const remove = async () => {
    if (!(await actions.confirm({ title: t('dash_delete_title'), text: t('dash_delete_text'), confirmLabel: t('common_delete'), danger: true }))) return;
    if (!deleteHistory(entry.id)) actions.toast(t('main_msg_report_delete_failed'), 'error');
    if (state.current?.historyId === entry.id && state.current.fromHistory) state.current = null;
    actions.render();
  };
  return h('tr', {},
    h('td', { class: 'mono nowrap muted' }, dateTime(entry.createdAt)),
    h('td', { class: 'history-name' }, h('button', { class: 'link', type: 'button', onclick: open, title: t('web_history_open') }, entry.fileName || t('common_unnamed'))),
    h('td', { class: 'mono' }, formatName(entry.format)),
    h('td', {}, h('div', { class: 'badges' },
      entry.hasAiEvidence ? h('span', { class: 'badge badge-signal' }, t('dash_history_ai_badge')) : null,
      entry.hasGps ? h('span', { class: 'badge badge-caution' }, 'GPS') : null,
      entry.exposureCount > 0 ? h('span', { class: 'badge' }, t('history_badge_reveals', entry.exposureCount)) : h('span', { class: 'badge badge-clean' }, t('history_badge_clean')))),
    h('td', { class: 'cell-action' }, h('button', { class: 'btn btn-square btn-ghost', type: 'button', onclick: remove,
      'aria-label': t('dash_history_delete', entry.fileName), title: t('common_delete') }, icon('trash'))));
}

function historySection() {
  const list = visibleHistory();
  const exportCsv = () => { saveBlob(new Blob([historyCsv(list)], { type: 'text/csv' }), 'metacheck-history.csv'); actions.toast(t('main_msg_history_csv_saved'), 'ok'); };
  let body;
  if (!settings.saveHistory && !list.length) body = h('p', { class: 'empty' }, t('dash_history_disabled'));
  else if (!list.length) body = h('div', { class: 'empty' }, h('strong', {}, t('dash_history_empty_title')), h('span', {}, t('dash_history_empty')));
  else body = h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('tbody', {}, list.map(historyRow))));
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' },
      h('div', {}, h('p', { class: 'eyebrow' }, t('dash_history_title')),
        h('p', { class: 'muted small' }, entitlement.isPro ? t('dash_history_limit_pro') : t('dash_history_limit_free'))),
      list.length ? h('button', { class: 'btn btn-small', type: 'button', onclick: exportCsv }, t('dash_history_csv')) : null),
    body);
}

export function homeView() {
  return [
    h('header', { class: 'page-head' },
      h('p', { class: 'eyebrow' }, t('onboarding_intro_eyebrow_panel')),
      h('h1', {}, t('dash_title')),
      h('p', { class: 'lead' }, t('dash_subtitle'))),
    h('div', { class: 'home-grid' },
      dropZone(),
      h('div', { class: 'stack' }, statistics(), studioCard())),
    historySection(),
    h('p', { class: 'foot-note' }, icon('shield', 16), h('span', {}, t('dash_privacy_footer'), ' ', t('onboarding_intro_disclaimer'))),
  ];
}
