/**
 * 供应商组设置的 IPC 业务体：入参校验，以及「新加入的电脑必须是这台电脑已经能用的同一个供应商」。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ipcMain, type IpcMainInvokeEvent } from 'electron';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('../fastPolicyRuntime.js', () => ({ groupFastPolicyPending: vi.fn(() => false), syncGroupFastPolicy: vi.fn(async () => {}) }));
vi.mock('../../device-link/dispatch.js', () => ({ notifyProviderShareCatalogChanged: vi.fn() }));
vi.mock('../runtime.js', () => ({
  getProviderGroupDirectory: vi.fn(),
  getProviderGroupRouter: vi.fn(),
  getProviderGroupRemoteClient: vi.fn(),
  readProviderGroupOfSession: vi.fn(),
  readProviderGroupRebalanceSuggestion: vi.fn(),
  recordProviderGroupRebalanceDecision: vi.fn(),
}));
vi.mock('../store.js', () => ({ readProviderGroup: vi.fn(), writeProviderGroup: vi.fn(), listProviderGroups: vi.fn() }));
vi.mock('../bindings.js', () => ({ pruneProviderGroupBindings: vi.fn() }));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: vi.fn(() => 'owner-a'),
  isAppSessionBoundaryPending: vi.fn(() => false),
}));
vi.mock('../../security/trustedAppRenderer.js', () => ({ assertTrustedAppRendererEvent: vi.fn() }));
vi.mock('../../device-link/index.js', () => ({ broadcast: vi.fn(), getSelfDeviceId: vi.fn(() => 'self'), remoteInvoke: vi.fn(), remoteBackgroundInvoke: vi.fn() }));
// 同账号管理的转发另有 managementClient.test.ts；IPC 回归只替换转发，不拉进分享运行时。
vi.mock('../managementClient.js', () => ({ invokeProviderManagement: vi.fn() }));
vi.mock('../../device-link/providerShareRuntime.js', () => ({
  executeProviderShareManagementCommand: vi.fn(), parseProviderShareCommand: vi.fn(),
}));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

import type { ProviderGroupCandidate, ProviderGroupConfig } from '../../../shared/providerGroup';
import type { ProviderManagementRequest } from '../../../shared/providerManagement';
import {
  executeProviderGroupCommand,
  markMembersUnreachableHere,
  parseProviderGroupCommand,
  registerProviderGroupIpc,
  createProviderGroupCommandDeps,
  PROVIDER_GROUP_REACHABILITY_CHECK_TIMEOUT_MS,
  type ProviderGroupCommandDeps,
} from '../ipc';
import { handleProviderManagementRequest, parseProviderManagementRequest } from '../management';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../../appSessionState';
import { executeProviderShareManagementCommand, parseProviderShareCommand } from '../../device-link/providerShareRuntime';
import { getProviderGroupDirectory, getProviderGroupRouter } from '../runtime';
import { invokeProviderManagement } from '../managementClient';
import { pruneProviderGroupBindings } from '../bindings';
import { readProviderGroup, writeProviderGroup } from '../store';
import { broadcast } from '../../device-link/index';

const LOCAL = { key: 'local', kind: 'local' as const, agentDeviceId: null, providerId: 'anthropic', limit: 4, weight: 1, paused: false };
const MINI = {
  key: 'device:mini:anthropic-1a2b3c4d',
  kind: 'device' as const,
  agentDeviceId: 'mini',
  providerId: 'anthropic-1a2b3c4d',
  label: 'stale label',
  limit: 4,
  weight: 1,
  paused: false,
};
const SHARED = {
  ...MINI, key: 'share:s1:anthropic', kind: 'share' as const, agentDeviceId: 'share:s1', providerId: 'anthropic',
};

afterEach(() => vi.mocked(isAppSessionBoundaryPending).mockReturnValue(false));

function deps(candidates: ProviderGroupCandidate[], existing: ProviderGroupConfig | null = null) {
  let stored = existing;
  let owner = 'owner-a';
  return {
    switchOwner: (next: string) => { owner = next; },
    ownerKey: vi.fn(() => owner),
    localDeviceId: vi.fn(() => 'self'),
    pruneBindings: vi.fn(async () => {}),
    router: { view: vi.fn(async (providerId: string) => ({ providerId, config: stored, members: [] })) },
    directory: { listCandidates: vi.fn(async () => candidates), resolveMembers: vi.fn(), invalidate: vi.fn() },
    readGroup: vi.fn(() => stored),
    writeGroup: vi.fn(async (_id: string, config: unknown) => {
      stored = config as ProviderGroupConfig | null;
      return stored;
    }),
    changed: vi.fn(),
  } as unknown as ProviderGroupCommandDeps & {
    writeGroup: ReturnType<typeof vi.fn>;
    changed: ReturnType<typeof vi.fn>;
    pruneBindings: ReturnType<typeof vi.fn>;
    switchOwner(next: string): void;
  };
}

describe('parseProviderGroupCommand', () => {
  // Unit: the real command boundary must preserve the confirmed message ID instead of a session-wide decision.
  it('passes a confirmed message id through parsing and execution', async () => {
    const d = deps([]);
    d.rebalanceDecision = vi.fn(async () => true);
    const request = { action: 'rebalance-decision', sessionId: 's1', memberKey: MINI.key, remember: false, clientId: 'message-a' };
    const command = parseProviderGroupCommand(request);
    if (command.action !== 'rebalance-decision') throw new Error('Expected the rebalance decision command');
    expect(await executeProviderGroupCommand(d, command)).toEqual({ ok: true });
    expect(d.rebalanceDecision).toHaveBeenCalledWith('s1', MINI.key, false, 'message-a');
    expect(() => parseProviderGroupCommand({ ...request, clientId: 'bad id' })).toThrow();
  });

  it('rejects malformed commands', () => {
    expect(() => parseProviderGroupCommand(null)).toThrow();
    expect(() => parseProviderGroupCommand({ action: 'get', providerId: 'bad id' })).toThrow();
    expect(() => parseProviderGroupCommand({ action: 'nope', providerId: 'anthropic' })).toThrow();
    expect(() => parseProviderGroupCommand({ action: 'save', providerId: 'anthropic' })).toThrow();
    expect(parseProviderGroupCommand({ action: 'get', providerId: 'anthropic' })).toEqual({ action: 'get', providerId: 'anthropic' });
  });

  it('accepts listing this computer’s groups and reading a group on another computer', () => {
    expect(parseProviderGroupCommand({ action: 'list' })).toEqual({ action: 'list' });
    expect(parseProviderGroupCommand({ action: 'remote-view', providerId: 'anthropic', deviceId: 'mini' }))
      .toEqual({ action: 'remote-view', providerId: 'anthropic', deviceId: 'mini' });
    expect(() => parseProviderGroupCommand({ action: 'remote-view', providerId: 'anthropic' })).toThrow();
    expect(() => parseProviderGroupCommand({ action: 'remote-view', providerId: 'anthropic', deviceId: 'bad id' })).toThrow();
  });

  it('accepts asking which group a task is in, without a provider id', () => {
    expect(parseProviderGroupCommand({ action: 'session-group', sessionId: 'db5a0a2c-3084-408c-9f78-234fe3c6745c' }))
      .toEqual({ action: 'session-group', sessionId: 'db5a0a2c-3084-408c-9f78-234fe3c6745c' });
    expect(() => parseProviderGroupCommand({ action: 'session-group' })).toThrow();
    expect(() => parseProviderGroupCommand({ action: 'session-group', sessionId: '../x' })).toThrow();
  });

  it('requires an explicit editing snapshot for conditional writes and rejects legacy remote writes', () => {
    const config: ProviderGroupConfig = { strategy: 'least', autoSwitch: true, members: [LOCAL] };
    for (const action of ['save-if-current', 'delete-if-current'] as const) {
      for (const expectedConfig of [null, config]) {
        const parsed = parseProviderGroupCommand({ action, providerId: 'anthropic', config, expectedConfig });
        expect(parsed).toMatchObject({ action, expectedConfig });
        expect(parseProviderManagementRequest({ action: 'manage-group', command: parsed })).toEqual({
          action: 'manage-group', command: parsed,
        });
      }
      for (const expectedConfig of [undefined, false, [], {}, { members: [] }]) {
        expect(() => parseProviderGroupCommand({ action, providerId: 'anthropic', config, expectedConfig }))
          .toThrow(/INVALID_PARAMS/);
      }
    }
    for (const action of ['save', 'delete']) {
      expect(() => parseProviderManagementRequest({ action: 'manage-group', command: { action, providerId: 'anthropic', config } }))
        .toThrow(/UNSUPPORTED_CAPABILITY/);
    }
  });
});

describe('executeProviderGroupCommand reads', () => {
  it('lists local groups without touching the network and forwards remote views', async () => {
    const d = deps([]);
    const listGroups = vi.fn(() => ({ anthropic: { strategy: 'least', autoSwitch: true, members: [] } }));
    const remoteView = vi.fn(async () => ({ providerId: 'anthropic', config: null, members: [] }));
    Object.assign(d, { listGroups, remoteView });
    expect(await executeProviderGroupCommand(d, { action: 'list' })).toEqual({ anthropic: expect.any(Object) });
    expect(d.router.view).not.toHaveBeenCalled();
    await executeProviderGroupCommand(d, { action: 'remote-view', providerId: 'anthropic', deviceId: 'mini' });
    expect(remoteView).toHaveBeenCalledWith('mini', 'anthropic');
  });

  it('marks a computer in another computer’s group that this computer cannot reach', async () => {
    const config: ProviderGroupConfig = {
      strategy: 'least',
      autoSwitch: true,
      members: [
        LOCAL,
        MINI,
        { ...MINI, key: 'device:self:anthropic', agentDeviceId: 'self', providerId: 'anthropic' },
        { ...MINI, key: 'device:vm:anthropic', agentDeviceId: 'vm', providerId: 'anthropic' },
      ],
    };
    const status = (key: string, state: 'available' | 'cooling') => ({
      key, kind: 'device' as const, label: key, state, running: 2, limit: 4, weight: 1, paused: false,
    });
    const view = {
      providerId: 'anthropic',
      config,
      members: [
        { ...status('local', 'available'), kind: 'local' as const },
        status(MINI.key, 'available'),
        status('device:self:anthropic', 'available'),
        status('device:vm:anthropic', 'cooling'),
      ],
    };
    // 这台电脑读不到 mini 的目录(连不上)。
    const readDeviceCatalog = vi.fn(async (agentDeviceId: string): Promise<never[]> => {
      throw new Error('[DEVICE_LINK_DEVICE_UNRESPONSIVE] target device ' + agentDeviceId + ' is unresponsive (circuit open)');
    });
    const marked = await markMembersUnreachableHere(view, { readDeviceCatalog }, 'self');
    // 只核对组所在电脑看着能用、由这台直连的「我的其他电脑」：组所在电脑自己、本机这台、冷却中的都不读。
    expect(readDeviceCatalog.mock.calls.map(([id]) => id)).toEqual(['mini']);
    expect(marked.members.map((m) => [m.key, m.unreachableHere === true])).toEqual([
      ['local', false],
      [MINI.key, true],
      ['device:self:anthropic', false],
      ['device:vm:anthropic', false],
    ]);
    // 其余字段照组所在电脑的回包。
    expect(marked.members[1]).toMatchObject({ state: 'available', running: 2 });
  });

  it.each([MINI, SHARED])('leaves a reachable $kind member unchanged, and skips probing before login', async (member) => {
    const config: ProviderGroupConfig = { strategy: 'least', autoSwitch: true, members: [LOCAL, member] };
    const view = {
      providerId: 'anthropic',
      config,
      members: [{ key: member.key, kind: member.kind, label: 'member', state: 'available' as const, running: 0, limit: 4, weight: 1, paused: false }],
    };
    const reachable = vi.fn(async () => []);
    expect(await markMembersUnreachableHere(view, { readDeviceCatalog: reachable }, 'self')).toBe(view);
    // 还不知道本机是哪台(没登录)：不判断。
    const unused = vi.fn(async () => []);
    expect(await markMembersUnreachableHere(view, { readDeviceCatalog: unused }, null)).toBe(view);
    expect(unused).not.toHaveBeenCalled();
  });

  it.each(['available', 'full'] as const)('marks a shared member reported as %s when it is unavailable on this computer', async (state) => {
    const config: ProviderGroupConfig = { strategy: 'least', autoSwitch: true, members: [LOCAL, SHARED] };
    const view = {
      providerId: 'anthropic', config,
      members: [{ key: SHARED.key, kind: SHARED.kind, label: 'Kai', state, running: 4, limit: 4, weight: 1, paused: false }],
    };
    // 分享按账号收到，跨区连接却按电脑启用：组所在电脑能用，不代表查看电脑也能直连。
    const readDeviceCatalog = vi.fn(async () => { throw new Error('[REMOTE_AGENT_SHARE_REMOVED] share not found'); });
    const result = await markMembersUnreachableHere(view, { readDeviceCatalog }, 'self');
    expect(readDeviceCatalog).toHaveBeenCalledExactlyOnceWith('share:s1');
    expect(result.members[0]).toEqual({ ...view.members[0], unreachableHere: true });
    expect(view.members[0]).not.toHaveProperty('unreachableHere');
  });

  it.each([MINI, SHARED])('does not hold the group view on a slow $kind member, and does not mark it', async (member) => {
    vi.useFakeTimers();
    try {
      const config: ProviderGroupConfig = { strategy: 'least', autoSwitch: true, members: [LOCAL, member] };
      const view = {
        providerId: 'anthropic',
        config,
        members: [{ key: member.key, kind: member.kind, label: 'member', state: 'available' as const, running: 0, limit: 4, weight: 1, paused: false }],
      };
      // 读目录一直没有结果(还没超时、熔断也还没打开)。
      const slow = vi.fn(() => new Promise<never[]>(() => undefined));
      const pending = markMembersUnreachableHere(view, { readDeviceCatalog: slow }, 'self');
      await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_REACHABILITY_CHECK_TIMEOUT_MS);
      expect(await pending).toBe(view);
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers which group a task is in from the service', async () => {
    const d = deps([]);
    const sessionGroup = vi.fn(async () => ({ groupDeviceId: 'mini', providerId: 'anthropic' }));
    Object.assign(d, { sessionGroup });
    expect(await executeProviderGroupCommand(d, { action: 'session-group', sessionId: 's1' }))
      .toEqual({ groupDeviceId: 'mini', providerId: 'anthropic' });
    expect(sessionGroup).toHaveBeenCalledWith('s1');
  });
});

describe('provider group IPC remote management', () => {
  const config: ProviderGroupConfig = { strategy: 'least', autoSwitch: true, members: [LOCAL, MINI] };
  const view = {
    providerId: 'anthropic', config,
    members: [{ key: MINI.key, kind: 'device' as const, label: 'mini', state: 'available' as const, running: 2, limit: 4, weight: 1, paused: false }],
  };
  const groupRequests: ProviderManagementRequest[] = [
    { action: 'manage-group', command: { action: 'get', providerId: 'anthropic' } },
    { action: 'manage-group', command: { action: 'save-if-current', providerId: 'anthropic', config, expectedConfig: config } },
  ];
  // 走真正注册的 IPC listener，确保进入管理页的路径也使用查看端可达性投影。
  function invokeRemoteCommand(
    d: ProviderGroupCommandDeps,
    remoteManage: (deviceId: string, request: ProviderManagementRequest) => Promise<unknown>,
    request: ProviderManagementRequest,
  ) {
    vi.mocked(activeOwnerScopeKey).mockImplementation(d.ownerKey);
    vi.mocked(getProviderGroupDirectory).mockReturnValue(d.directory);
    vi.mocked(getProviderGroupRouter).mockReturnValue(d.router);
    vi.mocked(invokeProviderManagement).mockImplementation((_invoke, deviceId, command) => remoteManage(deviceId, command));
    registerProviderGroupIpc();
    const listener = vi.mocked(ipcMain.handle).mock.calls.at(-1)![1];
    return listener({} as IpcMainInvokeEvent, { action: 'remote-manage', deviceId: 'group-host', request });
  }

  afterEach(() => vi.mocked(activeOwnerScopeKey).mockReturnValue('owner-a'));

  it.each(['entry', 'remote reply', 'reachability read'])('rejects management when teardown starts at %s without changing the owner key', async (stage) => {
    const d = deps([]);
    const remoteManage = vi.fn(async () => {
      if (stage === 'remote reply') vi.mocked(isAppSessionBoundaryPending).mockReturnValue(true);
      return view;
    });
    const readDeviceCatalog = vi.fn(async () => {
      vi.mocked(isAppSessionBoundaryPending).mockReturnValue(true);
      return [];
    });
    Object.assign(d, { directory: { ...d.directory, readDeviceCatalog } });
    if (stage === 'entry') vi.mocked(isAppSessionBoundaryPending).mockReturnValue(true);
    await expect(invokeRemoteCommand(d, remoteManage, groupRequests[0])).rejects.toThrow(/PRECONDITION_FAILED/);
    expect(remoteManage).toHaveBeenCalledTimes(stage === 'entry' ? 0 : 1);
    expect(readDeviceCatalog).toHaveBeenCalledTimes(stage === 'reachability read' ? 1 : 0);
  });

  it.each(groupRequests)('marks unreachable members in a remote $command.action result without changing the group state', async (request) => {
    const d = deps([]);
    const remoteManage = vi.fn(async () => view);
    const readDeviceCatalog = vi.fn(async () => { throw new Error('unreachable from this computer'); });
    Object.assign(d, { directory: { ...d.directory, readDeviceCatalog } });
    const result = await invokeRemoteCommand(d, remoteManage, request);
    expect(remoteManage).toHaveBeenCalledExactlyOnceWith('group-host', request);
    expect(readDeviceCatalog).toHaveBeenCalledExactlyOnceWith('mini');
    expect(result).toMatchObject({ members: [{ key: MINI.key, state: 'available', running: 2, unreachableHere: true }] });
    expect(view.members[0]).not.toHaveProperty('unreachableHere');
  });

  it.each(groupRequests)('probes shared members from this computer after remote $command.action', async (request) => {
    const d = deps([]);
    const sharedView = {
      ...view, config: { ...config, members: [LOCAL, SHARED] },
      members: [{ ...view.members[0], key: SHARED.key, kind: SHARED.kind, state: 'full' as const }],
    };
    const remoteManage = vi.fn(async () => sharedView);
    const readDeviceCatalog = vi.fn(async () => { throw new Error('share is unavailable from this computer'); });
    Object.assign(d, { directory: { ...d.directory, readDeviceCatalog } });
    const result = await invokeRemoteCommand(d, remoteManage, request);
    expect(readDeviceCatalog).toHaveBeenCalledExactlyOnceWith('share:s1');
    expect(result).toMatchObject({ members: [{ key: SHARED.key, state: 'full', running: 2, unreachableHere: true }] });
    expect(sharedView.members[0]).not.toHaveProperty('unreachableHere');
  });

  it('keeps candidates and share management results unchanged, and accepts a deleted group without probing members', async () => {
    const d = deps([]);
    const readDeviceCatalog = vi.fn();
    const remoteManage = vi.fn();
    Object.assign(d, { directory: { ...d.directory, readDeviceCatalog } });
    const cases: { request: ProviderManagementRequest; result: unknown }[] = [
      { request: { action: 'manage-group', command: { action: 'candidates', providerId: 'anthropic' } }, result: [] },
      { request: { action: 'manage-share', command: { action: 'owned', range: '7d' } }, result: { ready: true, shares: [] } },
      { request: { action: 'manage-group', command: { action: 'delete-if-current', providerId: 'anthropic', expectedConfig: config } }, result: { providerId: 'anthropic', config: null, members: [] } },
    ];
    for (const { request, result } of cases) {
      remoteManage.mockResolvedValueOnce(result);
      expect(await invokeRemoteCommand(d, remoteManage, request)).toEqual(result);
    }
    expect(remoteManage).toHaveBeenCalledTimes(3);
    expect(readDeviceCatalog).not.toHaveBeenCalled();
  });

  it.each(['remote reply', 'reachability read'])('drops a remote group view when the account changes during %s', async (stage) => {
    const d = deps([]);
    const remoteManage = vi.fn(async () => {
      if (stage === 'remote reply') d.switchOwner('owner-b');
      return view;
    });
    const readDeviceCatalog = vi.fn(async () => {
      d.switchOwner('owner-b');
      return [];
    });
    Object.assign(d, { directory: { ...d.directory, readDeviceCatalog } });
    await expect(invokeRemoteCommand(d, remoteManage, groupRequests[0]))
      .rejects.toThrow(/PRECONDITION_FAILED/);
    expect(readDeviceCatalog).toHaveBeenCalledTimes(stage === 'remote reply' ? 0 : 1);
  });
});

describe('executeProviderGroupCommand save', () => {
  it.each(['save-if-current', 'delete-if-current'] as const)(
    'does not publish or prune %s under a new owner after Fast synchronization fails',
    async (action) => {
      const config: ProviderGroupConfig = { strategy: 'least', autoSwitch: true, members: [LOCAL] };
      const d = deps([], config);
      d.syncFastPolicy = vi.fn(async () => { d.switchOwner('owner-b'); throw Error('native busy'); });
      await expect(executeProviderGroupCommand(d, {
        action, providerId: 'anthropic', expectedConfig: config, config: { ...config, allowFast: false },
      })).rejects.toThrow('PRECONDITION_FAILED');
      expect(d.pruneBindings).not.toHaveBeenCalled();
      expect(d.changed).not.toHaveBeenCalled();
    },
  );

  it.each(['save-if-current', 'delete-if-current'] as const)(
    'publishes the committed %s and prunes bindings even if native Fast synchronization fails',
    async (action) => {
      const config: ProviderGroupConfig = { strategy: 'least', autoSwitch: true, members: [LOCAL] };
      const d = deps([], config);
      d.syncFastPolicy = vi.fn(async () => { throw Error('native busy'); });
      await expect(executeProviderGroupCommand(d, {
        action, providerId: 'anthropic', expectedConfig: config,
        config: { ...config, allowFast: false },
      })).rejects.toThrow('native busy');
      expect(d.pruneBindings).toHaveBeenCalledWith('anthropic', action === 'delete-if-current' ? null : new Set(['local']));
      expect(d.changed).toHaveBeenCalledWith('anthropic');
      expect(d.readGroup('anthropic')).toEqual(action === 'delete-if-current' ? null : { ...config, allowFast: false });
    },
  );

  it.each(['save-if-current', 'delete-if-current'] as const)('refuses %s before any work while the old owner is being torn down', async (action) => {
    const d = deps([]);
    vi.mocked(isAppSessionBoundaryPending).mockReturnValue(true);
    await expect(executeProviderGroupCommand(d, {
      action, providerId: 'anthropic', expectedConfig: null,
      config: { strategy: 'least', autoSwitch: true, members: [LOCAL] },
    })).rejects.toThrow(/PRECONDITION_FAILED/);
    expect(d.directory.listCandidates).not.toHaveBeenCalled();
    expect(d.writeGroup).not.toHaveBeenCalled();
    expect(d.pruneBindings).not.toHaveBeenCalled();
  });

  it('does not save when teardown starts during candidate lookup with the owner key unchanged', async () => {
    const candidate = { key: MINI.key, kind: 'device' as const, agentDeviceId: 'mini', providerId: MINI.providerId, label: 'Mac mini', providerName: 'Claude' };
    const d = deps([candidate]);
    vi.mocked(d.directory.listCandidates).mockImplementationOnce(async () => {
      vi.mocked(isAppSessionBoundaryPending).mockReturnValue(true);
      return [candidate];
    });
    await expect(executeProviderGroupCommand(d, {
      action: 'save-if-current', providerId: 'anthropic', expectedConfig: null,
      config: { strategy: 'least', autoSwitch: true, members: [LOCAL, MINI] },
    })).rejects.toThrow(/PRECONDITION_FAILED/);
    expect(d.writeGroup).not.toHaveBeenCalled();
    expect(d.pruneBindings).not.toHaveBeenCalled();
  });

  it.each([
    ['save-if-current', 'write'], ['save-if-current', 'prune'], ['save-if-current', 'view'],
    ['delete-if-current', 'write'], ['delete-if-current', 'prune'], ['delete-if-current', 'view'],
  ] as const)('stops %s after teardown begins during %s', async (action, stage) => {
    const config: ProviderGroupConfig = { strategy: 'least', autoSwitch: true, members: [LOCAL] };
    const d = deps([], config);
    const beginBoundary = () => vi.mocked(isAppSessionBoundaryPending).mockReturnValue(true);
    if (stage === 'write') d.writeGroup.mockImplementationOnce(async () => { beginBoundary(); return config; });
    if (stage === 'prune') d.pruneBindings.mockImplementationOnce(async () => { beginBoundary(); });
    if (stage === 'view') vi.mocked(d.router.view).mockImplementationOnce(async () => { beginBoundary(); return { providerId: 'anthropic', config, members: [] }; });
    await expect(executeProviderGroupCommand(d, { action, providerId: 'anthropic', config, expectedConfig: config }))
      .rejects.toThrow(/PRECONDITION_FAILED/);
    expect(d.pruneBindings).toHaveBeenCalledTimes(stage === 'write' ? 0 : 1);
    expect(d.changed).toHaveBeenCalledTimes(stage === 'view' ? 1 : 0);
    expect(d.router.view).toHaveBeenCalledTimes(stage === 'view' ? 1 : 0);
  });

  it('passes the editing snapshot through candidate validation to the atomic writer', async () => {
    const initial: ProviderGroupConfig = { strategy: 'least', autoSwitch: true, members: [LOCAL] };
    const d = deps([{ key: MINI.key, kind: 'device', agentDeviceId: 'mini', providerId: MINI.providerId, label: 'Mac mini', providerName: 'Claude' }], initial);
    // 目录读取期间另一个编辑已落盘；最终写入处检查，而不是只在开始时检查。
    d.writeGroup.mockRejectedValueOnce(new Error('[PROVIDER_GROUP_CHANGED] changed while reading candidates'));
    await expect(executeProviderGroupCommand(d, {
      action: 'save-if-current', providerId: 'anthropic', expectedConfig: initial,
      config: { ...initial, members: [LOCAL, MINI] },
    })).rejects.toThrow(/PROVIDER_GROUP_CHANGED/);
    expect(d.directory.listCandidates).toHaveBeenCalled();
    expect(d.writeGroup).toHaveBeenCalledWith('anthropic', expect.objectContaining({
      members: [LOCAL, { ...MINI, label: 'Mac mini', providerName: 'Claude' }],
    }), initial);
    expect(d.pruneBindings).not.toHaveBeenCalled();
    expect(d.changed).not.toHaveBeenCalled();
  });

  it('does not release task bindings when a stale delete is rejected', async () => {
    const initial: ProviderGroupConfig = { strategy: 'least', autoSwitch: true, members: [LOCAL] };
    const d = deps([], initial);
    d.writeGroup.mockRejectedValueOnce(new Error('[PROVIDER_GROUP_CHANGED] changed before delete'));
    await expect(executeProviderGroupCommand(d, {
      action: 'delete-if-current', providerId: 'anthropic', expectedConfig: initial,
    })).rejects.toThrow(/PROVIDER_GROUP_CHANGED/);
    expect(d.writeGroup).toHaveBeenCalledWith('anthropic', null, initial);
    expect(d.pruneBindings).not.toHaveBeenCalled();
    expect(d.changed).not.toHaveBeenCalled();
  });

  it('accepts computers this computer can already use and takes their names from the directory', async () => {
    const d = deps([{ key: MINI.key, kind: 'device', agentDeviceId: 'mini', providerId: MINI.providerId, label: 'Mac mini', providerName: 'Claude' }]);
    await executeProviderGroupCommand(d, {
      action: 'save',
      providerId: 'anthropic',
      // 渲染端带来的账号名只是快照，以目录为准。
      config: { strategy: 'least', autoSwitch: true, members: [LOCAL, { ...MINI, providerName: 'Stale name' }] },
    });
    const written = d.writeGroup.mock.calls[0][1] as ProviderGroupConfig;
    expect(written.members.map((m) => m.key)).toEqual(['local', MINI.key]);
    expect(written.members[1].label).toBe('Mac mini');
    expect(written.members[1].providerName).toBe('Claude');
    expect(d.changed).toHaveBeenCalledWith('anthropic');
  });

  it('records the sharer’s computer of a shared-in member from the directory and keeps it on later saves', async () => {
    const SHARED = { key: 'share:s1:anthropic', kind: 'share' as const, agentDeviceId: 'share:s1', providerId: 'anthropic', limit: 4, weight: 1, paused: false };
    const d = deps([{ key: SHARED.key, kind: 'share', agentDeviceId: 'share:s1', providerId: 'anthropic', label: 'Kai', providerName: 'Claude', ownerName: 'Kai', hostDeviceId: 'kai-pc' }]);
    await executeProviderGroupCommand(d, {
      action: 'save',
      providerId: 'anthropic',
      config: { strategy: 'least', autoSwitch: true, members: [LOCAL, { ...SHARED, hostDeviceId: 'forged' }] },
    });
    expect((d.writeGroup.mock.calls[0][1] as ProviderGroupConfig).members[1].hostDeviceId).toBe('kai-pc');
    // 设置页即使带着伪造的快照保存(例如只改了暂停)，也以目录里的值为准。
    await executeProviderGroupCommand(d, {
      action: 'save',
      providerId: 'anthropic',
      config: { strategy: 'least', autoSwitch: true, members: [LOCAL, { ...SHARED, paused: true, hostDeviceId: 'forged-again' }] },
    });
    expect((d.writeGroup.mock.calls[1][1] as ProviderGroupConfig).members[1]).toMatchObject({ paused: true, hostDeviceId: 'kai-pc' });
  });

  it('does not trust a shared host id when the renderer has a stale member snapshot', async () => {
    const SHARED = { key: 'share:s1:anthropic', kind: 'share' as const, agentDeviceId: 'share:s1', providerId: 'anthropic', limit: 4, weight: 1, paused: false };
    const existing: ProviderGroupConfig = {
      strategy: 'least',
      autoSwitch: true,
      members: [LOCAL, { ...SHARED, hostDeviceId: 'kai-pc' }],
    };
    const d = deps([{ key: SHARED.key, kind: 'share', agentDeviceId: 'share:s1', providerId: 'anthropic', label: 'Kai', providerName: 'Claude', ownerName: 'Kai', hostDeviceId: 'kai-pc' }], existing);

    await executeProviderGroupCommand(d, {
      action: 'save',
      providerId: 'anthropic',
      config: { ...existing, members: [LOCAL, { ...SHARED, hostDeviceId: 'forged' }] },
    });

    expect((d.writeGroup.mock.calls[0][1] as ProviderGroupConfig).members[1].hostDeviceId).toBe('kai-pc');
  });

  it('refuses a computer that is not offered as a candidate', async () => {
    const d = deps([]);
    await expect(executeProviderGroupCommand(d, {
      action: 'save',
      providerId: 'anthropic',
      config: { strategy: 'least', autoSwitch: true, members: [LOCAL, MINI] },
    })).rejects.toThrow(/PRECONDITION_FAILED/);
    expect(d.writeGroup).not.toHaveBeenCalled();
  });

  it('does not re-check members that were already in the group (they may be offline)', async () => {
    const existing: ProviderGroupConfig = { strategy: 'least', autoSwitch: true, members: [LOCAL, MINI] };
    const d = deps([], existing);
    await executeProviderGroupCommand(d, {
      action: 'save',
      providerId: 'anthropic',
      config: { ...existing, strategy: 'round' },
    });
    expect(d.directory.listCandidates).not.toHaveBeenCalled();
    expect((d.writeGroup.mock.calls[0][1] as ProviderGroupConfig).strategy).toBe('round');
  });

  it('deletes the group when the last member is removed', async () => {
    const d = deps([], { strategy: 'least', autoSwitch: true, members: [LOCAL] });
    await executeProviderGroupCommand(d, {
      action: 'save',
      providerId: 'anthropic',
      config: { strategy: 'least', autoSwitch: true, members: [] },
    });
    expect(d.writeGroup).toHaveBeenCalledWith('anthropic', null);
    expect(d.pruneBindings).toHaveBeenCalledWith('anthropic', null);
  });

  it('releases tasks bound to computers that were removed from the group', async () => {
    const d = deps([], { strategy: 'least', autoSwitch: true, members: [LOCAL, MINI] });
    await executeProviderGroupCommand(d, {
      action: 'save',
      providerId: 'anthropic',
      config: { strategy: 'least', autoSwitch: true, members: [LOCAL] },
    });
    expect(d.pruneBindings).toHaveBeenCalledWith('anthropic', new Set(['local']));

    const removed = deps([], { strategy: 'least', autoSwitch: true, members: [LOCAL] });
    await executeProviderGroupCommand(removed, { action: 'delete', providerId: 'anthropic' });
    expect(removed.pruneBindings).toHaveBeenCalledWith('anthropic', null);
  });

  it('does not write when the account changed while reading the candidates', async () => {
    const d = deps([{ key: MINI.key, kind: 'device', agentDeviceId: 'mini', providerId: MINI.providerId, label: 'Mac mini', providerName: 'Claude' }]);
    (d.directory.listCandidates as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      d.switchOwner('owner-b');
      return [{ key: MINI.key, kind: 'device', agentDeviceId: 'mini', providerId: MINI.providerId, label: 'Mac mini', providerName: 'Claude' }];
    });
    await expect(executeProviderGroupCommand(d, {
      action: 'save',
      providerId: 'anthropic',
      config: { strategy: 'least', autoSwitch: true, members: [LOCAL, MINI] },
    })).rejects.toThrow(/PRECONDITION_FAILED/);
    expect(d.writeGroup).not.toHaveBeenCalled();
    expect(d.pruneBindings).not.toHaveBeenCalled();
  });
});

describe('provider management receiver account boundary', () => {
  it('invalidates the local model catalog when a subscription group changes', () => {
    vi.mocked(broadcast).mockClear();
    createProviderGroupCommandDeps().changed('openai');
    expect(broadcast).toHaveBeenCalledWith('maker:provider:changed', {});
    vi.mocked(broadcast).mockClear();
    createProviderGroupCommandDeps().changed('xai');
    expect(broadcast).not.toHaveBeenCalledWith('maker:provider:changed', {});
  });
  it('refreshes reshare coordination after a remote group edit without adding local-only consent details to the reply', async () => {
    const config: ProviderGroupConfig = { strategy: 'least', autoSwitch: true, members: [LOCAL] };
    const d = deps([], config);
    vi.mocked(getProviderGroupDirectory).mockReturnValue(d.directory);
    vi.mocked(getProviderGroupRouter).mockReturnValue(d.router);
    vi.mocked(readProviderGroup).mockReturnValue(config);
    vi.mocked(writeProviderGroup).mockResolvedValue(config);
    vi.mocked(pruneProviderGroupBindings).mockResolvedValue();
    const onGroupChanged = vi.fn();
    const reply = await handleProviderManagementRequest({
      action: 'manage-group', command: { action: 'save-if-current', providerId: 'anthropic', config, expectedConfig: config },
    }, { onGroupChanged });
    expect(onGroupChanged).toHaveBeenCalledExactlyOnceWith('anthropic');
    expect(reply.result).toEqual({ providerId: 'anthropic', config, members: [] });
  });

  // 同账号管理：新增备注与转分享决定共用主人操作入口，受邀者读取仍不在此范围。
  it.each([
    { action: 'reshare-decide', id: 'rs-pending', decision: 'approve' },
    { action: 'set-member-note', memberId: 'm1', note: 'Alice' },
  ] as const)('accepts $action as an owner operation and keeps forwarding operations outside the management scope', async (command) => {
    vi.mocked(parseProviderShareCommand).mockReturnValue(command);
    expect(parseProviderManagementRequest({ action: 'manage-share', command })).toEqual({ action: 'manage-share', command });
    vi.mocked(executeProviderShareManagementCommand).mockResolvedValueOnce({ ok: true });
    expect(await handleProviderManagementRequest({ action: 'manage-share', command })).toMatchObject({ result: { ok: true } });
    expect(executeProviderShareManagementCommand).toHaveBeenLastCalledWith(command);
    vi.mocked(parseProviderShareCommand).mockReturnValueOnce({ action: 'received' });
    expect(() => parseProviderManagementRequest({ action: 'manage-share', command: { action: 'received' } }))
      .toThrow(/PERMISSION_DENIED/);
  });

  // 「用量」块的按天明细(provider-groups.md §7)：只读的分享者查询，和 own-usage 一样经管理通道转交。
  it('accepts the daily usage query as an owner operation', () => {
    const command = { action: 'usage-history', providerId: 'anthropic' } as const;
    vi.mocked(parseProviderShareCommand).mockReturnValueOnce(command);
    expect(parseProviderManagementRequest({ action: 'manage-share', command })).toEqual({ action: 'manage-share', command });
  });

  it.each([
    { action: 'manage-group', command: { action: 'get', providerId: 'anthropic' } },
    { action: 'manage-share', command: { action: 'owned', range: '7d' } },
    { action: 'manage-share', command: { action: 'reshare-decide', id: 'rs-pending', decision: 'approve' } },
  ] satisfies ProviderManagementRequest[])('refuses $action before dispatch when teardown is pending', async (request) => {
    vi.mocked(getProviderGroupRouter).mockClear();
    vi.mocked(executeProviderShareManagementCommand).mockClear();
    vi.mocked(isAppSessionBoundaryPending).mockReturnValue(true);
    await expect(handleProviderManagementRequest(request)).rejects.toThrow(/PRECONDITION_FAILED/);
    expect(getProviderGroupRouter).not.toHaveBeenCalled();
    expect(executeProviderShareManagementCommand).not.toHaveBeenCalled();
  });

  it('does not return a successful share response after teardown begins with the same owner key', async () => {
    const command = { action: 'owned', range: '7d' } as const;
    vi.mocked(parseProviderShareCommand).mockReturnValueOnce(command);
    vi.mocked(executeProviderShareManagementCommand).mockImplementationOnce(async () => {
      vi.mocked(isAppSessionBoundaryPending).mockReturnValue(true);
      return { ready: true, shares: [] };
    });
    await expect(handleProviderManagementRequest({ action: 'manage-share', command }))
      .rejects.toThrow(/PRECONDITION_FAILED/);
  });
});
