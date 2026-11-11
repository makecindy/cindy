import { describe, expect, it, vi } from 'vitest';

import { createWorkerCreationPrefsSyncHandler } from '../workerCreationPrefsSyncHandler.js';
import { createWorkerRolesHandlers } from '../workerRolesSync.js';

describe('worker creation prefs sync IPC boundary', () => {
  it('rejects an untrusted sender before parsing or mutating the process-wide cache', () => {
    const denied = new Error('[PERMISSION_DENIED] untrusted renderer');
    const assertTrustedSender = vi.fn(() => {
      throw denied;
    });
    const setWorkerPermissionMode = vi.fn();
    const handler = createWorkerCreationPrefsSyncHandler({
      assertTrustedSender,
      setWorkerPermissionMode,
    });

    expect(() =>
      handler({ sender: 'webview' }, { workerPermissionMode: 'bypassPermissions' }),
    ).toThrow(denied);
    expect(setWorkerPermissionMode).not.toHaveBeenCalled();
  });

  it('accepts only supported permission modes from a trusted renderer', () => {
    const assertTrustedSender = vi.fn();
    const setWorkerPermissionMode = vi.fn();
    const handler = createWorkerCreationPrefsSyncHandler({
      assertTrustedSender,
      setWorkerPermissionMode,
    });

    handler({ sender: 'app' }, { workerPermissionMode: 'bypassPermissions' });
    handler({ sender: 'app' }, { workerPermissionMode: 'root' });
    handler({ sender: 'app' }, null);

    expect(assertTrustedSender).toHaveBeenCalledTimes(3);
    expect(setWorkerPermissionMode).toHaveBeenCalledTimes(1);
    expect(setWorkerPermissionMode).toHaveBeenCalledWith('bypassPermissions');
  });
});

// Unit: trusted IPC must mirror only the active owner's route, after sender admission.
// Previous tests covered permission only; stale owner stamps must not change model routing.
it('fences route snapshots by sender and active owner generation', () => {
  const setSelection = vi.fn();
  const owner = { dataOwnerId: 'owner', ownerGeneration: 2 };
  const route = { agent: 'pi', model: 'test-model', effort: 'high', fast: false, providerId: 'test', agentDeviceId: null };
  let trusted = true;
  const handler = createWorkerCreationPrefsSyncHandler({
    assertTrustedSender: () => { if (!trusted) throw new Error('untrusted'); },
    setWorkerPermissionMode: vi.fn(), getActiveOwner: () => owner, setSelection,
  });
  handler({}, { workerPermissionMode: 'auto', ownerStamp: owner, selection: route });
  // 快照里没带角色清单时第三个参数为 null。
  expect(setSelection).toHaveBeenLastCalledWith(route, owner, null);
  handler({}, { workerPermissionMode: 'auto', ownerStamp: { ...owner, ownerGeneration: 1 }, selection: null });
  handler({}, { workerPermissionMode: 'auto', ownerStamp: { ...owner, dataOwnerId: 'other' }, selection: null });
  trusted = false;
  expect(() => handler({}, { workerPermissionMode: 'auto', ownerStamp: owner, selection: null })).toThrow('untrusted');
  expect(setSelection).toHaveBeenCalledTimes(1);
});

// 测试价值(unit)：协同角色清单以被控端为准(2026-11-10 用户裁决)，手机与远程控制的电脑经这两个
// 入口读写。生产入口 createWorkerCreationPrefsSyncHandler(镜像)与 createWorkerRolesHandlers(读写)。
// 此前没有这条路径。最小失败输入：别的账号的镜像、还没镜像到就读、不认识的操作、未登记的本机窗口。
describe('worker roles remote read/write boundary', () => {
  const owner = { dataOwnerId: 'owner', ownerGeneration: 2 };
  const roles = { roles: [{ role: 'reviewer', task: 'Check the diff' }, { role: 'researcher' }] };

  it('mirrors the role list only for the active owner and drops a list it cannot parse', () => {
    const setSelection = vi.fn();
    const handler = createWorkerCreationPrefsSyncHandler({
      assertTrustedSender: vi.fn(), setWorkerPermissionMode: vi.fn(), getActiveOwner: () => owner, setSelection,
    });
    handler({}, { workerPermissionMode: 'auto', ownerStamp: owner, roles });
    expect(setSelection).toHaveBeenLastCalledWith(null, owner, roles);
    handler({}, { workerPermissionMode: 'auto', ownerStamp: owner, roles: { roles: [{ role: '' }] } });
    expect(setSelection).toHaveBeenLastCalledWith(null, owner, null);
    handler({}, { workerPermissionMode: 'auto', ownerStamp: { ...owner, dataOwnerId: 'other' }, roles });
    expect(setSelection).toHaveBeenCalledTimes(2);
  });

  it('serves the mirror, refuses before it exists, and forwards only valid operations to the renderer', () => {
    let mirror: typeof roles | null = null;
    let remote = true;
    let pending = false;
    const forwardMutation = vi.fn();
    const assertTrustedSender = vi.fn(() => { throw new Error('untrusted'); });
    const handlers = createWorkerRolesHandlers({
      isDeviceLinkInvoke: () => remote,
      assertTrustedSender,
      getActiveOwner: () => owner,
      isBoundaryPending: () => pending,
      getRoles: () => mirror,
      forwardMutation,
    });
    // 还没镜像到：明确报未就绪，控制端据此只显示内置角色。
    expect(() => handlers.get({})).toThrow('PRECONDITION_FAILED');
    mirror = roles;
    expect(handlers.get({})).toEqual(roles);

    expect(handlers.apply({}, { kind: 'forget', role: 'researcher', extra: 1 })).toEqual({ ok: true });
    expect(forwardMutation).toHaveBeenLastCalledWith({ kind: 'forget', role: 'researcher' }, owner);
    expect(() => handlers.apply({}, { kind: 'replace', roles: [] })).toThrow('INVALID_PARAMS');
    expect(forwardMutation).toHaveBeenCalledTimes(1);

    // 账号正在切换时不读不写；本机窗口的调用仍要过可信校验。
    pending = true;
    expect(() => handlers.get({})).toThrow('PRECONDITION_FAILED');
    expect(() => handlers.apply({}, { kind: 'forget', role: 'reviewer' })).toThrow('PRECONDITION_FAILED');
    pending = false;
    expect(assertTrustedSender).not.toHaveBeenCalled();
    remote = false;
    expect(() => handlers.get({})).toThrow('untrusted');
    expect(forwardMutation).toHaveBeenCalledTimes(1);
  });
});
