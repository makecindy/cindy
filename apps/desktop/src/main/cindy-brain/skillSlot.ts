/**
 * skillSlot.ts —— skill 槽的两半:SKILL.md 一致性检查 + 共享技能根链接对账。
 *
 * 设计要点:
 * - **确认框看到的 = Agent 读到的**:manifest 里 skill.items 的 name/description
 *   必须与包内 SKILL.md frontmatter 逐字一致。`checkSkillMdConsistency` 是唯一
 *   裁判,打包(forge.packGhostDir)与装入(GhostManager.parse)两侧共用,
 *   杜绝两端契约漂移。
 * - **单一幂等 reconciler**:`reconcileGhostSkillLinks` 以"期望态 vs 实际态"
 *   对账,不做增量命令式挂链——install/update/启停/卸载全走同一条广播管线
 *   触发对账,崩溃残留(悬空链接)下一轮自动自愈。
 * - **链接指向 Host 批准快照,不指向可变安装目录**:共享技能根
 *   `~/.agents/skills/<id>--<name>` 是指向**批准状态根**里
 *   `skill-snapshots/<id>/<revision>/<dir>` 的 junction(win32)/dir symlink。
 *   skill 槽是唯一越出沙箱的能力,确认框看到的 SKILL.md 必须就是 Agent 之后
 *   读到的那份,所以装入/更新确认时把技能目录逐字节拷成快照(只收普通文件),
 *   链接指快照而不是随后可被改写的 `brainRoot/<id>/<dir>`。代价是目标路径按
 *   revision 变化:每次更新都换一个新目标,靠对账重指(旧 revision 快照在
 *   receipt 提交后回收)。卸载即断链,由对账回收。
 * - **两个受管根**:因此本文件同时管理安装根(brainRoot)与批准状态根
 *   (approvalStateRoot);两者都必须由调用方给出,漏给会让活链接被判成外来
 *   链接而永不撤链 —— 停用/卸载后技能仍对主 Agent 生效,故 approvalStateRoot
 *   是必填项。
 * - **绝不误伤**:只删"确认为 symlink/junction 且目标落在上述两个受管根之一"
 *   的条目。真实目录(SkillHub 实体技能、用户手放的技能)与外来链接一律不碰,
 *   占位冲突只 warn 不覆盖(同 shared-global-skills 的冲突哲学)。
 * - **`.claude` 扇出与回收都不归这里管**:对账后调 prepareSharedGlobalSkillLinks,
 *   它负责把 `.agents` 新条目 link 进 `.claude`;我们撤链后留下的 `.claude`
 *   悬空兼容链接目标指向 `.agents` 受管根,同样由它的 cleanupBrokenManagedLinks
 *   回收——职责分界干净:目标在本文件受管根内的链接归本文件,目标在 `.agents`
 *   受管根内的归它。
 * - 多账号:两个受管根都是 owner-scoped,`~/.agents/skills` 是全局的。本函数只
 *   管理 realpath 落在**当前 owner 的受管根**内的活链接;他 owner 的活链接不碰
 *   (与 SkillHub 实体技能同一跨账号可见性现状)。悬空链接按结构判据回收
 *   (断链对所有消费方都是死重,跨 owner 清理防积尘),判据见
 *   `targetLooksGhostManaged`。
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
import {
  prepareSharedGlobalSkillLinks,
  sharedGlobalSkillsPaths,
} from '../maker-host/shared-global-skills.js';

/** 共享技能根里 ghost 技能的链接名。name 侧禁 `--`(GHOST_SKILL_NAME_RE),
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
    return `SKILL.md frontmatter name ${JSON.stringify(fmName)} 与清单声明 ${JSON.stringify(item.name)} 不一致(装入确认框展示的必须就是 Agent 读到的)`;
  }
  if (fmDescription !== item.description) {
    return 'SKILL.md frontmatter description 与清单声明不一致(装入确认框展示的必须就是 Agent 读到的)';
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

  for (const dir of [paths.sharedSkillsDir, paths.claudeSkillsDir, paths.codexSkillsDir]) {
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
        if (finalLexicalTarget !== lexicalTarget) {
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
   * 在把批准快照投影成共享链接前重算其完整内容摘要。必填:只检查 SKILL.md
   * frontmatter 拦不住正文/辅助文件被改写,而已有链接目标不变时也不能直接 kept。
   */
  validateApprovedSkillSnapshot: (ghost: InstalledGhost) => Promise<boolean>;
  /** Present only for the Ghost-managed global fanout path. */
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
 * 共享技能根对账:期望态(启用、已批准且带 skill 槽的插件)vs 实际态(根下目标
 * 落在受管根内的链接)。幂等、best-effort、不 throw;warnings 交调用方记日志。
 */
export async function reconcileGhostSkillLinks(
  opts: ReconcileOptions,
): Promise<ReconcileGhostSkillLinksResult> {
  const actions: GhostSkillLinkAction[] = [];
  const warnings: string[] = [];
  let changed = false;

  const { sharedSkillsDir } = sharedGlobalSkillsPaths(opts.homeDir);
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
    await fsp.mkdir(sharedSkillsDir, { recursive: true });
  } catch (err) {
    warnings.push(`无法创建共享技能根 ${sharedSkillsDir}:${(err as Error).message}`);
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
        g.manifest.slots.includes('skill') &&
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
    warnings.push(`无法读取共享技能根 ${sharedSkillsDir}:${(err as Error).message}`);
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
      warnings.push(`共享技能根 ${linkName} 被非托管条目占用,不覆盖`);
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

  // —— 扇出:`.agents` 条目 → `.claude` 兼容链接;撤链留下的 `.claude` 悬空
  //    兼容链接(目标在受管根内)也由它回收。每次对账都跑(兼容链接可能独立
  //    缺失——canonical 正常但 .claude 侧被删或上次扇出失败);幂等、失败不阻断。
  try {
    const fanout = await prepareSharedGlobalSkillLinks(
      {
        ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
        ...(opts.assertOwnerStable ? { assertOwnerStable: opts.assertOwnerStable } : {}),
      },
    );
    warnings.push(...fanout.warnings);
  } catch (err) {
    warnings.push(`共享技能链接扇出失败:${(err as Error).message}`);
  }

  return { changed, actions, warnings };
}
