/**
 * 区域截图选区覆盖层的自包含 HTML 生成器(win/linux)。
 *
 * 页面由 main 生成、经 data: URL 加载, 只依赖专用最小 preload
 * (regionCaptureOverlayPreload)暴露的 ready/init/result 三个方法 —— 不加载
 * 主 renderer bundle, 不承载主窗口 bridge(最小权限, review P1)。样式内嵌
 * raw CSS(sessionDragPreviewHtml 同款形态), 字号 11/13px 落在 DESIGN.md §3
 * 白名单档位内。CSP 采用 sha256 hash 白名单(不引入 'unsafe-inline', 仓库
 * 安全约束): 脚本是固定常量; 样式由主题配色生成, hash 按最终样式串运行时
 * 计算, 配色值经 main 严格格式校验、hint 只进 HTML 转义后的文本节点。
 *
 * 交互契约(与 main 侧 overlayCapture 对齐):
 * - DOMContentLoaded → announceReady → 收到 init 设置冻结帧 → img 解码完成
 *   announceContentReady → main 才 show() 窗口(解码失败报 cancel);
 * - 左键拖框 → mouseup 上报 select(DIP rect, 任意方向拖拽已规整并夹取边界);
 * - Esc / 右键 / 失焦(300ms 挂载宽限) → cancel; 近零选区由 main 判定为误点。
 */

import { createHash } from 'node:crypto';

import type { ScreenCaptureOverlayPalette } from '../../shared/screenCapture.js';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** CSP sha256 source 表达式(哈希内容 = 内联块标签之间的原文, 字节精确)。 */
function cspHash(source: string): string {
  return `'sha256-${createHash('sha256').update(source, 'utf8').digest('base64')}'`;
}

/**
 * 样式按主题配色生成(Light/Dark 双模式, DESIGN.md 门槛): 色值由 renderer 解析
 * 当前主题语义 token 后随 invoke 传入, main 已做严格格式校验(sanitizeOverlayPalette,
 * 仅放行 #hex / rgb[a] / hsl[a] 字面量), 非法值到不了这里 —— CSP 的 style hash
 * 由最终样式串运行时计算, 动态配色不破坏白名单。
 */
function buildOverlayStyle(palette: ScreenCaptureOverlayPalette): string {
  return `
  html, body { margin: 0; width: 100vw; height: 100vh; overflow: hidden; background: #000; cursor: crosshair; user-select: none; }
  #frame { position: absolute; inset: 0; width: 100%; height: 100%; display: none; }
  #mask { position: absolute; inset: 0; background: ${palette.scrim}; }
  #sel { position: absolute; display: none; border: 1px solid ${palette.selectionBorder}; box-shadow: 0 0 0 100000px ${palette.scrim}; }
  #size { position: absolute; top: -24px; left: 0; padding: 2px 6px; border-radius: 4px; background: ${palette.pillBg}; color: ${palette.pillFg}; font-family: ui-monospace, monospace; font-size: 11px; white-space: nowrap; }
  #hint { position: absolute; top: 32px; left: 50%; transform: translateX(-50%); padding: 6px 12px; border-radius: 6px; background: ${palette.pillBg}; color: ${palette.pillFg}; font-family: system-ui, sans-serif; font-size: 13px; white-space: nowrap; }`;
}

const OVERLAY_SCRIPT = `
(function () {
  'use strict';
  var api = window.regionCaptureOverlayAPI;
  if (!api) return;
  var frame = document.getElementById('frame');
  var mask = document.getElementById('mask');
  var sel = document.getElementById('sel');
  var size = document.getElementById('size');
  var hint = document.getElementById('hint');
  var reported = false;
  var start = null;

  function report(result) {
    if (reported) return;
    reported = true;
    api.reportResult(result);
  }

  // 拖拽起点/当前点 → 规整选区(任意方向拖拽都得到正宽高), 夹取到窗口边界。
  function rectFrom(a, b) {
    var maxX = window.innerWidth;
    var maxY = window.innerHeight;
    function clamp(v, max) { return Math.min(Math.max(v, 0), max); }
    var x1 = clamp(Math.min(a.x, b.x), maxX);
    var y1 = clamp(Math.min(a.y, b.y), maxY);
    var x2 = clamp(Math.max(a.x, b.x), maxX);
    var y2 = clamp(Math.max(a.y, b.y), maxY);
    return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
  }

  function renderSelection(rect) {
    sel.style.display = 'block';
    sel.style.left = rect.x + 'px';
    sel.style.top = rect.y + 'px';
    sel.style.width = rect.width + 'px';
    sel.style.height = rect.height + 'px';
    size.textContent = Math.round(rect.width) + ' \\\\u00d7 ' + Math.round(rect.height);
    mask.style.display = 'none';
    hint.style.display = 'none';
  }

  api.onInit(function (payload) {
    if (payload && typeof payload.imageDataUrl === 'string') {
      // 冻结帧解码完成后才让 main show() 窗口 —— 大分辨率帧解码期间不能先闪
      // 出全屏纯黑覆盖层。解码失败按取消收场, 不给用户一个黑屏选区。
      frame.onload = function () {
        mountedAt = Date.now();
        api.announceContentReady();
      };
      frame.onerror = function () {
        report({ kind: 'cancel' });
      };
      frame.src = payload.imageDataUrl;
      frame.style.display = 'block';
    }
  });

  document.addEventListener('mousedown', function (e) {
    if (e.button !== 0) return;
    start = { x: e.clientX, y: e.clientY };
    renderSelection(rectFrom(start, start));
  });
  document.addEventListener('mousemove', function (e) {
    if (!start) return;
    renderSelection(rectFrom(start, { x: e.clientX, y: e.clientY }));
  });
  document.addEventListener('mouseup', function (e) {
    if (!start) return;
    var rect = rectFrom(start, { x: e.clientX, y: e.clientY });
    start = null;
    report({ kind: 'select', rect: rect });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') report({ kind: 'cancel' });
  });
  document.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    report({ kind: 'cancel' });
  });
  // 失焦取消(切走窗口/Alt-Tab)。窗口刚显示时部分 WM 会派发瞬时 blur, 给宽限;
  // 起点在帧解码完成(即将 show)时重置, 覆盖解码耗时超过宽限窗口的情况。
  var mountedAt = Date.now();
  window.addEventListener('blur', function () {
    if (Date.now() - mountedAt < 300) return;
    report({ kind: 'cancel' });
  });

  api.announceReady();
})();`;

export function buildRegionCaptureOverlayHtml(
  hintText: string,
  palette: ScreenCaptureOverlayPalette,
): string {
  const hint = escapeHtml(hintText);
  const style = buildOverlayStyle(palette);
  const csp = [
    "default-src 'none'",
    'img-src data:',
    `style-src ${cspHash(style)}`,
    `script-src ${cspHash(OVERLAY_SCRIPT)}`,
  ].join('; ');
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>${style}</style>
</head>
<body>
<img id="frame" alt="" draggable="false">
<div id="mask"></div>
<div id="sel"><div id="size"></div></div>
<div id="hint">${hint}</div>
<script>${OVERLAY_SCRIPT}</script>
</body>
</html>`;
}
