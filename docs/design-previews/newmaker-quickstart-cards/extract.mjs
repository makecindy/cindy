#!/usr/bin/env node
// extract.mjs — New Maker 快捷入口卡片布局 QA demo 真值提取器。
//
// 从产品源码机械提取(正则 / JSON.parse)demo 需要的一切事实,每个叶子带 provenance
// {source(相对 demoDir 路径), locator(定位方式), hash(整源文件 sha256)}。
// 门 A 会现跑本脚本并要求输出 ≡ truth.json——所以本脚本必须确定性(无时间/随机)。
//
// 覆盖:
//   - 4 张卡片定义(key / icon / 支持语言 label) ← NewMakerDraftRoute.tsx + SUPPORTED_LOCALES
//   - section 标题(支持语言 + 字号/行高)        ← NewMakerDraftRoute.tsx + common.json
//   - 卡片几何(gap 8 / 圆角 12 / 描边 1 / icon 圈 32 / 字号 13 / min-h 84·112 / grid gap 12)
//   - 主题 token(6 卡片色 + text-secondary,light/dark hex) ← themes/colors.ts
//   - 布局公式常量(useProportionalWidth 的 5 常量 + minWidth 640 + 断点 560/700 + main px 16/32)
//   - adaptive.samples:用产品布局公式对 spec.adaptive.sampleSizes 预计算每个采样点的期望几何

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REL = '../../../apps/desktop'; // demoDir(docs/design-previews/newmaker-quickstart-cards) → worktree 下 apps/desktop

// 源文件相对路径(相对 demoDir;provenance.source 存这个字符串,校验器 resolve(demoDir, source))
const SRC = {
  draft: `${REL}/src/renderer/features/cc-agent/NewMakerDraftRoute.tsx`,
  colors: `${REL}/src/renderer/themes/colors.ts`,
  hook: `${REL}/src/renderer/hooks/useProportionalWidth.ts`,
  globals: `${REL}/src/renderer/styles/globals.css`,
  locales: `${REL}/src/shared/locale.ts`,
  i18n: (loc) => `${REL}/src/renderer/i18n/locales/${loc}/common.json`,
};

// —— 源文件读取 + 缓存 hash(整文件 sha256,与 schema.hashFile 一致) ——
const _cache = new Map();
function read(relPath) {
  if (!_cache.has(relPath)) {
    const abs = resolve(HERE, relPath);
    const text = readFileSync(abs, 'utf8');
    const hash = createHash('sha256').update(readFileSync(abs)).digest('hex');
    _cache.set(relPath, { text, hash });
  }
  return _cache.get(relPath);
}
function readSupportedLocales(relPath) {
  const declaration = read(relPath).text.match(/SUPPORTED_LOCALES\s*=\s*\[([^\]]*)\]/s)?.[1];
  const locales = declaration
    ? [...declaration.matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1])
    : [];
  must(locales.length > 0, `${relPath} 未找到 SUPPORTED_LOCALES`);
  return locales;
}
// 叶子包装:{ value, provenance:{ source, locator, hash } }
function leaf(value, relPath, locator) {
  const { hash } = read(relPath);
  return { value, provenance: { source: relPath, locator, hash } };
}

// —— 断言帮助:提取的东西必须真在源码里,否则源码变了就该报错(不静默用旧值) ——
function must(cond, msg) {
  if (!cond) {
    process.stderr.write(`extract.mjs 提取失败:${msg}\n`);
    process.exit(1);
  }
}
function grab(relPath, re, msg) {
  const m = read(relPath).text.match(re);
  must(m, msg);
  return m;
}

const LOCALES = readSupportedLocales(SRC.locales);

// ========== 1. 卡片定义(key / icon)—— NewMakerDraftRoute.tsx ==========
// createAgentQuickStarts 数组:逐条 key + labelKey + icon
const draftText = read(SRC.draft).text;
const cardDefRe =
  /\{\s*key:\s*'([a-z]+)',\s*labelKey:\s*'(newChat\.createAgent\.quickStarts\.[a-z]+)',\s*icon:\s*(\w+),/g;
const cardDefs = [];
for (const m of draftText.matchAll(cardDefRe)) {
  cardDefs.push({ key: m[1], labelKey: m[2], icon: m[3] });
}
must(cardDefs.length === 4, `createAgentQuickStarts 期望 4 张卡,实得 ${cardDefs.length}`);

// ========== 2. i18n 文案(SUPPORTED_LOCALES label + section 标题) ==========
const i18n = {};
for (const loc of LOCALES) {
  const rel = SRC.i18n(loc);
  const json = JSON.parse(read(rel).text);
  const ca = json?.newChat?.createAgent;
  must(ca && ca.quickStarts && ca.quickStart, `${loc}/common.json 缺 newChat.createAgent.quickStart(s)`);
  i18n[loc] = { rel, quickStarts: ca.quickStarts, title: ca.quickStart };
}

const cards = cardDefs.map((d) => {
  const shortKey = d.labelKey.split('.').pop();
  const labels = {};
  for (const loc of LOCALES) {
    const txt = i18n[loc].quickStarts[shortKey];
    must(typeof txt === 'string' && txt.length > 0, `${loc} 缺 quickStarts.${shortKey}`);
    labels[loc] = leaf(txt, i18n[loc].rel, `newChat.createAgent.quickStarts.${shortKey}`);
  }
  return {
    key: leaf(d.key, SRC.draft, `createAgentQuickStarts[].key='${d.key}'`),
    icon: leaf(d.icon, SRC.draft, `createAgentQuickStarts[].icon=${d.icon}`),
    labels,
  };
});

const sectionTitles = {};
for (const loc of LOCALES) {
  sectionTitles[loc] = leaf(i18n[loc].title, i18n[loc].rel, 'newChat.createAgent.quickStart');
}

// ========== 3. 卡片几何(Tailwind class → px;先断言 class 真在源码里) ==========
// 卡片按钮 className(竖排改稿后):flex flex-col items-start justify-between gap-1 rounded-xl border ... min-h-[112px] p-4
grab(
  SRC.draft,
  /flex flex-col items-start justify-between gap-1 rounded-xl border/,
  '卡片按钮缺 "flex flex-col items-start justify-between gap-1 rounded-xl border"(竖排契约,icon 顶+文字底)',
);
grab(SRC.draft, /isDraftNarrow \? 'min-h-\[84px\] p-3' : 'min-h-\[112px\] p-4'/, '卡片高度/内边距档缺失');
grab(SRC.draft, /grid w-full gap-3/, 'grid 容器缺 "grid w-full gap-3"');
grab(SRC.draft, /grid h-8 w-8 shrink-0 place-items-center rounded-full/, 'icon 圈缺 "h-8 w-8 ... rounded-full"');
grab(SRC.draft, /size=\{16\}/, 'icon glyph size={16} 缺失');
const labelLeading = Number(
  grab(
    SRC.draft,
    /w-full min-w-0 text-13 font-semibold leading-\[([\d.]+)\]/,
    'label span 缺 "w-full ... text-13 ... leading-[ratio]"(竖排文字契约,与 icon 同宽左对齐)',
  )[1],
);
const sectionLeading = Number(
  grab(
    SRC.draft,
    /text-14 font-medium leading-\[([\d.]+)\] text-\[var\(--text-secondary\)\]/,
    'section 标题缺 "text-14 ... leading-[ratio] ... text-secondary"',
  )[1],
);
// grid 列断点(draftContentWidth 即 inputWidth):< 560 → 1 列;< 700 → 2 列;否则 4 列
grab(SRC.draft, /isDraftNarrow = draftContentWidth < 560/, 'grid 列断点 560 缺失');
grab(SRC.draft, /isDraftMedium = draftContentWidth < 700/, 'grid 列断点 700 缺失');
// main 横向 padding 档:px-4(narrow) / px-8
grab(SRC.draft, /isDraftNarrow\s*\n?\s*\? 'px-4/, 'main narrow padding px-4 缺失');
// --text-13 = 13px(text-13 = var(--text-13),定义在 globals.css)
grab(SRC.globals, /--text-13:\s*13px/, 'globals.css 缺 --text-13: 13px');
grab(SRC.globals, /--text-14:\s*14px/, 'globals.css 缺 --text-14: 14px');

const card = {
  gapPx: leaf(4, SRC.draft, 'className gap-1 → 4px(Tailwind spacing 1 = 0.25rem)'),
  radiusPx: leaf(12, SRC.draft, 'className rounded-xl → 12px(与输入框统一,见代码注释)'),
  borderPx: leaf(1, SRC.draft, 'className border → 1px'),
  iconCirclePx: leaf(32, SRC.draft, 'className h-8 w-8 → 32px icon 圆圈'),
  iconGlyphPx: leaf(16, SRC.draft, 'Icon size={16} → 16px glyph'),
  labelFontPx: leaf(13, SRC.globals, 'text-13 = var(--text-13) = 13px(globals.css)'),
  labelLinePx: leaf(13 * labelLeading, SRC.draft, `className leading-[${labelLeading}] × text-13 → ${13 * labelLeading}px`),
  padNarrowPx: leaf(12, SRC.draft, 'narrow 档 p-3 → 12px'),
  padNormalPx: leaf(16, SRC.draft, '常态 p-4 → 16px'),
  minHNarrowPx: leaf(84, SRC.draft, 'narrow 档 min-h-[84px]'),
  minHNormalPx: leaf(112, SRC.draft, '常态 min-h-[112px]'),
  gridGapPx: leaf(12, SRC.draft, 'grid gap-3 → 12px'),
};

const section = {
  titleFontPx: leaf(14, SRC.draft, 'section 标题 text-14 = var(--text-14) = 14px'),
  titleLinePx: leaf(14 * sectionLeading, SRC.draft, `section 标题 leading-[${sectionLeading}] × text-14 → ${14 * sectionLeading}px`),
  titles: sectionTitles,
};

// ========== 4. 主题 token(colors.ts registerColor 的 light/dark hex) ==========
function color(tokenName) {
  const re = new RegExp(
    `registerColor\\('${tokenName.replace(/[-]/g, '\\-')}',\\s*\\{\\s*light:\\s*'([^']+)',\\s*dark:\\s*'([^']+)'`,
  );
  const m = grab(SRC.colors, re, `colors.ts 缺 token ${tokenName}`);
  return { light: m[1], dark: m[2] };
}
const T = {
  cardBg: color('create-agent-quick-card-bg'),
  cardBorder: color('create-agent-quick-card-border'),
  cardText: color('create-agent-quick-card-text'),
  iconBg: color('create-agent-quick-card-icon-bg'),
  icon: color('create-agent-quick-card-icon'),
  cardBgHover: color('create-agent-quick-card-bg-hover'),
  textSecondary: color('text-secondary'),
};
const colorLeaf = (name, mode) => leaf(T[name][mode], SRC.colors, `registerColor('${name === 'textSecondary' ? 'text-secondary' : 'create-agent-quick-card-' + kebab(name)}').${mode}`);
function kebab(n) {
  return ({ cardBg: 'bg', cardBorder: 'border', cardText: 'text', iconBg: 'icon-bg', icon: 'icon', cardBgHover: 'bg-hover' })[n];
}
const colors = {
  light: {
    cardBg: colorLeaf('cardBg', 'light'),
    cardBorder: colorLeaf('cardBorder', 'light'),
    cardText: colorLeaf('cardText', 'light'),
    iconBg: colorLeaf('iconBg', 'light'),
    icon: colorLeaf('icon', 'light'),
    cardBgHover: colorLeaf('cardBgHover', 'light'),
    textSecondary: colorLeaf('textSecondary', 'light'),
  },
  dark: {
    cardBg: colorLeaf('cardBg', 'dark'),
    cardBorder: colorLeaf('cardBorder', 'dark'),
    cardText: colorLeaf('cardText', 'dark'),
    iconBg: colorLeaf('iconBg', 'dark'),
    icon: colorLeaf('icon', 'dark'),
    cardBgHover: colorLeaf('cardBgHover', 'dark'),
    textSecondary: colorLeaf('textSecondary', 'dark'),
  },
};

// ========== 5. 布局公式常量(useProportionalWidth.ts + 调用点 minWidth) ==========
const numFrom = (relPath, re, name) => {
  const m = grab(relPath, re, `${name} 常量缺失`);
  return Number(m[1]);
};
const MAX_MESSAGE_WIDTH = numFrom(SRC.hook, /MAX_MESSAGE_WIDTH\s*=\s*(\d+)/, 'MAX_MESSAGE_WIDTH');
const INPUT_OUTSET = numFrom(SRC.hook, /INPUT_OUTSET\s*=\s*(\d+)/, 'INPUT_OUTSET');
const DEFAULT_MESSAGE_PAD = numFrom(SRC.hook, /DEFAULT_MESSAGE_PAD\s*=\s*(\d+)/, 'DEFAULT_MESSAGE_PAD');
const COMPACT_MESSAGE_PAD = numFrom(SRC.hook, /COMPACT_MESSAGE_PAD\s*=\s*(\d+)/, 'COMPACT_MESSAGE_PAD');
const AUTO_COMPACT_THRESHOLD = numFrom(SRC.hook, /AUTO_COMPACT_THRESHOLD\s*=\s*(\d+)/, 'AUTO_COMPACT_THRESHOLD');
const MIN_WIDTH = numFrom(SRC.draft, /useProportionalWidth\(914,\s*\{\s*minWidth:\s*(\d+)\s*\}\)/, 'minWidth 地板');

const layout = {
  maxMessageWidthPx: leaf(MAX_MESSAGE_WIDTH, SRC.hook, 'MAX_MESSAGE_WIDTH'),
  inputOutsetPx: leaf(INPUT_OUTSET, SRC.hook, 'INPUT_OUTSET'),
  defaultMessagePadPx: leaf(DEFAULT_MESSAGE_PAD, SRC.hook, 'DEFAULT_MESSAGE_PAD'),
  compactMessagePadPx: leaf(COMPACT_MESSAGE_PAD, SRC.hook, 'COMPACT_MESSAGE_PAD'),
  autoCompactThresholdPx: leaf(AUTO_COMPACT_THRESHOLD, SRC.hook, 'AUTO_COMPACT_THRESHOLD'),
  minWidthFloorPx: leaf(MIN_WIDTH, SRC.draft, 'useProportionalWidth(914,{minWidth:640})'),
  colBreak1Px: leaf(560, SRC.draft, 'isDraftNarrow = draftContentWidth < 560(1↔2 列 + narrow 档)'),
  colBreak2Px: leaf(700, SRC.draft, 'isDraftMedium = draftContentWidth < 700(2↔4 列)'),
  mainPadNarrowPx: leaf(16, SRC.draft, 'main narrow px-4 → 16px/侧'),
  mainPadNormalPx: leaf(32, SRC.draft, 'main 常态 px-8 → 32px/侧'),
};

// —— 产品布局公式(复刻 useProportionalWidth.compute + 草稿页 grid/main padding) ——
// oracle:验收侧不重写,只 resize→量 DOM 比对本表。
function inputWidthFor(C) {
  const useCompact = C < AUTO_COMPACT_THRESHOLD;
  const pad = useCompact ? COMPACT_MESSAGE_PAD : DEFAULT_MESSAGE_PAD;
  const msgAvail = Math.max(0, C - 2 * pad);
  const msg = Math.min(MAX_MESSAGE_WIDTH, msgAvail);
  let input = msg + INPUT_OUTSET;
  if (MIN_WIDTH > input) input = Math.min(MIN_WIDTH, C);
  return input;
}
function layoutFor(C) {
  const input = inputWidthFor(C);
  const narrow = input < 560;
  const mainPx = narrow ? 16 : 32;
  const avail = Math.max(0, C - 2 * mainPx);
  const columnW = Math.min(input, avail); // 列 maxWidth=input,但受 main 可用宽钳制
  const cols = input < 560 ? 1 : input < 700 ? 2 : 4;
  const gap = 12;
  const cardW = (columnW - (cols - 1) * gap) / cols;
  const cardH = narrow ? 84 : 112;
  return { columnW, cardW, cardH };
}

// ========== 6. adaptive.samples(免 provenance:门 A extractor-drift 覆盖) ==========
// sampleSizes 必须与 spec.json 的 adaptive.sampleSizes 完全一致(手动保持同步)。
const SAMPLE_SIZES = [
  [480, 700], [540, 700], [559, 700], [560, 700], [561, 700],
  [640, 700], [680, 700], [699, 700], [700, 700], [720, 700],
  [779, 700], [780, 700], [781, 700], [1000, 700], [1299, 700],
  [1300, 700], [1440, 900],
];
const round1 = (n) => Math.round(n * 100) / 100;
const samples = SAMPLE_SIZES.map(([w, h]) => {
  const L = layoutFor(w);
  return {
    w,
    h,
    probes: {
      quickstarts: { w: round1(L.columnW) },
      input: { w: round1(L.columnW) },
      card0: { w: round1(L.cardW), h: L.cardH },
    },
  };
});

// ========== 输出 ==========
const truth = {
  supportedLocales: LOCALES.map((locale, index) =>
    leaf(locale, SRC.locales, `SUPPORTED_LOCALES[${index}]`),
  ),
  cards,
  section,
  card,
  colors,
  layout,
  adaptive: { samples },
};

process.stdout.write(JSON.stringify(truth));
