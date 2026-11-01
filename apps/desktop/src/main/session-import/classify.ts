/**
 * 扫描候选的归类：哪些默认隐藏、怎么分组、原文件夹是否还在。
 *
 * - Cindy 自己运行过的任务：Cindy 的 Claude Code 任务写在用户的 ~/.claude 下（Cindy
 *   不改 Claude Code 的配置目录），所以其它 Cindy 版本、伙伴、测试脚本跑出来的任务
 *   都会被扫出来。工作目录在任何 Cindy 数据目录下的，默认隐藏。
 * - 临时文件夹里的任务：多为自动化脚本，默认隐藏。
 * - Codex 应用给每段对话建的 `~/Documents/Codex/<日期>/<名字>` 归入「对话」，
 *   不当成几十个只有 1 个任务的项目。
 * - Git worktree 里的任务归到它所属的主仓库。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizeWorkingDirForGrouping } from '../../shared/workingDir.js';
import type { HiddenCategory } from './types.js';

export interface ClassifyEnv {
  homeDir: string;
  /** 平台应用数据根（macOS: ~/Library/Application Support）。 */
  appDataDir: string | null;
  /** Cindy 管理的对话工作目录根。 */
  dialogueRoots: string[];
  tempRoots: string[];
  platform: NodeJS.Platform;
  exists: (p: string) => boolean;
  readFile: (p: string) => string | null;
}

export function defaultClassifyEnv(params: { appDataDir: string | null; dialogueRoots: string[] }): ClassifyEnv {
  const tmp = safeRealpath(os.tmpdir());
  const tempRoots = [os.tmpdir(), tmp, '/tmp', '/private/tmp', '/var/folders', '/private/var/folders']
    .filter((v): v is string => !!v);
  return {
    homeDir: os.homedir(),
    appDataDir: params.appDataDir,
    dialogueRoots: params.dialogueRoots,
    tempRoots: [...new Set(tempRoots)],
    platform: process.platform,
    exists: (p) => {
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
    readFile: (p) => {
      try {
        return fs.readFileSync(p, 'utf-8');
      } catch {
        return null;
      }
    },
  };
}

function safeRealpath(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function key(p: string, platform: NodeJS.Platform): string {
  const n = normalizeWorkingDirForGrouping(p) ?? p;
  return platform === 'win32' || platform === 'darwin' ? n.toLowerCase() : n;
}

function isInside(child: string, parent: string, platform: NodeJS.Platform): boolean {
  const c = key(child, platform);
  const p = key(parent, platform).replace(/\/+$/, '');
  return c === p || c.startsWith(`${p}/`);
}

/** 工作目录在任何 Cindy 数据目录（正式版、测试版、隔离档案）下。 */
export function isCindyAppDataPath(cwd: string, env: ClassifyEnv): boolean {
  if (env.dialogueRoots.some((root) => isInside(cwd, root, env.platform))) return true;
  if (!env.appDataDir) return false;
  if (!isInside(cwd, env.appDataDir, env.platform)) return false;
  const rel = key(cwd, env.platform).slice(key(env.appDataDir, env.platform).replace(/\/+$/, '').length + 1);
  const top = rel.split('/')[0] ?? '';
  return top.startsWith('cindy') || top.startsWith('xdt');
}

export function isTempPath(cwd: string, env: ClassifyEnv): boolean {
  return env.tempRoots.some((root) => isInside(cwd, root, env.platform));
}

export function hiddenCategoryFor(cwd: string | null, env: ClassifyEnv): HiddenCategory | null {
  if (!cwd) return null;
  if (isCindyAppDataPath(cwd, env)) return 'cindy';
  if (isTempPath(cwd, env)) return 'temp';
  return null;
}

/** Codex 应用为每段对话建的日期文件夹：~/Documents/Codex/YYYY-MM-DD/<名字>。 */
export function isCodexDatedChatDir(cwd: string, env: ClassifyEnv): boolean {
  const root = path.join(env.homeDir, 'Documents', 'Codex');
  if (!isInside(cwd, root, env.platform)) return false;
  const rel = key(cwd, env.platform).slice(key(root, env.platform).length + 1);
  return /^\d{4}-\d{2}-\d{2}(\/|$)/.test(rel);
}

/**
 * Git worktree 归到主仓库：`.git` 是文件且指向 `<主仓库>/.git/worktrees/<名字>` 时，
 * 返回主仓库根。目录不存在或不是 worktree 时返回 null。按目录缓存。
 */
export function createWorktreeResolver(env: ClassifyEnv): (cwd: string) => string | null {
  const cache = new Map<string, string | null>();
  return (cwd: string) => {
    const k = key(cwd, env.platform);
    if (cache.has(k)) return cache.get(k) ?? null;
    let found: string | null = null;
    let dir = cwd;
    for (let i = 0; i < 12; i += 1) {
      const gitFile = env.readFile(path.join(dir, '.git'));
      if (gitFile !== null) {
        const m = gitFile.match(/^gitdir:\s*(.+)$/m);
        const gitdir = m?.[1]?.trim();
        if (gitdir) {
          const abs = path.isAbsolute(gitdir) ? gitdir : path.resolve(dir, gitdir);
          const wt = abs.replace(/\\/g, '/').match(/^(.*)\/\.git\/worktrees\/[^/]+\/?$/);
          if (wt?.[1]) found = wt[1];
        }
        break;
      }
      if (env.exists(path.join(dir, '.git'))) break;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    cache.set(k, found);
    return found;
  };
}

/** 显示用路径：家目录缩写成 ~。 */
export function displayPath(p: string, homeDir: string): string {
  const n = (normalizeWorkingDirForGrouping(p) ?? p).replace(/\\/g, '/');
  const h = (normalizeWorkingDirForGrouping(homeDir) ?? homeDir).replace(/\\/g, '/').replace(/\/+$/, '');
  if (n === h) return '~';
  if (n.startsWith(`${h}/`)) return `~${n.slice(h.length)}`;
  return n;
}

export interface GroupInfo {
  groupKey: string;
  groupName: string;
  groupPath: string | null;
  dialogue: boolean;
}

export function groupFor(
  cwd: string | null,
  sourceDialogue: boolean,
  env: ClassifyEnv,
  resolveWorktree: (cwd: string) => string | null,
): GroupInfo {
  if (!cwd || sourceDialogue || isCodexDatedChatDir(cwd, env)) {
    return { groupKey: 'dialogue', groupName: '', groupPath: null, dialogue: true };
  }
  const root = resolveWorktree(cwd) ?? cwd;
  const normalized = normalizeWorkingDirForGrouping(root) ?? root;
  const shown = displayPath(normalized, env.homeDir);
  return {
    groupKey: key(normalized, env.platform),
    groupName: shown === '~' ? '~' : path.basename(normalized.replace(/\\/g, '/')),
    groupPath: shown,
    dialogue: false,
  };
}
