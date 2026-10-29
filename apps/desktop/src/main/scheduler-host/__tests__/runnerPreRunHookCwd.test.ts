/**
 * runner.fire 前置检查脚本(Pre-run Hook)的 cwd 解析回归:
 *   - heartbeat(绑定会话)任务 schedule.workingDir 通常为空,hook 必须在绑定
 *     会话 meta.workDir 下执行 —— 否则回落 homedir,仓库相关检查会失败并阻止任务
 *     (PR #608 review thread:Resolve heartbeat workdir before running hooks)。
 *   - 显式 workingDir 任务保持原行为,不额外查 meta。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { Maker } from '@cindy/maker-core';
import type { FireContext, Logger, Notifier, Schedule } from '@cindy/maker-scheduler';

const mocks = vi.hoisted(() => ({
  executePreRunHook: vi.fn(),
  formatPreRunHookFailure: vi.fn(() => 'pre-run hook failed with exit code 1'),
  buildSkipResultText: vi.fn(() => 'skipped'),
  createMessage: vi.fn(),
  getSessionRowSnapshot: vi.fn(),
  restoreArchivedSessionForSend: vi.fn(),
  getManagedWorktreeReadinessForSession: vi.fn(),
  ensureDialogueWorkspaceDir: vi.fn(),
  wireSessionToIpc: vi.fn(),
  resolveWorkingDir: vi.fn(),
  backfillSessionMeta: vi.fn(),
}));

vi.mock('../pre-run-hook', () => ({
  executePreRunHook: mocks.executePreRunHook,
  formatPreRunHookFailure: mocks.formatPreRunHookFailure,
  buildSkipResultText: mocks.buildSkipResultText,
}));
vi.mock('../../localDb/ipc/messages.js', () => ({
  createMessage: mocks.createMessage,
}));
vi.mock('../../localDb/ipc/sessions.js', () => ({
  getSessionRowSnapshot: mocks.getSessionRowSnapshot,
  getSessionRowSnapshotStrict: mocks.getSessionRowSnapshot,
  restoreArchivedSessionForSend: mocks.restoreArchivedSessionForSend,
  touchUserSendInDb: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../worktree/restore', () => ({
  getManagedWorktreeReadinessForSession: mocks.getManagedWorktreeReadinessForSession,
}));
vi.mock('../../localDb/dialogueWorkspace', () => ({
  ensureDialogueWorkspaceDir: mocks.ensureDialogueWorkspaceDir,
}));
vi.mock('../../maker-ipc/register.js', () => ({
  wireSessionToIpc: mocks.wireSessionToIpc,
  isSessionInTurn: () => false,
  noteSilentStopUserSend: vi.fn(),
  onSilentStopSettled: vi.fn(() => () => {}),
}));
vi.mock('../workdir-resolver', () => ({
  resolveWorkingDir: mocks.resolveWorkingDir,
}));
vi.mock('../runners/_shared', () => ({
  backfillSessionMeta: mocks.backfillSessionMeta,
}));

import { MakerScheduleRunner } from '../runner';

function baseSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'schedule-1',
    name: 'hook task',
    prompt: 'do the thing',
    jobType: 'prompt',
    source: 'user',
    kind: 'cron',
    cronExpr: '*/10 * * * *',
    timezone: 'Asia/Shanghai',
    recurring: true,
    manual: false,
    agentKind: 'codex',
    workspaceKind: 'project',
    useWorktree: false,
    notify: { desktop: true, feishu: false },
    status: 'active',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    preRunHook: { command: 'node scripts/check.mjs' },
    ...overrides,
  };
}

function createFireContext(): FireContext {
  return {
    runId: 'run-1',
    firedAt: 1_700_000_000_100,
    signal: new AbortController().signal,
    onPreRunHookCompleted: vi.fn(async () => undefined),
  };
}

function createRunner(getSessionMeta: Maker['getSessionMeta']) {
  const notifier: Notifier = { notify: vi.fn(async () => undefined) };
  const logger: Logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  const maker = {
    createSession: vi.fn(),
    getSessionMeta,
    isSessionAlive: vi.fn(() => false),
    closeSession: vi.fn(async () => undefined),
  } as unknown as Maker;
  const runner = new MakerScheduleRunner({
    maker,
    getDb: () => ({}) as never,
    notifier,
    logger,
  });
  return { runner, maker, notifier };
}

describe('MakerScheduleRunner pre-run hook cwd 解析', () => {
  it.each(['deleted'])('stops a %s heartbeat before running any hook', async (status) => {
    mocks.getSessionRowSnapshot.mockResolvedValueOnce({ status });
    const { runner, notifier } = createRunner(vi.fn() as never);
    const pause = vi.fn(async () => undefined);
    runner.attachScheduler({ pause } as never);
    const result = await runner.fire(baseSchedule({ targetSessionId: 'retired-session' }), createFireContext());
    expect(result).toMatchObject({ skipped: true });
    expect(pause).toHaveBeenCalledWith('schedule-1', { exemptRunId: 'run-1' });
    expect(mocks.executePreRunHook).not.toHaveBeenCalled();
    expect(notifier.notify).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionRowSnapshot.mockReset();
    mocks.restoreArchivedSessionForSend.mockReset();
    mocks.getManagedWorktreeReadinessForSession.mockResolvedValue('ready');
    // hook 判 skip → fire 在 hook 分支内早退,不进 session 创建,测试聚焦 cwd 传参
    mocks.executePreRunHook.mockResolvedValue({
      status: 'skipped',
      decision: 'skip',
      exitCode: 2,
      timedOut: false,
      spawnError: undefined,
      durationMs: 5,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      aborted: false,
    });
    mocks.buildSkipResultText.mockReturnValue('skipped');
  });

  // User decision 2026-10-23: scheduled input restores an archived task like a
  // user message. Existing tests retired it before hooks. Minimal unit case:
  // archived target with a recycled managed worktree; hook must see restored files.
  it.each([false, true])('restores the same archived task and its worktree before the hook (persistent=%s)', async (persistentSession) => {
    const target = { status: 'archived', workingDir: '/repo/.cindy-worktrees/task' };
    mocks.getSessionRowSnapshot.mockImplementation(async () => ({ ...target }));
    mocks.restoreArchivedSessionForSend.mockImplementation(async () => { target.status = 'active'; });
    mocks.getManagedWorktreeReadinessForSession.mockImplementation(async () => {
      expect(target.status).toBe('active');
      return 'ready';
    });
    mocks.executePreRunHook.mockImplementation(async () => {
      expect(target.status).toBe('active');
      expect(mocks.getManagedWorktreeReadinessForSession).toHaveBeenCalledWith('owner', target.workingDir);
      return { decision: 'skip', exitCode: 2 };
    });
    const { runner, maker } = createRunner(vi.fn(async () => ({ workDir: target.workingDir })) as never);
    const pause = vi.fn();
    const update = vi.fn();
    runner.attachScheduler({ pause, update } as never);
    await expect(runner.fire(baseSchedule({ targetSessionId: 'owner', persistentSession }), createFireContext()))
      .resolves.toMatchObject({ skipped: true });
    expect(target.status).toBe('active');
    expect(pause).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(maker.createSession).not.toHaveBeenCalled();
  });

  // PR #6864: source=user schedules can target managed sessions too. The target's
  // lifecycle, not just the schedule source, must keep archive retirement intact.
  it.each([
    { source: 'bot' },
    { orcaRole: 'worker' },
    { orcaRemoteLead: '{"leadSessionId":"lead"}' },
    { source: 'review' },
  ])('retires an archived managed target before hooks: %j', async (managed) => {
    const target = { status: 'archived', ...managed };
    mocks.getSessionRowSnapshot.mockResolvedValue(target);
    const { runner, maker } = createRunner(vi.fn() as never);
    const pause = vi.fn();
    runner.attachScheduler({ pause } as never);
    await expect(runner.fire(baseSchedule({ targetSessionId: 'owner' }), createFireContext()))
      .resolves.toMatchObject({ skipped: true });
    expect(pause).toHaveBeenCalledWith('schedule-1', { exemptRunId: 'run-1' });
    expect(target.status).toBe('archived');
    expect(mocks.restoreArchivedSessionForSend).not.toHaveBeenCalled();
    expect(mocks.executePreRunHook).not.toHaveBeenCalled();
    expect(maker.createSession).not.toHaveBeenCalled();
  });

  it('does not run the hook with an unrestored worktree snapshot', async () => {
    const target = { status: 'archived', workingDir: '/repo/.cindy-worktrees/task' };
    mocks.getSessionRowSnapshot.mockImplementation(async () => ({ ...target }));
    mocks.restoreArchivedSessionForSend.mockImplementation(async () => { target.status = 'active'; });
    mocks.getManagedWorktreeReadinessForSession.mockResolvedValue('retry');
    const { runner } = createRunner(vi.fn(async () => ({ workDir: target.workingDir })) as never);
    await expect(runner.fire(baseSchedule({ targetSessionId: 'owner' }), createFireContext()))
      .rejects.toThrow(/worktree/i);
    expect(mocks.executePreRunHook).not.toHaveBeenCalled();
  });

  it.each(['archived', 'deleted'])('does not restore files when a managed target becomes %s while acquiring its route lock', async (status) => {
    const workingDir = '/repo/.cindy-worktrees/task';
    mocks.getSessionRowSnapshot.mockResolvedValueOnce({ status: 'active', workingDir })
      .mockResolvedValue({ status, workingDir });
    const { runner } = createRunner(vi.fn() as never);
    await expect(runner.fire(baseSchedule({ targetSessionId: 'owner' }), createFireContext()))
      .rejects.toThrow(/unavailable/i);
    expect(mocks.restoreArchivedSessionForSend).not.toHaveBeenCalled();
    expect(mocks.getManagedWorktreeReadinessForSession).not.toHaveBeenCalled();
    expect(mocks.executePreRunHook).not.toHaveBeenCalled();
  });

  it('no change starts no model and emits no chat or completion notification', async () => {
    const { runner, maker, notifier } = createRunner(vi.fn(async () => null) as never);
    const context = createFireContext();
    const result = await runner.fire(baseSchedule({ silentWhenIdle: true }), context);
    expect(result.skipped).toBe(true);
    expect(maker.createSession).not.toHaveBeenCalled();
    expect(mocks.createMessage).not.toHaveBeenCalled();
    expect(notifier.notify).not.toHaveBeenCalled();
    expect(context.onPreRunHookCompleted).toHaveBeenCalledOnce();
  });

  it('heartbeat 任务(workingDir 空)→ 先解析绑定会话 meta.workDir 再跑 hook', async () => {
    const getSessionMeta = vi.fn(async () => ({ workDir: '/bound/project' }) as never);
    const { runner } = createRunner(getSessionMeta as never);

    const result = await runner.fire(
      baseSchedule({ targetSessionId: 'sess-bound', workingDir: undefined }),
      createFireContext(),
    );

    expect(result.skipped).toBe(true);
    expect(result.sessionId).toBe('');
    expect(getSessionMeta).toHaveBeenCalledWith('sess-bound');
    expect(mocks.executePreRunHook).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/bound/project',
        stdinPayload: expect.objectContaining({ workingDir: '/bound/project' }),
      }),
    );
  });

  it('heartbeat 任务带过期 workingDir(改绑前的 project 目录)→ 仍以会话 meta.workDir 为准', async () => {
    const getSessionMeta = vi.fn(async () => ({ workDir: '/bound/project' }) as never);
    const { runner } = createRunner(getSessionMeta as never);

    await runner.fire(
      baseSchedule({ targetSessionId: 'sess-bound', workingDir: '/stale/project' }),
      createFireContext(),
    );

    expect(mocks.executePreRunHook).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/bound/project' }),
    );
  });

  it('heartbeat meta 读取失败 → 回落原值(undefined),hook 仍按结果协议执行', async () => {
    const getSessionMeta = vi.fn(async () => {
      throw new Error('session missing');
    });
    const { runner } = createRunner(getSessionMeta as never);

    const result = await runner.fire(
      baseSchedule({ targetSessionId: 'sess-gone', workingDir: undefined }),
      createFireContext(),
    );

    expect(result.skipped).toBe(true);
    expect(mocks.executePreRunHook).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: undefined }),
    );
  });

  it('hook 被 pause/delete abort → fire 抛错(engine 记 aborted),不走 skip 留痕', async () => {
    mocks.executePreRunHook.mockResolvedValue({
      status: 'aborted',
      decision: 'block',
      exitCode: null,
      timedOut: false,
      aborted: true,
      spawnError: undefined,
      durationMs: 300,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
    });
    const { runner } = createRunner(vi.fn(async () => null) as never);

    await expect(
      runner.fire(baseSchedule({ workingDir: '/repo/project' }), createFireContext()),
    ).rejects.toThrow(/aborted/i);
  });

  it('hook 异常会持久化结果并在创建 session 前阻止执行', async () => {
    const hookResult = {
      status: 'failed' as const,
      decision: 'block' as const,
      exitCode: 1,
      timedOut: false,
      aborted: false,
      durationMs: 8,
      stdout: '',
      stderr: 'syntax error',
      stdoutTruncated: false,
      stderrTruncated: false,
    };
    mocks.executePreRunHook.mockResolvedValue(hookResult);
    const { runner, maker, notifier } = createRunner(vi.fn(async () => null) as never);
    const ctx = createFireContext();

    await expect(
      runner.fire(baseSchedule({ workingDir: '/repo/project' }), ctx),
    ).rejects.toThrow(/pre-run hook failed/i);

    expect(ctx.onPreRunHookCompleted).toHaveBeenCalledWith(hookResult);
    expect(maker.createSession).not.toHaveBeenCalled();
    expect(notifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'schedule-1' }),
      expect.objectContaining({ status: 'failed', errorMsg: expect.stringMatching(/pre-run hook/) }),
    );
  });

  it('显式 workingDir 任务 → 直接用任务目录,不查 session meta', async () => {
    const getSessionMeta = vi.fn(async () => null);
    const { runner } = createRunner(getSessionMeta as never);

    await runner.fire(
      baseSchedule({ workingDir: '/repo/project' }),
      createFireContext(),
    );

    expect(getSessionMeta).not.toHaveBeenCalled();
    expect(mocks.executePreRunHook).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/repo/project',
        stdinPayload: expect.objectContaining({ workingDir: '/repo/project' }),
      }),
    );
  });
});
