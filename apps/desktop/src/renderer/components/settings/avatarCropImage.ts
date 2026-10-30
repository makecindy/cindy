/**
 * avatarCropImage — 头像编辑的解码与导出(依赖 Canvas / ImageBitmap,几何见 avatarCropGeometry)。
 *
 * 色彩约定(与头像 HDR→SDR 转换的整合点):
 *   - 源图只解码一次成 ImageBitmap(按 EXIF 方向转正、超大图预缩到 4096px 长边);
 *   - 编辑台与导出都把它画进**默认的 sRGB 8-bit 2D 画布**,两者走同一条绘制路径,
 *     所以编辑台显示的像素与导出的像素一致;
 *   - 导出经 canvas 重新编码成 PNG / JPEG,输出是 8-bit sRGB,不写入 gain map 等
 *     HDR 附加数据。
 * 这里**不做** HDR→SDR 色调映射:HDR 源画进 sRGB 画布时如何压缩高光由 Chromium
 * 决定(可能只是裁切),画面观感是否合格不由本模块保证。正确的色调映射由上游
 * 选图转换负责;转换后的 SDR 源交给 loadAvatarSource 即可,本模块无需改动。
 */

import {
  avatarCropDrawRect,
  avatarOutputSize,
  type AvatarCrop,
  type AvatarImageSize,
} from './avatarCropGeometry';

/** 解码后的编辑源:转正、限尺寸后的位图 + 尺寸。 */
export interface AvatarSource {
  bitmap: ImageBitmap;
  size: AvatarImageSize;
}

/** 导出结果:即将上传的字节本身,预览也直接用它,保证所见即所传。 */
export interface AvatarExport {
  blob: Blob;
  bytes: Uint8Array;
  mimeType: AvatarExportMime;
}

export type AvatarExportMime = 'image/png' | 'image/jpeg';

/** 解码后长边上限:4x 放大时仍有充足源像素,同时把 48MP 照片的显存压到可控范围。 */
export const AVATAR_SOURCE_MAX_EDGE = 4096;
const JPEG_QUALITY = 0.92;

function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',');
  const header = dataUrl.slice(0, comma);
  const mime = /^data:([^;,]+)/.exec(header)?.[1] ?? 'application/octet-stream';
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/** 按长边上限算缩放后的尺寸(不放大)。 */
export function fitAvatarSourceSize(size: AvatarImageSize, maxEdge = AVATAR_SOURCE_MAX_EDGE) {
  const longEdge = Math.max(size.width, size.height);
  if (longEdge <= maxEdge) return size;
  const ratio = maxEdge / longEdge;
  return {
    width: Math.max(1, Math.round(size.width * ratio)),
    height: Math.max(1, Math.round(size.height * ratio)),
  };
}

/**
 * 读出图片按 EXIF 转正后的尺寸,不解码像素:`<img>` 加载完成只解析文件头,
 * 像素解码要等绘制或 decode() 才发生;naturalWidth/Height 已计入 EXIF 方向。
 */
function probeAvatarImageSize(blob: Blob): Promise<AvatarImageSize> {
  const url = URL.createObjectURL(blob);
  return new Promise<AvatarImageSize>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('avatar image is not decodable'));
    img.src = url;
  }).finally(() => URL.revokeObjectURL(url));
}

/**
 * 解码选中的图片。失败(损坏、格式不符)时抛错,由调用方提示并留在原界面。
 * 解码在切到编辑台**之前**完成,编辑台第一帧就有图,不出现空白帧。
 *
 * 先探尺寸、再**一次** createImageBitmap 直接解码到目标尺寸:超大原片不会先留一张
 * 全尺寸位图再缩出第二张,失败路径也没有需要额外释放的中间位图。
 */
export async function loadAvatarSource(dataUrl: string): Promise<AvatarSource> {
  const blob = dataUrlToBlob(dataUrl);
  const natural = await probeAvatarImageSize(blob);
  if (natural.width === 0 || natural.height === 0) {
    throw new Error('avatar image has no pixels');
  }
  const fitted = fitAvatarSourceSize(natural);
  const bitmap = await createImageBitmap(
    blob,
    fitted === natural
      ? { imageOrientation: 'from-image' }
      : {
          imageOrientation: 'from-image',
          resizeWidth: fitted.width,
          resizeHeight: fitted.height,
          resizeQuality: 'high',
        },
  );
  return { bitmap, size: { width: bitmap.width, height: bitmap.height } };
}

/** 把取景画进一块 outSize × outSize 的目标区域。编辑后预览与导出共用。 */
export function drawAvatarCrop(
  ctx: CanvasRenderingContext2D,
  source: AvatarSource,
  crop: AvatarCrop,
  outSize: number,
) {
  const { sx, sy, sw, sh } = avatarCropDrawRect(crop);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, outSize, outSize);
  ctx.drawImage(source.bitmap, sx, sy, sw, sh, 0, 0, outSize, outSize);
}

/** RGBA 像素里是否有任何非完全不透明的点。 */
export function hasTransparentPixel(rgba: Uint8ClampedArray) {
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 255) return true;
  }
  return false;
}

/**
 * 透明图沿用既有约定(保留透明,导出 PNG);其余导出 JPEG,体积更小。
 * 按导出画布的实际像素判断,不看文件扩展名——改了扩展名的透明 PNG 也保留透明。
 */
export function avatarExportMime(rgba: Uint8ClampedArray): AvatarExportMime {
  return hasTransparentPixel(rgba) ? 'image/png' : 'image/jpeg';
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: AvatarExportMime): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('avatar encode failed'))),
      mime,
      mime === 'image/jpeg' ? JPEG_QUALITY : undefined,
    );
  });
}

/** 按当前取景导出最终上传的头像字节。 */
export async function exportAvatarCrop(
  source: AvatarSource,
  crop: AvatarCrop,
): Promise<AvatarExport> {
  const outSize = avatarOutputSize(crop);
  const canvas = document.createElement('canvas');
  canvas.width = outSize;
  canvas.height = outSize;
  const ctx = canvas.getContext('2d', { colorSpace: 'srgb' });
  if (!ctx) throw new Error('avatar canvas unavailable');
  drawAvatarCrop(ctx, source, crop, outSize);
  const mimeType = avatarExportMime(ctx.getImageData(0, 0, outSize, outSize).data);
  const blob = await canvasToBlob(canvas, mimeType);
  return { blob, bytes: new Uint8Array(await blob.arrayBuffer()), mimeType };
}
