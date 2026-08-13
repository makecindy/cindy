/**
 * apply.ts —— 用户确认后把蒸馏提案从 staging 落盘到 ~/.agents/skills/<name>/。
 *
 * 流程对齐 skillhub/installService 的 final-switch 语义:
 *   1. 目标已存在 → 先 rename 挪去备份(可回滚),再切入新目录
 *   2. registry.addInstall(origin='learned' + provenance)失败 → 回滚文件
 *   3. best-effort 建 Claude 侧 symlink + 刷新共享 skill links
 * 被覆盖的旧版本移入 {ownerRoot}/learn/backups/ 持久保留(误覆盖可手动找回)。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { ownerScopedUserDataPath } from '../appSessionState';
import { createLogger, maskPath } from '../logger';
import { getCurrentDataOwnerId, getCurrentUserId } from '../authManager';
import {
  assertGhostSkillProjectionBoundaryStableForOwner,
  withSharedGlobalSkillProjectionMutation,
} from '../authBoundaryQuarantine.js';
import { registryService } from '../skillhub/registry';
import { computeFolderHash } from '../skillhub/folderHash';
import { ensureSymlinkToShared } from '../skillhub/installService';
import { prepareSharedGlobalSkillLinks } from '../maker-host/shared-global-skills.js';
import { stripUnreviewedEntries } from './staging';
import type { LearnProvenance } from '../../shared/learnTypes';

const log = createLogger('learn-host:apply');

const rand = (): string => crypto.randomBytes(4).toString('hex');

function globalSkillsDir(): string {
  return path.join(os.homedir(), '.agents', 'skills');
}

function learnBackupsRoot(): string {
  return ownerScopedUserDataPath('learn', 'backups');
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.promises.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * rename 优先;跨设备(EXDEV,staging 在 userData、目标在 home 可能不同卷)退化
 * 为 cp+rm。**自含原子性**:任一步失败都先清掉刚复制的 dst 恢复原状再抛 ——
 * 调用方只需面对「要么移成了、要么什么都没变」两种状态。此前"rm(src) 失败但
 * dst 保留"的容忍分支给 rollback 埋雷:src 未删时后续 fatal 步骤(registry
 * 写入等)触发回滚,finalDir 移不回已存在的 proposalDir,replaceDir 也无法
 * 复位,留下未注册安装(Codex review,#484 合并后 follow-up)。
 *
 * `preserveDstOnSrcRemovalFailure` 是**回滚/备份还原专用**的相反取舍:cp 已
 * 完整成功、只剩 rm(src) 失败(Windows 文件锁)时,dst 就是完好的还原副本,
 * 按默认语义清掉它等于亲手销毁提案/备份 —— 此模式改为保留 dst、把 src 当
 * 残渣 warn 后视为移动成功(Codex review on #585)。正向安装绝不能用:它会
 * 重新引入"dst 完整但 src 未删"的中间态,正是上一段修掉的雷。
 */
async function moveDir(
  src: string,
  dst: string,
  opts?: { preserveDstOnSrcRemovalFailure?: boolean },
): Promise<void> {
  try {
    await fs.promises.rename(src, dst);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
  }
  try {
    await fs.promises.cp(src, dst, { recursive: true });
  } catch (cpErr) {
    // cp 半途失败留部分 dst —— 清掉复原,把失败如实抛给调用方(可重试)。
    await fs.promises.rm(dst, { recursive: true, force: true }).catch(() => undefined);
    throw cpErr;
  }
  try {
    await fs.promises.rm(src, { recursive: true, force: true });
  } catch (rmErr) {
    if (opts?.preserveDstOnSrcRemovalFailure) {
      log.warn(`moveDir: src removal failed after full copy, keeping dst; residue at ${maskPath(src)}:`, rmErr);
      return;
    }
    await fs.promises.rm(dst, { recursive: true, force: true }).catch(() => undefined);
    throw rmErr;
  }
}

export interface ApplyProposalParams {
  /** staging 里的提案 skill 目录(已按 frontmatter name 重命名)。 */
  proposalDir: string;
  skillName: string;
  provenance: LearnProvenance;
}

export interface ApplyProposalResult {
  name: string;
  absolutePath: string;
  /** 覆盖了已有目录时,旧版本的持久备份路径。 */
  replacedBackupPath?: string;
}

/**
 * 落盘提案。抛错即失败(调用方保持 run 在 awaiting-review,可重试或放弃);
 * 文件切换与 registry 写入之间保证要么都成功、要么回滚到调用前状态。
 */
export async function applyProposal(params: ApplyProposalParams): Promise<ApplyProposalResult> {
  const { proposalDir, skillName, provenance } = params;
  const finalDir = path.join(globalSkillsDir(), skillName);
  const claudeLink = path.join(os.homedir(), '.claude', 'skills', skillName);
  const codexLink = path.join(os.homedir(), '.codex', 'skills', skillName);
  await fs.promises.mkdir(globalSkillsDir(), { recursive: true });

  // ── final switch(带回滚) ────────────────────────────────────────────────
  let replaceDir: string | null = null;
  let claudeRealDirBackup: string | null = null;
  let codexRealDirBackup: string | null = null;
  let finalDirCreated = false;
  const rollback = async (): Promise<void> => {
    if (finalDirCreated) {
      // 把新目录移回 staging 原位,保住提案(用户还能重试 apply)。还原方向
      // 保 dst 优先:EXDEV 回拷成功后 rm(finalDir) 被锁挡住时,绝不能把刚
      // 复制回来的提案再删掉(否则提案丢失且不可重试)。
      await moveDir(finalDir, proposalDir, { preserveDstOnSrcRemovalFailure: true }).catch((err) => {
        log.error('rollback: move finalDir back to staging failed:', err);
      });
      finalDirCreated = false;
    }
    if (replaceDir) {
      await fs.promises.rename(replaceDir, finalDir).catch((err) => {
        log.error('rollback: restore replaced dir failed:', err);
      });
      replaceDir = null;
    }
    if (claudeRealDirBackup) {
      await fs.promises.rm(claudeLink, { recursive: true, force: true }).catch((err) => {
        log.error('rollback: remove claude symlink failed:', err);
      });
      // 同上,还原方向保 dst:备份区残留一份副本无害,还原出的目录不能被清。
      await moveDir(claudeRealDirBackup, claudeLink, { preserveDstOnSrcRemovalFailure: true }).catch((err) => {
        log.error('rollback: restore claude real dir failed:', err);
      });
      claudeRealDirBackup = null;
    }
    if (codexRealDirBackup) {
      await fs.promises.rm(codexLink, { recursive: true, force: true }).catch((err) => {
        log.error('rollback: remove codex symlink failed:', err);
      });
      await moveDir(codexRealDirBackup, codexLink).catch((err) => {
        log.error('rollback: restore codex real dir failed:', err);
      });
      codexRealDirBackup = null;
    }
  };

  // 被改进的原 skill 可能本体就住在 ~/.claude/skills/<name>(共享链接流程只是
  // 把它 symlink 进 ~/.agents):必须在最终落盘前先把真实目录挪去持久备份。
  // 这一步失败要 fatal,否则 Apply 会显示成功但 Claude 仍加载旧版(Codex review)。
  const claudeSt = await fs.promises.lstat(claudeLink).catch(() => null);
  if (claudeSt && !claudeSt.isSymbolicLink() && claudeSt.isDirectory()) {
    claudeRealDirBackup = path.join(learnBackupsRoot(), `${skillName}-claude-${Date.now()}`);
    await fs.promises.mkdir(learnBackupsRoot(), { recursive: true });
    try {
      await moveDir(claudeLink, claudeRealDirBackup);
    } catch (err) {
      // moveDir 自含原子性:失败时原目录完好、备份区无残渣。置空防 rollback
      // 误"还原"一个不存在的备份;fatal 抛出让本次 apply 失败可重试(原目录
      // 留在原地会让 symlink 静默跳过、Claude 加载旧版而 apply 报成功)。
      claudeRealDirBackup = null;
      throw err;
    }
    log.info(`moved real claude-side skill dir to backup: ${maskPath(claudeRealDirBackup)}`);
  }

  // Codex 侧同责(~/.codex/skills/<name> 是 scanner 认可的 legacy 根):真实目录
  // 留着不动的话,apply 后 .agents 新版与 Codex 旧版双副本并存,Codex 继续加载
  // 旧版(Codex review P2)。同样挪去持久备份,最终切换后落 symlink 指回新版。
  const codexSt = await fs.promises.lstat(codexLink).catch(() => null);
  if (codexSt && !codexSt.isSymbolicLink() && codexSt.isDirectory()) {
    codexRealDirBackup = path.join(learnBackupsRoot(), `${skillName}-codex-${Date.now()}`);
    await fs.promises.mkdir(learnBackupsRoot(), { recursive: true });
    try {
      await moveDir(codexLink, codexRealDirBackup);
    } catch (err) {
      codexRealDirBackup = null;
      await rollback();
      throw err;
    }
    log.info(`moved real codex-side skill dir to backup: ${maskPath(codexRealDirBackup)}`);
  }

  try {
    if (await pathExists(finalDir)) {
      replaceDir = path.join(path.dirname(finalDir), `.xdt-replacing-learn-${skillName}-${rand()}`);
      await fs.promises.rename(finalDir, replaceDir);
    }
  } catch (err) {
    await rollback();
    throw err;
  }
  try {
    // 跨设备 EXDEV 时 moveDir 会退化成 cp+rm。必须在最终移动/复制前剥除
    // 未审查路径,否则 prompt 注入的 node_modules/.env 等大目录会先被完整复制
    // 到安装位置,再删除,主进程会被无意义 IO 拖住甚至打满磁盘。
    await stripUnreviewedEntries(proposalDir);
    // moveDir 自含原子性:失败即原状(staging 完整、finalDir 未创建),下方
    // catch 的 rollback 只需复位 replaceDir/claude 备份,不存在"dst 完整但
    // src 未删"的中间态 —— 那会让后续 fatal 步骤的回滚移不回 proposalDir。
    await moveDir(proposalDir, finalDir);
    finalDirCreated = true;
    // 审查集 == 安装集(review 修正):扫描/diff 阶段被排除的路径(噪声/敏感/
    // 打包忽略/非常规条目)落盘后同样剥除,用户没在 diff 里见过的东西不进系统。
    await stripUnreviewedEntries(finalDir);
  } catch (err) {
    await rollback();
    throw err;
  }

  // folderHash 必须在剥除之后基于 finalDir 计算(Greptile 修正):剥除会删掉
  // 噪声文件,先算后剥会让 registry 哈希与最终目录不符,安装即被判 dirty。
  const folderHash = (await computeFolderHash(finalDir).catch(() => null)) ?? '';

  if (claudeRealDirBackup) {
    try {
      await ensureSymlinkToShared(claudeLink, finalDir);
    } catch (err) {
      await rollback();
      throw err;
    }
  }
  if (codexRealDirBackup) {
    try {
      await ensureSymlinkToShared(codexLink, finalDir);
    } catch (err) {
      await rollback();
      throw err;
    }
  }

  // ── registry ─────────────────────────────────────────────────────────────
  const nowSec = Math.floor(Date.now() / 1000);
  try {
    await registryService.addInstall(skillName, finalDir, {
      version: '0.1.0',
      authorId: getCurrentUserId() ?? '',
      folderHash,
      installedAt: nowSec,
      updatedAt: nowSec,
      origin: 'learned',
      provenance,
    });
  } catch (err) {
    log.error('registry.addInstall failed, rolling back files:', err);
    await rollback();
    throw err;
  }

  // ── 被覆盖的旧版本 → 持久备份 ────────────────────────────────────────────
  let replacedBackupPath: string | undefined;
  if (claudeRealDirBackup) {
    replacedBackupPath = claudeRealDirBackup;
  } else if (codexRealDirBackup) {
    replacedBackupPath = codexRealDirBackup;
  }
  if (replaceDir) {
    const dest = path.join(learnBackupsRoot(), `${skillName}-${Date.now()}`);
    try {
      await fs.promises.mkdir(learnBackupsRoot(), { recursive: true });
      await moveDir(replaceDir, dest);
      if (!replacedBackupPath) replacedBackupPath = dest;
    } catch (err) {
      // 备份失败不回滚(registry + 文件已就位),旧目录留在 .xdt-replacing- 原地。
      log.warn(`persist backup failed, replaced dir left at ${maskPath(replaceDir)}:`, err);
    }
  }

  // ── best-effort links(与 installService 同语义,失败只 warn) ─────────────
  if (!claudeRealDirBackup) {
    try {
      await ensureSymlinkToShared(claudeLink, finalDir);
    } catch (err) {
      log.warn('claude symlink failed (non-fatal):', err);
    }
  }
  try {
    const ownerId = getCurrentDataOwnerId();
    const linkResult = await withSharedGlobalSkillProjectionMutation(ownerId, () =>
      prepareSharedGlobalSkillLinks({
        assertOwnerStable: () =>
          assertGhostSkillProjectionBoundaryStableForOwner(ownerId),
      }),
    );
    for (const warning of linkResult.warnings) {
      log.warn('shared global skill link warning:', warning);
    }
  } catch (err) {
    log.warn('prepare shared global skill links failed:', err);
  }

  return { name: skillName, absolutePath: finalDir, ...(replacedBackupPath ? { replacedBackupPath } : {}) };
}

/** apply 前查目标是否已存在(diff 面板 targetExists 用)。 */
export function resolveInstalledSkillDir(skillName: string): string {
  return path.join(globalSkillsDir(), skillName);
}
