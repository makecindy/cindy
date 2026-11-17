import { groupSessions, type GroupSessionsOptions, type ProjectNode } from '@/features/cc-agent/lib/projectGrouping';
import type { Session } from '@/lib/ccAgent.types';
import { sessionTaskProjectDirectory } from '@cindy/maker-shared/worktree-paths';
import { normalizeWorkingDirForStorage, workingDirComparisonKey } from '../../../../shared/workingDir';
import { projectHash } from './projectHash';

export interface SkillhubScanRoot {
  projectRoot: string;
  hash: string;
  displayName: string;
}

interface ScanCandidate {
  spelling: string;
  kind: 'project-root' | 'cwd';
  projectKey: string;
  displayName: string;
  label: string;
}

/** Keep the original spelling that identifies a SkillHub project independent of activity order. */
export function groupSkillhubSessions(sessions: readonly Session[], options: GroupSessionsOptions) {
  if (options.localPlatform !== 'win32') return groupSessions(sessions, options);

  // groupSessions takes its representative path from the first session. Pick a
  // deterministic original spelling before grouping; that function still orders
  // projects and their sessions by activity. Sort by the same directory
  // groupSessions groups on (sessionTaskProjectDirectory: taskProjectDir, then
  // companion.taskProjectDir, then projectDir/cwd). An alias set that shares one
  // execution directory stays stable too. Do not lowercase paths used for IO.
  const stableSessions = sessions
    .map((session) => ({ session, path: normalizeWorkingDirForStorage(sessionTaskProjectDirectory(session)) ?? '' }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    .map(({ session }) => session);
  return groupSessions(stableSessions, options);
}

function smaller(left: string, right: string): boolean {
  return left < right;
}

function scanLabel(project: ProjectNode, spelling: string): string {
  return spelling === project.workingDir
    ? project.displayName
    : `${project.displayName} · ${spelling.split('/').at(-1)}`;
}

function preferCandidate(candidate: ScanCandidate, current: ScanCandidate): boolean {
  if (candidate.kind !== current.kind) return candidate.kind === 'project-root';
  if (candidate.spelling !== current.spelling) return smaller(candidate.spelling, current.spelling);
  if (candidate.projectKey !== current.projectKey) return smaller(candidate.projectKey, current.projectKey);
  if (candidate.displayName !== current.displayName) return smaller(candidate.displayName, current.displayName);
  return false;
}

/**
 * Choose one original spelling for every scan comparison key across project groups.
 * A project root beats a cwd borrowed from another group. Spelling, project key,
 * and display name break ties of the same kind; activity order does not.
 * Windows output is comparison-key order. POSIX keeps the incoming traversal.
 */
export function selectSkillhubScanRoots(
  projects: readonly ProjectNode[],
  options: { windows: boolean },
): SkillhubScanRoot[] {
  const winners = new Map<string, ScanCandidate>();
  const order: string[] = [];
  for (const project of projects) {
    if (project.scope !== 'local') continue;
    const candidates = [
      { spelling: project.workingDir, kind: 'project-root' as const },
      ...project.sessions.map((session) => ({
        spelling: normalizeWorkingDirForStorage(session.workingDir),
        kind: 'cwd' as const,
      })),
    ];
    for (const candidate of candidates) {
      const spelling = candidate.spelling;
      const key = workingDirComparisonKey(spelling, { windows: options.windows });
      if (!spelling || key === null) continue;
      const next: ScanCandidate = {
        spelling,
        kind: candidate.kind,
        projectKey: project.projectKey,
        displayName: project.displayName,
        label: scanLabel(project, spelling),
      };
      const current = winners.get(key);
      if (!current) {
        winners.set(key, next);
        order.push(key);
      } else if (preferCandidate(next, current)) {
        winners.set(key, next);
      }
    }
  }
  const keys = options.windows
    ? [...winners.keys()].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    : order;
  return keys.map((key) => {
    const winner = winners.get(key)!;
    return {
      projectRoot: winner.spelling,
      hash: projectHash(winner.spelling),
      displayName: winner.label,
    };
  });
}
