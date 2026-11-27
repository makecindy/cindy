/**
 * runner.fire 前置检查脚本(Pre-run Hook)的 cwd 解析回归:
 *   - heartbeat(绑定会话)任务 schedule.workingDir 通常为空,hook 必须在绑定
 *     会话 meta.workDir 下执行 —— 否则回落 homedir,仓库相关检查会失败并阻止任务
 *     (PR #608 review thread:Resolve heartbeat workdir before running hooks)。
 *   - 显式 workingDir 任务保持原行为,不额外查 meta。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentEvent, Maker, Session, SessionSendResult } from '@cindy/maker-core';
import type { FireContext, Logger, Notifier, Schedule } from '@cindy/maker-scheduler';
import * as appSessionState from '../../appSessionState.js';
import * as dialogueRecoveryWorkspace from '../../maker-ipc/dialogueRecoveryWorkspace.js';
import { worktreeConversationFallbackDir } from '../../maker-ipc/workingDirectoryRecovery.js';
import { workingDirectoryRecovery } from '../../maker-ipc/workingDirectoryRecovery.desktop.js';
import { configureUserDataDir, getUserDataDir } from '../../userDataPath.js';

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

import { MakerScheduleRunner } from '../runner.desktop';

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
    recyclePiRuntimeIfResourcesDrifted: vi.fn(async () => false),
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

  it('批准快照中的执行目录变化时，在运行前拒绝前置命令', async () => {
    const getSessionMeta = vi.fn(async () => ({ workDir: '/changed/project' }) as never);
    const { runner } = createRunner(getSessionMeta as never);

    await expect(
      runner.fire(
        baseSchedule({ targetSessionId: 'sess-bound', workingDir: undefined }),
        { ...createFireContext(), expectedPreRunWorkingDir: '/approved/project' },
      ),
    ).rejects.toThrow(/execution directory changed/i);

    expect(mocks.executePreRunHook).not.toHaveBeenCalled();
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

  // #8237: confirmed imports retain the same hook execution as authored schedules.
  it.each(['user', 'project'] as const)('显式 workingDir 任务 (%s) → 直接用任务目录,不查 session meta', async (source) => {
    const getSessionMeta = vi.fn(async () => null);
    const { runner } = createRunner(getSessionMeta as never);

    await runner.fire(
      baseSchedule({ workingDir: '/repo/project', source }),
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

  // Rule (2026-11-06): a host status change runs a PR follow-up at once, and its check must know
  // the run was triggered so it skips its own pacing. Minimal input: the same fire with and without
  // ctx.trigger (unit); a cron fire must not carry the field.
  it('passes the host trigger to the hook input only when the run was triggered', async () => {
    const { runner } = createRunner(vi.fn(async () => null) as never);
    const trigger = { kind: 'watch' as const, source: 'pr-status', detail: 'https://github.com/o/r/pull/1' };
    await runner.fire(baseSchedule({ workingDir: '/repo/project' }), { ...createFireContext(), trigger });
    await runner.fire(baseSchedule({ workingDir: '/repo/project' }), createFireContext());
    const payloads = mocks.executePreRunHook.mock.calls.map(([options]) => (options as { stdinPayload: Record<string, unknown> }).stdinPayload);
    expect(payloads[0]).toMatchObject({ trigger });
    expect(payloads[1]).not.toHaveProperty('trigger');
  });

  // Regression (2026-11-26): when a bound task's managed worktree and branch are permanently gone
  // (`ready === 'gone'`), interactive sends already continue in `dialogues/worktree-recovery/<hash>`,
  // but scheduled runs threw `Scheduled task worktree could not be restored` on every fire.
  // Rule: docs/dev-rules/development-workflow.md §2「托管 worktree 不可用时的任务连续性」.
  describe('bound target with permanently gone managed worktree', () => {
    const tempRoots: string[] = [];
    let priorUserDataDir: string;
    let ownerPathSpy: { mockRestore(): void } | null = null;

    async function setupOwnerRoot(): Promise<{ tempRoot: string; ownerRoot: string }> {
      priorUserDataDir = getUserDataDir();
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-sched-wt-fallback-'));
      tempRoots.push(tempRoot);
      const ownerRoot = path.join(tempRoot, 'owners', 'owner-1');
      await fs.mkdir(ownerRoot, { recursive: true });
      configureUserDataDir(tempRoot);
      ownerPathSpy = vi.spyOn(appSessionState, 'ownerScopedUserDataPath').mockImplementation((...parts: string[]) =>
        path.join(ownerRoot, ...parts),
      );
      return { tempRoot, ownerRoot };
    }

    afterEach(async () => {
      workingDirectoryRecovery.clear();
      ownerPathSpy?.mockRestore();
      ownerPathSpy = null;
      if (priorUserDataDir) configureUserDataDir(priorUserDataDir);
      await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    });

    it('falls back to the unrestored-worktree conversation workspace for hooks and stays on it in the same runtime', async () => {
      const { tempRoot, ownerRoot } = await setupOwnerRoot();
      const sessionId = 'gone-hook-owner';
      const missingWorktree = path.join(tempRoot, 'repo', '.cindy-worktrees', 'calm-panini');
      const expectedFallback = worktreeConversationFallbackDir(
        path.join(ownerRoot, 'dialogues'),
        sessionId,
        missingWorktree,
      );
      const target = { status: 'active', workingDir: missingWorktree };
      mocks.getSessionRowSnapshot.mockImplementation(async () => ({ ...target }));
      mocks.getManagedWorktreeReadinessForSession.mockResolvedValue('gone');

      const { runner, maker } = createRunner(vi.fn(async () => ({ workDir: missingWorktree })) as never);

      await expect(
        runner.fire(baseSchedule({ targetSessionId: sessionId }), createFireContext()),
      ).resolves.toMatchObject({ skipped: true });
      expect(mocks.executePreRunHook).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: expectedFallback,
          stdinPayload: expect.objectContaining({ workingDir: expectedFallback }),
        }),
      );
      expect((await fs.stat(expectedFallback)).isDirectory()).toBe(true);
      await expect(fs.stat(missingWorktree)).rejects.toMatchObject({ code: 'ENOENT' });

      // Same process keeps the fallback without re-probing Git worktree restoration.
      await expect(
        runner.fire(baseSchedule({ targetSessionId: sessionId }), createFireContext()),
      ).resolves.toMatchObject({ skipped: true });
      expect(mocks.getManagedWorktreeReadinessForSession).toHaveBeenCalledTimes(1);
      expect(mocks.executePreRunHook).toHaveBeenLastCalledWith(
        expect.objectContaining({ cwd: expectedFallback }),
      );
      expect(maker.createSession).not.toHaveBeenCalled();
    });

    it('starts the bound session in the fallback dir, prepends the recovery note once, and consumes it on accept', async () => {
      const { tempRoot, ownerRoot } = await setupOwnerRoot();
      const sessionId = 'gone-send-owner';
      const missingWorktree = path.join(tempRoot, 'repo', '.cindy-worktrees', 'gone-send');
      const expectedFallback = worktreeConversationFallbackDir(
        path.join(ownerRoot, 'dialogues'),
        sessionId,
        missingWorktree,
      );
      const target = { status: 'active', workingDir: missingWorktree };
      mocks.getSessionRowSnapshot.mockImplementation(async () => ({ ...target }));
      mocks.getManagedWorktreeReadinessForSession.mockResolvedValue('gone');
      mocks.executePreRunHook.mockResolvedValue({
        status: 'passed',
        decision: 'run',
        exitCode: 0,
        timedOut: false,
        aborted: false,
        durationMs: 4,
        stdout: 'changed',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
      });

      const sentContents: string[] = [];
      const listeners: Array<(event: AgentEvent) => void> = [];
      const fakeSession = {
        id: sessionId,
        agentKind: 'codex',
        model: 'gpt-6-astra',
        workDir: expectedFallback,
        send: vi.fn(async (msg: { content: string }, opts?: { onAccepted?: () => Promise<void> }): Promise<SessionSendResult> => {
          sentContents.push(msg.content);
          await opts?.onAccepted?.();
          queueMicrotask(() => {
            for (const listener of [...listeners]) listener({ type: 'done', data: {} });
          });
          return { accepted: true };
        }),
        onEvent(listener: (event: AgentEvent) => void) {
          listeners.push(listener);
          return () => {
            const idx = listeners.indexOf(listener);
            if (idx >= 0) listeners.splice(idx, 1);
          };
        },
        abort: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      } as unknown as Session;

      const { runner, maker } = createRunner(
        vi.fn(async () => ({ workDir: missingWorktree, agentKind: 'codex', model: 'gpt-6-astra' })) as never,
      );
      (maker.createSession as ReturnType<typeof vi.fn>).mockResolvedValue(fakeSession);

      const schedule = baseSchedule({ targetSessionId: sessionId, model: 'gpt-6-astra' });
      await runner.fire(schedule, createFireContext());

      expect(maker.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ id: sessionId, workingDir: expectedFallback }),
      );
      expect(sentContents).toHaveLength(1);
      expect(sentContents[0]).toContain('[Working directory recovery]');
      expect(sentContents[0]).toContain(JSON.stringify(missingWorktree));
      expect(sentContents[0]).toContain(JSON.stringify(expectedFallback));

      // Subsequent run in the same process must not repeat the already-consumed recovery note.
      await runner.fire(schedule, createFireContext());
      expect(sentContents).toHaveLength(2);
      expect(sentContents[1]).not.toContain('[Working directory recovery]');
    });

    it('closes and rebuilds an idle live session on the gone worktree in direct-send mode, and defers while busy', async () => {
      const { tempRoot, ownerRoot } = await setupOwnerRoot();
      const sessionId = 'gone-live-owner';
      const missingWorktree = path.join(tempRoot, 'repo', '.cindy-worktrees', 'gone-live');
      const expectedFallback = worktreeConversationFallbackDir(
        path.join(ownerRoot, 'dialogues'),
        sessionId,
        missingWorktree,
      );
      mocks.getSessionRowSnapshot.mockImplementation(async () => ({
        status: 'active',
        workingDir: missingWorktree,
      }));
      mocks.getManagedWorktreeReadinessForSession.mockResolvedValue('gone');
      mocks.executePreRunHook.mockResolvedValue({
        status: 'passed',
        decision: 'run',
        exitCode: 0,
        timedOut: false,
        aborted: false,
        durationMs: 4,
        stdout: 'changed',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
      });

      let staleTurnRunning = true;
      const sentByDir: Array<{ workDir: string; content: string }> = [];
      const makeSession = (workDir: string, isTurnRunning = () => false): Session => {
        const listeners: Array<(event: AgentEvent) => void> = [];
        return {
          id: sessionId,
          agentKind: 'codex',
          model: 'gpt-6-astra',
          workDir,
          remoteHostId: null,
          isTurnRunning,
          send: vi.fn(async (msg: { content: string }, opts?: { onAccepted?: () => Promise<void> }): Promise<SessionSendResult> => {
            sentByDir.push({ workDir, content: msg.content });
            await opts?.onAccepted?.();
            queueMicrotask(() => {
              for (const listener of [...listeners]) listener({ type: 'done', data: {} });
            });
            return { accepted: true };
          }),
          onEvent(listener: (event: AgentEvent) => void) {
            listeners.push(listener);
            return () => {
              const idx = listeners.indexOf(listener);
              if (idx >= 0) listeners.splice(idx, 1);
            };
          },
          abort: vi.fn(async () => undefined),
          close: vi.fn(async () => undefined),
        } as unknown as Session;
      };

      const activeSessions = new Map<string, Session>([
        [sessionId, makeSession(missingWorktree, () => staleTurnRunning)],
      ]);
      const notifier: Notifier = { notify: vi.fn(async () => undefined) };
      const logger: Logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
      const closeSession = vi.fn(async (id: string) => {
        activeSessions.delete(id);
      });
      const createSession = vi.fn(async (opts: { id: string; workingDir: string }) => {
        // Mirror real Maker.createSession: return an existing active instance unchanged.
        const existing = activeSessions.get(opts.id);
        if (existing) return existing;
        const created = makeSession(opts.workingDir);
        activeSessions.set(opts.id, created);
        return created;
      });
      const maker = {
        createSession,
        getSessionMeta: vi.fn(async () => ({
          workDir: missingWorktree,
          agentKind: 'codex',
          model: 'gpt-6-astra',
        })),
        getSession: vi.fn((id: string) => activeSessions.get(id)),
        isSessionAlive: vi.fn((id: string) => activeSessions.has(id)),
        listActiveSessions: vi.fn(() => [...activeSessions.values()]),
        closeSession,
        recyclePiRuntimeIfResourcesDrifted: vi.fn(async () => false),
      } as unknown as Maker;
      const runner = new MakerScheduleRunner({
        maker,
        getDb: () => ({}) as never,
        notifier,
        logger,
      });

      const schedule = baseSchedule({ targetSessionId: sessionId, model: 'gpt-6-astra' });

      // While the stale live session is still mid-turn, defer instead of killing the turn or consuming the note.
      const busyResult = await runner.fire(schedule, createFireContext());
      expect(busyResult).toMatchObject({ deferred: true });
      expect(closeSession).not.toHaveBeenCalled();
      expect(sentByDir).toHaveLength(0);
      expect(workingDirectoryRecovery.peek(sessionId, missingWorktree)).toContain('[Working directory recovery]');

      // Once idle, close the stale live session and rebuild in the fallback directory before sending.
      staleTurnRunning = false;
      await runner.fire(schedule, createFireContext());
      expect(closeSession).toHaveBeenCalledTimes(1);
      expect(closeSession).toHaveBeenCalledWith(sessionId, 'runtime-refresh');
      expect(createSession).toHaveBeenCalledWith(
        expect.objectContaining({ id: sessionId, workingDir: expectedFallback }),
      );
      expect(sentByDir).toHaveLength(1);
      expect(sentByDir[0]!.workDir).toBe(expectedFallback);
      expect(sentByDir[0]!.content).toContain('[Working directory recovery]');

      // Subsequent fire reuses the already-rebuilt fallback live session without closing it or repeating the note.
      await runner.fire(schedule, createFireContext());
      expect(closeSession).toHaveBeenCalledTimes(1);
      expect(sentByDir).toHaveLength(2);
      expect(sentByDir[1]!.workDir).toBe(expectedFallback);
      expect(sentByDir[1]!.content).not.toContain('[Working directory recovery]');
    });

    it('fails closed when fallback allocation fails, and checks expectedPreRunWorkingDir against the persisted path', async () => {
      const { tempRoot, ownerRoot } = await setupOwnerRoot();
      const missingWorktree = path.join(tempRoot, 'repo', '.cindy-worktrees', 'gone-fail');
      mocks.getSessionRowSnapshot.mockImplementation(async () => ({ status: 'active', workingDir: missingWorktree }));
      mocks.getManagedWorktreeReadinessForSession.mockResolvedValue('gone');

      const allocSpy = vi.spyOn(dialogueRecoveryWorkspace, 'allocateDialogueRecoveryWorkspace')
        .mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
      const { runner } = createRunner(vi.fn(async () => ({ workDir: missingWorktree })) as never);

      await expect(
        runner.fire(baseSchedule({ targetSessionId: 'gone-alloc-fail' }), createFireContext()),
      ).rejects.toThrow(/worktree could not be restored/i);
      expect(mocks.executePreRunHook).not.toHaveBeenCalled();

      allocSpy.mockRestore();

      const sessionId = 'gone-approval-owner';
      const expectedFallback = worktreeConversationFallbackDir(
        path.join(ownerRoot, 'dialogues'),
        sessionId,
        missingWorktree,
      );
      await expect(
        runner.fire(baseSchedule({ targetSessionId: sessionId }), {
          ...createFireContext(),
          expectedPreRunWorkingDir: path.join(tempRoot, 'other-project'),
        }),
      ).rejects.toThrow(/execution directory changed/i);
      expect(mocks.executePreRunHook).not.toHaveBeenCalled();

      await expect(
        runner.fire(baseSchedule({ targetSessionId: sessionId }), {
          ...createFireContext(),
          expectedPreRunWorkingDir: missingWorktree,
        }),
      ).resolves.toMatchObject({ skipped: true });
      expect(mocks.executePreRunHook).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: expectedFallback }),
      );
    });
  });
});
