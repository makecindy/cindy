/**
 * imageAnnotationModel.ts — 图片圈点标注的纯函数层(手机版)。
 * ---------------------------------------------------------------------------
 * 笔迹一律存**归一化坐标**(0..1,相对图片自然尺寸),显示(SVG overlay)与
 * 烧录(WebView canvas)共用同一映射,所见即所得。视觉参数、线宽公式、归一化与
 * 采点过滤、SVG path 与 canvas 重放算法全部来自跨端共享核心
 * `@cindy/maker-shared/image-annotation`(与桌面同一份实现)。
 *
 * 手机版特有的部分:
 *   - contain 布局计算(RN 没有 getBoundingClientRect,显示矩形要从容器尺寸、
 *     自然尺寸与 lightbox 的 translate/scale 状态推导);
 *   - WebView 烧录 HTML 生成与协议(RN 无 DOM canvas,烧录在隐藏 WebView 里
 *     重放,重放脚本内联共享核心的 ANNOTATION_CANVAS_SCRIPT);
 *   - 烧录前的源图预处理规划(Android 解不了的格式先转码、超大图先预缩);
 *   - mime 嗅探与直传白名单。
 * 全部无副作用,node 可单测;React 组件只做事件采集与状态管理。
 */

import {
  ANNOTATION_CANVAS_SCRIPT,
  INTERRUPTED_STROKE_DISCARD_SCREEN_PX,
  annotationStrokeToSvgPath,
  annotationStrokeWidth,
  annotationOutlineWidth,
  normalizeAnnotationPoint as normalizeSharedAnnotationPoint,
  shouldAppendAnnotationPoint,
  type AnnotationStroke,
} from '@cindy/maker-shared/image-annotation';
import { MOBILE_IMAGE_UPLOAD_MAX_LONG_EDGE } from '@/session/mobileImagePreprocess';

// 视觉参数与纯函数的唯一真相源是跨端共享核心(@cindy/maker-shared/image-annotation);
// 这里只做薄 re-export,既有调用点与测试不必改导入路径。
export {
  ANNOTATION_OUTLINE_COLOR,
  ANNOTATION_OUTLINE_WIDTH_RATIO,
  ANNOTATION_STROKE_COLOR,
  MIN_POINT_DISTANCE_RATIO,
} from '@cindy/maker-shared/image-annotation';
export {
  annotationOutlineWidth,
  annotationStrokeToSvgPath,
  annotationStrokeWidth,
  shouldAppendAnnotationPoint,
};
export type { AnnotationStroke };

/**
 * 烧录 canvas 的边长上限:iOS WKWebView 的 canvas 有约 16MP 的硬限制,超限
 * 绘制静默产出空图。超大图按比例缩到该上限内烧录(归一化笔迹对缩放无感;
 * 发送链路本就有 2048 降采样,此处只是烧录阶段的安全钳)。
 */
export const ANNOTATION_MAX_BURN_DIMENSION = 4096;

/** 图片显示矩形(容器坐标系,px)。 */
export interface AnnotationDisplayRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * contain 适配的基础矩形(1x、无平移):图片按 aspect fit 居中放进容器后的
 * 位置与尺寸。lightbox 的 SVG overlay 以它为锚(其中心恒等于容器中心,因此
 * 与图片层共用同一 translate/scale transform 时视觉完全跟随)。
 */
export function annotationBaseRect(
  containerWidth: number,
  containerHeight: number,
  naturalWidth: number,
  naturalHeight: number,
): AnnotationDisplayRect | null {
  if (containerWidth <= 0 || containerHeight <= 0 || naturalWidth <= 0 || naturalHeight <= 0) {
    return null;
  }
  const scale = Math.min(containerWidth / naturalWidth, containerHeight / naturalHeight);
  const width = naturalWidth * scale;
  const height = naturalHeight * scale;
  return {
    left: (containerWidth - width) / 2,
    top: (containerHeight - height) / 2,
    width,
    height,
  };
}

/**
 * lightbox 变换状态下的实际显示矩形。图片层的 transform 是
 * [translate → scale(围绕容器中心)],因此显示中心 = 容器中心 + 平移量,
 * 尺寸 = 基础矩形 × scale。
 */
export function annotationDisplayRect(
  base: AnnotationDisplayRect,
  containerWidth: number,
  containerHeight: number,
  translateX: number,
  translateY: number,
  scale: number,
): AnnotationDisplayRect {
  const width = base.width * scale;
  const height = base.height * scale;
  return {
    left: containerWidth / 2 + translateX - width / 2,
    top: containerHeight / 2 + translateY - height / 2,
    width,
    height,
  };
}

/**
 * 触点(容器坐标)→ 归一化图片坐标。越界点钳制到边缘(画到图外时贴边),
 * 坐标量化到 4 位小数——实现见共享核心,这里只收窄参数类型。
 */
export function normalizeAnnotationPoint(
  pointX: number,
  pointY: number,
  rect: AnnotationDisplayRect,
): { x: number; y: number } | null {
  return normalizeSharedAnnotationPoint(pointX, pointY, rect);
}

/** 采点的屏幕像素阈值:移动不足该距离的 move 事件丢弃。 */
export const ANNOTATION_MIN_POINT_SCREEN_PX = 1.5;

/**
 * 按当前显示矩形把屏幕像素阈值换算成归一化最小点距(传给
 * shouldAppendAnnotationPoint)。用长边换算:任一方向上相距超过
 * {@link ANNOTATION_MIN_POINT_SCREEN_PX} 屏幕像素的点都不会被丢——放大作画时
 * 阈值随之变细保住精度,1x 下不再逐事件记录。矩形非法时退回共享默认阈值。
 */
export function annotationMinPointDistanceForRect(
  rect: Pick<AnnotationDisplayRect, 'width' | 'height'>,
  screenPx = ANNOTATION_MIN_POINT_SCREEN_PX,
): number | undefined {
  const longEdge = Math.max(rect.width, rect.height);
  if (!(longEdge > 0) || !Number.isFinite(longEdge)) return undefined;
  return screenPx / longEdge;
}

/**
 * 进行中笔迹的屏幕路径长度阈值:第二根手指落下导致单指画笔手势被取消时,
 * 短于它的半笔视为捏合起手的误触(点 / 小短线)丢弃;单指点按(手势正常结束)
 * 与真正的笔画不受影响。
 */
export const ANNOTATION_MULTI_TOUCH_DISCARD_SCREEN_PX = INTERRUPTED_STROKE_DISCARD_SCREEN_PX;

/**
 * 画笔手势结束时是否丢弃进行中的一笔:仅当手势非正常结束(第二根手指落下使
 * 单指画笔手势被取消)且屏幕路径长度短于阈值。
 */
export function shouldDiscardInterruptedStroke(
  gestureSucceeded: boolean,
  screenPathLength: number,
): boolean {
  return !gestureSucceeded && screenPathLength < ANNOTATION_MULTI_TOUCH_DISCARD_SCREEN_PX;
}

/**
 * 两组笔迹是否与基线一致(放弃确认用):逐条按引用比较——笔迹一旦落下就是
 * 不可变对象,新画 / 撤销都会改变数组成员或长度。
 */
export function annotationStrokesEqual(
  a: readonly AnnotationStroke[],
  b: readonly AnnotationStroke[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * 烧录 canvas 尺寸(与 WebView 内的安全钳同公式):长边超过
 * {@link ANNOTATION_MAX_BURN_DIMENSION} 时等比缩到上限内。
 */
export function annotationBurnCanvasSize(
  naturalWidth: number,
  naturalHeight: number,
): { width: number; height: number } {
  const cap = Math.min(1, ANNOTATION_MAX_BURN_DIMENSION / Math.max(naturalWidth, naturalHeight));
  return {
    width: Math.max(1, Math.round(naturalWidth * cap)),
    height: Math.max(1, Math.round(naturalHeight * cap)),
  };
}

/** 烧录任务输入(RN → WebView)。 */
export interface AnnotationBurnInRequest {
  /** 任务 id,回包按它对账(host 串行处理,防错帧)。 */
  id: string;
  /** 原图字节(纯 base64,无 data: 前缀)。 */
  base64: string;
  mimeType: string;
  strokes: readonly AnnotationStroke[];
  /**
   * 笔迹线宽 / 坐标所在的逻辑像素空间(可选)。源图已被预缩时传入「未预缩时
   * 的 canvas 尺寸」,WebView 在该空间内按共享算法重放后等比缩到实际 canvas,
   * 线宽相对图片的比例与未预缩时一致。缺省 = 实际 canvas 尺寸。
   */
  strokeSpace?: { width: number; height: number };
}

/** 烧录回包(WebView → RN,JSON 字符串经 postMessage)。 */
export type AnnotationBurnInResponse =
  | { id: string; ok: true; base64: string; mimeType: string; width: number; height: number }
  | { id: string; ok: false; error: string }
  | { ready: true };

/** 解析 WebView 回包;非本协议消息返回 null(防第三方注入噪声)。 */
export function parseAnnotationBurnInMessage(raw: string): AnnotationBurnInResponse | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const msg = parsed as Record<string, unknown>;
    if (msg.ready === true) return { ready: true };
    if (typeof msg.id !== 'string') return null;
    if (msg.ok === true) {
      if (typeof msg.base64 !== 'string' || typeof msg.mimeType !== 'string') return null;
      return {
        id: msg.id,
        ok: true,
        base64: msg.base64,
        mimeType: msg.mimeType,
        width: typeof msg.width === 'number' ? msg.width : 0,
        height: typeof msg.height === 'number' ? msg.height : 0,
      };
    }
    if (msg.ok === false) {
      return { id: msg.id, ok: false, error: typeof msg.error === 'string' ? msg.error : 'unknown' };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 构造注入 WebView 的烧录调用语句。请求经 JSON.stringify 嵌入:base64 字符集
 * 与数字坐标不含 `</script>` / 引号逃逸风险,注入安全。
 */
export function buildAnnotationBurnInInvocation(request: AnnotationBurnInRequest): string {
  return `window.__xdtBurnIn(${JSON.stringify(request)}); true;`;
}

/**
 * 烧录 WebView 的宿主 HTML。笔迹重放直接内联共享核心的
 * ANNOTATION_CANVAS_SCRIPT(cindyDrawAnnotationStrokes:round cap/join、先全部
 * 白描边再全部红线、单点画极短线段呈圆点),与 SVG 预览 / 桌面烧录同一实现。
 * JPEG 源保持 JPEG(照片转 PNG 体积爆炸),其余输出 PNG。
 */
export function buildAnnotationBurnInHtml(): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body>
<script>
${ANNOTATION_CANVAS_SCRIPT}
</script>
<script>
(function () {
  'use strict';
  var MAX_DIMENSION = ${ANNOTATION_MAX_BURN_DIMENSION};

  function post(msg) {
    window.ReactNativeWebView.postMessage(JSON.stringify(msg));
  }

  function drawStrokes(ctx, request, width, height) {
    var space = request.strokeSpace;
    if (space && space.width > 0 && space.height > 0 && (space.width !== width || space.height !== height)) {
      // 源图已预缩:在未预缩的逻辑空间内重放(线宽按逻辑尺寸计算),再等比缩到实际 canvas。
      ctx.save();
      ctx.scale(width / space.width, height / space.height);
      cindyDrawAnnotationStrokes(ctx, request.strokes, space.width, space.height);
      ctx.restore();
    } else {
      cindyDrawAnnotationStrokes(ctx, request.strokes, width, height);
    }
  }

  window.__xdtBurnIn = function (request) {
    try {
      var img = new Image();
      img.onload = function () {
        try {
          var naturalWidth = img.naturalWidth || img.width;
          var naturalHeight = img.naturalHeight || img.height;
          if (!naturalWidth || !naturalHeight) {
            post({ id: request.id, ok: false, error: 'image has no dimensions' });
            return;
          }
          var cap = Math.min(1, MAX_DIMENSION / Math.max(naturalWidth, naturalHeight));
          var width = Math.max(1, Math.round(naturalWidth * cap));
          var height = Math.max(1, Math.round(naturalHeight * cap));
          var canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          var ctx = canvas.getContext('2d');
          if (!ctx) {
            post({ id: request.id, ok: false, error: 'canvas unavailable' });
            return;
          }
          ctx.drawImage(img, 0, 0, width, height);
          drawStrokes(ctx, request, width, height);
          var outMime = request.mimeType === 'image/jpeg' ? 'image/jpeg' : 'image/png';
          var dataUrl = canvas.toDataURL(outMime, 0.92);
          var comma = dataUrl.indexOf(',');
          if (comma < 0) {
            post({ id: request.id, ok: false, error: 'encode failed' });
            return;
          }
          post({
            id: request.id,
            ok: true,
            base64: dataUrl.slice(comma + 1),
            mimeType: outMime,
            width: width,
            height: height,
          });
        } catch (err) {
          post({ id: request.id, ok: false, error: String(err) });
        }
      };
      img.onerror = function () {
        post({ id: request.id, ok: false, error: 'image decode failed' });
      };
      img.src = 'data:' + request.mimeType + ';base64,' + request.base64;
    } catch (err) {
      post({ id: request.id, ok: false, error: String(err) });
    }
  };

  post({ ready: true });
})();
</script>
</body></html>`;
}

/** 标注产物的文件名(烧录图始终是新文件,不覆盖原图)。 */
export function annotationBurnedFileName(mimeType: string, nowMs: number): string {
  const ext = mimeType === 'image/jpeg' ? 'jpg' : 'png';
  return `annotated-${nowMs}.${ext}`;
}

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** base64 头部 → 字节(只解码给魔数嗅探用的前几字节;不依赖全局 atob)。 */
function decodeBase64Head(base64: string, byteCount: number): Uint8Array {
  const charCount = Math.ceil(byteCount / 3) * 4;
  const clean = base64.slice(0, charCount).replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(byteCount);
  let outIndex = 0;
  for (let i = 0; i + 3 < clean.length + 1 && outIndex < byteCount; i += 4) {
    const e1 = BASE64_CHARS.indexOf(clean.charAt(i));
    const e2 = BASE64_CHARS.indexOf(clean.charAt(i + 1));
    const e3 = BASE64_CHARS.indexOf(clean.charAt(i + 2));
    const e4 = BASE64_CHARS.indexOf(clean.charAt(i + 3));
    if (e1 < 0 || e2 < 0) break;
    out[outIndex++] = (e1 << 2) | (e2 >> 4);
    if (e3 >= 0 && outIndex < byteCount) out[outIndex++] = ((e2 & 15) << 4) | (e3 >> 2);
    if (e4 >= 0 && outIndex < byteCount) out[outIndex++] = ((e3 & 3) << 6) | e4;
  }
  return out.slice(0, outIndex);
}

/**
 * 按字节魔数嗅探图片 mime(png/jpeg/gif/webp;识别不出返回 null)。
 * 与桌面 lightboxMediaActions.sniffImageMime 同口径(PR #792 review P2):
 * http 源的扩展名 / Content-Type 都可能缺失或说谎,mime 以字节为准,
 * 避免 JPEG 字节标成 .png 造成扩展名与内容不符。
 */
export function sniffImageMimeFromBase64(base64: string): string | null {
  const b = decodeBase64Head(base64, 12);
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return 'image/png';
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return 'image/jpeg';
  }
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
    return 'image/gif'; // GIF8
  }
  if (
    b.length >= 12
    && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 // RIFF
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 // WEBP
  ) {
    return 'image/webp';
  }
  return null;
}

/** 乐观上传管线直传白名单(与 attachments SUPPORTED_IMAGE_EXTS 同口径)。
 *  不在名单的可显示格式(bmp/ico/heic 等)转发时走烧录通道光栅化为 PNG
 *  (对齐桌面「字节可达 + 发送时光栅化」模型,PR #792)。 */
export function isDirectSendableImageMime(mimeType: string): boolean {
  const lower = mimeType.toLowerCase();
  return lower === 'image/png' || lower === 'image/jpeg' || lower === 'image/gif' || lower === 'image/webp';
}

/**
 * 图源 uri 的 mime 兜底(魔数嗅探失败时用):按扩展名返回**真实** mime,
 * 未知扩展给 application/octet-stream。绝不默认 image/jpeg——bmp/heic/avif/svg
 * 被标成 jpeg 会把「必须光栅化」的源误判为可直传,unsupported 字节顶着 .jpg
 * 上传(review P1);非直传 mime 会让这些源正确落入烧录光栅化路径,解不出时
 * 也是明确失败(Alert)而非静默坏数据。
 */
export function imageMimeForUriFallback(uri: string): string {
  const clean = (uri.split(/[?#]/)[0] ?? uri).toLowerCase();
  if (clean.endsWith('.png')) return 'image/png';
  if (clean.endsWith('.jpg') || clean.endsWith('.jpeg')) return 'image/jpeg';
  if (clean.endsWith('.webp')) return 'image/webp';
  if (clean.endsWith('.gif')) return 'image/gif';
  if (clean.endsWith('.bmp')) return 'image/bmp';
  if (clean.endsWith('.heic')) return 'image/heic';
  if (clean.endsWith('.heif')) return 'image/heif';
  if (clean.endsWith('.avif')) return 'image/avif';
  if (clean.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

/** gif(动图烧录只留首帧)与非位图源不开放画笔。 */
export function canAnnotateImageMime(mimeType: string | undefined): boolean {
  if (!mimeType) return true;
  const lower = mimeType.toLowerCase();
  if (!lower.startsWith('image/')) return false;
  return lower !== 'image/gif' && lower !== 'image/svg+xml';
}

/** Android 系统 WebView 解不了(或不稳定)的位图格式:烧录前先用原生 manipulator 转码。 */
const ANDROID_WEBVIEW_UNDECODABLE_MIMES = new Set([
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence',
  'image/avif',
]);
/** Android 转码 HEIC / HEIF / AVIF 的 JPEG 质量(高质量,体积可控)。 */
export const ANDROID_TRANSCODE_JPEG_QUALITY = 0.92;
/** 烧录前允许交给原生 manipulator 预缩的格式(未知 / 矢量 / 动图一律走原路径)。 */
const MANIPULATOR_PRESCALE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  ...ANDROID_WEBVIEW_UNDECODABLE_MIMES,
]);

/** 烧录前的源图预处理方案(expo-image-manipulator 执行)。 */
export interface AnnotationBurnSourcePlan {
  /** 等比缩放目标(只给长边一维);null = 只转码不缩尺寸。 */
  resize: { width: number } | { height: number } | null;
  /**
   * 中间产物格式:JPEG 源保持 JPEG(最高质量);Android 转码的 HEIC / HEIF / AVIF
   * 一律高质量 JPEG(照片格式,无损 PNG 在无尺寸提示时可达数十 MB);其余预缩
   * 为无损 PNG(保透明,长边已钳到上限)。
   */
  format: 'jpeg' | 'png';
  compress: number;
  /**
   * 预缩后笔迹重放的逻辑空间(= 未预缩时 WebView 会用的 canvas 尺寸),
   * 保证线宽相对图片的比例与未预缩时一致;只转码不缩时为 null。
   */
  strokeSpace: { width: number; height: number } | null;
}

/**
 * 决定烧录前要不要先把源图交给原生 manipulator 处理。返回 null = 原样交给
 * WebView(与既有路径完全一致)。
 *
 * - Android 系统 WebView 解不了 HEIC / HEIF / AVIF:先转码(HEIC / HEIF 转高质量
 *   JPEG 控制体积,AVIF 可能带透明、转无损 PNG),否则用户画完才得到解码失败。
 * - 已知尺寸长边超过上传上限(2048)的大图:先按上传同口径缩到上限,WebView
 *   只需解码 / 注入 / 烧录一张小图(内存与注入体积按像素数下降)。
 *   尺寸未知时不预缩(不为探测尺寸额外解码),维持原路径。
 */
export function planAnnotationBurnSource(input: {
  mimeType: string;
  platformOS: string;
  naturalWidth?: number | null;
  naturalHeight?: number | null;
}): AnnotationBurnSourcePlan | null {
  const mime = input.mimeType.trim().toLowerCase();
  if (!MANIPULATOR_PRESCALE_MIMES.has(mime)) return null;
  const width = positiveDimension(input.naturalWidth);
  const height = positiveDimension(input.naturalHeight);
  const transcode = input.platformOS === 'android' && ANDROID_WEBVIEW_UNDECODABLE_MIMES.has(mime);
  const prescale = width > 0 && height > 0 && Math.max(width, height) > MOBILE_IMAGE_UPLOAD_MAX_LONG_EDGE;
  if (!transcode && !prescale) return null;
  // HEIC/HEIF(相机照片,无透明通道)转 JPEG 控制体积;AVIF 可能带透明(贴纸等),
  // 保持 PNG 以免透明区变黑(体积由调用方的源文件上限兜底)。
  const transcodeToJpeg = transcode && mime !== 'image/avif';
  return {
    resize: prescale
      ? (width >= height ? { width: MOBILE_IMAGE_UPLOAD_MAX_LONG_EDGE } : { height: MOBILE_IMAGE_UPLOAD_MAX_LONG_EDGE })
      : null,
    format: mime === 'image/jpeg' || transcodeToJpeg ? 'jpeg' : 'png',
    compress: transcodeToJpeg ? ANDROID_TRANSCODE_JPEG_QUALITY : 1,
    strokeSpace: prescale ? annotationBurnCanvasSize(width, height) : null,
  };
}

/**
 * 校验 manipulator 预缩产物:尺寸有效、长边不超上限、宽高比与提示尺寸一致
 * (提示来自 lightbox 解码尺寸;方向或尺寸对不上说明提示不可信,放弃预缩回退
 * 原路径,绝不带着错误的线宽空间烧录)。
 */
export function isAnnotationBurnSourceResultUsable(
  plan: AnnotationBurnSourcePlan,
  result: { width: number; height: number },
  hint: { width?: number | null; height?: number | null },
): boolean {
  if (!(result.width > 0) || !(result.height > 0)) return false;
  if (!plan.resize) return true;
  if (Math.max(result.width, result.height) > MOBILE_IMAGE_UPLOAD_MAX_LONG_EDGE) return false;
  const hintWidth = positiveDimension(hint.width);
  const hintHeight = positiveDimension(hint.height);
  if (!hintWidth || !hintHeight) return false;
  const expected = hintWidth / hintHeight;
  const actual = result.width / result.height;
  return Math.abs(actual - expected) / expected <= 0.02;
}

function positiveDimension(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}
