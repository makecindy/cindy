/**
 * i18nCompleteness.test.ts —— 静态 i18n 完整性闸门(规则 18 的自动化兜底)。
 *
 * 背景:`fallbackLng = 'en'`,某 key 在某语言缺失会**静默回退英文、不报错**;若连 en 都缺,
 * 则直接渲染裸 key 字符串。开发期几乎发现不了,只有对应语言用户撞见——历史上只能靠人逐语言
 * 点界面排查(device-link 这轮就漏了 `settings.remoteControl.*` / `settings.imBot.*` 等整批)。
 * 本测试把"扫源码里用到的 key 是否 4 语言齐全"自动化,让这类遗漏在 CI 里红,而非靠人测。
 *
 * 判定:
 *  - 只看**静态字面量** `t('a.b.c')`(模板字面量 t(`a.${x}`) 无法静态解析 → 跳过,见末尾统计)。
 *  - 带**内联默认值**的 key 跳过(`t('k','默认')` 位置参 或 `t('k',{ defaultValue })`):
 *    这类有默认渲染,缺 key 不是可见 bug,作者有意为之。
 *  - 复数感知:i18next 用 `key_one`/`key_other` 等;`a.b` 视为命中当 `a.b` 或 `a.b_<复数后缀>` 存在。
 *  - KNOWN_MISSING:**与 device-link 无关的既有遗漏**,记录在案不阻断本轮;修一条删一条。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { glob } from 'node:fs/promises';

const RENDERER = resolve(__dirname, '..');
const LOCALES_DIR = resolve(RENDERER, 'i18n', 'locales');

const PLURAL_SUFFIXES = ['_zero', '_one', '_two', '_few', '_many', '_other'] as const;

/**
 * 既有 i18n 债务(**非本分支 device-link 引入**,owner 文件未在本次改动集内)。
 * 记录在案以免阻断 device-link 工作;后续按文件 owner 逐条补齐后从这里删除。
 */
const KNOWN_MISSING: ReadonlySet<string> = new Set([
]);

function loadLocales(): Record<string, unknown>[] {
  const dirs = readdirSync(LOCALES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  return dirs.map(
    (d) =>
      JSON.parse(readFileSync(resolve(LOCALES_DIR, d, 'common.json'), 'utf8')) as Record<
        string,
        unknown
      >,
  );
}

function localeNames(): string[] {
  return readdirSync(LOCALES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

/** 复数感知的 key 存在性判定。 */
function present(tree: Record<string, unknown>, key: string): boolean {
  const parts = key.split('.');
  let cur: unknown = tree;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      // 末段可能是复数:在父对象里找 leaf_<suffix>
      const parent = parts.slice(0, -1);
      const leaf = parts[parts.length - 1];
      let pc: unknown = tree;
      for (const pp of parent) {
        if (pc && typeof pc === 'object' && pp in (pc as Record<string, unknown>)) {
          pc = (pc as Record<string, unknown>)[pp];
        } else {
          return false;
        }
      }
      if (pc && typeof pc === 'object') {
        return PLURAL_SUFFIXES.some((suf) => leaf + suf in (pc as Record<string, unknown>));
      }
      return false;
    }
  }
  return cur !== undefined;
}

interface Scan {
  used: Set<string>;
  withDefault: Set<string>;
  templateCount: number;
}

async function scanSource(): Promise<Scan> {
  const used = new Set<string>();
  const withDefault = new Set<string>();
  let templateCount = 0;

  // 静态 t('a.b') / t("a.b");捕获 key 与其后是否紧跟逗号(可能是默认值)。
  const keyRe = /\bt\(\s*['"]([A-Za-z0-9_][A-Za-z0-9_.]*)['"]\s*(,)?/g;
  // 位置参默认:t('k', '默认')
  const posDefaultRe = /\bt\(\s*['"]([A-Za-z0-9_][A-Za-z0-9_.]*)['"]\s*,\s*['"]/g;
  // 选项默认:t('k', { ... defaultValue ... })
  const optDefaultRe = /\bt\(\s*['"]([A-Za-z0-9_][A-Za-z0-9_.]*)['"]\s*,\s*\{[^}]*defaultValue/g;
  const templateRe = /\bt\(\s*`/g;

  for await (const entry of glob('**/*.{ts,tsx}', { cwd: RENDERER })) {
    if (entry.includes('__tests__') || entry.startsWith('i18n/')) continue;
    const txt = readFileSync(resolve(RENDERER, entry), 'utf8');
    for (const m of txt.matchAll(keyRe)) used.add(m[1]);
    for (const m of txt.matchAll(posDefaultRe)) withDefault.add(m[1]);
    for (const m of txt.matchAll(optDefaultRe)) withDefault.add(m[1]);
    templateCount += [...txt.matchAll(templateRe)].length;
  }
  return { used, withDefault, templateCount };
}

describe('i18n completeness (static keys present in all locales)', () => {
  it('every static t() key (no inline default) exists in all supported locales', async () => {
    const locales = localeNames();
    const trees = loadLocales();
    expect(locales.length).toBeGreaterThanOrEqual(5); // zh-CN / zh-TW / en / ja / ko

    const { used, withDefault, templateCount } = await scanSource();

    const required = [...used].filter((k) => !withDefault.has(k) && !KNOWN_MISSING.has(k));

    const failures: string[] = [];
    for (const key of required) {
      const missingIn = locales.filter((_, i) => !present(trees[i], key));
      if (missingIn.length > 0) failures.push(`${key} → missing in [${missingIn.join(', ')}]`);
    }

    // 诊断信息(失败时打印),便于一次看清缺口。
    if (failures.length > 0) {
      console.error(
        `i18n gaps (${failures.length}); scanned ${used.size} static keys, ` +
          `${withDefault.size} with inline default skipped, ${templateCount} template t(\`...\`) sites unresolved:\n` +
          failures.join('\n'),
      );
    }
    expect(failures).toEqual([]);
  });

  it('KNOWN_MISSING stays minimal and only holds genuinely-absent keys (no stale entries)', async () => {
    // 防 allowlist 腐化:若某 KNOWN_MISSING key 已在所有语言补齐,应从名单删除。
    const trees = loadLocales();
    const stale = [...KNOWN_MISSING].filter((k) => trees.every((t) => present(t, k)));
    expect(stale).toEqual([]);
  });
});
