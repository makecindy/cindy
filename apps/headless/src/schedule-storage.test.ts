import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Scheduler } from '@cindy/maker-scheduler';
import { HeadlessScheduleStorage } from './schedule-storage.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe('HeadlessScheduleStorage', () => {
  it('persists shared scheduler state, atomically claims due fires, and records runs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-headless-schedules-'));
    dirs.push(dir);
    const storage = new HeadlessScheduleStorage(path.join(dir, 'sessions.db'));
    const scheduler = new Scheduler({ storage, runner: { fire: async () => ({ sessionId: 'run-session', resultText: 'finished' }) } });
    const schedule = await scheduler.create({
      name: 'manual task', prompt: 'check status', kind: 'cron', cronExpr: '0 * * * *', timezone: 'UTC', recurring: true,
      manual: true, agentKind: 'codex', model: 'gpt-5.6', useWorktree: false, notify: { desktop: false, feishu: false },
    });
    expect((await storage.get(schedule.id))?.manual).toBe(true);
    await expect(scheduler.runNow(schedule.id)).resolves.toEqual({ runId: expect.any(String) });
    await expect(storage.listRuns(schedule.id)).resolves.toMatchObject([
      { status: 'success', sessionId: 'run-session', resultText: 'finished' },
    ]);
    await expect(storage.claimDueFire(schedule.id, Date.now())).resolves.toBeNull();
    storage.close();
  });

  it('marks only stale running runs interrupted and preserves active heartbeats', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-headless-schedules-'));
    dirs.push(dir);
    const storage = new HeadlessScheduleStorage(path.join(dir, 'sessions.db'));
    await storage.insert({ id: 's1', name: 'task', prompt: 'go', kind: 'cron', cronExpr: '* * * * *', timezone: 'UTC', recurring: true, manual: false, agentKind: 'codex', useWorktree: false, workspaceKind: 'dialogue', notify: { desktop: false, feishu: false }, status: 'active', createdAt: 1, updatedAt: 1 });
    await storage.insertRun({ id: 'stale', scheduleId: 's1', firedAt: 1, status: 'running', heartbeatAt: 1 });
    await storage.insertRun({ id: 'live', scheduleId: 's1', firedAt: 1, status: 'running', heartbeatAt: 10_000 });
    await expect(storage.markRunningAsInterrupted(5_000)).resolves.toEqual(['s1']);
    await expect(storage.listRuns('s1')).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'live', status: 'running' }), expect.objectContaining({ id: 'stale', status: 'interrupted' }),
    ]));
    storage.close();
  });

  it('persists read markers only for completed runs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-headless-schedules-'));
    dirs.push(dir);
    const storage = new HeadlessScheduleStorage(path.join(dir, 'sessions.db'));
    await storage.insert({ id: 's1', name: 'task', prompt: 'go', kind: 'cron', cronExpr: '* * * * *', timezone: 'UTC', recurring: true, manual: false, agentKind: 'codex', useWorktree: false, workspaceKind: 'dialogue', notify: { desktop: false, feishu: false }, status: 'active', createdAt: 1, updatedAt: 1 });
    await storage.insertRun({ id: 'done', scheduleId: 's1', firedAt: 1, status: 'success' });
    await storage.insertRun({ id: 'pending', scheduleId: 's1', firedAt: 2, status: 'running' });

    await expect(storage.markRunRead('done')).resolves.toBe('s1');
    await expect(storage.markRunRead('done')).resolves.toBeNull();
    await expect(storage.markRunRead('pending')).resolves.toBeNull();
    await expect(storage.markScheduleRunsRead('s1')).resolves.toBe(0);
    const runs = await storage.listRuns('s1');
    expect(runs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'done', readAt: expect.any(Number) }),
      expect.objectContaining({ id: 'pending' }),
    ]));
    expect(runs.find((run) => run.id === 'pending')).not.toHaveProperty('readAt');
    storage.close();
  });
});
