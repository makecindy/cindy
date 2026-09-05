import type { Session } from '@/lib/ccAgent.types';
import { conversationSearchTitle } from '../../../../shared/conversationSearch';
import type { QuickSwitcherSession } from '../../../../shared/quickSwitcher';
import { fuzzyMatch } from './fuzzyMatch';
import {
  groupSessions,
  normalizeWorkingDir,
  projectIdentityKey,
  projectKeyComparisonKey,
  type ProjectNode,
} from './projectGrouping';
import { isProjectHidden } from './sidebarProjectVisibility';
import { sessionActivityMs } from './dateSessionGrouping';

export type QuickSwitcherResult = {
  key: string;
  title: string;
  score: number;
  exact: boolean;
  activity: number;
} & ({ kind: 'project'; project: ProjectNode } | { kind: 'session'; session: Session });

export function quickSwitcherSessionKey(
  session: Pick<Session, 'id' | 'deviceLinkDeviceId'>,
): string {
  return `${session.deviceLinkDeviceId ?? 'local'}:${session.id}`;
}

/** A grouping-only projection. Fetch a real Session before opening; never cache these defaults. */
export function catalogSessionForGrouping(row: QuickSwitcherSession): Session {
  return {
    ...row,
    deviceLinkDeviceId: row.deviceLinkDeviceId ?? undefined,
    deviceLinkDeviceName: row.deviceLinkDeviceName ?? undefined,
    userId: '',
    model: '',
    effort: 'medium',
    permissionMode: 'auto',
    sdkSessionId: null,
    totalTokenUsage: 0,
    totalCostUsd: 0,
    contextTokens: 0,
    contextWindow: 0,
    fastMode: false,
    clearedAt: null,
    extraDirs: [],
  };
}

export function quickSwitcherProjects(
  sessions: readonly Session[],
  aliases: ReadonlyMap<string, string>,
  recent: readonly { path: string; lastUsedAt: string; exists: boolean }[],
  platform: string,
): ProjectNode[] {
  const projects = groupSessions(
    sessions.filter((s) => s.status !== 'deleted' && s.orcaRole !== 'worker'),
    { projectAliases: aliases, includePinnedInProjects: true },
  ).projects;
  const keys = new Set(projects.map((p) => projectKeyComparisonKey(p.projectKey, platform)));
  // Recent directories also represent empty projects. They do not contribute fake tasks.
  for (const dir of recent) {
    if (!dir.exists) continue;
    const workingDir = normalizeWorkingDir(dir.path);
    if (!workingDir) continue;
    const projectKey = projectIdentityKey('local', workingDir, null);
    const key = projectKeyComparisonKey(projectKey, platform);
    if (keys.has(key)) continue;
    keys.add(key);
    projects.push({
      projectKey,
      workingDir,
      scope: 'local',
      remoteHostId: null,
      deviceLinkDeviceId: null,
      deviceLinkDeviceName: null,
      deviceLinkConnectionStatus: null,
      displayName:
        aliases.get(projectKey) ?? workingDir.split('/').filter(Boolean).at(-1) ?? workingDir,
      segments: 1,
      sessions: [],
      latestActivityAt: dir.lastUsedAt,
    });
  }
  return projects;
}

/** Rank the complete catalogue before applying the shared 24-row display limit. */
export function searchQuickSwitcher(args: {
  query: string;
  sessions: readonly Session[];
  projects: readonly ProjectNode[];
  hiddenProjectKeys: ReadonlySet<string>;
  platform: string;
  unnamedLabel: string;
}): { results: QuickSwitcherResult[]; total: number } {
  const query = args.query.trim();
  if (!query) return { results: [], total: 0 };
  const results: QuickSwitcherResult[] = [];
  const rank = (title: string, activity: string) => {
    const match = fuzzyMatch(title, query);
    return match
      ? {
          title,
          score: match.score,
          exact: title.toLowerCase() === query.toLowerCase(),
          activity: Date.parse(activity) || 0,
        }
      : null;
  };
  for (const project of args.projects) {
    if (isProjectHidden(project.projectKey, args.hiddenProjectKeys, args.platform)) continue;
    const baseName = project.workingDir.split('/').filter(Boolean).at(-1) ?? project.displayName;
    const matches = [
      rank(project.displayName, project.latestActivityAt),
      rank(baseName, project.latestActivityAt),
    ]
      .filter((m): m is NonNullable<typeof m> => m !== null)
      .sort((a, b) => Number(b.exact) - Number(a.exact) || b.score - a.score);
    if (matches[0])
      results.push({
        ...matches[0],
        title: project.displayName,
        kind: 'project',
        key: `project:${project.projectKey}`,
        project,
      });
  }
  for (const session of args.sessions) {
    if (session.status === 'deleted' || session.orcaRole === 'worker') continue;
    const title = conversationSearchTitle(session.title, args.unnamedLabel);
    const match = rank(title, new Date(sessionActivityMs(session) || 0).toISOString());
    if (match)
      results.push({
        ...match,
        kind: 'session',
        key: `session:${quickSwitcherSessionKey(session)}`,
        session,
      });
  }
  results.sort(
    (a, b) =>
      Number(b.exact) - Number(a.exact) ||
      b.score - a.score ||
      b.activity - a.activity ||
      a.key.localeCompare(b.key),
  );
  return { results: results.slice(0, 24), total: results.length };
}

export function projectSwitchTarget(
  project: ProjectNode,
  currentKey: string | null,
): Session | null {
  return (
    project.sessions.find((s) => quickSwitcherSessionKey(s) === currentKey) ??
    [...project.sessions]
      .filter((s) => s.status !== 'deleted')
      .sort(
        (a, b) =>
          Number(b.status === 'active') - Number(a.status === 'active') ||
          sessionActivityMs(b) - sessionActivityMs(a) ||
          a.id.localeCompare(b.id),
      )[0] ??
    null
  );
}
