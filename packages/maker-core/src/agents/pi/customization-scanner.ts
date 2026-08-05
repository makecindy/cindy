/**
 * pi 文件系统 customization scanner。
 *
 * 扫描路径:
 *   ~/.agents/skills/{name}/SKILL.md        → kind=skill, scope=user (跨引擎共享;
 *                                              与 cc/codex 同一个根,pi 因此看到与它们
 *                                              一致的技能包,无需 fan)
 *   ~/.pi/agent/skills/{name}/SKILL.md       → kind=skill, scope=user (pi 原生)
 *   {workingDir}/.agents/skills/{name}/...   → kind=skill, scope=repo
 *   {workingDir}/.pi/agent/skills/{name}/... → kind=skill, scope=repo (pi 原生)
 *
 * 纯文件系统发现,不 spawn pi —— ChatInput `/` palette 的 agent-skill 类目与
 * SkillHub 管理页共用。只暴露技能"存在"(name/description frontmatter),技能正文
 * 仅在 `/skill:name` 被调用时才进上下文,故此发现层零基线上下文增长。
 */

import os from 'node:os';
import path from 'node:path';

import type {
  ListCustomizationsOptions,
  ListCustomizationsResult,
} from '../../types/customizations.js';
import { scanCustomizationSources, type SourceDef } from '../shared/customization-scanner.js';

function buildPiSources(workingDirs: string[]): SourceDef[] {
  const home = os.homedir();
  const sources: SourceDef[] = [
    { engine: 'pi', kind: 'skill', scope: 'user', dir: path.join(home, '.agents', 'skills') },
    { engine: 'pi', kind: 'skill', scope: 'user', dir: path.join(home, '.pi', 'agent', 'skills') },
  ];
  for (const wd of workingDirs) {
    if (!wd || !path.isAbsolute(wd)) continue;
    sources.push(
      { engine: 'pi', kind: 'skill', scope: 'repo', dir: path.join(wd, '.agents', 'skills'), workingDir: wd },
      { engine: 'pi', kind: 'skill', scope: 'repo', dir: path.join(wd, '.pi', 'agent', 'skills'), workingDir: wd },
    );
  }
  return sources;
}

export async function scanPiCustomizations(
  opts: ListCustomizationsOptions,
): Promise<ListCustomizationsResult> {
  if (opts.kinds && opts.kinds.length > 0 && !opts.kinds.includes('skill')) {
    return { items: [], errors: [] };
  }

  const workingDirs = opts.workingDirs ?? [];
  const sources = buildPiSources(workingDirs);
  const result = scanCustomizationSources(sources, null);

  result.items.sort((a, b) => {
    if (a.scope !== b.scope) return a.scope.localeCompare(b.scope);
    return a.name.localeCompare(b.name);
  });

  return result;
}
