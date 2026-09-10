import path from 'node:path';
import fs from 'node:fs';
import { canonicalSkillPath, isSkillDisabled, skillEntryPath } from '../shared/skill-activation.js';
import type { PiProjectResourceAssemblySnapshot } from './project-resource-assembly.js';

/** Remove explicitly disabled sources while keeping all provenance arrays aligned. */
export function filterPiDisabledProjectSkills(
  assembly: PiProjectResourceAssemblySnapshot,
  disabled: readonly string[],
): PiProjectResourceAssemblySnapshot {
  if (disabled.length === 0) return assembly;
  const indices = new Set(assembly.skillPaths.flatMap((source, index) =>
    isSkillDisabled(source, disabled) ? [] : [index]));
  return Object.freeze({
    ...assembly,
    skillPaths: Object.freeze(assembly.skillPaths.filter((_, index) => indices.has(index))),
    launchSkillPaths: Object.freeze(assembly.launchSkillPaths.filter((_, index) => indices.has(index))),
    launchSkillDigests: Object.freeze(assembly.launchSkillDigests.filter((_, index) => indices.has(index))),
    launchSkillSourceFingerprints: Object.freeze(assembly.launchSkillSourceFingerprints.filter((_, index) => indices.has(index))),
  });
}

/** Resolve only disabled identities to Pi's lexical discovery paths (including symlinks).
 * This does not select what may load: native Pi remains the resource loader.
 */
export function piDisabledDiscoveryPaths(disabled: readonly string[], roots: readonly string[]): string[] {
  const result = new Set(disabled);
  if (disabled.length === 0) return [];
  // Alias resolution is best-effort and must not hold up native Pi startup.
  // Bound enumeration itself (including hidden entries), not just recursion.
  const deadline = performance.now() + 100;
  const disabledKeys = new Set(disabled.map(canonicalSkillPath));
  let remainingEntries = 2048;
  const exhausted = () => remainingEntries <= 0 || performance.now() >= deadline;
  const pending: Array<{ entry: string; ancestors: Set<string>; depth: number }> = [];
  const visit = (entry: string, ancestors: Set<string>, depth: number) => {
    if (depth > 16 || exhausted()) return;
    try {
      const key = canonicalSkillPath(entry);
      if (disabledKeys.has(key)) { result.add(entry); return; }
      if (!fs.statSync(entry).isDirectory() || ancestors.has(key)) return;
      if (fs.existsSync(path.join(entry, 'SKILL.md')) || fs.existsSync(path.join(entry, 'skill.md'))) return;
      if (depth < 16) pending.push({ entry, ancestors: new Set([...ancestors, key]), depth });
    } catch { /* Missing/unreadable discovery roots are handled by native Pi. */ }
  };
  for (const root of roots) {
    if (exhausted()) break;
    remainingEntries -= 1;
    visit(root, new Set(), 0);
  }
  // Inspect every root's direct candidates before descending into any subtree.
  // FIFO preserves this priority at subsequent levels within the shared budget.
  for (let index = 0; index < pending.length && !exhausted(); index += 1) {
    const { entry, ancestors, depth } = pending[index]!;
    try {
      const directory = fs.opendirSync(entry);
      try {
        while (!exhausted()) {
          const child = directory.readSync();
          if (!child) break;
          remainingEntries -= 1;
          if (!child.name.startsWith('.')) visit(path.join(entry, child.name), ancestors, depth + 1);
        }
      } finally {
        directory.closeSync();
      }
    } catch { /* Missing/unreadable discovery roots are handled by native Pi. */ }
  }
  return [...result];
}

/** Pi filters ordinary resources and package resources independently. Preserve native package filters. */
export function applyPiDisabledSkillSettings(
  settings: Record<string, unknown>,
  disabled: readonly string[],
): Record<string, unknown> {
  if (disabled.length === 0) return settings;
  const entryPaths = [...new Set(disabled.flatMap((source) => [
    skillEntryPath(source), skillEntryPath(canonicalSkillPath(source)),
  ]))];
  const packages = Array.isArray(settings.packages) ? settings.packages.map((entry: unknown) => {
    const spec = typeof entry === 'string' ? { source: entry } : entry;
    if (!spec || typeof spec !== 'object' || !('source' in spec)
      || typeof spec.source !== 'string' || !path.isAbsolute(spec.source)) return entry;
    const root = spec.source;
    const exclusions = entryPaths.flatMap((file) => {
      const relative = path.relative(root, file);
      return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
        ? [`-${relative.split(path.sep).join('/')}`,
          ...(path.basename(relative).toLowerCase() === 'skill.md'
            ? [`-${path.dirname(relative).split(path.sep).join('/')}`] : [])] : [];
    });
    if (exclusions.length === 0) return entry;
    const configured = 'skills' in spec ? spec.skills : undefined;
    // An explicit empty array already disables all package Skills. Never widen it.
    if (Array.isArray(configured) && configured.length === 0) return entry;
    return { ...spec, skills: [...(Array.isArray(configured) ? configured : ['**/*']), ...exclusions] };
  }) : undefined;
  return {
    ...settings,
    skills: [...(Array.isArray(settings.skills) ? settings.skills : []), ...entryPaths.flatMap((file) => [
      `-${file}`, ...(path.basename(file).toLowerCase() === 'skill.md' ? [`-${path.dirname(file)}`] : []),
    ])],
    ...(packages ? { packages } : {}),
  };
}
