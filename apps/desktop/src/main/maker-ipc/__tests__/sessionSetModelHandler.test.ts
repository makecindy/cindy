import { describe, expect, it, vi } from 'vitest';
import { MAKER_INVOKE } from '../channels';
import { registerSessionSetModelHandler } from '../sessionSetModelHandler';
import { IpcHarness } from './helpers/ipcHarness';

describe('SET_MODEL ingress', () => {
  it('checks the actual local sender before passing the complete selection to the transaction', async () => {
    const harness = new IpcHarness();
    const order: string[] = [];
    const assertTrustedSender = vi.fn(() => { order.push('trust'); });
    const apply = vi.fn(() => { order.push('apply'); return { applied: true }; });
    registerSessionSetModelHandler(harness, { isDeviceLinkInvoke: () => false, assertTrustedSender, apply });
    const selection = { effort: 'high', fastMode: false };
    await expect(harness.invokeFrom(42, MAKER_INVOKE.SET_MODEL, 'bot-session', 'model', null, 2, selection))
      .resolves.toEqual({ applied: true });
    expect(assertTrustedSender).toHaveBeenCalledWith(expect.objectContaining({ sender: expect.objectContaining({ id: 42 }) }));
    expect(apply).toHaveBeenCalledWith('bot-session', 'model', null, 2, selection);
    expect(order).toEqual(['trust', 'apply']);
  });

  it('rejects untrusted local callers before changing a model', async () => {
    const harness = new IpcHarness();
    const apply = vi.fn();
    registerSessionSetModelHandler(harness, {
      isDeviceLinkInvoke: () => false,
      assertTrustedSender: () => { throw new Error('untrusted sender'); }, apply,
    });
    await expect(harness.invoke(MAKER_INVOKE.SET_MODEL, 'bot-session', 'model')).rejects.toThrow('untrusted sender');
    expect(apply).not.toHaveBeenCalled();
  });

  it('lets authenticated device-link ingress use the transaction without an Electron frame', async () => {
    const harness = new IpcHarness();
    const assertTrustedSender = vi.fn(() => { throw new Error('no Electron frame'); });
    const apply = vi.fn(() => 'applied');
    registerSessionSetModelHandler(harness, { isDeviceLinkInvoke: () => true, assertTrustedSender, apply });
    await expect(harness.invoke(MAKER_INVOKE.SET_MODEL, 'bot-session', 'model')).resolves.toBe('applied');
    expect(assertTrustedSender).not.toHaveBeenCalled();
  });
});
