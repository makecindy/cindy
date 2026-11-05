/** Hooks 的格式兼容、路径转换与增量判据；检测和转换必须共用，避免反复提示或漏掉新增内容。 */
import fs from 'node:fs/promises';
import path from 'node:path';
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

/**
 * 保留转换器原有的事件级“不覆盖”契约：JSON / TOML 任一来源已有同名事件即跳过。
 * 不比较或合并事件内部的 matcher / handler，避免重复安装语义等价的命令。
 */
export function missingHookEvents(
  source: Record<string, unknown>,
  targets: Record<string, unknown>[],
  direction?: MigrationDirection,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(source)
      .filter(([event]) => !targets.some((target) => Object.hasOwn(target, event)))
      .map(([event, entry]) => [event, direction ? rewriteHookEntry(entry, direction) : entry]),
  );
}

/** 只添加缺失事件，已有事件整体保留，包括用户的 matcher 与 handler 数组。 */
export function appendHookEvents(
  target: Record<string, unknown>,
  additions: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const [event, value] of Object.entries(additions)) {
    if (!Object.hasOwn(result, event)) result[event] = value;
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
