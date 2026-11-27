#!/usr/bin/env node
/**
 * 生成 apps/desktop/src/renderer/i18n/crossLocaleStrings.generated.json。
 *
 * Desktop renderer 只静态打包英文语言包，其余语言按需加载。少数功能要在「非当前语言」下
 * 同步读取文案：跨语言识别 Cindy Make 旧版默认任务标题、按中文名搜索模型。这里从各语言
 * common.json 摘出这些 key，生成一个很小的常驻表。正本仍是 locales/<语言>/common.json；
 * `pnpm check:i18n` 会校验生成结果是否最新。
 *
 * 用法：node scripts/i18n-cross-locale.mjs        重新生成
 *       node scripts/i18n-cross-locale.mjs --check 只校验，过期时退出码 1
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const i18nDir = path.join(repoRoot, 'apps', 'desktop', 'src', 'renderer', 'i18n');
const localesDir = path.join(i18nDir, 'locales');
export const CROSS_LOCALE_OUTPUT = path.join(i18nDir, 'crossLocaleStrings.generated.json');

/** 精确 key 或子树前缀（子树内全部字符串叶子都会收录）。 */
export const CROSS_LOCALE_KEYS = [
  'cindyMake.merge.taskTitle',
  'cindyMake.history.mergeTaskTitle',
  'cindyMake.history.revertTaskTitle',
  'modelNames',
];

function collect(node, prefix, out) {
  if (typeof node === 'string') {
    out[prefix] = node;
    return;
  }
  if (!node || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) collect(value, `${prefix}.${key}`, out);
}

/** 按语言目录名与 key 的码点顺序输出（不随系统区域设置变化），内容稳定，便于 diff。 */
export function buildCrossLocaleStrings() {
  const result = {};
  const locales = fs
    .readdirSync(localesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const locale of locales) {
    const common = JSON.parse(fs.readFileSync(path.join(localesDir, locale, 'common.json'), 'utf8'));
    const strings = {};
    for (const key of CROSS_LOCALE_KEYS) {
      const node = key.split('.').reduce((value, part) => value?.[part], common);
      collect(node, key, strings);
    }
    result[locale] = Object.fromEntries(Object.entries(strings).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }
  return `${JSON.stringify(result, null, 2)}\n`;
}

/** 生成结果与磁盘上的文件一致时返回 true。 */
export function isCrossLocaleStringsFresh() {
  const current = fs.existsSync(CROSS_LOCALE_OUTPUT) ? fs.readFileSync(CROSS_LOCALE_OUTPUT, 'utf8') : '';
  return current.replace(/\r\n/g, '\n') === buildCrossLocaleStrings();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) {
    if (!isCrossLocaleStringsFresh()) {
      console.error('[i18n-cross-locale] ❌ crossLocaleStrings.generated.json 已过期，运行 node scripts/i18n-cross-locale.mjs 重新生成。');
      process.exit(1);
    }
    console.log('[i18n-cross-locale] ✅ crossLocaleStrings.generated.json 是最新的');
  } else {
    fs.writeFileSync(CROSS_LOCALE_OUTPUT, buildCrossLocaleStrings());
    console.log(`[i18n-cross-locale] 已生成 ${path.relative(repoRoot, CROSS_LOCALE_OUTPUT)}`);
  }
}
