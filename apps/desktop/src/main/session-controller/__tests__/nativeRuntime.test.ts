import { describe, expect, it, vi } from 'vitest';
import type { Maker, Session } from '@cindy/maker-core';
import { createNativeSessionController } from '../nativeRuntime.js';
import { SessionAdmissionError } from '../controller.js';
import type { SessionCallerPolicy } from '../callerContext.js';

function fixture() {
  let generation = 1;
  let owner = {};
  const send = vi.fn<Session['send']>(async (_message, options) => {
    generation++;
    await options?.onAccepted?.();
    options?.onDispatching?.();
    return { accepted: true };
  });
  const runtime = { id: 'task', instanceId: 'instance', getTurnGeneration: () => generation,
    send, abort: vi.fn(async () => {}), setModel: vi.fn(async () => {}) } as unknown as Session;
  let current: Session | null = runtime;
  const maker = { getSession: () => current, createSession: vi.fn(async () => runtime), closeSession: vi.fn(async () => {}) };
  const controller = createNativeSessionController(maker as unknown as Maker, {
    deviceId: () => 'device', owner: () => owner, execution: () => null,
  });
  const policy: SessionCallerPolicy = { source: 'scheduler', authorize: async () => {} };
  return { controller, policy, runtime, maker, send, setOwner: () => { owner = {}; },
    replace: () => { current = { ...runtime, instanceId: 'replacement' } as Session; } };
}

describe('host native Session ports', () => {
  it('does not close a replacement with the same generation after an authorization await', async () => {
    const f = fixture();
    f.policy.authorize = async () => { f.replace(); };
    await expect(f.controller.closeOwnedRuntime(f.policy, f.runtime)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.maker.closeSession).not.toHaveBeenCalled();
  });
  it('revalidates before native acceptance and preserves the native accepted result', async () => {
    const f = fixture();
    const accepted = vi.fn();
    expect(await f.controller.send(f.policy, f.runtime, 'hello', { onAccepted: accepted })).toEqual({ accepted: true });
    expect(accepted).toHaveBeenCalledOnce();
  });
  it('rejects account changes during native send preparation before the accepted callback', async () => {
    const f = fixture();
    const accepted = vi.fn();
    f.send.mockImplementation(async (_message, options) => {
      f.setOwner();
      await options?.onAccepted?.();
      return { accepted: true };
    });
    await expect(f.controller.send(f.policy, f.runtime, 'hello', { onAccepted: accepted })).rejects.toMatchObject({ code: 'OWNER_SCOPE_CHANGED' });
    expect(accepted).not.toHaveBeenCalled();
  });
  it('never starts a runtime when the source has revoked dispatch', async () => {
    const f = fixture();
    f.policy.authorize = async () => { throw new SessionAdmissionError('NOT_AUTHORIZED', 'cancelled'); };
    await expect(f.controller.ensureRuntime(f.policy, { id: 'task', agentKind: 'codex', workingDir: '/project', model: 'model' })).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
    expect(f.maker.createSession).not.toHaveBeenCalled();
  });
  it('allows exact-handle teardown after logout but rejects a replacement asynchronously', async () => {
    const f = fixture();
    const view = f.controller.ownedView(f.policy, f.runtime, () => true);
    f.setOwner();
    await view.abort();
    expect(f.runtime.abort).toHaveBeenCalledOnce();
    f.replace();
    await expect(view.abort()).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.runtime.abort).toHaveBeenCalledOnce();
  });

});
