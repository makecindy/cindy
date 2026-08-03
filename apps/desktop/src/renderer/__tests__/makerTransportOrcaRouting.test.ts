/**
 * makerTransport orca 路由单测:远程会话开协同时,团队读 / 管理 + worker-changed 订阅按
 * ctx session 来源正确路由 —— 远程走 deviceLink.invoke(对齐 preload channel/args),本机走
 * window.electronAPI.localDb.orcaWorkflows。这是手机版(纯控制端)复用的同一套契约的回归保护。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/lib/ccAgent.types';

beforeEach(() => {
  vi.resetModules();
});

function stubElectron() {
  const orcaSpies = {
    create: vi.fn(),
    getByLeadSession: vi.fn(),
    getByWorkerSession: vi.fn(),
    listWorkersByLead: vi.fn(),
    addWorker: vi.fn(),
    updateWorkerStatus: vi.fn(),
    onOrcaWorkerChanged: vi.fn<(cb: (p: unknown) => void) => () => void>(() => () => {}),
    createWorker: vi.fn(),
    switchFocus: vi.fn(),
    idleWorker: vi.fn(),
    archiveWorker: vi.fn(),
    endTeam: vi.fn(),
    getCollaborationSettings: vi.fn(),
    setCollaborationSetting: vi.fn(),
  };
  const invoke = vi.fn().mockResolvedValue(undefined);
  const onRemotePush = vi.fn<
    (cb: (p: { deviceId: string; channel: string; payload: unknown }) => void) => () => void
  >(() => () => {});
  vi.stubGlobal('window', {
    electronAPI: {
      localDb: { orcaWorkflows: orcaSpies },
      deviceLink: { invoke, onRemotePush },
    },
  });
  return { orcaSpies, invoke, onRemotePush };
}

const sess = (id: string): Session => ({ id }) as unknown as Session;

describe('orcaWorkflowsFor 路由', () => {
  it('远程 lead:读 / 管理命中对应隧道 channel + args(与 preload 对齐)', async () => {
    const { invoke } = stubElectron();
    const { orcaWorkflowsFor } = await import('@/lib/makerTransport');
    const { remoteProjectsStore } = await import('@/features/device-link/remoteProjectsStore');
    remoteProjectsStore.setDeviceSessions('dev-1', 'Mac', [sess('lead')]);

    const orca = orcaWorkflowsFor('lead');
    await orca.listWorkersByLead('lead');
    await orca.getByLeadSession('lead');
    await orca.createWorker({ leadSessionId: 'lead', role: 'developer' });
    await orca.switchFocus({ leadSessionId: 'lead', workerIdOrLabel: 'w1' });
    await orca.idleWorker('lead', 'w1');
    await orca.idleWorker('lead', 'w1', 'done');
    await orca.archiveWorker('lead', 'w1');
    await orca.endTeam('lead');
    await orca.getCollaborationSettings();

    expect(invoke).toHaveBeenCalledWith('dev-1', 'local-db:orca-workflows:list-workers-by-lead', ['lead']);
    expect(invoke).toHaveBeenCalledWith('dev-1', 'local-db:orca-workflows:get-by-lead', ['lead']);
    expect(invoke).toHaveBeenCalledWith('dev-1', 'maker:worker:create', [{ leadSessionId: 'lead', role: 'developer' }]);
    expect(invoke).toHaveBeenCalledWith('dev-1', 'maker:worker:switch-focus', [{ leadSessionId: 'lead', workerIdOrLabel: 'w1' }]);
    expect(invoke).toHaveBeenCalledWith('dev-1', 'maker:worker:idle', [{ leadSessionId: 'lead', workerId: 'w1' }]);
    expect(invoke).toHaveBeenCalledWith('dev-1', 'maker:worker:acknowledge-done', [{ leadSessionId: 'lead', workerId: 'w1' }]);
    expect(invoke).toHaveBeenCalledWith('dev-1', 'maker:worker:archive', [{ leadSessionId: 'lead', workerId: 'w1' }]);
    expect(invoke).toHaveBeenCalledWith('dev-1', 'maker:team:end', ['lead']);
    expect(invoke).toHaveBeenCalledWith('dev-1', 'maker:collaboration-settings:get', []);
    // 注:setCollaborationSetting / create / addWorker / updateWorkerStatus 刻意不在远程可路由集
    // (channel 不在 allowlist、无远程调用方);本机走 window.electronAPI.localDb.orcaWorkflows。
  });

  it('getByWorkerSession 按 worker session 的 deviceId 路由', async () => {
    const { invoke } = stubElectron();
    const { orcaWorkflowsFor } = await import('@/lib/makerTransport');
    const { remoteProjectsStore } = await import('@/features/device-link/remoteProjectsStore');
    remoteProjectsStore.setDeviceSessions('dev-1', 'Mac', [sess('worker-1')]);

    await orcaWorkflowsFor('worker-1').getByWorkerSession('worker-1');
    expect(invoke).toHaveBeenCalledWith('dev-1', 'local-db:orca-workflows:get-by-worker-session', ['worker-1']);
  });

  it('本机 lead:走本机 orcaWorkflows,不经隧道(零回归)', async () => {
    const { orcaSpies, invoke } = stubElectron();
    const { orcaWorkflowsFor } = await import('@/lib/makerTransport');

    const orca = orcaWorkflowsFor('local-lead'); // 未注册进 remoteProjectsStore → 本机
    await orca.listWorkersByLead('local-lead');
    await orca.createWorker({ leadSessionId: 'local-lead' });

    expect(orcaSpies.listWorkersByLead).toHaveBeenCalledWith('local-lead');
    expect(orcaSpies.createWorker).toHaveBeenCalledWith({ leadSessionId: 'local-lead' });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('subscribeOrcaWorkerChanged 分流', () => {
  it('本机 lead → 本机 onOrcaWorkerChanged,按 leadSessionId 过滤', async () => {
    const { orcaSpies, onRemotePush } = stubElectron();
    const { subscribeOrcaWorkerChanged } = await import('@/lib/makerTransport');

    const cb = vi.fn();
    subscribeOrcaWorkerChanged('local-lead', cb);
    expect(orcaSpies.onOrcaWorkerChanged).toHaveBeenCalled();
    expect(onRemotePush).not.toHaveBeenCalled();

    const handler = orcaSpies.onOrcaWorkerChanged.mock.calls[0][0];
    handler({ leadSessionId: 'local-lead' }); // match → cb
    handler({ leadSessionId: 'other' }); // no
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('远程 lead → device-link onRemotePush,按 channel + leadSessionId 过滤', async () => {
    const { orcaSpies, onRemotePush } = stubElectron();
    const { subscribeOrcaWorkerChanged } = await import('@/lib/makerTransport');
    const { remoteProjectsStore } = await import('@/features/device-link/remoteProjectsStore');
    remoteProjectsStore.setDeviceSessions('dev-1', 'Mac', [sess('rlead')]);

    const cb = vi.fn();
    subscribeOrcaWorkerChanged('rlead', cb);
    expect(onRemotePush).toHaveBeenCalled();
    expect(orcaSpies.onOrcaWorkerChanged).not.toHaveBeenCalled();

    const handler = onRemotePush.mock.calls[0][0];
    handler({ deviceId: 'dev-1', channel: 'maker:orca:worker-changed', payload: { leadSessionId: 'rlead' } }); // match
    handler({ deviceId: 'dev-1', channel: 'maker:event', payload: { sessionId: 'rlead' } }); // wrong channel
    handler({ deviceId: 'dev-1', channel: 'maker:orca:worker-changed', payload: { leadSessionId: 'other' } }); // wrong lead
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('远程 lead 的映射短暂消失时，worker-changed 订阅仍留在被控端', async () => {
    const { orcaSpies, onRemotePush } = stubElectron();
    const { subscribeOrcaWorkerChanged } = await import('@/lib/makerTransport');
    const { remoteProjectsStore } = await import('@/features/device-link/remoteProjectsStore');
    const { getStickySessionDeviceId } = await import(
      '@/features/device-link/stickySessionOrigin'
    );
    remoteProjectsStore.setDeviceSessions('dev-sticky', 'Mac', [sess('sticky-lead')]);
    expect(getStickySessionDeviceId('sticky-lead')).toBe('dev-sticky');
    remoteProjectsStore.setDeviceSessions('dev-sticky', 'Mac', []);

    const cb = vi.fn();
    subscribeOrcaWorkerChanged('sticky-lead', cb);

    expect(onRemotePush).toHaveBeenCalled();
    expect(orcaSpies.onOrcaWorkerChanged).not.toHaveBeenCalled();
    const handler = onRemotePush.mock.calls[0][0];
    handler({
      deviceId: 'dev-sticky',
      channel: 'maker:orca:worker-changed',
      payload: { leadSessionId: 'sticky-lead' },
    });
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
