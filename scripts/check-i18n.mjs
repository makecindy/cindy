#!/usr/bin/env node
/**
 * i18n key 一致性校验(issue #49)。
 *
 * 校验 apps/desktop/src/renderer/i18n/locales/<locale>/*.json:
 *  - 错误(exit 1):某 locale 缺少其它 locale 已有的 namespace / key(含孤儿 key——
 *    只存在于部分 locale 的 key 在其余 locale 视角下即缺失)、同一 key 在不同 locale
 *    类型冲突(一边是字符串叶子、一边是嵌套对象)、JSON 解析失败。
 *  - 复数 key(i18next `_one` / `_other` 等后缀)按家族校验:每个 locale 只要求
 *    具备 Intl.PluralRules 给出的本语言复数类别(en 需 one+other,zh/ja/ko 只需
 *    other),en 独有 `_one` 不算缺失。
 *  - 警告(不阻塞):值为空字符串;非默认 locale 的值与默认 locale(fallback,
 *    即 DEFAULT_LOCALE)完全相同——疑似未翻译,专有名词 / "OK" 等合法重复较多,
 *    故仅提示。
 *
 * locale 列表与默认语言从 apps/desktop/src/shared/locale.ts 的 SUPPORTED_LOCALES /
 * DEFAULT_LOCALE 解析,新增语言或改默认语言无需改本脚本。
 *
 * 用法:node scripts/check-i18n.mjs(root: pnpm check:i18n)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localeTsPath = path.join(repoRoot, 'apps', 'desktop', 'src', 'shared', 'locale.ts');
const localesDir = path.join(repoRoot, 'apps', 'desktop', 'src', 'renderer', 'i18n', 'locales');

/** 从 locale.ts 源码解析 SUPPORTED_LOCALES 数组字面量与 DEFAULT_LOCALE。 */
function parseLocaleConfig() {
  const src = fs.readFileSync(localeTsPath, 'utf8');
  const match = src.match(/SUPPORTED_LOCALES\s*=\s*\[([^\]]*)\]/);
  if (!match) {
    console.error(`[check-i18n] 无法从 ${localeTsPath} 解析 SUPPORTED_LOCALES`);
    process.exit(1);
  }
  const locales = [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
  if (locales.length === 0) {
    console.error('[check-i18n] SUPPORTED_LOCALES 解析结果为空');
    process.exit(1);
  }
  const defaultMatch = src.match(/DEFAULT_LOCALE[^=]*=\s*['"]([^'"]+)['"]/);
  if (!defaultMatch || !locales.includes(defaultMatch[1])) {
    console.error(`[check-i18n] 无法从 ${localeTsPath} 解析 DEFAULT_LOCALE(或不在 SUPPORTED_LOCALES 内)`);
    process.exit(1);
  }
  return { locales, defaultLocale: defaultMatch[1] };
}

/** 递归展平嵌套 JSON 为 Map<'a.b.c', string>。 */
function flatten(obj, prefix, out) {
  for (const [key, value] of Object.entries(obj)) {
    const keyPath = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      flatten(value, keyPath, out);
    } else {
      out.set(keyPath, value);
    }
  }
  return out;
}

const { locales, defaultLocale } = parseLocaleConfig();
const flatByLocale = new Map();
let hasError = false;

const namespaceFiles = new Set(
  locales.flatMap((locale) => {
    const dir = path.join(localesDir, locale);
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((file) => file.endsWith('.json')) : [];
  }),
);

for (const locale of locales) {
  const flat = new Map();
  for (const namespaceFile of [...namespaceFiles].sort()) {
    const file = path.join(localesDir, locale, namespaceFile);
    if (!fs.existsSync(file)) {
      console.error(`[check-i18n] ${locale} 缺少 namespace: ${namespaceFile}`);
      hasError = true;
      continue;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const namespace = path.basename(namespaceFile, '.json');
      flatten(parsed, namespace === 'common' ? '' : namespace, flat);
    } catch (err) {
      console.error(`[check-i18n] 读取 / 解析失败: ${file}\n  ${err.message}`);
      hasError = true;
    }
  }
  flatByLocale.set(locale, flat);
}

if (hasError) process.exit(1);

// ---- 复数家族归一 ----
// i18next 复数 key 形如 `base_one` / `base_other`。判定为复数家族的依据:任一
// locale 存在任意复数后缀变体(不只 `_other`——只看 `_other` 会放过"四语都只写
// 了 `_one`、漏了 `_other`"的情况,而 i18next 在 count≠1 及中日韩全部 count 都
// 查 `_other`,运行时会渲染裸 key)。家族内按 locale 自身语言的复数类别
// (Intl.PluralRules)要求变体:所有语言的类别都含 other,故 `_other` 对每个
// locale 都是硬性要求;en 独有 `_one` 则不会被中日韩误报为缺失。
const PLURAL_SUFFIX_RE = /_(zero|one|two|few|many|other)$/;
const pluralBases = new Set();
for (const flat of flatByLocale.values()) {
  for (const key of flat.keys()) {
    const m = key.match(PLURAL_SUFFIX_RE);
    if (m) pluralBases.add(key.slice(0, -(m[1].length + 1)));
  }
}
/** locale → 该语言 cardinal 复数类别集合,如 en → {one, other}。 */
const pluralCategories = new Map(
  locales.map((l) => [l, new Set(new Intl.PluralRules(l).resolvedOptions().pluralCategories)]),
);
// 防御:非 full-ICU 的 Node 构建下 pluralCategories 可能缺失(new Set(undefined)
// 静默得到空集,复数校验会被整体跳过)。CLDR 所有语言的类别都含 other,不满足
// 即环境数据异常,必须大声失败而不是静默放行。
for (const [locale, cats] of pluralCategories) {
  if (cats.size === 0 || !cats.has('other')) {
    console.error(
      `[check-i18n] Intl.PluralRules('${locale}') 复数类别异常(${JSON.stringify([...cats])})——` +
        `当前 Node 可能为 small-icu 构建,请使用带 full-icu 的 Node 运行本脚本`,
    );
    process.exit(1);
  }
}
/** 复数变体 key → 家族 base;非复数 key → null。 */
function pluralBaseOf(key) {
  const m = key.match(PLURAL_SUFFIX_RE);
  if (!m) return null;
  const base = key.slice(0, -(m[1].length + 1));
  return pluralBases.has(base) ? base : null;
}

// 全部 locale 的 key 并集为基准(复数家族折叠为 base)
const allKeys = new Set();
for (const flat of flatByLocale.values()) {
  for (const key of flat.keys()) allKeys.add(pluralBaseOf(key) ?? key);
}

// 错误 1:类型冲突 —— 同一 keyPath 在 A 是叶子、在 B 是嵌套分支(表现为 B 中存在
// 以该 keyPath 为前缀的更深 key,而 keyPath 本身不在 B 的叶子集合)。按原始叶子
// key(不折叠复数)检查。
const rawKeyUnion = new Set();
for (const flat of flatByLocale.values()) {
  for (const key of flat.keys()) rawKeyUnion.add(key);
}
const typeConflicts = [];
for (const key of rawKeyUnion) {
  const prefix = `${key}.`;
  for (const [locale, flat] of flatByLocale) {
    if (!flat.has(key)) continue;
    for (const [other, otherFlat] of flatByLocale) {
      if (other === locale || otherFlat.has(key)) continue;
      for (const otherKey of otherFlat.keys()) {
        if (otherKey.startsWith(prefix)) {
          typeConflicts.push({ key, message: `${key}: ${locale} 为字符串叶子,${other} 为嵌套对象` });
          break;
        }
      }
    }
  }
}

// 错误 2:缺失 key(按 locale 分组,孤儿 key 即并集中其余 locale 的缺失项)。
// 复数家族:locale 必须具备本语言全部复数类别对应的变体。
const missingByLocale = new Map(locales.map((l) => [l, []]));
const conflictKeys = new Set(typeConflicts.map((c) => c.key));
for (const key of allKeys) {
  if (conflictKeys.has(key)) continue; // 类型冲突单独报,不重复算缺失
  const isPluralFamily = pluralBases.has(key);
  for (const [locale, flat] of flatByLocale) {
    if (isPluralFamily) {
      const lacking = [...pluralCategories.get(locale)].filter((cat) => !flat.has(`${key}_${cat}`));
      if (lacking.length > 0) {
        missingByLocale.get(locale).push(`${key}_{${lacking.join(',')}}(复数家族)`);
      }
    } else if (!flat.has(key)) {
      const owners = locales.filter((l) => flatByLocale.get(l)?.has(key));
      missingByLocale.get(locale).push(`${key}(存在于: ${owners.join(', ')})`);
    }
  }
}

// 警告:空值 / 非默认 locale 值与默认 locale(fallback)相同(疑似未翻译)
const emptyValues = [];
const sameAsDefault = [];
const defaultFlat = flatByLocale.get(defaultLocale);
for (const [locale, flat] of flatByLocale) {
  for (const [key, value] of flat) {
    if (typeof value === 'string' && value.trim() === '') {
      emptyValues.push(`${locale}: ${key}`);
    }
    if (locale !== defaultLocale && defaultFlat && typeof value === 'string' && value !== '' && defaultFlat.get(key) === value) {
      sameAsDefault.push(`${locale}: ${key} = ${JSON.stringify(value)}`);
    }
  }
}

// ---- 输出 ----
let missingTotal = 0;
for (const [locale, missing] of missingByLocale) {
  if (missing.length === 0) continue;
  missingTotal += missing.length;
  console.error(`\n[check-i18n] ❌ ${locale} 缺失 ${missing.length} 个 key:`);
  for (const item of missing.sort()) console.error(`  - ${item}`);
}
if (typeConflicts.length > 0) {
  console.error(`\n[check-i18n] ❌ 类型冲突 ${typeConflicts.length} 处:`);
  for (const item of typeConflicts.map((c) => c.message).sort()) console.error(`  - ${item}`);
}
if (emptyValues.length > 0) {
  console.warn(`\n[check-i18n] ⚠️ 空字符串值 ${emptyValues.length} 处(会触发英文回退):`);
  for (const item of emptyValues.sort()) console.warn(`  - ${item}`);
}
if (sameAsDefault.length > 0) {
  const CAP = 50;
  console.warn(
    `\n[check-i18n] ⚠️ 非 ${defaultLocale} 值与 ${defaultLocale} 完全相同 ${sameAsDefault.length} 处(疑似未翻译,人工甄别,不阻塞):`,
  );
  for (const item of sameAsDefault.sort().slice(0, CAP)) console.warn(`  - ${item}`);
  if (sameAsDefault.length > CAP) console.warn(`  ...(其余 ${sameAsDefault.length - CAP} 处省略,完整列表可临时调大脚本内 CAP)`);
}

if (missingTotal > 0 || typeConflicts.length > 0) {
  console.error(
    `\n[check-i18n] 失败:缺失 ${missingTotal} / 类型冲突 ${typeConflicts.length}。` +
      `${locales.length} 种语言的 common.json 必须 key 完全一致(CLAUDE.md 规则 17)。`,
  );
  process.exit(1);
}

console.log(
  `[check-i18n] ✅ ${locales.join(' / ')} 共 ${allKeys.size} 个 key 全部一致` +
    (emptyValues.length || sameAsDefault.length ? `(警告 ${emptyValues.length + sameAsDefault.length} 处,见上)` : ''),
);
