import fsp from 'node:fs/promises';
import path from 'node:path';

import type {
  AgentSkillCommand,
  PiRuntimeCapabilityManifest,
} from '@cindy/maker-core';
import {
  piCanonicalPathIsWithin,
  piCanonicalPathsEqual,
} from '@cindy/maker-core';

import type { AgentInputQueuedMessage } from '../../shared/agentInputQueue.js';

export const PI_SKILL_INVOCATION_VALIDATION_DEADLINE_MS = 30_000;

export interface PiSkillInvocationValidationDeps {
  realpath: (candidate: string) => Promise<string>;
  deadlineMs?: number;
}

type PiSkillScanError = { path?: string; message: string };

const defaultValidationDeps: PiSkillInvocationValidationDeps = {
  realpath: (candidate) => fsp.realpath(candidate),
};

const PI_SKILL_INVOCATION_VALIDATION_TIMEOUT = 'PI_SKILL_INVOCATION_VALIDATION_TIMEOUT';
const PI_RUNTIME_USER_SKILL_CANONICAL_SOURCE = Symbol.for(
  'cindy.pi.runtime-user-skill-canonical-source',
);

function localPathContains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

/**
 * Scanner-wide errors have no path and invalidate every receipt. Path-scoped
 * errors only invalidate the selected Skill when the two local paths overlap;
 * a changed sibling Skill must not block an otherwise current runtime proof.
 */
export function piSkillScanErrorsBlockInvocation(
  errors: readonly PiSkillScanError[] | undefined,
  sourcePath: unknown,
): boolean {
  if (!errors?.length) return false;
  if (
    typeof sourcePath !== 'string'
    || !path.isAbsolute(sourcePath)
    || sourcePath.includes('\0')
  ) return true;
  const selected = path.resolve(sourcePath);
  return errors.some((error) => {
    if (
      typeof error.path !== 'string'
      || !path.isAbsolute(error.path)
      || error.path.includes('\0')
    ) return true;
    const failed = path.resolve(error.path);
    return localPathContains(failed, selected) || localPathContains(selected, failed);
  });
}

async function awaitValidationStep<T>(
  operation: () => Promise<T>,
  deadlineAtMs: number,
): Promise<T> {
  const remainingMs = deadlineAtMs - Date.now();
  if (remainingMs <= 0) {
    throw Object.assign(new Error('Pi Skill invocation validation deadline expired'), {
      code: PI_SKILL_INVOCATION_VALIDATION_TIMEOUT,
    });
  }
  const pending = operation();
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(Object.assign(
          new Error('Pi Skill invocation validation deadline expired'),
          { code: PI_SKILL_INVOCATION_VALIDATION_TIMEOUT },
        )), remainingMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function canonicalLocalPath(
  value: unknown,
  dependencies: PiSkillInvocationValidationDeps,
  deadlineAtMs: number,
): Promise<string | null> {
  if (typeof value !== 'string' || !value || value.includes('\0') || !path.isAbsolute(value)) {
    return null;
  }
  const resolved = path.resolve(value);
  try {
    return await awaitValidationStep(() => dependencies.realpath(resolved), deadlineAtMs);
  } catch {
    return null;
  }
}

async function existingPhysicalPath(
  value: unknown,
  dependencies: PiSkillInvocationValidationDeps,
  deadlineAtMs: number,
): Promise<string | null> {
  if (
    typeof value !== 'string'
    || !value
    || value.includes('\0')
    || !path.isAbsolute(value)
  ) return null;
  try {
    return await awaitValidationStep(
      () => dependencies.realpath(path.resolve(value)),
      deadlineAtMs,
    );
  } catch {
    return null;
  }
}

async function runtimeProjectSkillMatchesSource(
  sourcePath: string,
  skill: NonNullable<NonNullable<
    PiRuntimeCapabilityManifest['projectResources']
  >['loadedSkills']>[number],
  dependencies: PiSkillInvocationValidationDeps,
  deadlineAtMs: number,
): Promise<boolean> {
  const [selected, loadedSource, repoRoot] = await Promise.all([
    existingPhysicalPath(sourcePath, dependencies, deadlineAtMs),
    existingPhysicalPath(skill.sourcePath, dependencies, deadlineAtMs),
    existingPhysicalPath(skill.canonicalRepoRoot, dependencies, deadlineAtMs),
  ]);
  const identity = skill.pathComparisonIdentity;
  if (!selected || !loadedSource || !repoRoot || !identity) return false;
  return piCanonicalPathIsWithin(identity, repoRoot, selected)
    && piCanonicalPathIsWithin(identity, repoRoot, loadedSource)
    && piCanonicalPathsEqual(identity, selected, loadedSource);
}

async function runtimeUserSkillMatchesSource(
  sourcePath: string,
  command: PiRuntimeCapabilityManifest['commands'][number],
  dependencies: PiSkillInvocationValidationDeps,
  deadlineAtMs: number,
): Promise<boolean> {
  const [selected, baseDir] = await Promise.all([
    canonicalLocalPath(sourcePath, dependencies, deadlineAtMs),
    canonicalLocalPath(command.sourceInfo.baseDir, dependencies, deadlineAtMs),
  ]);
  if (
    !selected
    || !baseDir
    || command.sourceInfo.scope !== 'user'
    || command.sourceInfo.source !== 'auto'
  ) return false;

  // Preserve the selected entry name under ~/.agents/skills. Its canonical
  // target may have a different basename when the Skill is installed through
  // a symlink (for example, demo -> /shared/my-skill).
  const selectedName = path.basename(path.resolve(sourcePath));
  const derivedFromBase = await canonicalLocalPath(
    path.join(baseDir, 'skills', selectedName),
    dependencies,
    deadlineAtMs,
  );
  if (derivedFromBase !== selected) return false;

  if (command.sourceInfo.path === undefined) {
    // Pinned Pi v0.83 normally omits path for auto-loaded user Skills. Catalog
    // capture freezes the canonical target in a non-enumerable Symbol; using
    // only the re-resolved baseDir here would accept a post-catalog retarget.
    return Reflect.get(command, PI_RUNTIME_USER_SKILL_CANONICAL_SOURCE) === selected;
  }
  const runtimePath = await canonicalLocalPath(
    command.sourceInfo.path,
    dependencies,
    deadlineAtMs,
  );
  if (!runtimePath) return false;
  const runtimeSkillDir = path.basename(runtimePath) === 'SKILL.md'
    ? await canonicalLocalPath(path.dirname(runtimePath), dependencies, deadlineAtMs)
    : runtimePath;
  return runtimeSkillDir === selected;
}

/**
 * Revalidate renderer-provided Pi Skill routing against this exact runtime.
 * Discovery and persisted queue data are never sufficient authority.
 */
export async function isCurrentPiSkillInvocation(
  item: Pick<AgentInputQueuedMessage, 'agentSkillInvocation' | 'createOpts'>,
  manifest: PiRuntimeCapabilityManifest | undefined,
  currentSkills: readonly AgentSkillCommand[],
  dependencies: PiSkillInvocationValidationDeps = defaultValidationDeps,
): Promise<boolean> {
  const invocation = item.agentSkillInvocation;
  if (!invocation) return true;
  if (item.createOpts.agentKind !== 'pi' || manifest?.status !== 'loaded') return false;
  if (!invocation.name || !/^skill:[^\s/]+$/i.test(invocation.runtimeCommandName)) {
    return false;
  }
  if (!invocation.sourcePath || (invocation.scope !== 'repo' && invocation.scope !== 'user')) {
    return false;
  }
  const invocationSourcePath = invocation.sourcePath;
  const currentMatches = currentSkills.filter((skill) => (
    skill.name === invocation.name
    && skill.scope === invocation.scope
    && skill.path === invocation.sourcePath
    && skill.runtimeCommandName === invocation.runtimeCommandName
    && (invocation.scope !== 'repo' || skill.runtimeStatus === 'loaded')
  ));
  if (currentMatches.length !== 1) return false;
  const deadlineMs = dependencies.deadlineMs ?? PI_SKILL_INVOCATION_VALIDATION_DEADLINE_MS;
  const deadlineAtMs = Number.isSafeInteger(deadlineMs) && deadlineMs >= 0
    ? Date.now() + deadlineMs
    : Date.now();

  if (invocation.scope === 'repo') {
    let loadedMatches = 0;
    for (const skill of manifest.projectResources?.loadedSkills ?? []) {
      if (
        skill.commandName === invocation.runtimeCommandName
        && await runtimeProjectSkillMatchesSource(
          invocationSourcePath,
          skill,
          dependencies,
          deadlineAtMs,
        )
      ) loadedMatches += 1;
      if (loadedMatches > 1) return false;
    }
    return loadedMatches === 1;
  }
  let runtimeMatches = 0;
  for (const command of manifest.commands) {
    if (
      command.name === invocation.runtimeCommandName
      && command.source === 'skill'
      && await runtimeUserSkillMatchesSource(
        invocationSourcePath,
        command,
        dependencies,
        deadlineAtMs,
      )
    ) runtimeMatches += 1;
    if (runtimeMatches > 1) return false;
  }
  return runtimeMatches === 1;
}

export function stalePiSkillInvocationError(): Error & { code: string } {
  return Object.assign(
    new Error('Skill is not loaded from the selected source by the current Pi runtime. Restart or reselect it.'),
    { code: 'PI_SKILL_INVOCATION_STALE' },
  );
}

export function isStalePiSkillInvocationError(error: unknown): boolean {
  return !!error && typeof error === 'object'
    && (error as { code?: unknown }).code === 'PI_SKILL_INVOCATION_STALE';
}

/**
 * Run the last runtime proof and bind it to the exact Session that will receive
 * the message. Callers must not cross another async boundary before delivery.
 */
export async function assertCurrentPiSkillInvocationSession<T>(
  expectedSession: T,
  getCurrentSession: () => T | undefined,
  validate?: () => boolean | void | Promise<boolean | void>,
): Promise<void> {
  try {
    if (validate && await validate() === false) throw stalePiSkillInvocationError();
    if (getCurrentSession() !== expectedSession) throw stalePiSkillInvocationError();
  } catch (error) {
    if (isStalePiSkillInvocationError(error)) throw error;
    throw stalePiSkillInvocationError();
  }
}
