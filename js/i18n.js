// Interface texts. Shared strings come from the Android app's resources; website wording overrides them.

import en from './i18n/en.js';
import ru from './i18n/ru.js';
import { webEn, webRu } from './i18n/web.js';

const TABLES = { en: [webEn, en], ru: [webRu, ru, webEn, en] };
export const LANGUAGES = [['en', 'English'], ['ru', 'Русский']];

let lang = 'en';
let rules = new Intl.PluralRules('en');

export function setLanguage(code) {
  lang = TABLES[code] ? code : 'en';
  rules = new Intl.PluralRules(lang);
}
export const language = () => lang;

/** Language of the browser when the visitor has not chosen one. */
export function systemLanguage() {
  const list = typeof navigator !== 'undefined' ? navigator.languages ?? [navigator.language] : [];
  for (const tag of list) {
    const code = String(tag).toLowerCase().split('-')[0];
    if (TABLES[code]) return code;
    if (['uk', 'be', 'kk'].includes(code)) return 'ru';
  }
  return 'en';
}

function lookup(key) {
  for (const table of TABLES[lang]) if (table[key] !== undefined) return table[key];
  return undefined;
}

/** Android format strings: %1$s, %2$d, %1$02d, %%. */
function format(template, args) {
  return template.replace(/%(?:(\d+)\$)?(0?\d*)([sd%])/g, (all, index, width, type) => {
    if (type === '%') return '%';
    const value = args[(index ? Number(index) : 1) - 1];
    let text = value == null ? '' : String(type === 'd' ? Math.trunc(Number(value)) : value);
    if (width) text = text.padStart(Number(width), width.startsWith('0') ? '0' : ' ');
    return text;
  });
}

export function t(key, ...args) {
  const value = lookup(key);
  if (value === undefined) return key;
  if (typeof value === 'object') return format(value.other ?? Object.values(value)[0], args);
  return args.length ? format(value, args) : value.replace(/%%/g, '%');
}

export function plural(key, count, ...args) {
  const value = lookup(key);
  if (value === undefined || typeof value !== 'object') return t(key, count, ...args);
  return format(value[rules.select(count)] ?? value.other ?? Object.values(value)[0], [count, ...args]);
}

export const has = (key) => lookup(key) !== undefined;

/** Number with at most [digits] decimals, in the interface language. */
export function number(value, digits = 1) {
  return new Intl.NumberFormat(lang, { maximumFractionDigits: digits, useGrouping: false }).format(value);
}

export function fileSize(bytes) {
  if (!(bytes >= 0)) return '—';
  const units = lang === 'ru' ? ['Б', 'КБ', 'МБ', 'ГБ'] : ['B', 'KB', 'MB', 'GB'];
  let v = bytes, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${number(v, i === 0 ? 0 : v < 10 ? 2 : 1)} ${units[i]}`;
}

export function dateTime(ms) {
  return new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms));
}
