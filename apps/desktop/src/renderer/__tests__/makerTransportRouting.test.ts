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
    enableOrca: vi.fn(),
    disableOrca: vi.fn(),
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
  const invoke = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('window', {
    electronAPI: {
      maker: makerSpies,
      localDb: { orcaWorkflows, messages: localMessages },
      deviceLink: { invoke },
    },
  });
  return { makerSpies, orcaWorkflows, localMessages, invoke };
}

const sess = (id: string): Session => ({ id }) as unknown as Session;

describe('makerApiFor 路由(完整对等会话级操作)', () => {
  it('远程 device-link 会话:每个会话级操作命中对应隧道 channel + 原样转发 args', async () => {
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
    api.enableOrca('rs', { workerAgent: 'codex' });
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
    expect(invoke).toHaveBeenCalledWith('dev-1', 'maker:session:enable-orca', [
      'rs',
      { workerAgent: 'codex' },
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
