/**
 * inlineImageCompressor.ts
 * ---------------------------------------------------------------------------
 * Host-side implementation of @cindy/mcps' `CompressInlineImageFn`: shrinks the
 * inline (LLM-facing) copy of generated / downloaded images to a hard byte
 * target so the tool-result stream-json line stays under Claude Code's 256KiB
 * atomic-write boundary(超过会分块写,分块间隙可能被同进程其它 stdout 写入插队,
 * 整行 JSON 损坏后 agent-sdk 静默丢弃,表现为聊天流图片卡不渲染、tool_result
 * 不落库)。全分辨率原图始终由各 mediaStore 落盘,这里只影响给模型看的副本。
 *
 * 实现:sharp(desktop 直接依赖)webp 质量/边长阶梯,从高保真往下压,第一个
 * ≤ targetBytes 的档位胜出;全档位都超标时用最小的那份(仍优于原图);sharp
 * 不可用 / 解码失败 / 超时(5s)→ 返回 null,调用方内联原图(legacy 行为)。
 * 与 maker-core ImageResizer 的取舍不同:那边是文件路径 + 缓存 LRU(服务
 * toClaudeSdkContent 热路径),这边是内存 Buffer 一次性小图,不值得共享缓存。
 */

import { createLogger } from '../logger.js';

const log = createLogger('inlineImageCompressor');

type SharpModule = (typeof import('sharp'))['default'];
let sharpInstance: SharpModule | null = null;
let sharpLoadAttempted = false;

function loadSharp(): SharpModule | null {
  if (sharpLoadAttempted) return sharpInstance;
  sharpLoadAttempted = true;
  try {
    // Lazy require: sharp 带原生二进制,启动期不加载;加载失败整体降级为
    // "不压缩"(调用方内联原图),不能让 MCP 集成初始化炸掉。
    const req: NodeJS.Require =
      typeof require !== 'undefined' ? require : (eval('require') as NodeJS.Require);
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

/** Managed previews decode the bounded source once; later quality steps use
 * only its small thumbnail. Base64 is produced by the caller after fitting.
 */
export async function prepareInlineImagePreview(
  buffer: Buffer,
  mime: string,
  opts: { targetBytes: number },
): Promise<{ buffer: Buffer; mime: string } | null> {
  const sharp = loadSharp();
  if (!sharp) return null;
  try {
    const image = sharp(buffer, { failOn: 'warning', limitInputPixels: 16_777_216 });
    if (buffer.byteLength <= opts.targetBytes) {
      await image.resize(1, 1).raw().toBuffer();
      return { buffer, mime };
    }
    const first = LADDER[0];
    const thumbnail = await image
      .rotate()
      .resize({
        width: first.maxEdgePx,
        height: first.maxEdgePx,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: first.webpQuality })
      .toBuffer();
    if (thumbnail.byteLength <= opts.targetBytes) return { buffer: thumbnail, mime: 'image/webp' };
    const smaller = await compressInlineImage(thumbnail, 'image/webp', opts);
    return smaller && smaller.buffer.byteLength <= opts.targetBytes ? smaller : null;
  } catch {
    return null;
  }
}

/** Decode untrusted plugin images even when their bytes already fit inline. */
export async function isDecodableInlineImage(buffer: Buffer): Promise<boolean> {
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
export async function compressInlineImage(
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
