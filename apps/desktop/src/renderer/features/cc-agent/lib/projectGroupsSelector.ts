import type { Session } from '@/lib/ccAgent.types';
import {
  groupSessions,
  type GroupSessionsOptions,
  type PersistentLocalProject,
  type ProjectGroupsResult,
} from './projectGrouping';

// These fields are displayed by rows, but do not determine membership, names,
// or ordering. Unknown/new fields deliberately fall back to full grouping.
const ROW_ONLY_FIELDS = new Set([
  'title',
  'preview',
  'summary',
  'totalCostUsd',
  'totalMoney',
  'totalTokenUsage',
  'contextTokens',
  'contextWindow',
  'updatedAt',
]);

function sameGroupingInput(a: Session, b: Session): boolean {
  if ((a.userSendAt ?? a.updatedAt) !== (b.userSendAt ?? b.updatedAt)) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (!ROW_ONLY_FIELDS.has(key) && a[key as keyof Session] !== b[key as keyof Session]) {
      return false;
    }
  }
  return true;
}

function samePersistentProjects(
  a: readonly PersistentLocalProject[] | undefined,
  b: readonly PersistentLocalProject[] | undefined,
): boolean {
  return (
    a === b ||
    (!!a &&
      !!b &&
      a.length === b.length &&
      a.every((p, i) => {
        const next = b[i];
        return (
          p.workingDir === next.workingDir &&
          p.lastUsedAt === next.lastUsedAt &&
          p.knownAgentKinds.length === next.knownAgentKinds.length &&
          p.knownAgentKinds.every((kind, j) => kind === next.knownAgentKinds[j])
        );
      }))
  );
}

function sameOptions(a: GroupSessionsOptions, b: GroupSessionsOptions): boolean {
  return (
    a.projectAliases === b.projectAliases &&
    a.includePinnedInProjects === b.includePinnedInProjects &&
    a.includeDraftsInProjects === b.includeDraftsInProjects &&
    a.localPlatform === b.localPlatform &&
    a.botOwnerBySessionId === b.botOwnerBySessionId &&
    samePersistentProjects(a.persistentLocalProjects, b.persistentLocalProjects)
  );
}

/** One previous projection per hook; no global cache or retained session history.
 * Timestamp/preview/spend updates replace the affected row in its existing group.
 * All other changes use the canonical algorithm, including draft time fallback,
 * identity, pinning, aliases, bot ownership and remote connection state.
 */
export function createProjectGroupsSelector() {
  let previous:
    | {
        sessions: readonly Session[];
        options: GroupSessionsOptions;
        result: ProjectGroupsResult;
      }
    | undefined;

  return (sessions: readonly Session[], options: GroupSessionsOptions): ProjectGroupsResult => {
    let result: ProjectGroupsResult | undefined;
    if (
      previous &&
      sameOptions(previous.options, options) &&
      previous.sessions.length === sessions.length
    ) {
      const replacements = new Map<Session, Session>();
      const reusable = sessions.every((session, i) => {
        const old = previous!.sessions[i];
        if (old === session) return true;
        if (!sameGroupingInput(old, session)) return false;
        replacements.set(old, session);
        return true;
      });
      if (reusable) {
        const replaceRows = (rows: Session[]): Session[] =>
          rows.some((row) => replacements.has(row))
            ? rows.map((row) => replacements.get(row) ?? row)
            : rows;
        const replaceGroups = <T extends { sessions: Session[] }>(groups: T[]): T[] => {
          let changed = false;
          const next = groups.map((group) => {
            const rows = replaceRows(group.sessions);
            if (rows === group.sessions) return group;
            changed = true;
            return { ...group, sessions: rows };
          });
          return changed ? next : groups;
        };
        result =
          replacements.size === 0
            ? previous.result
            : {
                pinned: replaceRows(previous.result.pinned),
                dialogues: replaceRows(previous.result.dialogues),
                unclassified: replaceRows(previous.result.unclassified),
                bots: replaceGroups(previous.result.bots),
                projects: replaceGroups(previous.result.projects),
              };
      }
    }
    result ??= groupSessions(sessions, options);
    previous = { sessions, options, result };
    return result;
  };
}
