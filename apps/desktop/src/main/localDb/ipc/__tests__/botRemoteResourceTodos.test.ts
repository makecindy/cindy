import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const env = vi.hoisted(() => ({ visible: true, current: true, access: vi.fn(), get: vi.fn() }));
vi.mock('../../../agent-island/service.js', () => ({ getAgentIslandService: () => null }));
vi.mock('../../../maker-ipc/botRemoteResourceInvalidation.js', () => ({
  scheduleBotRemoteResourceChangedForSession: vi.fn(),
}));
vi.mock('../../../maker-ipc/workingStatus.js', () => ({ getWorkingStatusCopy: vi.fn() }));
vi.mock('../../client/current.js', () => ({ getDbClient: () => null }));
vi.mock('../../../device-link/broadcast-tap.js', () => ({
  captureDataOwnerBroadcastScope: () => ({}),
  isDataOwnerBroadcastScopeCurrent: () => env.current,
}));
vi.mock('../../../maker-ipc/botTodoAccess.js', () => ({ todoAccess: env.access }));
vi.mock('../bots.js', () => ({
  getBotRemoteResourceSource: env.get,
  listBotRemoteResourceSources: async () => [],
}));
import { createBotTodoStore } from '../../../maker-ipc/botTodoStore';
import { remoteResourceRegistry } from '../../../device-link/remoteResourceRegistry';
import { registerBotRemoteResourceProvider } from '../botRemoteResourceProvider';
let root = '';
const source = {
  id: 'bot-one',
  name: 'Sora',
  description: '',
  avatar: '',
  avatarColor: 'teal',
  status: 'active' as const,
  canonicalSessionId: 'session-one',
  lastMessagePreview: null,
  lastMessageAt: null,
  lastMessageRole: null,
  needsAttention: false,
  hiddenAt: null,
  pinnedAt: null,
  activityAt: 1,
  currentVersion: 1,
  updatedAt: 1,
};
const context = { controllerDeviceId: 'phone' },
  client = { protocolVersion: 1, primitives: ['teammate-todos'], locale: 'zh-CN' },
  ref = { collectionId: 'teammates', kind: 'bot', id: 'todos:bot-one' };
beforeEach(async () => {
  env.visible = true;
  env.current = true;
  env.get.mockReset();
  env.access.mockReset();
  env.get.mockImplementation(async (id: string) =>
    id === 'bot-one' && env.visible ? source : null,
  );
  root = await mkdtemp(path.join(os.tmpdir(), 'remote-todo-'));
  const store = createBotTodoStore(path.join(root, 'todos.v1.json'), async () => ({}));
  env.access.mockImplementation(async () => ({
    list: async () => ({ items: (await store.read()).items, version: 1 }),
    patch: store.patch,
    act: vi.fn(),
  }));
  registerBotRemoteResourceProvider();
});
afterEach(async () => rm(root, { recursive: true, force: true }));
it('uses existing resource get/invoke, preserving the same store across controllers and full-set pagination', async () => {
  const access = await env.access();
  for (let n = 0; n < 36; n++)
    await access.patch({ key: 'k' + n, title: '事务 ' + n, outcome: '验收通过' });
  const get = () =>
    remoteResourceRegistry.get(context, {
      client,
      ref,
      query: JSON.stringify({ offset: 25, query: '事务' }),
    });
  const resource = await get();
  const page = resource.blocks?.[0].data as {
    items: Array<{ id: string; revision: number }>;
    total: number;
  };
  expect(page.total).toBe(36);
  expect(page.items).toHaveLength(11);
  await remoteResourceRegistry.invoke(context, {
    client,
    collectionId: 'teammates',
    resourceRef: ref,
    actionId: 'todo-update',
    input: { id: page.items[0].id, expectedRevision: page.items[0].revision, progress: '手机修改' },
  });
  expect(
    (await access.list()).items.find((t: { id: string }) => t.id === page.items[0].id).progress,
  ).toBe('手机修改');
  await expect(
    remoteResourceRegistry.invoke(context, {
      client,
      collectionId: 'teammates',
      resourceRef: ref,
      actionId: 'todo-update',
      input: { id: page.items[0].id, expectedRevision: 1, progress: '旧修订' },
    }),
  ).rejects.toThrow('CONFLICT');
});
it('does not read invisible teammates or leak a result across account changes', async () => {
  env.visible = false;
  await expect(remoteResourceRegistry.get(context, { client, ref })).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
  expect(env.access).not.toHaveBeenCalled();
  env.visible = true;
  env.access.mockImplementationOnce(async () => ({
    list: async () => {
      env.current = false;
      return { items: [] };
    },
  }));
  await expect(remoteResourceRegistry.get(context, { client, ref })).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
  env.current = true;
  await expect(
    remoteResourceRegistry.invoke(context, {
      client,
      collectionId: 'teammates',
      resourceRef: { ...ref, id: 'other-bot' },
      actionId: 'todo-update',
      input: { title: 'x' },
    }),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
});

it('bounds text fallback independently of legitimate long-page data', async () => {
  const access = await env.access();
  for (let n = 0; n < 25; n++)
    await access.patch({
      key: 'long' + n,
      title: '长说明'.repeat(30),
      outcome: '完成条件',
      progress: '详细进展'.repeat(1000),
    });
  const resource = await remoteResourceRegistry.get(context, { client, ref });
  expect(resource.blocks?.[0].fallbackMarkdown.length).toBeLessThanOrEqual(8000);
  expect((resource.blocks?.[0].data as { items: unknown[] }).items).toHaveLength(25);
});

it('projects host-only paths and metadata out of both reads and update responses while keeping the host record', async () => {
  const access = await env.access();
  const todo = await access.patch({ key: '/host/private/project:bug', title: '反馈', outcome: '验收',
    sources: [{ kind: 'github', id: '/host/private/project:issue', project: '/host/private/project', label: 'Issue', ref: 'https://example.com/issue' }],
    associations: [{ kind: 'pr', id: '/host/private/project:pr', label: 'PR' }],
    next: { kind: 'advance', label: '继续', instruction: 'Read /host/private/project' } });
  const resource = await remoteResourceRegistry.get(context, { client, ref });
  expect(JSON.stringify(resource)).not.toContain('/host/private');
  const items = (resource.blocks?.[0].data as { items: Array<{ id: string; sources: Array<{ project?: string; ref?: string }> }> }).items;
  expect(items[0].id).toBe(todo.id);
  expect(items[0].sources[0].project).toBeUndefined();
  expect(items[0].sources[0].ref).toBe('https://example.com/issue');
  const updated = await remoteResourceRegistry.invoke(context, { client, collectionId: 'teammates', resourceRef: ref,
    actionId: 'todo-update', input: { id: todo.id, expectedRevision: todo.revision, progress: '手机修改' } });
  expect(JSON.stringify(updated)).not.toContain('/host/private');
  expect((await access.list()).items[0].sources[0].project).toBe('/host/private/project');
  expect((await access.list()).items[0].next.instruction).toBe('Read /host/private/project');
});

it('projects the next deferral expiry even when the deferred item is absent from the open page', async () => {
  const access = await env.access();
  await access.patch({ key: 'visible', title: '可见事务', outcome: '核对完成' });
  const later = await access.patch({ key: 'later', title: '稍后事务', outcome: '核对完成' });
  const until = new Date(Date.now() + 60_000).toISOString();
  await access.patch({ id: later.id, expectedRevision: later.revision, operation: 'later', until });
  const resource = await remoteResourceRegistry.get(context, { client, ref });
  const page = resource.blocks?.[0].data as { items: Array<{ id: string }>; nextDeferredAt: string };
  expect(page.items).toHaveLength(1);
  expect(page.items[0].id).not.toBe(later.id);
  expect(page.nextDeferredAt).toBe(until);
});
