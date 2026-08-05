/**
 * CodeMirror 6 theme aligned with the chat MarkdownRenderer's github.css /
 * github-dark.css highlight.js theme. The goal is to make CodeMirror code
 * inside the SkillHub editor look 1:1 identical to highlight.js code in
 * chat — so users see the same colors / typography whether they're reading
 * a file in chat or editing it in SkillHub.
 *
 * Approach: highlight.js classes (`.hljs-keyword`, `.hljs-string`, ...)
 * don't exist in CodeMirror — CM uses Lezer tags (t.keyword, t.string, ...).
 * We define a `HighlightStyle` that maps each Lezer tag to the same color
 * value the github theme uses for the equivalent hljs class.
 *
 * Color tables sourced from:
 *   - Light: highlight.js/styles/github.css (PrettyLights syntax tokens)
 *   - Dark:  apps/desktop/src/renderer/styles/globals.css `.dark .hljs-*`
 *            block (mirrors github-dark.css)
 */

import { HighlightStyle } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

const CODE_FONT_STACK = 'var(--app-font-code, var(--app-font-code-default))';
const UI_FONT_STACK = 'var(--app-font-ui, var(--app-font-ui-default))';
const CODE_FONT_SIZE = 'var(--app-code-font-size)';

// ── Color palettes ───────────────────────────────────────────────────────

/** PrettyLights LIGHT — github.css */
const githubLightColors = {
  bg: 'transparent',                    // editor body — let host's Surface show
  text: '#24292e',                      // base text (default)
  comment: '#6a737d',                   // comments
  keyword: '#d73a49',                   // keywords / type / modifier
  literal: '#005cc5',                   // numbers / booleans / null / constants
  string: '#032f62',                    // strings / regex
  variable: '#e36209',                  // built-ins / symbols
  function: '#6f42c1',                  // function names / class names
  tag: '#22863a',                       // HTML / JSX tag names
};

/** github-dark — mirrored from globals.css `.dark .hljs-*` */
const githubDarkColors = {
  bg: 'transparent',
  text: '#c9d1d9',
  comment: '#8b949e',
  keyword: '#ff7b72',
  literal: '#79c0ff',
  string: '#a5d6ff',
  variable: '#ffa657',
  function: '#d2a8ff',
  tag: '#7ee787',
};

// ── HighlightStyle (Lezer tag → color) ───────────────────────────────────

function makeHighlightStyle(c: typeof githubLightColors) {
  return HighlightStyle.define([
    // Keywords + type-like things — red in github theme
    {
      tag: [
        t.keyword,
        t.controlKeyword,
        t.operatorKeyword,
        t.definitionKeyword,
        t.modifier,
        t.typeName,
        t.standard(t.tagName),
      ],
      color: c.keyword,
    },
    // Function / class names — purple
    {
      tag: [
        t.function(t.variableName),
        t.function(t.propertyName),
        t.className,
        t.namespace,
      ],
      color: c.function,
    },
    // Strings + regex — blue (light) / pale-blue (dark)
    {
      tag: [t.string, t.special(t.string), t.regexp],
      color: c.string,
    },
    // Numbers + literals + atoms — constant color
    {
      tag: [t.number, t.bool, t.null, t.atom, t.literal],
      color: c.literal,
    },
    // Comments — grey, italic (matches github.css `.hljs-comment`)
    {
      tag: [t.comment, t.lineComment, t.blockComment, t.docComment],
      color: c.comment,
      fontStyle: 'italic',
    },
    // Built-in symbols — orange (matches `.hljs-built_in`)
    {
      tag: [t.standard(t.variableName), t.special(t.variableName)],
      color: c.variable,
    },
    // HTML/JSX tag names — green (matches `.hljs-name` / `.hljs-selector-tag`)
    {
      tag: [t.tagName, t.angleBracket],
      color: c.tag,
    },
    // Property names + attributes — constant color
    {
      tag: [t.propertyName, t.attributeName],
      color: c.literal,
    },
    // Markdown-specific tags stay grayscale; code tokens above still use
    // GitHub colors. The doc editor should read like a document, not a code
    // diff, while the underlying text remains untouched.
    {
      tag: [t.heading, t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6],
      color: c.text,
      fontWeight: '500',
    },
    { tag: t.quote, color: c.comment },
    // Inline code (markdown) — keep base text color, mono already
    { tag: t.monospace, color: c.text },
    { tag: [t.link, t.url], color: c.text, textDecoration: 'underline' },
    // Emphasis / strong — keep colors, just style
    { tag: t.emphasis, fontStyle: 'italic' },
    { tag: t.strong, fontWeight: 'bold' },
    // Punctuation / brackets — base text color
    { tag: [t.punctuation, t.bracket, t.derefOperator], color: c.text },
  ]);
}

export const githubLightHighlight = makeHighlightStyle(githubLightColors);
export const githubDarkHighlight = makeHighlightStyle(githubDarkColors);

// ── Editor wrapper theme (typography, layout, selection, gutters) ─────────

/** Build the EditorView.theme() for our editor wrapper. Matches the chat
 *  MarkdownRenderer's code-block typography exactly: JetBrains Mono 14px,
 *  line-height 1.6. cm-content padding 全部归零 —— 外边距由 FileBodyView 的
 *  外层容器(editContainerCls)统一接管,避免 cm-scroller 的滚动条 / cm-line
 *  默认 2px 内边距等隐藏因素让"编辑↔预览切换"出现左右跳变。
 *  No line numbers (kept minimal). System selection blue. */
function makeEditorTheme(c: typeof githubLightColors, isDark: boolean) {
  return EditorView.theme(
    {
      '&': {
        fontSize: CODE_FONT_SIZE,
        backgroundColor: c.bg,
        height: '100%',
        color: c.text,
      },
      '.cm-scroller': {
        // 不在这层设 fontFamily —— CodeMirror baseTheme 给 .cm-content 显式
        // 写了 `font-family: monospace`,specificity 比 .cm-scroller 高,
        // .cm-content 不会继承我们这里的字体栈,实测会被 Chromium 解析成
        // HarmonyOS Sans SC(从 body 兜底),字符变细变窄。所以 fontFamily
        // 必须直接挂到 .cm-content 上,见下方。
        lineHeight: '1.5',
        // Soft wrap (set via EditorView.lineWrapping extension below) +
        // no horizontal scrollbar.
        overflowX: 'hidden',
      },
      '.cm-content': {
        // 字体栈对齐预览模式 MarkdownRenderer 的 <pre>(实测 computed family
        // 为 JetBrains Mono Variable, JetBrains Mono, ui-monospace, ...)。
        // 写在 .cm-content 上是为了压过 baseTheme 的 `font-family: monospace`,
        // 否则编辑模式会回落到中文 sans-serif,字宽和预览对不上。
        fontFamily: CODE_FONT_STACK,
        lineHeight: '1.5',
        // 左右内边距由这里接管(FileBodyView 的 editContainerCls 不再加 px-),
        // 这样 .cm-scroller 能拉满到 FileBodyView 右边缘,垂直滚动条贴边显示。
        // 左侧 padding 为 0 —— 行号 gutter 自己控制 padding-left 30px,
        // 文字距离行号有 14px 间距(gutter padding-right + cm-content padding-left)。
        padding: '28px 30px 28px 14px',
        caretColor: c.text,
      },
      '.cm-focused': { outline: 'none' },
      '.cm-line': {
        // CodeMirror baseTheme 默认 .cm-line 有 padding: 0 2px,会让左右多出
        // 2px 内边距,这里强制归零让外层容器统一控制。
        padding: '0',
        // 实测 CodeMirror baseTheme 在 .cm-line 上也设了字体,会盖掉
        // .cm-content 的继承,这里再显式声明一次确保 JetBrains Mono 生效。
        fontFamily: CODE_FONT_STACK,
        lineHeight: '1.5',
      },
      // Selection uses the shared focus ring alpha token so alternate themes can
      // keep editor selection aligned with the rest of the app.
      '.cm-selectionBackground, ::selection': {
        background: 'var(--focus-ring-soft) !important',
      },
      '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
        background: 'var(--focus-ring-soft)',
      },
      // No active-line highlight (user disliked it earlier).
      '.cm-activeLine, .cm-activeLineGutter': { background: 'transparent' },
      // 行号 gutter —— 编辑和预览(只读)都显示,保证切换零跳变。无背景 / 无右
      // 边框,让数字"贴在内容旁边",不像传统 IDE 那样有一条灰柱子。
      // 关键 1:**不要**改字号/行高 —— CodeMirror 是按 cm-content 的字号 + 行高
      // 计算每行高度的,gutter 默认继承,行号天然和代码行 baseline 对齐。
      // 关键 2:**不要给 .cm-gutters 加 padding-top / padding-bottom**。CodeMirror
      // 的 gutter 是用 absolute 定位 + cm-content 的 lineBlock 测量来对齐的,
      // 容器加了 vertical padding 会叠加到已对齐的 top 上,首行行号会被推下去
      // (实测推 28px 看起来错了将近两行)。垂直起点必须由 .cm-content 的
      // padding-top 唯一控制。padding-left 是水平方向,不影响对齐,可以加。
      '.cm-gutters': {
        backgroundColor: 'transparent',
        border: 'none',
        // 仅水平 padding —— 见上方关于"垂直 padding 不能加"的说明。
        paddingLeft: '30px',
        color: c.comment,
        fontFamily: CODE_FONT_STACK,
        // gutter 自己 user-select: none,数字不会被选中复制
        userSelect: 'none',
      },
      '.cm-lineNumbers .cm-gutterElement': {
        // baseTheme 默认 padding: 0 3px 0 5px。这里改成 0 16px 0 0:
        //   - 右 16px = 数字到代码内容的视觉间距(再加上 cm-content padding-left
        //     14px,实际间距 30px,视觉上数字和代码"分得开但不远")。
        //   - 左 0 让数字严格右对齐到 padding-left 30px 之后的列。
        padding: '0 16px 0 0',
        minWidth: '2ch',
        textAlign: 'right',
        color: c.comment,
        // **不要**改 fontSize / lineHeight —— 见 .cm-gutters 上的注释。
      },
      // Cursor color matches text color.
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: c.text },
    },
    { dark: isDark },
  );
}

export const githubLightEditorTheme = makeEditorTheme(githubLightColors, false);
export const githubDarkEditorTheme = makeEditorTheme(githubDarkColors, true);

// ── Plain-mode editor theme (no language / no syntax highlighting) ────────
//
// 给 .md 和未识别后缀文件用 —— 视觉上对齐之前的"chat 排版 textarea"(Inter
// 15px / line-height 1.6 / --msg-assistant-text)。和 code 主题的差异:
//   - fontFamily 走 body 的 sans 栈(Inter + CJK fallback)而不是 JetBrains
//     Mono;.cm-content 和 .cm-line 都要显式声明,理由同 makeEditorTheme 注释:
//     CodeMirror baseTheme 在两层都写了 monospace,specificity 必须显式压过。
//   - 没有 lineNumbers gutter,所以不需要 .cm-gutters / .cm-lineNumbers 规则;
//     左右 padding 由 .cm-content 直接接管(40px,等价之前的 px-10)。
//   - 上下 padding 28px ≈ py-7,对齐预览模式 MarkdownRenderer 容器留白。
//   - color 用 var(--msg-assistant-text):chat 体系下的正文色 token,跟之前
//     textarea 的 text-[var(--msg-assistant-text)] 完全一致,light/dark 都自动
//     跟随;不复用 githubLightColors.text(那是代码块基础色,跟 chat 正文有
//     微小色差)。
const PLAIN_FONT_STACK = UI_FONT_STACK;

function makePlainEditorTheme(isDark: boolean) {
  const text = 'var(--msg-assistant-text)';
  return EditorView.theme(
    {
      '&': {
        fontSize: '15px',
        backgroundColor: 'transparent',
        height: '100%',
        color: text,
      },
      '.cm-scroller': {
        lineHeight: '1.6',
        overflowX: 'hidden',
      },
      '.cm-content': {
        fontFamily: PLAIN_FONT_STACK,
        lineHeight: '1.6',
        // 等价之前 textarea 的 px-10 py-7。
        padding: '28px 40px',
        caretColor: text,
      },
      '.cm-focused': { outline: 'none' },
      '.cm-line': {
        // baseTheme 默认 .cm-line padding: 0 2px + font-family: monospace,
        // 显式覆盖,理由同代码主题。
        padding: '0',
        fontFamily: PLAIN_FONT_STACK,
        lineHeight: '1.6',
      },
      '.cm-selectionBackground, ::selection': {
        background: 'var(--focus-ring-soft) !important',
      },
      '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
        background: 'var(--focus-ring-soft)',
      },
      '.cm-activeLine, .cm-activeLineGutter': { background: 'transparent' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: text },
    },
    { dark: isDark },
  );
}

export const plainLightEditorTheme = makePlainEditorTheme(false);
export const plainDarkEditorTheme = makePlainEditorTheme(true);

function makeMarkdownEditorTheme(isDark: boolean) {
  const text = 'var(--msg-assistant-text)';
  const muted = 'var(--text-secondary)';
  const board = 'var(--border-default)';
  const tableBg = 'var(--md-table-bg)';

  return EditorView.theme(
    {
      '&': {
        fontSize: '16px',
        backgroundColor: 'transparent',
        height: '100%',
        color: text,
      },
      '.cm-scroller': {
        lineHeight: '1.68',
        overflowX: 'hidden',
      },
      '.cm-content': {
        fontFamily: PLAIN_FONT_STACK,
        lineHeight: '1.68',
        padding: '34px 72px 48px',
        caretColor: text,
        maxWidth: '920px',
        margin: '0 auto',
        width: '100%',
      },
      '.cm-focused': { outline: 'none' },
      '.cm-line': {
        padding: '0',
        fontFamily: PLAIN_FONT_STACK,
        lineHeight: '1.68',
      },
      '.cm-md-heading-line': {
        color: text,
        fontWeight: '500',
        paddingTop: '0.72em',
        paddingBottom: '0.18em',
      },
      '.cm-md-heading-1': { fontSize: '2.15em', lineHeight: '1.12' },
      '.cm-md-heading-2': { fontSize: '1.62em', lineHeight: '1.18' },
      '.cm-md-heading-3': { fontSize: '1.28em', lineHeight: '1.24' },
      '.cm-md-heading-4, .cm-md-heading-5, .cm-md-heading-6': {
        fontSize: '1.06em',
        lineHeight: '1.32',
      },
      '.cm-md-quote-line': {
        color: muted,
        borderLeft: `3px solid ${board}`,
        paddingLeft: '14px',
      },
      '.cm-md-list-line': {
        paddingLeft: '4px',
      },
      '.cm-md-task-line': {
        color: text,
      },
      '.cm-md-marker': {
        color: muted,
      },
      '.cm-md-marker-bullet': {
        display: 'inline-block',
        minWidth: '1.45em',
        textAlign: 'center',
      },
      '.cm-md-marker-ordered': {
        display: 'inline-block',
        minWidth: '1.7em',
        paddingRight: '0.25em',
        textAlign: 'right',
      },
      '.cm-md-marker-checked, .cm-md-marker-unchecked': {
        display: 'inline-block',
        minWidth: '1.35em',
        color: muted,
      },
      // ⚠️ doc 模式行内/块级元素的纵向留白必须用 padding,不能用 margin:
      // CodeMirror 的 height map 按 getBoundingClientRect().height 记账,margin
      // 不在 rect 内 → 视觉排版比内部记账高,点击坐标反查会系统性偏到下面的行
      // ("点上面选中下面")。表格 widget 一直用 padding 就是这个原因。
      '.cm-md-horizontal-rule': {
        display: 'block',
        // Tailwind preflight 全局 border-box,这里要 content-box 才能让
        // padding 叠在 1px 之外撑出总高度。
        boxSizing: 'content-box',
        height: '1px',
        padding: '0.75em 0',
        backgroundClip: 'content-box',
        backgroundColor: board,
      },
      '.cm-md-table-line': {
        backgroundColor: tableBg,
        fontFamily: CODE_FONT_STACK,
        fontSize: '0.92em',
        lineHeight: '1.65',
      },
      '.cm-md-table-widget': {
        overflow: 'visible',
        padding: '0.65em 0',
        position: 'relative',
      },
      '.cm-md-table-controls': {
        position: 'absolute',
        inset: '0',
        pointerEvents: 'none',
        zIndex: '3',
      },
      '.cm-md-table-menu': {
        position: 'absolute',
        display: 'none',
        width: '168px',
        padding: '6px',
        borderRadius: '12px',
        border: `1px solid ${board}`,
        backgroundColor: 'var(--cmd-palette-bg)',
        zIndex: '4',
        pointerEvents: 'auto',
        boxShadow: 'var(--shadow-menu)',
      },
      '.cm-md-table-widget[data-open-menu="context"] .cm-md-table-menu': {
        display: 'block',
      },
      '.cm-md-table-menu-separator': {
        height: '1px',
        margin: '5px 4px',
        backgroundColor: board,
      },
      '.cm-md-table-menu-item': {
        display: 'block',
        width: '100%',
        border: '0',
        borderRadius: '9999px',
        backgroundColor: 'transparent',
        color: text,
        cursor: 'pointer',
        font: 'inherit',
        fontSize: '13px',
        lineHeight: '1.35',
        padding: '7px 10px',
        textAlign: 'left',
      },
      '.cm-md-table-menu-item:hover': {
        backgroundColor: 'var(--cmd-palette-item-hover)',
      },
      '.cm-md-table-menu-item:disabled': {
        color: 'var(--text-disabled)',
        cursor: 'default',
      },
      '.cm-md-table-menu-item:disabled:hover': {
        backgroundColor: 'transparent',
      },
      '.cm-md-table-widget table': {
        minWidth: '100%',
        borderCollapse: 'collapse',
        tableLayout: 'fixed',
        fontSize: '0.95em',
        lineHeight: '1.5',
      },
      '.cm-md-table-widget th, .cm-md-table-widget td': {
        border: `1px solid ${board}`,
        padding: '8px 10px',
        textAlign: 'left',
        verticalAlign: 'top',
        wordBreak: 'break-word',
        overflowWrap: 'anywhere',
        outline: 'none',
      },
      '.cm-md-table-widget th': {
        fontWeight: '500',
        backgroundColor: tableBg,
        position: 'relative',
      },
      '.cm-md-table-resize-handle': {
        position: 'absolute',
        top: '0',
        right: '-3px',
        width: '6px',
        height: '100%',
        cursor: 'col-resize',
        userSelect: 'none',
        zIndex: '1',
      },
      '.cm-md-table-resize-handle:hover': {
        backgroundColor: board,
      },
      '.cm-md-table-widget td:focus, .cm-md-table-widget th:focus': {
        boxShadow: `inset 0 0 0 1px ${muted}`,
      },
      // ── Fenced code block 卡片(``` / ~~~ 整块) ─────────────────────────
      // 行角色由 markdownFenceLines.computeFenceLineRoles 标注:first/body/last
      // 三类行拼成一张连贯的灰底圆角卡片。未闭合围栏的开栏行只有本基础 class
      // (无 first/last),渲染成单行灰条。
      // ⚠️ 卡片外间距用透明 border(计入 getBoundingClientRect,height map 能
      // 记账),不能用 margin — 见 .cm-md-horizontal-rule 的说明。
      '.cm-md-fence-line': {
        color: muted,
        fontFamily: CODE_FONT_STACK,
        fontSize: '0.875em',
        lineHeight: '1.7',
        backgroundColor: 'var(--msg-code-block-bg)',
        paddingLeft: '16px',
        paddingRight: '16px',
      },
      // 内容行用正文色;``` 标记行(first/last)保持 muted,视觉上退后。
      '.cm-md-fence-body': {
        color: text,
      },
      '.cm-md-fence-first': {
        paddingTop: '10px',
        borderTop: '0.65em solid transparent',
        backgroundClip: 'padding-box',
        // 椭圆半径补偿:外圈纵向半径 = 12px + border 宽,灰底(padding box)的
        // 可见圆角保持 12px 正圆(与 mermaid 卡片一致)。
        borderTopLeftRadius: '12px calc(12px + 0.65em)',
        borderTopRightRadius: '12px calc(12px + 0.65em)',
      },
      '.cm-md-fence-last': {
        paddingBottom: '10px',
        borderBottom: '0.65em solid transparent',
        backgroundClip: 'padding-box',
        borderBottomLeftRadius: '12px calc(12px + 0.65em)',
        borderBottomRightRadius: '12px calc(12px + 0.65em)',
      },
      // ── Markdown image live-preview widget ──────────────────────────────
      // padding 而非 margin — 见上方 .cm-md-horizontal-rule 的说明。
      '.cm-md-image-widget': {
        padding: '0.65em 0',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: '10px',
      },
      // <p align="center"> blocks center their images (README hero shots).
      '.cm-md-image-widget.cm-md-image-center': {
        alignItems: 'center',
      },
      '.cm-md-image-item': {
        maxWidth: '100%',
      },
      '.cm-md-image-widget img': {
        display: 'block',
        maxWidth: '100%',
        maxHeight: '60vh',
        height: 'auto',
        width: 'auto',
        borderRadius: '8px',
      },
      '.cm-md-image-item.cm-md-image-clickable': {
        cursor: 'zoom-in',
      },
      '.cm-md-image-item.cm-md-image-clickable:focus-visible': {
        outline: `2px solid var(--focus-ring)`,
        outlineOffset: '2px',
      },
      // Load-failure / unresolvable-path card: keeps the raw src visible so
      // the user can spot the typo without un-collapsing anything.
      '.cm-md-image-error': {
        padding: '10px 14px',
        borderRadius: '8px',
        border: `1px dashed ${board}`,
        color: muted,
        fontSize: '13px',
        lineHeight: '1.5',
        maxWidth: '100%',
      },
      '.cm-md-image-error-path': {
        fontFamily: CODE_FONT_STACK,
        fontSize: '12px',
        wordBreak: 'break-all',
        opacity: '0.8',
      },
      // 外层 wrapper 只负责纵向留白(padding,不能 margin — 见
      // .cm-md-horizontal-rule 的说明);卡片视觉(边框/背景/圆角)在内层
      // .cm-md-mermaid-card 上,这样留白也被 CM 量进块高度。
      '.cm-md-mermaid-widget': {
        padding: '0.65em 0',
      },
      '.cm-md-mermaid-card': {
        // position:relative anchors the absolute-positioned toolbar.
        position: 'relative',
        padding: '16px',
        minHeight: '40px',
        borderRadius: '12px',
        border: `1px solid var(--msg-code-block-border)`,
        backgroundColor: 'var(--msg-code-block-bg)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        overflowX: 'auto',
      },
      '.cm-md-mermaid-card.cm-md-mermaid-clickable': {
        cursor: 'zoom-in',
      },
      '.cm-md-mermaid-card.cm-md-mermaid-clickable:focus-visible': {
        outline: `2px solid var(--focus-ring)`,
        outlineOffset: '2px',
      },
      // Hover-revealed toolbar (top-right of widget). Holds zoom + edit-source
      // buttons; positioned absolute so layout doesn't shift when the SVG
      // resizes. Visibility opacity-driven so transition is smooth.
      '.cm-md-mermaid-toolbar': {
        position: 'absolute',
        top: '8px',
        right: '8px',
        display: 'flex',
        gap: '4px',
        opacity: '0',
        transition: 'opacity 150ms ease',
        zIndex: '1',
      },
      '.cm-md-mermaid-card:hover .cm-md-mermaid-toolbar, .cm-md-mermaid-card:focus-within .cm-md-mermaid-toolbar': {
        opacity: '1',
      },
      '.cm-md-mermaid-toolbar-btn': {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '28px',
        height: '28px',
        padding: '0',
        borderRadius: '6px',
        border: `1px solid ${board}`,
        backgroundColor: 'var(--msg-code-block-bg)',
        color: muted,
        cursor: 'pointer',
        transition: 'background-color 120ms ease, color 120ms ease',
      },
      '.cm-md-mermaid-toolbar-btn:hover': {
        backgroundColor: 'var(--cmd-palette-item-hover)',
        color: text,
      },
      '.cm-md-mermaid-toolbar-btn:focus-visible': {
        outline: `2px solid var(--focus-ring)`,
        outlineOffset: '1px',
      },
      // Cap intrinsic SVG size so a tall diagram doesn't dominate the viewport.
      '.cm-md-mermaid-card > svg': {
        maxWidth: '100%',
        maxHeight: '60vh',
        height: 'auto',
        width: 'auto',
      },
      '.cm-md-mermaid-card.cm-md-mermaid-loading, .cm-md-mermaid-card.cm-md-mermaid-error': {
        justifyContent: 'flex-start',
        flexDirection: 'column',
        alignItems: 'stretch',
      },
      '.cm-md-mermaid-card.cm-md-mermaid-loading': {
        opacity: '0.6',
      },
      '.cm-md-mermaid-error-banner': {
        marginBottom: '10px',
        padding: '8px 12px',
        borderRadius: '8px',
        border: `1px solid ${board}`,
        backgroundColor: tableBg,
        color: muted,
        fontSize: '12px',
        lineHeight: '1.5',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      },
      '.cm-md-mermaid-fallback': {
        margin: '0',
        padding: '0',
        background: 'transparent',
        color: text,
        fontFamily: CODE_FONT_STACK,
        fontSize: CODE_FONT_SIZE,
        lineHeight: '1.5',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      },
      '.cm-selectionBackground, ::selection': {
        background: 'var(--focus-ring-soft) !important',
      },
      '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
        background: 'var(--focus-ring-soft)',
      },
      '.cm-activeLine, .cm-activeLineGutter': { background: 'transparent' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: text },
    },
    { dark: isDark },
  );
}

export const markdownLightEditorTheme = makeMarkdownEditorTheme(false);
export const markdownDarkEditorTheme = makeMarkdownEditorTheme(true);
