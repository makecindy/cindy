import { describe, expect, it, vi } from 'vitest';
import type { IpcMain } from 'electron';
import { createSessionIpcAdapter } from '../ipcAdapter.js';
import { withSessionCaller } from '../callerContext.js';
import { revalidateSessionOperation, requireSessionOperation, withSessionOperation } from '../operationContext.js';
import { SessionAdmissionError } from '../controller.js';
import { withSendToSessionLock } from '../../maker-ipc/sendToSessionLock.js';
import { MAKER_INVOKE as C } from '../../maker-ipc/channels.js';

vi.mock('../uiCaller.js', () => ({ withUiSessionCaller: vi.fn() }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn(), error: vi.fn() }) }));

type Handler = Parameters<IpcMain['handle']>[1];
function fixture() {
  const handlers = new Map<string, Handler>();
  const owner = {};
  let allowed = true;
  const authorize = vi.fn(async () => {
    if (!allowed) throw new SessionAdmissionError('NOT_AUTHORIZED', 'revoked');
  });
  const registry = createSessionIpcAdapter({ handle: (channel, handler) => { handlers.set(channel, handler); } }, {
    deviceId: () => 'device', owner: () => owner, execution: () => null,
    interactionSessionId: id => id === 'request' ? 'session' : undefined,
    withCaller: (_event, run) => withSessionCaller({ source: 'ui', authorize }, run),
  });
  return { registry, authorize, revoke: () => { allowed = false; },
    invoke: (channel: string, ...args: unknown[]) => handlers.get(channel)!({} as Parameters<Handler>[0], ...args) };
}

describe('Session IPC adapter', () => {
  it('preserves runtime deferred results and maps the operation to the target', async () => {
    const f = fixture();
    const result = { status: 'deferred', generation: 4, appliesAt: 'next_send' };
    f.registry.handle(C.SET_MODEL, () => result);
    expect(await f.invoke(C.SET_MODEL, 'session', 'model')).toBe(result);
    expect(f.authorize).toHaveBeenCalledWith({ operation: 'selectRuntime', deviceId: 'device', targets: [{ deviceId: 'device', sessionId: 'session' }] });
  });

  it('binds an interaction to the host resolver, not a session claim in the decision', async () => {
    const f = fixture();
    f.registry.handle(C.RESOLVE_INTERACTION, () => ({ accepted: true }));
    await f.invoke(C.RESOLVE_INTERACTION, 'request', { sessionId: 'other' });
    expect(f.authorize).toHaveBeenCalledWith({ operation: 'resolveInteraction', deviceId: 'device', targets: [{ deviceId: 'device', sessionId: 'session' }] });
  });

  it('rechecks revocation after waiting for the existing send lock', async () => {
    const f = fixture();
    let unlock!: () => void;
    const held = withSendToSessionLock('session', () => new Promise<void>(resolve => { unlock = resolve; }));
    await vi.waitFor(() => expect(unlock).toBeTypeOf('function'));
    const mutate = vi.fn();
    f.registry.handle(C.SET_MODEL, () => withSendToSessionLock('session', async () => { mutate(); }));
    const request = f.invoke(C.SET_MODEL, 'session');
    await vi.waitFor(() => expect(f.authorize).toHaveBeenCalledOnce());
    f.revoke(); unlock(); await held;
    await expect(request).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
    expect(mutate).not.toHaveBeenCalled();
  });

  it('leaves unrelated IPC outside the Session controller', async () => {
    const f = fixture();
    f.registry.handle(C.GET_NEW_MAKER_DEFAULTS, () => 'defaults');
    expect(f.invoke(C.GET_NEW_MAKER_DEFAULTS)).toBe('defaults');
    expect(f.authorize).not.toHaveBeenCalled();
  });

  it('does not lend a completed operation lease to a runtime listener', async () => {
    let release!: () => void;
    let listener!: Promise<void>;
    const authorize = vi.fn(async () => {});
    await withSessionOperation({ authorize, assertCurrent: () => {}, allows: async () => true }, async () => {
      listener = new Promise<void>(resolve => { release = resolve; }).then(async () => {
        expect(() => requireSessionOperation()).toThrow('admission is required');
        await revalidateSessionOperation();
      });
    });
    release(); await listener;
    expect(authorize).not.toHaveBeenCalled();
  });
});
