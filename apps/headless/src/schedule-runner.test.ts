import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Schedule } from '@cindy/maker-scheduler';
import { HeadlessScheduleRunner } from './schedule-runner.js';
import { HeadlessSessionStorage } from './session-storage.js';
import type { HeadlessSessionRuntime } from './session-runtime.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe('HeadlessScheduleRunner', () => {
  it('creates a durable session and waits for its terminal agent event', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-headless-schedule-runner-'));
    dirs.push(dir);
    const storage = new HeadlessSessionStorage(path.join(dir, 'sessions.db'));
    const runtime: HeadlessSessionRuntime = {
      send: async (session) => { await storage.appendEvent(session.id, 'agent_event', { type: 'text', data: 'completed ' }); await storage.appendEvent(session.id, 'agent_event', { type: 'done', data: {} }); },
      steer: async () => undefined, abort: async () => undefined, closeSession: async () => undefined, resolveInteraction: async () => false, reconfigure: async () => undefined, setOrcaRole: async () => undefined,
      isSessionBusy: () => false, isAnySessionBusy: () => false, close: async () => undefined,
    };
    const runner = new HeadlessScheduleRunner(storage, runtime, path.join(dir, 'state'));
    const bound: string[] = [];
    const result = await runner.fire(schedule(), { runId: 'run1', firedAt: Date.now(), signal: new AbortController().signal, onSessionBound: (id) => { bound.push(id); } });
    expect(result).toMatchObject({ sessionId: expect.any(String), resultText: 'completed ' });
    expect(bound).toEqual([result.sessionId]);
    expect(await storage.get(result.sessionId)).toMatchObject({ title: '[Schedule] task' });
    storage.close();
  });
});

function schedule(): Schedule {
  return { id: 'schedule1', name: 'task', prompt: 'do it', kind: 'cron', cronExpr: '* * * * *', timezone: 'UTC', recurring: true, manual: false, agentKind: 'codex', model: 'gpt-5.6', useWorktree: false, workspaceKind: 'dialogue', notify: { desktop: false, feishu: false }, status: 'active', createdAt: 1, updatedAt: 1 };
}
