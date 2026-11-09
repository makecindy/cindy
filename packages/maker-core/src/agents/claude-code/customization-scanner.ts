/**
 * Claude Code customization scanner —— 扫描 Claude Code 的本地 customization。
 *
 * 三种 kind:
 *   ~/.claude/skills/{name}/SKILL.md          → kind=skill,   scope=global
 *   ~/.claude/commands/{name}.md              → kind=command, scope=global
 *   ~/.claude/agents/{name}.md                → kind=agent,   scope=global
 *   {workingDir}/.claude/skills/{name}/...    → kind=skill,   scope=project
 *   {workingDir}/.claude/commands/{name}.md   → kind=command, scope=project
 *   {workingDir}/.claude/agents/{name}.md     → kind=agent,   scope=project
 *
 * 扫盘逻辑委托给 shared/customization-scanner，本模块只负责
 * 构建 Claude 特定的目录列表和排序规则。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {
  ListCustomizationsOptions,
  ListCustomizationsResult,
} from '../../types/customizations.js';
import { scanClaudePluginSkills } from '../shared/claude-plugin-skills.js';
import {
  readFolderSkill,
  scanCustomizationSources,
  type SourceDef,
} from '../shared/customization-scanner.js';

type Kind = 'skill' | 'command' | 'agent';
type Scope = 'global' | 'project';

function buildClaudeSources(
  workingDirs: string[],
  configDir = path.join(os.homedir(), '.claude'),
): SourceDef[] {
  const sources: SourceDef[] = [
    { engine: 'claude-code', kind: 'skill',   scope: 'global', dir: path.join(configDir, 'skills') },
    { engine: 'claude-code', kind: 'command', scope: 'global', dir: path.join(configDir, 'commands') },
    { engine: 'claude-code', kind: 'agent',   scope: 'global', dir: path.join(configDir, 'agents') },
  ];
  for (const wd of workingDirs) {
    if (!wd || !path.isAbsolute(wd)) continue;
    sources.push(
      { engine: 'claude-code', kind: 'skill',   scope: 'project', dir: path.join(wd, '.claude', 'skills'),   workingDir: wd },
      { engine: 'claude-code', kind: 'command', scope: 'project', dir: path.join(wd, '.claude', 'commands'), workingDir: wd },
      { engine: 'claude-code', kind: 'agent',   scope: 'project', dir: path.join(wd, '.claude', 'agents'),   workingDir: wd },
    );
  }
  return sources;
}

const SCOPE_ORDER: Record<Scope, number> = { global: 0, project: 1 };
const KIND_ORDER: Record<Kind, number> = { skill: 0, command: 1, agent: 2 };

/**
 * Claude Code customization scanner 入口。
 *
 * - workingDirs 空数组 / 不填 → 仅 global
 * - kinds 不填 → 三类全返回
 * - 单 source 失败收进 errors, 不抛
 *
 * 排序: scope (global 先) → kind (skill, command, agent) → name 字母序。
 */
export async function scanClaudeCustomizations(
  opts: ListCustomizationsOptions,
): Promise<ListCustomizationsResult> {
  // Each working dir contributes its own Git root; SkillHub passes the whole
  // project catalogue, not just the active one.
  const roots = (opts.workingDirs ?? []).map((dir) => resolveGitRoot(dir));
  return scanClaudeCustomizationsAtConfig(
    opts,
    path.join(os.homedir(), '.claude'),
    roots.length > 0 ? roots : [undefined],
  );
}

function scanClaudeCustomizationsAtConfig(
  opts: ListCustomizationsOptions,
  configDir: string,
  projectRoots?: readonly (string | undefined)[],
): ListCustomizationsResult {
  const workingDirs = opts.workingDirs ?? [];
  const kindFilter = opts.kinds && opts.kinds.length > 0 ? new Set(opts.kinds) : null;

  const sources = buildClaudeSources(workingDirs, configDir);
  const result = scanCustomizationSources(sources, kindFilter);

  // Enabled Claude Code plugins contribute Skills with a `plugin:skill`
  // namespace. They are not part of the user/project folder sources above.
  //
  // SkillHub can ask about several projects at once, and each project may have
  // its own installs and settings overrides. Scan every project root and keep
  // the most specific entry per Skill name, so reordering recent projects never
  // changes what the page shows.
  if (!kindFilter || kindFilter.has('skill')) {
    const roots = projectRoots && projectRoots.length > 0 ? projectRoots : [undefined];
    const byName = new Map<string, ReturnType<typeof scanClaudePluginSkills>[number]>();
    for (const root of new Set(roots)) {
      for (const skill of scanClaudePluginSkills({
        configDir,
        ...(root ? { projectRoot: root } : {}),
      })) {
        const existing = byName.get(skill.name);
        if (!existing || existing.scope === 'user') byName.set(skill.name, skill);
      }
    }
    for (const skill of byName.values()) {
      result.items.push(
        readFolderSkill(
          {
            engine: 'claude-code',
            kind: 'skill',
            scope: skill.scope === 'user' ? 'global' : 'project',
            dir: skill.folder,
            namePrefix: skill.pluginName,
            ...(skill.projectRoot ? { workingDir: skill.projectRoot } : {}),
          },
          skill.folder,
          skill.mdPath,
        ),
      );
    }
  }

  result.items.sort((a, b) => {
    const sa = SCOPE_ORDER[a.scope as Scope] ?? 99;
    const sb = SCOPE_ORDER[b.scope as Scope] ?? 99;
    if (sa !== sb) return sa - sb;
    const ka = KIND_ORDER[a.kind as Kind] ?? 99;
    const kb = KIND_ORDER[b.kind as Kind] ?? 99;
    if (ka !== kb) return ka - kb;
    return a.name.localeCompare(b.name);
  });

  return result;
}

/**
 * Nearest Git root at or above `workingDir`, or undefined when the path is not
 * inside a repository. Project-scoped plugin installs and project settings are
 * keyed by this root — a session started in `/repo/packages/app` still uses
 * `/repo/.claude`, so callers must not pass the raw cwd.
 */
export function resolveGitRoot(workingDir: string): string | undefined {
  let current: string;
  try {
    current = fs.realpathSync(workingDir);
  } catch {
    current = path.resolve(workingDir);
  }
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** Native slash-command discovery walks to the nearest Git root (or filesystem root).
 * Keep this runtime view separate from SkillHub's explicitly owned project list.
 * Legacy commands and Skills share Claude's slash-command namespace, so callers
 * making authorization decisions must see both kinds.
 * Ancestors precede descendants so same-name winner selection keeps the closest source.
 */
export async function scanClaudeRuntimeSkills(
  workingDir: string,
  configDir = path.join(os.homedir(), '.claude'),
): Promise<ListCustomizationsResult> {
  let current = fs.realpathSync(workingDir);
  const workingDirs: string[] = [];
  while (true) {
    workingDirs.unshift(current);
    if (fs.existsSync(path.join(current, '.git'))) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  // The walk stops at the nearest Git root (or filesystem root), so the first
  // entry is the project root iff a `.git` was actually found there. Plugin
  // installs and project settings are keyed by that root, not by the cwd.
  const root = workingDirs[0];
  const projectRoot = root && fs.existsSync(path.join(root, '.git')) ? root : undefined;
  return scanClaudeCustomizationsAtConfig(
    { workingDirs, kinds: ['skill', 'command'] },
    configDir,
    [projectRoot],
  );
}
