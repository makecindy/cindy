import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { DeviceLinkError, type InvokeResultPayload } from '@cindy/device-link';
import { createSchedulerRemoteDeps } from '../schedulerDevices.js';

type Invoke = (
  deviceId: string,
  channel: string,
  args: unknown[],
  options?: { preSend?: () => void },
) => Promise<InvokeResultPayload>;

function setup(invoke = vi.fn<Invoke>(async () => ({ ok: true, result: [] }))) {
  let owner = 1;
  const captureAccess = () => {
    const captured = owner;
    return () => {
      if (captured !== owner) throw new Error('Owner changed');
    };
  };
  return {
    invoke,
    changeOwner: () => owner++,
    remote: createSchedulerRemoteDeps({ invoke, captureAccess, listDevices: async () => [] }),
  };
}

describe('desktop scheduler cross-device transport', () => {
  // PR #6830 / discussion_r4385260097, unit: the existing route/null tests omit
  // explicit engine updates with inherited location. An old host silently drops
  // modelAgentKind; the public adapter must reject before issuing that write.
  it.each([
    { capabilities: {}, patch: { modelAgentKind: 'codex', model: 'gpt-5' }, supported: false },
    { capabilities: { supportsScheduleModelSelection: false }, patch: { modelAgentKind: 'codex', model: 'gpt-5' }, supported: false },
    { capabilities: { supportsScheduleAgentDeviceSelection: true }, patch: { modelAgentKind: 'codex', model: 'gpt-5' }, supported: false },
    { capabilities: { supportsScheduleModelSelection: true }, patch: { modelAgentKind: 'codex', model: 'gpt-5' }, supported: true },
    { capabilities: { supportsScheduleModelSelection: true }, patch: { modelAgentKind: 'codex', model: 'gpt-5', modelAgentDeviceId: '' }, supported: false },
    { capabilities: { supportsScheduleModelSelection: true, supportsScheduleAgentDeviceSelection: true }, patch: { modelAgentKind: 'codex', model: 'gpt-5', modelAgentDeviceId: '' }, supported: true },
  ])('checks explicit engine support before remote writes: $capabilities / $patch', async ({ capabilities, patch, supported }) => {
    const s = setup();
    s.invoke.mockResolvedValueOnce({ ok: true, result: capabilities });
    s.invoke.mockResolvedValueOnce({ ok: true, result: { id: 's1' } });
    const result = await s.remote.invoke('mac', 'update', ['s1', patch]);
    expect(result).toMatchObject(supported ? { ok: true, data: { id: 's1' } } : { ok: false, code: 'REMOTE_UNSUPPORTED' });
    expect(s.invoke.mock.calls[0].slice(0, 3)).toEqual(['mac', 'maker:get-capabilities', ['claude-code']]);
    expect(s.invoke).toHaveBeenCalledTimes(supported ? 2 : 1);
    if (supported) expect(s.invoke.mock.calls[1].slice(0, 3)).toEqual(['mac', 'maker:schedule:update', ['s1', patch]]);
  });

  it('does not send an engine update after the account changes during capability lookup', async () => {
    const s = setup();
    s.invoke.mockImplementationOnce(async () => {
      s.changeOwner();
      return { ok: true, result: { supportsScheduleModelSelection: true } };
    });
    expect(await s.remote.invoke('mac', 'update', ['s1', { modelAgentKind: 'codex', model: 'gpt-5' }]))
      .toMatchObject({ ok: false });
    expect(s.invoke.mock.calls.map(([, channel]) => channel)).toEqual(['maker:get-capabilities']);
  });

  // Unit: an old host ignores the new route field; reject before a write can run locally instead.
  it.each([false, true])('checks remote schedule location support before writing (%s)', async (supported) => {
    const s = setup();
    s.invoke.mockResolvedValueOnce({ ok: true, result: { supportsScheduleAgentDeviceSelection: supported } });
    s.invoke.mockResolvedValueOnce({ ok: true, result: { id: 's1' } });
    const result = await s.remote.invoke('mac', 'update', ['s1', { modelAgentDeviceId: 'shared:owner' }]);
    expect(s.invoke.mock.calls[0].slice(0, 3)).toEqual(['mac', 'maker:get-capabilities', ['claude-code']]);
    expect(s.invoke).toHaveBeenCalledTimes(supported ? 2 : 1);
    expect(result.ok).toBe(supported);
    if (!supported) expect(result).toMatchObject({ code: 'REMOTE_UNSUPPORTED' });
  });
  // PR #6830, unit: route clearing needs the same new-host capability as setting
  // a location, including partial clears that omit the location field entirely.
  it.each([false, true])('checks support before forwarding null model axes (%s)', async (supported) => {
    const s = setup();
    const patch = { modelAgentKind: null, model: null, providerId: null, effort: null };
    s.invoke.mockResolvedValueOnce({ ok: true, result: { supportsScheduleAgentDeviceSelection: supported } });
    s.invoke.mockResolvedValueOnce({ ok: true, result: { id: 's1' } });
    const result = await s.remote.invoke('mac', 'update', ['s1', patch]);
    expect(result.ok).toBe(supported);
    expect(s.invoke).toHaveBeenCalledTimes(supported ? 2 : 1);
    if (supported) expect(s.invoke.mock.calls[1].slice(0, 3)).toEqual(['mac', 'maker:schedule:update', ['s1', patch]]);
    else expect(result).toMatchObject({ code: 'REMOTE_UNSUPPORTED' });
  });
  it('reuses the existing remote-control schedule channels with their argument shapes', async () => {
    const s = setup();
    await s.remote.invoke('mac', 'list', [{ status: 'active' }]);
    await s.remote.invoke('mac', 'list-runs', ['s1', 5]);
    for (const op of ['get', 'pause', 'resume', 'delete', 'run-now'] as const) {
      s.invoke.mockResolvedValueOnce({
        ok: true,
        result: op === 'delete' ? undefined : { id: 's1' },
      });
      expect(await s.remote.invoke('mac', op, ['s1'])).toEqual({
        ok: true,
        data: op === 'delete' ? null : { id: 's1' },
      });
    }
    s.invoke.mockResolvedValueOnce({ ok: true, result: { id: 's1' } });
    await s.remote.invoke('mac', 'update', ['s1', { name: 'n' }]);
    expect(s.invoke.mock.calls.map(([device, channel, args]) => [device, channel, args])).toEqual([
      ['mac', 'maker:schedule:list', [{ status: 'active' }]],
      ['mac', 'maker:schedule:list-runs', ['s1', 5]],
      ['mac', 'maker:schedule:get', ['s1']],
      ['mac', 'maker:schedule:pause', ['s1']],
      ['mac', 'maker:schedule:resume', ['s1']],
      ['mac', 'maker:schedule:delete', ['s1']],
      ['mac', 'maker:schedule:run-now', ['s1']],
      ['mac', 'maker:schedule:update', ['s1', { name: 'n' }]],
    ]);
  });

  it('reports an older peer, offline, disabled, timeout and remote business errors explicitly', async () => {
    const cases: Array<[InvokeResultPayload | Error, string]> = [
      [{ ok: false, error: { code: 'CHANNEL_NOT_ALLOWED', message: 'no' } }, 'REMOTE_UNSUPPORTED'],
      [
        {
          ok: false,
          error: {
            code: 'IPC_ERROR',
            message: 'Error invoking remote method: Error: [NOT_FOUND] Schedule not found: s1',
          },
        },
        'NOT_FOUND',
      ],
      [
        { ok: false, error: { code: 'IPC_ERROR', message: '[INVALID_PARAMS] invalid cron' } },
        'INVALID_PARAMS',
      ],
      [new DeviceLinkError('DEVICE_OFFLINE', 'offline'), 'REMOTE_DEVICE_OFFLINE'],
      [new DeviceLinkError('REMOTE_DISABLED', 'off'), 'REMOTE_DISABLED'],
      [new DeviceLinkError('INVOKE_TIMEOUT', 'slow'), 'REMOTE_TIMEOUT'],
      [
        new Error('[DEVICE_LINK_CONTROL_DISABLED] device control is disabled locally'),
        'REMOTE_DISABLED',
      ],
      [new Error('[DEVICE_LINK_STANDBY] owned elsewhere'), 'DEVICE_LINK_NOT_READY'],
      [new Error('boom'), 'REMOTE_UNAVAILABLE'],
    ];
    for (const [outcome, code] of cases) {
      const s = setup(
        vi.fn<Invoke>(async () => {
          if (outcome instanceof Error) throw outcome;
          return outcome as InvokeResultPayload;
        }),
      );
      expect(await s.remote.invoke('mac', 'pause', ['s1'])).toMatchObject({ ok: false, code });
    }
  });

  it('reports a write as possibly applied whenever the request left without a trustworthy result', async () => {
    const lost = Object.assign(new DeviceLinkError('NOT_CONNECTED', 'dropped'), { inFlight: true });
    // 被控端 handler 完成后的可见性 / 账号复核失败：写入已经发生。
    const postHandler = {
      ok: false as const,
      error: { code: 'IPC_ERROR' as const, message: '[NOT_FOUND] Session does not exist' },
    };
    for (const outcome of [lost, postHandler]) {
      for (const op of ['update', 'pause', 'resume', 'delete', 'run-now'] as const) {
        const s = setup(
          vi.fn<Invoke>(async () => {
            if (outcome instanceof Error) throw outcome;
            return outcome as InvokeResultPayload;
          }),
        );
        const result = await s.remote.invoke('mac', op, ['s1']);
        expect(result).toMatchObject({ ok: false, code: 'REMOTE_RESULT_UNKNOWN' });
        expect(result.ok === false && result.message).toContain('可能已生效');
      }
      // 读操作没有副作用：只是这次没读到。
      const read = setup(
        vi.fn<Invoke>(async () => {
          if (outcome instanceof Error) throw outcome;
          return outcome as InvokeResultPayload;
        }),
      );
      expect(await read.remote.invoke('mac', 'get', ['s1'])).toMatchObject({
        ok: false,
        code: 'REMOTE_UNAVAILABLE',
      });
    }
    // handler 进入后的内部错误或未编码错误可能发生在写入之后。
    for (const message of ['[INTERNAL] emit failed after save', 'Error: boom']) {
      const internal = setup(
        vi.fn<Invoke>(async () => ({ ok: false, error: { code: 'IPC_ERROR', message } })),
      );
      expect(await internal.remote.invoke('mac', 'run-now', ['s1'])).toMatchObject({
        ok: false,
        code: 'REMOTE_RESULT_UNKNOWN',
      });
      // 读操作没有副作用，照常归类。
      expect(await internal.remote.invoke('mac', 'get', ['s1'])).toMatchObject({ ok: false });
      expect(await internal.remote.invoke('mac', 'get', ['s1'])).not.toMatchObject({
        code: 'REMOTE_RESULT_UNKNOWN',
      });
    }
    // 写入前的拒绝仍是确定结果：参数错误、scheduler 尚未就绪。
    for (const [message, code] of [
      ['[INVALID_PARAMS] invalid cron', 'INVALID_PARAMS'],
      ['[INTERNAL] scheduler not ready: timeout', 'INTERNAL'],
    ]) {
      const early = setup(
        vi.fn<Invoke>(async () => ({ ok: false, error: { code: 'IPC_ERROR', message } })),
      );
      expect(await early.remote.invoke('mac', 'pause', ['s1'])).toMatchObject({ ok: false, code });
    }
    // 定时任务自己的「不存在」仍是确定结果。
    const notFound = setup(
      vi.fn<Invoke>(async () => ({
        ok: false,
        error: { code: 'IPC_ERROR', message: '[NOT_FOUND] Schedule not found: s1' },
      })),
    );
    expect(await notFound.remote.invoke('mac', 'delete', ['s1'])).toMatchObject({
      ok: false,
      code: 'NOT_FOUND',
    });
  });

  it('does not read a reply that arrives after the local account changed', async () => {
    const s = setup(
      vi.fn<Invoke>(async () => {
        s.changeOwner();
        return { ok: true, result: { id: 's1', name: 'old account schedule' } };
      }),
    );
    const write = await s.remote.invoke('mac', 'pause', ['s1']);
    expect(write).toMatchObject({ ok: false, code: 'REMOTE_RESULT_UNKNOWN' });
    expect(JSON.stringify(write)).not.toContain('old account schedule');
  });

  it('keeps the post-handler rejection text in sync with the dispatcher', () => {
    const dispatch = readFileSync(
      fileURLToPath(new URL('../../device-link/dispatch.ts', import.meta.url)),
      'utf8',
    );
    expect(dispatch).toContain("throw new Error('[NOT_FOUND] Session does not exist')");
    const schedule = readFileSync(
      fileURLToPath(new URL('../../maker-ipc/schedule.ts', import.meta.url)),
      'utf8',
    );
    expect(schedule).toContain('`scheduler not ready: ${');
  });

  it('rejects a malformed list and never sends after the account changes', async () => {
    const malformed = setup(vi.fn<Invoke>(async () => ({ ok: true, result: { not: 'a list' } })));
    expect(await malformed.remote.invoke('mac', 'list', [undefined])).toMatchObject({
      ok: false,
      code: 'REMOTE_INVALID_RESPONSE',
    });
    const s = setup(
      vi.fn<Invoke>(async (_d, _c, _a, options) => {
        s.changeOwner();
        options?.preSend?.();
        return { ok: true, result: [] };
      }),
    );
    expect(await s.remote.invoke('mac', 'list', [undefined])).toMatchObject({ ok: false });
  });
});
