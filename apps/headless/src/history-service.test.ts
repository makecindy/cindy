import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HeadlessSessionRuntime } from './session-runtime.js';
import { HeadlessHistoryService } from './history-service.js';
import { HeadlessSessionStorage } from './session-storage.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function storage(): HeadlessSessionStorage {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-headless-history-'));
  dirs.push(dir);
  return new HeadlessSessionStorage(path.join(dir, 'sessions.db'));
}

function fakeRuntime() {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const runtime = {
    isSessionBusy: () => false,
    closeSession: async (...args: unknown[]) => { calls.push({ name: 'close', args }); },
    forkNativeSession: async (...args: unknown[]) => {
      calls.push({ name: 'fork', args });
      return { newSdkSessionId: 'fork-thread', uuidMap: new Map([['a1', 'fork-a1']]) };
    },
    previewNativeRewind: async (...args: unknown[]) => {
      calls.push({ name: 'preview', args });
      return { canRewind: true, filesChanged: ['src/a.ts'], insertions: 2, deletions: 1 };
    },
    commitNativeRewind: async (...args: unknown[]) => { calls.push({ name: 'commit', args }); },
  } as unknown as HeadlessSessionRuntime;
  return { runtime, calls };
}

async function seed(store: HeadlessSessionStorage, agentKind: 'claude-code' | 'codex' = 'claude-code') {
  await store.create({ id: 's1', agentKind, workDir: '/srv/project', title: 'History', model: 'model', sdkSessionId: agentKind === 'codex' ? 'thread-1' : 'sdk-1' });
  await store.appendEvent('s1', 'user_message', { clientId: 'u1', content: 'first question' });
  await store.appendEvent('s1', 'agent_event', { type: 'text', data: { text: 'first answer', isFinal: true }, agentMeta: { uuid: 'a1' } });
  await store.appendEvent('s1', 'user_message', { clientId: 'u2', content: 'second question' });
  await store.appendEvent('s1', 'agent_event', { type: 'text', data: { text: 'second answer', isFinal: true }, agentMeta: { uuid: 'a2' } });
}

describe('HeadlessHistoryService', () => {
  it('deletes display history and invalidates native context atomically for a safe rebuild', async () => {
    const store = storage(); await seed(store);
    const { runtime, calls } = fakeRuntime();
    const service = new HeadlessHistoryService(store, runtime);

    await expect(service.deleteMessage('s1', 'headless-event-4')).resolves.toMatchObject({ clientIds: ['headless-event-4'] });
    expect(calls).toEqual([{ name: 'close', args: ['s1'] }]);
    expect((await store.get('s1'))).toMatchObject({ sdkSessionId: undefined, pendingHandoff: expect.stringContaining('first question') });
    expect((await store.listHistoryMessages('s1')).map((message) => message.clientId)).toEqual(['u1', 'headless-event-2', 'u2']);
    store.close();
  });

  it('forks a native transcript and copies/remaps indexed history through the selected assistant', async () => {
    const store = storage(); await seed(store);
    const { runtime, calls } = fakeRuntime();
    const service = new HeadlessHistoryService(store, runtime);

    const fork = await service.fork('s1', 'headless-event-2');
    expect(fork).toMatchObject({ parentSessionId: 's1', sdkSessionId: 'fork-thread', title: '[Fork] History' });
    expect(calls[0]).toMatchObject({ name: 'fork', args: ['claude-code', expect.objectContaining({ sourceSdkSessionId: 'sdk-1', upToMessageId: 'a1', tailTurnsToDrop: 1 })] });
    const copied = await store.listHistoryMessages(fork.id);
    expect(copied.map((message) => message.content)).toEqual(['first question', 'first answer']);
    expect(copied[1]?.agentMeta).toMatchObject({ uuid: 'fork-a1' });
    store.close();
  });

  it('uses the native rewind primitive then hides the target turn from the structured timeline', async () => {
    const store = storage(); await seed(store, 'codex');
    const { runtime, calls } = fakeRuntime();
    const service = new HeadlessHistoryService(store, runtime);

    await expect(service.previewRewind('s1', 'u2')).resolves.toEqual({ canRewind: true, filesChanged: [], insertions: 0, deletions: 0 });
    await service.commitRewind('s1', 'u2');
    expect(calls).toContainEqual({ name: 'commit', args: [expect.objectContaining({ id: 's1' }), '', '', { tailTurnsToDrop: 1 }] });
    expect((await store.listHistoryMessages('s1')).map((message) => message.clientId)).toEqual(['u1', 'headless-event-2']);
    store.close();
  });

  it('derives Claude user anchors from the following assistant transcript metadata for real file previews', async () => {
    const store = storage();
    await store.create({ id: 's1', agentKind: 'claude-code', workDir: '/srv/project', title: 'Claude', model: 'claude', sdkSessionId: 'sdk-1' });
    await store.appendEvent('s1', 'user_message', { clientId: 'u1', content: 'change it' });
    await store.appendEvent('s1', 'agent_event', {
      type: 'text', data: { text: 'done', isFinal: true }, agentMeta: { uuid: 'a1', transcriptParentUuid: 'native-u1' },
    });
    const { runtime, calls } = fakeRuntime();
    const service = new HeadlessHistoryService(store, runtime);

    await expect(service.previewRewind('s1', 'u1')).resolves.toEqual({ canRewind: true, filesChanged: ['src/a.ts'], insertions: 2, deletions: 1 });
    expect(calls).toContainEqual({ name: 'preview', args: [expect.objectContaining({ id: 's1' }), 'native-u1'] });
    store.close();
  });
});
