/**
 * Multibox（`git multibox`）托管 worktree 后端。
 *
 * Multibox 是 `git worktree` 的替代品：参数与 `git worktree add/remove` 相同，产物仍是
 * 普通 git worktree，但会从当前 checkout 克隆引擎缓存（Unity `Library/`、Rust `target/`
 * 等，同盘 ReFS/APFS 上用 reflink），省掉新工作区的重新导入与重新编译。
 *
 * 选择规则（创建、恢复、删除共用）：
 *   - 仓库根有 `.multibox.toml`（项目表明自己使用 Multibox，已提交或仅本地均可），且
 *   - 本机能运行 `git multibox --version`。
 * 两者都满足才走 Multibox，否则保持原生 git worktree 流程不变。按「是否启用」选，
 * 不按「是否失败」选：Multibox 报错时原样返回错误，不自动改用 `git worktree` 重试
 * （`-b` 建的分支可能已存在，重试只会制造更多错误）。
 *
 * 与原生流程的差异：
 *   - 不能带 `--no-checkout`：带上后 multibox 直接退回普通 `git worktree add`，一份缓存
 *     都不复制。因此 Multibox 一次给出完整目录，跳过 Cindy 的分段检出与后台全量 checkout。
 *   - 删除带 `--wait`：multibox 默认在后台删除，回收流程需要在返回时确认目录已消失。
 *   - 安全语义与 `git worktree remove` 一致：不带 `-f` 时拒绝删除有改动的工作区，
 *     另外编辑器打开着该工作区时也会拒绝。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { gitExec } from './gitExec';
import { createLogger } from '../logger';

const log = createLogger('WorktreeMultibox');

export const MULTIBOX_CONFIG_FILE = '.multibox.toml';

/** `git multibox --version` 探测上限；只为防止异常卡住，正常几十毫秒返回。 */
const MULTIBOX_PROBE_TIMEOUT_MS = 10_000;

/** 仓库根有 `.multibox.toml` 且本机装了 git multibox 时返回 true。 */
export async function shouldUseMultibox(baseRepo: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path.join(baseRepo, MULTIBOX_CONFIG_FILE));
    if (!stat.isFile()) return false;
  } catch {
    return false;
  }
  try {
    await gitExec(['multibox', '--version'], baseRepo, {
      timeoutMs: MULTIBOX_PROBE_TIMEOUT_MS,
      repairSafeDirectory: false,
    });
    return true;
  } catch (err) {
    log.info(
      `[multibox] ${MULTIBOX_CONFIG_FILE} found but git multibox is unavailable; using git worktree:`,
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

/**
 * `git multibox add` 参数。与 buildWorktreeAddArgs 保持同一分支边界（`--no-track`），
 * 但去掉 `--no-checkout`（见文件头）；`--json` 让结果可解析。
 */
export function buildMultiboxAddArgs(
  branch: string,
  worktreePath: string,
  sourceBranch: string,
): string[] {
  return [
    '-c',
    'core.longpaths=true',
    'multibox',
    'add',
    '--json',
    '--no-track',
    '-b',
    branch,
    worktreePath,
    sourceBranch,
  ];
}

/** 恢复时在已有分支上重建目录：`git multibox add <path> <branch>`。 */
export function buildMultiboxRestoreArgs(worktreePath: string, branch: string): string[] {
  return ['-c', 'core.longpaths=true', 'multibox', 'add', '--json', worktreePath, branch];
}

/** `git multibox remove --wait [-f] <path>`：前台删除，返回时目录已不存在。 */
export function buildMultiboxRemoveArgs(worktreePath: string, opts: { force?: boolean } = {}): string[] {
  return [
    '-c',
    'core.longpaths=true',
    'multibox',
    'remove',
    '--wait',
    ...(opts.force ? ['-f'] : []),
    worktreePath,
  ];
}

interface MultiboxAddSummary {
  method?: unknown;
  filesystem?: unknown;
  seconds?: unknown;
  tracked?: { files?: unknown };
  cached?: { files?: unknown };
  environment?: unknown;
  warnings?: unknown;
}

/**
 * 记录 `--json` 结果：克隆方式、耗时、缓存数量、需要设置的环境变量名与警告。
 * 只用于诊断，解析失败不影响创建结果。
 */
export function logMultiboxAddResult(worktreePath: string, stdout: string): void {
  const line = stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .reverse()
    .find((s) => s.startsWith('{'));
  if (!line) {
    log.info(`[multibox] add completed for ${worktreePath} (no JSON summary)`);
    return;
  }
  try {
    const summary = JSON.parse(line) as MultiboxAddSummary;
    const envKeys = summary.environment && typeof summary.environment === 'object'
      ? Object.keys(summary.environment as Record<string, unknown>)
      : [];
    log.info(`[multibox] add completed for ${worktreePath}`, {
      method: summary.method,
      filesystem: summary.filesystem,
      seconds: summary.seconds,
      trackedFiles: summary.tracked?.files,
      cachedFiles: summary.cached?.files,
      environment: envKeys,
    });
    if (Array.isArray(summary.warnings) && summary.warnings.length > 0) {
      log.warn(`[multibox] add warnings for ${worktreePath}:`, summary.warnings.slice(0, 10));
    }
  } catch {
    log.info(`[multibox] add completed for ${worktreePath} (unparseable JSON summary)`);
  }
}
