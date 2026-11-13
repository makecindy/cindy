import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DL_SESSION_HANDOFF_CHANNEL,
  DeviceLinkError,
  REMOTE_INVOKE_ALLOWLIST,
  resolveRemoteInvokeTimeoutMs,
  type InvokeResultPayload,
} from '@cindy/device-link';
import { creationOperation } from '../../../shared/remoteSessionCreation.js';
import { createRemoteSessionHandoff } from '../sessionHandoffRemote.js';
import { releaseRemoteTaskActionReceipt, validateRemoteTaskActionReceipt } from '../../maker-ipc/remoteTaskActionReceipt.js';
import { captureAgentRequest } from '../../maker-ipc/forwardedRequest.js';
import { matchesForwardedRequest } from '../../../shared/forwardedRequest.js';

const issued: string[] = [];
afterEach(() => { issued.splice(0).forEach(releaseRemoteTaskActionReceipt); });

const accepted = {
  ok: true,
  agentKind: 'codex',
  wakeKind: 'queued',
  targetTitle: 'remote',
  targetLastUserSendAt: null,
};
function setup(outcome: unknown = { ok: true, result: accepted }) {
  const invoke = vi.fn(async (_device: string, _channel: string, args: unknown[]): Promise<InvokeResultPayload> => {
    if ((args[0] as { action?: string }).action === 'task-action-capability') return { ok: true, result: { taskActionVersion: 1 } };
    issued.push((args[0] as { taskActionReceipt: string }).taskActionReceipt);
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
  // Unit regression: a failed read-only capability probe cannot have created a task,
  // whether returned or thrown. The same IPC error after create stays uncertain.
  it.each(['probe-return', 'probe-throw', 'create-return'] as const)(
    'classifies creation failure at the actual send phase (%s)', async phase => {
      const failure = { ok: false as const, error: { code: 'IPC_ERROR' as const, message: 'Error: [PRECONDITION_FAILED] Task visibility is not ready' } };
      const invoke = vi.fn(async (_device: string, _channel: string, args: unknown[]): Promise<InvokeResultPayload> => {
        if ((args[0] as { action?: string }).action === 'task-action-capability') {
          if (phase === 'probe-throw') throw new Error(failure.error.message);
          return phase === 'probe-return' ? failure : { ok: true, result: { taskActionVersion: 1, ordinaryCreateVersion: 1 } };
        }
        issued.push((args[0] as { taskActionReceipt: string }).taskActionReceipt);
        return failure;
      });
      const send = createRemoteSessionHandoff({ invoke, captureAccess: () => () => {} });
      expect(await send({ deviceId: 'mbp', sessionId: 'new-id' }, {
        message: 'hi', sender: async () => ({ sessionId: 'me' }), create: async () => ({ permissionMode: 'ask' }),
      })).toMatchObject({ ok: false, errorCode: phase === 'create-return' ? 'DELIVERY_UNKNOWN' : 'REMOTE_UNAVAILABLE' });
      expect(invoke).toHaveBeenCalledTimes(phase === 'create-return' ? 2 : 1);
      if (phase !== 'create-return') expect(invoke.mock.calls[0]![2][0]).toEqual({ action: 'task-action-capability', sessionId: 'new-id' });
    },
  );

  // Unit regression: the destination can explicitly reject a budget model before
  // persistence. Preserve its remedy and release the unused authorization receipt.
  it('preserves an explicit budget-model creation rejection', async () => {
    const rejection = { ok: false as const, errorCode: 'BUDGET_MODEL_REQUIRES_API_MODE', message: 'Connect Cindy AI to use this model' };
    const invoke = vi.fn(async (_device: string, _channel: string, args: unknown[]): Promise<InvokeResultPayload> => {
      if ((args[0] as { action?: string }).action === 'task-action-capability')
        return { ok: true, result: { taskActionVersion: 1, ordinaryCreateVersion: 1 } };
      issued.push((args[0] as { taskActionReceipt: string }).taskActionReceipt);
      return { ok: true, result: rejection };
    });
    const send = createRemoteSessionHandoff({ invoke, captureAccess: () => () => {} });
    const create = { permissionMode: 'ask' as const, model: 'codex/test-budget-model' };
    expect(await send({ deviceId: 'mbp', sessionId: 'new-id' }, {
      message: 'hi', sender: async () => ({ sessionId: 'me' }), create: async () => create,
    })).toEqual(rejection);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(await validateRemoteTaskActionReceipt('mbp', { receiptId: issued.at(-1)!, sessionId: 'me', targetSessionId: 'new-id',
      message: 'hi', operation: creationOperation(create) })).toBe(false);
  });

  // Unit/protocol: creation must negotiate before mutation, bind all options to its
  // receipt and preserve the receipt until the queued first message is consumed.
  it('negotiates ordinary creation and binds its configuration without retrying', async () => {
    const create = { permissionMode: 'ask' as const, projectDir: '/remote/project', model: 'selected' };
    let supported = false;
    const invoke = vi.fn(async (_device: string, _channel: string, args: unknown[]): Promise<InvokeResultPayload> => {
      const wire = args[0] as { action?: string; taskActionReceipt: string; create?: unknown };
      if (wire.action === 'task-action-capability') return { ok: true, result: { taskActionVersion: 1, ordinaryCreateVersion: supported ? 1 : undefined } };
      issued.push(wire.taskActionReceipt);
      expect(wire).toMatchObject({ action: 'create', create });
      return { ok: true, result: { ...accepted, wakeKind: 'created', targetSessionId: 'new-id', model: 'selected', workingDir: '/remote/project' } };
    });
    const send = createRemoteSessionHandoff({ invoke, captureAccess: () => () => {} });
    const run = () => send({ deviceId: 'mbp', sessionId: 'new-id' }, {
      message: 'hi', sender: async () => ({ sessionId: 'me' }), create: async () => create,
    });
    expect(await run()).toMatchObject({ ok: false, errorCode: 'REMOTE_UNSUPPORTED' });
    expect(invoke).toHaveBeenCalledOnce();
    supported = true;
    expect(await run()).toMatchObject({ ok: true, wakeKind: 'created', model: 'selected' });
    expect(invoke).toHaveBeenCalledTimes(3);
    const receipt = { receiptId: issued.at(-1)!, sessionId: 'me', targetSessionId: 'new-id', message: 'hi' };
    expect(await validateRemoteTaskActionReceipt('mbp', { ...receipt, operation: creationOperation(create) })).toBe(true);
    expect(await validateRemoteTaskActionReceipt('mbp', receipt)).toBe(false);
    expect(await validateRemoteTaskActionReceipt('mbp', { ...receipt, operation: creationOperation({ ...create, permissionMode: 'bypassPermissions' }) })).toBe(false);
  });

  // 2026-11-05: a newer receiver takes the agent's own text with a checked hand-off; an older one
  // still verifies the quoted envelope, so it keeps receiving exactly what it received before.
  // Unit: real capture and sender against both capability answers.
  it.each([
    [{ taskActionVersion: 1, plainRequestBody: 1 }, 'plain'],
    [{ taskActionVersion: 1 }, 'legacy'],
  ] as const)('chooses the body the receiver can verify (%j)', async (capability, expected) => {
    const invoke = vi.fn(async (_device: string, _channel: string, args: unknown[]): Promise<InvokeResultPayload> => {
      if ((args[0] as { action?: string }).action === 'task-action-capability') return { ok: true, result: capability };
      issued.push((args[0] as { taskActionReceipt: string }).taskActionReceipt);
      return { ok: true, result: accepted };
    });
    const captureRequest = (sessionId: string, message: string, target?: { sessionId?: string }) => captureAgentRequest(sessionId, message,
      { clientId: 'owner-input', authoredText: '修好就合进去' }, async () => [], true, true, target?.sessionId);
    const send = createRemoteSessionHandoff({ invoke, captureAccess: () => () => {}, captureRequest });
    expect(await send({ deviceId: 'mbp', sessionId: 's9' },
      { message: 'Fix #12 and merge it.', sender: async () => ({ sessionId: 'me', title: 'T' }) })).toEqual(accepted);
    const wire = invoke.mock.calls.at(-1)![2][0] as { message: string; requestSource: Parameters<typeof matchesForwardedRequest>[0] };
    expect(matchesForwardedRequest(wire.requestSource, wire.message)).toBe(true);
    if (expected === 'plain') {
      expect(wire.message).toBe('Fix #12 and merge it.');
      expect(wire.requestSource).toEqual({ sessionId: 'me', clientId: 'owner-input', plainBody: true, delegatedText: 'Fix #12 and merge it.' });
    } else {
      expect(wire.message).toContain('修好就合进去');
      expect(wire.requestSource).toEqual({ userText: '修好就合进去', sessionId: 'me', clientId: 'owner-input', ownerVerified: true });
    }
  });

  // #6399, unit: the existing result-code matrix did not inspect receipt lifetime.
  // Known-unsent attempts must not exhaust the 256 live delivery slots; unknown
  // attempts and accepted queued messages must remain verifiable by the receiver.
  it.each([
    [Object.assign(new DeviceLinkError('DEVICE_OFFLINE', ''), { inFlight: false }), false],
    [new Error('[DEVICE_LINK_CONTROL_DISABLED] off'), false],
    [{ ok: false, error: { code: 'DEVICE_OFFLINE', message: '' } }, false],
    [{ ok: true, result: { ok: false, errorCode: 'ARCHIVED' } }, false],
    [Object.assign(new DeviceLinkError('NOT_CONNECTED', ''), { inFlight: true }), true],
    [Object.assign(new DeviceLinkError('INVOKE_TIMEOUT', ''), { inFlight: true }), true],
    [new DeviceLinkError('INVOKE_TIMEOUT', ''), true],
    [{ ok: false, error: { code: 'BACKPRESSURE', message: 'receipt query overloaded' } }, true],
    [new Error('unknown transport failure'), true],
    [{ ok: true, result: accepted }, true],
    [{ ok: true, result: { ...accepted, wakeKind: 'future-mode' } }, true],
    [{ ok: true, result: { ...accepted, wakeKind: 'resumed' } }, false],
  ])('retains a receipt only while delivery may need it (%#)', async (outcome, retained) => {
    await setup(outcome).send();
    expect(await validateRemoteTaskActionReceipt('mbp', {
      receiptId: issued.at(-1)!, sessionId: 'me', targetSessionId: 's9', message: 'hi',
    })).toBe(retained);
  });

  it('keeps sending after more than 256 proven pre-send failures', async () => {
    const s = setup(Object.assign(new DeviceLinkError('DEVICE_OFFLINE', ''), { inFlight: false }));
    for (let attempt = 0; attempt < 260; attempt++) {
      expect(await s.send()).toMatchObject({ ok: false, errorCode: 'REMOTE_DEVICE_OFFLINE' });
    }
    expect(s.invoke).toHaveBeenCalledTimes(520);
  });

  it('sends one request on the same-account handoff channel and returns the remote acceptance', async () => {
    expect(REMOTE_INVOKE_ALLOWLIST.has(DL_SESSION_HANDOFF_CHANNEL)).toBe(true);
    // 慢恢复的任务不能被默认 30s 误报成结果未知。
    expect(resolveRemoteInvokeTimeoutMs(DL_SESSION_HANDOFF_CHANNEL)).toBe(65_000);
    const s = setup();
    expect(await s.send()).toEqual(accepted);
    expect(s.invoke).toHaveBeenCalledTimes(2);
    expect(s.invoke).toHaveBeenCalledWith(
      'mbp',
      DL_SESSION_HANDOFF_CHANNEL,
      [{ sessionId: 's9', message: 'hi', sender: { sessionId: 'me', title: 'T' }, taskActionReceipt: expect.any(String) }],
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
      expect(s.invoke).toHaveBeenCalledTimes(2);
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
    const inFlight = vi.fn(async (_device: string, _channel: string, args: unknown[]): Promise<InvokeResultPayload> => {
      if ((args[0] as { action?: string }).action === 'task-action-capability') return { ok: true, result: { taskActionVersion: 1 } };
      issued.push((args[0] as { taskActionReceipt: string }).taskActionReceipt);
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
