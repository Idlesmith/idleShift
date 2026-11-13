// Localization helper. Zero dependencies.
// Supported languages: 'en', 'ja'. Fallback: 'en', then key.
import en from './en.mjs';
import ja from './ja.mjs';

export const DICTS = Object.freeze({ en, ja });

export function t(lang, key, ...args) {
  const dict = DICTS[lang] || DICTS.en;
  const val = dict[key] ?? DICTS.en[key] ?? key;
  if (typeof val === 'function') {
    try { return val(...args); } catch { return key; }
  }
  return typeof val === 'string' ? val : key;
}

export function resolveUiLanguage(configured = 'auto') {
  if (configured === 'en' || configured === 'ja') return configured;
  // 'auto' normally follows the OS locale. IDLESHIFT_UI_LANGUAGE pins it, so
  // tests (and English or Japanese users on another-language OS) get a fixed result.
  const pinned = String(globalThis.process?.env?.IDLESHIFT_UI_LANGUAGE || '').toLowerCase();
  if (pinned === 'en' || pinned === 'ja') return pinned;
  try {
    const loc = Intl.DateTimeFormat().resolvedOptions().locale || '';
    if (loc.toLowerCase().startsWith('ja')) return 'ja';
  } catch { /* fallback to en */ }
  return 'en';
}

export function resolveAiLanguage(configured = 'en', uiLang = 'en') {
  if (configured === 'ui') return uiLang;
  if (configured === 'ja' || configured === 'en') return configured;
  return 'en';
}
