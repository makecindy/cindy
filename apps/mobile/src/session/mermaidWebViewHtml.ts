// ⚠️ 加载结构的硬约束(与 mathWebViewHtml.ts 同一套,改动前先读那边文件头):
// 阻塞式外链 <script src> 在资源请求挂起(弱网,不是快速失败)时会让页面停在
// "Loading Mermaid..." 直到浏览器自身的 TCP 超时(几十秒)。所以本文件必须保持:
// 1. 静态文档零外链资源,图表源码作为首屏内容立即绘制;
// 2. mermaid JS 由内联脚本动态注入,带超时;
// 3. 固定版本资源随 Mobile 包分发,执行失败就停留在源码展示,
//    永不长时间空转。
import { repairMermaidSource } from '@cindy/maker-shared/mermaid-autofix';

import { lightColors } from '@/theme/tokens';
import { i18n } from '@/i18n';
import { MOBILE_MERMAID_JS } from '@/session/richContentAssets.generated';
export { MOBILE_MERMAID_VERSION } from '@/session/richContentAssets.generated';

/** 本地资源执行超时;异常时停留在源码降级。 */
const MERMAID_LOCAL_TIMEOUT_MS = 1000;

/** Mermaid 本地动态加载器,只在页面含图表时注入。 */
export function buildMermaidLoaderJs(
  onReadyJs: string,
  onErrorJs = '',
): string {
  return `
    (function () {
      var done = false;
      var timer = setTimeout(fail, ${MERMAID_LOCAL_TIMEOUT_MS});
      function fail() {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { ${onErrorJs} } catch (error) { /* 保持源码展示 */ }
      }
      try {
        var script = document.createElement('script');
        script.textContent = ${serializeForScript(MOBILE_MERMAID_JS)};
        document.head.appendChild(script);
        if (!window.mermaid) { fail(); return; }
        try { ${onReadyJs} } catch (error) { fail(); return; }
        done = true;
        clearTimeout(timer);
      } catch (error) {
        fail();
      }
    })();
  `;
}

/** mermaid WebView 主题色与展示选项(可选,缺省走 light;调用方从 useTheme().colors 注入)。 */
export interface MermaidWebViewColors {
  surfaceChip?: string;
  textPrimary?: string;
  textSecondary?: string;
  textTertiary?: string;
  dark?: boolean;
  /** true 时首屏不绘制源码(保持干净背景,SVG 就绪后直接浮现,观感同图片加载);
      源码仅在 CDN 全部失败或渲染失败时作为降级出现。详情查看器用;内联预览
      保持源码首屏(列表里不能出现无内容白条)。 */
  deferSource?: boolean;
  /** true 时页面允许双指缩放(详情查看);缺省锁定(内联预览,避免列表滚动误触)。 */
  zoomable?: boolean;
}

export function buildMermaidWebViewHtml(
  source: string,
  theme: MermaidWebViewColors = {},
): string {
  const surfaceChip = theme.surfaceChip ?? lightColors.surfaceChip;
  const textPrimary = theme.textPrimary ?? lightColors.textPrimary;
  const textSecondary = theme.textSecondary ?? lightColors.textSecondary;
  const textTertiary = theme.textTertiary ?? lightColors.textTertiary;
  const mermaidTheme = theme.dark ? 'dark' : 'default';
  // 详情查看允许双指放大(上限 5x);内联预览锁定缩放,避免和消息列表滚动手势打架。
  const viewportContent = theme.zoomable
    ? 'width=device-width, initial-scale=1, maximum-scale=5'
    : 'width=device-width, initial-scale=1, maximum-scale=1';
  const trimmed = source.trim();
  const deferSource = !!theme.deferSource;
  // 空图占位文案在调用点求值(HTML 生成时),注入首屏与脚本降级两处;不硬编码。
  const emptyDiagramLabel = i18n.t('message.renderer.mermaidEmpty');
  const serializedEmptyDiagramLabel = serializeForScript(emptyDiagramLabel);
  // deferSource:首屏留空(干净背景),源码只作降级;否则源码即首屏(弱网零白条)。
  const firstFrameHtml = deferSource
    ? ''
    : `<pre>${escapeHtmlText(trimmed) || escapeHtmlText(emptyDiagramLabel)}</pre>`;
  // deferSource 模式下,本地资源失败 / 空源码这两条「静默停留首屏」的路径必须
  // 显式降级到源码,否则页面永远空白。
  const exhaustFallback = deferSource ? 'showSource();' : '';
  const serializedSource = serializeForScript(trimmed);
  // RN 侧预计算确定性修复版(mermaidAutofix):原文 parse 失败时 WebView 内用它
  // 重试一次。无可修项时注入空串,WebView 侧跳过重试直接走源码降级。
  const repaired = repairMermaidSource(trimmed);
  const serializedRepaired = serializeForScript(
    repaired === trimmed ? '' : repaired,
  );
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="${viewportContent}" />
  <style>
    html, body {
      margin: 0;
      padding: 0;
      background: ${surfaceChip};
      color: ${textPrimary};
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      overflow: auto;
    }
    #root {
      min-height: 100vh;
      box-sizing: border-box;
      padding: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    /* contain 模式:SVG 盒子撑满可视区,内容靠 preserveAspectRatio(默认 meet)
       等比缩放居中——小图放大、大图缩小,任何容器长宽比(竖屏/横屏/内联窄条)
       都不变形、不留大片空白、无内滚动。 */
    #root > svg {
      width: 100%;
      height: calc(100vh - 24px) !important;
    }
    #root.source {
      display: block;
    }
    pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 13px;
      line-height: 1.45;
      color: ${textSecondary};
    }
    .notice {
      margin-bottom: 8px;
      font-size: 12px;
      font-weight: 600;
      color: ${textTertiary};
      text-transform: uppercase;
    }
  </style>
</head>
<body>
  <!-- 首屏零外链阻塞:默认立即绘制图表源码;deferSource 模式留空背景。
       mermaid 就绪后原位升级为 SVG。 -->
  <div id="root" class="source">${firstFrameHtml}</div>
  <script>
    const source = ${serializedSource};
    const repairedSource = ${serializedRepaired};
    const root = document.getElementById('root');

    function showSource(label) {
      root.className = 'source';
      const pre = document.createElement('pre');
      pre.textContent = source || ${serializedEmptyDiagramLabel};
      root.innerHTML = '';
      if (label) {
        const notice = document.createElement('div');
        notice.className = 'notice';
        notice.textContent = label;
        root.appendChild(notice);
      }
      root.appendChild(pre);
    }

    async function renderMermaid() {
      const trimmed = source.trim();
      if (!trimmed || !window.mermaid) return;
      window.mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: '${mermaidTheme}',
        fontFamily: 'inherit',
        // htmlLabels:false 强制 SVG text 标签:foreignObject(HTML label)在 WebKit
        // 的 canvas 光栅化里会丢文字,导出 PNG 必须纯 SVG 文本。
        flowchart: { useMaxWidth: false, htmlLabels: false },
        sequence: { useMaxWidth: false },
        class: { useMaxWidth: false },
        state: { useMaxWidth: false },
        er: { useMaxWidth: false },
        // gantt 不钉 useWidth 时按「渲染那一刻的窗口宽度」排版:竖屏打开即窄画布,
        // 日期轴挤叠,且 SVG 长宽比随渲染定死、旋转只缩放不重排。钉宽画布(横屏/
        // 桌面同级)让任何朝向打开都得到宽松布局,显示端 contain 等比缩放适配。
        gantt: { useMaxWidth: false, useWidth: 760 },
        journey: { useMaxWidth: false },
        pie: { useMaxWidth: false }
      });
      try {
        await window.mermaid.parse(trimmed);
        const rendered = await window.mermaid.render('mobile-mermaid-diagram', trimmed);
        root.className = '';
        root.innerHTML = rendered.svg;
      } catch (error) {
        // 原文失败 → 用 RN 侧预算好的修复版重试一次;再失败才降级源码展示。
        if (repairedSource) {
          try {
            await window.mermaid.parse(repairedSource);
            const rendered = await window.mermaid.render('mobile-mermaid-diagram-fixed', repairedSource);
            root.className = '';
            root.innerHTML = rendered.svg;
            return;
          } catch (retryError) {
            // fall through
          }
        }
        showSource('render failed');
      }
    }

    // 导出:把当前已渲染 SVG 光栅化为 PNG(base64)经 postMessage 回传 RN。
    // 尺寸取 viewBox 固有值(与显示缩放无关),按请求倍率放大并对 canvas 上限
    // (4096)收敛;实底填充查看器底色(透明 PNG 拷贝到浅/深底后难辨认)。
    window.__cindyMermaidExportPng = function (id, scale) {
      function post(payload) {
        if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(payload));
      }
      try {
        var svg = root.querySelector('svg');
        if (!svg) { post({ type: 'mermaid-export', id: id, ok: false, error: 'not-rendered' }); return; }
        var vb = svg.viewBox && svg.viewBox.baseVal;
        var rect = svg.getBoundingClientRect();
        var w = (vb && vb.width) || rect.width || 800;
        var h = (vb && vb.height) || rect.height || 600;
        var effScale = Math.min(scale || 2, 4096 / Math.max(w, h));
        var xml = new XMLSerializer().serializeToString(svg);
        var img = new Image();
        img.onload = function () {
          try {
            var canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(w * effScale));
            canvas.height = Math.max(1, Math.round(h * effScale));
            var ctx = canvas.getContext('2d');
            ctx.fillStyle = '${surfaceChip}';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            var dataUrl = canvas.toDataURL('image/png');
            post({ type: 'mermaid-export', id: id, ok: true, base64: dataUrl.slice('data:image/png;base64,'.length) });
          } catch (e) {
            post({ type: 'mermaid-export', id: id, ok: false, error: String((e && e.message) || e) });
          }
        };
        img.onerror = function () { post({ type: 'mermaid-export', id: id, ok: false, error: 'svg-decode-failed' }); };
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
      } catch (e) {
        post({ type: 'mermaid-export', id: id, ok: false, error: String((e && e.message) || e) });
      }
    };

    // mermaid JS 随 Mobile 包分发,只在页面含图表时动态注入;
    // 执行失败停留在首屏源码,不产生空白页。
    (function () {
      if (!source.trim()) { ${exhaustFallback} return; }
      ${buildMermaidLoaderJs('renderMermaid();', exhaustFallback)}
    })();
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
