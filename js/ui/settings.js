// Settings: plan and key, language and theme, history, own API, about.

import { h } from './dom.js';
import { actions, VERSION } from './state.js';
import { licenseForm, proStatusText, applyAppearance } from './app.js';
import { t, language, LANGUAGES } from '../i18n.js';
import { settings, saveSettings, entitlement, removeLicense, clearHistory, FREE_DAILY_LIMIT } from '../store.js';

function toggle(label, text, checked, onChange) {
  return h('label', { class: 'switch-row' },
    h('span', {}, h('strong', {}, label), text ? h('span', { class: 'muted small' }, text) : null),
    h('input', { type: 'checkbox', class: 'switch', checked, onchange: (e) => onChange(e.target.checked) }));
}

function planCard() {
  return h('section', { class: 'card' },
    h('p', { class: 'eyebrow' }, t('settings_plan_eyebrow')),
    h('h2', {}, entitlement.isPro ? t('pro_title') : t('settings_plan_free')),
    h('p', { class: 'mono' }, proStatusText()),
    h('p', {}, entitlement.isPro ? t('settings_plan_pro_text') : t('settings_plan_free_text', FREE_DAILY_LIMIT)),
    h('p', { class: 'muted small' }, t('pro_pro_features')),
    h('p', { class: 'muted small' }, t('web_pro_how')),
    entitlement.isPro
      ? h('button', { class: 'btn', type: 'button', onclick: () => { removeLicense(); actions.render(); } }, t('settings_remove_license'))
      : licenseForm());
}

function appearanceCard() {
  const rerender = applyAppearance;
  const themes = [['system', 'web_theme_system'], ['light', 'web_theme_light'], ['dark', 'web_theme_dark']];
  return h('section', { class: 'card' },
    h('p', { class: 'eyebrow' }, t('appearance_section')),
    h('div', { class: 'fields fields-2' },
      h('label', { class: 'field' }, h('span', { class: 'label' }, t('appearance_language')),
        h('select', { class: 'input', onchange: (e) => { saveSettings({ lang: e.target.value || null }); rerender(); } },
          h('option', { value: '', selected: settings.lang == null }, t('appearance_language_system')),
          LANGUAGES.map(([code, name]) => h('option', { value: code, selected: settings.lang === code }, name)))),
      h('label', { class: 'field' }, h('span', { class: 'label' }, t('appearance_theme')),
        h('select', { class: 'input', onchange: (e) => { saveSettings({ theme: e.target.value }); rerender(); } },
          themes.map(([value, key]) => h('option', { value, selected: settings.theme === value }, t(key)))))),
    h('p', { class: 'muted small' }, t('appearance_language_current', LANGUAGES.find(([code]) => code === language())[1])));
}

function historyCard() {
  const clearAll = async () => {
    if (!(await actions.confirm({ title: t('settings_clear_title'), text: t('settings_clear_text'), confirmLabel: t('common_delete'), danger: true }))) return;
    actions.toast(clearHistory() ? t('settings_msg_history_cleared') : t('settings_msg_history_clear_failed'), 'ok');
  };
  return h('section', { class: 'card' },
    h('p', { class: 'eyebrow' }, t('settings_section_history')),
    toggle(t('settings_save_history'), t('settings_save_history_text'), settings.saveHistory, (v) => saveSettings({ saveHistory: v })),
    h('button', { class: 'btn btn-danger-ghost', type: 'button', onclick: clearAll }, t('settings_clear_history')));
}

function apiCard() {
  const text = (key, label, { type = 'text', placeholder = '', note = null } = {}) => h('label', { class: 'field' },
    h('span', { class: 'label' }, label),
    h('input', { class: 'input mono', type, value: settings[key], placeholder, autocomplete: 'off', spellcheck: false,
      onchange: (e) => {
        const value = e.target.value.trim();
        if (key === 'apiEndpoint' && value && !/^https:\/\/[^\s/@]+(\/|$)/i.test(value)) { actions.toast(t('api_config_url_not_https'), 'error'); return; }
        if (key === 'apiHeaderName' && value && !/^[A-Za-z0-9-]+$/.test(value)) { actions.toast(t('api_config_header_invalid'), 'error'); return; }
        saveSettings({ [key]: value });
        if (key === 'apiKey') actions.toast(t(value ? 'settings_msg_key_saved' : 'settings_msg_key_deleted'), 'ok');
      } }),
    note ? h('span', { class: 'hint' }, note) : null);
  return h('section', { class: 'card' },
    h('p', { class: 'eyebrow' }, t('settings_section_api'), entitlement.isPro ? null : h('span', { class: 'tag' }, 'PRO')),
    toggle(t('settings_api_enabled'), t('settings_api_enabled_text'), settings.apiEnabled, (v) => saveSettings({ apiEnabled: v })),
    h('p', { class: 'label' }, t('settings_api_connection')),
    h('div', { class: 'fields' },
      text('apiEndpoint', t('settings_api_url'), { type: 'url', placeholder: 'https://example.com/api/report' }),
      h('div', { class: 'fields fields-2' },
        text('apiHeaderName', t('settings_api_header')),
        text('apiKey', t('settings_api_key'), { type: 'password', note: t('settings_api_key_note') }))),
    toggle(t('settings_api_send_gps'), t('settings_api_send_gps_text'), settings.apiSendGps, (v) => saveSettings({ apiSendGps: v })),
    h('p', { class: 'muted small' }, t('web_api_cors')));
}

function aboutCard() {
  const link = (href, label) => h('a', { class: 'link', href, target: '_blank', rel: 'noopener noreferrer' }, label);
  return h('section', { class: 'card' },
    h('p', { class: 'eyebrow' }, t('about_eyebrow')),
    h('h2', {}, t('about_version', VERSION)),
    h('p', {}, t('web_about_text')),
    h('ul', { class: 'plain links' },
      h('li', {}, link(t('legal_privacy_url'), t('about_privacy'))),
      h('li', {}, link(t('legal_terms_url'), t('about_terms'))),
      h('li', {}, link('https://v1lb.github.io/legal-metacheck/', t('about_support')))),
    h('details', { class: 'details' }, h('summary', {}, t('about_licenses')),
      h('p', { class: 'small' }, t('web_about_source_fonts')),
      h('p', { class: 'small' }, t('web_about_source_map')),
      h('p', { class: 'small' }, t('licenses_map_data'))));
}

export function settingsView() {
  return [
    h('header', { class: 'page-head' },
      h('p', { class: 'eyebrow' }, t('settings_eyebrow')),
      h('h1', {}, t('settings_title')),
      h('p', { class: 'lead' }, t('settings_subtitle'))),
    h('div', { class: 'two-col' },
      h('div', { class: 'stack' }, planCard(), historyCard(),
        h('section', { class: 'card card-quiet' }, h('p', { class: 'eyebrow' }, t('settings_security_eyebrow')), h('h2', {}, t('settings_security_title')), h('p', { class: 'muted' }, t('settings_security_text')))),
      h('div', { class: 'stack' }, appearanceCard(), apiCard(), aboutCard())),
  ];
}
