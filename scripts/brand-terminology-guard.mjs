import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const FORBIDDEN_TERMS = [
  {
    term: 'XDT' + 'Maker',
    replacement: 'Cindy',
  },
  {
    term: 'XDT' + ' Maker',
    replacement: 'Cindy',
  },
];

// Agent 工具名会直接显示在工具调用卡片和模型上下文中，也属于产品身份。
// 字符串拆开书写，避免 guard 把自己的规则定义误判成违规。
const FORBIDDEN_AGENT_TOOL_IDENTIFIERS = [
  { term: 'lizi_' + 'xdt_helper', replacement: 'cindy_helper' },
  { term: 'xdt_' + 'maker', replacement: 'cindy' },
];

function isAllowedLegacyAgentToolIdentifier(file, line, term) {
  if (term !== 'xdt_' + 'maker') return false;
  return (
    (file === 'packages/maker-core/src/agents/codex/index.ts' &&
      line.includes('LEGACY_ASK_USER_DYNAMIC_TOOL_NAMESPACE')) ||
    (file === 'packages/maker-core/src/agents/codex/index.test.ts' &&
      line.includes("namespace: '" + 'xdt_' + "maker'"))
  );
}

const ALLOWED_LEGACY_OCCURRENCES = new Set([
  [
    'apps/desktop/drizzle/0025_reclassify_codex_projectless_dialogues.sql',
    1,
    52,
    'XDT' + ' Maker',
  ].join(':'),
]);

// ---------------------------------------------------------------------------
// Locale 品牌名占位符检查:
// 品牌展示名已收敛到 @cindy/maker-shared/branding 的 BRAND_NAME,四语言 locale
// 文案统一用 {{appName}} 占位。这里拒绝在 locale JSON 里重新硬编码品牌名——
// 硬编码在开发期无感知,未来改名时必漏。运行时插值的端到端断言在
// apps/desktop/src/renderer/__tests__/i18nBrandPlaceholder.test.ts。
// ---------------------------------------------------------------------------

const LOCALE_FILE_RE = /^apps\/desktop\/src\/renderer\/i18n\/locales\/[^/]+\/common\.json$/;
const LOCALE_BRAND_RE = /XDMaker|XD Maker|xdt-maker/;
/**
 * key 级豁免:当前为空。历史豁免均已随 2026-07 品牌翻转清退:
 *  - openForLoginHint(Chrome 受管 profile 显示名)→ profile 已翻 Cindy,文案同步;
 *  - settings.remote.keys.nameHint(ssh 默认密钥名)→ 默认名已翻 cindy,文案同步。
 * 若未来需要新豁免,按完整 key 路径精确匹配——不能只按末段 key 名,否则任意
 * 嵌套下同名 key 都会被静默放过。
 */
const LOCALE_EXEMPT_KEY_PATHS = new Set([]);
function collectLocaleViolations(file, node, path, out) {
  if (typeof node === 'string') {
    if (!LOCALE_BRAND_RE.test(node)) return;
    if (LOCALE_EXEMPT_KEY_PATHS.has(path)) return;
    out.push({ file, key: path });
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      collectLocaleViolations(file, v, path ? `${path}.${k}` : k, out);
    }
  }
}

function fail(message) {
  console.error(`[brand-terminology-guard] ${message}`);
  process.exit(1);
}

const listed = spawnSync('git', ['ls-files', '-z'], {
  encoding: 'buffer',
  // The tracked path list exceeds spawnSync's default 1 MiB output limit.
  maxBuffer: 64 * 1024 * 1024,
});

// macOS can report status 0 alongside ENOBUFS; scanning that partial listing
// would silently omit files at the end of the index.
if (listed.error || listed.status !== 0) {
  fail(`git ls-files failed with exit ${listed.status ?? 'null'}\n${listed.error ? `${listed.error.code ?? 'spawn error'}: ${listed.error.message}` : ''}\n${listed.stderr?.toString('utf8') ?? ''}`);
}

const files = listed.stdout
  .toString('utf8')
  .split('\0')
  .filter(Boolean);

const violations = [];
const agentToolIdentifierViolations = [];
const localeViolations = [];

for (const file of files) {
  let buffer;
  try {
    buffer = readFileSync(file);
  } catch {
    continue;
  }
  if (buffer.includes(0)) continue;

  const text = buffer.toString('utf8');

  if (LOCALE_FILE_RE.test(file)) {
    try {
      collectLocaleViolations(file, JSON.parse(text), '', localeViolations);
    } catch {
      fail(`${file} is not valid JSON`);
    }
  }
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    // project-knowledge 是 pctx 自动生成快照，不手改；它可能暂时引用历史名称。
    if (!file.startsWith('.cindy/project-knowledge/')) {
      for (const { term, replacement } of FORBIDDEN_AGENT_TOOL_IDENTIFIERS) {
        if (!line.includes(term)) continue;
        if (isAllowedLegacyAgentToolIdentifier(file, line, term)) continue;
        agentToolIdentifierViolations.push({
          file,
          line: index + 1,
          term,
          replacement,
        });
      }
      if (
        file.startsWith('packages/lizi-mcps/src/') &&
        (/category\s*:\s*['"]xdt['"]/.test(line) || line.includes('category=xdt'))
      ) {
        agentToolIdentifierViolations.push({
          file,
          line: index + 1,
          term: 'xdt helper category',
          replacement: 'cindy helper category',
        });
      }
    }
    for (const { term, replacement } of FORBIDDEN_TERMS) {
      let searchFrom = 0;
      while (searchFrom < line.length) {
        const column = line.indexOf(term, searchFrom);
        if (column === -1) break;
        const lineNumber = index + 1;
        const columnNumber = column + 1;
        const legacyKey = [file, lineNumber, columnNumber, term].join(':');
        searchFrom = column + term.length;
        if (ALLOWED_LEGACY_OCCURRENCES.has(legacyKey)) continue;
        violations.push({
          file,
          line: lineNumber,
          column: columnNumber,
          term,
          replacement,
        });
      }
    }
  }
}

if (agentToolIdentifierViolations.length > 0) {
  console.error('❌ [brand-terminology-guard] deprecated agent tool identifiers found');
  for (const hit of agentToolIdentifierViolations) {
    console.error(`  ${hit.file}:${hit.line} uses "${hit.term}" → use "${hit.replacement}"`);
  }
  console.error('\nOnly the explicit Codex resume compatibility path may retain the legacy namespace.');
  process.exit(1);
}

if (violations.length > 0) {
  console.error('❌ [brand-terminology-guard] forbidden product spellings found');
  for (const hit of violations) {
    console.error(`  ${hit.file}:${hit.line}:${hit.column} uses "${hit.term}" → use "${hit.replacement}"`);
  }
  console.error('\nAllowed technical identifiers such as xdt-maker://, @xdt-maker, and xdt-maker-* are not checked by this guard.');
  console.error('Known immutable historical migration strings are allowlisted by exact file/line/column.');
  process.exit(1);
}

if (localeViolations.length > 0) {
  console.error('❌ [brand-terminology-guard] hardcoded brand name in locale files — use {{appName}}');
  for (const hit of localeViolations) {
    console.error(`  ${hit.file} → key "${hit.key}"`);
  }
  console.error('\nlocale 文案里的品牌名必须写 {{appName}}(由 i18next defaultVariables 注入 BRAND_NAME)。');
  console.error('标识符例外属于稳定标识符层，不要将其当作 locale 展示文案改名。');
  process.exit(1);
}

console.log('✅ [brand-terminology-guard] PASS — no forbidden brand spellings, locales use {{appName}}');
