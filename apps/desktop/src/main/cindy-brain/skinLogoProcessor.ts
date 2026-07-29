/**
 * Cindy Skin 首页 Logo 专用预处理。
 *
 * 生图模型对透明画布支持不稳定，因此插件统一要求“近白纯色底 + 深色文字字标”，
 * 主机再确定性地把近白像素转成平滑 alpha，并裁掉画布留白。
 */
import fs from 'node:fs/promises';

import * as blobStore from '../cindy-media/blobStore.js';
import { ingestMedia } from '../cindy-media/ingest.js';
const CLEAR_AT = 8;
const OPAQUE_AT = 40;

const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_PIXELS = 8_000_000;
let processingTail: Promise<void> = Promise.resolve();

type SharpModule = (typeof import('sharp'))['default'];
let sharpInstance: SharpModule | null = null;
let sharpLoadAttempted = false;

/** sharp 带原生 libvips；只在用户实际处理皮肤图片时加载，不进入 main 启动链。 */
function loadSharp(): SharpModule {
  if (!sharpLoadAttempted) {
    sharpLoadAttempted = true;
    try {
      const req: NodeJS.Require =
        typeof require !== 'undefined' ? require : (eval('require') as NodeJS.Require);
      sharpInstance = req('sharp') as SharpModule;
    } catch {
      sharpInstance = null;
    }
  }
  if (!sharpInstance) {
    throw new Error('图片处理组件暂时不可用，请重启 Cindy 后重试');
  }
  return sharpInstance;
}

function serializeProcessing<T>(operation: () => Promise<T>): Promise<T> {
  const run = processingTail.then(operation);
  processingTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function validateStaticImageBuffer(source: Uint8Array): Promise<void> {
  if (source.byteLength <= 0 || source.byteLength > MAX_SOURCE_BYTES) {
    throw new Error('图片过大，请使用 8 MB 以内的静态图片');
  }
  const sharp = loadSharp();
  const metadata = await sharp(source, {
    failOn: 'error',
    limitInputPixels: MAX_SOURCE_PIXELS,
  }).metadata();
  if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_SOURCE_PIXELS) {
    throw new Error('图片尺寸过大，请使用 800 万像素以内的静态图片');
  }
  if ((metadata.pages ?? 1) > 1 || metadata.pageHeight) {
    throw new Error('只支持静态图片');
  }
}

export function validateStaticSkinImage(source: Uint8Array): Promise<void> {
  return serializeProcessing(() => validateStaticImageBuffer(source));
}

export async function whiteBackgroundToTransparentPng(source: Uint8Array): Promise<Buffer> {
  return serializeProcessing(async () => {
    await validateStaticImageBuffer(source);
    const sharp = loadSharp();
    const { data, info } = await sharp(source, {
      failOn: 'error',
      limitInputPixels: MAX_SOURCE_PIXELS,
    })
      .rotate()
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    let visiblePixels = 0;
    for (let offset = 0; offset < data.length; offset += 4) {
      const distanceFromWhite = Math.max(
        255 - data[offset],
        255 - data[offset + 1],
        255 - data[offset + 2],
      );
      const whiteAlpha =
        distanceFromWhite <= CLEAR_AT
          ? 0
          : distanceFromWhite >= OPAQUE_AT
            ? 255
            : Math.round(((distanceFromWhite - CLEAR_AT) / (OPAQUE_AT - CLEAR_AT)) * 255);
      data[offset + 3] = Math.round((data[offset + 3] * whiteAlpha) / 255);
      if (data[offset + 3] >= 24) visiblePixels += 1;
    }
    if (visiblePixels < 16) {
      throw new Error('Logo 去白底后没有可见内容，请使用深色文字与纯白背景');
    }

    return sharp(data, {
      raw: {
        width: info.width,
        height: info.height,
        channels: 4,
      },
    })
      .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
  });
}

export async function removeWhiteSkinLogoBackground(params: {
  hash: string;
  ext: string;
}): Promise<{ hash: string; url: string; mimeType: string }> {
  const { absPath } = blobStore.resolveHashRef(params.hash, params.ext);
  const source = await fs.readFile(absPath);
  const png = await whiteBackgroundToTransparentPng(source);
  const ingested = await ingestMedia({
    buffer: png,
    mimeType: 'image/png',
    refs: [],
  });
  return {
    hash: ingested.hash,
    url: ingested.url,
    mimeType: ingested.mimeType,
  };
}
