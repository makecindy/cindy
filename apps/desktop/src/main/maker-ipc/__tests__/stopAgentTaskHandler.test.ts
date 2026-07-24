import { describe, expect, it, vi } from 'vitest';

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

  it('is idempotent when the session is not loaded (task cannot be alive)', async () => {
    const harness = new IpcHarness();
    registerStopAgentTaskHandler(harness, { getLiveSession: vi.fn(() => undefined) });

    await expect(
      harness.invoke(MAKER_INVOKE.STOP_AGENT_TASK, 'session-1', 'task-1'),
    ).resolves.toEqual({ ok: true });
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
