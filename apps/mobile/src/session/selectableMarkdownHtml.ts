import {
  isMobileMarkdownImageDirectUrl,
  parseMobileMarkdown,
  type MobileMarkdownBlock,
  type MobileMarkdownInline,
} from '@/session/messageMarkdown';
import { tokenizeCode } from '@/session/codeHighlight';
import { parseSessionDeepLinkUrl, shortSessionId } from '@/session/sessionLinks';
import { buildKatexLoaderJs } from '@/session/mathWebViewHtml';
// lineHeight 取别名:本模块内 `lineHeight` 是正文行高的局部变量(来自 options)。
import { lightColors, lineHeight as lineHeightScale, typeScale } from '@/theme/tokens';
import { i18n } from '@/i18n';

/**
 * 全屏 markdown 文档 HTML 构建器 —— 当前唯一消费方是文件预览的 MarkdownFileReader
 * (WebView 自身滚动的阅读态)。聊天消息气泡已全面切换为原生 markdown 渲染,
 * 本模块随之瘦身:气泡专用的 segments 拼装 / bridge 脚本 / 测高估算已删除,
 * 只保留「markdown → 完整 HTML 文档」这一条能力。
 */
export interface SelectableMarkdownHtmlOptions {
  bodyGap?: number;
  borderColor?: string;
  chipColor?: string;
  fontSize?: number;
  /** 行内 code 文字色(压暗档,不是底色;见 css 里的说明)。 */
  inlineCodeColor?: string;
  lineHeight?: number;
  markerWidth?: number;
  mutedColor?: string;
  /**
   * 会话深链 chip 的标题 map(sessionId → 会话标题)。渲染期同步写进静态
   * HTML(WebView 无法事后 patch DOM);缺失时降级「会话 <短id>」。
   */
  sessionLinkTitles?: Readonly<Record<string, string>>;
  /** 代码块语法着色的 6 档颜色(缺省用 light 主题值)。 */
  syntaxColors?: {
    comment?: string;
    function?: string;
    keyword?: string;
    number?: string;
    property?: string;
    string?: string;
  };
  tableCellMinWidth?: number;
  textColor?: string;
  /**
   * 定位到源码行(1-based):渲染完成后滚动到覆盖该行的块并闪两下高亮
   * (高亮是一次性动画,结束即移除,不驻留)。供「文件 chip 带行号 → 渲染态
   * 定位」使用;缺省不注入定位脚本。
   */
  targetLine?: number;
}

/** renderBlocks/renderInline 的渲染上下文(目前只有会话 chip 标题 map)。 */
interface RenderContext {
  sessionLinkTitles?: Readonly<Record<string, string>>;
}

export function buildSelectableMarkdownHtml(
  markdown: string,
  options: SelectableMarkdownHtmlOptions = {},
): string {
  // srcLines 仅在有合法定位目标时开启:无 targetLine 的消费方保持原 HTML 结构,
  // 不为用不上的 data-src-line 容器多付 DOM 节点(bot review 建议)。
  const wantsTargetLine =
    options.targetLine !== undefined && Number.isInteger(options.targetLine) && options.targetLine > 0;
  const blocks = parseMobileMarkdown(markdown, { srcLines: wantsTargetLine });
  const css = buildSelectableMarkdownCss(options);
  // KaTeX runtime 只在文档确实含公式时注入(绝大多数文档没有,不为它们付
  // CDN 请求;失败降级由占位内容天然承担——块级是源码 <pre>、行内是斜体源码)。
  // CSS/JS 一律由 loader 动态注入,不放静态 <link>/<script src>:阻塞式外链在
  // CDN 挂起时会让 WebView 永久白屏(见 mathWebViewHtml.ts 的硬约束说明)。
  const hasMath = blocksContainMath(blocks);
  return [
    '<!doctype html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">',
    `<style>${css}</style>`,
    '</head>',
    '<body>',
    `<main id="xdt-content" role="article" aria-label="${escapeAttribute(i18n.t('message.renderer.markdownDocAriaLabel'))}">`,
    renderBlocks(blocks, { sessionLinkTitles: options.sessionLinkTitles }),
    '</main>',
    hasMath ? buildMathRuntimeScript() : '',
    buildTargetLineScript(options.targetLine),
    '</body>',
    '</html>',
  ].join('');
}

/** 文档内是否存在 math 块或 inline math(决定要不要注入 KaTeX runtime)。 */
function blocksContainMath(blocks: readonly MobileMarkdownBlock[]): boolean {
  const inlinesHaveMath = (inlines: readonly MobileMarkdownInline[]) =>
    inlines.some((inline) => inline.type === 'math');
  return blocks.some((block) => {
    if (block.type === 'math') return true;
    if (block.type === 'table') {
      return block.header.some(inlinesHaveMath) || block.rows.some((row) => row.cells.some(inlinesHaveMath));
    }
    if (block.type === 'code' || block.type === 'mermaid') return false;
    return inlinesHaveMath(block.inlines);
  });
}

/**
 * KaTeX 原位渲染脚本:KaTeX 就绪后把所有 data-latex 元素替换成 KaTeX 输出。
 * CSS/JS 经 buildKatexLoaderJs 动态注入(双 CDN failover + 超时,不阻塞首屏),
 * 全部失败时占位源码(块级 <pre> / 行内斜体)保持可读;渲染失败(非法 LaTeX)
 * 由 throwOnError:false 消化,不抛错不留半截 DOM。
 */
function buildMathRuntimeScript(): string {
  const renderAllJs = [
    'document.querySelectorAll("[data-latex]").forEach(function (el) {',
    '  try {',
    '    window.katex.render(el.getAttribute("data-latex"), el, {',
    '      displayMode: el.hasAttribute("data-katex-display"),',
    '      throwOnError: false,',
    '      strict: "ignore",',
    '    });',
    '  } catch (error) { /* 保留占位源码 */ }',
    '});',
  ].join('');
  return `<script>${buildKatexLoaderJs(renderAllJs)}</script>`;
}

/**
 * 渲染态「定位到源码行」脚本:选出 data-src-line ≤ 目标行的最后一个块
 * (= 覆盖目标行的块),滚到视口中部并闪两下高亮。window load 后补滚一次
 * (图片加载会推移布局)。高亮走 CSS animation 两次迭代,animationend 移除
 * class——闪完即恢复原样,不驻留。
 */
function buildTargetLineScript(targetLine: number | undefined): string {
  if (targetLine === undefined || !Number.isInteger(targetLine) || targetLine <= 0) return '';
  const target = targetLine - 1;
  return `<script>(function(){
var nodes=document.querySelectorAll('[data-src-line]');
var best=null,bestLine=-1;
for(var i=0;i<nodes.length;i++){
  var n=parseInt(nodes[i].getAttribute('data-src-line'),10);
  if(!isNaN(n)&&n<=${target}&&n>=bestLine){bestLine=n;best=nodes[i];}
}
if(!best)return;
var scroll=function(){best.scrollIntoView({block:'center'});};
scroll();
window.addEventListener('load',function(){setTimeout(scroll,50);});
best.classList.add('xdt-line-flash');
best.addEventListener('animationend',function(){best.classList.remove('xdt-line-flash');},{once:true});
})();</script>`;
}

function buildSelectableMarkdownCss(options: SelectableMarkdownHtmlOptions): string {
  // 缺省走 light hex(调用方一般从 useTheme().colors 显式注入,见 MarkdownFileReader)。
  const textColor = cssValue(options.textColor ?? lightColors.textPrimary);
  const mutedColor = cssValue(options.mutedColor ?? lightColors.textSecondary);
  const borderColor = cssValue(options.borderColor ?? lightColors.border);
  const chipColor = cssValue(options.chipColor ?? lightColors.surfaceChip);
  const inlineCodeColor = cssValue(options.inlineCodeColor ?? lightColors.chatInlineCodeText);
  const fontSize = cssNumber(options.fontSize ?? 16);
  const lineHeight = cssNumber(options.lineHeight ?? 23);
  const codeFontSize = cssNumber(typeScale.code);
  // 标题两档大号 + 共用行高(20/28、18/28 都是 lineHeight 阶梯里的既有配对)。
  const headingLargeFontSize = cssNumber(typeScale.title);
  const headingMediumFontSize = cssNumber(typeScale.subtitle);
  const headingLineHeight = cssNumber(lineHeightScale.listTitle);
  const syntax = {
    comment: cssValue(options.syntaxColors?.comment ?? lightColors.syntaxComment),
    function: cssValue(options.syntaxColors?.function ?? lightColors.syntaxFunction),
    keyword: cssValue(options.syntaxColors?.keyword ?? lightColors.syntaxKeyword),
    number: cssValue(options.syntaxColors?.number ?? lightColors.syntaxNumber),
    property: cssValue(options.syntaxColors?.property ?? lightColors.syntaxProperty),
    string: cssValue(options.syntaxColors?.string ?? lightColors.syntaxString),
  };
  const bodyGap = cssNumber(options.bodyGap ?? 10);
  const markerWidth = cssNumber(options.markerWidth ?? 24);
  const tableCellMinWidth = cssNumber(options.tableCellMinWidth ?? 112);

  return `
    html, body {
      margin: 0;
      padding: 0;
      background: transparent;
      color: ${textColor};
      font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif;
      font-size: ${fontSize}px;
      line-height: ${lineHeight}px;
      overflow: visible;
      overflow-wrap: anywhere;
      cursor: text;
      touch-action: auto;
      -webkit-text-size-adjust: 100%;
      -webkit-tap-highlight-color: transparent;
      -webkit-touch-callout: default !important;
      -webkit-user-select: text !important;
      user-select: text !important;
      caret-color: transparent;
      outline: none;
    }
    #xdt-content {
      display: flex;
      flex-direction: column;
      gap: ${bodyGap}px;
      -webkit-touch-callout: default !important;
      -webkit-user-select: text !important;
      user-select: text !important;
      caret-color: transparent;
      outline: none;
    }
    #xdt-content * {
      -webkit-touch-callout: default !important;
      -webkit-user-select: text !important;
      user-select: text !important;
    }
    .xdt-markdown-segment {
      display: flex;
      flex-direction: column;
      gap: ${bodyGap}px;
      margin: 0;
    }
    @keyframes xdt-line-flash {
      0%, 100% { background: transparent; }
      50% { background: ${chipColor}; }
    }
    .xdt-line-flash {
      animation: xdt-line-flash 0.45s ease-in-out 2;
      border-radius: 8px;
    }
    p, h1, h2, h3, h4, h5, h6, blockquote, pre, table, .list-row {
      margin: 0;
    }
    /* 标题分三档。改前 h1–h6 全部等于正文字号(只有 font-weight:500 撑),文档里
       完全读不出层级 —— 与聊天消息流同一个缺陷、同一套修法:
         h1  20/28 = 1.400(= desktop h1 比例)
         h2  18/28 = 1.556(= desktop h2 比例)
         h3+ 正文字号,靠 500 字重区分(= desktop 让 h3 贴近正文的处理) */
    h1, h2, h3, h4, h5, h6 {
      font-size: ${fontSize}px;
      font-weight: 500;
      line-height: ${lineHeight}px;
    }
    h1 {
      font-size: ${headingLargeFontSize}px;
      line-height: ${headingLineHeight}px;
    }
    h2 {
      font-size: ${headingMediumFontSize}px;
      line-height: ${headingLineHeight}px;
    }
    /* 引用正文与列表 marker 走正文色(不用 mutedColor):mutedColor =
       textSecondary 对底色仅 3.1:1(light)/ 3.4:1(dark),低于 WCAG AA 4.5:1。
       引用语义由左侧竖线表达,编号与列表项正文同色。与聊天消息流
       (MessageRenderer 的 markdownQuoteText / markdownListMarker)保持一致。
       th 仍用 mutedColor —— 表头是元信息且有 font-weight 500 区分。 */
    blockquote {
      border-left: 2px solid ${borderColor};
      color: ${textColor};
      padding-left: 8px;
    }
    .list-row {
      display: flex;
      gap: 8px;
    }
    #xdt-content .list-marker {
      color: ${textColor};
      flex: 0 0 ${markerWidth}px;
      text-align: right;
    }
    .list-text {
      flex: 1;
      min-width: 0;
    }
    pre {
      background: ${chipColor};
      border-radius: 12px;
      box-sizing: border-box;
      color: ${textColor};
      font-family: Menlo, Monaco, Consolas, monospace;
      font-size: ${codeFontSize}px;
      line-height: 21px;
      overflow-wrap: anywhere;
      padding: 10px 12px;
      white-space: pre-wrap;
    }
    /* 语法着色只作用于代码块内(pre code):行内 code 不着色 —— 一句话里的短标识
       被染成关键字色反而更吵。与聊天消息流共用 session/codeHighlight 的分词
       结果,配色同为 GitHub 主题。
       注意:本文件是模板字符串,注释里不能出现反引号。 */
    pre code .syn-keyword { color: ${syntax.keyword}; }
    pre code .syn-string { color: ${syntax.string}; }
    pre code .syn-comment { color: ${syntax.comment}; }
    pre code .syn-number { color: ${syntax.number}; }
    pre code .syn-function { color: ${syntax.function}; }
    pre code .syn-property { color: ${syntax.property}; }
    /* 行内 code:零底色 + 等宽字体 + 文字压暗(取值见 tokens 里 chatInlineCodeText)。
       本文件虽然是 CSS,做得出圆角淡底,但仍跟随聊天消息流的 markdownInlineCode ——
       同一个 App 里同一种元素不该两副样子;桌面端另走 GitHub 淡底,两端形态刻意不同。 */
    code {
      color: ${inlineCodeColor};
      font-family: Menlo, Monaco, Consolas, monospace;
      font-size: ${codeFontSize}px;
    }
    /* 代码块内不压暗:pre 已有底色与描边把它划成独立区块,里面还要承载语法着色,
       正文片段必须留在正文色上。不写这条 color 就会继承上面 code 的压暗。 */
    pre code {
      background: transparent;
      color: ${textColor};
      font-size: inherit;
    }
    a {
      color: ${textColor};
      text-decoration: underline;
    }
    img {
      border-radius: 8px;
      cursor: pointer;
      display: inline-block;
      height: auto;
      max-width: 100%;
      /* 气泡内渲染高度上限,与 bridge 预留封顶(320px)对齐:无尺寸 ![](url) 的长图加载后
         不再无界长高(intrinsic 比例在 max-width/max-height 双约束下保持,宽随高等比收缩),
         加载后的跳变被封在预留值与上限的差以内;点开 lightbox 看全图。 */
      max-height: 320px;
      vertical-align: middle;
    }
    .xdt-image-chip {
      background: ${chipColor};
      border-radius: 6px;
      cursor: pointer;
      padding: 1px 8px;
      text-decoration: underline;
    }
    .xdt-session-chip {
      background: ${chipColor};
      border: 1px solid ${borderColor};
      border-radius: 6px;
      box-sizing: border-box;
      color: ${textColor};
      display: inline-block;
      max-width: 100%;
      padding: 0 6px;
      text-decoration: none;
      vertical-align: bottom;
    }
    table {
      border-collapse: separate;
      border-left: 1px solid ${borderColor};
      border-spacing: 0;
      border-top: 1px solid ${borderColor};
      display: block;
      max-width: 100%;
      overflow-x: auto;
    }
    th, td {
      border-bottom: 1px solid ${borderColor};
      border-right: 1px solid ${borderColor};
      box-sizing: border-box;
      min-width: ${tableCellMinWidth}px;
      padding: 4px 8px;
      text-align: left;
      vertical-align: top;
    }
    th {
      color: ${mutedColor};
      font-weight: 500;
    }
    .xdt-math-block {
      overflow-x: auto;
      text-align: center;
    }
    .xdt-math-block pre {
      text-align: left;
    }
  `;
}

function renderBlocks(blocks: readonly MobileMarkdownBlock[], ctx: RenderContext = {}): string {
  // 统一 div 包裹并打 data-src-line:#xdt-content 是 flex+gap 布局,包一层对
  // 布局中性(wrapper 成为 flex child,块自身 margin 恒 0),定位脚本按属性查块。
  return blocks
    .map((block) => {
      const html = renderBlock(block, ctx);
      return block.srcLine !== undefined ? `<div data-src-line="${block.srcLine}">${html}</div>` : html;
    })
    .join('');
}

function renderBlock(block: MobileMarkdownBlock, ctx: RenderContext): string {
  switch (block.type) {
    case 'paragraph':
      return `<p>${renderInlines(block.inlines, ctx)}</p>`;
    case 'heading': {
      const level = Math.min(6, Math.max(1, block.level));
      return `<h${level}>${renderInlines(block.inlines, ctx)}</h${level}>`;
    }
    case 'blockquote':
      return `<blockquote>${renderInlines(block.inlines, ctx)}</blockquote>`;
    case 'list_item': {
      const marker = block.checked === true ? '✓' : block.checked === false ? '□' : block.ordered ? block.marker : '•';
      return [
        '<div class="list-row">',
        `<span class="list-marker">${escapeHtml(marker)}</span>`,
        `<span class="list-text">${renderInlines(block.inlines, ctx)}</span>`,
        '</div>',
      ].join('');
    }
    case 'code':
      // 与聊天消息流同一个 tokenizer(session/codeHighlight),着色口径一致;
      // 每个非 plain 片段包一层 <span class="syn-*">,颜色见 css 里的 .syn-* 规则。
      return `<pre><code>${highlightCodeHtml(block.text, block.language)}</code></pre>`;
    case 'mermaid':
      return `<pre><code>${escapeHtml(`// mermaid\n${block.text}`)}</code></pre>`;
    case 'math':
      // display 公式:data-latex 存源码,文档级 KaTeX runtime(见
      // buildMathRuntimeScript)加载后原位渲染;CDN 失败时保持源码 <pre> 展示。
      return `<div class="xdt-math-block" data-katex-display="1" data-latex="${escapeAttribute(block.text)}"><pre>${escapeHtml(block.text)}</pre></div>`;
    case 'table':
      return [
        '<table>',
        '<thead><tr>',
        block.header.map((cell) => `<th>${renderInlines(cell, ctx)}</th>`).join(''),
        '</tr></thead>',
        '<tbody>',
        block.rows.map((row) => `<tr>${row.cells.map((cell) => `<td>${renderInlines(cell, ctx)}</td>`).join('')}</tr>`).join(''),
        '</tbody>',
        '</table>',
      ].join('');
  }
}

function renderInlines(inlines: readonly MobileMarkdownInline[], ctx: RenderContext = {}): string {
  return inlines.map((inline) => renderInline(inline, ctx)).join('');
}

function renderInline(inline: MobileMarkdownInline, ctx: RenderContext = {}): string {
  switch (inline.type) {
    case 'text':
      return escapeHtml(inline.text);
    case 'link': {
      const session = parseSessionDeepLinkUrl(inline.url);
      if (session) {
        // 会话深链 → chip:作者显式 label 优先,否则标题 map,再降级「会话 <短id>」。
        const explicit =
          inline.text.trim() && inline.text.trim() !== inline.url ? inline.text.trim() : null;
        const title =
          explicit ??
          ctx.sessionLinkTitles?.[session.sessionId] ??
          i18n.t('message.renderer.sessionChipFallback', { id: shortSessionId(session.sessionId) });
        return `<a class="xdt-session-chip" href="${escapeAttribute(inline.url)}">›&nbsp;${escapeHtml(title)}</a>`;
      }
      return `<a href="${escapeAttribute(inline.url)}">${escapeHtml(inline.text)}</a>`;
    }
    case 'strong':
      return `<strong>${escapeHtml(inline.text)}</strong>`;
    case 'emphasis':
      return `<em>${escapeHtml(inline.text)}</em>`;
    case 'code':
      return `<code>${escapeHtml(inline.text)}</code>`;
    case 'strikethrough':
      return `<del>${escapeHtml(inline.text)}</del>`;
    case 'math':
      // inline 公式:同 display 块走文档级 KaTeX runtime 原位渲染(displayMode
      // 关闭),加载失败保持斜体源码。
      return `<span class="xdt-math-inline" data-latex="${escapeAttribute(inline.text)}"><em>${escapeHtml(inline.text)}</em></span>`;
    case 'image': {
      // xdt 系非直连图:WebView 无法解析 xdt-image:// 等内部 scheme,渲染占位 chip,
      // 点击经 data-xdt-src 上报后由 ImageLightbox 走 remote-media resolver 取图。
      if (!isMobileMarkdownImageDirectUrl(inline.url)) {
        return `<span class="xdt-image-chip" data-xdt-src="${escapeAttribute(inline.url)}" data-xdt-alt="${escapeAttribute(inline.alt)}">${escapeHtml(inline.alt || i18n.t('message.renderer.imageFallbackTitle'))}</span>`;
      }
      // width/height 是解析层过滤过的纯数字提示;CSS 的 max-width:100% + height:auto 保证不撑破气泡。
      // 双属性齐全时浏览器会按声明 aspect-ratio 在加载前预留高度,height=9999 这类极端比例
      // (白名单只拦"1-4 位纯数字")会预留出 ~10k px 空框、加载后再回缩;声明比例超出 [1:4, 4:1]
      // 时丢弃 height 属性,落回 bridge 的有界预留(width×0.75 且被展示宽/封顶截断)。
      const declaredRatioSane = inline.width !== undefined && inline.height !== undefined
        ? inline.height / inline.width <= 4 && inline.height / inline.width >= 0.25
        : true;
      const size = [
        inline.width !== undefined ? ` width="${inline.width}"` : '',
        inline.height !== undefined && declaredRatioSane ? ` height="${inline.height}"` : '',
      ].join('');
      // data-xdt-src 保留解析层原始 URL:target.src 会被 WebView percent-encode(中文文件名等),
      // 与图集里存的原始 URL 精确匹配不上会丢横滑翻页,点击上报以 data-xdt-src 为准。
      return `<img src="${escapeAttribute(inline.url)}" data-xdt-src="${escapeAttribute(inline.url)}" alt="${escapeAttribute(inline.alt)}"${size}>`;
    }
  }
}

/**
 * 代码块语法着色 → HTML。走与聊天消息流相同的 tokenizer,颜色由 css 的 .syn-*
 * 规则给(见 buildSelectableMarkdownCss)。每个片段都经 escapeHtml,不会因为着色
 * 引入未转义内容。
 */
function highlightCodeHtml(source: string, language: string | undefined): string {
  return tokenizeCode(source, language)
    .map((token) => (
      token.kind === 'plain'
        ? escapeHtml(token.text)
        : `<span class="syn-${token.kind}">${escapeHtml(token.text)}</span>`
    ))
    .join('');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

function cssValue(value: string): string {
  return value.replace(/[;"<>]/g, '');
}

function cssNumber(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}
