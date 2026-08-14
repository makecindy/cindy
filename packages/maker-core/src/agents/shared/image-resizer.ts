/**
 * image-resizer
 * ---------------------------------------------------------------------------
 * Last-mile shrink for images that go INTO the LLM context. UI / IM 仍然显示
 * 原图,只在 toClaudeSdkContent / toAppServerInput 这一步把 image-block 的
 * absPath 透明替换为缩好的副本路径,再由下游转换为模型原生图片输入,
 * 显著节省 vision token。
 *
 * 设计要点:
 *  - 用 sharp (libvips Node binding)。所有 decode/resize/encode 都在 libuv
 *    线程池里跑, V8 主线程不阻塞 (await 期间 IPC / agent 事件正常流动)。
 *  - 跳过短路: 原文件 ≤ skipUnderBytes (默认 500KB) 直接返回原 path,不进队列。
 *  - 并发上限: 默认 2 个并发 (semaphore), 给 libuv 池其他 IO 留余量。
 *  - 软超时: 单图 5s 没完直接放弃, 降级用原图 (log warn)。
 *  - 缓存键: sha256(absPath + mtime + size + 'v1')。同一张图反复 @ 引用零成本;
 *    版本号 v1 留作未来策略变更时强制刷缓存。
 *  - 缓存目录: os.tmpdir() 下, 全局共享 (跨 session 复用 — 同一张飞书 / art 图
 *    在多个 session 里被引用, 只缩一次)。
 *  - LRU: 全局 200MB 上限, 每次 write 后异步 sweep, 不阻塞 send。
 *  - GIF 等 sharp 不支持的格式 / 解码失败 / 任何异常 → 安全降级返回原 path。
 *
 * 不知道 sessionId, 也不需要知道 — content-hash dedup 已经把磁盘占用绑死,
 * session-tied 清理反而会破坏跨 session 缓存命中。
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// sharp 是可选 peerDep。host 没装时 import 会失败,我们整体降级为 noop
// (toClaudeSdkContent / toAppServerInput 仍能工作,只是不缩图)。
type SharpModule = (typeof import('sharp'))['default'];
let sharpInstance: SharpModule | null = null;
let sharpLoadAttempted = false;
function loadSharp(): SharpModule | null {
  if (sharpLoadAttempted) return sharpInstance;
  sharpLoadAttempted = true;
  try {
    // 用 require 而非 import 是为了在 sharp 装不上的环境(如纯 type-check 跑测试)
    // 不让顶层 import 把整个模块 boom 掉。
    const req: NodeJS.Require =
      typeof require !== 'undefined'
        ? require
        : (eval('require') as NodeJS.Require);
    sharpInstance = req('sharp') as SharpModule;
  } catch {
    sharpInstance = null;
  }
  return sharpInstance;
}

export interface ImageResizerLogger {
  warn(msg: string, meta?: Record<string, unknown>): void;
  debug?(msg: string, meta?: Record<string, unknown>): void;
}

export interface ImageResizerConfig {
  /** 长边像素上限。默认 1568 (Claude vision 推荐值)。 */
  maxEdgePx?: number;
  /** 输出 WebP 质量 0-100。默认 85。 */
  webpQuality?: number;
  /** 原图字节 ≤ 此阈值直接跳过, 不缩。默认 500_000 (500KB)。 */
  skipUnderBytes?: number;
  /** 缓存根目录。默认 os.tmpdir()/maker-core-image-resize。 */
  cacheDir?: string;
  /** 缓存总字节上限, 超出按 atime 升序删。默认 200MB。 */
  cacheLimitBytes?: number;
  /** 并发上限 (semaphore)。默认 2。 */
  concurrency?: number;
  /** 单图软超时 ms, 超时返回原 path。默认 5000。 */
  timeoutMs?: number;
  logger?: ImageResizerLogger;
}

const DEFAULTS = {
  maxEdgePx: 1568,
  webpQuality: 85,
  skipUnderBytes: 500_000,
  cacheLimitBytes: 200 * 1024 * 1024,
  concurrency: 2,
  timeoutMs: 5000,
  cacheVersion: 'v1',
};

const VALIDATION_MAX_INPUT_PIXELS = 100_000_000;

interface QueueTask {
  run: () => Promise<void>;
}

export class ImageResizer {
  private readonly cfg: Required<Omit<ImageResizerConfig, 'logger'>> & { logger: ImageResizerLogger | undefined };
  private readonly cacheDirReady: Promise<boolean>;
  private readonly inflight = new Map<string, Promise<string>>();
  private active = 0;
  private readonly waiting: QueueTask[] = [];
  private sweepScheduled = false;

  constructor(cfg: ImageResizerConfig = {}) {
    this.cfg = {
      maxEdgePx: cfg.maxEdgePx ?? DEFAULTS.maxEdgePx,
      webpQuality: cfg.webpQuality ?? DEFAULTS.webpQuality,
      skipUnderBytes: cfg.skipUnderBytes ?? DEFAULTS.skipUnderBytes,
      cacheDir:
        cfg.cacheDir ?? path.join(os.tmpdir(), 'maker-core-image-resize'),
      cacheLimitBytes: cfg.cacheLimitBytes ?? DEFAULTS.cacheLimitBytes,
      concurrency: cfg.concurrency ?? DEFAULTS.concurrency,
      timeoutMs: cfg.timeoutMs ?? DEFAULTS.timeoutMs,
      logger: cfg.logger,
    };
    this.cacheDirReady = this.preparePrivateCacheDir()
      .then(() => true)
      .catch((e) => {
        this.cfg.logger?.warn('image-resizer: private cache setup failed', {
          dir: this.cfg.cacheDir,
          error: String(e),
        });
        return false;
      });
  }

  /**
   * 缓存目录绝对路径。host 侧需要识别"某个路径是不是缩图缓存文件"时用
   * (如 ghost 附件过户:模型在 prompt 里只见得到缩图副本路径)。只读。
   */
  get cacheDir(): string {
    return this.cfg.cacheDir;
  }

  /**
   * 处理一张图。返回结果:
   *  - 缩好的缓存文件绝对路径 (新缩 / 缓存命中)
   *  - 原 absPath (跳过短路 / 不存在 / 解码失败 / 超时 / sharp 不可用 / 任何错误)
   *
   * 不抛错, 永远 resolve 一个可用 path。
   */
  async process(absPath: string): Promise<string> {
    if (!(await this.cacheDirReady)) return absPath;
    if (!absPath || typeof absPath !== 'string') return absPath;

    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(absPath);
    } catch {
      // 文件不存在 / 不可读 → 把原 path 还回去, 让下游 SDK 自己抱怨
      return absPath;
    }
    if (!stat.isFile()) return absPath;
    if (stat.size <= this.cfg.skipUnderBytes) return absPath;

    const sharp = loadSharp();
    if (!sharp) {
      this.cfg.logger?.warn('image-resizer: sharp not available, skipping resize', {
        absPath,
      });
      return absPath;
    }

    const key = this.computeCacheKey(absPath, stat.mtimeMs, stat.size);
    const cachedPath = path.join(this.cfg.cacheDir, `${key}.webp`);

    // 命中缓存 → 直接返回 (touch atime 让 LRU 把它判为最近用过)
    try {
      const cached = await fs.lstat(cachedPath);
      if (!cached.isFile() || cached.isSymbolicLink()) throw new Error('unsafe cache entry');
      await fs.chmod(cachedPath, 0o600);
      this.touchAtime(cachedPath).catch(() => undefined);
      return cachedPath;
    } catch {
      // miss, fall through
    }

    // 同一张图并发请求合并
    const existing = this.inflight.get(key);
    if (existing) return existing;

    const task = this.runResize(absPath, cachedPath, sharp).finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, task);
    return task;
  }

  /**
   * Fully decode an image before it is embedded as model-native base64 input.
   * Magic bytes identify a container but cannot prove that the payload is complete.
   * Missing sharp, decode errors, and timeouts all fail closed so callers can keep
   * the existing path-reference fallback.
   */
  async validate(absPath: string): Promise<boolean> {
    if (!absPath || typeof absPath !== 'string') return false;
    return this.validateInput(absPath, { absPath });
  }

  /** Validate the exact bytes a caller is about to embed. */
  async validateBuffer(data: Buffer): Promise<boolean> {
    if (!Buffer.isBuffer(data) || data.length === 0) return false;
    return this.validateInput(data, { bytes: data.length });
  }

  private async validateInput(
    input: string | Buffer,
    logMeta: Record<string, unknown>,
  ): Promise<boolean> {
    const sharp = loadSharp();
    if (!sharp) return false;

    return this.acquireSlot(async () => {
      const work = sharp(input, {
        failOn: 'error',
        limitInputPixels: VALIDATION_MAX_INPUT_PIXELS,
        sequentialRead: true,
      })
        .rotate()
        .resize({
          width: this.cfg.maxEdgePx,
          height: this.cfg.maxEdgePx,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .toBuffer()
        .then(() => true)
        .catch((error) => {
          this.cfg.logger?.warn('image-resizer: image validation failed', {
            ...logMeta,
            error: String(error),
          });
          return false;
        });
      const timeout = new Promise<'timeout'>((resolve) => {
        setTimeout(() => resolve('timeout'), this.cfg.timeoutMs).unref?.();
      });
      const result = await Promise.race([work, timeout]);
      if (result === 'timeout') {
        this.cfg.logger?.warn('image-resizer: image validation timeout', {
          ...logMeta,
          timeoutMs: this.cfg.timeoutMs,
        });
        return false;
      }
      return result;
    });
  }

  /** 内部: 跑实际的 resize, 含并发闸门 + 超时 + 错误降级。 */
  private async runResize(
    absPath: string,
    cachedPath: string,
    sharp: SharpModule,
  ): Promise<string> {
    return this.acquireSlot(async () => {
      const work = this.doResize(absPath, cachedPath, sharp);
      const timeout = new Promise<'timeout'>((resolve) => {
        setTimeout(() => resolve('timeout'), this.cfg.timeoutMs).unref?.();
      });
      const result = await Promise.race([work, timeout]);
      if (result === 'timeout') {
        this.cfg.logger?.warn('image-resizer: resize timeout, returning original', {
          absPath,
          timeoutMs: this.cfg.timeoutMs,
        });
        return absPath;
      }
      return result;
    });
  }

  private async doResize(
    absPath: string,
    cachedPath: string,
    sharp: SharpModule,
  ): Promise<string> {
    try {
      // failOn:'none' 容忍轻微损坏的图; rotate() 跟 EXIF 方向。
      const buf = await sharp(absPath, { failOn: 'none' })
        .rotate()
        .resize({
          width: this.cfg.maxEdgePx,
          height: this.cfg.maxEdgePx,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: this.cfg.webpQuality })
        .toBuffer();

      // 写到临时文件再 rename, 避免并发读到半截文件
      const tmpPath = `${cachedPath}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tmpPath, buf, { flag: 'wx', mode: 0o600 });
      await fs.rename(tmpPath, cachedPath);
      await fs.chmod(cachedPath, 0o600);
      this.cfg.logger?.debug?.('image-resizer: cached', {
        absPath,
        cachedPath,
        outBytes: buf.length,
      });
      this.scheduleLruSweep();
      return cachedPath;
    } catch (e) {
      // GIF / 不支持格式 / 解码失败 / 写入失败 → 全部降级回原图
      this.cfg.logger?.warn('image-resizer: resize failed, returning original', {
        absPath,
        error: String(e),
      });
      return absPath;
    }
  }

  /** 简易 semaphore: 并发上限 N, 多余的进 waiting 队列。 */
  private acquireSlot<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const task: QueueTask = {
        run: async () => {
          try {
            resolve(await fn());
          } catch (e) {
            reject(e);
          } finally {
            this.active--;
            this.pump();
          }
        },
      };
      this.waiting.push(task);
      this.pump();
    });
  }

  private pump(): void {
    while (this.active < this.cfg.concurrency && this.waiting.length > 0) {
      const next = this.waiting.shift();
      if (!next) return;
      this.active++;
      // fire-and-forget; task 内部 try/catch 已收
      void next.run();
    }
  }

  private computeCacheKey(absPath: string, mtimeMs: number, size: number): string {
    return createHash('sha256')
      .update(absPath)
      .update('|')
      .update(String(Math.floor(mtimeMs)))
      .update('|')
      .update(String(size))
      .update('|')
      .update(DEFAULTS.cacheVersion)
      .digest('hex');
  }

  private async preparePrivateCacheDir(): Promise<void> {
    await fs.mkdir(this.cfg.cacheDir, { recursive: true, mode: 0o700 });
    const cacheDirStat = await fs.lstat(this.cfg.cacheDir);
    if (!cacheDirStat.isDirectory() || cacheDirStat.isSymbolicLink()) {
      throw new Error('cache path is not a private directory');
    }
    await fs.chmod(this.cfg.cacheDir, 0o700);
    const entries = await fs.readdir(this.cfg.cacheDir);
    await Promise.all(
      entries.map(async (name) => {
        const entryPath = path.join(this.cfg.cacheDir, name);
        const entry = await fs.lstat(entryPath).catch(() => null);
        if (entry?.isFile() && !entry.isSymbolicLink()) {
          await fs.chmod(entryPath, 0o600);
        }
      }),
    );
  }

  private async touchAtime(p: string): Promise<void> {
    const now = new Date();
    try {
      await fs.utimes(p, now, now);
    } catch {
      // 平台/权限问题, 忽略 — 不影响功能
    }
  }

  /**
   * LRU sweep: 异步, 不阻塞 send。多次调度合并成一次 (sweepScheduled 守门)。
   * 策略: 列目录, 按 atime 升序删到总字节 ≤ cacheLimitBytes。
   */
  private scheduleLruSweep(): void {
    if (this.sweepScheduled) return;
    this.sweepScheduled = true;
    setImmediate(() => {
      this.sweepLru().finally(() => {
        this.sweepScheduled = false;
      });
    });
  }

  private async sweepLru(): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.cfg.cacheDir);
    } catch {
      return;
    }
    type Item = { p: string; size: number; atimeMs: number };
    const items: Item[] = [];
    for (const name of entries) {
      if (!name.endsWith('.webp')) continue;
      const p = path.join(this.cfg.cacheDir, name);
      try {
        const st = await fs.stat(p);
        if (!st.isFile()) continue;
        items.push({ p, size: st.size, atimeMs: st.atimeMs });
      } catch {
        // 文件可能在 readdir 后被并发清掉, 忽略
      }
    }
    let total = items.reduce((s, it) => s + it.size, 0);
    if (total <= this.cfg.cacheLimitBytes) return;
    items.sort((a, b) => a.atimeMs - b.atimeMs); // 最久未访问优先
    for (const it of items) {
      if (total <= this.cfg.cacheLimitBytes) break;
      try {
        await fs.unlink(it.p);
        total -= it.size;
        this.cfg.logger?.debug?.('image-resizer: lru evicted', { p: it.p, size: it.size });
      } catch {
        // 忽略
      }
    }
  }
}

// ── Module-level default singleton ───────────────────────────────────────────
// toClaudeSdkContent / toAppServerInput 直接用这个。host 想换配置可以调
// configureDefaultImageResizer() 在 Maker 起来前覆盖。

let defaultInstance: ImageResizer | null = null;

export function getDefaultImageResizer(): ImageResizer {
  if (!defaultInstance) defaultInstance = new ImageResizer();
  return defaultInstance;
}

export function configureDefaultImageResizer(cfg: ImageResizerConfig): void {
  defaultInstance = new ImageResizer(cfg);
}

/** 测试用: 重置 singleton 让下次调用拿全新实例。 */
export function __resetDefaultImageResizerForTesting(): void {
  defaultInstance = null;
}
