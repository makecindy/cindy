import {
  isMobileMarkdownImageDirectUrl,
  parseMobileMarkdown,
  mobileMarkdownListMarkerText,
  type MobileMarkdownBlock,
  type MobileMarkdownInline,
  type MobileMarkdownInlineMark,
} from '@/session/messageMarkdown';
import { tokenizeCode } from '@/session/codeHighlight';
import { parseSessionDeepLinkUrl } from '@/session/sessionLinks';
import { buildKatexLoaderJs } from '@/session/mathWebViewHtml';
import { repairMermaidSource } from '@cindy/maker-shared/mermaid-autofix';
// lineHeight 取别名:本模块内 `lineHeight` 是正文行高的局部变量(来自 options)。
import { lightColors, lineHeight as lineHeightScale, typeScale } from '@/theme/tokens';
import { i18n } from '@/i18n';

/**
 * 全屏 markdown 文档 HTML 构建器 —— 文件预览的 MarkdownFileReader 使用完整文档
 * (WebView 自身滚动的阅读态)，会话分享复用 CSS 与内容片段。聊天消息气泡已全面切换为原生 markdown 渲染,
 * 本模块随之瘦身:气泡专用的 segments 拼装 / bridge 脚本 / 测高估算已删除,
 * 不承担聊天气泡的布局与手势。
 */
export interface SelectableMarkdownHtmlOptions {
  /** When supplied, export only these embedded images; never expose source URLs. */
  imageSources?: ReadonlyMap<string, { uri: string }>;
  /**
   * When true (and `imageSources` allowlist is not restricting images), emit
   * progressive hydration slots for local/remote Markdown images and enable
   * tap-to-open `markdown-image:open:<index>` messages for ImageLightbox.
   */
  interactiveImages?: boolean;
  bodyGap?: number;
  borderColor?: string;
  chipColor?: string;
  fontSize?: number;
  /** 文件预览正文左右边距；调用方传入共享 spacing.lg。 */
  horizontalPadding?: number;
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
  /** 显式指定时保留列宽并在表内横向滚动（会话分享）；省略时按文件预览视口换行。 */
  tableCellMinWidth?: number;
  textColor?: string;
  /**
   * 定位到源码行(1-based):渲染完成后滚动到覆盖该行的块并闪两下高亮
   * (高亮是一次性动画,结束即移除,不驻留)。供「文件 chip 带行号 → 渲染态
   * 定位」使用;缺省不注入定位脚本。
   */
  targetLine?: number;
}

/** renderBlocks/renderInline 的渲染上下文。 */
interface RenderContext {
  imageSources?: SelectableMarkdownHtmlOptions['imageSources'];
  interactiveImages?: boolean;
  nextImageIndex?: () => number;
  sessionLinkTitles?: Readonly<Record<string, string>>;
  /** Trusted chat renderer hook; never receives or executes author HTML. */
  renderInline?: (inline: MobileMarkdownInline) => string | undefined;
}

/** A parsed block, sharing the file reader's escaping and code tokenizer. */
export function buildSelectableMarkdownBlockHtml(block: MobileMarkdownBlock, context: RenderContext = {}): string {
  return renderBlock(block, context);
}

export function buildSelectableMarkdownHtml(
  markdown: string,
  options: SelectableMarkdownHtmlOptions = {},
): string {
  // srcLines 仅在有合法定位目标时开启:无 targetLine 的消费方保持原 HTML 结构,
  // 不为用不上的 data-src-line 容器多付 DOM 节点(bot review 建议)。
  const wantsTargetLine =
    options.targetLine !== undefined && Number.isInteger(options.targetLine) && options.targetLine > 0;
  const interactiveImages = options.interactiveImages === true && !options.imageSources;
  const blocks = parseMobileMarkdown(markdown, {
    srcLines: wantsTargetLine,
    allowLocalHtmlImages: interactiveImages,
  });
  const hasMath = blocksContainMath(blocks);
  const hasCarousel = blocksContainCarousel(blocks);
  const hasImages = interactiveImages && blocksContainImages(blocks);
  let imageCounter = 0;
  const css = buildSelectableMarkdownCss(options, hasMath);
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
    renderBlocks(blocks, {
      sessionLinkTitles: options.sessionLinkTitles,
      imageSources: options.imageSources,
      interactiveImages,
      nextImageIndex: () => imageCounter++,
    }),
    '</main>',
    hasMath ? buildMathRuntimeScript() : '',
    hasCarousel ? buildCarouselRuntimeScript() : '',
    hasImages ? buildInteractiveImageScript() : '',
    buildTargetLineScript(options.targetLine),
    '</body>',
    '</html>',
  ].join('');
}

export function buildSelectableMarkdownFragmentHtml(
  markdown: string,
  options: SelectableMarkdownHtmlOptions = {},
): string {
  return renderBlocks(parseMobileMarkdown(markdown), {
    imageSources: options.imageSources,
    sessionLinkTitles: options.sessionLinkTitles,
  });
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
    if (block.type === 'carousel') {
      return block.slides.some((slide) => blocksContainMath(slide));
    }
    if (block.type === 'code' || block.type === 'mermaid') return false;
    return inlinesHaveMath(block.inlines);
  });
}

function blocksContainCarousel(blocks: readonly MobileMarkdownBlock[]): boolean {
  return blocks.some((block) => block.type === 'carousel');
}

function blocksContainImages(blocks: readonly MobileMarkdownBlock[]): boolean {
  const inlinesHaveImage = (inlines: readonly MobileMarkdownInline[]) =>
    inlines.some((inline) => inline.type === 'image');
  return blocks.some((block) => {
    if (block.type === 'table') {
      return block.header.some(inlinesHaveImage) || block.rows.some((row) => row.cells.some(inlinesHaveImage));
    }
    if (block.type === 'carousel') {
      return block.slides.some((slide) => blocksContainImages(slide));
    }
    if (block.type === 'code' || block.type === 'mermaid' || block.type === 'math') return false;
    return inlinesHaveImage(block.inlines);
  });
}

export interface InlineMathElementLike {
  clientWidth: number;
  scrollWidth: number;
  parentElement?: { clientWidth: number } | null;
  classList: {
    add(token: string): void;
    remove(token: string): void;
  };
}

export function syncInlineMathOverflowElement(el: InlineMathElementLike): boolean {
  el.classList.remove('xdt-math-inline-fit');
  const parent = el.parentElement;
  const limit = el.clientWidth > 0 ? el.clientWidth : (parent && parent.clientWidth > 0 ? parent.clientWidth : 0);
  const fits = limit <= 0 || el.scrollWidth <= limit + 1;
  if (fits) {
    el.classList.add('xdt-math-inline-fit');
  }
  return fits;
}

/**
 * KaTeX 原位渲染脚本:KaTeX 就绪后把所有 data-latex 元素替换成 KaTeX 输出。
 */
function buildMathRuntimeScript(): string {
  const renderAllJs = [
    'function syncInlineMathOverflow() {',
    '  document.querySelectorAll(".xdt-math-inline").forEach(function (el) {',
    '    el.classList.remove("xdt-math-inline-fit");',
    '    var parent = el.parentElement;',
    '    var limit = el.clientWidth > 0 ? el.clientWidth : (parent && parent.clientWidth > 0 ? parent.clientWidth : 0);',
    '    if (limit <= 0 || el.scrollWidth <= limit + 1) {',
    '      el.classList.add("xdt-math-inline-fit");',
    '    }',
    '  });',
    '}',
    'document.querySelectorAll("[data-latex]").forEach(function (el) {',
    '  try {',
    '    window.katex.render(el.getAttribute("data-latex"), el, {',
    '      displayMode: el.hasAttribute("data-katex-display"),',
    '      throwOnError: false,',
    '      strict: "ignore",',
    '    });',
    '  } catch (error) { /* 保留占位源码 */ }',
    '});',
    'syncInlineMathOverflow();',
    'if (document.fonts && document.fonts.ready) {',
    '  document.fonts.ready.then(syncInlineMathOverflow);',
    '}',
    'window.addEventListener("resize", syncInlineMathOverflow);',
  ].join('');
  return `<script>${buildKatexLoaderJs(renderAllJs)}</script>`;
}

/**
 * Interactive slide switching for ````carousel blocks (prev/next buttons and
 * horizontal swipe inside each carousel card).
 */
function buildCarouselRuntimeScript(): string {
  return `<script>(function(){
document.querySelectorAll('[data-xdt-carousel]').forEach(function(card){
  var slides=card.querySelectorAll('[data-xdt-slide]');
  if(slides.length<=1)return;
  var counter=card.querySelector('[data-xdt-carousel-counter]');
  var active=0;
  function show(next){
    active=(next+slides.length)%slides.length;
    for(var i=0;i<slides.length;i++){
      if(i===active)slides[i].classList.add('is-active');
      else slides[i].classList.remove('is-active');
    }
    if(counter)counter.textContent=(active+1)+' / '+slides.length;
  }
  var prev=card.querySelector('[data-xdt-carousel-prev]');
  var next=card.querySelector('[data-xdt-carousel-next]');
  if(prev)prev.addEventListener('click',function(e){e.stopPropagation();show(active-1);});
  if(next)next.addEventListener('click',function(e){e.stopPropagation();show(active+1);});
  var touchStart=null;
  card.addEventListener('touchstart',function(e){
    if(e.touches.length!==1)return;
    touchStart={x:e.touches[0].clientX,y:e.touches[0].clientY};
  },{passive:true});
  card.addEventListener('touchend',function(e){
    if(!touchStart||e.changedTouches.length!==1){touchStart=null;return;}
    var dx=e.changedTouches[0].clientX-touchStart.x;
    var dy=e.changedTouches[0].clientY-touchStart.y;
    touchStart=null;
    if(Math.abs(dx)>=40&&Math.abs(dx)>Math.abs(dy)*1.5){
      show(dx<0?active+1:active-1);
    }
  },{passive:true});
});
})();</script>`;
}

/**
 * Progressive in-place image hydration and tap-to-open bridge for Markdown
 * document previews. Updates DOM slots via exact attribute comparison (zero
 * selector interpolation, zero WebView reload).
 */
function buildInteractiveImageScript(): string {
  return `<script>(function(){
window.__cindyUpdateMarkdownImage=function(rawSrc,uri,status){
  var slots=document.querySelectorAll('.xdt-md-img-slot');
  for(var i=0;i<slots.length;i++){
    var slot=slots[i];
    if(slot.getAttribute('data-xdt-img-src')!==rawSrc)continue;
    slot.classList.remove('xdt-md-img-loading');
    if(status==='ready'&&typeof uri==='string'&&uri.indexOf('data:image/')===0){
      slot.classList.remove('xdt-md-img-error');
      slot.classList.add('xdt-md-img-loaded');
      var img=slot.querySelector('img.xdt-md-img');
      if(!img){
        img=document.createElement('img');
        img.className='xdt-md-img';
        var idx=slot.getAttribute('data-xdt-img-index');
        if(idx!==null)img.setAttribute('data-xdt-img-index',idx);
        var w=slot.getAttribute('data-xdt-width');
        var h=slot.getAttribute('data-xdt-height');
        if(w)img.setAttribute('width',w);
        if(h)img.setAttribute('height',h);
        slot.textContent='';
        slot.appendChild(img);
      }
      img.alt=slot.getAttribute('data-xdt-alt')||'';
      img.src=uri;
    }else{
      slot.classList.add('xdt-md-img-error');
    }
  }
};
var root=document.getElementById('xdt-content');
if(!root)return;
root.addEventListener('click',function(event){
  var sel=window.getSelection&&window.getSelection();
  if(sel&&!sel.isCollapsed)return;
  var el=event.target&&event.target.nodeType===1?event.target:event.target&&event.target.parentElement;
  if(!el)return;
  if(el.closest&&el.closest('a,button,[data-xdt-carousel-prev],[data-xdt-carousel-next]'))return;
  var host=el.closest?el.closest('[data-xdt-img-index]'):null;
  if(!host)return;
  if(host.classList&&host.classList.contains('xdt-md-img-error'))return;
  var index=host.getAttribute('data-xdt-img-index');
  if(index===null||!/^\\d+$/.test(index))return;
  if(window.ReactNativeWebView){
    window.ReactNativeWebView.postMessage('markdown-image:open:'+index);
  }
});
})();</script>`;
}

/**
 * 渲染态「定位到源码行」脚本:选出 data-src-line ≤ 目标行的最后一个块
 * (= 覆盖目标行的块),滚到视口中部并闪两下高亮。
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

export function buildSelectableMarkdownCss(options: SelectableMarkdownHtmlOptions, includeMath = true): string {
  // 缺省走 light hex(调用方一般从 useTheme().colors 显式注入,见 MarkdownFileReader)。
  const textColor = cssValue(options.textColor ?? lightColors.textPrimary);
  const mutedColor = cssValue(options.mutedColor ?? lightColors.textSecondary);
  const borderColor = cssValue(options.borderColor ?? lightColors.border);
  const chipColor = cssValue(options.chipColor ?? lightColors.surfaceChip);
  const inlineCodeColor = cssValue(options.inlineCodeColor ?? lightColors.chatInlineCodeText);
  const fontSize = cssNumber(options.fontSize ?? 16);
  const lineHeight = cssNumber(options.lineHeight ?? 23);
  const codeFontSize = cssNumber(typeScale.bodySmall);
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
  const horizontalPadding = cssNumber(options.horizontalPadding ?? 16);
  const markerWidth = cssNumber(options.markerWidth ?? 24);
  const tableCellMinWidth = cssNumber(options.tableCellMinWidth ?? 0);
  const tableLayout = options.tableCellMinWidth === undefined
    ? 'table-layout: fixed; width: 100%;'
    : 'display: block; max-width: 100%; overflow-x: auto;';

  return `
    html {
      margin: 0;
      overflow-x: hidden;
      overscroll-behavior-x: none;
      touch-action: auto;
    }
    body {
      box-sizing: border-box;
      margin: 0;
      min-width: 0;
      padding: 0 ${horizontalPadding}px;
      background: transparent;
      color: ${textColor};
      font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif;
      font-size: ${fontSize}px;
      line-height: ${lineHeight}px;
      overflow-x: hidden;
      overflow-y: visible;
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
      max-width: 100%;
      min-width: 0;
      width: 100%;
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
    pre code .syn-keyword { color: ${syntax.keyword}; }
    pre code .syn-string { color: ${syntax.string}; }
    pre code .syn-comment { color: ${syntax.comment}; }
    pre code .syn-number { color: ${syntax.number}; }
    pre code .syn-function { color: ${syntax.function}; }
    pre code .syn-property { color: ${syntax.property}; }
    code {
      color: ${inlineCodeColor};
      font-family: Menlo, Monaco, Consolas, monospace;
      font-size: ${codeFontSize}px;
    }
    pre code {
      background: transparent;
      color: ${textColor};
      font-size: inherit;
    }
    a {
      color: inherit;
      text-decoration: underline;
    }
    img {
      border-radius: 8px;
      display: inline-block;
      height: auto;
      max-width: 100%;
      max-height: 320px;
      vertical-align: middle;
    }
    .xdt-image-chip {
      background: ${chipColor};
      border-radius: 6px;
      padding: 1px 8px;
    }
    .xdt-md-img-slot {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      max-width: 100%;
      vertical-align: middle;
    }
    .xdt-md-img-slot.xdt-md-img-loading {
      background: ${chipColor};
      border: 1px solid ${borderColor};
      border-radius: 10px;
      color: ${mutedColor};
      font-size: ${codeFontSize}px;
      min-height: 72px;
      min-width: 160px;
      padding: 10px 14px;
      box-sizing: border-box;
    }
    .xdt-md-img-slot.xdt-md-img-error {
      background: ${chipColor};
      border: 1px dashed ${borderColor};
      border-radius: 8px;
      color: ${mutedColor};
      font-size: ${codeFontSize}px;
      padding: 6px 10px;
    }
    .xdt-md-img-slot.xdt-md-img-loaded {
      display: inline-block;
      background: transparent;
      border: 0;
      padding: 0;
    }
    .xdt-carousel {
      border: 1px solid ${borderColor};
      border-radius: 12px;
      background: ${chipColor};
      overflow: hidden;
      max-width: 100%;
    }
    .xdt-carousel-stage {
      padding: 12px;
    }
    .xdt-carousel-slide {
      display: none;
      text-align: center;
    }
    .xdt-carousel-slide.is-active {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
    }
    .xdt-carousel-slide img {
      display: block;
      margin: 0 auto;
      max-height: 420px;
    }
    .xdt-carousel-nav {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 8px 12px;
      border-top: 1px solid ${borderColor};
    }
    .xdt-carousel-btn {
      appearance: none;
      -webkit-appearance: none;
      border: 1px solid ${borderColor};
      border-radius: 8px;
      background: transparent;
      color: ${textColor};
      font-size: 18px;
      line-height: 1;
      width: 34px;
      height: 30px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
    }
    .xdt-carousel-counter {
      color: ${mutedColor};
      font-size: ${codeFontSize}px;
      font-variant-numeric: tabular-nums;
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
      vertical-align: bottom;
    }
    table {
      border-collapse: separate;
      border-left: 1px solid ${borderColor};
      border-spacing: 0;
      border-top: 1px solid ${borderColor};
      ${tableLayout}
    }
    th, td {
      border-bottom: 1px solid ${borderColor};
      border-right: 1px solid ${borderColor};
      box-sizing: border-box;
      min-width: ${tableCellMinWidth}px;
      overflow-wrap: anywhere;
      padding: 4px 8px;
      word-break: break-word;
      text-align: left;
      vertical-align: top;
    }
    th {
      color: ${mutedColor};
      font-weight: 500;
    }
    .xdt-math-inline {
      display: inline-block;
      max-width: 100%;
      overflow-x: auto;
      vertical-align: middle;
    }
    .xdt-math-inline.xdt-math-inline-fit {
      overflow-x: visible;
      vertical-align: baseline;
    }
    .xdt-math-block {
      max-width: 100%;
      min-width: 0;
      padding: 4px 0;
      overflow-x: auto;
      overflow-y: hidden;
      -webkit-overflow-scrolling: touch;
      text-align: center;
    }
    ${includeMath ? `.xdt-math-inline .katex { font-size: 1.05em; }
    .xdt-math-block .katex-display { margin: 0; }` : ''}
    .xdt-math-block pre {
      text-align: left;
    }
  `;
}

function renderBlocks(blocks: readonly MobileMarkdownBlock[], ctx: RenderContext = {}): string {
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
      const marker = block.checked === true ? '✓' : block.checked === false ? '□' : mobileMarkdownListMarkerText(block).trim();
      return [
        `<div class="list-row"${block.depth ? ` style="margin-left:${block.depth}em"` : ''}>`,
        `<span class="list-marker">${escapeHtml(marker)}</span>`,
        `<span class="list-text">${renderInlines(block.inlines, ctx)}</span>`,
        '</div>',
      ].join('');
    }
    case 'code':
      return `<pre><code>${highlightCodeHtml(block.text, block.language)}</code></pre>`;
    case 'mermaid': {
      const repaired = repairMermaidSource(block.text);
      const repairedAttribute = repaired === block.text
        ? ''
        : ` data-mermaid-repaired-source="${escapeAttribute(repaired)}"`;
      return `<pre><code data-mermaid-source="${escapeAttribute(block.text)}"${repairedAttribute}>${escapeHtml(`// mermaid\n${block.text}`)}</code></pre>`;
    }
    case 'math':
      return `<div class="xdt-math-block" data-katex-display="1" data-latex="${escapeAttribute(block.text)}"><pre>${escapeHtml(block.text)}</pre></div>`;
    case 'carousel': {
      const slidesHtml = block.slides
        .map((slide, index) => `<div class="xdt-carousel-slide${index === 0 ? ' is-active' : ''}" data-xdt-slide="${index}">${renderBlocks(slide, ctx)}</div>`)
        .join('');
      const navHtml = block.slides.length > 1
        ? [
            '<div class="xdt-carousel-nav">',
            `<button type="button" class="xdt-carousel-btn" data-xdt-carousel-prev aria-label="${escapeAttribute(i18n.t('message.attachmentPreview.previousPage'))}">&#8249;</button>`,
            `<span class="xdt-carousel-counter" data-xdt-carousel-counter>1 / ${block.slides.length}</span>`,
            `<button type="button" class="xdt-carousel-btn" data-xdt-carousel-next aria-label="${escapeAttribute(i18n.t('message.attachmentPreview.nextPage'))}">&#8250;</button>`,
            '</div>',
          ].join('')
        : '';
      return `<div class="xdt-carousel" data-xdt-carousel="1"><div class="xdt-carousel-stage">${slidesHtml}</div>${navHtml}</div>`;
    }
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

const MARK_TAGS: Record<MobileMarkdownInlineMark, string> = {
  strong: 'strong',
  emphasis: 'em',
  strikethrough: 'del',
};

function renderInline(inline: MobileMarkdownInline, ctx: RenderContext = {}): string {
  if (inline.marks?.length) {
    return inline.marks.reduceRight(
      (html, mark) => `<${MARK_TAGS[mark]}>${html}</${MARK_TAGS[mark]}>`,
      renderInline({ ...inline, marks: undefined }, ctx),
    );
  }
  const rendered = ctx.renderInline?.(inline);
  if (rendered !== undefined) return rendered;
  switch (inline.type) {
    case 'text':
      return escapeHtml(inline.text);
    case 'link': {
      if (!/^https?:\/\//i.test(inline.url)) {
        const session = parseSessionDeepLinkUrl(inline.url);
        if (session) {
          const explicit =
            inline.text.trim() && inline.text.trim() !== inline.url ? inline.text.trim() : null;
          const title =
            explicit ??
            ctx.sessionLinkTitles?.[session.sessionId] ??
            i18n.t('message.renderer.sessionChipFallback');
          return `<span class="xdt-session-chip">›&nbsp;${escapeHtml(title)}</span>`;
        }
        return escapeHtml(inline.text);
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
      return `<span class="xdt-math-inline" data-latex="${escapeAttribute(inline.text)}"><em>${escapeHtml(inline.text)}</em></span>`;
    case 'image': {
      const alt = inline.alt || i18n.t('message.renderer.imageFallbackTitle');
      if (ctx.imageSources) {
        const image = ctx.imageSources.get(inline.url);
        return image?.uri.startsWith('data:image/')
          ? `<img src="${escapeAttribute(image.uri)}" alt="${escapeAttribute(alt)}">`
          : `<span class="xdt-image-chip">${escapeHtml(alt)}</span>`;
      }
      const imageIndex = ctx.interactiveImages && ctx.nextImageIndex ? ctx.nextImageIndex() : null;
      const declaredRatioSane = inline.width !== undefined && inline.height !== undefined
        ? inline.height / inline.width <= 4 && inline.height / inline.width >= 0.25
        : true;
      if (!isMobileMarkdownImageDirectUrl(inline.url)) {
        if (imageIndex !== null) {
          const dimAttrs = [
            inline.width !== undefined ? ` data-xdt-width="${inline.width}"` : '',
            inline.height !== undefined && declaredRatioSane ? ` data-xdt-height="${inline.height}"` : '',
          ].join('');
          return `<span class="xdt-md-img-slot xdt-md-img-loading" data-xdt-img-index="${imageIndex}" data-xdt-img-src="${escapeAttribute(inline.url)}" data-xdt-alt="${escapeAttribute(alt)}"${dimAttrs}><span>${escapeHtml(alt)}</span></span>`;
        }
        return `<span class="xdt-image-chip" data-xdt-src="${escapeAttribute(inline.url)}" data-xdt-alt="${escapeAttribute(inline.alt)}">${escapeHtml(alt)}</span>`;
      }
      const size = [
        inline.width !== undefined ? ` width="${inline.width}"` : '',
        inline.height !== undefined && declaredRatioSane ? ` height="${inline.height}"` : '',
      ].join('');
      const interactiveAttrs = imageIndex !== null
        ? ` class="xdt-md-img" data-xdt-img-index="${imageIndex}"`
        : '';
      return `<img src="${escapeAttribute(inline.url)}" data-xdt-src="${escapeAttribute(inline.url)}" alt="${escapeAttribute(alt)}"${interactiveAttrs}${size}>`;
    }
  }
}

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
