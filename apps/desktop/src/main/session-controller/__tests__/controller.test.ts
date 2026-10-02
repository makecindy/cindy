import { describe, expect, it, vi } from 'vitest';
import { captureInternalSessionCaller } from '../internalCaller.js';
import { createSessionController, sessionOperation } from '../controller.js';

function fixture() {
  let owner: object | null = {};
  let execution = { instanceId: 'instance-1', generation: 1 };
  const write = vi.fn(async (_id: string) => ({ status: 'deferred' as const, generation: 7 }));
  const controller = createSessionController({
    deviceId: () => 'device-a', owner: () => owner, execution: () => execution,
  }, {
    select: sessionOperation({ operation: 'selectRuntime', targets: (id: string) => [id],
      execute: (_scope, id: string) => write(id) }),
    lateWrite: sessionOperation({ operation: 'send', targets: (id: string, _wait: () => Promise<void>) => [id],
      execute: async (scope, id: string, wait: () => Promise<void>) => {
        await wait();
        await scope.authorize();
        return write(id);
      } }),
  });
  return { controller, write, changeOwner: () => { owner = {}; },
    replaceExecution: () => { execution = { instanceId: 'instance-2', generation: 1 }; } };
}

describe('Session controller admission and business boundaries', () => {
  it('preserves the business result and checks the real target before invoking', async () => {
    const { controller, write } = fixture();
    const authorize = vi.fn(async () => {});
    const caller = controller.issueCaller({ source: 'plugin', authorize });
    expect(await controller.invoke(caller, 'select', 'target')).toEqual({ status: 'deferred', generation: 7 });
    expect(authorize).toHaveBeenCalledWith({ operation: 'selectRuntime', deviceId: 'device-a',
      targets: [{ deviceId: 'device-a', sessionId: 'target' }] });
    expect(write).toHaveBeenCalledOnce();
  });

  it('rejects a model-supplied or copied caller even when its source says ui', async () => {
    const { controller, write } = fixture();
    await expect(controller.invoke({ source: 'ui' }, 'select', 'target')).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
    const real = controller.issueCaller({ source: 'ui', authorize: async () => {} });
    await expect(controller.invoke({ ...real }, 'select', 'target')).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
    expect(write).not.toHaveBeenCalled();
  });

  it('rejects account changes while the authorization lookup is pending', async () => {
    const { controller, write, changeOwner } = fixture();
    const caller = controller.issueCaller({ source: 'companion', authorize: async () => changeOwner() });
    await expect(controller.invoke(caller, 'select', 'target')).rejects.toMatchObject({ code: 'OWNER_SCOPE_CHANGED' });
    expect(write).not.toHaveBeenCalled();
  });

  it('rechecks revocation after waiting for the existing write boundary', async () => {
    const { controller, write } = fixture();
    let revoked = false;
    const caller = controller.issueCaller({ source: 'plugin', authorize: async () => {
      if (revoked) throw new Error('plugin approval revoked');
    } });
    await expect(controller.invoke(caller, 'lateWrite', 'target', async () => { revoked = true; }))
      .rejects.toThrow('plugin approval revoked');
    expect(write).not.toHaveBeenCalled();
  });

  it('does not turn a denied request into a backend call', async () => {
    const { controller, write } = fixture();
    const caller = controller.issueCaller({ source: 'companion', authorize: async () => { throw new Error('outside project'); } });
    await expect(controller.invoke(caller, 'select', 'target')).rejects.toThrow('outside project');
    expect(write).not.toHaveBeenCalled();
  });

  it('internal composition cannot replace a revoked plugin policy or retain its completed lease', async () => {
    const owner = {};
    const host = { deviceId: () => 'device-a', owner: () => owner, execution: () => null };
    let allowed = true;
    let composed!: ReturnType<typeof captureInternalSessionCaller>;
    const admission = { operation: 'send' as const, deviceId: 'device-a', targets: [{ deviceId: 'device-a', sessionId: 'target' }] };
    const controller = createSessionController(host, { send: sessionOperation({ operation: 'send', targets: () => ['target'], execute: async () => {
      composed = captureInternalSessionCaller(host, { source: 'host', sessionIds: ['target'], operations: ['send'] });
      allowed = false;
      await expect(composed.authorize(admission)).rejects.toThrow('revoked');
      allowed = true;
    } }) });
    await controller.invoke(controller.issueCaller({ source: 'plugin', authorize: async () => { if (!allowed) throw new Error('revoked'); } }), 'send');
    await expect(composed.authorize(admission)).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
  });
  it('old instance cancellation cannot match a new runtime with the same turn number', () => {
    const { controller, replaceExecution } = fixture();
    const target = { deviceId: 'device-a', sessionId: 'target' };
    controller.assertExecution(target, { instanceId: 'instance-1', generation: 1 });
    replaceExecution();
    expect(() => controller.assertExecution(target, { instanceId: 'instance-1', generation: 1 }))
      .toThrow('Session execution changed');
  });

  it('rejects same-named files on another device or SSH namespace', () => {
    const { controller } = fixture();
    const file = { kind: 'file' as const, locator: '/workspace/report.txt', owningDeviceId: 'device-b', remoteHostId: null };
    expect(() => controller.assertResources([file], null)).toThrow('Resource belongs to another device');
    expect(() => controller.assertResources([{ ...file, owningDeviceId: 'device-a', remoteHostId: 'ssh-a' }], null))
      .toThrow('Resource belongs to another device');
    expect(() => controller.assertResources([{ ...file, owningDeviceId: 'device-a' }], null)).not.toThrow();
  });
});
