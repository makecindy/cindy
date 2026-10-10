/**
 * Validate bundled Skill metadata and reconcile owner-private projections of
 * approved snapshots. All harnesses consume agent-skills/skills; Claude builds
 * filtered per-session plugins from these sources. No new user-global links are made.
 * Legacy user-global links are removed only when their targets establish Cindy
 * ownership. Real directories and foreign links are preserved.
 * Source bytes must remain receipt-bound approved snapshots, never mutable plugin
 * install directories. Reconciliation validates the snapshot digest and metadata
 * before exposing it. Both brainRoot and approvalStateRoot are required so old
 * projections can be revoked on update, uninstall and owner changes.
 */

import { promises as fsp } from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';

import matter from 'gray-matter';

import {
  GHOST_SKILL_NAME_RE,
  isValidGhostId,
  type GhostSkillItem,
  type InstalledGhost,
} from '../../shared/ghost.js';
import { parseAndValidateFrontmatter } from '../skillhub/frontmatterValidation.js';
import { sharedGlobalSkillsPaths } from '../maker-host/shared-global-skills.js';

/** Owner-scoped plugin root; never installed into the user's shared skill directories. */
export function ghostSkillPluginRoot(approvalStateRoot: string): string {
  return path.join(approvalStateRoot, 'agent-skills');
}

/** 私有技能根里 ghost 技能的链接名。name 侧禁 `--`(GHOST_SKILL_NAME_RE),
 *  按"最后一个 `--`"拆分唯一,不同插件不可能撞名。 */
export function ghostSkillLinkName(ghostId: string, skillName: string): string {
  return `${ghostId}--${skillName}`;
}

/**
 * SKILL.md 与 manifest 声明的一致性裁判(纯函数)。
 * 返回错误原因(中文,给作者自纠),一致返回 null。
 */
export function checkSkillMdConsistency(content: string, item: GhostSkillItem): string | null {
  let data: Record<string, unknown>;
  try {
    data = (matter(content).data as Record<string, unknown>) ?? {};
  } catch {
    return 'SKILL.md frontmatter 无法解析(YAML 语法错误)';
  }
  const { issues } = parseAndValidateFrontmatter(content, 'skill');
  if (issues.length > 0) {
    return `SKILL.md frontmatter 不合格:${issues.map((i) => `${i.field}:${i.message}`).join('; ')}`;
  }
  const fmName = typeof data.name === 'string' ? data.name.trim() : '';
  const fmDescription = typeof data.description === 'string' ? data.description.trim() : '';
  if (fmName !== item.name) {
    return `SKILL.md frontmatter name ${JSON.stringify(fmName)} 与清单声明 ${JSON.stringify(item.name)} 不一致(插件详情展示的必须就是 Agent 读到的)`;
  }
  if (fmDescription !== item.description) {
    return 'SKILL.md frontmatter description 与清单声明不一致(插件详情展示的必须就是 Agent 读到的)';
  }
  return null;
}

export interface GhostSkillLinkAction {
  linkName: string;
  op: 'linked' | 'removed' | 'kept' | 'skipped';
  reason?: string;
}

export interface ReconcileGhostSkillLinksResult {
  changed: boolean;
  actions: GhostSkillLinkAction[];
  warnings: string[];
}

/**
 * Remove Cindy-managed global skill projections for every owner root during an
 * account boundary. This is intentionally separate from the active-owner
 * reconcile: the latter must preserve user-owned foreign links, while a
 * boundary must revoke all Cindy-owned projections before the next owner is
 * visible.
 *
 * The sweep keeps unrelated foreign-link failures as warnings, but separately
 * reports blockers whenever it cannot prove a shared root is clean or cannot
 * remove an identified owner projection. The account boundary must not expose a
 * new owner while one of those blockers remains (I-2).
 */
export async function removeGhostSkillLinksForRoots(
  managedRoots: readonly string[],
  homeDir?: string,
  additionalSkillDirs: readonly string[] = [],
): Promise<{ changed: boolean; warnings: string[]; blockers: string[] }> {
  const warnings: string[] = [];
  const blockers: string[] = [];
  let changed = false;
  const paths = sharedGlobalSkillsPaths(homeDir);
  const lexicalRoots = [...new Set(managedRoots.map(normalizeForCompare))];
  const resolvedRoots: string[] = [];
  for (const root of managedRoots) {
    try {
      const rootStat = await fsp.lstat(root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        const message = `Managed owner skill root is not a regular directory: ${root}`;
        warnings.push(message);
        blockers.push(message);
        continue;
      }
      resolvedRoots.push(normalizeForCompare(await fsp.realpath(root)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        const message = `Unable to resolve managed owner skill root ${root}: ${(err as Error).message}`;
        warnings.push(message);
        blockers.push(message);
      }
    }
  }
  if (lexicalRoots.length === 0) return { changed, warnings, blockers };

  for (const dir of [paths.claudeSkillsDir, paths.codexSkillsDir, paths.sharedSkillsDir, ...additionalSkillDirs]) {
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      const message = `Unable to read global skill root ${dir}: ${(err as Error).message}`;
      warnings.push(message);
      blockers.push(message);
      continue;
    }
    for (const entry of entries) {
      const linkPath = path.join(dir, entry.name);
      try {
        // Dirent.d_type can be unknown on network filesystems and can become stale
        // before this sweep reaches the entry. lstat is the ownership/type verdict.
        if (!(await fsp.lstat(linkPath)).isSymbolicLink()) continue;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        const message = `Unable to inspect global skill entry ${linkPath}: ${(err as Error).message}`;
        warnings.push(message);
        blockers.push(message);
        continue;
      }
      let rawTarget: string;
      try {
        rawTarget = await fsp.readlink(linkPath);
      } catch (readlinkError) {
        if ((readlinkError as NodeJS.ErrnoException).code === 'ENOENT') continue;
        const message = `Unable to read owner skill link ${linkPath}: ${(readlinkError as Error).message}`;
        warnings.push(message);
        blockers.push(message);
        continue;
      }
      const lexicalTarget = normalizeForCompare(path.resolve(path.dirname(linkPath), rawTarget));
      let managed = lexicalRoots.some((root) => isSameOrInside(lexicalTarget, root));
      try {
        const resolvedTarget = normalizeForCompare(await fsp.realpath(linkPath));
        managed ||= resolvedRoots.some((root) => isSameOrInside(resolvedTarget, root));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          // A resolvable raw target still lets us distinguish an unrelated bad link
          // from an owner projection whose target is temporarily inaccessible.
          warnings.push(`Unable to resolve owner skill link ${linkPath}: ${(err as Error).message}`);
        }
      }
      let sourceTargetProof: string | undefined;
      if (!managed && isSameOrInside(lexicalTarget, normalizeForCompare(paths.sharedSkillsDir))) {
        // The second link can be dangling while its source still identifies a
        // legacy Cindy target. Inspect it before removing the source link.
        try {
          sourceTargetProof = await fsp.readlink(lexicalTarget);
          const sourceTarget = path.resolve(path.dirname(lexicalTarget), sourceTargetProof);
          managed = lexicalRoots.some((root) => isSameOrInside(normalizeForCompare(sourceTarget), root));
        } catch { /* An unprovable/user-owned dangling link is left untouched. */ }
      }
      if (!managed) continue;
      try {
        const stat = await fsp.lstat(linkPath);
        if (!stat.isSymbolicLink()) {
          const message = `Skipped owner skill link that changed before removal: ${linkPath}`;
          warnings.push(message);
          blockers.push(message);
          continue;
        }
        // The link may have been replaced after the ownership read. Re-read
        // the raw target immediately before unlinking so a user-owned link
        // cannot be removed merely because the old target was managed.
        const finalRawTarget = await fsp.readlink(linkPath);
        const finalLexicalTarget = normalizeForCompare(
          path.resolve(path.dirname(linkPath), finalRawTarget),
        );
        if (finalLexicalTarget !== lexicalTarget
          || (sourceTargetProof !== undefined && await fsp.readlink(lexicalTarget) !== sourceTargetProof)) {
          const message = `Skipped owner skill link whose target changed before removal: ${linkPath}`;
          warnings.push(message);
          blockers.push(message);
          continue;
        }
        await fsp.unlink(linkPath);
        changed = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        const message = `Unable to remove owner skill link ${linkPath}: ${(err as Error).message}`;
        warnings.push(message);
        blockers.push(message);
        continue;
      }
    }
  }
  return { changed, warnings, blockers };
}

interface ReconcileOptions {
  ghosts: InstalledGhost[];
  /** 当前 owner 的插件安装根(userData/.../cindy-brain)。 */
  brainRoot: string;
  /**
   * Host-owned root containing approval-revision-bound skill snapshots.
   * 必填:漏给会让指向快照的活链接被判成外来链接而永不撤链(见头注释)。
   */
  approvalStateRoot: string;
  /**
   * 在把批准快照投影成私有链接前重算其完整内容摘要。必填:只检查 SKILL.md
   * frontmatter 拦不住正文/辅助文件被改写,而已有链接目标不变时也不能直接 kept。
   */
  validateApprovedSkillSnapshot: (ghost: InstalledGhost) => Promise<boolean>;
  /** Shared owner boundary check, also required while migrating old global links. */
  assertOwnerStable?: () => void;
  /** 覆盖 home 目录(仅测试)。 */
  homeDir?: string;
}

function normalizeForCompare(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isSameOrInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function realPathOrNull(value: string): Promise<string | null> {
  try {
    return normalizeForCompare(await fsp.realpath(value));
  } catch {
    return null;
  }
}

/**
 * 断链回收判据:链接名符合 `<id>--<name>` ghost 命名,且目标路径命中我们自己
 * 铺出来的结构 —— 安装根的 `cindy-brain` 段,或批准状态根的
 * `<状态根名>/skill-snapshots` **相邻两段**。两条同时满足才动手。
 *
 * 状态根名要求相邻匹配而不是单看 `skill-snapshots`:后者是个通用名字,单独匹配
 * 会误删用户自己在别处的 `skill-snapshots/` 下建的外来悬空链接。owner 段在路径
 * 中间,所以这条判据仍跨 owner 通用。
 */
function targetLooksGhostManaged(
  target: string,
  linkName: string,
  approvalStateDirName: string,
  managedRoots: readonly string[],
): boolean {
  // 链接名必须完整符合我们自己的命名契约:`<合法 ghostId>--<合法技能名>`
  // (按最后一个 `--` 拆分,与 ghostSkillLinkName 同规)。只看 includes('--')
  // 会把用户自建的 `foo--notes` 之类当成候选。
  const splitAt = linkName.lastIndexOf('--');
  if (splitAt <= 0) return false;
  const ghostId = linkName.slice(0, splitAt);
  const skillName = linkName.slice(splitAt + 2);
  if (!isValidGhostId(ghostId) || !GHOST_SKILL_NAME_RE.test(skillName)) return false;

  // 目标结构必须命中**我们铺过的两种布局之一**,且布局里的 id 段必须等于链接名里
  // 的 ghostId —— 单看"路径里有个段叫 cindy-brain"会把用户指向自己项目目录
  // (如 D:/projects/cindy-brain/...)的悬空链接误删,违背"外来链接绝不动"。
  // 两种布局(id 段可核对,这就是可验证的布局标识):
  //   旧模型(pre-receipt,线上存量): .../cindy-brain/<ghostId>/<skillDir...>
  //   新模型:                       .../<状态根名>/skill-snapshots/<ghostId>/<revision>/...
  const segments = target.split(/[\\/]/).map((segment) => segment.toLowerCase());
  const stateDirName = approvalStateDirName.toLowerCase();
  const idLower = ghostId.toLowerCase();
  const normalizedTarget = normalizeForCompare(target);
  if (!managedRoots.some((root) => isSameOrInside(normalizedTarget, root))) return false;
  return segments.some(
    (segment, index) =>
      (segment === 'cindy-brain' && segments[index + 1] === idLower) ||
      (segment === stateDirName &&
        segments[index + 1] === 'skill-snapshots' &&
        segments[index + 2] === idLower),
  );
}

/**
 * 插件技能根对账:期望态(启用、已批准且带 skill 槽的插件)vs 实际态(根下目标
 * 落在受管根内的链接)。幂等、best-effort、不 throw;warnings 交调用方记日志。
 */
export async function reconcileGhostSkillLinks(
  opts: ReconcileOptions,
): Promise<ReconcileGhostSkillLinksResult> {
  const actions: GhostSkillLinkAction[] = [];
  const warnings: string[] = [];
  let changed = false;

  const pluginRoot = ghostSkillPluginRoot(opts.approvalStateRoot);
  const sharedSkillsDir = path.join(pluginRoot, 'skills');
  // realpath 兼容 brainRoot 或其祖先是 symlink 的场景(relocated home dir)——
  // 活链接 realpath 后必须与归一化的物理根比较才可靠。resolve 失败退化到词法。
  const lexicalManagedRootCompares = [
    normalizeForCompare(opts.brainRoot),
    normalizeForCompare(opts.approvalStateRoot),
  ];
  const managedRootCompares = [
    (await realPathOrNull(opts.brainRoot)) ?? normalizeForCompare(opts.brainRoot),
    (await realPathOrNull(opts.approvalStateRoot)) ??
      normalizeForCompare(opts.approvalStateRoot),
  ];
  // 活链接按 realpath 归属当前 owner；断链只能读到 raw target，它可能保留 Windows
  // 8.3 短路径或 symlink 祖先的词法表示，所以用物理根 + 词法根的并集判断。
  const danglingManagedRootCompares = [
    ...new Set([...managedRootCompares, ...lexicalManagedRootCompares]),
  ];
  const approvalStateDirName = path.basename(path.resolve(opts.approvalStateRoot));

  try {
    opts.assertOwnerStable?.();
    await fsp.mkdir(sharedSkillsDir, { recursive: true });
  } catch (err) {
    warnings.push(`无法创建私有技能根 ${sharedSkillsDir}:${(err as Error).message}`);
    return { changed, actions, warnings };
  }

  // —— 期望态:linkName → { target, item }。按 id+name 排序保证确定性;撞名
  //    first-wins + warn 兜底(name 正则已保证结构上不可能,防御纵深)。
  const desired = new Map<string, { target: string; item: GhostSkillItem }>();
  const eligible = opts.ghosts
    .filter(
      (g) =>
        g.enabled &&
        g.approval.state === 'approved' &&
        Boolean(g.approvedSkillRoot) &&
        g.manifest.skill,
    )
    .sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
  for (const ghost of eligible) {
    let snapshotValid = false;
    try {
      snapshotValid = await opts.validateApprovedSkillSnapshot(ghost);
    } catch (err) {
      warnings.push(
        `批准技能快照校验失败 ${ghost.manifest.id}:${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (!snapshotValid) {
      warnings.push(`批准技能快照字节不可信,撤链并等待修复:${ghost.manifest.id}`);
      continue;
    }
    const sortedItems = [...(ghost.manifest.skill?.items ?? [])].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const item of sortedItems) {
      const linkName = ghostSkillLinkName(ghost.manifest.id, item.name);
      if (desired.has(linkName)) {
        warnings.push(`技能链接名冲突 ${linkName},保留先到者`);
        continue;
      }
      desired.set(linkName, {
        target: path.join(ghost.approvedSkillRoot!, ...item.dir.split('/')),
        item,
      });
    }
  }

  // —— 实际态扫描:只认 symlink/junction 条目;真实目录绝不进入后续任何分支。
  let linkNames: string[];
  try {
    const entries = await fsp.readdir(sharedSkillsDir, { withFileTypes: true });
    linkNames = entries.filter((ent) => ent.isSymbolicLink()).map((ent) => ent.name);
  } catch (err) {
    warnings.push(`无法读取插件技能根 ${sharedSkillsDir}:${(err as Error).message}`);
    return { changed, actions, warnings };
  }

  const managedLive = new Map<string, string>(); // linkName → realpath(compare 形态)
  const toRemove = new Map<string, string>();
  for (const entName of linkNames) {
    const linkPath = path.join(sharedSkillsDir, entName);
    let rawTarget: string | null = null;
    try {
      rawTarget = await fsp.readlink(linkPath);
    } catch {
      // A concurrent unlink/replacement is handled by the later lstat guard.
    }
    const real = await realPathOrNull(linkPath);
    if (real !== null) {
      // 活链接:目标在当前 owner 的受管根内才归我们管;他 owner / 外来链接不碰。
      const lexicalTarget = rawTarget === null
        ? null
        : path.resolve(path.dirname(linkPath), rawTarget);
      const rawManaged = lexicalTarget !== null && targetLooksGhostManaged(
        lexicalTarget,
        entName,
        approvalStateDirName,
        danglingManagedRootCompares,
      );
      // If the managed snapshot root was replaced by a link, resolved ownership
      // can escape. Keep the lexical managed proof so our projection is revoked.
      if (!rawManaged && !managedRootCompares.some((root) => isSameOrInside(real, root))) continue;
      const want = desired.get(entName);
      const wantCompare = want
        ? ((await realPathOrNull(want.target)) ?? normalizeForCompare(want.target))
        : null;
      if (want !== undefined && real === wantCompare) {
        managedLive.set(entName, real);
      } else if (rawTarget !== null) {
        toRemove.set(entName, rawTarget);
      }
      continue;
    }
    // 断链:目标命中受管结构即回收(含他 owner 与登出态临时根的残留)。
    if (rawTarget === null) {
      continue;
    }
    const absTarget = path.isAbsolute(rawTarget)
      ? rawTarget
      : path.resolve(sharedSkillsDir, rawTarget);
    if (
      targetLooksGhostManaged(
        absTarget,
        entName,
        approvalStateDirName,
        danglingManagedRootCompares,
      )
    ) {
      toRemove.set(entName, rawTarget);
    }
  }

  // —— 删除步:先撤旧再建新,防"改目标"落进冲突分支。
  for (const [linkName, expectedRawTarget] of toRemove) {
    const linkPath = path.join(sharedSkillsDir, linkName);
    try {
      const stat = await fsp.lstat(linkPath);
      if (!stat.isSymbolicLink()) continue; // TOCTOU 防御:再确认一次才动手
      const currentRawTarget = await fsp.readlink(linkPath);
      if (currentRawTarget !== expectedRawTarget) {
        warnings.push(`技能链接 ${linkName} 在回收前已变化,留待下一轮对账`);
        continue;
      }
      await fsp.unlink(linkPath);
      actions.push({ linkName, op: 'removed' });
      changed = true;
    } catch (err) {
      warnings.push(`移除技能链接 ${linkName} 失败:${(err as Error).message}`);
    }
  }

  // —— 创建步:目标须存在、含 SKILL.md 且内容与 manifest 一致(容忍更新备份
  //    窗口的瞬时缺失,skip+warn 等下一轮自愈);占位者非本 owner 托管链接不覆盖。
  for (const [linkName, { target, item }] of desired) {
    if (managedLive.has(linkName)) {
      actions.push({ linkName, op: 'kept' });
      continue;
    }
    const skillMdPath = path.join(target, 'SKILL.md');
    let skillMdContent: string;
    try {
      skillMdContent = await fsp.readFile(skillMdPath, 'utf8');
    } catch {
      actions.push({ linkName, op: 'skipped', reason: 'target-missing-skill-md' });
      warnings.push(`技能目录缺失或无 SKILL.md,暂不挂链:${target}`);
      continue;
    }
    const consistencyErr = checkSkillMdConsistency(skillMdContent, item);
    if (consistencyErr !== null) {
      actions.push({ linkName, op: 'skipped', reason: 'skill-md-inconsistent' });
      warnings.push(`${linkName} SKILL.md 一致性不通过,暂不挂链:${consistencyErr}`);
      continue;
    }
    const linkPath = path.join(sharedSkillsDir, linkName);
    try {
      await fsp.lstat(linkPath);
      // 走到这里 = 位置被占且不是删除步清掉的托管链接(真实目录/外来链接)。
      actions.push({ linkName, op: 'skipped', reason: 'occupied-by-unmanaged-entry' });
      warnings.push(`私有技能根 ${linkName} 被非托管条目占用,不覆盖`);
      continue;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        warnings.push(`检查技能链接位 ${linkName} 失败:${(err as Error).message}`);
        continue;
      }
    }
    try {
      await fsp.symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
      actions.push({ linkName, op: 'linked' });
      changed = true;
    } catch (err) {
      warnings.push(`创建技能链接 ${linkName} 失败:${(err as Error).message}`);
    }
  }

  opts.assertOwnerStable?.();
  const migrated = await removeGhostSkillLinksForRoots([opts.brainRoot, opts.approvalStateRoot], opts.homeDir);
  changed ||= migrated.changed;
  warnings.push(...migrated.warnings);
  return { changed, actions, warnings };
}
