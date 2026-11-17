// Page shell: navigation rail, router, toasts, dialogs, drag and drop, paste.

import { h, append, clear, icon, pickFiles, MEDIA_ACCEPT } from './dom.js';
import { state, actions } from './state.js';
import { t, setLanguage, systemLanguage, language, LANGUAGES } from '../i18n.js';
import { errorText, licenseErrorText } from '../texts.js';
import { settings, saveSettings, entitlement, loadEntitlement, applyLicense, addHistory, usedToday, FREE_DAILY_LIMIT } from '../store.js';
import { analyzeFile } from '../core/analyze.js';
import { isVideo } from '../core/format.js';
import { homeView } from './home.js';
import { reportView } from './report.js';
import { studioView } from './studio.js';
import { settingsView } from './settings.js';

const ROUTES = { '': homeView, report: reportView, studio: studioView, settings: settingsView };
const root = document.getElementById('app');
const toasts = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
const dialogs = h('div', {});
let view = null;

// --- Theme and language ---

function applyTheme() {
  const dark = settings.theme === 'dark' || (settings.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#17160F' : '#F4F1EA');
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

function applyLanguage() {
  setLanguage(settings.lang ?? systemLanguage());
  document.documentElement.lang = language();
  document.title = `MetaCheck · ${t('web_tagline')}`;
}

export function applyAppearance() { applyTheme(); applyLanguage(); actions.render(); }

// --- Toasts and dialogs ---

actions.toast = (text, kind = 'info') => {
  const el = h('div', { class: `toast toast-${kind}` }, text);
  toasts.append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 9000 : 5000);
};

function dialog(title, body, buttons) {
  return new Promise((resolve) => {
    const el = h('dialog', { class: 'dialog' });
    const close = (value) => { el.close(); el.remove(); resolve(value); };
    append(el,
      h('div', { class: 'dialog-head' }, h('h2', {}, title),
        h('button', { class: 'btn btn-square btn-ghost', type: 'button', 'aria-label': t('common_close'), onclick: () => close(null) }, icon('close'))),
      h('div', { class: 'dialog-body' }, typeof body === 'function' ? body(close) : body),
      buttons?.length ? h('div', { class: 'dialog-actions' }, buttons.map(([label, value, cls]) =>
        h('button', { class: `btn ${cls ?? ''}`, type: 'button', onclick: () => close(value) }, label))) : null,
    );
    el.addEventListener('cancel', (e) => { e.preventDefault(); close(null); });
    el.addEventListener('click', (e) => { if (e.target === el) close(null); });
    dialogs.append(el);
    el.showModal();
  });
}
actions.dialog = dialog;

actions.confirm = async ({ title, text, confirmLabel, danger = false }) =>
  (await dialog(title, h('p', {}, text), [[t('common_cancel'), false, 'btn-ghost'], [confirmLabel ?? t('web_confirm'), true, danger ? 'btn-danger' : 'btn-primary']])) === true;

export function proStatusText() {
  if (!entitlement.isPro) return t('pro_status_free');
  return entitlement.expiresAt
    ? t('pro_status_license_until', new Intl.DateTimeFormat(language(), { dateStyle: 'medium' }).format(new Date(entitlement.expiresAt * 1000)))
    : t('pro_status_license');
}

/** Key field with its button; used by the Pro dialog and the settings page. */
export function licenseForm(onDone) {
  const input = h('input', { class: 'input mono', type: 'text', placeholder: 'MC1.…', autocomplete: 'off', spellcheck: false, 'aria-label': t('pro_key_label') });
  const message = h('p', { class: 'form-error', role: 'alert' });
  const submit = async (event) => {
    event.preventDefault();
    message.textContent = '';
    if (!input.value.trim()) return;
    try {
      await applyLicense(input.value);
      actions.toast(t('pro_msg_key_accepted'), 'ok');
      onDone?.();
      actions.render();
    } catch (e) { message.textContent = licenseErrorText(e.code); }
  };
  return h('form', { class: 'license-form', onsubmit: submit },
    h('label', { class: 'label' }, t('pro_key_label')),
    h('div', { class: 'row' }, input, h('button', { class: 'btn btn-primary', type: 'submit' }, t('pro_key_apply'))), message);
}

actions.openPro = () => dialog(t('pro_title'), (close) => [
  h('p', { class: 'eyebrow' }, t('pro_eyebrow')),
  h('p', { class: 'pro-state' }, proStatusText()),
  h('p', {}, t('pro_free_features', FREE_DAILY_LIMIT)),
  h('p', {}, t('pro_pro_features')),
  h('p', { class: 'muted' }, t('web_pro_how'), ' ', t('web_pro_get_key')),
  entitlement.isPro ? null : licenseForm(() => close(null)),
]);

actions.run = async (fn) => {
  if (state.busy) { actions.toast(t('main_msg_busy')); return null; }
  state.busy = true;
  document.body.classList.add('is-busy');
  try { return await fn(); } catch (error) {
    if (error?.code === 'PRO_REQUIRED') { actions.toast(t('error_pro_required')); actions.openPro(); }
    else if (error?.code === 'DAILY_LIMIT') { actions.toast(t('pro_limit_reached', error.limit ?? FREE_DAILY_LIMIT), 'error'); actions.openPro(); }
    else { console.error(error); actions.toast(errorText(error), 'error'); }
    return null;
  } finally {
    state.busy = false;
    document.body.classList.remove('is-busy');
    document.querySelectorAll('[data-quota]').forEach((el) => { el.textContent = quotaText(); });
  }
};

/** One line about today's free cleanings; elements marked data-quota are refreshed after every operation. */
export function quotaText() {
  return entitlement.isPro ? t('studio_quota_pro') : t('studio_quota_free', usedToday(), FREE_DAILY_LIMIT);
}

// --- Opening files ---

function setCurrent(next) {
  if (state.current?.previewUrl) URL.revokeObjectURL(state.current.previewUrl);
  state.current = next;
}

actions.openReport = (report, extra = {}) => {
  setCurrent({ file: null, report, exif: null, previewUrl: null, historyId: null, ...extra });
  state.reportTab = 'analysis';
  if (location.hash === '#/report') actions.render(); else actions.navigate('#/report');
};

actions.checkFile = async (file) => {
  if (!file) return;
  if (state.busy) { actions.toast(t('main_msg_busy')); return; }
  state.busy = true;
  renderLoading();
  try {
    const { report, exif } = await analyzeFile(file);
    const entry = addHistory(report);
    const previewUrl = URL.createObjectURL(file);
    state.busy = false;
    actions.openReport(report, { file, exif, previewUrl, historyId: entry?.id ?? null, isVideo: isVideo(report.file.format) });
  } catch (error) {
    state.busy = false;
    console.error(error);
    renderError(error?.code === 'UNSUPPORTED_FORMAT' ? t('error_unsupported_format') : t('main_error_read_file'));
  }
};

export async function chooseAndCheck() {
  const [file] = await pickFiles({ accept: MEDIA_ACCEPT });
  if (file) actions.checkFile(file);
}

export async function pasteAndCheck() {
  try {
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find((x) => x.startsWith('image/'));
      if (type) { actions.checkFile(new File([await item.getType(type)], `clipboard.${type.split('/')[1]}`, { type })); return; }
    }
    actions.toast(t('main_msg_clipboard_no_image'));
  } catch { actions.toast(t('main_msg_clipboard_failed'), 'error'); }
}

// --- Shell ---

function navLink(hash, label, iconName, active) {
  return h('a', { class: `nav-link${active ? ' is-active' : ''}`, href: hash, 'aria-current': active ? 'page' : null }, icon(iconName), h('span', {}, label));
}

function rail(route) {
  const nextTheme = { system: 'light', light: 'dark', dark: 'system' }[settings.theme] ?? 'system';
  const themeLabel = t({ system: 'web_theme_system', light: 'web_theme_light', dark: 'web_theme_dark' }[settings.theme]);
  return h('aside', { class: 'rail' },
    h('a', { class: 'brand', href: '#/' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, 'MC'),
      h('span', { class: 'brand-text' }, h('strong', {}, 'MetaCheck'), h('small', {}, t('web_tagline')))),
    h('nav', { class: 'nav', 'aria-label': 'MetaCheck' },
      navLink('#/', t('web_nav_check'), 'search', route === '' || route === 'report'),
      navLink('#/studio', t('studio_name'), 'studio', route === 'studio'),
      navLink('#/settings', t('main_title_settings'), 'settings', route === 'settings')),
    h('div', { class: 'rail-foot' },
      h('button', { class: `plan${entitlement.isPro ? ' is-pro' : ''}`, type: 'button', onclick: actions.openPro },
        h('span', { class: 'eyebrow' }, entitlement.isPro ? t('dash_pro_active') : t('settings_plan_free')),
        h('span', { class: 'plan-text' }, entitlement.isPro ? t('dash_pro_active_text') : t('dash_pro_text'))),
      h('div', { class: 'rail-toggles' },
        h('div', { class: 'segmented', role: 'group', 'aria-label': t('appearance_language') }, LANGUAGES.map(([code]) =>
          h('button', { type: 'button', class: language() === code ? 'is-on' : '', 'aria-pressed': String(language() === code),
            onclick: () => { saveSettings({ lang: code }); applyAppearance(); } }, code.toUpperCase()))),
        h('button', { class: 'btn btn-ghost btn-small', type: 'button', title: t('appearance_theme'),
          onclick: () => { saveSettings({ theme: nextTheme }); applyAppearance(); } }, `${t('appearance_theme')}: ${themeLabel}`)),
      h('p', { class: 'rail-note' }, icon('lock', 14), h('span', {}, t('web_local_note')))));
}

function mount(content, route) {
  view = h('main', { class: 'view', id: 'view', tabindex: '-1' }, content);
  clear(root).append(h('a', { class: 'skip', href: '#view' }, t('web_skip_to_content')), h('div', { class: 'shell' }, rail(route), view), toasts, dialogs);
}

function currentRoute() {
  const route = location.hash.replace(/^#\/?/, '').split('?')[0];
  return route in ROUTES ? route : '';
}

function renderLoading() {
  mount(h('section', { class: 'state-screen' },
    h('p', { class: 'eyebrow' }, t('loading_eyebrow')), h('h1', {}, t('loading_title')), h('p', { class: 'muted' }, t('loading_text')),
    h('div', { class: 'scanline', 'aria-hidden': 'true' })), 'report');
}

function renderError(message) {
  mount(h('section', { class: 'state-screen' },
    h('p', { class: 'eyebrow eyebrow-signal' }, t('error_eyebrow')), h('h1', {}, t('error_title')), h('p', {}, message),
    h('div', { class: 'row' },
      h('button', { class: 'btn btn-primary', type: 'button', onclick: chooseAndCheck }, t('error_choose_other')),
      h('a', { class: 'btn', href: '#/' }, t('error_home')))), 'report');
}

actions.render = () => {
  let route = currentRoute();
  if (route === 'report' && !state.current) { route = ''; history.replaceState(null, '', '#/'); }
  mount(ROUTES[route](), route);
};
actions.navigate = (hash) => { if (location.hash === hash) actions.render(); else location.hash = hash; };

addEventListener('hashchange', () => { actions.render(); scrollTo(0, 0); view?.focus({ preventScroll: true }); });

// --- Drag and drop, paste ---

let dragDepth = 0;
const hasFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes('Files');
addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; document.body.classList.add('is-dragging'); } });
addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('is-dragging'); } });
addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('is-dragging');
  const files = [...e.dataTransfer.files];
  // A drop on a dedicated zone (studio source, batch list) is handled there.
  const zone = e.target.closest?.('[data-drop]');
  if (zone) zone.dispatchEvent(new CustomEvent('files', { detail: files }));
  else if (files[0]) actions.checkFile(files[0]);
});
addEventListener('paste', (e) => {
  if (e.target.closest?.('input, textarea')) return;
  const file = [...(e.clipboardData?.files ?? [])][0];
  if (file) { e.preventDefault(); actions.checkFile(file); }
});

// --- Start ---

applyTheme();
applyLanguage();
actions.render();
loadEntitlement().then((e) => { if (e.isPro) actions.render(); });
