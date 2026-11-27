/** Codex-bound hooks use the same compatibility plan for detection and writing.
 * The reverse import retains its event-level merge and no-overwrite script copies.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { planCodexHooks } from '../codexHookPlan.js';
import { replaceFile } from '../../utils/replaceFile.js';
import { readBoundedFileNoFollow } from '../../utils/readBoundedFile.js';

import type { MigrationItem, MigrationStepStatus } from '../types.js';
import {
  appendHookEvents, extractCodexEvents, isPlainObject, missingHookEvents,
  readCodexTomlHooks, readHookJson, unwrapNestedClaudeHooks,
} from '../hookConfig.js';

export interface ConvertOutcome {
  status: MigrationStepStatus;
  detail?: string;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** 复制 srcDir 下所有文件到 dstDir（不递归子目录的子目录是 OK 的：hooks 默认平铺）。已存在文件跳过。 */
async function copyHookScripts(srcDir: string, dstDir: string): Promise<{ copied: number; skipped: number }> {
  let copied = 0;
  let skipped = 0;
  if (!(await exists(srcDir))) return { copied, skipped };
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  if (!entries.some((entry) => entry.isFile())) return { copied, skipped };
  await fs.mkdir(dstDir, { recursive: true });
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const srcPath = path.join(srcDir, ent.name);
    const dstPath = path.join(dstDir, ent.name);
    if (await exists(dstPath)) {
      skipped += 1;
      continue;
    }
    try {
      await fs.copyFile(srcPath, dstPath, fs.constants.COPYFILE_EXCL);
      copied += 1;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e && e.code === 'EEXIST') {
        skipped += 1;
        continue;
      }
      throw err;
    }
  }
  return { copied, skipped };
}

/** A sibling hard link publishes complete bytes and fails if the user already owns the name. */
async function publishNewFile(staged: string, file: string): Promise<boolean> {
  try {
    try {
      await fs.link(staged, file);
    } catch (error) {
      if (!['ENOTSUP', 'EPERM', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await fs.copyFile(staged, file, fs.constants.COPYFILE_EXCL);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

async function convertToCodex(item: MigrationItem): Promise<ConvertOutcome> {
  const wd = path.dirname(path.dirname(path.resolve(item.source)));
  const target = path.join(wd, '.codex', 'hooks.json');
  if (target !== path.resolve(item.target) || path.join(wd, '.claude', 'hooks') !== path.resolve(item.source)) {
    return { status: 'failed', detail: '项目脚本路径不匹配' };
  }
  const plan = await planCodexHooks(wd);
  if (!plan || (item.id !== 'hooks:0' && item.id !== plan.id)) return { status: 'skipped' };

  for (const script of plan.scripts.values()) {
    if (!script.missing) continue;
    const dir = path.join(wd, '.codex', 'hooks');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, script.name);
    const staged = path.join(dir, randomUUID() + '.tmp');
    try {
      await fs.writeFile(staged, script.bytes, { flag: 'wx', mode: script.mode });
      if (!await publishNewFile(staged, file)) {
        const copy = await readBoundedFileNoFollow(file, script.bytes.length, { nonBlocking: true });
        if (!copy?.equals(script.bytes)) return { status: 'skipped' };
      }
    } finally {
      await fs.rm(staged, { force: true });
    }
  }
  if (!isDeepStrictEqual(plan.previous, plan.next)) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const staged = target + '.' + randomUUID() + '.tmp';
    try {
      await fs.writeFile(staged, JSON.stringify(plan.next, null, 2) + '\n', {
        flag: 'wx', mode: plan.targetMode === undefined ? 0o600 : plan.targetMode & 0o777,
      });
      if (plan.targetMode === undefined) {
        if (!await publishNewFile(staged, target)) return { status: 'skipped' };
      } else {
        if (!(await fs.lstat(target)).isFile() || !isDeepStrictEqual(plan.previous, await readHookJson(target))) {
          return { status: 'skipped' };
        }
        await replaceFile(staged, target);
      }
    } finally {
      await fs.rm(staged, { force: true });
    }
  }
  return { status: 'success' };
}

/** to-claude: 读 Codex JSON / TOML hooks + 复制脚本 → merge 进 settings.json hooks 段 */
async function convertToClaude(item: MigrationItem): Promise<ConvertOutcome> {
  const codexHooksJson = item.source; // <wd>/.codex/hooks.json
  const codexHooksDir = path.join(path.dirname(codexHooksJson), 'hooks');
  const claudeSettingsPath = item.target; // <wd>/.claude/settings.json
  const claudeHooksDir = path.join(path.dirname(claudeSettingsPath), 'hooks');

  // 先解析 codex hooks.json
  let codexHooks: Record<string, unknown> = {};
  try {
    const parsed = await readHookJson(codexHooksJson);
    if (isPlainObject(parsed)) codexHooks = extractCodexEvents(parsed);
  } catch (err) {
    return { status: 'failed', detail: `hooks.json 解析失败: ${err instanceof Error ? err.message : String(err)}` };
  }

  const tomlEvents = await readCodexTomlHooks(path.dirname(codexHooksJson));
  codexHooks = appendHookEvents(codexHooks, missingHookEvents(tomlEvents, [codexHooks]));

  // merge 到 settings.json hooks 段
  let settings: Record<string, unknown> = {};
  const hadSettings = await exists(claudeSettingsPath);
  if (hadSettings) {
    const parsed = await readHookJson(claudeSettingsPath);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      settings = parsed as Record<string, unknown>;
    }
  }
  // 存量错误嵌套 settings.hooks.hooks 一并拍平修复
  const rawHooks = isPlainObject(settings.hooks) ? settings.hooks : {};
  const existingHooks = unwrapNestedClaudeHooks(rawHooks);
  const repaired = existingHooks !== rawHooks;

  // 配置解析成功后才复制脚本，语法错误不能留下部分写入
  let scriptResult = { copied: 0, skipped: 0 };
  try {
    scriptResult = await copyHookScripts(codexHooksDir, claudeHooksDir);
  } catch (err) {
    return { status: 'failed', detail: `脚本复制失败: ${err instanceof Error ? err.message : String(err)}` };
  }

  const additions = missingHookEvents(codexHooks, [existingHooks], 'to-claude');
  const added = Object.keys(additions).length;
  const skipped = Object.keys(codexHooks).length - added;
  if (added === 0 && scriptResult.copied === 0 && !repaired) {
    return { status: 'skipped', detail: '所有 hook 已存在' };
  }

  if (added > 0 || repaired) {
    settings.hooks = appendHookEvents(existingHooks, additions);
    await fs.mkdir(path.dirname(claudeSettingsPath), { recursive: true });
    await fs.writeFile(claudeSettingsPath, JSON.stringify(settings, null, 2), 'utf8');
  }

  const parts: string[] = [];
  if (scriptResult.copied > 0) parts.push(`脚本 ${scriptResult.copied}`);
  if (added > 0) parts.push(`索引 ${added}`);
  if (skipped > 0) parts.push(`跳过 ${skipped}`);
  if (repaired) parts.push('修复嵌套 hooks.hooks');
  return { status: 'success', detail: parts.join(', ') };
}

export async function convertHooks(item: MigrationItem): Promise<ConvertOutcome> {
  try {
    return await (item.direction === 'to-codex' ? convertToCodex(item) : convertToClaude(item));
  } catch (err) {
    return { status: 'failed', detail: err instanceof Error ? err.message : String(err) };
  }
}
