
import type {Logger} from '@cindy/maker-core';
import {createRequire} from 'node:module';
export interface createInlineImageCompressorHost {log:Pick<Logger,'warn'>;}


type SharpModule = (typeof import('sharp'))['default'];
export function createInlineImageCompressor(host: createInlineImageCompressorHost) {
const {log}=host;



let sharpInstance: SharpModule | null = null;
let sharpLoadAttempted = false;

function loadSharp(): SharpModule | null {
  if (sharpLoadAttempted) return sharpInstance;
  sharpLoadAttempted = true;
  try {
    // Lazy require: sharp 带原生二进制,启动期不加载;加载失败整体降级为
    // "不压缩"(调用方内联原图),不能让 MCP 集成初始化炸掉。
    const req: NodeJS.Require =
      typeof require !== 'undefined' ? require : createRequire(import.meta.url);
    sharpInstance = req('sharp') as SharpModule;
  } catch (err) {
    log.warn('sharp unavailable, inline image compression disabled', {
      error: err instanceof Error ? err.message : String(err),
    });
    sharpInstance = null;
  }
  return sharpInstance;
}

/** 质量/边长阶梯:从"几乎无感"压到"缩略图",第一个达标的胜出。 */
const LADDER: ReadonlyArray<{ maxEdgePx: number; webpQuality: number }> = [
  { maxEdgePx: 1280, webpQuality: 78 },
  { maxEdgePx: 1024, webpQuality: 65 },
  { maxEdgePx: 800, webpQuality: 55 },
  { maxEdgePx: 640, webpQuality: 45 },
];

const TIMEOUT_MS = 5_000;

/** Decode untrusted plugin images even when their bytes already fit inline. */
async function isDecodableInlineImage(buffer: Buffer): Promise<boolean> {
  const sharp = loadSharp();
  if (!sharp) return false;
  try {
    await sharp(buffer, { failOn: 'warning' }).resize(1, 1).raw().toBuffer();
    return true;
  } catch {
    return false;
  }
}

/**
 * CompressInlineImageFn 实现。返回压缩后的 { buffer, mime },或 null 表示
 * "按原样内联"(已达标 / 不可解码 / sharp 缺失 / 超时)。永不 throw。
 */
async function compressInlineImage(
  buffer: Buffer,
  mime: string,
  opts: { targetBytes: number },
): Promise<{ buffer: Buffer; mime: string } | null> {
  if (buffer.byteLength <= opts.targetBytes) return null;

  const sharp = loadSharp();
  if (!sharp) return null;

  const work = (async (): Promise<{ buffer: Buffer; mime: string } | null> => {
    let smallest: Buffer | null = null;
    for (const step of LADDER) {
      const out = await sharp(buffer, { failOn: 'none' })
        .rotate()
        .resize({
          width: step.maxEdgePx,
          height: step.maxEdgePx,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: step.webpQuality })
        .toBuffer();
      if (out.byteLength <= opts.targetBytes) {
        return { buffer: out, mime: 'image/webp' };
      }
      if (!smallest || out.byteLength < smallest.byteLength) smallest = out;
    }
    // 全档位超标(极端大图/噪声图):用最小档,只要它确实比原图小。
    if (smallest && smallest.byteLength < buffer.byteLength) {
      log.warn('inline image still over target after full ladder, using smallest', {
        originalBytes: buffer.byteLength,
        smallestBytes: smallest.byteLength,
        targetBytes: opts.targetBytes,
      });
      return { buffer: smallest, mime: 'image/webp' };
    }
    return null;
  })();

  const timeout = new Promise<'timeout'>((resolve) => {
    setTimeout(() => resolve('timeout'), TIMEOUT_MS).unref?.();
  });

  try {
    const result = await Promise.race([work, timeout]);
    if (result === 'timeout') {
      log.warn('inline image compression timeout, inlining original', {
        bytes: buffer.byteLength,
        mime,
        timeoutMs: TIMEOUT_MS,
      });
      return null;
    }
    return result;
  } catch (err) {
    // GIF 动图 / SVG / 损坏数据等 sharp 处理不了的输入,全部降级内联原图。
    log.warn('inline image compression failed, inlining original', {
      bytes: buffer.byteLength,
      mime,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
return {isDecodableInlineImage,compressInlineImage};
}
