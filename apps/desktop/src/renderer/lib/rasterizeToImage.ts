/**
 * rasterizeToImage — 消息内容块「复制为图片」的共享光栅化实现(renderer)。
 *
 * 两条互补路径,产物统一为 PNG Blob:
 *   1. `svgToPngBlob`  — Mermaid 等天然 SVG 的块:SVG 字符串 → data: URL →
 *      `Image.decode()` → canvas。算法与手机版对齐(mermaidWebViewHtml.ts):
 *      按 viewBox 固有尺寸取材(与屏幕显示缩放无关)、3x 导出倍率、
 *      4096 边长收敛、主题实底。
 *   2. `domToPngBlob`  — 表格 / KaTeX 公式等普通 HTML DOM 块:经 html-to-image
 *      (foreignObject 序列化)光栅化;web font(KaTeX 字体等)必须内联,
 *      否则 SVG-as-image 渲染时回退系统字体——首次收集后模块级缓存。
 *
 * 剪贴板走 `copyPngBlobToClipboard`(纯内存 ClipboardItem,不落盘,不涉及
 * cindy-media 总仓;与 ImageLightbox.handleCopyImage 同一范式)。
 */

import { getFontEmbedCSS, toBlob as domNodeToBlob } from 'html-to-image';

import { createLogger } from '@/lib/logger';

const log = createLogger('RasterizeToImage');

/** 导出倍率:与手机版 EXPORT_PNG_SCALE 一致,保证飞书/文档里缩放后仍清晰。 */
export const EXPORT_PNG_SCALE = 3;

/**
 * canvas 单边上限:超大图(长 flowchart / 宽表格)按此对倍率收敛,防止
 * 位图内存爆炸(4096×4096×4B ≈ 64MB 已是单次导出可接受的上限)。
 */
export const EXPORT_MAX_EDGE_PX = 4096;

/** 输出像素总量上限:与 4096×4096 位图保持同一约 64MB 内存预算。 */
export const EXPORT_MAX_OUTPUT_PIXELS = EXPORT_MAX_EDGE_PX * EXPORT_MAX_EDGE_PX;

/**
 * 倍率收敛(纯函数,单测覆盖):目标倍率同时受最长边与输出像素总量约束。
 * 两个限制都是**硬上限**(内存保护是第一目标):内容本身超长时倍率允许任意小,
 * 产物是一张有界的整体缩略图——绝不为可读性抬高倍率突破上限(review P1:
 * 钳 0.1 下界会让 50000px 内容导出 5000px 位图,内存峰值超设计值)。
 */
export function computeExportScale(
  width: number,
  height: number,
  desiredScale: number = EXPORT_PNG_SCALE,
  maxEdge: number = EXPORT_MAX_EDGE_PX,
  maxOutputPixels: number = EXPORT_MAX_OUTPUT_PIXELS,
): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return 1;
  }
  const edgeScale = maxEdge / Math.max(width, height);
  const pixelScale = Math.sqrt(maxOutputPixels / (width * height));
  return Math.min(desiredScale, edgeScale, pixelScale);
}

/**
 * 从 SVG 字符串解析固有尺寸(纯函数,单测覆盖):viewBox 优先(与显示期
 * CSS 收缩无关),缺 viewBox 时回退 width/height 属性(剥掉 px 单位)。
 */
export function parseSvgIntrinsicSize(svgText: string): { width: number; height: number } | null {
  const container = document.createElement('div');
  container.innerHTML = svgText;
  const el = container.querySelector('svg');
  if (!el) return null;
  const vb = el.getAttribute('viewBox');
  if (vb) {
    const parts = vb
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
      return { width: parts[2], height: parts[3] };
    }
  }
  const w = Number.parseFloat(el.getAttribute('width') ?? '');
  const h = Number.parseFloat(el.getAttribute('height') ?? '');
  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
    return { width: w, height: h };
  }
  return null;
}

/**
 * 导出实底色:从触发元素向上找第一个非透明 computed backgroundColor
 * (即块自己所在的主题底色,天然走 token 不硬编码);全透明时回退
 * `--background`(HSL 三元组,包 hsl() 消费)。透明 PNG 贴到深/浅底
 * 都难辨认,导出一律铺实底——与手机版同一决策。
 */
export function resolveExportBackground(from?: Element | null): string {
  let el: Element | null = from ?? null;
  while (el) {
    const bg = window.getComputedStyle(el).backgroundColor;
    if (bg && bg !== 'transparent' && !/^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0\s*\)$/.test(bg)) {
      return bg;
    }
    el = el.parentElement;
  }
  const triplet = window
    .getComputedStyle(document.documentElement)
    .getPropertyValue('--background')
    .trim();
  return triplet ? `hsl(${triplet})` : '#ffffff';
}

/**
 * SVG 字符串 → PNG Blob(Mermaid 路径)。
 * Chromium 下 SVG-as-image 按 drawImage 目标尺寸矢量光栅化,放大不糊;
 * foreignObject(mermaid htmlLabels)在 Chromium 的 SVG 图像里正常渲染
 * 且不 taint canvas(html-to-image 同一机制),无需像手机版(WebKit)
 * 强制 htmlLabels:false。
 */
export async function svgToPngBlob(
  svgText: string,
  opts?: { scale?: number; background?: string },
): Promise<Blob> {
  const size = parseSvgIntrinsicSize(svgText);
  if (!size) throw new Error('svg has no usable size');
  const scale = computeExportScale(size.width, size.height, opts?.scale);
  const outW = Math.max(1, Math.round(size.width * scale));
  const outH = Math.max(1, Math.round(size.height * scale));

  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
  await image.decode();

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas unavailable');
  ctx.fillStyle = opts?.background ?? resolveExportBackground();
  ctx.fillRect(0, 0, outW, outH);
  ctx.drawImage(image, 0, 0, outW, outH);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('png encode failed');
  return blob;
}

/**
 * @font-face 内联 CSS 的模块级缓存。html-to-image 的字体收集要遍历全部
 * document 样式表并把命中的字体文件转 base64——是一次性开销,绝不能每次
 * 复制都重做。字体集在会话期不变(KaTeX/应用字体都是构建期打包),缓存
 * 一次全局复用;失败时置空缓存下次重试,并降级为不内联(系统字体兜底)。
 */
let fontEmbedCssPromise: Promise<string> | null = null;

function getCachedFontEmbedCss(node: HTMLElement): Promise<string> {
  if (!fontEmbedCssPromise) {
    fontEmbedCssPromise = getFontEmbedCSS(node).catch((err) => {
      log.warn('font embed css collection failed, falling back to system fonts', {
        error: err instanceof Error ? err.message : String(err),
      });
      fontEmbedCssPromise = null;
      return '';
    });
  }
  return fontEmbedCssPromise;
}

/**
 * HTML DOM 节点 → PNG Blob(表格 / 块级公式路径)。
 * - 尺寸取 `scrollWidth/scrollHeight`(宽表格取完整内容宽,不被可视口截断);
 * - 倍率经 computeExportScale 按最长边与输出像素预算收敛(默认 2x——DOM 块以
 *   文字为主,2x 已够清晰,比 3x 省一半以上内存);
 * - `await document.fonts.ready` + 内联 @font-face,保证 KaTeX 字形不回退。
 */
export async function domToPngBlob(
  node: HTMLElement,
  opts?: {
    scale?: number;
    background?: string;
    maxEdge?: number;
    maxOutputPixels?: number;
  },
): Promise<Blob> {
  const width = node.scrollWidth;
  const height = node.scrollHeight;
  if (width <= 0 || height <= 0) throw new Error('node has no size');
  const scale = computeExportScale(
    width,
    height,
    opts?.scale ?? 2,
    opts?.maxEdge,
    opts?.maxOutputPixels,
  );

  await document.fonts.ready;
  const fontEmbedCSS = await getCachedFontEmbedCss(node);

  const blob = await domNodeToBlob(node, {
    width,
    height,
    pixelRatio: scale,
    backgroundColor: opts?.background ?? resolveExportBackground(node),
    fontEmbedCSS,
  });
  if (!blob) throw new Error('png encode failed');
  return blob;
}

/**
 * PNG Blob → 系统剪贴板。位图侧 ClipboardItem 仅接受 image/png(Chromium
 * 限制,与 ImageLightbox 同注);Electron/Chromium 跨平台统一实现,
 * macOS/Windows 无平台分叉。纯内存操作、不落盘。
 *
 * `plainText`(可选)与图片写进**同一个** ClipboardItem 作为 text/plain 备选
 * 表示:粘贴目标按自己的偏好取格式——飞书/文档吃图片,代码编辑器/输入框吃
 * 源码(mermaid 源码 / 表格 TSV / 公式 LaTeX),一次复制两头可用。
 */
export async function copyPngBlobToClipboard(blob: Blob, plainText?: string): Promise<void> {
  const representations: Record<string, Blob> = { 'image/png': blob };
  if (plainText) {
    representations['text/plain'] = new Blob([plainText], { type: 'text/plain' });
  }
  await navigator.clipboard.write([new ClipboardItem(representations)]);
}
