/**
 * makerTransport 路由单测:验证「完整对等」补齐的会话级操作按 sessionId 来源正确路由 ——
 *   - device-link 远程会话 → window.electronAPI.deviceLink.invoke(deviceId, '<channel>', args)
 *   - 本机会话           → window.electronAPI.maker.<method>(args)
 * 这是手机版(纯控制端)将要复用的同一套 channel/args 契约的回归保护。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/lib/ccAgent.types';

beforeEach(() => {
  vi.resetModules();
});

function stubElectron() {
  const makerSpies = {
    setModel: vi.fn(),
    setEffort: vi.fn(),
    fork: vi.fn(),
    forkStripEncrypted: vi.fn(),
    rewindPreview: vi.fn(),
    rewindCommit: vi.fn(),
    getContextUsage: vi.fn(),
    setExtraDirs: vi.fn(),
    closeSession: vi.fn(),
    compactSession: vi.fn().mockResolvedValue({ tokensBefore: 100, estimatedTokensAfter: 20 }),
    enableOrca: vi.fn(),
    dispatchOrcaUiAssignment: vi.fn(),
    disableOrca: vi.fn(),
    regenerateSessionTitle: vi.fn().mockResolvedValue({ title: 'local title' }),
    plugins: { getState: vi.fn().mockResolvedValue({ effectiveEnabled: true }) },
    input: { clearSession: vi.fn(), compact: vi.fn() },
  };
  const orcaWorkflows = {
    getByLeadSession: vi.fn(),
    getByWorkerSession: vi.fn(),
    listWorkersByLead: vi.fn(),
    createWorker: vi.fn(),
    switchFocus: vi.fn(),
    idleWorker: vi.fn(),
    archiveWorker: vi.fn(),
    endTeam: vi.fn(),
    getCollaborationSettings: vi.fn(),
  };
  const localMessages = {
    estimatedSessionValue: vi.fn().mockResolvedValue({ totalValueUsd: 0, entries: [] }),
  };
  const localSessions = {
    get: vi.fn().mockRejectedValue(new Error('[NOT_FOUND] Session does not exist')),
    update: vi.fn(),
  };
  const invoke = vi.fn().mockResolvedValue(undefined);
  const getState = vi.fn().mockResolvedValue({ disabledControlDeviceIds: [] });
  vi.stubGlobal('window', {
    electronAPI: {
      maker: makerSpies,
      localDb: { orcaWorkflows, messages: localMessages, sessions: localSessions },
      deviceLink: { invoke, getState },
    },
  });
  return { makerSpies, orcaWorkflows, localMessages, localSessions, invoke, getState };
}

const sess = (id: string): Session => ({ id }) as unknown as Session;

describe('makerApiFor 路由(完整对等会话级操作)', () => {
  it('远程 device-link 会话:每个任务级操作命中对应隧道 channel + 原样转发 args', async () => {
    const { invoke } = stubElectron();
    const { makerApiFor } = await import('@/lib/makerTransport');
    const { remoteProjectsStore } = await import('@/features/device-link/remoteProjectsStore');
    remoteProjectsStore.setDeviceSessions('dev-1', 'Mac', [sess('rs')]);

    const api = makerApiFor('rs');
    api.fork('rs', 'msg');
    api.forkStripEncrypted('rs');
    api.rewindPreview('rs', 'c1');
    api.rewindCommit('rs', 'c1');
    api.getContextUsage('rs', { agentKind: 'codex', workingDir: '/w', model: 'm' });
    api.setExtraDirs('rs', ['/a']);
    api.closeSession('rs');
    api.compactSession('rs', 'focus on API design');
    api.enableOrca('rs', { workerAgent: 'codex' });
    api.dispatchOrcaUiAssignment('rs', 'worker-1', 'Review this PR', 123, true);
    api.disableOrca('rs');
    api.input.compact(
      'rs',
      { agentKind: 'claude-code', workingDir: '/w', model: 'm' },
      { userName: 'Carol' },
    );
    api.input.clearSession('rs');

    expect(invoke).toHaveBeenCalledWith('dev-1', 'maker:fork', ['rs', 'msg']);
    expect(invoke).toHaveBeenCalledWith('dev-1', 'maker:fork-strip-encrypted', ['rs']);
    expect(invoke).toHaveBeenCalledWith('dev-1', 'maker:rewind:preview', ['rs', 'c1']);
    expect(invoke).toHaveBeenCalledWith('dev-1', 'maker:rewind:commit', ['rs', 'c1']);
    expect(invoke).toHaveBeenCalledWith('dev-1', 'maker:get-context-usage', [
      'rs',
      { agentKind: 'codex', workingDir: '/w', model: 'm' },
    ]);
    expect(invoke).toHaveBeenCalledWith('dev-1', 'maker:set-extra-dirs', ['rs', ['/a']]);
    expect(invoke).toHaveBeenCalledWith('dev-1', 'maker:close-session', ['rs']);
    expect(invoke).toHaveBeenCalledWith('dev-1', 'maker:compact-session', ['rs', 'focus on API design']);
    expect(invoke).toHaveBeenCalledWith('dev-1', 'maker:session:enable-orca', [
      'rs',
      { workerAgent: 'codex' },
    ]);
    expect(invoke).toHaveBeenCalledWith('dev-1', 'maker:worker:dispatch-ui-assignment', [
      'rs',
      'worker-1',
      'Review this PR',
      123,
      true,
    ]);
    expect(invoke).toHaveBeenCalledWith('dev-1', 'maker:session:disable-orca', ['rs']);
    expect(invoke).toHaveBeenCalledWith('dev-1', 'maker:input:compact', [
      'rs',
      { agentKind: 'claude-code', workingDir: '/w', model: 'm' },
      { userName: 'Carol' },
    ]);
    expect(invoke).toHaveBeenCalledWith('dev-1', 'maker:input:clear-session', ['rs']);
  });

  it('已捕获的 deviceId 在 session origin 暂时消失后仍固定走远程隧道', async () => {
    const { makerSpies, invoke } = stubElectron();
    const { makerApiForDevice } = await import('@/lib/makerTransport');

    const api = makerApiForDevice('dev-sticky');
    await api.setModel('rs', 'claude-fable-5');
    await api.setEffort('rs', 'xhigh');

    expect(invoke).toHaveBeenCalledWith('dev-sticky', 'maker:set-model', ['rs', 'claude-fable-5']);
    expect(invoke).toHaveBeenCalledWith('dev-sticky', 'maker:set-effort', ['rs', 'xhigh']);
    expect(makerSpies.setModel).not.toHaveBeenCalled();
    expect(makerSpies.setEffort).not.toHaveBeenCalled();
  });

  it('远程 compactSession 裁掉尾部 undefined，同时保留显式空 instructions', async () => {
    const { invoke } = stubElectron();
    const { makerApiForDevice } = await import('@/lib/makerTransport');
    const api = makerApiForDevice('dev-wire');

    await api.compactSession('rs');
    await api.compactSession('rs', '');

    expect(invoke).toHaveBeenNthCalledWith(1, 'dev-wire', 'maker:compact-session', ['rs']);
    expect(invoke).toHaveBeenNthCalledWith(2, 'dev-wire', 'maker:compact-session', ['rs', '']);
  });

  it('远程 setModel 压缩 JSON 可选参数,保留中间占位且裁掉尾部 null', async () => {
    const { invoke } = stubElectron();
    const { makerApiForDevice } = await import('@/lib/makerTransport');
    const api = makerApiForDevice('dev-wire');
    const selection = { effort: 'high', fastMode: true };

    await api.setModel('rs', 'model-only');
    await api.setModel('rs', 'with-provider', 'provider-a');
    await api.setModel('rs', 'with-revision', null, 7);
    await api.setModel('rs', 'with-selection', 'provider-b', undefined, selection);

    expect(invoke).toHaveBeenCalledWith('dev-wire', 'maker:set-model', ['rs', 'model-only']);
    expect(invoke).toHaveBeenCalledWith('dev-wire', 'maker:set-model', [
      'rs',
      'with-provider',
      'provider-a',
    ]);
    expect(invoke).toHaveBeenCalledWith('dev-wire', 'maker:set-model', [
      'rs',
      'with-revision',
      null,
      7,
    ]);
    expect(invoke).toHaveBeenCalledWith('dev-wire', 'maker:set-model', [
      'rs',
      'with-selection',
      'provider-b',
      null,
      selection,
    ]);
    const lastArgs = invoke.mock.calls.at(-1)?.[2] as unknown[];
    expect(lastArgs).toHaveLength(5);
    expect(lastArgs.at(-1)).toBe(selection);
  });

  it('远程 setModel 拒绝省略 provider 但携带 revision 或 selection 的歧义调用', async () => {
    const { invoke } = stubElectron();
    const { makerApiForDevice } = await import('@/lib/makerTransport');
    const api = makerApiForDevice('dev-ambiguous');

    await expect(api.setModel('rs', 'with-revision', undefined, 7)).rejects.toThrow(
      /providerId is required/,
    );
    await expect(
      api.setModel('rs', 'with-selection', undefined, undefined, {
        effort: 'high',
        fastMode: true,
      }),
    ).rejects.toThrow(/providerId is required/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('getSessionFor:镜像清空期间仍从最后已知设备读取任务元数据', async () => {
    const { invoke } = stubElectron();
    invoke.mockResolvedValue({ id: 'rs', workingDir: '/remote/worktree' });
    const { getSessionFor } = await import('@/lib/makerTransport');
    const { remoteProjectsStore } = await import('@/features/device-link/remoteProjectsStore');

    remoteProjectsStore.setDeviceSessions('dev-1', 'Mac', [sess('rs')]);
    await getSessionFor('rs'); // seed sticky origin before the simulated clear
    invoke.mockClear();
    remoteProjectsStore.clear();

    await getSessionFor('rs');

    expect(invoke).toHaveBeenCalledWith('dev-1', 'local-db:sessions:get', ['rs']);
  });

  it('regenerateSessionTitleFor:镜像清空期间仍在被控端自动起名，不回落控制端本机', async () => {
    const { makerSpies, invoke } = stubElectron();
    invoke.mockResolvedValue({ title: 'remote title' });
    const { regenerateSessionTitleFor } = await import('@/lib/makerTransport');
    const { remoteProjectsStore } = await import('@/features/device-link/remoteProjectsStore');

    remoteProjectsStore.setDeviceSessions('dev-1', 'Mac', [sess('rs')]);
    await regenerateSessionTitleFor('rs');
    expect(invoke).toHaveBeenCalledWith('dev-1', 'maker:regenerate-title', [{ sessionId: 'rs' }]);

    invoke.mockClear();
    remoteProjectsStore.clear();
    await regenerateSessionTitleFor('rs');

    expect(invoke).toHaveBeenCalledWith('dev-1', 'maker:regenerate-title', [{ sessionId: 'rs' }]);
    expect(makerSpies.regenerateSessionTitle).not.toHaveBeenCalled();
  });

  it('regenerateSessionTitleFor:从未有远程归属的会话仍走本机', async () => {
    const { makerSpies, invoke } = stubElectron();
    const { regenerateSessionTitleFor } = await import('@/lib/makerTransport');

    await regenerateSessionTitleFor('local-only');

    expect(makerSpies.regenerateSessionTitle).toHaveBeenCalledWith('local-only');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('远程会话 patchMeta(删/归档/改名/置顶)经隧道 local-db:sessions:patch-meta', async () => {
    const { invoke } = stubElectron();
    const { remoteProjectsStore } = await import('@/features/device-link/remoteProjectsStore');
    const sessionService = await import('@/lib/sessionService');
    remoteProjectsStore.setDeviceSessions('dev-1', 'Mac', [sess('rs')]);

    // setStatus 是 patchMeta 的便捷封装:delete → { status: 'deleted' }
    await sessionService.setStatus('rs', 'deleted');
    expect(invoke).toHaveBeenCalledWith('dev-1', 'local-db:sessions:patch-meta', [
      'rs',
      { status: 'deleted' },
    ]);
    // 改名 / 置顶走同一窄口径通道
    await sessionService.patchMeta('rs', { title: 'New' });
    expect(invoke).toHaveBeenCalledWith('dev-1', 'local-db:sessions:patch-meta', [
      'rs',
      { title: 'New' },
    ]);

    // Relay reconnect may temporarily clear the live mirror. The sticky
    // origin must keep the archived-session auto-unarchive on the remote host.
    remoteProjectsStore.clear();
    await sessionService.setStatus('rs', 'active');
    expect(invoke).toHaveBeenCalledWith('dev-1', 'local-db:sessions:patch-meta', [
      'rs',
      { status: 'active' },
    ]);
  });

  it.each([
    ['archived', { status: 'archived', pinnedAt: null }],
    ['deleted', { status: 'deleted' }],
  ] as const)(
    'setStatus routes a disabled remote-id collision to the verified local row for %s',
    async (status, expectedPatch) => {
      const { getState, invoke, localSessions } = stubElectron();
      const { remoteProjectsStore } = await import('@/features/device-link/remoteProjectsStore');
      const { getStickySessionDeviceId } = await import(
        '@/features/device-link/stickySessionOrigin'
      );
      const sessionService = await import('@/lib/sessionService');
      const localRow = sess('collision');

      remoteProjectsStore.setDeviceSessions('dev-disabled', 'Old desktop', [localRow]);
      expect(getStickySessionDeviceId('collision')).toBe('dev-disabled');
      remoteProjectsStore.removeDevice('dev-disabled');
      getState.mockResolvedValue({ disabledControlDeviceIds: ['dev-disabled'] });
      localSessions.get.mockResolvedValue(localRow);
      localSessions.update.mockResolvedValue({ ...localRow, status });

      await sessionService.setStatus('collision', status);

      expect(getState).toHaveBeenCalledOnce();
      expect(localSessions.get).toHaveBeenCalledWith('collision');
      expect(localSessions.update).toHaveBeenCalledWith('collision', expectedPatch);
      expect(invoke).not.toHaveBeenCalled();
    },
  );

  it('setStatus keeps a disabled true remote session pinned when no local row exists', async () => {
    const { getState, invoke, localSessions } = stubElectron();
    const { remoteProjectsStore } = await import('@/features/device-link/remoteProjectsStore');
    const { getStickySessionDeviceId } = await import(
      '@/features/device-link/stickySessionOrigin'
    );
    const sessionService = await import('@/lib/sessionService');

    remoteProjectsStore.setDeviceSessions('dev-disabled', 'Old desktop', [sess('remote-only')]);
    expect(getStickySessionDeviceId('remote-only')).toBe('dev-disabled');
    remoteProjectsStore.removeDevice('dev-disabled');
    getState.mockResolvedValue({ disabledControlDeviceIds: ['dev-disabled'] });

    await sessionService.setStatus('remote-only', 'archived');

    expect(getState).toHaveBeenCalledOnce();
    expect(localSessions.get).toHaveBeenCalledWith('remote-only');
    expect(localSessions.update).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith('dev-disabled', 'local-db:sessions:patch-meta', [
      'remote-only',
      { status: 'archived', pinnedAt: null },
    ]);
  });

  it('本机会话:走本地 maker,不经隧道', async () => {
    const { makerSpies, invoke } = stubElectron();
    const { makerApiFor } = await import('@/lib/makerTransport');
    // 未注册进 remoteProjectsStore → getSessionDeviceId 返回 undefined → 本地
    const api = makerApiFor('local-sess');
    api.fork('local-sess', 'm');
    api.closeSession('local-sess');

    expect(makerSpies.fork).toHaveBeenCalledWith('local-sess', 'm');
    expect(makerSpies.closeSession).toHaveBeenCalledWith('local-sess');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('detached 子窗口依赖的远程 Orca lead 操作经隧道,不查控制端本机空库', async () => {
    const { orcaWorkflows, invoke } = stubElectron();
    const { orcaWorkflowsFor } = await import('@/lib/makerTransport');
    const { remoteProjectsStore } = await import('@/features/device-link/remoteProjectsStore');
    remoteProjectsStore.setDeviceSessions('dev-1', 'Mac', [sess('remote-lead')]);

    const api = orcaWorkflowsFor('remote-lead');
    await api.listWorkersByLead('remote-lead');
    await api.endTeam('remote-lead');

    expect(invoke).toHaveBeenCalledWith('dev-1', 'local-db:orca-workflows:list-workers-by-lead', [
      'remote-lead',
    ]);
    expect(invoke).toHaveBeenCalledWith('dev-1', 'maker:team:end', ['remote-lead']);
    expect(orcaWorkflows.listWorkersByLead).not.toHaveBeenCalled();
    expect(orcaWorkflows.endTeam).not.toHaveBeenCalled();
  });

  it('isSessionTurnRunningFor:远程经隧道 maker:session-in-turn;本机直接 false(不经隧道)', async () => {
    const { invoke } = stubElectron();
    invoke.mockResolvedValue(true);
    const { isSessionTurnRunningFor } = await import('@/lib/makerTransport');
    const { remoteProjectsStore } = await import('@/features/device-link/remoteProjectsStore');
    remoteProjectsStore.setDeviceSessions('dev-1', 'Mac', [sess('rs')]);

    await expect(isSessionTurnRunningFor('rs')).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith('dev-1', 'maker:session-in-turn', ['rs']);

    invoke.mockClear();
    // 未注册 → 本机会话:直接 false,不经隧道(看门狗对本机会话整体不生效)
    await expect(isSessionTurnRunningFor('local-sess')).resolves.toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('estimatedSessionValueFor:远程经隧道查被控端汇总;本机查本地库(不经隧道)', async () => {
    const { localMessages, invoke } = stubElectron();
    invoke.mockResolvedValue({ totalValueUsd: 1.5, entries: [{ clientId: 'a', costUsd: 1.5 }] });
    const { estimatedSessionValueFor } = await import('@/lib/makerTransport');
    const { remoteProjectsStore } = await import('@/features/device-link/remoteProjectsStore');
    remoteProjectsStore.setDeviceSessions('dev-1', 'Mac', [sess('rs')]);

    // 远程会话:查本机是空库恒 0,必须隧道到被控端
    await expect(estimatedSessionValueFor('rs')).resolves.toEqual({
      totalValueUsd: 1.5,
      entries: [{ clientId: 'a', costUsd: 1.5 }],
    });
    expect(invoke).toHaveBeenCalledWith('dev-1', 'local-db:messages:estimatedSessionValue', ['rs']);
    expect(localMessages.estimatedSessionValue).not.toHaveBeenCalled();

    invoke.mockClear();
    await estimatedSessionValueFor('local-sess');
    expect(localMessages.estimatedSessionValue).toHaveBeenCalledWith('local-sess');
    expect(invoke).not.toHaveBeenCalled();
  });

  // issue #1170 codex P2:协同 mutation 在 relay 瞬时重连清空注册表的窗口内若退回本机,
  // 会在**控制端**建出或销毁一个 team —— 与「入口按粘滞归属渲染」直接矛盾。
  it('makerApiForSticky:注册表被清空后仍走隧道,不退回本机', async () => {
    const { makerSpies, invoke } = stubElectron();
    const { makerApiFor, makerApiForSticky } = await import('@/lib/makerTransport');
    const { remoteProjectsStore } = await import('@/features/device-link/remoteProjectsStore');
    const { getStickySessionDeviceId } = await import('@/features/device-link/stickySessionOrigin');

    remoteProjectsStore.setDeviceSessions('dev-1', 'Mac', [sess('lead')]);
    // 先解析一次,让粘滞归属记住 dev-1(与真实链路一致:视图渲染时已解析过)。
    expect(getStickySessionDeviceId('lead')).toBe('dev-1');

    // relay 瞬时重连:注册表被清空,非粘滞判定这一刻会解析成「本机」。
    remoteProjectsStore.setDeviceSessions('dev-1', 'Mac', []);
    await makerApiFor('lead').enableOrca('lead', { workerAgent: 'codex' });
    expect(makerSpies.enableOrca).toHaveBeenCalled(); // 非粘滞:确实退回了本机(问题本体)

    invoke.mockClear();
    makerSpies.enableOrca.mockClear();
    makerSpies.compactSession.mockClear();
    await makerApiForSticky('lead').enableOrca('lead', { workerAgent: 'codex' });
    expect(invoke).toHaveBeenCalledWith('dev-1', 'maker:session:enable-orca', [
      'lead',
      { workerAgent: 'codex' },
    ]);
    expect(makerSpies.enableOrca).not.toHaveBeenCalled();
    // 手动压缩同属「误判本机会静默失败」的 mutation(greptile P1):远程 pi 压缩必须
    // 隧道到被控端,重连窗口内不退回控制端本机 maker(本机无该 live 会话 → null)。
    await makerApiForSticky('lead').compactSession('lead', 'focus on API design');
    expect(invoke).toHaveBeenCalledWith('dev-1', 'maker:compact-session', [
      'lead',
      'focus on API design',
    ]);
    expect(makerSpies.compactSession).not.toHaveBeenCalled();
  });

  it('makerApiForSticky:从未解析过归属的本机会话仍走本机(零回归)', async () => {
    const { makerSpies, invoke } = stubElectron();
    const { makerApiForSticky } = await import('@/lib/makerTransport');

    await makerApiForSticky('local-only').disableOrca('local-only');
    expect(makerSpies.disableOrca).toHaveBeenCalledWith('local-only');
    expect(invoke).not.toHaveBeenCalled();
    await makerApiForSticky('local-only').compactSession('local-only');
    expect(makerSpies.compactSession).toHaveBeenCalledWith('local-only');
  });

  // issue #1170:协同入口的项目级 collab 开关此前一律查控制端本机 —— 拿被控端的路径查
  // 自己的 fs,读到的是控制端自己的用户级开关,与被控端 main 的权威授权可能相反。
  it('pluginEnableStateFor:传了 deviceId 就隧道查被控端;没传才查本机', async () => {
    const { makerSpies, invoke } = stubElectron();
    invoke.mockResolvedValue({ effectiveEnabled: false });
    const { pluginEnableStateFor } = await import('@/lib/makerTransport');

    await expect(pluginEnableStateFor('dev-1', 'collab', '/host/proj', 'project')).resolves.toEqual(
      {
        effectiveEnabled: false,
      },
    );
    expect(invoke).toHaveBeenCalledWith('dev-1', 'maker:plugins:get-state', [
      'collab',
      '/host/proj',
      'project',
    ]);
    expect(makerSpies.plugins.getState).not.toHaveBeenCalled();

    invoke.mockClear();
    await pluginEnableStateFor(null, 'collab', '/local/proj', 'project');
    expect(makerSpies.plugins.getState).toHaveBeenCalledWith('collab', '/local/proj', 'project');
    expect(invoke).not.toHaveBeenCalled();

    // skipQuery 档(SSH 远端):不传 workingDir → 落用户级/全局级,两条路由都要保持原样透传。
    invoke.mockClear();
    makerSpies.plugins.getState.mockClear();
    await pluginEnableStateFor('dev-1', 'collab', undefined);
    expect(invoke).toHaveBeenCalledWith('dev-1', 'maker:plugins:get-state', ['collab', undefined]);
    await pluginEnableStateFor(undefined, 'collab', undefined);
    expect(makerSpies.plugins.getState).toHaveBeenCalledWith('collab', undefined);
  });
});

describe('drift 守卫:makerTransport 隧道的每个 channel 都在 REMOTE_INVOKE_ALLOWLIST 内', () => {
  it('适配器里 t(...) / invokeRemote(deviceId, ...) 的 channel 串无一逃出 allowlist', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const { REMOTE_INVOKE_ALLOWLIST } = await import('@cindy/device-link');
    const src = readFileSync(resolve(__dirname, '..', 'lib', 'makerTransport.ts'), 'utf8');
    // 抓两种隧道写法的字面量 channel:通用 t('<ch>') 与手动打包的 invokeRemote(deviceId, '<ch>', ...)。
    const channels = new Set<string>();
    for (const m of src.matchAll(/\bt\('([^']+)'\)/g)) channels.add(m[1]);
    for (const m of src.matchAll(/invokeRemote\(deviceId,\s*'([^']+)'/g)) channels.add(m[1]);
    expect(channels.size).toBeGreaterThan(10); // 正则没失效(当前 ~41 个)
    // 任一 channel 不在 allowlist → 远程调用会 CHANNEL_NOT_ALLOWED,这里提前在 CI 红。
    const offenders = [...channels].filter((c) => !REMOTE_INVOKE_ALLOWLIST.has(c));
    expect(offenders).toEqual([]);
  });
});
