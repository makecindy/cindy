import { describe, expect, it, vi } from 'vitest';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { registerByokIpc } from '../byokIpc.js';
function harness(trusted = true) {
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>();
  const control = {
    getStatus: vi.fn(() => ({
      state: 'ready' as const,
      providers: [{ providerId: 'byok-company', state: 'ready' as const }],
    })),
    sync: vi.fn(async () => undefined),
  };
  const assertSender = vi.fn(() => {
    if (!trusted) throw new Error('untrusted renderer');
  });
  registerByokIpc(
    {
      handle: (name, handler) => {
        handlers.set(name, handler);
      },
    } as Pick<IpcMain, 'handle'>,
    control,
    assertSender,
  );
  const call = (name: string, value?: unknown) =>
    handlers.get(`model-access:byok-${name}`)!({} as IpcMainInvokeEvent, value);
  return { call, control, assertSender };
}
describe('enterprise BYOK IPC boundary', () => {
  it('rejects untrusted status reads and mutations before calling the runtime', async () => {
    const { call, control } = harness(false);
    expect(() => call('status')).toThrow('untrusted');
    await expect(call('retry')).rejects.toThrow('untrusted');
    expect(control.getStatus).not.toHaveBeenCalled();
    expect(control.sync).not.toHaveBeenCalled();
  });
  it('refresh returns only the runtime status', async () => {
    const { call, control } = harness();
    expect(await call('retry')).toEqual(control.getStatus());
    expect(control.sync).toHaveBeenCalledOnce();
  });
});
