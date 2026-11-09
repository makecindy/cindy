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
interface PluginScanTarget {
  /** Directory matched against `installed_plugins.json#projectPath` and settings. */
  scanRoot: string;
  /** Project identity SkillHub groups by. Defaults to `scanRoot`. */
  ownerRoot?: string;
}

export async function scanClaudeCustomizations(
  opts: ListCustomizationsOptions,
): Promise<ListCustomizationsResult> {
  // Each working dir contributes its own project; SkillHub passes the whole
  // catalogue, not just the active one. Two dirs inside the same repository
  // resolve to the same scan root, so the first one owns the entry.
  const seen = new Set<string>();
  const targets: PluginScanTarget[] = [];
  for (const dir of opts.workingDirs ?? []) {
    const ownerRoot = path.resolve(dir);
    const scanRoot = resolveGitRoot(dir) ?? ownerRoot;
    if (seen.has(scanRoot)) continue;
    seen.add(scanRoot);
    targets.push({ scanRoot, ownerRoot });
  }
  return scanClaudeCustomizationsAtConfig(
    opts,
    path.join(os.homedir(), '.claude'),
    targets,
  );
}

function scanClaudeCustomizationsAtConfig(
  opts: ListCustomizationsOptions,
  configDir: string,
  targets?: readonly PluginScanTarget[],
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
    // Always run a user-only pass first: a plugin enabled globally but disabled
    // by every listed project must still appear in the global list.
    const passes: (PluginScanTarget | undefined)[] = [undefined, ...(targets ?? [])];
    const seen = new Set<string>();
    for (const target of passes) {
      const scanRoot = target?.scanRoot;
      for (const skill of scanClaudePluginSkills({
        configDir,
        ...(scanRoot ? { projectRoot: scanRoot } : {}),
      })) {
        const ownerRoot = skill.scope === 'user'
          ? undefined
          : (target?.ownerRoot ?? scanRoot);
        // Project-scoped entries stay distinct per project; user entries from
        // different passes collapse into one.
        const key = `${skill.name}\u0000${ownerRoot ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.items.push(
          readFolderSkill(
            {
              engine: 'claude-code',
              kind: 'skill',
              scope: skill.scope === 'user' ? 'global' : 'project',
              dir: skill.folder,
              namePrefix: skill.pluginName,
              ...(ownerRoot ? { workingDir: ownerRoot } : {}),
            },
            skill.folder,
            skill.mdPath,
          ),
        );
      }
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
  // entry is the project root iff a `.git` was actually found there. Claude
  // projects do not require a repository, so without one the working directory
  // itself is the project context.
  const ownerRoot = path.resolve(workingDir);
  const root = workingDirs[0];
  const scanRoot = root && fs.existsSync(path.join(root, '.git')) ? root : ownerRoot;
  return scanClaudeCustomizationsAtConfig(
    { workingDirs, kinds: ['skill', 'command'] },
    configDir,
    [{ scanRoot, ownerRoot }],
  );
}
