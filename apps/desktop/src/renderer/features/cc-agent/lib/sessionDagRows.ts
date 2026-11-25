import { createContext } from 'react';
import { isSharedTaskPeer } from '@cindy/device-link';
import type { Session } from '@/lib/ccAgent.types';

type RemoteOrigin = (id: string) => string | undefined;
type Status = 'active' | 'archived' | 'all';

function ordinary(s: Session) {
  // The local DB is owner-scoped; its mapper deliberately emits userId: ''.
  return typeof s.userId === 'string' && !s.hiddenAt && s.status !== 'deleted' &&
    !s.orcaRole && !s.orcaRemoteLead && !s.companion &&
    (!s.source || s.source === 'desktop' || s.source === 'side-chat');
}

// A promoted side chat keeps its native origin for navigation, not as a DAG edge.
export function sessionDagParent(session: Session) {
  return session.sideChatPromoted ? null : session.parentSessionId;
}

function sameOwner(a: Session, b: Session) {
  return a.userId === b.userId && a.deviceLinkDeviceId === b.deviceLinkDeviceId && (a.remoteHostId ?? null) === (b.remoteHostId ?? null);
}

function missingParents(frontier: readonly Session[], known: ReadonlySet<string>, remote: RemoteOrigin) {
  const missing = new Map<string, Session[]>();
  for (const child of frontier) {
    const id = sessionDagParent(child);
    if (!id || known.has(id) || child.deviceLinkDeviceId || !ordinary(child) || remote(child.id) || remote(id)) continue;
    const siblings = missing.get(id);
    if (siblings) siblings.push(child);
    else missing.set(id, [child]);
  }
  return missing;
}

// Key the request by identity/lineage, not by previews, pin order or streamed activity.
export function missingSessionDagKey(rows: readonly Session[], remote: RemoteOrigin): string {
  const known = new Set(rows.map(s => s.id));
  const missing = missingParents(rows, known, remote);
  if (!missing.size) return '';
  // A previously loaded grandparent may itself move off-page.
  return JSON.stringify([[...known].sort(), [...missing.values()].flatMap(children => children.map(s =>
    JSON.stringify([s.parentSessionId, s.userId, s.remoteHostId ?? null]))).sort()]);
}

// Resolve just the missing ancestors via the owner-bound ordinary-list ID subset.
// No history reads, foreign transports, full-db scans, or persistent ancestry cache.
export async function readSessionDagAncestors(rows: readonly Session[], read: (ids: string[]) => Promise<Session[]>,
  remote: RemoteOrigin, current: () => boolean): Promise<Session[]> {
  const known = new Set(rows.map(s => s.id));
  let frontier = rows;
  const result: Session[] = [];
  while (current()) {
    const missing = missingParents(frontier, known, remote);
    if (!missing.size) break;
    const ids = [...missing.keys()];
    const next: Session[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      if (!current()) return [];
      const batch = ids.slice(i, i + 100);
      for (const id of batch) known.add(id);
      let page: Session[];
      try { page = await read(batch); }
      catch { continue; } // Keep these native rows; unrelated families can still resolve.
      if (!current()) return [];
      for (const parent of page) {
        if (batch.includes(parent.id) && !parent.deviceLinkDeviceId && ordinary(parent) && !remote(parent.id) &&
          missing.get(parent.id)?.some(child => sameOwner(parent, child))) next.push(parent);
      }
    }
    result.push(...next);
    frontier = next;
  }
  return current() ? result : [];
}

export interface SessionDagIndex {
  readonly roots: ReadonlyMap<string, Session>;
  readonly branches: ReadonlyMap<string, readonly Session[]>;
}
export const EMPTY_SESSION_DAG: SessionDagIndex = { roots: new Map(), branches: new Map() };
export const SidebarDagBranches = createContext<SessionDagIndex>(EMPTY_SESSION_DAG);

// Traverse only verified FK edges. Cycles (including their descendants) have no
// reachable anchor. An orphan anchors its real descendants, never a guessed parent.
export function buildSessionDagIndex(rows: readonly Session[], status: Status, remote: RemoteOrigin): SessionDagIndex {
  const byId = new Map<string, Session>();
  const ambiguous = new Set<string>();
  for (const s of rows) {
    if (byId.has(s.id)) ambiguous.add(s.id);
    else byId.set(s.id, s);
  }
  for (const [id, s] of byId) {
    const device = s.deviceLinkDeviceId;
    if (ambiguous.has(id) || !ordinary(s) || remote(id) !== device ||
      (device && (isSharedTaskPeer(device) || s.deviceLinkConnectionStatus !== 'connected'))) byId.delete(id);
  }
  const children = new Map<string, Session[]>();
  const queue: Session[] = [];
  const roots = new Map<string, Session>();
  for (const s of byId.values()) {
    const id = sessionDagParent(s);
    const p = id && byId.get(id);
    if (!p || !sameOwner(p, s)) queue.push(s);
    else if (children.has(p.id)) children.get(p.id)!.push(s);
    else children.set(p.id, [s]);
  }
  for (let i = 0; i < queue.length; i++) {
    const s = queue[i];
    const anchor = roots.get(s.id) ?? (status === 'all' || s.status === status ? s : undefined);
    for (const child of children.get(s.id) ?? []) {
      if (anchor) roots.set(child.id, anchor);
      queue.push(child);
    }
  }
  const branches = new Map<string, Session[]>();
  for (const s of byId.values()) {
    const root = roots.get(s.id);
    if (!root) continue;
    if (branches.has(root.id)) branches.get(root.id)!.push(s);
    else branches.set(root.id, [s]);
  }
  return { roots, branches };
}

// Resolve a visual selection only. Never rewrite the native URL, message anchor,
// read acknowledgement or the device specified by a deep link.
export function sessionDagHighlight(id: string | undefined, device: string | null, index: SessionDagIndex) {
  const root = id && index.roots.get(id);
  return root && (!device || device === root.deviceLinkDeviceId) ? root.id : id;
}

// Before grouping: use the real root's project, status and pin, never the child's.
// Existing roots keep their position; a root outside the page takes its child's slot.
export function projectSessionDagRows(rows: Session[], index: SessionDagIndex): Session[] {
  if (!index.roots.size) return rows;
  const rootFor = (s: Session) => {
    const root = sessionDagParent(s) && ordinary(s) && index.roots.get(s.id);
    return root && sameOwner(s, root) ? root : undefined;
  };
  if (!rows.some(rootFor)) return rows;
  const present = new Set(rows.map(s => s.id));
  return rows.flatMap(s => {
    const root = rootFor(s);
    if (!root) return [s];
    if (present.has(root.id)) return [];
    present.add(root.id);
    return [root];
  });
}
