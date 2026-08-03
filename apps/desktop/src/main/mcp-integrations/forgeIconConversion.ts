import { GHOST_ICON_MAX_BYTES } from '../../shared/ghost.js';

export const FORGE_ICON_CONVERT_TIMEOUT_MS = 5_000;
const FORGE_ICON_EDGE_PX = 1024;
const FORGE_ICON_TIMEOUT = Symbol('forge-icon-timeout');

export type ForgeSharpModule = (typeof import('sharp'))['default'];

interface ForgeIconConverterOptions {
  loadSharp: () => ForgeSharpModule | null;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

type ForgeIconWorkOutcome =
  | { ok: true; data: Buffer }
  | { ok: false; error: unknown };

/**
 * Forge 图标转换器。只允许一个原生 sharp 任务在飞；繁忙时直接回退默认图标，
 * 不排队。wall-clock 超时只负责尽快返回，名额必须等 native promise 真正 settle
 * 才释放，否则每次超时都会继续往 Electron 主进程叠加后台任务。
 */
export function createForgeIconConverter(options: ForgeIconConverterOptions) {
  const timeoutMs = options.timeoutMs ?? FORGE_ICON_CONVERT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? GHOST_ICON_MAX_BYTES;
  const nativeTimeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  let busy = false;

  return async function convertForgeIconToPng(absPath: string): Promise<Buffer> {
    if (busy) throw new Error('AI 图标转换繁忙，已使用默认图标');
    const sharp = options.loadSharp();
    if (!sharp) throw new Error('sharp unavailable');

    let work: Promise<ForgeIconWorkOutcome>;
    busy = true;
    try {
      const nativeWork = sharp(absPath, {
        failOn: 'error',
        limitInputPixels: 64 * 1024 * 1024,
      })
        .rotate()
        .resize(FORGE_ICON_EDGE_PX, FORGE_ICON_EDGE_PX, {
          fit: 'cover',
          position: 'centre',
        })
        // palette 量化降低 AI 图片体积；最终仍按安装器的 512 KiB 硬顶复核。
        .png({ compressionLevel: 9, palette: true, colours: 256, effort: 7 })
        // sharp 的原生 timeout 会终止 libvips 处理；外层 race 还需覆盖排队时间。
        .timeout({ seconds: nativeTimeoutSeconds })
        .toBuffer();
      // race 前先把 rejection 变成普通 outcome，迟到异常不会逃逸成
      // unhandledRejection；busy 跟 native 生命周期走，不跟 wall-clock race 走。
      work = nativeWork
        .then<ForgeIconWorkOutcome, ForgeIconWorkOutcome>(
          (data) => ({ ok: true, data }),
          (error) => ({ ok: false, error }),
        )
        .finally(() => {
          busy = false;
        });
    } catch (err) {
      busy = false;
      throw err;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        work,
        new Promise<typeof FORGE_ICON_TIMEOUT>((resolve) => {
          timer = setTimeout(() => resolve(FORGE_ICON_TIMEOUT), timeoutMs);
          timer.unref?.();
        }),
      ]);
      if (result === FORGE_ICON_TIMEOUT) {
        throw new Error(`AI 图标转换超时(${timeoutMs}ms)`);
      }
      if (!result.ok) {
        throw result.error instanceof Error ? result.error : new Error(String(result.error));
      }
      if (result.data.byteLength === 0 || result.data.byteLength > maxOutputBytes) {
        throw new Error(`AI 图标转换结果必须在 1–${maxOutputBytes} 字节之间`);
      }
      return result.data;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
}
