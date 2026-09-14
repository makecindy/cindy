import { describe, expect, it, vi } from 'vitest';

import { MAKER_INVOKE } from '../channels';
import { registerMakerSessionSendHandler } from '../sessionSendHandler';
import { IpcHarness } from './helpers/ipcHarness';

describe('maker session SEND IPC handler', () => {
  it('validates sessionId before delegating to the send transaction', async () => {
    const harness = new IpcHarness();
    const sendToAgentAccepted = vi.fn();

    registerMakerSessionSendHandler(harness, { sendToAgentAccepted });

    await expect(harness.invoke(MAKER_INVOKE.SEND, undefined, 'hello')).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
    expect(sendToAgentAccepted).not.toHaveBeenCalled();
  });

  it('delegates message, create opts, and send opts unchanged', async () => {
    const harness = new IpcHarness();
    const result = {
      accepted: true,
      outcome: { kind: 'session-send', accepted: true },
    };
    const sendToAgentAccepted = vi.fn().mockResolvedValue(result);
    const message = { type: 'user', content: 'hello' };
    const createOpts = {
      agentKind: 'codex',
      workingDir: 'C:\\repo',
      model: 'gpt-5.4',
    };
    const sendOpts = { messageUuid: 'msg-1', throwOnStartFailure: true };

    registerMakerSessionSendHandler(harness, { sendToAgentAccepted });

    await expect(
      harness.invoke(MAKER_INVOKE.SEND, 'session-1', message, createOpts, sendOpts),
    ).resolves.toBe(result);
    expect(sendToAgentAccepted).toHaveBeenCalledWith('session-1', message, createOpts, sendOpts);
  });

  it('runs the clear-boundary fence before a legacy direct send', async () => {
    const harness = new IpcHarness();
    const sendToAgentAccepted = vi.fn().mockResolvedValue({ accepted: true });
    const assertRemoteInputControlBoundary = vi.fn().mockReturnValue({
      expectedClearBoundaryMs: 456,
      expectedInputGeneration: 9,
    });
    const sendOpts = { expectedClearBoundaryMs: 123 };

    registerMakerSessionSendHandler(harness, {
      sendToAgentAccepted,
      assertRemoteInputControlBoundary,
    });

    await harness.invoke(MAKER_INVOKE.SEND, 'session-1', 'hello', undefined, sendOpts);

    expect(assertRemoteInputControlBoundary).toHaveBeenCalledWith('session-1', sendOpts);
    expect(sendToAgentAccepted).toHaveBeenCalledWith(
      'session-1',
      'hello',
      undefined,
      { expectedClearBoundaryMs: 456, expectedInputGeneration: 9 },
    );
  });

  it('strips a Renderer-forged IM permission policy before dispatch', async () => {
    const harness = new IpcHarness();
    const sendToAgentAccepted = vi.fn().mockResolvedValue({ accepted: true });

    registerMakerSessionSendHandler(harness, { sendToAgentAccepted });

    await harness.invoke(MAKER_INVOKE.SEND, 'session-1', 'pi install npm:context-mode', undefined, {
      messageUuid: 'msg-1',
      turnPermissionPolicy: {
        origin: { kind: 'im', channel: 'telegram' },
        confirmationSurface: 'channel',
      },
    });

    expect(sendToAgentAccepted).toHaveBeenCalledWith(
      'session-1',
      'pi install npm:context-mode',
      undefined,
      { messageUuid: 'msg-1' },
    );
  });

  it('does not reach the send transaction when the Main input boundary rejects Review', async () => {
    const harness = new IpcHarness();
    const sendToAgentAccepted = vi.fn();
    const assertRemoteInputControlBoundary = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('Review input rejected'), { code: 'UNSUPPORTED_CAPABILITY' }),
      );

    registerMakerSessionSendHandler(harness, {
      sendToAgentAccepted,
      assertRemoteInputControlBoundary,
    });

    await expect(harness.invoke(MAKER_INVOKE.SEND, 'review-1', 'hello')).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
    });
    expect(sendToAgentAccepted).not.toHaveBeenCalled();
  });

  it('keeps a validated clear token when the optional boundary hook is absent', async () => {
    const harness = new IpcHarness();
    const sendToAgentAccepted = vi.fn().mockResolvedValue({ accepted: true });
    const sendOpts = { expectedClearBoundaryMs: 123, messageUuid: 'msg-1' };

    registerMakerSessionSendHandler(harness, { sendToAgentAccepted });

    await harness.invoke(MAKER_INVOKE.SEND, 'session-1', 'hello', undefined, sendOpts);

    expect(sendToAgentAccepted).toHaveBeenCalledWith(
      'session-1',
      'hello',
      undefined,
      sendOpts,
    );
  });

  it('keeps empty string sessionId on the send transaction path for compatibility', async () => {
    const harness = new IpcHarness();
    const result = { accepted: false, reason: 'NOT_FOUND' };
    const sendToAgentAccepted = vi.fn().mockResolvedValue(result);

    registerMakerSessionSendHandler(harness, { sendToAgentAccepted });

    await expect(harness.invoke(MAKER_INVOKE.SEND, '', 'hello')).resolves.toBe(result);
    expect(sendToAgentAccepted).toHaveBeenCalledWith('', 'hello', undefined, undefined);
  });
});
