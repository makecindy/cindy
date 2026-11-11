import fs from 'node:fs';
import path from 'node:path';
import { normalizeWorkingDirForStorage } from '../../shared/workingDir';
import type { BuiltInSkillDescriptor } from '../maker-host/built-in-skills';
import type { Skill } from './scanner';
import { inspectLocalSkillTarget, type LocalSkillTarget } from './localSkillTarget';
import { resolveExistingSkillPathForGrant } from './skillPathPolicy';

export interface SkillScanGrantInput {
  skills: Skill[];
  managedSkillRoots: readonly string[];
  builtInSkills: readonly BuiltInSkillDescriptor[];
}

/** Private Main/worker snapshot; never sent to Renderer. Operations revalidate it. */
export interface SkillScanGrants {
  error?: string;
  entries: Array<{ root: string; projectRootKey?: string; builtIn?: boolean }>;
  records: Array<{ skill: Skill; physicalIdentity: string; target: LocalSkillTarget | null }>;
}

function projectRootKey(value: unknown): string | null {
  if (typeof value !== 'string' || value.includes('\0') || value.includes('\uFFFD')) return null;
  const normalized = normalizeWorkingDirForStorage(value);
  if (!normalized || !path.isAbsolute(normalized)) return null;
  const resolved = path.resolve(normalized);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
function physicalIdentity(source: string): string {
  const st = fs.statSync(source);
  return JSON.stringify([fs.realpathSync.native(source), st.dev, st.ino]);
}
export function prepareSkillScanGrants(
  input: SkillScanGrantInput,
  resolveGrant = resolveExistingSkillPathForGrant,
): SkillScanGrants {
  const { skills, managedSkillRoots, builtInSkills } = input;
  const normalizePathForCompare = (value: string): string => {
    const withoutWindowsNamespace = process.platform === 'win32'
      ? value.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '')
      : value;
    const normalized = path.resolve(withoutWindowsNamespace);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  const realPathOrResolved = (value: string): string => {
    try { return normalizePathForCompare(fs.realpathSync.native(value)); }
    catch { return normalizePathForCompare(value); }
  };
  const configuredBuiltInRoot = (source: string): string | null => {
    const physicalSource = realPathOrResolved(source);
    const descriptor = builtInSkills.find((skill) => (
      realPathOrResolved(skill.absolutePath) === physicalSource
    ));
    return descriptor ? realPathOrResolved(descriptor.absolutePath) : null;
  };

  const entries: SkillScanGrants['entries'] = [];
  const seenEntries = new Set<string>();
  for (const skill of skills) {
    const skillProjectRootKey = skill.scope === 'project'
      ? projectRootKey(skill.projectRoot)
      : undefined;
    if (skill.scope === 'project' && !skillProjectRootKey) continue;
    // A built-in discovered through ~/.agents/skills still resolves to the
    // app-owned physical root. Keep Main's built-in attestation instead of
    // downgrading it to an ordinary discovery grant, otherwise the later
    // read handlers re-apply the lexical user-skill whitelist and reject the
    // exact path that the scan returned.
    if (skill.builtIn === true) {
      const root = configuredBuiltInRoot(skill.absolutePath);
      const entryKey = root ? `${root}\0built-in` : null;
      if (root && entryKey && !seenEntries.has(entryKey)) {
        seenEntries.add(entryKey);
        entries.push({ root, builtIn: true });
      }
      continue;
    }
    // discoveredPath preserves an allowed lexical alias when absolutePath was
    // canonicalized through a parent-directory symlink.
    for (const candidate of [skill.discoveredPath, skill.absolutePath]) {
      const root = resolveGrant(candidate);
      if (root) {
        const entryKey = `${root}\0${skillProjectRootKey ?? ''}`;
        if (!seenEntries.has(entryKey)) {
          seenEntries.add(entryKey);
          entries.push({
            root,
            ...(skillProjectRootKey ? { projectRootKey: skillProjectRootKey } : {}),
          });
        }
        break;
      }
    }
  }
  const records = skills.flatMap((skill) => {
    if (skill.kind !== 'skill') return [];
    try {
      return [{ skill, physicalIdentity: physicalIdentity(skill.absolutePath),
        target: inspectLocalSkillTarget(skill.absolutePath, skill.discoveryPaths ?? [skill.discoveredPath], managedSkillRoots) }];
    } catch { return []; }
  });
  const aliasesByIdentity = new Map<string, Set<string>>();
  for (const record of records) {
    const aliases = aliasesByIdentity.get(record.physicalIdentity) ?? new Set<string>();
    for (const alias of record.target?.aliases ?? []) aliases.add(alias);
    aliasesByIdentity.set(record.physicalIdentity, aliases);
  }
  for (const record of records) {
    // Removing the physical entity must clean every scanned scope's links.
    // Removing an external import keeps its scope-local operation/aliases.
    if (record.target && !record.target.linkOnly) {
      record.target.aliases = [...aliasesByIdentity.get(record.physicalIdentity)!];
    }
  }
  return { entries, records };
}
