import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const env = vi.hoisted(() => ({
  owner: 'owner-one',
  generation: 1,
  root: '',
  active: true,
  pending: false,
  projects: ['/cindy'],
  notify: vi.fn(),
  cancel: vi.fn(async () => true),
}));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => `${env.owner}:${env.generation}`,
  ownerScopedUserDataPath: () => env.root,
  isAppSessionBoundaryPending: () => env.pending,
}));
vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: () => ({
    drizzle: {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [
              {
                id: 'bot-one',
                status: env.active ? 'active' : 'deleted',
                sessionId: 'canonical-one',
              },
            ],
          }),
        }),
      }),
    },
  }),
}));
vi.mock('../botWorkbenchService.js', () => ({
  readBotWorkbenchState: async () => ({ directories: env.projects, tasks: {} }),
  broadcastBotWorkbenchChanged: env.notify,
}));
vi.mock('../botRemoteResourceInvalidation.js', () => ({
  broadcastBotRemoteResourceChanged: env.notify,
}));
vi.mock('../botWorkbenchTools.js', () => ({
  resolveWorkbenchCaller: async (id: string) =>
    id === 'canonical-one'
      ? { ok: true, botId: 'bot-one' }
      : { ok: false, errorCode: 'NOT_A_BOT_SESSION' },
}));
vi.mock('../../localDb/agentInputQueueSnapshots.js', () => ({
  saveCancelledInputDelivery: env.cancel,
}));
import {
  configureBotTodoDispatch,
  todoAccess,
  todoForCaller,
  settleBotTodoForSession,
} from '../botTodoAccess';
import { createBotTodoStore } from '../botTodoStore';
import { botProfileDir } from '../botProfileFolder';
import { createBotTodoDispatch } from '../botTodoDispatch';
let root = '';
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'todo-owner-'));
  env.root = root;
  env.owner = 'owner-one';
  env.generation = 1;
  env.active = true;
  env.pending = false;
  env.notify.mockClear();
  env.cancel.mockReset().mockResolvedValue(true);
  configureBotTodoDispatch(async () => ({ ok: true }));
});
afterEach(async () => rm(root, { recursive: true, force: true }));
const patch = {
  key: 'same-feedback',
  title: '修复同一问题',
  outcome: '升级路径验收通过',
  next: {
    kind: 'advance' as const,
    label: '继续验收',
    instruction: '运行隔离数据验收，不发送消息',
  },
};
describe('Todo public access', () => {
  it('enforces current active canonical teammate and owner fences', async () => {
    await expect(todoForCaller('ordinary-session')).rejects.toMatchObject({
      code: 'NOT_A_BOT_SESSION',
    });
    const access = await todoForCaller('canonical-one');
    await access.patch(patch);
    env.owner = 'owner-two';
    await expect(access.list()).rejects.toMatchObject({ code: 'OWNER_SCOPE_CHANGED' });
    env.owner = 'owner-one';
    env.active = false;
    await expect(todoAccess('bot-one')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('checks every scoped source and does not advance rejected events', async () => {
    const access = await todoAccess('bot-one');
    await expect(
      access.ingest({
        source: 'mail',
        sequence: 1,
        patch: {
          ...patch,
          sources: [
            { kind: 'github', id: '1', label: 'Cindy', project: '/cindy' },
            { kind: 'mail', id: '2', label: 'Unrelated', project: '/private' },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: 'SOURCE_OUTSIDE_SCOPE' });
    expect(
      await access.preflight([{ source: 'mail', sequence: 1, key: patch.key, project: '/cindy' }]),
    ).toMatchObject([{ decision: 'review' }]);
  });
  it('single-click dispatches only once and preserves received vs accepted', async () => {
    let resolve: (value: { ok: boolean }) => void = () => {};
    const send = vi.fn(
      (_input: Parameters<Parameters<typeof configureBotTodoDispatch>[0]>[0]) =>
        new Promise<{ ok: boolean }>((r) => {
          resolve = r;
        }),
    );
    configureBotTodoDispatch(send);
    const access = await todoAccess('bot-one'),
      todo = await access.patch(patch);
    const first = access.act(todo.id, todo.revision, 'request-first');
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect((await access.list()).items[0].action?.state).toBe('received');
    await access.act(todo.id, todo.revision, 'request-second');
    expect(send).toHaveBeenCalledOnce();
    resolve({ ok: true });
    await first;
    const saved = (await access.list()).items[0];
    expect(saved.action?.state).toBe('accepted');
    expect(saved.status).toBe('open');
    expect(send.mock.calls[0][0]).toMatchObject({
      sessionId: 'canonical-one',
      requestId: 'request-first',
    });
  });
  it('does not blindly replay an uncertain dispatch', async () => {
    const send = vi.fn(async () => {
      throw new Error('uncertain delivery');
    });
    configureBotTodoDispatch(send);
    const access = await todoAccess('bot-one'),
      todo = await access.patch(patch);
    await expect(access.act(todo.id, todo.revision, 'request-first')).rejects.toThrow('uncertain');
    expect((await access.list()).items[0].action?.state).toBe('unknown');
    await access.act(todo.id, todo.revision, 'request-retry');
    expect(send).toHaveBeenCalledOnce();
  });
  it('keeps queued receipt distinct from dispatch, retries discarded input and ignores duplicate or stale receipts', async () => {
    const send = vi.fn(async () => ({ ok: true, queued: true }));
    const bridge = createBotTodoDispatch(send);
    configureBotTodoDispatch(bridge.dispatch);
    const access = await todoAccess('bot-one'),
      todo = await access.patch(patch);
    const queued = await access.act(todo.id, todo.revision, 'queued-one');
    expect(queued?.action?.state).toBe('received');
    await bridge.settle('different-session', 'queued-one', false);
    expect((await access.list()).items[0].action?.state).toBe('received');
    await bridge.settle('canonical-one', 'queued-one', false);
    expect((await access.list()).items[0].action?.state).toBe('failed');
    await access.act(todo.id, todo.revision, 'queued-two');
    await bridge.settle('canonical-one', 'queued-one', true);
    expect((await access.list()).items[0].action?.state).toBe('received');
    await bridge.settle('canonical-one', 'queued-two', true);
    await bridge.settle('canonical-one', 'queued-two', false);
    expect((await access.list()).items[0].action?.state).toBe('accepted');
    expect((await access.list()).items[0].status).toBe('open');
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('rejects an old-owner queue receipt without writing to either account', async () => {
    const bridge = createBotTodoDispatch(
      async () => ({ ok: true, queued: true }),
      settleBotTodoForSession,
    );
    configureBotTodoDispatch(bridge.dispatch);
    const access = await todoAccess('bot-one'),
      todo = await access.patch(patch);
    await access.act(todo.id, todo.revision, 'old-owner');
    env.owner = 'owner-two';
    env.root = path.join(root, 'other-owner');
    await expect(bridge.settle('canonical-one', 'old-owner', false)).rejects.toMatchObject({
      code: 'OWNER_SCOPE_CHANGED',
    });
    env.owner = 'owner-one';
    env.root = root;
    env.generation++;
    const restoredAccess = await todoAccess('bot-one');
    expect((await restoredAccess.list()).items[0].action?.state).toBe('received');
    await bridge.settle('canonical-one', 'old-owner', false);
    expect((await restoredAccess.list()).items[0].action?.state).toBe('failed');
  });
  it('rebuilds queued associations from disk after losing the dispatch bridge', async () => {
    const old = createBotTodoDispatch(async () => ({ ok: true, queued: true }));
    configureBotTodoDispatch(old.dispatch);
    const access = await todoAccess('bot-one'),
      todo = await access.patch(patch);
    await access.act(todo.id, todo.revision, 'restart-one');
    const restored = createBotTodoDispatch(
      async () => ({ ok: true, queued: true }),
      settleBotTodoForSession,
    );
    configureBotTodoDispatch(restored.dispatch);
    await restored.settle('another-session', 'restart-one', false);
    expect((await access.list()).items[0].action?.state).toBe('received');
    await restored.settle('canonical-one', 'restart-one', false);
    expect((await access.list()).items[0].action?.state).toBe('failed');
    expect(env.cancel).toHaveBeenCalledWith('canonical-one', 'restart-one');
    await access.act(todo.id, todo.revision, 'restart-two');
    // Lose a second bridge while queued; actual dispatch can still resolve the same Todo.
    const again = createBotTodoDispatch(async () => ({ ok: true }), settleBotTodoForSession);
    await again.settle('canonical-one', 'restart-two', true);
    await again.settle('canonical-one', 'restart-two', false);
    expect((await access.list()).items[0].action?.state).toBe('accepted');
    expect((await access.list()).items[0].status).toBe('open');
  });
  it('reconciles orphaned prepare receipts without replaying ambiguous persisted input', async () => {
    const access = await todoAccess('bot-one'),
      todo = await access.patch(patch);
    const disk = createBotTodoStore(
      path.join(botProfileDir(env.root, 'bot-one'), 'todos.v1.json'),
      async () => ({}),
    );
    // Process loss after prepare but before enqueue leaves only the durable Todo receipt.
    await disk.prepareAction(todo.id, todo.revision, 'orphan');
    const inspect = vi.fn(async (_session: string, ids: string[]) =>
      ids.map((requestId) => ({ requestId, state: 'cancelled' as const })),
    );
    const send = vi.fn(async () => ({ ok: true, queued: true }));
    configureBotTodoDispatch(send, inspect);
    expect((await access.list()).items[0].action?.state).toBe('failed');
    await access.act(todo.id, todo.revision, 'after-orphan');
    expect(send).toHaveBeenCalledOnce();
    configureBotTodoDispatch(send, async (_session, ids) =>
      ids.map((requestId) => ({ requestId, state: 'pending' })),
    );
    expect((await access.list()).items[0].action?.state).toBe('received');
    configureBotTodoDispatch(send, async (_session, ids) =>
      ids.map((requestId) => ({ requestId, state: 'unknown' })),
    );
    expect((await access.list()).items[0].action?.state).toBe('unknown');
    await access.act(todo.id, todo.revision, 'no-blind-replay');
    expect(send).toHaveBeenCalledOnce();
  });
  it('does not reconcile an in-process prepare while enqueue is still in flight', async () => {
    let finish!: (r: { ok: boolean; queued: boolean }) => void;
    const send = vi.fn(
      () =>
        new Promise<{ ok: boolean; queued: boolean }>((r) => {
          finish = r;
        }),
    );
    const inspect = vi.fn(async (_session: string, ids: string[]) =>
      ids.map((requestId) => ({ requestId, state: 'cancelled' as const })),
    );
    configureBotTodoDispatch(send, inspect);
    const access = await todoAccess('bot-one'),
      todo = await access.patch(patch);
    const first = access.act(todo.id, todo.revision, 'preparing');
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    await access.act(todo.id, todo.revision, 'preparing');
    expect((await access.list()).items[0].action?.state).toBe('received');
    expect(inspect).not.toHaveBeenCalled();
    finish({ ok: true, queued: true });
    await first;
  });
});

it('successful no-action acknowledgement advances only its source cursor without requiring a Todo', async () => {
  const access = await todoAccess('bot-one');
  expect(await access.ingest({ source: 'mail', sequence: 1, skip: 'no-action' })).toMatchObject({
    duplicate: false,
    todo: null,
  });
  expect(await access.preflight([{ source: 'mail', sequence: 1, key: 'unused' }])).toMatchObject([
    { decision: 'duplicate' },
  ]);
  expect((await access.list()).items).toEqual([]);
});
