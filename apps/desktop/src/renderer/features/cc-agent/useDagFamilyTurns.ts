import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { getSessionDeviceId } from '@/features/device-link/remoteProjectsStore';
import type { Message, Session } from '@/lib/ccAgent.types';
import { parseUserContent } from '@/lib/imageRef';
import { makerChatStore, type ChatMessage } from '@/lib/makerChatStore';
import { listMessagesFor } from '@/lib/makerTransport';
import { parseMessageToolUse } from '@cindy/maker-shared/message-normalize';
import { isContinuationMessage, isSyntheticTriggerText } from '@cindy/maker-shared/synthetic-trigger';
import { isAnsweredAsyncQuestionClientId } from '@cindy/maker-shared/interaction';
import { sessionDagParent } from './lib/sessionDagRows';
import type { DagNode } from './session-dag/types';

type Branch = Pick<Session, 'id' | 'parentSessionId' | 'forkedAtMessageId' | 'createdAt' | 'clearedAt' | 'source' | 'deviceLinkDeviceId'>;
// Retain no tool payloads, thinking, attachment bytes or raw agent metadata.
type Row = { id: string; role: 'user' | 'assistant' | 'agent_switch' | 'tool_use' | 'error'; at: number; order?: number; text: string | null; reply?: string; streaming?: boolean; continuation?: boolean; failedUserId?: string };
type RetryLink = { source: string; replaces?: string };
type RetryBook = Map<string, ReadonlyMap<string, RetryLink>>;
type Pane = { messages?: readonly ChatMessage[]; failed?: string; running?: string; links?: ReadonlyMap<string, RetryLink> };
export type DagSavedRetries = { scope: string; rows: readonly (readonly [string, string, string, string])[] };

// These are display aliases only. They never authorize a retry or a fork.
export function savedDagRetryLinks(saved: DagSavedRetries | undefined, scope: string | null) {
  const result = new Map<string, Map<string, RetryLink>>();
  if (!saved || saved.scope !== scope || !Array.isArray(saved.rows)) return result;
  for (const row of saved.rows) {
    if (!Array.isArray(row) || row.length !== 4 || !row.every(id => typeof id === 'string' && id.length)) continue;
    const [session, clone, source, replaces] = row;
    if (clone === source || clone === replaces) continue;
    const links = result.get(session) ?? new Map<string, RetryLink>();
    links.set(clone, { source, replaces });
    result.set(session, links);
  }
  return result;
}
const projectedRole = (role: Message['role']): role is Row['role'] =>
  role === 'user' || role === 'assistant' || role === 'agent_switch' || role === 'tool_use' || role === 'error';
type History = Map<string, Row[]>;
const EMPTY: DagNode[] = [];

export function dagFamily(sessionId: string, sessions: readonly Session[]): Branch[] {
  const current = sessions.find(s => s.id === sessionId);
  if (!current) return [];
  const byId = new Map<string, Session>();
  const children = new Map<string, Session[]>();
  for (const s of sessions) {
    if (s.userId !== current.userId || s.deviceLinkDeviceId !== current.deviceLinkDeviceId ||
        (s.remoteHostId ?? null) !== (current.remoteHostId ?? null) || s.status === 'deleted' || s.hiddenAt ||
        s.companion || s.orcaRole || s.orcaRemoteLead || (s.source && s.source !== 'desktop' && s.source !== 'side-chat') || byId.has(s.id)) continue;
    byId.set(s.id, s);
    const parent = sessionDagParent(s);
    if (parent) {
      const siblings = children.get(parent) ?? [];
      siblings.push(s);
      children.set(parent, siblings);
    }
  }
  if (!byId.has(sessionId)) return [];
  let root = current;
  const visited = new Set<string>();
  let parent = sessionDagParent(root);
  while (parent && byId.has(parent)) {
    if (visited.has(root.id)) return [];
    visited.add(root.id);
    root = byId.get(parent)!;
    parent = sessionDagParent(root);
  }
  const queue = [root];
  for (let i = 0; i < queue.length; i++) {
    for (const child of (children.get(queue[i].id) ?? []).sort((a, b) => a.id.localeCompare(b.id))) queue.push(child);
  }
  return queue.map(s => ({ id: s.id, parentSessionId: sessionDagParent(s), forkedAtMessageId: s.forkedAtMessageId,
    source: s.source, createdAt: s.createdAt, clearedAt: s.clearedAt, deviceLinkDeviceId: s.deviceLinkDeviceId }));
}

function historyRow(m: Message): Row | null {
  if (!projectedRole(m.role)) return null;
  const meta = m.agentMeta;
  const base = { id: m.clientId, at: Date.parse(m.createdAt), order: m.rowid, reply: meta?.replyToClientId };
  // Native terminal rows may carry the *previous* vendor event's metadata.
  // parentUuid on this row is not evidence that the terminal error is hidden.
  if (m.role === 'error') return { ...base, role: m.role, text: '' };
  const content = m.content;
  const textual = typeof content === 'string' || Array.isArray(content) ||
    (content !== null && typeof content === 'object' && 'text' in content && typeof content.text === 'string');
  const body = m.role === 'tool_use' ? parseMessageToolUse(m).toolName :
    m.role === 'agent_switch' || !textual ? null : m.role === 'assistant' && typeof content === 'string'
    ? content : parseUserContent(content).text;
  const excluded = meta?.parentUuid || meta?.failedSamplingAttempt || meta?.mcpApp || meta?.contextRebuild ||
    meta?.modelChange || meta?.voiceCall || meta?.remoteContentTruncated || (m.role === 'user' && isAnsweredAsyncQuestionClientId(m.clientId));
  const continuation = !excluded && m.role === 'user' && (Boolean(meta?.recoveryCheckpoint?.failedUserClientId) ||
    isContinuationMessage({ role: m.role, content: body, agentMeta: meta }));
  const hidden = excluded || continuation || (m.role === 'user' && isSyntheticTriggerText(body ?? ''));
  return { ...base, role: m.role, text: hidden ? null : body,
    ...(continuation ? { continuation, failedUserId: meta?.recoveryCheckpoint?.failedUserClientId } : {}) };
}

function mergeLive(persisted: readonly Row[], messages: readonly ChatMessage[], clearedAt: string | null): Row[] {
  const merged = new Map(persisted.map(row => [row.id, row]));
  const fence = clearedAt ? Date.parse(clearedAt) : -Infinity;
  const newest = persisted.at(-1)?.at ?? -Infinity;
  for (const m of messages) {
    if (!projectedRole(m.role) || m.role === 'agent_switch') continue;
    const saved = merged.get(m.clientId);
    // The DB is authoritative for closed rows. Overlay just the live tail, never a
    // synthetic/hidden row or an editor's cached pre-clear/pre-rewind history.
    if (saved && !m.isStreaming) continue;
    const at = saved?.at ?? (m.createdAt ? Date.parse(m.createdAt) : Infinity);
    if (!saved && at < newest && !m.isStreaming && !m.isPendingPersist) continue;
    if (at <= fence || saved?.text === null || m.parentToolUseId || m.failedSamplingAttempt) continue;
    const continuation = isContinuationMessage(m);
    if (m.systemCardType && !continuation && !m.isSyntheticTrigger) continue;
    const hidden = m.isSyntheticTrigger || continuation || (m.role === 'user' && isSyntheticTriggerText(m.content));
    if (hidden && m.role !== 'user') continue;
    const text = hidden ? null : m.role === 'tool_use' ? m.toolName ?? null : m.role === 'error' ? '' : m.content;
    merged.set(m.clientId, { id: m.clientId, role: m.role, text, at, order: saved?.order ?? m.rowid, reply: m.replyToClientId, streaming: m.isStreaming, continuation });
  }
  return Array.from(merged.values()).sort((a, b) => a.at - b.at || (a.order ?? Infinity) - (b.order ?? Infinity));
}

// Parent and child client IDs differ after native fork. Identity is the specific
// parent's fork anchor plus the matching ordered prefix, not a global text hash.
// User anchor excludes itself; assistant includes its whole turn up to the next
// user/engine switch. Inherited row aliases survive nested forks at copied rows.
export function projectDagTurns(family: readonly Branch[], histories: ReadonlyMap<string, readonly Row[]>, panes?: ReadonlyMap<string, Pane>, savedLinks?: ReadonlyMap<string, ReadonlyMap<string, RetryLink>>): DagNode[] {
  const nodes: DagNode[] = [];
  const byBranch = new Map(histories);
  for (const branch of family) {
    const messages = panes?.get(branch.id)?.messages;
    const saved = histories.get(branch.id);
    if (saved && messages?.length) byBranch.set(branch.id, mergeLive(saved, messages, branch.clearedAt));
  }
  const indexes = new Map<string, Map<string, { index: number; node?: DagNode }>>();
  for (const branch of family) {
    const pane = panes?.get(branch.id);
    const saved = savedLinks?.get(branch.id);
    const linkFor = (id: string) => saved?.get(id) ?? pane?.links?.get(id);
    const rows = byBranch.get(branch.id) ?? [];
    const parentRows = byBranch.get(branch.parentSessionId ?? '') ?? [];
    const parentIndex = indexes.get(branch.parentSessionId ?? '');
    const anchor = parentIndex?.get(branch.forkedAtMessageId ?? '');
    const index = new Map<string, { index: number; node?: DagNode }>();
    indexes.set(branch.id, index);
    let cursor = 0;
    let previous: string | null = null;
    if (anchor) {
      const isRetry = parentRows[anchor.index].role === 'user';
      previous = (isRetry ? anchor.node?.parentId : anchor.node?.id) ?? null;
      let end = anchor.index;
      if (!isRetry) {
        end++;
        while (end < parentRows.length && parentRows[end].role !== 'user' && parentRows[end].role !== 'agent_switch') end++;
      }
      // Native side chats can shift all inherited timestamps backwards together.
      const offset = branch.source === 'side-chat' && rows.length && end
        ? Math.max(0, parentRows[0].at - rows[0].at) : 0;
      for (; cursor < end && cursor < rows.length; cursor++) {
        const source = parentRows[cursor], copy = rows[cursor];
        if (source.role !== copy.role || source.at - offset !== copy.at || source.text !== copy.text ||
            (branch.source === 'side-chat' && copy.at >= Date.parse(branch.createdAt))) break;
        index.set(copy.id, { index: cursor, node: parentIndex?.get(source.id)?.node });
      }
    }
    let active: DagNode | undefined;
    const originals = new Map<string, DagNode>();
    for (; cursor < rows.length; cursor++) {
      const row = rows[cursor];
      if (row.role === 'user') {
        const link = linkFor(row.id);
        const source = row.failedUserId ?? link?.replaces ?? link?.source;
        const original = source ? index.get(source)?.node ?? (link && index.get(link.source)?.node) ?? originals.get(link?.source ?? source) : active;
        if (row.continuation || (link && (!link.replaces || original?.sessionId === branch.id))) {
          active = original?.sessionId === branch.id ? original : undefined;
          if (active) {
            if (link?.replaces) active.userMessageId = row.id; // Native actions need the surviving row.
            delete active.runState;
          }
        } else {
          active = row.text === null ? undefined : {
            id: JSON.stringify([branch.id, link?.source ?? row.id]), parentId: previous, sessionId: branch.id,
            question: row.text, answer: '', userMessageId: row.id, side: branch.source === 'side-chat' || undefined,
          };
          if (active) {
            nodes.push(active);
            previous = active.id;
            if (link) originals.set(link.source, active);
          }
        }
      }
      const owner = row.role !== 'user' && row.reply && index.has(row.reply) ? index.get(row.reply)?.node : active;
      if (owner?.sessionId === branch.id && row.text !== null) {
        if (row.role === 'assistant' && row.text) {
          owner.answer = owner.answer ? `${owner.answer}\n\n${row.text}` : row.text;
          owner.answerMessageId = row.id;
        }
        if (row.role === 'tool_use' && row.text && !owner.toolText?.split('\n').includes(row.text)) {
          owner.toolText = owner.toolText ? `${owner.toolText}\n${row.text}` : row.text;
        }
        if (row.role === 'error') owner.runState = 'failed';
        else if (row.streaming) owner.runState = 'running';
        else if (row.role === 'assistant' && row.text) delete owner.runState;
      }
      index.set(row.id, { index: cursor, node: owner });
    }
    // A live terminal event first updates the banner, not messages[]. Only
    // the typed recovery target can name the card before its error row arrives.
    const target = pane?.failed ?? pane?.running;
    const liveLink = target ? linkFor(target) : undefined;
    const liveOwner = target && (index.get(target)?.node ?? (liveLink &&
      (index.get(liveLink.replaces ?? liveLink.source)?.node ?? originals.get(liveLink.source) ?? index.get(liveLink.source)?.node)));
    if (liveOwner && liveOwner.sessionId === branch.id) liveOwner.runState = pane?.failed ? 'failed' : 'running';
  }
  return nodes;
}

// Old hosts may shorten a page. An empty page, not a guessed page size, is EOF.
export async function readDagHistory(branch: Branch, current: () => boolean, list = listMessagesFor): Promise<Row[]> {
  const newestFirst: Row[] = [];
  const seen = new Set<string>();
  let before: string | undefined;
  while (current()) {
    if (getSessionDeviceId(branch.id) !== branch.deviceLinkDeviceId) throw new Error('会话所在设备已变化，请重新加载会话图');
    const page: Message[] = await list(branch.id, { limit: 100, before });
    if (!current()) return [];
    if (!page.length) break;
    for (const message of page) {
      if (message.sessionId !== branch.id || !message.id || seen.has(message.id)) throw new Error('历史分页发生变化，请重新加载会话图');
      seen.add(message.id);
      const row = historyRow(message);
      if (row) newestFirst.push(row);
    }
    before = page[page.length - 1].id;
  }
  return newestFirst.reverse();
}

/** Classify the selected native turn in its own timeline, independently of side branches.
 * Read newest first; normally the answer and its user are on the first page. A missing
 * anchor, hidden input or engine transition is not affirmative evidence for a fork. */
export async function dagAnswerPosition(branch: Branch, answerId: string, userId?: string): Promise<'tip' | 'historical' | 'unknown'> {
  if (!answerId) return 'unknown';
  const owner = getDataOwnerGeneration();
  const current = () => isDataOwnerGenerationCurrent(owner) && getSessionDeviceId(branch.id) === branch.deviceLinkDeviceId;
  let before: string | undefined, found = false, firstUser: string | undefined, expectedUser = userId, boundary = false;
  let replyKey: string | undefined, linkedResume = false;
  const visited = new Set<string>();
  while (current()) {
    const page = await listMessagesFor(branch.id, {limit: 32, before});
    if (!current() || !page.length) return 'unknown';
    for (const m of page) {
      if (!m.id || !m.clientId || m.sessionId !== branch.id || visited.has(m.id)) return 'unknown';
      visited.add(m.id);
      if (m.agentMeta?.contextRebuild || m.role === 'agent_switch' || (!found && m.role === 'error')) boundary = true;
      if (m.clientId === answerId) {
        const row = historyRow(m);
        if (row?.role !== 'assistant' || row.text === null) return 'unknown';
        found = true;
        replyKey = row.reply;
      }
      if (m.role !== 'user') continue;
      const input = historyRow(m);
      if (!input || input.text === null) {
        if (found && input?.continuation && input.failedUserId) {
          expectedUser ??= input.failedUserId;
          if (expectedUser !== input.failedUserId) boundary = true;
          else if (m.clientId === replyKey) linkedResume = true;
        } else boundary = true;
        continue;
      }
      firstUser ??= m.clientId;
      if (found) {
        // An older turn's late reply can physically follow a different user question.
        // Forking at that assistant row would inherit the intervening question too.
        if ((expectedUser && expectedUser !== m.clientId) || (replyKey && replyKey !== m.clientId && !linkedResume)) return 'unknown';
        if (firstUser !== m.clientId) return 'historical';
        return boundary ? 'unknown' : 'tip';
      }
    }
    before = page[page.length - 1].id;
  }
  return 'unknown';
}

// Read the native tail again at action time. A filtered or stale canvas is not evidence
// that the selected answer is the last message of its session.
export async function isDagAnswerAtTip(branch: Branch, answerId: string) {
  if (getSessionDeviceId(branch.id) !== branch.deviceLinkDeviceId) throw Error('会话所在设备已变化');
  const [tail] = await listMessagesFor(branch.id, { limit: 1 });
  return tail?.sessionId === branch.id && tail.role === 'assistant' && tail.clientId === answerId;
}

// Keep only host-issued ID pairs for the lifetime of this owner/family view.
// Manual zero-output clones soft-delete the old question + error after dispatch;
// their provenance is in the queue projection, not in the surviving DB row.
export function createDagPaneReader(id: string, book: RetryBook): () => Pane {
  let last: Pane | undefined;
  let lastQueue: ReturnType<typeof makerChatStore.getSnapshot>['pendingQueue'] | undefined;
  return () => {
    const state = makerChatStore.getSnapshot(id);
    const recovery = state.inputRecovery;
    const item = recovery?.kind === 'active-turn' ? recovery.item : undefined;
    const remember = (q: Pick<NonNullable<typeof item>, 'clientId' | 'retrySourceClientId' | 'supersedesUserClientId'>) => {
      const source = q.retrySourceClientId ?? q.supersedesUserClientId;
      if (!source || source === q.clientId || book.get(id)?.has(q.clientId)) return;
      book.set(id, new Map(book.get(id)).set(q.clientId, {source, replaces:q.supersedesUserClientId}));
    };
    if (item) remember(item);
    if (state.pendingQueue !== lastQueue) {
      lastQueue = state.pendingQueue;
      lastQueue.forEach(remember);
    }
    const failed = state.error ? item?.clientId ?? (recovery?.kind === 'queue-head' ? recovery.clientId : undefined) : undefined;
    const running = state.continuationTurnClientId ?? undefined;
    const links = book.get(id);
    if (!last || last.messages !== state.messages || last.failed !== failed || last.running !== running || last.links !== links) {
      last = { messages:state.messages, failed, running, links };
    }
    return last;
  };
}

// Read on each native notification: React can batch away a short-lived queue
// snapshot between enqueue and persistence. Do not start another disk read.
function useTrackedPanes(idsKey: string, book: RetryBook) {
  const store = useMemo(() => {
    const ids: string[] = JSON.parse(idsKey);
    const readers = ids.map(id => [id, createDagPaneReader(id, book)] as const);
    let snapshot = new Map<string, Pane>();
    const read = () => {
      let next = snapshot;
      for (const [id, reader] of readers) {
        const pane = reader();
        if (pane === snapshot.get(id)) continue;
        if (next === snapshot) next = new Map(snapshot);
        next.set(id, pane);
      }
      return snapshot = next;
    };
    const subscribe = (notify: () => void) => {
      const cleanups = readers.map(([id, reader]) => makerChatStore.subscribe(id, () => {
        reader(); notify();
      }));
      return () => cleanups.forEach(stop => stop());
    };
    return { read, subscribe };
  }, [idsKey, book]);
  return useSyncExternalStore(store.subscribe, store.read);
}

export function useDagFamilyTurns(enabled: boolean, sessionId: string | undefined, allSessions: readonly Session[], messages: readonly ChatMessage[], revision: number, activeId?: string, pinnedId?: string, savedRetries?: DagSavedRetries, trackedIds: readonly string[] = []): {
  nodes: DagNode[]; family: readonly Branch[]; loading: boolean; error: string | null; rootId: string | null;
} {
  const owner = getDataOwnerGeneration();
  const familyKey = useMemo(() => JSON.stringify(enabled && sessionId ? dagFamily(sessionId, allSessions) : []), [enabled, sessionId, allSessions]);
  // Sidebar telemetry and streamed tokens must not restart full history reads.
  const family = useMemo<Branch[]>(() => JSON.parse(familyKey), [familyKey]);
  const rootId = family[0]?.id;
  const current = allSessions.find(s => s.id === sessionId);
  const scope = current && rootId ? JSON.stringify([current.userId, current.deviceLinkDeviceId ?? 'local', rootId]) : null;
  const savedLinks = useMemo(() => savedDagRetryLinks(savedRetries, scope), [savedRetries, scope]);
  const book = useMemo<RetryBook>(() => new Map(), [owner, scope]);
  // Live snapshots are owned by the family, not the transient composer used for a send.
  const watched = new Set([sessionId, activeId, pinnedId, ...trackedIds]);
  const livePanes = useTrackedPanes(JSON.stringify(family.filter(s => watched.has(s.id)).map(s => s.id)), book);
  const request = useMemo(() => ({ family, owner, scope, revision }), [family, owner, scope, revision]);
  const [loaded, setLoaded] = useState<{ request: typeof request; histories: History; error: string | null } | null>(null);
  useEffect(() => {
    let disposed = false;
    const current = () => !disposed && isDataOwnerGenerationCurrent(request.owner);
    if (request.family.length) {
      void (async () => {
        const histories: History = new Map();
        let failures = 0;
        for (const branch of request.family) {
          if (!current()) return;
          try { histories.set(branch.id, await readDagHistory(branch, current)); }
          catch { failures++; }
        }
        if (current()) setLoaded({ request, histories, error: failures ? `有 ${failures} 个会话的历史未能完整读取` : null });
      })();
    } else setLoaded(null);
    return () => { disposed = true; };
  }, [request]);
  const valid = loaded?.request === request ? loaded : null;
  // A native fork may be listed before its input is admitted. Preserve existing
  // editors only across an additive family update; removal, reparent, clear,
  // account or origin changes must never expose pre-change history.
  const visible = useMemo(() => {
    if (!loaded || loaded.request.owner !== owner || loaded.request.scope !== scope) return null;
    if (loaded.request.family === family) return loaded.histories;
    if (family.length <= loaded.request.family.length) return null;
    const current = new Map(family.map(b => [b.id, b]));
    return loaded.request.family.every(b => JSON.stringify(current.get(b.id)) === JSON.stringify(b))
      ? loaded.histories : null;
  }, [loaded, family, scope, owner]);
  const nodes = useMemo(() => {
    if (!visible || !sessionId || !family.length) return EMPTY;
    const panes = new Map<string, Pane>();
    for (const [id, links] of book) panes.set(id, { links });
    for (const [id, pane] of livePanes) panes.set(id, pane);
    panes.set(sessionId, { ...livePanes.get(sessionId), messages });
    return projectDagTurns(family, visible, panes, savedLinks);
  }, [visible, family, sessionId, messages, book, livePanes, savedLinks]);
  return { nodes, family, loading: !!family.length && !valid, error: valid?.error ?? null, rootId: family[0]?.id ?? null };
}
