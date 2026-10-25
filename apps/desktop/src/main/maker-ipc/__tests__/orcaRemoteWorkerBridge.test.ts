import { describe, expect, it, vi } from 'vitest';
import type { Logger, Maker, McpProviderContext } from '@cindy/maker-core';
import {
  createOrcaWorkerBridgeMcpProvider,
  type OrcaWorkerLink,
  type OrcaBridgeMcpDeps,
} from '@cindy/orca-workflow';
import type { OrcaRemoteLead } from '../../../shared/orcaRemoteWorker.js';
import { createOrcaRemoteWorkerBridge } from '../orcaRemoteWorkerBridge.js';
import type { OrcaWorkerRecord } from '../../localDb/orcaTeamStore.js';

// Value: production MCP handlers → execution-device route → attested Lead handler. The live
// 2026-10-21 probe failed for a valid remote session with no local orcaRole. Existing tests
// covered local links only. Minimal input: one remote Worker, one queued report. Unit tier;
// no sockets, Electron app or real account is needed. Also protects device/team/child isolation.
function setup() {
  let owner = 1;
  let activeTeam: string | null = 'team-1';
  const remoteLead: OrcaRemoteLead = {
    leadDeviceId: 'pc',
    leadDeviceName: 'PC',
    leadSessionId: 'lead-1',
    leadTitle: 'Lead',
    workerLabel: 'tester',
  };
  const worker = {
    id: 'worker-1',
    teamId: 'team-1',
    sessionId: 'proxy-1',
    leadSessionId: 'lead-1',
    status: 'running',
    executionDevice: { deviceId: 'mac', remoteSessionId: 'remote-1' },
    session: { id: 'proxy-1', agentKind: 'codex' },
  } as OrcaWorkerRecord;
  const link: OrcaWorkerLink = {
    workerId: worker.id,
    workflowId: worker.teamId,
    workerSessionId: worker.sessionId,
    leadSessionId: 'lead-1',
    leadSession: { sessionId: 'lead-1', agentKind: 'codex', workingDir: '/lead', model: 'model' },
  };
  const log = {
    child: () => log,
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
  } as unknown as Logger;
  const leadSession = {
    id: 'lead-1',
    agentKind: 'codex',
    getStatus: () => 'ready',
    onEvent: () => () => {},
  };
  const dispatch = vi.fn<NonNullable<OrcaBridgeMcpDeps['dispatchInterAgentMessage']>>(async () => ({
    ok: true as const,
    mode: 'queued' as const,
    clientId: 'report-1',
  }));
  const settled = vi.fn(async () => { worker.status = 'done'; });
  const captureSettlement = vi.fn((_proxy: string, _inputs: readonly string[]) => settled);
  const activeInputIds = ['input-a'];
  const getActiveInputClientIds = vi.fn(() => activeInputIds);
  const getAcceptedInputProvenance = vi.fn<() => { originKind?: string } | null>(() => ({ originKind: 'orca' }));
  const provider = createOrcaWorkerBridgeMcpProvider({
    getMaker: () => ({ getSession: () => leadSession }) as unknown as Maker,
    logger: log,
    persistUserMessage: vi.fn(),
    wireSession: vi.fn(),
    orcaTeamStore: {
      getWorkerLink: async () => link,
      updateWorkerStatus: async (_id, status) => {
        worker.status = status;
      },
    },
    dispatchInterAgentMessage: dispatch,
    readLeadHistory: async () => ({
      items: [{ id: 'm1', role: 'user', content: 'Lead context', agentMeta: null, createdAt: 1 }],
      nextCursor: null,
      hasMore: false,
    }),
  });
  const host = createOrcaRemoteWorkerBridge({
    getOwnerToken: () => owner,
    activeTeamId: async () => activeTeam,
    readSession: vi.fn(),
    listWorkers: async () => [worker],
    remoteInvoke: vi.fn(),
    invokeTool: (ctx, tool, args) => provider.invokeTool(ctx, tool, args, { manageWorkerStatus: false }),
    captureReportSettlement: captureSettlement,
  });
  const remoteInvoke = vi.fn(async (_device: string, _channel: string, args: unknown[]) => ({
    ok: true as const,
    result: await host.handle(args[0], { controllerDeviceId: 'mac' }),
  }));
  const readSession = vi.fn(async () => ({ status: 'active', orcaRemoteLead: remoteLead }));
  const execution = createOrcaRemoteWorkerBridge({
    getOwnerToken: () => owner,
    readSession,
    remoteInvoke,
    getActiveInputClientIds,
    getAcceptedInputProvenance,
    listWorkers: vi.fn(),
    activeTeamId: vi.fn(),
    invokeTool: vi.fn(),
  });
  const executionProvider = createOrcaWorkerBridgeMcpProvider({
    getMaker: () => {
      throw new Error('must never recreate Lead on execution device');
    },
    logger: log,
    persistUserMessage: vi.fn(),
    wireSession: vi.fn(),
    forwardRemoteWorkerTool: execution.forwardTool,
  });
  const ctx: McpProviderContext = {
    sessionId: 'remote-1',
    workingDir: '/worker',
    agentKind: 'codex',
    mcpCallerAttested: true,
    mcpCallerKind: 'root',
  };
  const request = {
    sessionId: 'remote-1',
    leadSessionId: 'lead-1',
    tool: 'send_to_lead',
    args: { worker_id: 'worker-1', message: 'verified result' },
  };
  return {
    executionProvider,
    execution,
    host,
    ctx,
    request,
    worker,
    settled,
    captureSettlement,
    activeInputIds,
    getActiveInputClientIds,
    getAcceptedInputProvenance,
    remoteInvoke,
    dispatch,
    readSession,
    remoteLead,
    changeOwner: () => owner++,
    endTeam: () => {
      activeTeam = null;
    },
  };
}

const json = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0].text);

describe('cross-device Worker bridge', () => {
  // PR #6659 discussion_r4336139384: a persisted remote link does not authorize
  // execution-device user turns. Existing tests checked root Agent identity only.
  // Unit: real MCP/bridge handlers must reject before dispatch or settlement, even
  // when cumulative reply IDs still include the Lead's input after human steering.
  it.each([
    { name: 'direct user turn', origin: {}, ids: ['user-1'] },
    { name: 'accepted human steering', origin: { originKind: 'desktop' }, ids: ['input-a', 'user-1'] },
    { name: 'no active input', origin: null, ids: [] },
  ])('rejects a report from $name', async ({ origin, ids }) => {
    const s = setup();
    s.getAcceptedInputProvenance.mockReturnValue(origin);
    s.activeInputIds.splice(0, s.activeInputIds.length, ...ids);
    const result = await s.executionProvider.invokeTool(s.ctx, 'send_to_lead', s.request.args);
    expect(result.isError).toBe(true);
    expect(json(result)).toMatchObject({ code: 'NOT_LEAD_ASSIGNED_TURN' });
    expect(s.remoteInvoke).not.toHaveBeenCalled();
    expect(s.dispatch).not.toHaveBeenCalled();
    expect(s.captureSettlement).not.toHaveBeenCalled();
    expect(s.worker.status).toBe('running');
  });

  it('delivers a real remote Worker report to a busy Lead and settles it once', async () => {
    const s = setup();
    const result = await s.executionProvider.invokeTool(s.ctx, 'send_to_lead', s.request.args);
    expect(json(result)).toMatchObject({
      ok: true,
      queued: true,
      worker_id: 'worker-1',
      lead_session_id: 'lead-1',
    });
    expect(s.dispatch).toHaveBeenCalledTimes(1);
    expect(s.dispatch.mock.calls[0][0]).toMatchObject({
      targetSessionId: 'lead-1',
      source: 'worker',
      workerId: 'worker-1',
      rawContent: 'verified result',
    });
    expect(s.worker.status).toBe('done');
    expect(s.settled).toHaveBeenCalledTimes(1);
    expect(s.captureSettlement).toHaveBeenCalledWith('proxy-1', ['input-a']);
  });

  // Review regression: A reports while B is pending. Runtime keeps B, so shared MCP
  // must leave the Worker running. The old local-status side effect bypassed that decision.
  // Unit tier, real production tool/bridge handlers, one successful queued Lead delivery.
  it('leaves Worker status to input-specific remote settlement when B is still pending', async () => {
    const s = setup();
    s.settled.mockImplementationOnce(async () => {});
    s.readSession.mockImplementationOnce(async () => {
      s.activeInputIds.splice(0, 1, 'input-b');
      s.getAcceptedInputProvenance.mockReturnValue({});
      return { status: 'active', orcaRemoteLead: s.remoteLead };
    });
    const result = await s.executionProvider.invokeTool(s.ctx, 'send_to_lead', s.request.args);
    expect(json(result)).toMatchObject({ ok: true, queued: true });
    expect(s.captureSettlement).toHaveBeenCalledWith('proxy-1', ['input-a']);
    expect(s.worker.status).toBe('running');
  });

  it.each(['lead_status', 'read_lead', 'read_lead_history'])(
    'routes %s to the same owning Lead',
    async (tool) => {
      const s = setup();
      s.getAcceptedInputProvenance.mockReturnValue({});
      const result = await s.executionProvider.invokeTool(s.ctx, tool, { worker_id: 'worker-1' });
      expect(json(result)).toMatchObject({ worker_id: 'worker-1', lead_session_id: 'lead-1' });
      if (tool === 'read_lead_history')
        expect(json(result).messages[0].content).toBe('Lead context');
      expect(s.dispatch).not.toHaveBeenCalled();
      expect(s.settled).not.toHaveBeenCalled();
    },
  );

  it.each([null, { controllerDeviceId: 'other' }, { controllerDeviceId: 'mac', sharedTask: {} }])(
    'rejects unattested, wrong-device and shared-task callers',
    async (caller) => {
      const s = setup();
      await expect(s.host.handle(s.request, caller)).rejects.toThrow(/PERMISSION_DENIED/);
      expect(s.dispatch).not.toHaveBeenCalled();
    },
  );

  it.each([
    { sessionId: 'another-session' },
    { leadSessionId: 'another-lead' },
    { args: { worker_id: 'another-worker', message: 'spoof' } },
  ])('rejects a forged link %j', async (patch) => {
    const s = setup();
    await expect(
      s.host.handle({ ...s.request, ...patch }, { controllerDeviceId: 'mac' }),
    ).rejects.toThrow(/PERMISSION_DENIED/);
    expect(s.dispatch).not.toHaveBeenCalled();
  });

  it('rejects descendant reporters before forwarding to another computer', async () => {
    const s = setup();
    const result = await s.executionProvider.invokeTool(
      { ...s.ctx, mcpCallerKind: 'descendant' },
      'send_to_lead',
      s.request.args,
    );
    expect(json(result)).toMatchObject({ code: 'NESTED_AGENT_NOT_ALLOWED' });
    expect(s.remoteInvoke).not.toHaveBeenCalled();
  });

  it('refuses tools outside the four Worker bridge operations', async () => {
    const s = setup();
    await expect(
      s.host.handle({ ...s.request, tool: 'send_to_worker' }, { controllerDeviceId: 'mac' }),
    ).rejects.toThrow(/INVALID_PARAMS/);
    expect(s.dispatch).not.toHaveBeenCalled();
  });

  it('rejects ended teams and released Workers without dispatch', async () => {
    const s = setup();
    s.endTeam();
    await expect(s.host.handle(s.request, { controllerDeviceId: 'mac' })).rejects.toThrow(
      /PERMISSION_DENIED/,
    );
    s.readSession.mockResolvedValue({
      status: 'active',
      orcaRemoteLead: { ...s.remoteLead, releasedAt: 1 },
    });
    expect(
      json((await s.execution.forwardTool(s.ctx, 'send_to_lead', s.request.args))!),
    ).toMatchObject({ code: 'NOT_FOUND' });
    expect(s.remoteInvoke).not.toHaveBeenCalled();
  });

  it.each(['CHANNEL_NOT_ALLOWED', 'REMOTE_DISABLED', 'DEVICE_OFFLINE'] as const)(
    'handles %s without replaying a report or settling pending state',
    async (code) => {
      const s = setup();
      s.remoteInvoke.mockResolvedValue({
        ok: false,
        error: { code, message: 'unavailable' },
      } as never);
      const result = await s.executionProvider.invokeTool(s.ctx, 'send_to_lead', s.request.args);
      expect(result.isError).toBe(true);
      expect(json(result)).toMatchObject({ code });
      expect(s.remoteInvoke).toHaveBeenCalledTimes(1);
      expect(s.settled).not.toHaveBeenCalled();
    },
  );

  it('does not deliver a stale-account result', async () => {
    const s = setup();
    s.remoteInvoke.mockImplementation(async () => {
      s.changeOwner();
      return { ok: true, result: { content: [], isError: false } };
    });
    await expect(
      s.executionProvider.invokeTool(s.ctx, 'send_to_lead', s.request.args),
    ).rejects.toThrow(/PERMISSION_DENIED/);
  });

  it('does not retry a timed-out report whose execution result is unknown', async () => {
    const s = setup();
    s.remoteInvoke.mockRejectedValueOnce(new Error('INVOKE_TIMEOUT'));
    const result = await s.executionProvider.invokeTool(s.ctx, 'send_to_lead', s.request.args);
    expect(json(result)).toMatchObject({ code: 'REMOTE_BRIDGE_UNAVAILABLE' });
    expect(s.remoteInvoke).toHaveBeenCalledTimes(1);
    expect(s.settled).not.toHaveBeenCalled();
  });

  it('leaves local Worker calls on their original path without extra DB or device reads', async () => {
    const s = setup();
    expect(
      await s.execution.forwardTool(
        { ...s.ctx, vendorOptions: { orcaRole: 'worker' } },
        'lead_status',
        { worker_id: 'local' },
      ),
    ).toBeNull();
    expect(s.readSession).not.toHaveBeenCalled();
    expect(s.remoteInvoke).not.toHaveBeenCalled();
    expect(s.getActiveInputClientIds).not.toHaveBeenCalled();
    expect(s.getAcceptedInputProvenance).not.toHaveBeenCalled();
  });
});
