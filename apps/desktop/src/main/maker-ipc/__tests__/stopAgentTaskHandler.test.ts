import { describe, expect, it, vi } from 'vitest';

import { createIpcError } from '../../../shared/ipc-errors';
import { MAKER_INVOKE } from '../channels';
import { registerStopAgentTaskHandler } from '../stopAgentTaskHandler';
import { IpcHarness } from './helpers/ipcHarness';

describe('stop agent task IPC handler', () => {
  it('validates sessionId and taskId before touching the session', async () => {
    const harness = new IpcHarness();
    const getLiveSession = vi.fn();
    registerStopAgentTaskHandler(harness, { getLiveSession });

    await expect(
      harness.invoke(MAKER_INVOKE.STOP_AGENT_TASK, undefined, 'task-1'),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(
      harness.invoke(MAKER_INVOKE.STOP_AGENT_TASK, 'session-1', ''),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(getLiveSession).not.toHaveBeenCalled();
  });

  it('stops the named task on the live session', async () => {
    const harness = new IpcHarness();
    const stopBackgroundTask = vi.fn().mockResolvedValue(undefined);
    registerStopAgentTaskHandler(harness, {
      getLiveSession: vi.fn(() => ({ stopBackgroundTask })),
    });

    await expect(
      harness.invoke(MAKER_INVOKE.STOP_AGENT_TASK, 'session-1', 'task-1'),
    ).resolves.toEqual({ ok: true });
    expect(stopBackgroundTask).toHaveBeenCalledWith('task-1');
  });

  it('is idempotent when neither a live session nor a detached task is found', async () => {
    const harness = new IpcHarness();
    registerStopAgentTaskHandler(harness, { getLiveSession: vi.fn(() => undefined) });

    await expect(
      harness.invoke(MAKER_INVOKE.STOP_AGENT_TASK, 'session-1', 'task-1'),
    ).resolves.toEqual({ ok: true });
  });

  it('stops a detached task even when its parent session handle is unloaded', async () => {
    const harness = new IpcHarness();
    const stopDetachedTask = vi.fn().mockResolvedValue(true);
    registerStopAgentTaskHandler(harness, {
      getLiveSession: vi.fn(() => undefined),
      stopDetachedTask,
    });

    await expect(
      harness.invoke(MAKER_INVOKE.STOP_AGENT_TASK, 'session-1', 'task-1'),
    ).resolves.toEqual({ ok: true });
    expect(stopDetachedTask).toHaveBeenCalledWith('session-1', 'task-1');
  });

  it('prefers an exact detached PI task after the live session switched harnesses', async () => {
    const harness = new IpcHarness();
    const stopDetachedTask = vi.fn().mockResolvedValue(true);
    const stopBackgroundTask = vi.fn().mockResolvedValue(undefined);
    registerStopAgentTaskHandler(harness, {
      getLiveSession: vi.fn(() => ({ stopBackgroundTask })),
      stopDetachedTask,
    });

    await expect(
      harness.invoke(MAKER_INVOKE.STOP_AGENT_TASK, 'session-1', 'old-pi-task'),
    ).resolves.toEqual({ ok: true });
    expect(stopDetachedTask).toHaveBeenCalledWith('session-1', 'old-pi-task');
    expect(stopBackgroundTask).not.toHaveBeenCalled();
  });

  it('surfaces a detached-fallback refusal instead of relabelling it INTERNAL', async () => {
    // The fallback enumerates durable runs out of a shared pi-agent-home, so it
    // can find one another live instance owns. Its refusal is a user-facing
    // verdict and must reach the UI with its own code.
    const harness = new IpcHarness();
    const stopBackgroundTask = vi.fn().mockResolvedValue(undefined);
    registerStopAgentTaskHandler(harness, {
      getLiveSession: vi.fn(() => ({ stopBackgroundTask })),
      stopDetachedTask: vi.fn(async () => {
        throw createIpcError(
          'PRECONDITION_FAILED',
          'This Subagent run belongs to another running Cindy instance.',
        );
      }),
    });

    await expect(
      harness.invoke(MAKER_INVOKE.STOP_AGENT_TASK, 'session-1', 'task-1'),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    // A refused stop must not silently fall through to the live handle either.
    expect(stopBackgroundTask).not.toHaveBeenCalled();
  });

  it('maps NotSupportedError to UNSUPPORTED_CAPABILITY', async () => {
    const harness = new IpcHarness();
    const err = new Error('stopBackgroundTask not supported');
    err.name = 'NotSupportedError';
    registerStopAgentTaskHandler(harness, {
      getLiveSession: vi.fn(() => ({ stopBackgroundTask: vi.fn().mockRejectedValue(err) })),
    });

    await expect(
      harness.invoke(MAKER_INVOKE.STOP_AGENT_TASK, 'session-1', 'task-1'),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
  });

  it('maps plain "not supported" failures (old SDK / old remote daemon) to UNSUPPORTED_CAPABILITY', async () => {
    const harness = new IpcHarness();
    registerStopAgentTaskHandler(harness, {
      getLiveSession: vi.fn(() => ({
        stopBackgroundTask: vi
          .fn()
          .mockRejectedValue(new Error('stopTask is not supported by the current Claude SDK or remote daemon')),
      })),
    });

    await expect(
      harness.invoke(MAKER_INVOKE.STOP_AGENT_TASK, 'session-1', 'task-1'),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
  });

  it('maps other failures to INTERNAL', async () => {
    const harness = new IpcHarness();
    registerStopAgentTaskHandler(harness, {
      getLiveSession: vi.fn(() => ({
        stopBackgroundTask: vi.fn().mockRejectedValue(new Error('rpc timeout')),
      })),
    });

    await expect(
      harness.invoke(MAKER_INVOKE.STOP_AGENT_TASK, 'session-1', 'task-1'),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
  });
});
