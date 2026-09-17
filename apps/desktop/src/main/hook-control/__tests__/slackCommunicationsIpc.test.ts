import { describe, expect, it, vi } from 'vitest';
import type { SlackHookView } from '../../../shared/hookControlIpc.js';
import { setSlackCommunicationsFromIpc } from '../slackCommunicationsIpc.js';

describe('Slack communications IPC', () => {
  function harness(supported = true) {
    const snapshot = () => ({
      serverSlackCommunications: supported,
      bindings: [{ teamId: 'T1' }],
    }) as SlackHookView;
    return { snapshot, setSlackCommunications: vi.fn(async () => ({ ok: true as const, result: {} })) };
  }
  it('只修改本机已知 workspace', async () => {
    const manager = harness();
    expect(await setSlackCommunicationsFromIpc(manager, { teamId: 'T1', enabled: false })).toEqual({ hook: manager.snapshot() });
    expect(manager.setSlackCommunications).toHaveBeenCalledWith('T1', false);
  });
  it.each([null, {}, { teamId: 'T1', enabled: 'true' }, { teamId: 'T2', enabled: true }, { teamId: 'x'.repeat(129), enabled: true }])('拒绝非法或越权参数 %j', async (payload) => {
    const manager = harness();
    await expect(setSlackCommunicationsFromIpc(manager, payload)).rejects.toThrow('[INVALID_PARAMS]');
    expect(manager.setSlackCommunications).not.toHaveBeenCalled();
  });
  it('旧 server fail closed，不发送新版操作', async () => {
    const manager = harness(false);
    await expect(setSlackCommunicationsFromIpc(manager, { teamId: 'T1', enabled: true })).rejects.toThrow('[HOOK_MULTI_TEAM_UNSUPPORTED]');
    expect(manager.setSlackCommunications).not.toHaveBeenCalled();
  });
});
