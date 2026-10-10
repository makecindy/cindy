#!/usr/bin/env node
/**
 * Resolve the known design-inventory merge conflict without changing the
 * inventory generator or its governance contract.
 *
 * The command only handles an active merge where the configured main ref is
 * exactly the commit recorded in MERGE_HEAD and the inventory is the only
 * unresolved path. It writes the main-side document into the worktree,
 * delegates regeneration and validation to the existing pnpm commands, then
 * stages the resolved file.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  extractHumanSurfaceIds,
  GENERATED_BEGIN,
  GENERATED_END,
  INVENTORY_REL_PATH,
  renderDefaultHumanRow,
} from './shared/design-inventory.mjs';

export const DEFAULT_MAIN_REF = 'origin/main';

function git(cwd, args, options = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', ...options });
}

function gitText(cwd, args) {
  return git(cwd, args).trim();
}

function unresolvedPaths(cwd) {
  const output = git(cwd, ['diff', '--name-only', '-z', '--diff-filter=U'], { encoding: 'buffer' });
  return output.toString('utf8').split('\0').filter(Boolean);
}

function splitProtectedSections(document) {
  const begin = document.indexOf(GENERATED_BEGIN);
  const end = document.indexOf(GENERATED_END);
  if (
    begin < 0 || end < 0 || end < begin ||
    document.lastIndexOf(GENERATED_BEGIN) !== begin ||
    document.lastIndexOf(GENERATED_END) !== end
  ) {
    throw new Error('设计台账缺少有效的 GENERATED 区块标记');
  }
  const generatedEnd = end + GENERATED_END.length;
  return {
    prefix: document.slice(0, begin),
    suffix: document.slice(generatedEnd),
  };
}

function commandForPnpm() {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

export function inventorySubprocessEnv(source = process.env) {
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => key.toUpperCase() !== 'CINDY_INVENTORY_DOC'),
  );
}

function runPnpm(cwd, command) {
  execFileSync(commandForPnpm(), [command], {
    cwd,
    stdio: 'inherit',
    env: inventorySubprocessEnv(),
  });
}

function formatPaths(paths) {
  return paths.map(file => `  - ${file}`).join('\n');
}

const HUMAN_ROW_RE = /^\| `([^`]+)` \|/;

function assertProtectedSectionsPreserved(before, after) {
  if (before.prefix !== after.prefix) {
    throw new Error(
      '[design-inventory] 生成器改写了人工维护区或文件前缀，已停止并保留失败现场。',
    );
  }

  const existingIds = new Set(extractHumanSurfaceIds(before.suffix));
  const addedIds = new Set(
    extractHumanSurfaceIds(after.suffix).filter((id) => !existingIds.has(id)),
  );
  const seenAddedIds = new Set();
  const suffixWithoutAllowedRows = [];
  for (const chunk of after.suffix.match(/[^\n]*(?:\n|$)/g) ?? []) {
    if (!chunk) continue;
    const line = chunk.endsWith('\n') ? chunk.slice(0, -1) : chunk;
    const id = HUMAN_ROW_RE.exec(line)?.[1];
    if (!id || !addedIds.has(id)) {
      suffixWithoutAllowedRows.push(chunk);
      continue;
    }
    if (seenAddedIds.has(id) || line !== renderDefaultHumanRow(id)) {
      throw new Error(
        '[design-inventory] 生成器新增了非标准默认人工行，已停止并保留失败现场。',
      );
    }
    seenAddedIds.add(id);
  }

  if (
    seenAddedIds.size !== addedIds.size ||
    suffixWithoutAllowedRows.join('') !== before.suffix
  ) {
    throw new Error(
      '[design-inventory] 生成器改写了人工维护区中的已有内容，已停止并保留失败现场。',
    );
  }
  return [...addedIds];
}

const CLI_USAGE = '用法：pnpm resolve:design-inventory-conflict -- --main-ref <main-ref>';

export function parseCliArgs(args) {
  if (args.length === 0) return { mainRef: DEFAULT_MAIN_REF };
  if (
    args.length !== 2 ||
    args[0] !== '--main-ref' ||
    !args[1] ||
    args[1].startsWith('--')
  ) {
    throw new Error(CLI_USAGE);
  }
  return { mainRef: args[1] };
}

/**
 * Resolve the conflict. `runInventory` is injectable so tests can use a
 * temporary Git repository without running the repository-wide generator.
 */
export function resolveDesignInventoryConflict({
  cwd = process.cwd(),
  mainRef = DEFAULT_MAIN_REF,
  runInventory = runPnpm,
  log = console.log,
} = {}) {
  const repoRoot = gitText(cwd, ['rev-parse', '--show-toplevel']);
  const mergeHeadPathRaw = gitText(cwd, ['rev-parse', '--git-path', 'MERGE_HEAD']);
  const mergeHeadPath = path.isAbsolute(mergeHeadPathRaw)
    ? mergeHeadPathRaw
    : path.join(repoRoot, mergeHeadPathRaw);
  const mergeHead = fs.existsSync(mergeHeadPath)
    ? fs.readFileSync(mergeHeadPath, 'utf8').trim().split(/\s+/)[0]
    : '';

  if (!mergeHead) {
    log('[design-inventory] 当前没有进行中的 merge，无需处理。');
    return { status: 'noop', reason: 'no-merge' };
  }

  const unresolved = unresolvedPaths(repoRoot);
  if (unresolved.length === 0) {
    log('[design-inventory] 当前 merge 没有未解决文件，无需处理。');
    return { status: 'noop', reason: 'no-unresolved-paths' };
  }

  const target = INVENTORY_REL_PATH;
  const otherUnresolved = unresolved.filter(file => file !== target);
  if (otherUnresolved.length > 0) {
    throw new Error(
      '[design-inventory] 拒绝继续：存在其他未解决文件。请先处理这些文件：\n' +
      formatPaths(otherUnresolved),
    );
  }
  if (!unresolved.includes(target)) {
    throw new Error(
      `[design-inventory] 拒绝继续：当前未解决文件中没有 ${target}。`,
    );
  }

  let mainCommit;
  try {
    mainCommit = gitText(repoRoot, ['rev-parse', '--verify', `${mainRef}^{commit}`]);
  } catch {
    throw new Error(`[design-inventory] 无法解析 main ref：${mainRef}`);
  }
  if (mainCommit !== mergeHead) {
    throw new Error(
      `[design-inventory] 拒绝继续：MERGE_HEAD (${mergeHead}) 与 main ref ${mainRef} (${mainCommit}) 不一致。\n` +
      '请使用发起当前 merge 时的同一个 main ref，避免把另一份主干内容写入冲突文件。',
    );
  }

  let mainDocument;
  try {
    mainDocument = git(repoRoot, ['show', `${mainCommit}:${target}`]);
  } catch {
    throw new Error(`[design-inventory] main ref 中不存在目标文件：${target}`);
  }
  const protectedBefore = splitProtectedSections(mainDocument);
  const targetPath = path.join(repoRoot, ...target.split('/'));

  // Leave the index unmerged until generation and validation have succeeded.
  // A failed run therefore preserves the conflict for manual recovery.
  fs.writeFileSync(targetPath, mainDocument, 'utf8');
  runInventory(repoRoot, 'design:inventory');
  const protectedAfter = splitProtectedSections(fs.readFileSync(targetPath, 'utf8'));
  const addedHumanIds = assertProtectedSectionsPreserved(protectedBefore, protectedAfter);
  runInventory(repoRoot, 'check:design-inventory');
  git(repoRoot, ['add', '--', target]);
  const remaining = unresolvedPaths(repoRoot);
  if (remaining.length > 0) {
    throw new Error(
      '[design-inventory] 校验后仍存在未解决文件：\n' + formatPaths(remaining),
    );
  }
  const diff = git(repoRoot, ['diff', '--cached', '--', target]);
  log(
    `[design-inventory] 已解决 ${target}，已有人工内容保持不变` +
    (addedHumanIds.length > 0 ? `，新增 ${addedHumanIds.length} 条标准默认行。` : '。'),
  );
  log('[design-inventory] 暂存 diff：');
  log(diff || '(无暂存 diff)');
  return { status: 'resolved', target, diff };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { mainRef } = parseCliArgs(process.argv.slice(2));
    resolveDesignInventoryConflict({ mainRef });
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
