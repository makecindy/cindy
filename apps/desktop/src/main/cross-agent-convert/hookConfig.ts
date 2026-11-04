/** Hooks 的格式兼容、路径转换与增量判据；检测和转换必须共用，避免反复提示或漏掉新增内容。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseToml } from 'smol-toml';

import type { MigrationDirection } from './types.js';

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 兼容旧平铺 JSON，但顶层 description 是元数据，不能转换成事件。 */
export function extractCodexEvents(root: Record<string, unknown>): Record<string, unknown> {
  if (isPlainObject(root.hooks)) return root.hooks;
  return Object.fromEntries(
    Object.entries(root).filter(([key]) => key !== 'hooks' && key !== 'description'),
  );
}

/** 保留 #7169 对存量 settings.hooks.hooks 的修复；已有外层事件优先。 */
export function unwrapNestedClaudeHooks(hooks: Record<string, unknown>): Record<string, unknown> {
  if (!isPlainObject(hooks.hooks)) return hooks;
  const { hooks: nested, ...events } = hooks;
  return { ...nested, ...events };
}

export async function readHookJson(file: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed: unknown = raw.trim() ? JSON.parse(raw) : {};
    if (!isPlainObject(parsed)) throw new Error(`Invalid hooks object: ${path.basename(file)}`);
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

/** TOML 只读：转换不重写用户的原生配置、注释或其它设置。语法错误交给调用方处理。 */
export async function readCodexTomlHooks(codexDir: string): Promise<Record<string, unknown>> {
  try {
    const parsed = parseToml(await fs.readFile(path.join(codexDir, 'config.toml'), 'utf8'));
    if (!isPlainObject(parsed.hooks)) return {};
    return Object.fromEntries(
      Object.entries(parsed.hooks).filter(
        ([, groups]) =>
          Array.isArray(groups) &&
          groups.every((group) => isPlainObject(group) && Array.isArray(group.hooks)),
      ),
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

function rewriteHookEntry(entry: unknown, direction: MigrationDirection): unknown {
  if (typeof entry === 'string') {
    return direction === 'to-codex'
      ? entry.replace(/\.claude\/hooks\//g, '.codex/hooks/')
      : entry.replace(/\.codex\/hooks\//g, '.claude/hooks/');
  }
  if (Array.isArray(entry)) return entry.map((value) => rewriteHookEntry(value, direction));
  if (isPlainObject(entry)) {
    return Object.fromEntries(
      Object.entries(entry).map(([key, value]) => [key, rewriteHookEntry(value, direction)]),
    );
  }
  return entry;
}

/** Codex TOML 接受 command_windows / commandWindows 两种拼写，比较时按同一字段处理。 */
function comparableHandler(handler: unknown): unknown {
  if (!isPlainObject(handler) || !Object.hasOwn(handler, 'command_windows')) return handler;
  const { command_windows, ...rest } = handler;
  return { ...rest, commandWindows: rest.commandWindows ?? command_windows };
}

/**
 * 只返回目标各来源中尚未覆盖的内容。同一 matcher 下逐 handler 去重，
 * 新 handler 作为独立 matcher group 追加，保留已有组的值与顺序。
 * 非数组的存量事件保持旧版“不覆盖”策略，不能提示一次永远无法完成的转换。
 */
export function missingHookEvents(
  source: Record<string, unknown>,
  targets: Record<string, unknown>[],
  direction?: MigrationDirection,
): Record<string, unknown> {
  const missing: Record<string, unknown> = {};
  for (const [event, raw] of Object.entries(source)) {
    const entry = direction ? rewriteHookEntry(raw, direction) : raw;
    const existing = targets
      .filter((target) => Object.hasOwn(target, event))
      .map((target) => target[event]);
    if (existing.length === 0) {
      missing[event] = entry;
      continue;
    }
    if (!Array.isArray(entry) || existing.some((value) => !Array.isArray(value))) continue;
    const groups = existing.flat();
    const additions: unknown[] = [];
    for (const group of entry) {
      if (groups.some((candidate) => isDeepStrictEqual(candidate, group))) continue;
      if (!isPlainObject(group) || !Array.isArray(group.hooks)) {
        additions.push(group);
        continue;
      }
      const { hooks, ...options } = group;
      const matches = groups.filter((candidate) => {
        if (!isPlainObject(candidate) || !Array.isArray(candidate.hooks)) return false;
        const candidateOptions = Object.fromEntries(
          Object.entries(candidate).filter(([key]) => key !== 'hooks'),
        );
        return isDeepStrictEqual(options, candidateOptions);
      });
      const covered = matches.flatMap((candidate) => (candidate as { hooks: unknown[] }).hooks);
      const handlers = hooks.filter(
        (handler) =>
          !covered.some((candidate) =>
            isDeepStrictEqual(comparableHandler(candidate), comparableHandler(handler)),
          ),
      );
      if (handlers.length > 0 || (hooks.length === 0 && matches.length === 0)) {
        additions.push({ ...options, hooks: handlers });
      }
    }
    if (additions.length > 0) missing[event] = additions;
  }
  return missing;
}

/** 追加已由 missingHookEvents 筛出的增量，不替换现有事件或 handler。 */
export function appendHookEvents(
  target: Record<string, unknown>,
  additions: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const [event, value] of Object.entries(additions)) {
    const previous = result[event];
    result[event] =
      Array.isArray(previous) && Array.isArray(value) ? [...previous, ...value] : value;
  }
  return result;
}

/** 和复制器保持一致：只检查平铺普通文件；空目录、子目录与已有同名目标都没有复制增量。 */
export async function hasMissingHookScripts(source: string, target: string): Promise<boolean> {
  let entries;
  try {
    entries = await fs.readdir(source, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    try {
      await fs.access(path.join(target, entry.name));
    } catch {
      return true;
    }
  }
  return false;
}
