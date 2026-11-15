import { describe, expect, it, vi } from 'vitest';

import type { RemoteAgentPoller } from '../controller/poller';
import { RemoteAgentRunClient } from '../controller/runClient';

function handlers() {
  return {
    onEvent: () => undefined,
    onState: () => undefined,
    onWs: () => undefined,
    onClosed: vi.fn(),
    onRequest: async () => ({ type: 'interaction' as const, result: { kind: 'permission' as const, behavior: 'allow' as const } }),
  };
}

describe('RemoteAgentRunClient.close', () => {
  it('rejects a DEVICE_LINK close after locally finishing the client', async () => {
    const invoke = vi.fn(async () => {
      throw Object.assign(new Error('[DEVICE_LINK_NOT_CONNECTED] not connected'), { code: 'NOT_CONNECTED' });
    });
    const seen = handlers();
    const client = new RemoteAgentRunClient(
      'run-1',
      { invoke, unregister: () => undefined } as unknown as RemoteAgentPoller,
      seen,
      () => 'id',
    );
    await expect(client.close('close', 'navigation')).rejects.toMatchObject({
      message: expect.stringMatching(/DEVICE_LINK_NOT_CONNECTED/),
    });
    expect(client.isClosed).toBe(true);
    expect(seen.onClosed).toHaveBeenCalledWith('closed', undefined, false);
  });
});
