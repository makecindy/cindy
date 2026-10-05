import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';

import {
  ensureDirectoryLink,
  isDirectory,
  isSameOrInside,
  normalizeForCompare,
  realPathOrNull,
  removeManagedLink,
  type ManagedLinkStatus,
} from './managed-dir-links.js';

export const CODEX_LEGACY_CODEX_SKILLS_LINK_NAME = 'xdt-codex';
export const CODEX_SHARED_AGENTS_SKILLS_LINK_NAME = 'xdt-agents';

type SourceName = 'codex' | 'agents' | `cindy-${string}`;
type LinkStatus = ManagedLinkStatus;

export interface CodexGlobalSkillSourceResult {
  name: SourceName;
  source: string;
  link: string;
  status: LinkStatus;
  reason?: string;
}

export interface CodexGlobalSkillsPrepareResult {
  codexHome: string;
  skillsDir: string;
  changed: boolean;
  sources: CodexGlobalSkillSourceResult[];
  warnings: string[];
}

interface PrepareOptions {
  homeDir?: string;
  /** Owned storage roots, used only to recognize obsolete projections. */
  managedRoots?: readonly string[];
  managedSkills?: readonly { path?: string; claudeCommandName: string }[];
}

export function codexManagedSkillLinkName(command: string): `cindy-${string}` {
  return `cindy-${encodeURIComponent(command)}`;
}

function isManagedSkillTarget(target: string, roots: readonly string[]): boolean {
  const normalized = normalizeForCompare(target);
  if (!roots.some((root) => isSameOrInside(normalized, normalizeForCompare(root)))) return false;
  const segments = normalized.split(path.sep);
  return (
    segments.includes('shared-system-skills') ||
    segments.some(
      (segment, index) =>
        (segment === 'ghost-install-state' &&
          ['skill-snapshots', 'agent-skills'].includes(segments[index + 1] ?? '')) ||
        (segment === 'managed-agent-skills' && segments[index + 1] === 'cindy'),
    )
  );
}

async function cleanupLegacyAggregate(codexHome: string): Promise<void> {
  const legacyScanEntry = path.join(codexHome, 'skills', 'xdt-global');
  await removeManagedLink(legacyScanEntry);

  const legacyAggregateDir = path.join(codexHome, 'global_skills');
  let entries: string[];
  try {
    entries = await fsp.readdir(legacyAggregateDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }

  const removableNames = new Set(['codex', 'agents']);
  for (const entry of entries) {
    if (!removableNames.has(entry)) return;
    const entryPath = path.join(legacyAggregateDir, entry);
    try {
      const stat = await fsp.lstat(entryPath);
      if (!stat.isSymbolicLink()) return;
    } catch {
      return;
    }
  }

  for (const entry of entries) {
    await fsp.rm(path.join(legacyAggregateDir, entry), { recursive: true, force: true });
  }
  await fsp.rmdir(legacyAggregateDir).catch(() => undefined);
}

export function codexGlobalSkillsPaths(codexHome: string, homeDir = os.homedir()) {
  const skillsDir = path.join(codexHome, 'skills');
  return {
    codexHome,
    skillsDir,
    legacyCodexSkillsLink: path.join(skillsDir, CODEX_LEGACY_CODEX_SKILLS_LINK_NAME),
    sharedAgentsSkillsLink: path.join(skillsDir, CODEX_SHARED_AGENTS_SKILLS_LINK_NAME),
    legacyCodexSkillsDir: path.join(homeDir, '.codex', 'skills'),
    sharedAgentsSkillsDir: path.join(homeDir, '.agents', 'skills'),
  };
}

export async function prepareCodexGlobalSkillsLinks(
  codexHome: string,
  opts: PrepareOptions = {},
): Promise<CodexGlobalSkillsPrepareResult> {
  const paths = codexGlobalSkillsPaths(codexHome, opts.homeDir);
  await fsp.mkdir(paths.codexHome, { recursive: true });
  await fsp.mkdir(paths.skillsDir, { recursive: true });

  const warnings: string[] = [];
  let changed = false;
  await cleanupLegacyAggregate(paths.codexHome);

  const skillsDirReal = await realPathOrNull(paths.skillsDir);
  const sourceDefs: Array<{ name: SourceName; source: string; link: string }> = [
    { name: 'codex', source: paths.legacyCodexSkillsDir, link: paths.legacyCodexSkillsLink },
    { name: 'agents', source: paths.sharedAgentsSkillsDir, link: paths.sharedAgentsSkillsLink },
    ...(opts.managedSkills ?? []).flatMap((skill) =>
      skill.path
        ? [
            {
              name: codexManagedSkillLinkName(skill.claudeCommandName),
              source: path.dirname(skill.path),
              link: path.join(paths.skillsDir, codexManagedSkillLinkName(skill.claudeCommandName)),
            },
          ]
        : [],
    ),
  ];

  // Never expose a whole projection directory: preserved conflicts in it are
  // not approved skills. Retire old aggregates and obsolete individual links.
  const desiredLinks = new Set(sourceDefs.map((source) => source.link));
  const ownedRoots = [...(opts.managedRoots ?? [])];
  for (const root of opts.managedRoots ?? []) {
    const realRoot = await realPathOrNull(root);
    if (realRoot) ownedRoots.push(realRoot);
  }
  const foreignLinks = new Set<string>();
  for (const entry of await fsp.readdir(paths.skillsDir)) {
    if (!entry.startsWith('cindy-')) continue;
    const link = path.join(paths.skillsDir, entry);
    if (!(await fsp.lstat(link)).isSymbolicLink()) continue;
    const rawTarget = await fsp.readlink(link);
    const target = path.resolve(paths.skillsDir, rawTarget);
    if (!isManagedSkillTarget(target, ownedRoots)) {
      foreignLinks.add(link);
      continue;
    }
    if (!desiredLinks.has(link) && (await fsp.readlink(link)) === rawTarget) {
      changed = (await removeManagedLink(link)) || changed;
    }
  }

  const sources: CodexGlobalSkillSourceResult[] = [];
  for (const sourceDef of sourceDefs) {
    if (foreignLinks.has(sourceDef.link)) {
      sources.push({ ...sourceDef, status: 'conflict', reason: 'foreign skill link is preserved' });
      warnings.push(`cannot link Codex ${sourceDef.name} skills: foreign skill link is preserved`);
      continue;
    }
    if (!(await isDirectory(sourceDef.source))) {
      changed = (await removeManagedLink(sourceDef.link)) || changed;
      sources.push({ ...sourceDef, status: 'missing', reason: 'source directory does not exist' });
      continue;
    }

    const sourceReal = await realPathOrNull(sourceDef.source);
    if (sourceReal && skillsDirReal && isSameOrInside(sourceReal, skillsDirReal)) {
      sources.push({ ...sourceDef, status: 'skipped', reason: 'source would create a scan cycle' });
      continue;
    }

    const result = await ensureDirectoryLink(sourceDef.link, sourceDef.source);
    changed = changed || result.changed;
    sources.push({ ...sourceDef, status: result.status, reason: result.reason });
    if (result.status === 'conflict' || result.status === 'error') {
      warnings.push(
        `cannot link Codex ${sourceDef.name} skills from ${sourceDef.source}: ${result.reason ?? result.status}`,
      );
    }
  }

  // All callers share the same success contract: a verified managed Skill must
  // have its current entry. User compatibility roots retain warning semantics.
  const failedManagedSource = sources.find(
    (source) => source.name.startsWith('cindy-') && !['linked', 'kept'].includes(source.status),
  );
  if (failedManagedSource) {
    throw new Error(
      `Cannot prepare Codex managed Skill ${failedManagedSource.name}: ${failedManagedSource.reason ?? failedManagedSource.status}`,
    );
  }

  return {
    codexHome: paths.codexHome,
    skillsDir: paths.skillsDir,
    changed,
    sources,
    warnings,
  };
}
