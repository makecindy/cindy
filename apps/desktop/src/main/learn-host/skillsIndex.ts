/**
 * skillsIndex.ts —— 已装 skill 清单(learn 的"改 vs 加"决策依据)。
 *
 * 蒸馏前把 ~/.agents/skills/(learn 落盘与市场安装的共享根)下所有 skill 的
 * name/description 注入 prompt,让模型显式决策:同域已有 skill → 沿用
 * 原名出改进版(落盘自动走"与已装版本 diff+备份");否则才新建。没有这份
 * 清单,模型只能碰运气自己去翻,"改还是加"就不可复现(规则 9)。
 *
 * 扫描是只读 fs 遍历,失败静默降级(清单缺失不阻断蒸馏)。
 */

import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';
import { shouldPruneSkillScanDirectory } from '@cindy/maker-core/skill-scan-limits';

import { createLogger } from '../logger';
import { redactSensitive } from './redaction';

const log = createLogger('learn-host:skills-index');

/** 清单条数上限(超出截断并注明 —— no silent caps)。 */
export const SKILLS_INDEX_MAX = 100;
/** description 展示截断。 */
const DESC_CAP = 160;

export interface InstalledSkillEntry {
  name: string;
  description: string;
  /** skill 目录绝对路径 —— 仅供内部定位;prompt 清单不暴露本地路径。 */
  absolutePath: string;
}

function redactPromptMetadata(value: string): string {
  return redactSensitive(value).text.replace(/\s+/g, ' ').trim();
}

/** 纯格式化:清单 → prompt 块(空清单返回空串;供单测)。
 *  清单只暴露名称/描述,不暴露本地路径(Codex review):否则 agent 可自行 Read
 *  原始 SKILL.md,绕过 controller 的 redactSensitive 预处理。 */
export function formatSkillsIndexBlock(entries: InstalledSkillEntry[], truncatedCount = 0): string {
  if (entries.length === 0) return '';
  const lines = entries.map(
    (e) => {
      const name = redactPromptMetadata(e.name) || '(unnamed skill)';
      const description = redactPromptMetadata(e.description) || '(no description)';
      return `- ${name}: ${description}`;
    },
  );
  const tail = truncatedCount > 0 ? `\n(${truncatedCount} more installed skill(s) omitted.)` : '';
  return `${lines.join('\n')}${tail}`;
}

async function isDirectoryEntry(entry: Dirent, fullPath: string): Promise<boolean> {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return (await fs.stat(fullPath)).isDirectory();
  } catch {
    return false;
  }
}

async function isSymlinkDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.lstat(target)).isSymbolicLink();
  } catch {
    return false;
  }
}

async function findSkillMd(dir: string): Promise<string | null> {
  for (const name of ['SKILL.md', 'skill.md']) {
    try {
      if ((await fs.stat(path.join(dir, name))).isFile()) return name;
    } catch {
      // Try the other spelling.
    }
  }
  return null;
}

/** 扫描全局 skill 根,读每个 SKILL.md 的 frontmatter name/description。 */
export async function listInstalledSkills(): Promise<{ entries: InstalledSkillEntry[]; truncatedCount: number }> {
  const root = path.join(os.homedir(), '.agents', 'skills');
  let skillTargets: Array<{ dir: string; skillFile: string }>;
  try {
    const topLevel: Array<{ name: string; path: string; isSymlink: boolean }> = [];
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || /\.bak\.\d+$/.test(entry.name)) continue;
      const fullPath = path.join(root, entry.name);
      if (!(await isDirectoryEntry(entry, fullPath))) continue;
      const isSymlink = entry.isSymbolicLink()
        || (entry.isDirectory() && await isSymlinkDirectory(fullPath));
      topLevel.push({ name: entry.name, path: fullPath, isSymlink });
    }
    topLevel.sort((a, b) => a.name.localeCompare(b.name));

    skillTargets = [];
    // Direct Skills first, so they win over nested Skills with the same leaf
    // name regardless of directory order.
    const namespaces: typeof topLevel = [];
    for (const entry of topLevel) {
      const skillFile = await findSkillMd(entry.path);
      if (skillFile) {
        skillTargets.push({ dir: entry.path, skillFile });
        continue;
      }
      // 共享 skill 链接流程会把既有 Claude/Codex 全局 skill 以 symlink 形式挂进
      // 本根 —— 只认真实目录会漏掉它们。直接 symlink skill 已在上方计入;
      // symlink namespace 不下钻,避免越界或循环。
      if (entry.isSymlink || shouldPruneSkillScanDirectory(entry.name)) continue;
      namespaces.push(entry);
    }
    // 最多一层 namespace/author: <root>/<namespace>/<skill>。
    for (const entry of namespaces) {
      let nestedEntries: Dirent[];
      try {
        nestedEntries = await fs.readdir(entry.path, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const nested of nestedEntries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (nested.name.startsWith('.') || /\.bak\.\d+$/.test(nested.name)) continue;
        // Direct Skills win over nested Skills with the same leaf name; keep the
        // first namespace when names collide, matching the other scanners.
        if (skillTargets.some((target) => path.basename(target.dir) === nested.name)) continue;
        const nestedPath = path.join(entry.path, nested.name);
        if (!(await isDirectoryEntry(nested, nestedPath))) continue;
        const nestedSkillFile = await findSkillMd(nestedPath);
        if (nestedSkillFile) skillTargets.push({ dir: nestedPath, skillFile: nestedSkillFile });
      }
    }
    // Truncation must be deterministic: sort before applying SKILLS_INDEX_MAX.
    skillTargets.sort((a, b) => {
      const byName = path.basename(a.dir).localeCompare(path.basename(b.dir));
      return byName !== 0 ? byName : a.dir.localeCompare(b.dir);
    });
  } catch {
    return { entries: [], truncatedCount: 0 };
  }

  const entries: InstalledSkillEntry[] = [];
  let truncatedCount = 0;
  for (const target of skillTargets) {
    if (entries.length >= SKILLS_INDEX_MAX) {
      truncatedCount = skillTargets.length - SKILLS_INDEX_MAX;
      break;
    }
    const dirName = path.basename(target.dir);
    try {
      const raw = await fs.readFile(path.join(target.dir, target.skillFile), 'utf8');
      const parsed = matter(raw);
      const data = parsed.data as Record<string, unknown>;
      const name = redactPromptMetadata(String(data.name ?? dirName)) || dirName;
      const description = redactPromptMetadata(String(data.description ?? '')).slice(0, DESC_CAP);
      entries.push({ name, description, absolutePath: target.dir });
    } catch (err) {
      // 无 SKILL.md / 解析失败的目录跳过(不是合法 skill)
      log.debug?.('skip skill dir:', dirName, err);
    }
  }
  return { entries, truncatedCount };
}
