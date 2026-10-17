import { describe, expect, it, vi } from 'vitest';
import {
  DL_SESSION_HANDOFF_CHANNEL,
  DeviceLinkError,
  REMOTE_INVOKE_ALLOWLIST,
  resolveRemoteInvokeTimeoutMs,
  type InvokeResultPayload,
} from '@cindy/device-link';
import { createRemoteSessionHandoff } from '../sessionHandoffRemote.js';

const accepted = {
  ok: true,
  agentKind: 'codex',
  wakeKind: 'queued',
  targetTitle: 'remote',
  targetLastUserSendAt: null,
};
function setup(outcome: unknown = { ok: true, result: accepted }) {
  const invoke = vi.fn(async (): Promise<InvokeResultPayload> => {
    if (outcome instanceof Error) throw outcome;
    return outcome as InvokeResultPayload;
  });
  const send = createRemoteSessionHandoff({ invoke, captureAccess: () => () => {} });
  return {
    invoke,
    send: () =>
      send(
        { deviceId: 'mbp', sessionId: 's9' },
        { message: 'hi', sender: async () => ({ sessionId: 'me', title: 'T' }) },
      ),
  };
}

describe('cross-device send_to_session sender', () => {
  it('sends one request on the same-account handoff channel and returns the remote acceptance', async () => {
    expect(REMOTE_INVOKE_ALLOWLIST.has(DL_SESSION_HANDOFF_CHANNEL)).toBe(true);
    // 慢恢复的任务不能被默认 30s 误报成结果未知。
    expect(resolveRemoteInvokeTimeoutMs(DL_SESSION_HANDOFF_CHANNEL)).toBe(65_000);
    const s = setup();
    expect(await s.send()).toEqual(accepted);
    expect(s.invoke).toHaveBeenCalledOnce();
    expect(s.invoke).toHaveBeenCalledWith(
      'mbp',
      DL_SESSION_HANDOFF_CHANNEL,
      [{ sessionId: 's9', message: 'hi', sender: { sessionId: 'me', title: 'T' } }],
      { preSend: expect.any(Function) },
    );
  });

  it('says an older computer does not support it instead of failing silently', async () => {
    for (const outcome of [
      { ok: false, error: { code: 'CHANNEL_NOT_ALLOWED', message: 'no' } },
      new DeviceLinkError('CHANNEL_NOT_ALLOWED', 'no'),
    ]) {
      const result = await setup(outcome).send();
      expect(result).toMatchObject({ ok: false, errorCode: 'REMOTE_UNSUPPORTED' });
      expect(result.ok === false && result.message).toContain('没有发出');
    }
  });

  it('separates not-sent failures from an unknown delivery', async () => {
    const cases: Array<[unknown, string]> = [
      [new DeviceLinkError('DEVICE_OFFLINE', ''), 'REMOTE_DEVICE_OFFLINE'],
      [new DeviceLinkError('REMOTE_DISABLED', ''), 'REMOTE_DISABLED'],
      [new Error('[DEVICE_LINK_CONTROL_DISABLED] off'), 'REMOTE_DISABLED'],
      [new DeviceLinkError('LINK_NOT_OPEN', ''), 'REMOTE_UNAVAILABLE'],
      [
        {
          ok: false,
          // 隧道层的 NOT_FOUND 也可能来自 handler 完成后的复核：无法证明没投递。
          error: { code: 'IPC_ERROR', message: 'Error: [NOT_FOUND] Session does not exist' },
        },
        'DELIVERY_UNKNOWN',
      ],
      // 目标任务不存在由 handler 以数据返回，是确定结果。
      [{ ok: true, result: { ok: false, errorCode: 'NOT_FOUND', message: 'gone' } }, 'NOT_FOUND'],
      [{ ok: true, result: { ok: false, errorCode: 'ARCHIVED', message: 'archived' } }, 'ARCHIVED'],
      [
        // Agent 没能启动时消息可能已记入目标任务，不能原样透传成可直接重试的错误。
        { ok: true, result: { ok: false, errorCode: 'AGENT_NOT_READY', message: 'x' } },
        'DELIVERY_UNKNOWN',
      ],
      // 已发出但没有可信回执:可能已送达,不能说「没有发出」。
      [new DeviceLinkError('INVOKE_TIMEOUT', ''), 'DELIVERY_UNKNOWN'],
      [
        Object.assign(new DeviceLinkError('NOT_CONNECTED', ''), { inFlight: true }),
        'DELIVERY_UNKNOWN',
      ],
      [
        {
          ok: false,
          error: { code: 'IPC_ERROR', message: 'Error: [INTERNAL] owner check failed' },
        },
        'DELIVERY_UNKNOWN',
      ],
      [
        { ok: true, result: { ok: true, agentKind: 'weird', wakeKind: 'queued' } },
        'DELIVERY_UNKNOWN',
      ],
      [{ ok: true, result: 'nope' }, 'DELIVERY_UNKNOWN'],
      // 目标电脑的内部错误可能发生在消息已记入任务之后。
      [
        { ok: true, result: { ok: false, errorCode: 'INTERNAL', message: 'x' } },
        'DELIVERY_UNKNOWN',
      ],
      [
        { ok: true, result: { ok: false, errorCode: 'SOMETHING_NEW', message: 'x' } },
        'DELIVERY_UNKNOWN',
      ],
    ];
    for (const [outcome, errorCode] of cases) {
      const s = setup(outcome);
      expect(await s.send()).toMatchObject({ ok: false, errorCode });
      // 任何失败都不自动重发。
      expect(s.invoke).toHaveBeenCalledOnce();
    }
  });

  it('does not send when the account scope is already changing', async () => {
    const invoke = vi.fn();
    const send = createRemoteSessionHandoff({
      invoke,
      captureAccess: () => {
        throw new Error('changing');
      },
    });
    expect(
      await send(
        { deviceId: 'mbp', sessionId: 's9' },
        { message: 'hi', sender: async () => ({ sessionId: 'me' }) },
      ),
    ).toMatchObject({ ok: false, errorCode: 'HOST_NOT_READY' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('holds one account record across the sender lookup, the send and the reply', async () => {
    let owner = 1;
    const captureAccess = () => {
      const captured = owner;
      return () => {
        if (captured !== owner) throw new Error('Owner changed');
      };
    };
    const target = { deviceId: 'mbp', sessionId: 's9' };
    // 读来源期间切换账号：还没发出。
    const beforeSend = vi.fn(async (): Promise<InvokeResultPayload> => ({
      ok: true,
      result: accepted,
    }));
    const early = await createRemoteSessionHandoff({ invoke: beforeSend, captureAccess })(target, {
      message: 'hi',
      sender: async () => {
        owner += 1;
        return { sessionId: 'me', title: 'old account title' };
      },
    });
    expect(early).toMatchObject({ ok: false, errorCode: 'HOST_NOT_READY' });
    expect(beforeSend).not.toHaveBeenCalled();
    // 发出后、回执前切换账号：结果未知，且不返回上一个账号的任务信息。
    const inFlight = vi.fn(async (): Promise<InvokeResultPayload> => {
      owner += 1;
      return { ok: true, result: { ...accepted, targetTitle: 'old account task' } };
    });
    const late = await createRemoteSessionHandoff({ invoke: inFlight, captureAccess })(target, {
      message: 'hi',
      sender: async () => ({ sessionId: 'me' }),
    });
    expect(late).toMatchObject({ ok: false, errorCode: 'DELIVERY_UNKNOWN' });
    expect(JSON.stringify(late)).not.toContain('old account task');
  });
});
