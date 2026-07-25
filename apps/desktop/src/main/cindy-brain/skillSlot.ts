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
 * - **链接不复制字节**:共享技能根 `~/.agents/skills/<id>--<name>` 是指向插件
 *   安装目录(brainRoot/<id>/<dir>)的 junction(win32)/dir symlink。更新插件
 *   时安装目录路径稳定,链接跨版本存活;卸载即断链,由对账回收。
 * - **绝不误伤**:只删"确认为 symlink/junction 且目标落在 cindy-brain 安装根"
 *   的条目。真实目录(SkillHub 实体技能、用户手放的技能)与外来链接一律不碰,
 *   占位冲突只 warn 不覆盖(同 shared-global-skills 的冲突哲学)。
 * - **`.claude` 扇出与回收都不归这里管**:对账后调 prepareSharedGlobalSkillLinks,
 *   它负责把 `.agents` 新条目 link 进 `.claude`;我们撤链后留下的 `.claude`
 *   悬空兼容链接目标指向 `.agents` 受管根,同样由它的 cleanupBrokenManagedLinks
 *   回收——职责分界干净:目标在 brainRoot 的链接归本文件,受管根内的归它。
 * - 多账号:brainRoot 是 owner-scoped,`~/.agents/skills` 是全局的。本函数只
 *   管理 realpath 落在**当前 brainRoot** 内的活链接;他 owner 的活链接不碰
 *   (与 SkillHub 实体技能同一跨账号可见性现状)。悬空链接只要目标带
 *   `cindy-brain` 路径段就回收(断链对所有消费方都是死重,跨 owner 清理防积尘)。
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';

import matter from 'gray-matter';

import type { GhostSkillItem, InstalledGhost } from '../../shared/ghost.js';
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

interface ReconcileOptions {
  ghosts: InstalledGhost[];
  /** 当前 owner 的插件安装根(userData/.../cindy-brain)。 */
  brainRoot: string;
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

/** 断链回收判据:链接名符合 `<id>--<name>` ghost 命名且目标路径带 `cindy-brain`
 *  段才视为 ghost 托管(跨 owner 通用)。两条同时满足才动手,避免误伤用户创建
 *  的恰巧含该路径段的外来链接。 */
function targetLooksGhostManaged(target: string, linkName: string): boolean {
  if (!linkName.includes('--')) return false;
  return target
    .split(/[\\/]/)
    .some((segment) => segment.toLowerCase() === 'cindy-brain');
}

/**
 * 共享技能根对账:期望态(启用且带 skill 槽的插件)vs 实际态(根下目标落在
 * brainRoot 的链接)。幂等、best-effort、不 throw;warnings 交调用方记日志。
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
  const brainRootCompare = (await realPathOrNull(opts.brainRoot)) ?? normalizeForCompare(opts.brainRoot);

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
    .filter((g) => g.enabled && g.manifest.slots.includes('skill') && g.manifest.skill)
    .sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
  for (const ghost of eligible) {
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
        target: path.join(opts.brainRoot, ghost.manifest.id, ...item.dir.split('/')),
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
  const toRemove: string[] = [];
  for (const entName of linkNames) {
    const linkPath = path.join(sharedSkillsDir, entName);
    const real = await realPathOrNull(linkPath);
    if (real !== null) {
      // 活链接:目标在当前 brainRoot 内才归我们管;他 owner / 外来链接不碰。
      if (!isSameOrInside(real, brainRootCompare)) continue;
      const want = desired.get(entName);
      if (want !== undefined && real === normalizeForCompare(want.target)) {
        managedLive.set(entName, real);
      } else {
        toRemove.push(entName);
      }
      continue;
    }
    // 断链:目标带 cindy-brain 段即回收(含他 owner 与登出态临时根的残留)。
    let rawTarget: string;
    try {
      rawTarget = await fsp.readlink(linkPath);
    } catch {
      continue;
    }
    const absTarget = path.isAbsolute(rawTarget)
      ? rawTarget
      : path.resolve(sharedSkillsDir, rawTarget);
    if (targetLooksGhostManaged(absTarget, entName)) toRemove.push(entName);
  }

  // —— 删除步:先撤旧再建新,防"改目标"落进冲突分支。
  for (const linkName of toRemove) {
    const linkPath = path.join(sharedSkillsDir, linkName);
    try {
      const stat = await fsp.lstat(linkPath);
      if (!stat.isSymbolicLink()) continue; // TOCTOU 防御:再确认一次才动手
      await fsp.rm(linkPath, { recursive: true, force: true });
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
      opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {},
    );
    warnings.push(...fanout.warnings);
  } catch (err) {
    warnings.push(`共享技能链接扇出失败:${(err as Error).message}`);
  }

  return { changed, actions, warnings };
}
