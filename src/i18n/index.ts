// i18n 框架 — 字典 + key 抽取 + 参数插值(2026-08-05 spec §7.2)
// zh 为源语言完整字典;en 逐步补齐,缺 key 回落 zh,再回落 key 本身。
import { zh } from './zh.js';
import { en } from './en.js';

export type Locale = 'zh' | 'en';

const DICTS: Record<Locale, Record<string, string>> = { zh, en };

const LOCALE_KEY = 'peyt.locale';

export function getLocale(): Locale {
  const v = localStorage.getItem(LOCALE_KEY);
  return v === 'en' ? 'en' : 'zh';
}

export function setLocale(locale: Locale): void {
  localStorage.setItem(LOCALE_KEY, locale);
  document.documentElement.lang = locale === 'en' ? 'en' : 'zh';
}

/** 取当前语言字典;en 缺 key 回落 zh。 */
export function lookup(key: string): string {
  const dict = DICTS[getLocale()];
  const zhDict = DICTS.zh;
  const v = dict[key] ?? zhDict[key] ?? key;
  return v;
}

/** 翻译:{name} 形式的参数插值。 */
export function t(key: string, params?: Record<string, string | number>): string {
  let s = lookup(key);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.replaceAll(`{${k}}`, String(v));
    }
  }
  return s;
}
