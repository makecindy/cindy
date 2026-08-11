import fs from 'node:fs';

import { withCrossProcessLock } from '../device-link/crossProcessLock.js';

interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface OverrideSettingsState<T> {
  value: T;
  isCustomized: boolean;
  defaults: T;
  customizedKeys: string[];
}

export interface OverrideSettingsFile<T> {
  read(): T;
  readState(): OverrideSettingsState<T>;
  writePatch(patch: Partial<T>, options?: { preserveDefaults?: boolean }): void;
  /** 跨进程锁内强制现读盘上 overrides，再合并 patch 并原子替换文件。 */
  writePatchAtomic(patch: Partial<T>, options?: { preserveDefaults?: boolean }): Promise<void>;
  /** 在同一把跨进程锁内基于最新磁盘快照计算并写入 patch。 */
  updateAtomic(
    updater: (current: OverrideSettingsState<T>) => Partial<T>,
    options?: { preserveDefaults?: boolean },
  ): Promise<T>;
  reset(): T;
  /** 跨进程锁内删除 override 文件。 */
  resetAtomic(): Promise<T>;
  /**
   * 文件被进程外修改(用户/agent 手改配置)时失效缓存,下次 read 现读。
   * mtime 守卫:文件没变时零开销(一次 stat),不重读不重复打 loaded 日志。
   * 支持"直接改文件即生效"语义的 store 在读取入口调用;不调用 = 原缓存语义。
   */
  invalidateIfChanged(): void;
}

interface CachedState<T> extends OverrideSettingsState<T> {
  overrides: Record<string, unknown>;
  readStatus: 'missing' | 'readable' | 'unreadable';
}

export function createOverrideSettingsFile<T>(options: {
  filePath: () => string;
  defaults: T;
  normalize: (raw: unknown) => T;
  mergeOverrides?: (args: {
    patch: Partial<T>;
    next: T;
    defaults: T;
    overrides: Record<string, unknown>;
  }) => Record<string, unknown>;
  log: Logger;
  label: string;
  /** owner/session 跨 await 切换时让原子写 fail closed。 */
  scopeKey?: () => string;
  /** 读写文件的大小硬上限；超限时拒绝读取或落盘，避免主进程无界分配。 */
  maxBytes?: number;
  /** 读取/解析失败时保留原文件并拒绝普通写入；reset 仍可显式恢复。 */
  preserveUnreadableFile?: boolean;
  /** 设置值可能含敏感数据时，仅记录加载状态，不把 normalized value 写入日志。 */
  logLoadedValue?: boolean;
  /** 读取错误可能带出原文件片段时，不把错误详情写入日志。 */
  logReadErrorDetails?: boolean;
}): OverrideSettingsFile<T> {
  let cached: CachedState<T> | null = null;
  let cachedResolvedPath: string | null = null;
  /** 缓存装载时文件的 mtimeMs;null = 装载时文件不存在(默认态)。 */
  let cachedFileMtimeMs: number | null = null;

  const defaults = (): T => clone(options.defaults);

  /** 当前文件 mtimeMs;文件不存在/不可 stat 时 null(与"无文件"同态)。 */
  function statFileMtimeMs(): number | null {
    try {
      return fs.statSync(options.filePath()).mtimeMs;
    } catch {
      return null;
    }
  }

  function readState(): OverrideSettingsState<T> {
    invalidateIfPathChanged();
    if (cached) return toPublicState(cached);
    const file = options.filePath();
    cachedResolvedPath = file;
    let readStatus: CachedState<T>['readStatus'] = 'missing';
    try {
      if (fs.existsSync(file)) {
        const stat = fs.statSync(file);
        if (options.maxBytes !== undefined && stat.size > options.maxBytes) {
          throw new Error(`file exceeds ${options.maxBytes} byte limit`);
        }
        const text = fs.readFileSync(file, 'utf-8');
        const parsed = JSON.parse(text);
        if (options.preserveUnreadableFile && !isLoggableObject(parsed)) {
          throw new Error('settings file root must be an object');
        }
        const overrides = isLoggableObject(parsed) ? parsed : {};
        cachedFileMtimeMs = stat.mtimeMs;
        cached = {
          value: options.normalize({ ...defaults(), ...overrides }),
          isCustomized: Object.keys(overrides).length > 0,
          defaults: defaults(),
          customizedKeys: Object.keys(overrides),
          overrides,
          readStatus: 'readable',
        };
        options.log.info(`${options.label} settings loaded`, {
          ...(options.logLoadedValue === false
            ? {}
            : isLoggableObject(cached.value)
              ? cached.value
              : { value: cached.value }),
          path: file,
          isCustomized: cached.isCustomized,
        });
        return toPublicState(cached);
      }
    } catch (err) {
      if (options.preserveUnreadableFile) readStatus = 'unreadable';
      options.log.warn(`${options.label} settings read failed; falling back to defaults`, {
        ...(options.logReadErrorDetails === false
          ? {}
          : { error: err instanceof Error ? err.message : String(err) }),
        path: file,
      });
      if (!options.preserveUnreadableFile) {
        try {
          fs.unlinkSync(file);
        } catch {
          // no-op
        }
      }
    }

    // 保留坏文件时记住它的 mtime，避免每次读取重复解析/刷日志；用户修复后
    // invalidateIfChanged 会看到 mtime 变化并自动重试。
    cachedFileMtimeMs = readStatus === 'unreadable' ? statFileMtimeMs() : null;
    cached = {
      value: defaults(),
      isCustomized: false,
      defaults: defaults(),
      customizedKeys: [],
      overrides: {},
      readStatus,
    };
    return toPublicState(cached);
  }

  function invalidateIfChanged(): void {
    invalidateIfPathChanged();
    if (!cached) return;
    if (statFileMtimeMs() !== cachedFileMtimeMs) {
      cached = null;
      cachedFileMtimeMs = null;
    }
  }

  function writePatch(patch: Partial<T>, writeOptions?: { preserveDefaults?: boolean }): void {
    const current = readWritableState();
    const next = options.normalize({ ...current.value, ...patch });
    const currentDefaults = defaults();
    const currentOverrides = cached?.overrides ?? {};
    const nextOverrides = options.mergeOverrides
      ? options.mergeOverrides({
          patch,
          next,
          defaults: currentDefaults,
          overrides: currentOverrides,
        })
      : (() => {
          const overrides = { ...currentOverrides };
          for (const key of Object.keys(patch) as Array<keyof T>) {
            const normalizedValue = next[key];
            if (!writeOptions?.preserveDefaults && isEqual(normalizedValue, currentDefaults[key])) {
              delete overrides[String(key)];
            } else {
              overrides[String(key)] = normalizedValue;
            }
          }
          return overrides;
        })();
    writeOverrides(nextOverrides);
  }

  async function writePatchAtomic(
    patch: Partial<T>,
    writeOptions?: { preserveDefaults?: boolean },
  ): Promise<void> {
    const file = options.filePath();
    const scopeKey = options.scopeKey?.();
    fs.mkdirSync(pathDirname(file), { recursive: true });
    await withCrossProcessLock(
      `${file}.lock`,
      { label: `${options.label}-settings`, waitMs: 12_000 },
      async (status) => {
        if (!status.held) {
          throw new Error(`${options.label} settings are busy in another process`);
        }
        if (options.filePath() !== file || options.scopeKey?.() !== scopeKey) {
          throw new Error(
            `${options.label} settings scope changed while waiting for the write lock`,
          );
        }
        invalidate();
        writePatch(patch, writeOptions);
      },
    );
  }

  async function updateAtomic(
    updater: (current: OverrideSettingsState<T>) => Partial<T>,
    writeOptions?: { preserveDefaults?: boolean },
  ): Promise<T> {
    const file = options.filePath();
    const scopeKey = options.scopeKey?.();
    fs.mkdirSync(pathDirname(file), { recursive: true });
    return withCrossProcessLock(
      `${file}.lock`,
      { label: `${options.label}-settings`, waitMs: 12_000 },
      async (status) => {
        if (!status.held) {
          throw new Error(`${options.label} settings are busy in another process`);
        }
        if (options.filePath() !== file || options.scopeKey?.() !== scopeKey) {
          throw new Error(
            `${options.label} settings scope changed while waiting for the write lock`,
          );
        }
        invalidate();
        const current = readWritableState();
        writePatch(updater(current), writeOptions);
        return readState().value;
      },
    );
  }

  function writeOverrides(overrides: Record<string, unknown>): void {
    if (Object.keys(overrides).length === 0) {
      reset();
      return;
    }
    const file = options.filePath();
    const tmp = `${file}.tmp`;
    const serialized = JSON.stringify(overrides, null, 2);
    if (
      options.maxBytes !== undefined &&
      Buffer.byteLength(serialized, 'utf-8') > options.maxBytes
    ) {
      throw new Error(`file exceeds ${options.maxBytes} byte limit`);
    }
    fs.mkdirSync(pathDirname(file), { recursive: true });
    fs.writeFileSync(tmp, serialized, 'utf-8');
    fs.renameSync(tmp, file);
    cachedFileMtimeMs = statFileMtimeMs();
    const next = options.normalize({ ...defaults(), ...overrides });
    cached = {
      value: next,
      isCustomized: Object.keys(overrides).length > 0,
      defaults: defaults(),
      customizedKeys: Object.keys(overrides),
      overrides,
      readStatus: 'readable',
    };
  }

  function reset(): T {
    const file = options.filePath();
    cachedResolvedPath = file;
    try {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    } catch (err) {
      options.log.warn(`${options.label} settings reset failed`, {
        error: err instanceof Error ? err.message : String(err),
        path: file,
      });
      throw err;
    }
    cachedFileMtimeMs = null;
    cached = {
      value: defaults(),
      isCustomized: false,
      defaults: defaults(),
      customizedKeys: [],
      overrides: {},
      readStatus: 'missing',
    };
    options.log.info(`${options.label} settings reset to defaults`, { path: file });
    return cached.value;
  }

  async function resetAtomic(): Promise<T> {
    const file = options.filePath();
    const scopeKey = options.scopeKey?.();
    fs.mkdirSync(pathDirname(file), { recursive: true });
    return withCrossProcessLock(
      `${file}.lock`,
      { label: `${options.label}-settings`, waitMs: 12_000 },
      async (status) => {
        if (!status.held) {
          throw new Error(`${options.label} settings are busy in another process`);
        }
        if (options.filePath() !== file || options.scopeKey?.() !== scopeKey) {
          throw new Error(
            `${options.label} settings scope changed while waiting for the write lock`,
          );
        }
        invalidate();
        return reset();
      },
    );
  }

  return {
    read: () => readState().value,
    readState,
    writePatch,
    writePatchAtomic,
    updateAtomic,
    reset,
    resetAtomic,
    invalidateIfChanged,
  };

  function invalidate(): void {
    cached = null;
    cachedFileMtimeMs = null;
    cachedResolvedPath = null;
  }

  function invalidateIfPathChanged(): void {
    const currentPath = options.filePath();
    if (cachedResolvedPath === null || cachedResolvedPath === currentPath) return;
    cached = null;
    cachedFileMtimeMs = null;
    cachedResolvedPath = currentPath;
  }

  function readWritableState(): OverrideSettingsState<T> {
    const state = readState();
    if (cached?.readStatus === 'unreadable') {
      throw new Error(`${options.label} settings file is unreadable; refusing to overwrite it`);
    }
    return state;
  }
}

function pathDirname(filePath: string): string {
  const slash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return slash < 0 ? '.' : filePath.slice(0, slash);
}

function toPublicState<T>(state: CachedState<T>): OverrideSettingsState<T> {
  return {
    value: state.value,
    isCustomized: state.isCustomized,
    defaults: state.defaults,
    customizedKeys: state.customizedKeys,
  };
}

function clone<T>(value: T): T {
  if (Array.isArray(value) || (value && typeof value === 'object')) {
    return JSON.parse(JSON.stringify(value)) as T;
  }
  return value;
}

function isEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortObjectKeys(value));
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortObjectKeys);
  }
  if (isLoggableObject(value)) {
    return Object.keys(value)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortObjectKeys(value[key]);
        return acc;
      }, {});
  }
  return value;
}

function isLoggableObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
