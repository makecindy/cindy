import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HeadlessInputQueue } from './input-queue.js';
import { HeadlessSessionStorage } from './session-storage.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-headless-input-queue-'));
  dirs.push(dir);
  const storage = new HeadlessSessionStorage(path.join(dir, 'sessions.db'));
  let busy = false;
  const sent: string[] = [];
  const runtime = {
    send: vi.fn(async (_session, content: string) => { busy = true; sent.push(content); }),
    steer: vi.fn(async () => undefined),
    abort: vi.fn(async () => { busy = false; }),
    isSessionBusy: vi.fn(() => busy),
  };
  const queue = new HeadlessInputQueue(storage, runtime);
  return { storage, queue, runtime, sent, setBusy: (value: boolean) => { busy = value; } };
}

describe('HeadlessInputQueue', () => {
  it('persists queued input, dispatches exactly one turn, then drains on a terminal event', async () => {
    const { storage, queue, sent, setBusy } = fixture();
    await storage.create({ id: 's1', agentKind: 'codex', workDir: '/srv/a', title: 'A', model: 'gpt' });
    await queue.start();

    await queue.enqueue('s1', { clientId: 'one', text: 'first', chatMessage: { content: 'first' } });
    await queue.enqueue('s1', { clientId: 'two', text: 'second', chatMessage: { content: 'second' } });
    await vi.waitFor(() => expect(sent).toEqual(['first']));
    await expect(queue.projection('s1')).resolves.toMatchObject({ pendingQueue: [expect.objectContaining({ clientId: 'two' })] });

    setBusy(false);
    await storage.appendEvent('s1', 'agent_event', { type: 'done', data: {} });
    await vi.waitFor(() => expect(sent).toEqual(['first', 'second']));
    await expect(queue.projection('s1')).resolves.toMatchObject({ pendingQueue: [] });
  });

  it('persists queue mutations and resumes after an explicit pause', async () => {
    const { storage, queue, sent } = fixture();
    await storage.create({ id: 's1', agentKind: 'codex', workDir: '/srv/a', title: 'A', model: 'gpt' });
    await queue.start();
    await queue.stopSession('s1', { keepQueue: true, pauseQueue: true });
    await queue.enqueue('s1', { clientId: 'one', text: 'first' });
    await queue.enqueue('s1', { clientId: 'two', text: 'second' });
    await queue.updateText('s1', 'two', 'second edited');
    await queue.move('s1', 'two', 0);
    expect(sent).toEqual([]);
    await expect(queue.projection('s1')).resolves.toMatchObject({
      queuePaused: true,
      pendingQueue: [expect.objectContaining({ clientId: 'two', text: 'second edited' }), expect.objectContaining({ clientId: 'one' })],
    });

    await queue.resume('s1');
    await vi.waitFor(() => expect(sent).toEqual(['second edited']));
  });

  it('recovers an active entry after a daemon restart instead of losing it', async () => {
    const { storage, queue, sent } = fixture();
    await storage.create({ id: 's1', agentKind: 'codex', workDir: '/srv/a', title: 'A', model: 'gpt' });
    await storage.enqueueInput('s1', 'interrupted', { clientId: 'interrupted', text: 'retry me' });
    await storage.setInputState('s1', 'interrupted', 'active');

    await queue.start();
    await vi.waitFor(() => expect(sent).toEqual(['retry me']));
  });
});
