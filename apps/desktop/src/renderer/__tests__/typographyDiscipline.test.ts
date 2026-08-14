import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 排版纪律守护测试(#1505 PR4,含对抗式双审三轮加固)—— 桌面端字重 / 字号
 * 白名单的 CI 红线。蓝本 = 手机端 typographyTokenDiscipline.test.ts;规范正文 =
 * DESIGN.md §3「字重阶梯」与「桌面 UI 字号白名单」(2026-08 修订)。
 *
 * ## 规则(值白名单制:值出梯即红,豁免须在下方 EXEMPTIONS 精确登记)
 *  1. Tailwind 字重类只许 font-normal / font-medium / font-semibold;
 *     font-bold 及以上、以下与任意值 font-[...] 一律禁止(豁免域除外)。
 *  2. Tailwind 任意值字号 text-[N<unit>]、无类型提示的长度函数、属性形式
 *     `[font-size:...]` 与 `text-[length:...]` 零容忍(`length:` 前缀一律命中,
 *     已登记值走精确豁免):
 *     数字开头的任意值(单位不枚举,含现代 viewport / font-relative /
 *     container-query 单位)、大小写不敏感、含小数与 .75 形态、length: 前缀
 *     及已识别的长度函数均命中;已登记的 code-font/compact 派生值只能按
 *     具体文件 + 具体命中精确豁免。对可解析为字号的关键字同样默认拒绝,
 *     不要用开放集合的枚举代替默认拒绝;token 类
 *     text-<n> 的 <n> 必须在白名单内,语义类只收编 xs/sm/base/lg。
 *  3. fontWeight / fontSize 的值片段(冒号、JSX 属性 =、style 赋值、三元两臂,
 *     **允许跨行**)必须落梯:weight 任意数字字面量 ∈ {400,500,600}(550/650
 *     中间值与 <100/>1000 越界值同判),bold/bolder/lighter 关键字大小写
 *     不敏感全红;size 裸数字与 px 值 ∈ 白名单,
 *     pt/ch 等非 px 绝对/视口单位一律红(em/rem/% 相对比例域放行,已登记)。
 *  4. JS 字符串内嵌 CSS 与 .css 的 font-weight 声明(允许跨行)按**完整值**
 *     白名单判定:数值(含小数,400.5 不会截成 400 放行)必须精确 ∈
 *     {400,500,600};关键字大小写归一后 bold/bolder/lighter 判红,
 *     normal(=400)与 inherit(继承梯内值)放行;属性名与关键字均
 *     大小写不敏感(CSS 语义);
 *     font: shorthand 只放行 `font: inherit`:尺寸单位形态、system font
 *     关键字(caption 等六个)、size 关键字起头(medium serif / large Arial)、
 *     style/weight/variant/stretch 关键字或三位字重起头、var(...)、
 *     initial/unset/revert(-layer) 全部判红。
 *  5. CSS 扫描先做有状态块注释剥离(保行号);TS/TSX 扫描先做行级注释归零,
 *     `*` 起头行仅在**非选择器形态**时按 jsdoc 跳过(`* {` / `*{` 照常受检)。
 *  6. 同一行 / 同一文件多个违规逐个计数(occurrence 级)—— 在已豁免文件里
 *     追加新违规同样会红。
 *  7. 镜像检查覆盖规范正本(DESIGN.md §3 白名单)与三处权威来源代码
 *     (tailwind.config.ts fontSize / globals.css `--text-<n>` /
 *     useFontSettings.ts `UI_TEXT_TOKEN_SIZES`);另单独校验消费端
 *     `lib/utils.ts` tailwind-merge 字号去重组的一致性。SCALED_TAILWIND_TOKENS
 *     只负责语义类运行时缩放,与 numeric 白名单无关,不计入任何计数。
 *     配置中仍保留 xl..5xl 语义映射(源码零使用),不可简单删除:它们挂在
 *     theme.extend 下,删除会静默回退到不跟随用户缩放的 Tailwind 默认值;
 *     守卫在源码侧拒绝 xl..9xl,配置清理留待后续改成显式 numeric 档位。
 *  8. 会缩放的字号 token(`text-<n>` / `text-xs|sm|base|lg`)不得与固定 px 行高
 *     `leading-[Mpx]` 同处一个 class 值区域:字号跟随「外观 → UI 字号」缩放而
 *     固定行框不跟随,放大字号即裁切 / 重叠。判定按 className / cn(...) 的
 *     **整块区域**(跨行)而非同一行 —— 单行比对会漏掉 `cn()` 分行写法。
 *     修法是改成无单位比例(比例 = 原 px ÷ 字号),默认字号下渲染不变。
 *
 * ## 豁免(精确绑定:文件 + 规则 + 理由 + 具体合法命中/上下文及期望次数)
 *  每条豁免按具体 match 与上下文签名计数;新增 font-black 或 800 即使总数不变也红。
 *  豁免域清单与理由正本见 DESIGN.md §3「排版豁免登记表」;下表是其中
 *  落到静态扫描命中的子集(外部页注入的字体族、手机 WebView 生成器、紧凑
 *  派生值等域由「合法值 / SKIP / 手机侧守卫」承接,天然无命中,不在此表)。
 *
 * ## 盲区清单(显式登记,不宣称全入口;新增写法先补扫描再用)
 *  - 动态拼接的 class / 样式字符串(`'text-[' + n + 'px]'`)、跨文件常量组装、
 *    数值经变量间接传入(`fontWeight: W` 且 W 定义在别处);
 *  - 非常规数字字面量形态:数字分隔符(6_50)、进制字面量(0x28a)、科学计数
 *    (5e2)不参与判定(非现实字重写法);函数调用**子表达式**(toWeight(550),
 *    含其参数域)逐层剔除后按动态值跳过——片段剩余部分的直接字面量(括号
 *    包裹、混合三元的字面量臂)照判;shorthand 的 && / || 逻辑表达式按动态值
 *    跳过,不按内部 token 误判;多行三元只覆盖值首行;
 *  - fontSize 的相对比例值(em / rem / %,如编辑器标题系数)与算式派生值
 *    (`size * 0.86`、`17 / 1`,片段含 * 或 / 即跳过)—— 非静态可判;
 *  - 内联字号盲区: `style={{ fontSize: <number | 'Npx'> }}` 形式的白名单档位
 *    当前允许通过,但 `applyFontSettings` 只改写 `--text-*` 变量,这些字面量不会
 *    响应设置页的 UI 字号缩放。实测共有 48 处未登记命中,其中约 39 处是真实 UI:
 *    `features/skillhub/` 共 27 处(`InstallTargetPicker` 10 / `MarketCard` 8 /
 *    `SkillhubMarketListView` 6 / `SkillhubMarketPreviewPanel` 3),另有
 *    `MakerExperimentalView` 4、`LegacyMigrationDialog` 3、`ModelLightbox` 1、
 *    `ImageLightbox` 1、`LoginControls` 2、`AttachmentTypeThumb` 1;其余命中包括
 *    `codemirrorGithubTheme.ts`、`shareConversationImage.ts` 与 `xtermPool.ts`。
 *    `codemirrorGithubTheme.ts` / `loginDesignTokens.ts` 各 13 处属既有豁免域;
 *    SVG `fontSize="N"` 属性与 `xtermPool.ts` 的数字入参属于无法用 token 类表达的
 *    结构性合法用法。收紧方向是静态内联字号默认判红,仅为 SVG/画布/第三方 API
 *    登记精确豁免;本 PR 不处理,后续独立施工需改约 48 处调用点并先界定豁免边界,
 *    再完成设计核对与 Light/Dark 双模式验收;
 *  - CSS `@apply` 排版类盲区:CSS 分支当前只扫描显式 `font-weight` / `font:`
 *    声明,不解析 `.x { @apply font-bold; }` 或字号类;Tailwind PostCSS 展开后
 *    可能产生守卫未见的字重/字号。此类形态本轮不改扫描,后续独立施工需纳入
 *    CSS 类名检查或明确拒绝排版类 `@apply`,并补对应红 fixture;
 *  - CSS font-weight 的动态值(var(...)、模板插值、calc())与
 *    initial/unset/revert 全局关键字(计算结果不引入梯外静态值)不判红;
 *  - .css 与字符串内嵌 CSS 的直接 font-size 声明值域(紧凑模式 -1px 派生、
 *    FileBrowserBody 的 em 标题系数、oauthResultPage 品牌块等机制/豁免域,
 *    v1 不做值校验);新增规则先扩展 CSS 值扫描并登记精确派生豁免;
 *  - renderer HTML 模板只扫描 class 中的 Tailwind 字号/字重类,不解析内联
 *    style 的 CSS font-size 值;CSS 值域走上条登记盲区;
 *  - 注释剥离为启发式而非解析器:TS 行中块注释、含「空白+//」的字符串字面量、
 *    CSS 字符串字面量内的块注释起始序列(content 属性存 "/*" 类)可造成漏报;
 *    jsdoc 中「* {@link …}」形态的行会被当作选择器行扫描(可能误报,现库零实例);
 *  - src/renderer/vendor/(第三方 vendored 产物)与构建产物;
 *  - 原生层(macOS agent-island Swift helper 等,见 DESIGN.md §3 non-goals);
 *  - 手机端(apps/mobile 有自己的 typographyTokenDiscipline 守卫,其 WebView
 *    HTML 生成器盲区在彼处登记)。
 */

const ROOT = join(__dirname, '..', '..', '..');
const SCAN_DIR = join(ROOT, 'src');
const DESIGN_MD = join(ROOT, '..', '..', 'docs', 'design-rules', 'DESIGN.md');

/** DESIGN.md §3 桌面 UI 字号白名单(镜像检查覆盖规范正本与三处权威来源)。 */
const SIZE_WHITELIST = [10, 11, 12, 13, 14, 15, 16, 18, 20, 24, 28] as const;
const SIZE_SET = new Set<number>(SIZE_WHITELIST);
const SEMANTIC_TOKEN_VALUES = {
  xs: 12,
  sm: 14,
  base: 16,
  lg: 18,
  xl: 20,
  '2xl': 24,
  '3xl': 30,
  '4xl': 36,
  '5xl': 48,
} as const;
/** 字重:UI chrome 工作集(700 只许经豁免,见 DESIGN.md §3 字重阶梯)。 */
const WEIGHT_SET = new Set([400, 500, 600]);

/** 整文件不扫描:画布常量本体 / 测试 / vendored 第三方。 */
const SKIP_FILES = [
  /__tests__\//,
  /\.test\.(ts|tsx)$/,
  // 登录品牌画布常量本体(设计 px 坐标系,DESIGN.md §3 豁免表;地位对齐手机端
  // loginSkinLayout.ts):字面量只许进这里,消费组件仍被全量扫描。
  /^src\/renderer\/components\/login\/loginDesignTokens\.ts$/,
  /^src\/renderer\/vendor\//,
];

interface Exemption {
  file: string;
  rule: string;
  /** 理由(正本在 DESIGN.md §3 排版豁免登记表)。 */
  reason: string;
  /** 允许的具体命中/上下文及 occurrence 期望次数;未登记签名一律不享有豁免。 */
  signatures: ReadonlyArray<{ match: string; expected: number; context?: string }>;
}

const EXEMPTIONS: Exemption[] = [
  // 登录/Splash 品牌画布域:Tailwind font-bold ×7 + 内联 700 五处形态
  // (238 直接字面量、290 filled/error 三元、300/310 focus/blur style 赋值、748 内联 style)。
  {
    file: 'src/renderer/components/login/LoginControls.tsx',
    rule: 'tw-weight',
    reason: '登录品牌画布 Bold(§16)',
    signatures: [{ match: 'font-bold', expected: 7 }],
  },
  {
    file: 'src/renderer/components/login/LoginControls.tsx',
    rule: 'inline-weight',
    reason: '登录品牌画布 Bold(§16,含 filled/focus 态三元与 style 赋值)',
    signatures: [{ match: 'fontWeight …700', expected: 5 }],
  },
  {
    file: 'src/renderer/components/auth/LegacyMigrationDialog.tsx',
    rule: 'inline-weight',
    reason: '登录品牌画布家族(680→490 缩放),字重按 #1505 拍板豁免',
    signatures: [{ match: 'fontWeight …700', expected: 2 }],
  },
  {
    file: 'src/renderer/components/markdown/codemirrorGithubTheme.ts',
    rule: 'inline-weight',
    reason: 'markdown 内容域:编辑器 strong 语法节点(§3 豁免表「markdown 内容」行)',
    signatures: [{ match: 'fontWeight …bold', expected: 1 }],
  },
  {
    file: 'src/main/oauthResultPage.ts',
    rule: 'string-weight',
    reason: '登录品牌画布家族(自包含品牌页生成器,§3 豁免表)',
    signatures: [{ match: 'font-weight:700', expected: 2 }],
  },
  {
    file: 'src/renderer/styles/globals.css',
    rule: 'css-weight',
    reason: 'hljs 语法高亮主题移植(§3 豁免表,保真优先)',
    signatures: [
      { match: 'font-weight: bold', context: '.dark .hljs-section', expected: 1 },
      { match: 'font-weight: bold', context: '.dark .hljs-strong', expected: 1 },
      {
        match: 'font-weight: bold',
        context: "[data-theme='solarized-light'] .hljs-strong",
        expected: 1,
      },
      {
        match: 'font-weight: bold',
        context:
          "[data-theme='solarized-light'] .hljs-meta .hljs-keyword, [data-theme='solarized-light'] .hljs-meta-keyword",
        expected: 1,
      },
    ],
  },
  // 紧凑代码字号是 DESIGN.md §3 已登记的机制本体;只允许这些现有文件/具体类。
  {
    file: 'src/renderer/components/chat/AgentActionRow.tsx',
    rule: 'arb-size',
    reason: '紧凑代码字号派生值',
    signatures: [{ match: 'text-[length:calc(var(--app-code-font-size)_-_1px)]', expected: 1 }],
  },
  {
    file: 'src/renderer/components/chat/DiffView.tsx',
    rule: 'arb-size',
    reason: '紧凑代码字号派生值',
    signatures: [{ match: 'text-[length:calc(var(--app-code-font-size)_-_1px)]', expected: 1 }],
  },
  {
    file: 'src/renderer/components/chat/GhostSummonCard.tsx',
    rule: 'arb-size',
    reason: '紧凑代码字号派生值',
    signatures: [{ match: 'text-[length:calc(var(--app-code-font-size)_-_1px)]', expected: 1 }],
  },
  {
    file: 'src/renderer/components/chat/MarkdownDiffBlock.tsx',
    rule: 'arb-size',
    reason: '紧凑代码字号派生值',
    signatures: [{ match: 'text-[length:calc(var(--app-code-font-size)_-_1px)]', expected: 1 }],
  },
  {
    file: 'src/renderer/components/chat/MarkdownMermaidBlock.tsx',
    rule: 'arb-size',
    reason: '代码字号变量',
    signatures: [{ match: 'text-[length:var(--app-code-font-size)]', expected: 2 }],
  },
  {
    file: 'src/renderer/components/chat/MarkdownRenderer.tsx',
    rule: 'arb-size',
    reason: '代码字号变量',
    signatures: [{ match: 'text-[length:var(--app-code-font-size)]', expected: 2 }],
  },
  {
    file: 'src/renderer/components/chat/SystemCard.tsx',
    rule: 'arb-size',
    reason: '紧凑代码字号派生值',
    signatures: [
      { match: 'text-[length:calc(var(--app-code-font-size)_-_1.5px)]', expected: 1 },
      { match: 'text-[length:calc(var(--app-code-font-size)_-_1px)]', expected: 2 },
    ],
  },
  {
    file: 'src/renderer/components/chat/ToolCallCard.tsx',
    rule: 'arb-size',
    reason: '紧凑代码字号派生值',
    signatures: [{ match: 'text-[length:calc(var(--app-code-font-size)_-_1px)]', expected: 2 }],
  },
  {
    file: 'src/renderer/components/chat/ToolPayloadLightbox.tsx',
    rule: 'arb-size',
    reason: '紧凑代码字号派生值',
    signatures: [{ match: 'text-[length:calc(var(--app-code-font-size)_-_1px)]', expected: 3 }],
  },
  {
    file: 'src/renderer/components/chat/UserMessage.tsx',
    rule: 'arb-size',
    reason: '紧凑代码字号派生值',
    signatures: [{ match: 'text-[length:calc(var(--app-code-font-size)_-_2px)]', expected: 1 }],
  },
  {
    file: 'src/renderer/components/markdown/MermaidSourceEditor.tsx',
    rule: 'arb-size',
    reason: '紧凑代码字号派生值',
    signatures: [{ match: 'text-[length:calc(var(--app-code-font-size)_-_1px)]', expected: 1 }],
  },
  {
    file: 'src/renderer/components/new-chat/PermissionPrompt.tsx',
    rule: 'arb-size',
    reason: '紧凑代码字号派生值',
    signatures: [{ match: 'text-[length:calc(var(--app-code-font-size)_-_1px)]', expected: 1 }],
  },
  {
    file: 'src/renderer/features/skillhub/PublishDialog.tsx',
    rule: 'arb-size',
    reason: '紧凑代码字号派生值',
    signatures: [{ match: 'text-[length:calc(var(--app-code-font-size)_-_3px)]', expected: 1 }],
  },
  {
    file: 'src/renderer/features/skillhub/SkillhubDetailView.tsx',
    rule: 'arb-size',
    reason: '代码字号变量',
    signatures: [{ match: 'text-[length:var(--app-code-font-size)]', expected: 1 }],
  },
];

// ── 预处理 ──────────────────────────────────────────────────────────

/** TS/TSX 行预处理:整行注释归 null(// 与 jsdoc 续行 *),剥「空白+//」尾注释。
 *  `*` 起头但形如 CSS 选择器(`* {` / `*{` / `*,`)的行**不是**注释——模板字符串
 *  内嵌 CSS 的通配选择器必须照常受检(红队三轮 P1)。 */
export function prepareTsLine(line: string): string | null {
  const t = line.trim();
  if (t.startsWith('//') || t.startsWith('/*')) return null;
  if (t.startsWith('*') && !/^\*\s*[{,]/.test(t)) return null;
  return line.replace(/\s\/\/.*$/, '');
}

/** TS/TSX 全文预处理:逐行套 prepareTsLine,注释行置空但**保行数**。 */
export function prepareTsContent(raw: string): string {
  return raw
    .split('\n')
    .map((line) => prepareTsLine(line) ?? '')
    .join('\n');
}

/** CSS 全文预处理:有状态剥离块注释,注释区域以空格填充保住行号与列语境。 */
export function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

interface Hit {
  match: string;
  index: number;
  /** CSS selector/context for declarations whose exemption must be location-bound. */
  context?: string;
}

// ── 检查器(输入为**预处理后的全文**,返回全部命中及偏移;红绿 fixture 直测) ──

/** 规则 1:Tailwind 禁用字重类与任意值字重。 */
export function findTwWeightViolations(text: string): Hit[] {
  return [
    ...[...text.matchAll(/\bfont-(?:thin|extralight|light|bold|extrabold|black)\b/g)],
    ...[...text.matchAll(/\bfont-\[[^\]\n]*\]/g)],
  ].map((m) => ({ match: m[0], index: m.index ?? 0 }));
}

/** 规则 2a:任意值字号类零容忍 —— 全长度单位、大小写不敏感、含 .75 形态。 */
export function findArbitrarySizes(text: string): Hit[] {
  return [
    ...text.matchAll(
      /\btext-\[(?:(?:\d+(?:\.\d+)?|\.\d+)[^\]\n]*|length:[^\]\n]+|(?:calc|clamp|min|max)\([^\]\n]+\)|[a-z-]+)\]/gi,
    ),
    ...text.matchAll(/\[(?:font-size):[^\]\n]+\]/gi),
  ].map((m) => ({ match: m[0], index: m.index ?? 0 }));
}

/** 规则 2b:token 字号类必须在白名单档内。 */
export function findOffLadderTokenSizes(text: string): Hit[] {
  const hits: Hit[] = [];
  for (const m of text.matchAll(/\btext-(\d+)\b/g)) {
    if (!SIZE_SET.has(Number(m[1]))) hits.push({ match: m[0], index: m.index ?? 0 });
  }
  // DESIGN.md 只收编 xs/sm/base/lg; Tailwind 默认仍提供 xl..9xl,
  // 所以必须显式拦截这些可用但白名单外的语义类。
  for (const m of text.matchAll(/\btext-(xl|[2-9]xl)\b/g)) {
    hits.push({ match: m[0], index: m.index ?? 0 });
  }
  return hits;
}

/** 取关键字之后的值片段。分隔符([:=])后按值形态截断:引号值取引号内、
 *  JSX 表达式属性(={…})取花括号内、裸值截到 [,;}\n] —— 分隔符前后允许换行,
 *  因此 `fontWeight:\n 800` 这类跨行声明照常落网;多行三元只覆盖首行
 *  (prettier 惯例下值不拆行,残余形态记入盲区)。 */
function segmentsAfter(text: string, keyword: string): Hit[] {
  const segments: Hit[] = [];
  for (const m of text.matchAll(new RegExp(`\\b${keyword}\\b\\s*[:=]?\\s*`, 'g'))) {
    const rest = text.slice((m.index ?? 0) + m[0].length);
    const first = rest[0];
    let segment: string;
    if (first === '"' || first === "'" || first === '`') {
      const end = rest.indexOf(first, 1);
      segment = end === -1 ? rest.slice(1) : rest.slice(1, end);
    } else if (first === '{') {
      const end = rest.indexOf('}', 1);
      segment = end === -1 ? rest.slice(1) : rest.slice(1, end);
    } else {
      segment = rest.split(/[,;}\n]/, 1)[0] ?? '';
    }
    segments.push({ match: segment, index: m.index ?? 0 });
  }
  return segments;
}

/** 规则 3a:fontWeight 值片段全数落梯。口径 = **十进制裸/引号数字字面量**
 *  (含中间值 550/650 与越界值);数字分隔符(6_50)、进制字面量(0x28a)、
 *  科学计数(5e2)与函数调用表达式(toWeight(550))为登记盲区——前三者非
 *  现实字重写法,后者为动态值不按内部参数误判(红队四轮)。 */
export function findInlineWeightViolations(text: string): Hit[] {
  const hits: Hit[] = [];
  for (const seg of segmentsAfter(text, 'fontWeight')) {
    // 只剔除**函数调用子表达式**本体(内层起逐层剥,参数域按动态值登记盲区),
    // 剩余部分的直接字面量照判——`(700)` 括号包裹与「一臂函数、一臂字面量」的
    // 混合三元不再整段跳过(gate-audit 五轮)。
    let scannable = seg.match;
    let prev: string;
    do {
      prev = scannable;
      scannable = scannable.replace(/[A-Za-z_$][\w$]*\s*\([^()]*\)/g, ' ');
    } while (scannable !== prev);
    // 关键字大小写不敏感(值最终进 CSS,'BOLD' 与 'bold' 等效):bold/bolder/
    // lighter 全红;normal(=400)放行。
    for (const m of scannable.matchAll(/\b(\d+(?:\.\d+)?)\b|\b(?:bold(?:er)?|lighter)\b/gi)) {
      if (m[1] && WEIGHT_SET.has(Number(m[1]))) continue;
      hits.push({ match: `fontWeight …${m[0]}`, index: seg.index });
    }
  }
  return hits;
}

/** 规则 3b:fontSize 值片段——裸数字与 px 值必须在白名单,pt/ch/vw 等非 px
 *  绝对/视口单位一律红;em/rem/% 相对比例与算式派生(含 * 或 /)放行(登记盲区)。 */
export function findInlineSizeViolations(text: string): Hit[] {
  const hits: Hit[] = [];
  for (const seg of segmentsAfter(text, 'fontSize')) {
    if (/[*/]/.test(seg.match)) continue;
    for (const m of seg.match.matchAll(
      /(?<![\w.])(\d+(?:\.\d+)?|\.\d+)(px|r?em|%|pt|pc|ch|ex|q|cm|mm|in|vw|vh|vmin|vmax)?\b/gi,
    )) {
      const unit = m[2]?.toLowerCase();
      if (unit === 'em' || unit === 'rem' || unit === '%') continue;
      if (unit && unit !== 'px') {
        hits.push({ match: `fontSize …${m[0]}(非 px 单位)`, index: seg.index });
        continue;
      }
      if (!SIZE_SET.has(Number(m[1]))) hits.push({ match: `fontSize …${m[1]}`, index: seg.index });
    }
  }
  return hits;
}

/** 规则 4a/5:CSS 声明(字符串内嵌或 .css,允许跨行)的 font-weight 按完整值
 *  白名单判定(gate-audit 四轮):值截到 [;}\n],剥 !important 后——数值
 *  (含小数)必须精确 ∈ WEIGHT_SET(400.5 不再截成 400 放行);关键字统一
 *  lower-case 后 bold/bolder/lighter 判红,normal/inherit 放行;var(...)、
 *  模板插值等动态值与 initial/unset/revert 为登记盲区。属性名 /i。 */
function cssSelectorContextAt(text: string, index: number): string | undefined {
  const before = text.slice(0, index);
  const blockStart = before.lastIndexOf('{');
  const blockEnd = before.lastIndexOf('}');
  if (blockStart <= blockEnd) return undefined;
  const selector = before
    .slice(blockEnd + 1, blockStart)
    .trim()
    .replace(/\s+/g, ' ');
  return selector || undefined;
}

export function findStringWeightViolations(
  text: string,
  options: { includeSelectorContext?: boolean } = {},
): Hit[] {
  const hits: Hit[] = [];
  for (const m of text.matchAll(/font-weight\s*:\s*([^;}\n]+)/gi)) {
    const value = m[1]
      .replace(/\s*!important\s*$/i, '')
      .trim()
      .toLowerCase();
    if (!value) continue;
    if (/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) {
      if (WEIGHT_SET.has(Number(value))) continue;
    } else if (!/^(?:bold(?:er)?|lighter)$/.test(value)) {
      continue;
    }
    const index = m.index ?? 0;
    hits.push({
      match: m[0].replace(/\s+/g, ' ').slice(0, 60),
      index,
      ...(options.includeSelectorContext ? { context: cssSelectorContextAt(text, index) } : {}),
    });
  }
  return hits;
}

/** 规则 4b:font: shorthand 只放行 `font: inherit`。六类形态全判(双审三轮):
 *   a) 值含尺寸单位;b) CSS system font 关键字;c) size 关键字起头且后随
 *   更多 token(medium serif / large Arial);d) style/weight/variant/stretch
 *   关键字或三位字重起头且后随更多 token;e) var(...);f) initial/unset/
 *   revert(-layer) 等 inherit 以外的 global keyword。
 *  非 CSS 语境对象键(`font: 20,`、`font: someVar`)与带引号值不满足任一形态,
 *  天然放行。 */
export function findFontShorthands(text: string): Hit[] {
  const hits: Hit[] = [];
  // 裸值与引号值双通道:style 对象里的 font: 'bold 12px system-ui' 属引号值
  // 形态(红队四轮),同样按六形态判;含 && / || 的 TS 逻辑表达式跳过
  // (bold && medium 这类标识符运算不是 CSS 声明,防误报)。
  // 属性名同样 /i(CSS property 大小写不敏感,`FONT:` 不得绕过)。
  const candidates: Hit[] = [];
  for (const m of text.matchAll(/\bfont\s*:\s*(['"`])([^'"`\n]*)\1/gi)) {
    candidates.push({ match: m[2], index: m.index ?? 0 });
  }
  for (const m of text.matchAll(/\bfont\s*:\s*([^;,}'"]*)/gi)) {
    candidates.push({ match: m[1], index: m.index ?? 0 });
  }
  for (const c of candidates) {
    const value = c.match.replace(/\s+/g, ' ').trim();
    if (!value || value === 'inherit' || /&&|\|\|/.test(value)) continue;
    const unitForm =
      /(?:\d+(?:\.\d+)?|\.\d+)(?:px|r?em|pt|pc|ch|ex|q|cm|mm|in|vw|vh|vmin|vmax)\b/i.test(value);
    const systemKeyword = /^(?:caption|icon|menu|message-box|small-caption|status-bar)\b/i.test(
      value,
    );
    const sizeKeywordShorthand =
      /^(?:xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|smaller|larger)\b\s+\S/i.test(
        value,
      );
    // numeric weight 起头按完整数值文法判(两位/四位/小数/带符号同样是
    // shorthand 形态,50 / 1000 / 700.5 / +700 不得绕过——gate-audit 五轮)。
    const styleKeywordShorthand =
      /^(?:normal|italic|oblique|bold|bolder|lighter|small-caps|(?:ultra-|extra-|semi-)?(?:condensed|expanded)|[+-]?(?:\d+(?:\.\d+)?|\.\d+))\s+\S/i.test(
        value,
      );
    const varForm = /^var\(/i.test(value);
    const globalKeyword = /^(?:initial|unset|revert(?:-layer)?)\b/i.test(value);
    if (
      unitForm ||
      systemKeyword ||
      sizeKeywordShorthand ||
      styleKeywordShorthand ||
      varForm ||
      globalKeyword
    ) {
      hits.push({ match: `font: ${value}`.slice(0, 60), index: c.index });
    }
  }
  return hits;
}

/**
 * 固定 px 行高 + 会缩放的字号 token = 功能缺陷(不是行高风格漂移)。
 *
 * `text-<n>` / `text-xs|sm|base|lg` 经 `--text-*` 响应「外观 → UI 字号」设置,
 * `leading-[Mpx]` 的行框不跟随;用户把字号调大时文字在固定行框里裁切 / 重叠。
 * 一律改成无单位比例(比例 = 原 px ÷ 字号),默认字号下渲染不变。
 * 规范见 DESIGN.md §3 non-goals 的行高例外条款。
 *
 * 判定按「同一个 class 值区域」而不是同一行:`cn(...)` 会把字号与行高分散到
 * 不同行,只比对单行会漏 —— #1553 就是这样漏掉过 PlanActionCard 一处,
 * 因此这里做括号 / 引号配对取整块区域再比对。
 */
const SIZE_TOKEN_IN_CLASS = /\btext-(?:\d+|xs|sm|base|lg)\b/;

function matchBalanced(text: string, openIndex: number, open: string, close: string): number {
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    if (text[i] === open) depth += 1;
    else if (text[i] === close) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

/** className={...} / className="..." 与独立的 cn/clsx/twMerge(...) 区域。 */
function classValueRegions(text: string): Array<{ start: number; end: number }> {
  const regions: Array<{ start: number; end: number }> = [];
  for (const m of text.matchAll(/className\s*=\s*/g)) {
    const at = (m.index ?? 0) + m[0].length;
    const ch = text[at];
    if (ch === '{') {
      regions.push({ start: at, end: matchBalanced(text, at, '{', '}') });
    } else if (ch === '"' || ch === "'" || ch === '`') {
      const end = text.indexOf(ch, at + 1);
      regions.push({ start: at, end: end === -1 ? text.length : end + 1 });
    }
  }
  // class 常量未必直接挂在 className 上(变量、helper 返回值)。
  for (const m of text.matchAll(/\b(?:cn|clsx|twMerge)\s*\(/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    regions.push({ start: open, end: matchBalanced(text, open, '(', ')') });
  }
  return regions;
}

function findFixedLeadingWithScalingToken(text: string): Hit[] {
  const byIndex = new Map<number, Hit>();
  for (const region of classValueRegions(text)) {
    const slice = text.slice(region.start, region.end);
    const token = SIZE_TOKEN_IN_CLASS.exec(slice);
    if (!token) continue;
    for (const m of slice.matchAll(/leading-\[(\d+(?:\.\d+)?)px\]/g)) {
      // className 区域与其内层 cn(...) 区域会重叠,按绝对下标去重免得重复计数。
      const index = region.start + (m.index ?? 0);
      if (!byIndex.has(index)) byIndex.set(index, { match: m[0], index, context: token[0] });
    }
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

// ── 文件遍历 ────────────────────────────────────────────────────────

function collectFiles(exts: RegExp): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        walk(p);
        continue;
      }
      if (!exts.test(name)) continue;
      const rel = relative(ROOT, p).split(sep).join('/');
      if (!SKIP_FILES.some((re) => re.test(rel))) files.push(rel);
    }
  };
  walk(SCAN_DIR);
  return files;
}

interface Violation {
  file: string;
  line: number;
  rule: string;
  match: string;
  context?: string;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function scan(): Violation[] {
  const violations: Violation[] = [];
  const push = (file: string, text: string, rule: string, hits: Hit[]) => {
    for (const h of hits)
      violations.push({
        file,
        line: lineOf(text, h.index),
        rule,
        match: h.match,
        ...(h.context ? { context: h.context } : {}),
      });
  };

  for (const rel of collectFiles(/\.(ts|tsx|html)$/)) {
    const text = prepareTsContent(readFileSync(join(ROOT, rel), 'utf8'));
    push(rel, text, 'tw-weight', findTwWeightViolations(text));
    push(rel, text, 'arb-size', findArbitrarySizes(text));
    push(rel, text, 'token-size', findOffLadderTokenSizes(text));
    push(rel, text, 'inline-weight', findInlineWeightViolations(text));
    push(rel, text, 'inline-size', findInlineSizeViolations(text));
    push(rel, text, 'string-weight', findStringWeightViolations(text));
    push(rel, text, 'font-shorthand', findFontShorthands(text));
    push(rel, text, 'fixed-leading', findFixedLeadingWithScalingToken(text));
  }
  for (const rel of collectFiles(/\.css$/)) {
    const text = stripCssComments(readFileSync(join(ROOT, rel), 'utf8'));
    push(
      rel,
      text,
      'css-weight',
      findStringWeightViolations(text, { includeSelectorContext: true }),
    );
    push(rel, text, 'font-shorthand', findFontShorthands(text));
  }
  return violations;
}

/** 镜像解析器保持 key 与实际映射值成对返回，不能只看变量名档位。 */
export function parseNumericConfigMappings(config: string): Array<readonly [number, number]> {
  const fontSizeBlock = /fontSize:\s*\{([\s\S]*?)^\s*\},\s*borderRadius:/m.exec(config)?.[1] ?? '';
  return [...fontSizeBlock.matchAll(/^\s*(\d+):\s*['"]var\(--text-(\d+)\)['"]/gm)]
    .map((m) => [Number(m[1]), Number(m[2])] as const)
    .sort(([a], [b]) => a - b);
}

export function parseNumericCssMappings(css: string): Array<readonly [number, number]> {
  return [...css.matchAll(/--text-(\d+):\s*(\d+)px;/g)]
    .map((m) => [Number(m[1]), Number(m[2])] as const)
    .sort(([a], [b]) => a - b);
}

// ── 主守卫 ──────────────────────────────────────────────────────────

describe('typography discipline (DESIGN.md §3, #1505)', () => {
  it('keeps weights and sizes on the ladder; exemption hit counts stay exact', () => {
    const violations = scan();

    const keyOf = (file: string, rule: string) => `${file} ${rule}`;
    const exemptionByKey = new Map(EXEMPTIONS.map((e) => [keyOf(e.file, e.rule), e]));

    const signatureKey = (match: string, context?: string) => `${match} @ ${context ?? '<any>'}`;
    const counts = new Map<string, Map<string, number>>();
    const unexempted: string[] = [];
    for (const v of violations) {
      const key = keyOf(v.file, v.rule);
      const exemption = exemptionByKey.get(key);
      if (exemption) {
        const signature = exemption.signatures.find(
          (s) => s.match === v.match && (!s.context || s.context === v.context),
        );
        if (!signature) {
          unexempted.push(`${v.file}:${v.line} [${v.rule}] ${v.match}（未登记的豁免命中）`);
          continue;
        }
        const bucket = counts.get(key) ?? new Map<string, number>();
        bucket.set(
          signatureKey(v.match, signature.context),
          (bucket.get(signatureKey(v.match, signature.context)) ?? 0) + 1,
        );
        counts.set(key, bucket);
      } else {
        unexempted.push(`${v.file}:${v.line} [${v.rule}] ${v.match}`);
      }
    }

    const exemptionDrift: string[] = [];
    for (const e of EXEMPTIONS) {
      const actual = counts.get(keyOf(e.file, e.rule)) ?? new Map<string, number>();
      for (const signature of e.signatures) {
        const hits = actual.get(signatureKey(signature.match, signature.context)) ?? 0;
        if (hits !== signature.expected) {
          exemptionDrift.push(
            `${e.file} [${e.rule}] ${signature.match} 登记 ${signature.expected} 次,实测 ${hits} 次 —— ` +
              (hits > signature.expected
                ? '有人蹭豁免,新增处必须自证或归梯'
                : '豁免已过期,请同步删登记'),
          );
        }
      }
    }

    expect(unexempted).toEqual([]);
    expect(exemptionDrift).toEqual([]);
  });

  it('mirrors the size ladder across DESIGN.md and the three authoritative code sources', () => {
    const expected = [...SIZE_WHITELIST].sort((a, b) => a - b);
    const expectedSemantic = { xs: 12, sm: 14, base: 16, lg: 18 };

    const config = readFileSync(join(ROOT, 'tailwind.config.ts'), 'utf8');
    const fontSizeBlock =
      /fontSize:\s*\{([\s\S]*?)^\s*\},\s*borderRadius:/m.exec(config)?.[1] ?? '';
    const configNumeric = parseNumericConfigMappings(config);
    expect(configNumeric).toEqual(expected.map((n) => [n, n]));
    const configSemantic = Object.fromEntries(
      [...fontSizeBlock.matchAll(/^\s*(xs|sm|base|lg):\s*\[['"]var\(--text-\1\)['"]/gm)].map(
        (m) => [m[1], expectedSemantic[m[1] as keyof typeof expectedSemantic]],
      ),
    );
    expect(configSemantic).toEqual(expectedSemantic);
    const preservedConfigSemantic = Object.fromEntries(
      [
        ...fontSizeBlock.matchAll(
          /^\s*['"]?(xl|2xl|3xl|4xl|5xl)['"]?:\s*\[['"]var\(--text-\1\)['"]/gm,
        ),
      ].map((m) => [m[1], SEMANTIC_TOKEN_VALUES[m[1] as keyof typeof SEMANTIC_TOKEN_VALUES]]),
    );
    expect(preservedConfigSemantic).toEqual({ xl: 20, '2xl': 24, '3xl': 30, '4xl': 36, '5xl': 48 });

    const css = readFileSync(join(ROOT, 'src/renderer/styles/globals.css'), 'utf8');
    const cssNumeric = parseNumericCssMappings(css);
    expect(cssNumeric).toEqual(expected.map((n) => [n, n]));
    const cssSemantic = Object.fromEntries(
      [...css.matchAll(/--text-(xs|sm|base|lg):\s*(\d+)px;/g)].map((m) => [m[1], Number(m[2])]),
    );
    expect(cssSemantic).toEqual(expectedSemantic);
    const preservedCssSemantic = Object.fromEntries(
      [...css.matchAll(/--text-(xl|2xl|3xl|4xl|5xl):\s*(\d+)px;/g)].map((m) => [
        m[1],
        Number(m[2]),
      ]),
    );
    expect(preservedCssSemantic).toEqual({ xl: 20, '2xl': 24, '3xl': 30, '4xl': 36, '5xl': 48 });

    const hook = readFileSync(join(ROOT, 'src/renderer/hooks/useFontSettings.ts'), 'utf8');
    const runtimeBlock = /UI_TEXT_TOKEN_SIZES\s*=\s*\[([^\]]+)\]/s.exec(hook)?.[1] ?? '';
    const runtimeNumeric = [...runtimeBlock.matchAll(/\b\d+\b/g)]
      .map((m) => Number(m[0]))
      .sort((a, b) => a - b);
    expect(runtimeNumeric).toEqual(expected);
    expect(hook).toMatch(
      /for \(const tokenSize of UI_TEXT_TOKEN_SIZES\)[\s\S]*?set\(`--text-\$\{tokenSize\}`, `\$\{Math\.round\(tokenSize \* scale\)\}px`\)/,
    );
    const semanticBlock = /SCALED_TAILWIND_TOKENS\s*=\s*\{([^}]+)\}/s.exec(hook)?.[1] ?? '';
    const runtimeSemantic = Object.fromEntries(
      [...semanticBlock.matchAll(/^\s*(xs|sm|base|lg):\s*(\d+),/gm)].map((m) => [
        m[1],
        Number(m[2]),
      ]),
    );
    expect(runtimeSemantic).toEqual(expectedSemantic);
    const preservedRuntimeSemantic = Object.fromEntries(
      [...semanticBlock.matchAll(/^\s*['"]?(xl|2xl|3xl|4xl|5xl)['"]?:\s*(\d+),/gm)].map((m) => [
        m[1],
        Number(m[2]),
      ]),
    );
    expect(preservedRuntimeSemantic).toEqual({
      xl: 20,
      '2xl': 24,
      '3xl': 30,
      '4xl': 36,
      '5xl': 48,
    });

    // DESIGN.md §3「桌面 UI 字号白名单」小节的两个 {…} 集合。
    const design = readFileSync(DESIGN_MD, 'utf8');
    const section = design.split('### 桌面 UI 字号白名单')[1]?.split('###')[0] ?? '';
    const sets = [...section.matchAll(/\{([\d\s,、]+)\}/g)];
    const docTiers = sets
      .flatMap((m) =>
        m[1]
          .split(/[,、\s]+/)
          .filter(Boolean)
          .map(Number),
      )
      .sort((a, b) => a - b);
    expect(docTiers).toEqual(expected);
  });

  it('keeps the tailwind-merge font-size consumer in sync', () => {
    const expected = [...SIZE_WHITELIST].sort((a, b) => a - b);
    const mergeUtils = readFileSync(join(ROOT, 'src/renderer/lib/utils.ts'), 'utf8');
    const mergeBlock = /font-size'[\s\S]*?text:\s*\[([^\]]+)\]/.exec(mergeUtils)?.[1] ?? '';
    const mergeNumeric = [...mergeBlock.matchAll(/['"](\d+)['"]/g)]
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b);
    expect(mergeNumeric).toEqual(expected);
  });

  // ── 红绿 fixture:检查器本身的行为锚定(防误报/漏报同时回归) ──
  describe('checker fixtures', () => {
    const matches = (hits: Hit[]) => hits.map((h) => h.match);

    it('flags red samples', () => {
      expect(matches(findTwWeightViolations('className="text-12 font-bold"'))).toEqual([
        'font-bold',
      ]);
      expect(matches(findTwWeightViolations('font-[550]'))).toEqual(['font-[550]']);
      // 同行双违规逐个计数(评审轮:第一个命中不再吞掉第二个)
      expect(findTwWeightViolations('cn("font-bold font-black")')).toHaveLength(2);
      expect(matches(findArbitrarySizes('className="text-[12.5px]"'))).toEqual(['text-[12.5px]']);
      // 固定 px 行高 + 会缩放的字号:同行、语义档位都要红。
      expect(matches(findFixedLeadingWithScalingToken('className="text-14 leading-[18px]"'))).toEqual(
        ['leading-[18px]'],
      );
      expect(
        findFixedLeadingWithScalingToken('className="text-sm leading-[18px]"'),
      ).toHaveLength(1);
      // 关键回归:cn(...) 把字号与行高分散到不同行时不得漏(#1553 实测漏过一处)。
      expect(
        findFixedLeadingWithScalingToken(
          ['className={cn(', "  'text-14 flex-1',", "  'leading-[22px]',", ')}'].join('\n'),
        ),
      ).toHaveLength(1);
      // className 区域与内层 cn(...) 区域重叠,同一处只能计一次。
      expect(
        findFixedLeadingWithScalingToken('className={cn("text-13", "leading-[16px]")}'),
      ).toHaveLength(1);
      expect(findArbitrarySizes('text-[9px] text-[8px]')).toHaveLength(2);
      // 全单位 / 大小写 / 无整数部分小数(三轮加固)
      expect(findArbitrarySizes('text-[0.75rem]')).toHaveLength(1);
      expect(findArbitrarySizes('text-[.75rem]')).toHaveLength(1);
      // 函数形式不能因 `[` 后不是数字而绕过守卫(P1)
      expect(findArbitrarySizes('text-[length:calc(9px+1vw)]')).toHaveLength(1);
      // `length:` 默认拒绝开放的 CSS 函数集合,不能退化为已知函数枚举。
      expect(findArbitrarySizes('text-[length:env(safe-area-inset-top,_9px)]')).toHaveLength(1);
      // 数字开头的现代单位不得依赖单位枚举:动态 viewport、font-relative、container-query。
      expect(findArbitrarySizes('text-[9dvh] text-[1lh] text-[1cqw]')).toHaveLength(3);
      // Tailwind 可推断为 length 的函数无需显式 `length:` 也必须拦截。
      expect(findArbitrarySizes('text-[calc(9px+1vw)] text-[clamp(9px,1vw,12px)]')).toHaveLength(2);
      expect(findArbitrarySizes('text-[length:var(--app-code-font-size)]')).toHaveLength(1);
      // Tailwind 任意属性形式同样会生成字号样式,不能绕过 text- 类守卫。
      expect(findArbitrarySizes('[font-size:9px] [font-size:17px]')).toHaveLength(2);
      // 百分比与 CSS 字号关键字也是可生成 font-size 的任意值;未知关键字同样默认拒绝。
      expect(findArbitrarySizes('text-[50%] text-[xx-small] text-[future-size-keyword]')).toHaveLength(3);
      // 省略前导零的小数必须按完整 0.12px 识别(P2)
      expect(findArbitrarySizes('text-[.12px]')).toHaveLength(1);
      expect(findArbitrarySizes('text-[12PX]')).toHaveLength(1);
      expect(findArbitrarySizes('text-[17pt]')).toHaveLength(1);
      expect(findArbitrarySizes('text-[length:.75rem]')).toHaveLength(1);
      expect(matches(findOffLadderTokenSizes('className="text-17 font-medium"'))).toEqual([
        'text-17',
      ]);
      expect(matches(findOffLadderTokenSizes('text-xl text-2xl text-3xl text-9xl'))).toEqual([
        'text-xl',
        'text-2xl',
        'text-3xl',
        'text-9xl',
      ]);
      expect(findInlineWeightViolations('fontWeight: 700,')).toHaveLength(1);
      expect(findInlineWeightViolations("fontWeight: 'bold' }")).toHaveLength(1);
      // 中间值与越界值(不只认整百)
      expect(findInlineWeightViolations('fontWeight: 550,')).toHaveLength(1);
      expect(findInlineWeightViolations("fontWeight: '650' }")).toHaveLength(1);
      expect(findInlineWeightViolations('fontWeight: 999,')).toHaveLength(1);
      expect(findInlineWeightViolations('fontWeight: 1000,')).toHaveLength(1);
      expect(findInlineWeightViolations('fontWeight: 50,')).toHaveLength(1);
      // 三元 / style 赋值 / JSX 属性形态
      expect(findInlineWeightViolations('fontWeight: filled ? 700 : 400,')).toHaveLength(1);
      expect(findInlineWeightViolations("el.style.fontWeight = '700';")).toHaveLength(1);
      expect(findInlineWeightViolations('<Text fontWeight="800">')).toHaveLength(1);
      // 跨行声明(红队三轮 P1:值换行不再漏报)
      expect(findInlineWeightViolations('const s = {\n  fontWeight:\n    800,\n};')).toHaveLength(
        1,
      );
      expect(findInlineSizeViolations('const s = {\n  fontSize:\n    17,\n};')).toHaveLength(1);
      expect(findStringWeightViolations('.x {\n  font-weight:\n    900;\n}')).toHaveLength(1);
      expect(findFontShorthands('font:\n  normal 700 12px/22px sans-serif;')).toHaveLength(1);
      expect(findInlineSizeViolations('fontSize: 17,')).toHaveLength(1);
      expect(findInlineSizeViolations("fontSize: '.12px',")).toHaveLength(1);
      expect(findInlineSizeViolations("fontSize: '12.5px' }")).toHaveLength(1);
      expect(findInlineSizeViolations('fontSize={17}')).toHaveLength(1);
      // 非 px 绝对/视口单位与大小写(三轮加固)
      expect(findInlineSizeViolations("fontSize: '17pt',")).toHaveLength(1);
      expect(findInlineSizeViolations("fontSize: '17ch',")).toHaveLength(1);
      expect(findInlineSizeViolations("fontSize: '17PX',")).toHaveLength(1);
      expect(findInlineSizeViolations("fontSize: '13pt',")).toHaveLength(1);
      expect(matches(findStringWeightViolations('font-weight:700;color:red'))).toEqual([
        'font-weight:700',
      ]);
      expect(findStringWeightViolations('h1{font-weight:700} h2{font-weight:900}')).toHaveLength(2);
      expect(findStringWeightViolations('font-weight: bold;')).toHaveLength(1);
      const selectorBound = findStringWeightViolations(
        '.hljs-strong { font-weight: bold; } .ordinary-ui { font-weight: bold; }',
        { includeSelectorContext: true },
      );
      expect(selectorBound.map((hit) => hit.context)).toEqual(['.hljs-strong', '.ordinary-ui']);
      // CSS 通配选择器不是注释(css 路径经 stripCssComments,ts 路径经 prepareTsContent)
      expect(findStringWeightViolations(stripCssComments('* { font-weight: 900; }'))).toHaveLength(
        1,
      );
      expect(
        findStringWeightViolations(prepareTsContent('const css = `\n* { font-weight: 900; }\n`;')),
      ).toHaveLength(1);
      expect(
        findStringWeightViolations(
          prepareTsContent('const css = `\n*{box-sizing:border-box}\n.a{font-weight:900}\n`;'),
        ),
      ).toHaveLength(1);
      // shorthand 合法变体全覆盖(三轮:size 关键字 / system 关键字 / var / global)
      expect(findFontShorthands('font: 600 12px/22px sans-serif;')).toHaveLength(1);
      expect(findFontShorthands('font: normal 700 12px/22px sans-serif;')).toHaveLength(1);
      expect(findFontShorthands('font : 900 12px sans-serif;')).toHaveLength(1);
      expect(findFontShorthands('font: bold 1.2em serif;')).toHaveLength(1);
      expect(findFontShorthands('font: caption;')).toHaveLength(1);
      expect(findFontShorthands('font: bold medium system-ui;')).toHaveLength(1);
      expect(findFontShorthands('font: medium serif;')).toHaveLength(1);
      expect(findFontShorthands('font: large Arial;')).toHaveLength(1);
      expect(findFontShorthands('font: var(--marker-font);')).toHaveLength(1);
      expect(findFontShorthands('font: initial;')).toHaveLength(1);
      expect(findFontShorthands('font: unset;')).toHaveLength(1);
      expect(findFontShorthands('font: revert;')).toHaveLength(1);
      // 引号值与大小写(红队四轮:style 对象里的字符串 shorthand / CSS 大小写不敏感)
      expect(findFontShorthands("style={{ font: 'bold 12px system-ui' }}")).toHaveLength(1);
      expect(findFontShorthands('style={{ font: "caption" }}')).toHaveLength(1);
      expect(findFontShorthands('font: CAPTION;')).toHaveLength(1);
      // 属性名大小写与完整值判定(gate-audit 四轮)
      expect(findFontShorthands('FONT: medium serif;')).toHaveLength(1);
      expect(findStringWeightViolations('FONT-WEIGHT: 900;')).toHaveLength(1);
      expect(findStringWeightViolations('font-weight: BOLD;')).toHaveLength(1);
      expect(findStringWeightViolations('font-weight: lighter;')).toHaveLength(1);
      // 小数中间值:完整值判定,不再截成 400/500/600 静默放行
      expect(findStringWeightViolations('font-weight: 400.5;')).toHaveLength(1);
      expect(findStringWeightViolations('font-weight: 500.5;')).toHaveLength(1);
      expect(findStringWeightViolations('font-weight: 600.5;')).toHaveLength(1);
      expect(findStringWeightViolations('font-weight: 900 !important;')).toHaveLength(1);
      expect(findInlineWeightViolations("fontWeight: 'lighter' }")).toHaveLength(1);
      expect(findInlineWeightViolations("fontWeight: 'BOLD' }")).toHaveLength(1);
      expect(findInlineWeightViolations("fontWeight: 'Bolder' }")).toHaveLength(1);
      // 括号包裹与混合三元:直接字面量臂不因片段含括号而整段漏判(gate-audit 五轮)
      expect(findInlineWeightViolations('fontWeight: (700),')).toHaveLength(1);
      expect(findInlineWeightViolations('fontWeight: active ? 700 : toWeight(500),')).toHaveLength(
        1,
      );
      expect(findInlineWeightViolations('fontWeight: active ? toWeight(500) : 800,')).toHaveLength(
        1,
      );
      // shorthand numeric weight 完整文法:两位/四位/小数/带符号不得绕过
      expect(findFontShorthands('font: 50 medium serif;')).toHaveLength(1);
      expect(findFontShorthands('font: 1000 medium serif;')).toHaveLength(1);
      expect(findFontShorthands('font: 700.5 medium serif;')).toHaveLength(1);
      expect(findFontShorthands('font: +700 medium serif;')).toHaveLength(1);
      expect(findStringWeightViolations('font-weight: +700;')).toHaveLength(1);
      expect(findStringWeightViolations('font-weight: .5;')).toHaveLength(1);
      // 错误映射 fixture:只改右侧映射值也必须被镜像解析抓住(P1)
      expect(
        parseNumericConfigMappings(`fontSize: {\n  12: 'var(--text-9)',\n},\nborderRadius: {}`),
      ).not.toEqual([[12, 12]]);
      expect(parseNumericCssMappings(':root { --text-12: 9px; }')).not.toEqual([[12, 12]]);
      // 删除档位后仍残留静态变量也必须被镜像检查抓住，而不是被白名单过滤吞掉。
      expect(parseNumericCssMappings(':root { --text-12: 12px; --text-17: 17px; }')).not.toEqual([
        [12, 12],
      ]);
    });

    it('passes green samples', () => {
      expect(findTwWeightViolations('className="font-medium font-semibold font-normal"')).toEqual(
        [],
      );
      expect(findArbitrarySizes('text-[var(--md-h1-fg)]')).toEqual([]);
      // 无单位比例本身就是修法,不能反过来判红。
      expect(findFixedLeadingWithScalingToken('className="text-14 leading-[1.571]"')).toEqual([]);
      // 没有会缩放的字号 token 时,固定行高不属于本规则(行高档位统一是 non-goal)。
      expect(findFixedLeadingWithScalingToken('className="leading-[22px] text-[var(--x)]"')).toEqual(
        [],
      );
      // 语义 leading 档位与行高变量同样放行。
      expect(findFixedLeadingWithScalingToken('className="text-14 leading-snug"')).toEqual([]);
      expect(findArbitrarySizes('text-[var(--app-code-font-size)]')).toEqual([]);
      expect(
        findOffLadderTokenSizes('className="text-xs text-sm text-base text-lg text-12 text-28"'),
      ).toEqual([]);
      expect(findInlineWeightViolations('fontWeight: 500,')).toEqual([]);
      expect(findInlineWeightViolations('fontWeight: active ? 600 : 500,')).toEqual([]);
      // 片段截断:同对象里的后续属性数字不误报为字重
      expect(findInlineWeightViolations('fontWeight: 500, width: 300 }')).toEqual([]);
      expect(findInlineSizeViolations('fontSize: 13,')).toEqual([]);
      expect(findInlineSizeViolations("fontSize: '13px' }")).toEqual([]);
      expect(findInlineSizeViolations('fontSize: CONTROL.fontSize,')).toEqual([]);
      // 相对比例(em/rem/%)与算式派生值属登记盲区,不误报
      expect(findInlineSizeViolations("fontSize: '2.15em',")).toEqual([]);
      expect(findInlineSizeViolations('fontSize: size * 0.86,')).toEqual([]);
      // SVG/JSX 多行属性:相邻属性的数值不串进本属性片段
      expect(
        findInlineSizeViolations(
          '<text\n  fontSize="10"\n  fontWeight="500"\n  letterSpacing="0.3"\n/>',
        ),
      ).toEqual([]);
      expect(
        findInlineWeightViolations(
          '<text\n  fontSize="10"\n  fontWeight="500"\n  letterSpacing="0.3"\n/>',
        ),
      ).toEqual([]);
      expect(findStringWeightViolations('font-weight: 600;')).toEqual([]);
      // normal(=400)/inherit 落梯放行;动态值与 initial/unset/revert 为登记盲区
      expect(findStringWeightViolations('font-weight: normal;')).toEqual([]);
      expect(findStringWeightViolations('font-weight: NORMAL;')).toEqual([]);
      expect(findStringWeightViolations('font-weight: inherit;')).toEqual([]);
      expect(findStringWeightViolations('font-weight: var(--w);')).toEqual([]);
      expect(findStringWeightViolations('font-weight: 500 !important;')).toEqual([]);
      expect(findFontShorthands("font: 'inherit'")).toEqual([]);
      expect(findFontShorthands('font: inherit;')).toEqual([]);
      expect(findFontShorthands('font: 20,')).toEqual([]);
      expect(findFontShorthands('font: markerFont,')).toEqual([]);
      // TS 逻辑表达式不是 CSS 声明(红队四轮误报面),跳过
      expect(findFontShorthands('const x = { font: bold && medium };')).toEqual([]);
      expect(findFontShorthands('font: caption || fallback,')).toEqual([]);
      // 函数调用子表达式按动态值剔除(参数域为登记盲区),不按内部参数误判;
      // 嵌套调用逐层剥净
      expect(findInlineWeightViolations('fontWeight: toWeight(550),')).toEqual([]);
      expect(findInlineWeightViolations('fontWeight: getWeight(active ? 700 : 500),')).toEqual([]);
      expect(findInlineWeightViolations('fontWeight: f(g(550)),')).toEqual([]);
      // 带符号合法值:+400 = 400,落梯放行
      expect(findStringWeightViolations('font-weight: +400;')).toEqual([]);
      // 非常规数字字面量形态为登记盲区(现行为 = 不判,锚定防悄改)
      expect(findInlineWeightViolations('fontWeight: 5e2,')).toEqual([]);
      expect(findInlineWeightViolations('fontWeight: 6_50,')).toEqual([]);
      // 尾注释剥离:注释里的数字不进入 fontSize 片段
      expect(
        findInlineSizeViolations(prepareTsContent('fontSize: 13, // 对齐 xterm 2024 默认')),
      ).toEqual([]);
      expect(prepareTsLine('  // font-weight: 700 in prose')).toBeNull();
      expect(prepareTsLine(' * jsdoc 续行 font-weight: 700 也是注释')).toBeNull();
      // CSS 块注释剥离保行号:注释内的违规不报、注释外的照报且行号正确
      const stripped = stripCssComments('/* font-weight: 900 */\na { font-weight: 900; }');
      const hits = findStringWeightViolations(stripped);
      expect(hits).toHaveLength(1);
      expect(stripped.slice(0, hits[0].index).split('\n')).toHaveLength(2);
    });
  });
});
