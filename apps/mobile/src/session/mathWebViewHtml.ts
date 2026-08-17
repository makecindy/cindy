// KaTeX 版本对齐基准:desktop 真正的渲染引擎是 rehype-katex 内部依赖的
// KaTeX 的 JS/CSS/字体由同步脚本从根依赖一起打包,三者必须保持同版本——
// KaTeX 的字体文件名、度量和类名会随版本变化,跨版本错配是静态检查发现不了
// 的渲染劣化,review 实捉。
//
// ⚠️ 加载结构的硬约束(模拟器实测事故后的结论,改动前必读):
// 外链 CSS <link> 放 <head> 是渲染阻塞、<script src> 是解析阻塞——资源请求
// 一旦挂起(不是快速失败),页面会**永久白屏**且 load 事件永不触发,WKWebView
// 反复重排空白视图造成整屏闪动。所以本文件的 HTML 必须保持:
// 1. 静态文档零外链资源,公式源码作为首屏内容立即绘制;
// 2. KaTeX 的 CSS/JS 全部由内联脚本动态注入,带超时;
// 3. 固定版本资源随 Mobile 包分发,加载失败就停留在源码展示,永不白屏。
import { lightColors } from '@/theme/tokens';
import {
  MOBILE_KATEX_CSS,
  MOBILE_KATEX_JS,
} from '@/session/richContentAssets.generated';
export { MOBILE_KATEX_VERSION } from '@/session/richContentAssets.generated';

/** 本地资源执行超时;异常时停留在源码占位。 */
const KATEX_LOCAL_TIMEOUT_MS = 1000;

/**
 * KaTeX 动态加载器 JS(不含 <script> 标签)。资源随 Mobile 包分发,
 * 只在页面实际含公式时注入,避免普通文档付出渲染开销。
 * @param onReadyJs window.katex 可用且样式就绪后执行的 JS 语句。
 * @param onErrorJs 本地资源执行异常时的收敛语句。
 */
export function buildKatexLoaderJs(onReadyJs: string, onErrorJs = ''): string {
  return `
    (function () {
      var done = false;
      var timer = setTimeout(fail, ${KATEX_LOCAL_TIMEOUT_MS});
      function fail() {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { ${onErrorJs} } catch (error) { /* 保持源码展示 */ }
      }
      try {
        var style = document.createElement('style');
        style.textContent = ${serializeForScript(MOBILE_KATEX_CSS)};
        document.head.appendChild(style);
        var script = document.createElement('script');
        script.textContent = ${serializeForScript(MOBILE_KATEX_JS)};
        document.head.appendChild(script);
        if (!window.katex) { fail(); return; }
        try { ${onReadyJs} } catch (error) { fail(); return; }
        done = true;
        clearTimeout(timer);
      } catch (error) {
        fail();
      }
    })();
  `;
}

/** math WebView 主题色(可选,缺省走 light;调用方从 useTheme().colors 注入)。 */
export interface MathWebViewColors {
  background?: string;
  textPrimary?: string;
  textSecondary?: string;
  errorColor?: string;
}

// 颜色值白名单:只放行 hex / rgb(a) / hsl(a) 形态。主题色会插值进 <style>
// 规则与 JS 字符串字面量两种上下文,字符集里排除引号/花括号/尖括号/反斜杠,
// 两种上下文都不可能被截断或注入;不合形态一律回退默认值(当前主题 token
// 全是内部 hex/rgba,校验是为将来用户自定义主题留的防线,review 建议)。
const SAFE_CSS_COLOR_RE =
  /^(#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla)\([0-9,.%\s/]*\))$/;

function safeCssColor(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && SAFE_CSS_COLOR_RE.test(trimmed) ? trimmed : fallback;
}

/**
 * display LaTeX 公式 → 自包含 WebView HTML 文档。
 * - 首屏立即绘制公式源码(零外链阻塞,永不白屏),KaTeX 就绪后原位升级;
 * - 渲染/高度变化经 ReactNativeWebView.postMessage 上报,宿主组件自适应高度;
 * - 本地资源执行失败时停留在源码展示(与 mermaid 的 showSource 降级口径一致)。
 */
export function buildMathWebViewHtml(
  latex: string,
  theme: MathWebViewColors = {},
): string {
  const background = safeCssColor(theme.background, lightColors.surface);
  const textPrimary = safeCssColor(theme.textPrimary, lightColors.textPrimary);
  const textSecondary = safeCssColor(
    theme.textSecondary,
    lightColors.textSecondary,
  );
  const errorColor = safeCssColor(theme.errorColor, textSecondary);
  const trimmed = latex.trim();
  const serializedSource = serializeForScript(trimmed);
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
  <style>
    html, body {
      margin: 0;
      padding: 0;
      background: ${background};
      color: ${textPrimary};
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    #root {
      box-sizing: border-box;
      padding: 8px 4px;
      overflow-x: auto;
      overflow-y: hidden;
      text-align: center;
    }
    #root .katex-display {
      margin: 0;
    }
    pre {
      margin: 0;
      text-align: left;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 13px;
      line-height: 1.45;
      color: ${textSecondary};
    }
  </style>
</head>
<body>
  <div id="root"><pre>${escapeHtmlText(trimmed)}</pre></div>
  <script>
    var source = ${serializedSource};
    var root = document.getElementById('root');

    var lastSentHeight = 0;
    var lastSentStage = '';
    // stage 语义:'source' = 源码占位的过渡态高度;'katex' = KaTeX 成品的最终
    // 态高度。宿主组件对已有最终高度缓存的公式会忽略过渡态上报,重访零跳动。
    function reportHeight(stage) {
      if (!window.ReactNativeWebView) return;
      var height = Math.ceil(root.getBoundingClientRect().height);
      // 滞回去抖:相近高度不重复上报(阈值与宿主同口径);stage 升级
      // (source → katex)即使高度相同也放行一次,宿主靠它落最终高度缓存。
      if (stage === lastSentStage && Math.abs(height - lastSentHeight) < 3) return;
      lastSentHeight = height;
      lastSentStage = stage;
      window.ReactNativeWebView.postMessage(
        JSON.stringify({ kind: 'math-height', stage: stage, height: height }),
      );
    }

    function renderKatex() {
      window.katex.render(source, root, {
        displayMode: true,
        throwOnError: false,
        strict: 'ignore',
        errorColor: '${errorColor}',
      });
      reportHeight('katex');
      // 字体异步就绪后度量可能微调,fonts.ready 后补报一次(幂等)。
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(function () { reportHeight('katex'); });
      }
    }

    // 首屏源码已绘制,先按它上报过渡态高度,WebView 立即获得正确尺寸的可见内容。
    reportHeight('source');
    if (source.trim()) {
      ${buildKatexLoaderJs('renderKatex();')}
    }
  </script>
</body>
</html>`;
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function serializeForScript(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
