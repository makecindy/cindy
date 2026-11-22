#!/usr/bin/env node
/**
 * 同源多译检查：同一句「中文源 + 英文源」在不同模块译成不同说法。
 *
 * 为什么需要它：check:i18n 只管 key 齐不齐，check:i18n-glossary 只管术语与写法，
 * 都不看「同一句源文在两个模块里是否译得一样」。IM 各平台（discord / telegram /
 * feishu / wecom / wechat）同一句提示词分别写过一遍，就是靠这个口子分叉的。
 *
 * 用法：
 *   node scripts/check-same-source.mjs            # 报告（默认，退出码 0）
 *   node scripts/check-same-source.mjs --strict   # 有分歧即失败（基线落地后启用）
 *
 * 口径：
 *   - 以 zh-CN 与 en 为源；两者都相同才算同源（同一中文对应不同英文是语境差异，不算）。
 *   - 同一源在多个 key 上出现、且译文不止一种，记为一组分歧。
 *   - 文言两版（zh-Hant-x-lzh / zh-Hans-x-lzh）暂不纳入：其用词按文体自行取舍。
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(import.meta.dirname, '..');
const LOCALES = ['zh-TW', 'ja', 'ko', 'es', 'fr', 'de', 'pt-PT', 'pt-BR'];
const SOURCE = 'zh-CN';
const REFERENCE = 'en';
const DESKTOP = path.join(repoRoot, 'apps/desktop/src/renderer/i18n/locales');
const MOBILE = path.join(repoRoot, 'apps/mobile/src/i18n/locales');
const MOBILE_NS = ['groupChat', 'interaction', 'plugins', 'session', 'settings', 'models', 'devices', 'mcpApps', 'chat', 'composer', 'home', 'files', 'shared'];
const STRICT = process.argv.includes('--strict');

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function flatten(value, prefix = '', out = new Map()) {
  for (const [key, child] of Object.entries(value)) {
    const next = prefix ? prefix + '.' + key : key;
    if (child && typeof child === 'object' && !Array.isArray(child)) flatten(child, next, out);
    else if (typeof child === 'string') out.set(next, child);
  }
  return out;
}

function loadCatalog() {
  const catalog = new Map();
  const add = (namespace, locale, file) => {
    if (!existsSync(file)) return;
    if (!catalog.has(namespace)) catalog.set(namespace, new Map());
    catalog.get(namespace).set(locale, flatten(readJson(file)));
  };
  for (const locale of [SOURCE, REFERENCE, ...LOCALES]) {
    add('desktop', locale, path.join(DESKTOP, locale, 'common.json'));
    for (const ns of MOBILE_NS) add('mobile/' + ns, locale, path.join(MOBILE, locale, ns + '.json'));
  }
  return catalog;
}

function collect(catalog) {
  const groups = new Map();
  for (const [namespace, byLocale] of catalog) {
    const source = byLocale.get(SOURCE);
    const reference = byLocale.get(REFERENCE);
    if (!source || !reference) continue;
    for (const locale of LOCALES) {
      const target = byLocale.get(locale);
      if (!target) continue;
      for (const [key, zh] of source) {
        const en = reference.get(key);
        const value = target.get(key);
        if (en === undefined || value === undefined) continue;
        const id = locale + '\t' + zh + '\t' + en;
        if (!groups.has(id)) groups.set(id, new Map());
        const variants = groups.get(id);
        if (!variants.has(value)) variants.set(value, []);
        variants.get(value).push(namespace + ':' + key);
      }
    }
  }
  return [...groups].filter(([, variants]) => variants.size > 1);
}

const groups = collect(loadCatalog());
const byLocale = new Map();
for (const [id] of groups) {
  const locale = id.slice(0, id.indexOf('\t'));
  byLocale.set(locale, (byLocale.get(locale) ?? 0) + 1);
}

console.log('[check-same-source] 同一（中文源, 英文源）出现多种译文的组数：' + groups.length);
for (const [locale, count] of [...byLocale].sort((a, b) => b[1] - a[1])) {
  console.log('  ' + locale + ': ' + count);
}

for (const [id, variants] of groups.slice(0, 10)) {
  const [locale, zh, en] = id.split('\t');
  console.log('\n- ' + locale + ' | zh: ' + zh.slice(0, 60) + ' | en: ' + en.slice(0, 60));
  for (const [value, keys] of [...variants].slice(0, 4)) {
    console.log('    ' + JSON.stringify(value).slice(0, 80) + '  @ ' + keys[0] + (keys.length > 1 ? ' (+' + (keys.length - 1) + ')' : ''));
  }
}

if (groups.length > 0 && STRICT) {
  console.error('\n[check-same-source] --strict：存在同源多译，失败。');
  process.exit(1);
}

