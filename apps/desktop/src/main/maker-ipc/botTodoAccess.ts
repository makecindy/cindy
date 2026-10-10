import path from 'node:path';
import { eq } from 'drizzle-orm';
import {
  TodoError,
  todoActionText,
  preflightTodoEvents,
  type TodoPatch,
  type TeammateTodo,
} from '@cindy/maker-shared/teammate-todo';
import {
  activeOwnerScopeKey,
  isAppSessionBoundaryPending,
  ownerScopedUserDataPath,
} from '../appSessionState.js';
import { getDbClient } from '../localDb/client/current.js';
import { saveCancelledInputDelivery } from '../localDb/agentInputQueueSnapshots.js';
import { botProfiles } from '../localDb/schema.js';
import { botProfileDir } from './botProfileFolder.js';
import { broadcastBotWorkbenchChanged, readBotWorkbenchState } from './botWorkbenchService.js';
import { broadcastBotRemoteResourceChanged } from './botRemoteResourceInvalidation.js';
import { resolveWorkbenchCaller } from './botWorkbenchTools.js';
import { createBotTodoStore, type TodoIngestInput, type TodoIngestResult } from './botTodoStore.js';

export interface BotTodoAccess {
  list(): Promise<{ items: TeammateTodo[]; version: 1 }>;
  patch(input: TodoPatch): Promise<TeammateTodo>;
  ingest(input: TodoIngestInput): Promise<TodoIngestResult>;
  preflight(
    events: Parameters<typeof preflightTodoEvents>[1],
  ): Promise<ReturnType<typeof preflightTodoEvents>>;
  act(
    id: string,
    revision: number,
    requestId: string,
    locale?: string,
  ): Promise<TeammateTodo | null>;
  /** Host lifecycle only; not exposed as a model or Remote Resource action. */
  settle(requestId: string, dispatched: boolean): Promise<void>;
}
export type TodoDispatchResult = { ok: boolean; queued?: boolean; error?: string };
export type TodoDispatchInput = {
  sessionId: string;
  message: string;
  displayText: string;
  requestId: string;
  assertCurrent: () => void;
  canRecover: () => boolean;
  onSettled: (result: { ok: boolean; error?: string }) => Promise<void>;
};
type Dispatch = (p: TodoDispatchInput) => Promise<TodoDispatchResult>;
let dispatch: Dispatch | null = null;
type RecoveryReceipt = { requestId: string; state: 'pending' | 'cancelled' | 'unknown' };
type InspectReceipts = (sessionId: string, requestIds: string[]) => Promise<RecoveryReceipt[]>;
let inspectReceipts: InspectReceipts | null = null;
// Only closes the prepare -> enqueue race within this process. Recovery uses durable records.
const preparing = new Map<string, number>();
export function configureBotTodoDispatch(value: Dispatch, inspect?: InspectReceipts) {
  dispatch = value;
  inspectReceipts = inspect ?? null;
}
export async function todoAccess(botId: string): Promise<BotTodoAccess> {
  const owner = activeOwnerScopeKey(),
    root = ownerScopedUserDataPath();
  const assertCurrent = () => {
    if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== owner)
      throw new TodoError('OWNER_SCOPE_CHANGED');
  };
  assertCurrent();
  const [bot] = await getDbClient()
    .drizzle.select({
      id: botProfiles.id,
      status: botProfiles.status,
      sessionId: botProfiles.canonicalSessionId,
    })
    .from(botProfiles)
    .where(eq(botProfiles.id, botId))
    .limit(1);
  assertCurrent();
  if (!bot || bot.status !== 'active') throw new TodoError('NOT_FOUND');
  const readLegacy = () => readBotWorkbenchState(root, botId);
  const store = createBotTodoStore(
    path.join(botProfileDir(root, botId), 'todos.v1.json'),
    async () => (await readLegacy()).tasks,
    assertCurrent,
  );
  const changed = () => {
    assertCurrent();
    broadcastBotWorkbenchChanged(botId);
    broadcastBotRemoteResourceChanged(botId);
  };
  const attemptKey = (requestId: string) => JSON.stringify([root, botId, requestId]);
  const recoverReceived = async () => {
    const state = await store.read();
    const received = state.items.filter(
      (t) => t.action?.state === 'received' && !preparing.has(attemptKey(t.action.requestId)),
    );
    if (!bot.sessionId || !inspectReceipts || !received.length) return state;
    const receipts = await inspectReceipts(
      bot.sessionId,
      received.map((t) => t.action!.requestId),
    );
    assertCurrent();
    const byRequest = new Map(receipts.map((r) => [r.requestId, r]));
    let saved = false;
    for (const t of received) {
      const receipt = byRequest.get(t.action!.requestId);
      if (!receipt || receipt.state === 'pending' || preparing.has(attemptKey(receipt.requestId)))
        continue;
      const result = await store.settleAction(t.id, receipt.requestId, {
        ok: false,
        uncertain: receipt.state === 'unknown',
        error: receipt.state === 'cancelled' ? 'CANCELLED' : 'DELIVERY_UNCONFIRMED',
      });
      saved ||= result !== null;
    }
    if (saved) changed();
    return saved ? store.read() : state;
  };
  const settle = async (requestId: string, dispatched: boolean) => {
    const t = (await store.read()).items.find(
      (t) => t.action?.requestId === requestId && t.action.state === 'received',
    );
    if (!t || !bot.sessionId) return;
    // A cancellation tombstone fences a stale restored queue before exposing Retry.
    const cancelled = !dispatched && (await saveCancelledInputDelivery(bot.sessionId, requestId));
    assertCurrent();
    if (
      await store.settleAction(t.id, requestId, {
        ok: dispatched,
        uncertain: !dispatched && !cancelled,
        ...(!dispatched ? { error: cancelled ? 'CANCELLED' : 'DELIVERY_UNCONFIRMED' } : {}),
      })
    )
      changed();
  };
  return {
    list: async () => {
      const state = await recoverReceived();
      return { items: state.items, version: 1 as const };
    },
    settle,
    patch: async (p: TodoPatch) => {
      const state = await readLegacy();
      for (const s of p.sources ?? [])
        if (s.project && !state.directories.includes(s.project))
          throw new TodoError('SOURCE_OUTSIDE_SCOPE');
      const saved = await store.patch(p);
      changed();
      return saved;
    },
    ingest: async (p: TodoIngestInput) => {
      const scope = await readLegacy();
      for (const s of p.patch?.sources ?? [])
        if (s.project && !scope.directories.includes(s.project))
          throw new TodoError('SOURCE_OUTSIDE_SCOPE');
      const saved = await store.ingest(p);
      changed();
      return saved;
    },
    preflight: async (events: Parameters<typeof preflightTodoEvents>[1]) =>
      preflightTodoEvents(await store.read(), events, (await readLegacy()).directories),
    act: async (id: string, revision: number, requestId: string, locale?: string) => {
      if (!bot.sessionId || !dispatch) throw new TodoError('HOST_NOT_READY');
      await recoverReceived();
      const key = attemptKey(requestId);
      preparing.set(key, (preparing.get(key) ?? 0) + 1);
      try {
        const prepared = await store.prepareAction(id, revision, requestId);
        changed();
        if (!prepared.dispatch) return prepared.todo;
        assertCurrent();
        const t = prepared.todo;
        const result = await dispatch({
          sessionId: bot.sessionId,
          requestId,
          displayText: todoActionText(
            t.title,
            t.next?.label ?? t.title,
            typeof locale === 'string' ? locale : 'en',
          ),
          message: JSON.stringify({
            kind: 'todo-action',
            todo_id: t.id,
            revision: t.revision,
            next: t.next,
            outcome: t.outcome,
            scope:
              'Advance only this agreed next step under existing permissions. Read the same Todo, preserve sources, and update it after a real receipt. Recording or reading external messages does not authorize sending, spending or broader access.',
          }),
          assertCurrent,
          canRecover: () => !isAppSessionBoundaryPending() && ownerScopedUserDataPath() === root,
          onSettled: async (result) => {
            assertCurrent();
            await settle(requestId, result.ok);
          },
        });
        // Enqueue success is only receipt. Coordinator dispatch/discard settles it later.
        if (result.ok && result.queued)
          return (await store.read()).items.find((item) => item.id === id) ?? null;
        const settled = await store.settleAction(id, requestId, result);
        changed();
        return settled;
      } catch (error) {
        // An uncertain dispatch is never automatically replayed (especially external sends).
        await store.settleAction(id, requestId, {
          ok: false,
          uncertain: true,
          error: error instanceof Error ? error.message : 'UNKNOWN',
        });
        changed();
        throw error;
      } finally {
        const count = (preparing.get(key) ?? 1) - 1;
        if (count) preparing.set(key, count);
        else preparing.delete(key);
      }
    },
  };
}
/** Rebuild the association from this owner's canonical profile and persisted request ID. */
export async function settleBotTodoForSession(
  sessionId: string,
  requestId: string,
  dispatched: boolean,
): Promise<void> {
  const owner = activeOwnerScopeKey();
  if (isAppSessionBoundaryPending()) throw new TodoError('OWNER_SCOPE_CHANGED');
  const [bot] = await getDbClient()
    .drizzle.select({ id: botProfiles.id, sessionId: botProfiles.canonicalSessionId })
    .from(botProfiles)
    .where(eq(botProfiles.canonicalSessionId, sessionId))
    .limit(1);
  if (owner !== activeOwnerScopeKey() || isAppSessionBoundaryPending())
    throw new TodoError('OWNER_SCOPE_CHANGED');
  if (bot?.sessionId === sessionId) await (await todoAccess(bot.id)).settle(requestId, dispatched);
}
export async function todoForCaller(callerSessionId: string): Promise<BotTodoAccess> {
  const owner = activeOwnerScopeKey();
  const caller = await resolveWorkbenchCaller(callerSessionId);
  if (!caller.ok) throw new TodoError(caller.errorCode);
  if (owner !== activeOwnerScopeKey()) throw new TodoError('OWNER_SCOPE_CHANGED');
  return todoAccess(caller.botId);
}
