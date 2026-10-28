import type { Session } from '@/lib/ccAgent.types';
import type { ProjectNode } from './projectGrouping';

export interface SidebarDelegationScope {
  botId: string;
  delegatedSessionIds?: readonly string[];
}

export type SidebarTaskKind = 'ordinary' | 'delegated' | 'unknown';

/** A dated project name is never sufficient evidence that a directory is internal. */
export function isInternalDiagnosticWorkspace(directory: string | null | undefined): boolean {
  const normalized = (directory ?? '').replace(/\\/g, '/');
  return /(?:^|\/)bots\/[^/]+\/workspace\/diagnostics(?:\/|$)/i.test(normalized);
}

export function isLocalPresentationSession(session: Session): boolean {
  return !session.remoteHostId && !session.deviceLinkDeviceId;
}

export function sidebarTaskKind(
  session: Session,
  scopes: readonly SidebarDelegationScope[],
): SidebarTaskKind {
  if (!isLocalPresentationSession(session)) return 'unknown';
  if (scopes.some((scope) => scope.delegatedSessionIds?.includes(session.id))) return 'delegated';
  // Fork and side-chat lineage is distinct from delegation. Never turn a parent pointer
  // or a Bot's general follow responsibility into a delegation claim.
  if (session.parentSessionId && !session.forkedAtMessageId) return 'unknown';
  return 'ordinary';
}

export function shouldCollectSidebarTask(
  session: Session,
  scopes: readonly SidebarDelegationScope[],
): boolean {
  return (
    sidebarTaskKind(session, scopes) === 'delegated' ||
    (isLocalPresentationSession(session) && isInternalDiagnosticWorkspace(session.workingDir))
  );
}

export interface SidebarTaskInput {
  projects: readonly ProjectNode[];
  dialogues: readonly Session[];
  unclassified?: readonly Session[];
  bots?: readonly { botId: string; sessions: Session[] }[];
}

export function partitionSidebarTaskInput<T extends SidebarTaskInput>(
  input: T,
  scopes: readonly SidebarDelegationScope[],
) {
  const collected = new Map<string, Session>();
  const split = (sessions: readonly Session[], internal: boolean) =>
    sessions.filter((session) => {
      const keep = shouldCollectSidebarTask(session, scopes);
      if (keep) collected.set(session.id, session);
      return keep === internal;
    });
  const projects = (internal: boolean) =>
    input.projects.flatMap((project) => {
      const sessions = split(project.sessions, internal);
      const internalDirectory =
        project.scope === 'local' &&
        !project.deviceLinkDeviceId &&
        isInternalDiagnosticWorkspace(project.workingDir);
      // Real registered projects retain their header even when all their tasks are folded.
      if (!sessions.length && (internal || internalDirectory)) return [];
      return [{ ...project, sessions }];
    });
  const bots = (internal: boolean) =>
    (input.bots ?? []).flatMap((bot) => {
      const sessions = split(bot.sessions, internal);
      return sessions.length ? [{ ...bot, sessions }] : [];
    });
  const normal = {
    ...input,
    projects: projects(false),
    dialogues: split(input.dialogues, false),
    unclassified: split(input.unclassified ?? [], false),
    bots: bots(false),
  };
  const internal = {
    ...input,
    projects: projects(true),
    dialogues: split(input.dialogues, true),
    unclassified: split(input.unclassified ?? [], true),
    bots: bots(true),
  };
  return { normal, internal, collected: [...collected.values()] };
}

export interface PresentationPinnedEntry {
  kind: string;
  session?: Session;
  project?: ProjectNode;
  displaySessions?: Session[];
}

export function filterPresentationPinnedEntries<T extends PresentationPinnedEntry>(
  entries: readonly T[],
  scopes: readonly SidebarDelegationScope[],
): T[] {
  return entries.flatMap((entry) => {
    if (entry.kind === 'session' && entry.session) {
      return shouldCollectSidebarTask(entry.session, scopes) ? [] : [entry];
    }
    if (entry.kind === 'project' && entry.project) {
      const project = entry.project;
      const sessions = (entry.displaySessions ?? project.sessions).filter(
        (session) => !shouldCollectSidebarTask(session, scopes),
      );
      if (
        !sessions.length &&
        isInternalDiagnosticWorkspace(project.workingDir) &&
        project.scope === 'local'
      )
        return [];
      return [{ ...entry, project: { ...project, sessions }, displaySessions: sessions }];
    }
    return [entry];
  });
}

/** Pinned tasks are excluded from the main-list input. Add them back only to the
 * folded view; the original pinned flags, order and project identity stay untouched. */
export function includeCollectedPinnedTasks<T extends SidebarTaskInput>(
  input: T,
  entries: readonly PresentationPinnedEntry[],
  scopes: readonly SidebarDelegationScope[],
): T {
  const projects = input.projects.map((project) => ({
    ...project,
    sessions: [...project.sessions],
  }));
  const unclassified = [...(input.unclassified ?? [])];
  const known = new Set(
    [
      ...projects.flatMap((project) => project.sessions),
      ...input.dialogues,
      ...unclassified,
      ...(input.bots ?? []).flatMap((bot) => bot.sessions),
    ].map((session) => session.id),
  );
  for (const entry of entries) {
    const candidates = entry.session
      ? [entry.session]
      : (entry.displaySessions ?? entry.project?.sessions ?? []);
    for (const session of candidates) {
      if (known.has(session.id) || !shouldCollectSidebarTask(session, scopes)) continue;
      known.add(session.id);
      const project = projects.find(
        (project) =>
          project.workingDir === session.workingDir &&
          project.remoteHostId === (session.remoteHostId ?? null) &&
          project.deviceLinkDeviceId === (session.deviceLinkDeviceId ?? null),
      );
      if (project) project.sessions.push(session);
      else if (entry.project) projects.push({ ...entry.project, sessions: [session] });
      else unclassified.push(session);
    }
  }
  return { ...input, projects, unclassified };
}
