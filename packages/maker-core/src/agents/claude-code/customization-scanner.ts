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
import { scanCustomizationSources, type SourceDef } from '../shared/customization-scanner.js';

type Kind = 'skill' | 'command' | 'agent';
type Scope = 'global' | 'project';

function buildClaudeSources(workingDirs: string[]): SourceDef[] {
  const home = os.homedir();
  const sources: SourceDef[] = [
    { engine: 'claude-code', kind: 'skill',   scope: 'global', dir: path.join(home, '.claude', 'skills') },
    { engine: 'claude-code', kind: 'command', scope: 'global', dir: path.join(home, '.claude', 'commands') },
    { engine: 'claude-code', kind: 'agent',   scope: 'global', dir: path.join(home, '.claude', 'agents') },
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
  const workingDirs = opts.workingDirs ?? [];
  const kindFilter = opts.kinds && opts.kinds.length > 0 ? new Set(opts.kinds) : null;

  const sources = buildClaudeSources(workingDirs);
  const result = scanCustomizationSources(sources, kindFilter);

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

/** Native project discovery walks to the nearest Git root (or filesystem root).
 * Keep this runtime view separate from SkillHub's explicitly owned project list.
 * Ancestors precede descendants so same-name winner selection keeps the closest source.
 */
export async function scanClaudeRuntimeSkills(workingDir: string): Promise<ListCustomizationsResult> {
  let current = fs.realpathSync(workingDir);
  const workingDirs: string[] = [];
  while (true) {
    workingDirs.unshift(current);
    if (fs.existsSync(path.join(current, '.git'))) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return scanClaudeCustomizations({ workingDirs, kinds: ['skill'] });
}
