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

  it('keeps empty string sessionId on the send transaction path for compatibility', async () => {
    const harness = new IpcHarness();
    const result = { accepted: false, reason: 'NOT_FOUND' };
    const sendToAgentAccepted = vi.fn().mockResolvedValue(result);

    registerMakerSessionSendHandler(harness, { sendToAgentAccepted });

    await expect(harness.invoke(MAKER_INVOKE.SEND, '', 'hello')).resolves.toBe(result);
    expect(sendToAgentAccepted).toHaveBeenCalledWith('', 'hello', undefined, undefined);
  });
});
