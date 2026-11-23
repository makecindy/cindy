/**
 * The Skills a plugin-engine task is told about before its first message (docs/plans/acp-plugin-bridge.md
 * 「插件与 Skill 告知」): the same scope as the built-in Pi engine — Cindy-managed and approved plugin
 * Skills, Pi's discovery directories for the task folder, and the user's enable switches.
 *
 * Directory discovery runs in the isolated, time-limited scan process (`scanLocalCustomizations`), never
 * as a synchronous scan on Main, so a large or slow Skill folder cannot block other tasks while a plugin
 * engine starts.
 */

import path from 'node:path';
import { canonicalSkillPath, snapshotDisabledSkillPaths, type ListCustomizationsOptions, type ListCustomizationsResult, type PluginEngineBriefingSkill } from '@cindy/maker-core';

export interface PluginEngineSkillPorts {
  listManagedSkills(): Promise<ReadonlyArray<{ name: string; description?: string; path?: string }>>;
  scanCustomizations(engine: 'pi', options: ListCustomizationsOptions): Promise<ListCustomizationsResult>;
  readDisabledSkillPaths(): readonly string[];
}

export function createPluginEngineSkillLister(ports: PluginEngineSkillPorts) {
  return async ({ workingDir }: { workingDir: string }): Promise<PluginEngineBriefingSkill[]> => {
    const [managed, scanned] = await Promise.all([
      ports.listManagedSkills(),
      ports.scanCustomizations('pi', { workingDirs: [workingDir], kinds: ['skill'] }),
    ]);
    // Each disabled path and each Skill is resolved once (not once per pair); with nothing turned off,
    // nothing is resolved.
    const disabledPaths = ports.readDisabledSkillPaths();
    const disabled = disabledPaths.length ? new Set(snapshotDisabledSkillPaths(disabledPaths)) : null;
    const discovered = scanned.items
      .filter((item) => item.kind === 'skill' && item.enabled !== false)
      .map((item) => ({ name: item.name, description: item.description, path: item.mdPath ?? path.join(item.absolutePath, 'SKILL.md') }));
    return [...managed, ...discovered]
      .filter((skill) => !disabled || !skill.path || !disabled.has(canonicalSkillPath(skill.path)))
      .map((skill) => ({ name: skill.name, ...(skill.description ? { description: skill.description } : {}), ...(skill.path ? { path: skill.path } : {}) }));
  };
}
