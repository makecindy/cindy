import { describe, expect, it, vi } from 'vitest';

import {
  applyPendingAgentSwitchIfIdle,
  applySetModelThenCancelAgentSwitchIntent,
  createPendingAgentSwitchRegistry,
  performSessionAgentSwitch,
  registerMakerSessionAgentSwitchHandler,
  relocateForFreshStart,
  settleSystemRouteSwitchIntent,
  type AgentSwitchSessionRow,
  type MakerSessionAgentSwitchHandlerDeps,
  type PendingAgentSwitchIntent,
} from '../sessionAgentSwitchHandler';
import { createAgentHandoffPendingRegistry } from '../agentHandoff';
import { MAKER_INVOKE } from '../channels';
import { remoteAgentLinkError } from '../../remote-agent/controller/runClient';
import { IpcHarness } from './helpers/ipcHarness';
import { getDeviceLinkInvokeContext, runDeviceLinkInvokeContext } from '../../device-link/invoke-context';
import { applyScheduledModelSelection, type ScheduledModelSelection } from '../scheduledModelSelection';
import { authorizeSharedTaskOperation } from '@cindy/device-link';
import type { SharedTaskPeerCapture } from '../../device-link/sharedTaskDispatch';
import { createSharedTaskSettingGuard } from '../sharedTaskSetting';

function makeRow(overrides: Partial<AgentSwitchSessionRow> = {}): AgentSwitchSessionRow {
  return {
    id: 's1',
    agentKind: 'cc',
    model: 'claude-fable-5',
    providerId: 'xd',
    status: 'active',
    remoteHostId: null,
    orcaRole: null,
    sdkSessionId: 'sdk-old',
    ...overrides,
  };
}

function makeDeps(overrides: Partial<MakerSessionAgentSwitchHandlerDeps> = {}): {
  deps: MakerSessionAgentSwitchHandlerDeps;
  calls: string[];
} {
  const calls: string[] = [];
  const deps: MakerSessionAgentSwitchHandlerDeps = {
    confirmNativeHistoryFallback: vi.fn(async () => true),
    getSessionRow: vi.fn(async () => makeRow()),
    getLiveSession: vi.fn(() => ({ isTurnRunning: () => false })),
    closeSession: vi.fn(async () => {
      calls.push('close');
    }),
    listMessagesForHandoff: vi.fn(async () => [
      { role: 'user', content: '你好', createdAt: 1 },
      { role: 'assistant', content: '你好!', createdAt: 2 },
    ]),
    applyAgentSwitchToDb: vi.fn(async () => {
      calls.push('db');
    }),
    setSessionProvider: vi.fn(() => {
      calls.push('provider');
    }),
    insertBoundaryMessage: vi.fn(async () => {
      calls.push('boundary');
      return 'boundary-client-1';
    }),
    applyResumeFallbackAtomically: vi.fn(async () => {
      calls.push('fallback-db');
    }),
    setPendingHandoff: vi.fn(() => {
      calls.push('pending');
    }),
    bootstrapSwitchedSession: vi.fn(async () => {
      calls.push('bootstrap');
    }),
    withCloseSuppressed: vi.fn((_sessionId, fn) => fn()),
    log: { info: vi.fn(), warn: vi.fn() },
    ...overrides,
  };
  return { deps, calls };
}

const validParams = {
  sessionId: 's1',
  targetAgentKind: 'codex',
  model: 'gpt-5.5',
  providerId: null,
};

describe('same-harness native relocation', () => {
  // Quota balancing is now automatic only while native context survives. Exercise the
  // real switch entry: refusal after a failed resume must restore the original route.
  it.each(['missing', 'rejected', 'silent'] as const)('asks before summary fallback after %s native history and preserves the source on refusal', async failure => {
    let row = makeRow({ workingDir: '/project', sdkSessionId: 'source-native', agentDeviceId: null });
    const original = { ...row };
    const { deps } = makeDeps({
      getSessionRow: vi.fn(async () => ({ ...row })),
      relocateNativeHistory: vi.fn(async () => failure === 'missing' ? null : 'transferred'),
      closeSession: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new Error('DEVICE_LINK_NOT_CONNECTED')),
      applyAgentSwitchToDb: vi.fn(async (_id, patch) => { row = { ...row, ...patch, providerId: patch.providerId ?? null }; }),
      getLiveSession: () => ({ isTurnRunning: () => false, sdkSessionId: failure === 'silent' ? 'fresh' : row.sdkSessionId ?? undefined }),
      bootstrapSwitchedSession: vi.fn(async () => { if (failure === 'rejected') throw new Error('cannot resume'); }),
      confirmNativeHistoryFallback: vi.fn(async () => {
        expect(row).toMatchObject({ sdkSessionId: original.sdkSessionId, agentDeviceId: original.agentDeviceId, providerId: original.providerId });
        return false;
      }),
    });
    await expect(performSessionAgentSwitch(deps, { ...validParams, targetAgentKind: 'claude-code', agentDeviceId: 'mini',
      applyNow: true, skipBootstrap: true, providerGroupSwitchReason: 'quota-rebalance' })).rejects.toThrow('NATIVE_HISTORY_FALLBACK_DECLINED');
    expect(deps.confirmNativeHistoryFallback).toHaveBeenCalledOnce();
    expect(deps.insertBoundaryMessage).not.toHaveBeenCalled();
    expect(deps.setPendingHandoff).not.toHaveBeenCalled();
    expect(row.sdkSessionId).toBe('source-native');
  });

  it.each([false, true])('publishes an automatic native switch without asking, or a confirmed summary (%s)', async resumeFails => {
    let row = makeRow({ workingDir: '/project', sdkSessionId: 'source-native' });
    const { deps } = makeDeps({
      getSessionRow: vi.fn(async () => ({ ...row })),
      relocateNativeHistory: vi.fn(async () => 'transferred'),
      applyAgentSwitchToDb: vi.fn(async (_id, patch) => { row = { ...row, ...patch, providerId: patch.providerId ?? null }; }),
      getLiveSession: () => ({ isTurnRunning: () => false, sdkSessionId: row.sdkSessionId ?? undefined }),
      bootstrapSwitchedSession: vi.fn(async () => { if (resumeFails) throw new Error('cannot resume'); }),
    });
    await performSessionAgentSwitch(deps, { ...validParams, targetAgentKind: 'claude-code', agentDeviceId: 'mini',
      applyNow: true, skipBootstrap: true, providerGroupSwitchReason: 'quota-rebalance' });
    expect(deps.confirmNativeHistoryFallback).toHaveBeenCalledTimes(resumeFails ? 1 : 0);
    expect(deps.bootstrapSwitchedSession).toHaveBeenCalledOnce();
    expect(deps.insertBoundaryMessage).toHaveBeenCalledWith('s1', expect.objectContaining({ nativeHistory: resumeFails ? 'fallback' : 'restored' }));
    expect(row.agentDeviceId).toBe('mini');
    expect(row.sdkSessionId).toBe(resumeFails ? null : 'transferred');
  });

  it('restores the source on cancellation during the native probe without asking', async () => {
    let row = makeRow({ workingDir: '/project', sdkSessionId: 'source-native' });
    const controller = new AbortController();
    const { deps } = makeDeps({
      getSessionRow: vi.fn(async () => ({ ...row })),
      relocateNativeHistory: vi.fn(async () => 'transferred'),
      applyAgentSwitchToDb: vi.fn(async (_id, patch) => { row = { ...row, ...patch, providerId: patch.providerId ?? null }; }),
      bootstrapSwitchedSession: vi.fn(async () => { controller.abort(); }),
    });
    await expect(performSessionAgentSwitch(deps, { ...validParams, targetAgentKind: 'claude-code', agentDeviceId: 'mini',
      applyNow: true, providerGroupSwitchReason: 'quota-rebalance', signal: controller.signal })).rejects.toThrow();
    expect(row.sdkSessionId).toBe('source-native');
    expect(row.agentDeviceId).toBeNull();
    expect(deps.confirmNativeHistoryFallback).not.toHaveBeenCalled();
  });

  it.each(['closed', 'close-rejected', 'account-changed', 'history-cleared'] as const)('rolls back a successful quota probe when the final route write fails (%s)', async state => {
    let row = makeRow({ workingDir: '/project', sdkSessionId: 'source-native', agentDeviceId: 'source' });
    const original = { ...row };
    let owner = 1;
    let generation = 0;
    let targetWrites = 0;
    let live = true;
    const { deps } = makeDeps({
      readOwnerGeneration: () => owner,
      readPendingHandoffGeneration: () => generation,
      getSessionRow: vi.fn(async () => ({ ...row })),
      getLiveSession: () => live ? { isTurnRunning: () => false, sdkSessionId: row.sdkSessionId ?? undefined } : undefined,
      relocateNativeHistory: vi.fn(async () => 'transferred'),
      applyAgentSwitchToDb: vi.fn(async (_id, patch) => {
        if (patch.sdkSessionId === 'transferred' && ++targetWrites === 2) throw new Error('route write failed');
        row = { ...row, ...patch, providerId: patch.providerId ?? null };
      }),
      bootstrapSwitchedSession: vi.fn(async () => { live = true; }),
      closeSession: vi.fn(async () => {
        live = false;
        if (targetWrites < 2) return;
        if (state === 'account-changed') owner++;
        if (state === 'history-cleared') generation++;
        if (state !== 'closed') throw new Error('DEVICE_LINK_NOT_CONNECTED');
      }),
    });
    await expect(performSessionAgentSwitch(deps, { ...validParams, targetAgentKind: 'claude-code', agentDeviceId: 'mini',
      applyNow: true, providerGroupSwitchReason: 'quota-rebalance', effort: 'high', fastMode: true })).rejects.toThrow('route write failed');
    expect(live).toBe(false);
    expect(deps.insertBoundaryMessage).not.toHaveBeenCalled();
    expect(deps.setPendingHandoff).not.toHaveBeenCalled();
    expect(deps.confirmNativeHistoryFallback).not.toHaveBeenCalled();
    if (state === 'account-changed' || state === 'history-cleared') {
      expect(deps.applyAgentSwitchToDb).toHaveBeenCalledTimes(2);
      expect(deps.setSessionProvider).toHaveBeenCalledTimes(1);
      return;
    }
    expect(row).toEqual(original);
    expect(deps.setSessionProvider).toHaveBeenLastCalledWith('s1', original.providerId);
  });

  it.each([
    ['claude-code', 'cc', null, 'mini'], ['codex', 'codex', 'mini', null], ['pi', 'pi', 'mini', 'studio'],
  ] as const)('restores %s history from %s between computers before dispatch', async (kind, dbKind, from, to) => {
    let nativeId = 'original';
    const row = makeRow({ agentKind: dbKind, agentDeviceId: from, workingDir: '/project', sdkSessionId: nativeId });
    const relocateNativeHistory = vi.fn(async () => 'transferred');
    const { deps, calls } = makeDeps({
      getSessionRow: vi.fn(async () => row), relocateNativeHistory,
      getLiveSession: () => ({ isTurnRunning: () => false, sdkSessionId: nativeId }),
      applyAgentSwitchToDb: vi.fn(async (_sessionId, patch) => { calls.push('db'); nativeId = patch.sdkSessionId!; }),
    });
    await performSessionAgentSwitch(deps, { ...validParams, targetAgentKind: kind, agentDeviceId: to, applyNow: true, skipBootstrap: true });
    expect(relocateNativeHistory).toHaveBeenCalledWith(expect.objectContaining({ fromDevice: from, toDevice: to, nativeId: 'original', workingDir: '/project' }));
    expect(vi.mocked(deps.closeSession).mock.invocationCallOrder[0]).toBeLessThan(relocateNativeHistory.mock.invocationCallOrder[0]);
    expect(deps.applyAgentSwitchToDb).toHaveBeenCalledWith('s1', expect.objectContaining({ sdkSessionId: 'transferred' }));
    expect(deps.bootstrapSwitchedSession).toHaveBeenCalledOnce();
    expect(deps.insertBoundaryMessage).toHaveBeenCalledWith('s1', expect.objectContaining({ resumed: true, handoff: expect.not.stringContaining('你好') }));
    expect(deps.applyResumeFallbackAtomically).not.toHaveBeenCalled();
  });

  it.each([false, true])('falls back with visible handoff metadata when restore fails or silently starts fresh (%s)', async (silent) => {
    const { deps } = makeDeps({
      getSessionRow: vi.fn(async () => makeRow({ workingDir: '/project' })),
      relocateNativeHistory: vi.fn(async () => 'transferred'),
      bootstrapSwitchedSession: silent ? vi.fn(async () => {}) : vi.fn().mockRejectedValueOnce(new Error('native format unavailable')).mockResolvedValue(undefined),
    });
    await performSessionAgentSwitch(deps, { ...validParams, targetAgentKind: 'claude-code', agentDeviceId: 'mini', applyNow: true });
    expect(deps.applyResumeFallbackAtomically).toHaveBeenCalledWith('s1', 'boundary-client-1', expect.objectContaining({ resumed: false, handoff: expect.stringContaining('你好') }));
    expect(deps.bootstrapSwitchedSession).toHaveBeenCalledTimes(2);
  });

  it.each(['current', 'account-changed', 'history-cleared'] as const)('settles native resume fallback despite failed target cleanup (%s)', async state => {
    let owner = 1;
    let generation = 0;
    let row = makeRow({ workingDir: '/project', sdkSessionId: 'source-native' });
    let boundary: unknown;
    const { deps } = makeDeps({
      readOwnerGeneration: () => owner,
      readPendingHandoffGeneration: () => generation,
      getSessionRow: vi.fn(async () => ({ ...row })),
      getLiveSession: () => ({ isTurnRunning: () => false, sdkSessionId: row.sdkSessionId ?? undefined }),
      relocateNativeHistory: vi.fn(async () => 'transferred'),
      applyAgentSwitchToDb: vi.fn(async (_id, patch) => { row = { ...row, ...patch, providerId: patch.providerId ?? null }; }),
      insertBoundaryMessage: vi.fn(async (_id, content) => { boundary = content; return 'boundary-client-1'; }),
      applyResumeFallbackAtomically: vi.fn(async (_id, _clientId, content) => { row.sdkSessionId = null; boundary = content; }),
      closeSession: vi.fn().mockResolvedValueOnce(undefined).mockImplementation(async () => {
        if (state === 'account-changed') owner++;
        if (state === 'history-cleared') generation++;
        throw new Error('DEVICE_LINK_NOT_CONNECTED');
      }),
      bootstrapSwitchedSession: vi.fn().mockRejectedValueOnce(new Error('cannot resume')).mockResolvedValue(undefined),
    });
    const switching = performSessionAgentSwitch(deps, { ...validParams, targetAgentKind: 'claude-code', agentDeviceId: 'mini', applyNow: true });
    if (state !== 'current') {
      await expect(switching).rejects.toThrow(state === 'account-changed' ? 'REMOTE_AGENT_ACCOUNT_CHANGED' : 'history changed');
      expect(deps.applyResumeFallbackAtomically).not.toHaveBeenCalled();
      expect(deps.bootstrapSwitchedSession).toHaveBeenCalledOnce();
      return;
    }
    await expect(switching).resolves.toMatchObject({ switched: true, engineReady: true });
    expect(row.sdkSessionId).toBeNull();
    expect(boundary).toMatchObject({ resumed: false, nativeHistory: 'fallback', handoff: expect.stringContaining('你好') });
    expect(deps.setPendingHandoff).toHaveBeenLastCalledWith('s1', expect.stringContaining('你好'), 0);
    expect(deps.bootstrapSwitchedSession).toHaveBeenCalledTimes(2);
  });

  it('does not commit native history after clear or cancellation during transfer', async () => {
    let generation = 0;
    const { deps } = makeDeps({
      readPendingHandoffGeneration: () => generation,
      getSessionRow: vi.fn(async () => makeRow({ workingDir: '/project' })),
      relocateNativeHistory: vi.fn(async input => { generation++; input.assertCurrent(); return 'transferred'; }),
    });
    await expect(performSessionAgentSwitch(deps, { ...validParams, targetAgentKind: 'claude-code', agentDeviceId: 'mini', applyNow: true })).rejects.toThrow('history changed');
    expect(deps.applyAgentSwitchToDb).not.toHaveBeenCalled();
    expect(deps.setPendingHandoff).not.toHaveBeenCalled();
  });

  it('keeps context from a previous switch that has not reached the native session yet', async () => {
    const { deps } = makeDeps({
      getSessionRow: vi.fn(async () => makeRow({ workingDir: '/project' })),
      relocateNativeHistory: vi.fn(async () => 'transferred'),
      peekPendingHandoff: vi.fn(async () => 'Important context waiting for the first native send'),
      getLiveSession: () => ({ isTurnRunning: () => false, sdkSessionId: 'transferred' }),
    });
    await performSessionAgentSwitch(deps, { ...validParams, targetAgentKind: 'claude-code', agentDeviceId: 'mini', applyNow: true });
    expect(deps.setPendingHandoff).toHaveBeenCalledWith('s1', expect.stringContaining('Important context waiting for the first native send'), undefined);
    expect(deps.applyResumeFallbackAtomically).not.toHaveBeenCalled();
  });

  it('does not treat an account switch during transfer as an ordinary fallback', async () => {
    let owner = 1;
    const { deps } = makeDeps({
      readOwnerGeneration: () => owner,
      getSessionRow: vi.fn(async () => makeRow({ workingDir: '/project' })),
      relocateNativeHistory: vi.fn(async () => { owner++; throw new Error('owner changed'); }),
    });
    await expect(performSessionAgentSwitch(deps, { ...validParams, targetAgentKind: 'claude-code', agentDeviceId: 'mini', applyNow: true })).rejects.toThrow('REMOTE_AGENT_ACCOUNT_CHANGED');
    expect(deps.applyAgentSwitchToDb).not.toHaveBeenCalled();
    expect(deps.setPendingHandoff).not.toHaveBeenCalled();
  });

  it('resumes native history on startup relocation and atomically falls back if opening it fails', async () => {
    const { deps } = makeDeps({
      getSessionRow: vi.fn(async () => makeRow({ workingDir: '/project', agentDeviceId: 'target' })),
      relocateNativeHistory: vi.fn(async () => 'restored-native'),
    });
    const result = await relocateForFreshStart(deps, { sessionId: 's1', agentDeviceId: 'target', providerId: null,
      from: { agentDeviceId: 'source', providerId: null } });
    expect(result.nativeId).toBe('restored-native');
    expect(deps.relocateNativeHistory).toHaveBeenCalledWith(expect.objectContaining({ fromDevice: 'source', toDevice: 'target' }));
    expect(deps.applyAgentSwitchToDb).toHaveBeenCalledWith('s1', expect.objectContaining({ sdkSessionId: 'restored-native' }));
    expect(deps.insertBoundaryMessage).toHaveBeenCalledWith('s1', expect.objectContaining({ nativeHistory: 'restored', resumed: true }));
    await result.fallback!();
    expect(deps.applyResumeFallbackAtomically).toHaveBeenCalledWith('s1', 'boundary-client-1', expect.objectContaining({
      resumed: false, nativeHistory: 'fallback', handoff: expect.stringContaining('你好'),
    }));
    expect(deps.setPendingHandoff).toHaveBeenLastCalledWith('s1', expect.stringContaining('你好'), undefined);
  });

  it('keeps cross-harness switching on the existing handoff path', async () => {
    const relocateNativeHistory = vi.fn();
    const { deps } = makeDeps({ relocateNativeHistory, getSessionRow: vi.fn(async () => makeRow({ workingDir: '/project' })) });
    await performSessionAgentSwitch(deps, { ...validParams, agentDeviceId: 'mini', applyNow: true });
    expect(relocateNativeHistory).not.toHaveBeenCalled();
    expect(deps.applyAgentSwitchToDb).toHaveBeenCalledWith('s1', expect.objectContaining({ sdkSessionId: null }));
  });

  it('restores the source before opening a native copy whose fallback boundary could not be saved', async () => {
    const { deps } = makeDeps({
      getSessionRow: vi.fn(async () => makeRow({ workingDir: '/project', sdkSessionId: 'source-native', agentDeviceId: 'source' })),
      relocateNativeHistory: vi.fn(async () => 'transferred'),
      insertBoundaryMessage: vi.fn(async () => { throw new Error('boundary write failed'); }),
    });
    await expect(relocateForFreshStart(deps, { sessionId: 's1', agentDeviceId: 'target', providerId: null }))
      .rejects.toThrow('boundary write failed');
    expect(deps.applyAgentSwitchToDb).toHaveBeenLastCalledWith('s1', expect.objectContaining({
      sdkSessionId: 'source-native', agentDeviceId: 'source', providerId: 'xd',
    }));
    expect(deps.setSessionProvider).toHaveBeenLastCalledWith('s1', 'xd');
    expect(deps.setPendingHandoff).not.toHaveBeenCalled();
    expect(deps.bootstrapSwitchedSession).not.toHaveBeenCalled();
  });
});

const orcaAgents = [
  { kind: 'claude-code', dbKind: 'cc', model: 'claude-fable-5', providerId: 'anthropic' },
  { kind: 'codex', dbKind: 'codex', model: 'gpt-6-astra', providerId: 'openai' },
  { kind: 'pi', dbKind: 'pi', model: 'gpt-6-astra', providerId: 'openai' },
] as const;
const orcaSwitchCases = (['lead', 'worker'] as const).flatMap((role) =>
  orcaAgents.flatMap((from) => orcaAgents.filter((to) => to.kind !== from.kind).map((to) => ({
    role, from, to, name: `${role}: ${from.kind} → ${to.kind}`,
  }))),
);

describe('Orca three-Agent switching', () => {
  it.each(orcaSwitchCases)('$name stages until idle, preserves its role, and resumes the parked source on return', async ({ role, from, to }) => {
    let row = makeRow({ agentKind: from.dbKind, model: from.model, providerId: from.providerId, orcaRole: role });
    let running = true;
    const pendingSwitches = createPendingAgentSwitchRegistry();
    const parked = new Map<string, string>();
    const { deps } = makeDeps({
      pendingSwitches,
      getSessionRow: vi.fn(async () => ({ ...row })),
      getLiveSession: vi.fn(() => ({ isTurnRunning: () => running })),
      findParkedEngineSession: vi.fn(async (_id, kind) => {
        const sdkSessionId = parked.get(kind);
        return sdkSessionId ? { sdkSessionId, watermarkCreatedAt: 0, watermarkRowid: 0 } : null;
      }),
      applyAgentSwitchToDb: vi.fn(async (_id, patch) => {
        row = { ...row, ...patch, providerId: patch.providerId ?? null, sdkSessionId: patch.sdkSessionId ?? null };
      }),
      insertBoundaryMessage: vi.fn(async (_id, boundary) => {
        if (boundary.fromSdkSessionId) parked.set(boundary.fromAgentKind, boundary.fromSdkSessionId);
        return `boundary-${parked.size}`;
      }),
      bootstrapSwitchedSession: vi.fn(async () => { row.sdkSessionId ??= `native-${row.agentKind}`; }),
    });

    await expect(performSessionAgentSwitch(deps, {
      sessionId: 's1', targetAgentKind: to.kind, model: to.model, providerId: to.providerId,
    })).resolves.toMatchObject({ deferred: true, switched: false });
    await applyPendingAgentSwitchIfIdle(deps, 's1', { bootstrapAfterSwitch: true });
    expect(row).toMatchObject({ agentKind: from.dbKind, sdkSessionId: 'sdk-old', orcaRole: role });
    expect(deps.closeSession).not.toHaveBeenCalled();
    expect(pendingSwitches.get('s1')?.targetAgentKind).toBe(to.kind);

    running = false;
    await applyPendingAgentSwitchIfIdle(deps, 's1', { bootstrapAfterSwitch: true });
    expect(row).toMatchObject({ agentKind: to.dbKind, model: to.model, providerId: to.providerId, orcaRole: role, sdkSessionId: `native-${to.dbKind}` });
    expect(pendingSwitches.get('s1')).toBeUndefined();
    expect(deps.closeSession).toHaveBeenCalledExactlyOnceWith('s1');
    expect(deps.bootstrapSwitchedSession).toHaveBeenCalledExactlyOnceWith('s1');
    expect(deps.applyAgentSwitchToDb).toHaveBeenCalledWith('s1', expect.objectContaining({ agentKind: to.dbKind, sdkSessionId: null }));
    expect(deps.insertBoundaryMessage).toHaveBeenLastCalledWith('s1', expect.objectContaining({
      fromAgentKind: from.dbKind, toAgentKind: to.dbKind, fromSdkSessionId: 'sdk-old',
      consumed: false, resumed: false, handoff: expect.stringContaining('你好'),
    }));

    await performSessionAgentSwitch(deps, {
      sessionId: 's1', targetAgentKind: from.kind, model: from.model, providerId: from.providerId,
    });
    await applyPendingAgentSwitchIfIdle(deps, 's1', { bootstrapAfterSwitch: true });
    expect(row).toMatchObject({ agentKind: from.dbKind, model: from.model, providerId: from.providerId, orcaRole: role, sdkSessionId: 'sdk-old' });
    expect(pendingSwitches.get('s1')).toBeUndefined();
    expect(deps.insertBoundaryMessage).toHaveBeenLastCalledWith('s1', expect.objectContaining({
      fromAgentKind: to.dbKind, toAgentKind: from.dbKind, resumed: true, consumed: false,
      handoff: expect.stringContaining('now it is switching back to you'),
    }));
    expect(deps.closeSession).toHaveBeenCalledTimes(2);
    expect(deps.bootstrapSwitchedSession).toHaveBeenCalledTimes(2);
  });
});

describe('same-engine selection at send', () => {
  function selectionHarness() {
    const pending = createPendingAgentSwitchRegistry();
    let row = makeRow({ agentKind: 'codex', model: 'gpt-6-astra', providerId: 'openai' });
    const apply = vi.fn(async (intent: PendingAgentSwitchIntent) => {
      row = { ...row, model: intent.model, providerId: intent.providerId ?? null };
    });
    const { deps, calls } = makeDeps({
      pendingSwitches: pending,
      getSessionRow: async () => row,
      selectSameAgentModel: async (id, intent, applyNow) => {
        if (!applyNow) {
          pending.set(id, intent);
          return { deferred: true };
        }
        await apply(intent);
        return { deferred: false };
      },
    });
    return { deps, pending, apply, calls, row: () => row };
  }

  // #7825, unit: exercise the production pending-apply entry with the real
  // setting guard and permission policy. Existing cases test switching and
  // guest denial separately; the missing input is an owner-staged choice whose
  // first send runs inside a guest's async invoke context.
  function sharedSelectionHarness(sessionId = 's1') {
    const h = selectionHarness();
    let current = true;
    const capture: SharedTaskPeerCapture = {
      author: { sharedTaskId: 'shared', sessionId, memberId: 'guest', accountId: 'guest', displayName: 'Guest' },
      isCurrent: () => current,
      authorize: (operation) => authorizeSharedTaskOperation({
        sharedTaskId: 'shared', sessionId: 's1', ownerAccountId: 'owner', hostDeviceId: 'host',
        status: 'active', revision: 1,
        guests: current ? [{ memberId: 'guest', accountId: 'guest', version: 1, deviceIds: ['phone'] }] : [],
      }, { accountId: 'guest', deviceId: 'phone' }, 's1', operation).allowed,
    };
    const context = { controllerDeviceId: 'phone', channel: 'maker:input:enqueue', sharedTask: capture,
      sharedTaskSetting: { admitted: false } };
    const preflight = vi.fn(async () => false);
    const select = h.deps.selectSameAgentModel!;
    h.deps.selectSameAgentModel = async (id, intent, applyNow, assertSelectionCurrent, beforeMutation, pendingSelectionAccess) => {
      if (!applyNow) return select(id, intent, false);
      const invoke = getDeviceLinkInvokeContext();
      const guard = pendingSelectionAccess ?? createSharedTaskSettingGuard(invoke?.sharedTask, id, invoke?.sharedTaskSetting ?? { admitted: false });
      assertSelectionCurrent?.();
      guard();
      await preflight();
      await beforeMutation?.();
      assertSelectionCurrent?.();
      guard.admit();
      return select(id, intent, true);
    };
    return { ...h, capture, context, preflight, revoke: () => { current = false; } };
  }

  it('applies the owner choice on the first guest send without granting the guest model access', async () => {
    const h = sharedSelectionHarness();
    await performSessionAgentSwitch(h.deps, { ...validParams, model: 'gpt-5.6-sol' });
    await runDeviceLinkInvokeContext(h.context, async () => {
      await applyPendingAgentSwitchIfIdle(h.deps, 's1');
      expect(h.row().model).toBe('gpt-5.6-sol');
      expect(h.pending.get('s1')).toBeUndefined();
      // The next send still carries the guest author, and a subsequent settings
      // request in the same invoke must not inherit the host transaction's admission.
      expect(getDeviceLinkInvokeContext()).toBe(h.context);
      expect(h.context.sharedTaskSetting.admitted).toBe(false);
      const ipc = new IpcHarness();
      registerMakerSessionAgentSwitchHandler(ipc, h.deps);
      await expect(ipc.invoke(MAKER_INVOKE.SWITCH_SESSION_AGENT, 's1', 'codex', 'guest-model', null))
        .rejects.toThrow('PERMISSION_DENIED');
      expect(h.row().model).toBe('gpt-5.6-sol');
      expect(h.pending.get('s1')).toBeUndefined();
    });
    expect(h.apply).toHaveBeenCalledOnce();
  });

  it.each(['revoked', 'other-task', 'during-preflight'] as const)(
    'keeps the owner choice pending when guest access fails (%s)', async (failure) => {
      const h = sharedSelectionHarness(failure === 'other-task' ? 'other-task' : 's1');
      await performSessionAgentSwitch(h.deps, { ...validParams, model: 'gpt-5.6-sol' });
      if (failure === 'revoked') h.revoke();
      if (failure === 'during-preflight') h.preflight.mockImplementationOnce(async () => {
        h.revoke();
        return false;
      });
      await expect(runDeviceLinkInvokeContext(h.context, () => applyPendingAgentSwitchIfIdle(h.deps, 's1')))
        .rejects.toThrow('PERMISSION_DENIED');
      expect(h.row().model).toBe('gpt-6-astra');
      expect(h.apply).not.toHaveBeenCalled();
      expect(h.pending.get('s1')?.model).toBe('gpt-5.6-sol');
      // An invalid guest request must not discard the owner's pending choice.
      await applyPendingAgentSwitchIfIdle(h.deps, 's1');
      expect(h.row().model).toBe('gpt-5.6-sol');
      expect(h.pending.get('s1')).toBeUndefined();
    },
  );

  it('keeps the source thread untouched while selecting away and back, and applies only the final choice on send', async () => {
    const h = selectionHarness();
    for (const [model, providerId] of [['gpt-5.6-sol', 'xd'], ['gpt-6-astra', 'openai']]) {
      expect(await performSessionAgentSwitch(h.deps, {
        sessionId: 's1', targetAgentKind: 'codex', model, providerId, effort: 'high', fastMode: false,
      })).toMatchObject({ deferred: true, switched: false });
    }
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.row()).toMatchObject({ model: 'gpt-6-astra', providerId: 'openai', sdkSessionId: 'sdk-old' });
    expect(h.calls).toEqual([]);
    await applyPendingAgentSwitchIfIdle(h.deps, 's1');
    await applyPendingAgentSwitchIfIdle(h.deps, 's1');
    expect(h.apply).toHaveBeenCalledTimes(1);
    expect(h.apply).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-6-astra', providerId: 'openai' }));
    expect(h.pending.get('s1')).toBeUndefined();
    expect(h.calls).toEqual([]);
  });

  it('keeps the staged thinking intent when a later edit only changes effort or fast', async () => {
    const h = selectionHarness();
    await performSessionAgentSwitch(h.deps, {
      sessionId: 's1', targetAgentKind: 'codex', model: 'gpt-6-astra', providerId: 'openai',
      effort: 'high', fastMode: false, thinking: true,
    });
    expect(h.pending.get('s1')?.thinking).toBe(true);
    // 意图期内改档位（只带 effort）必须继承已暂存的 thinking；否则结算回放会把它丢成 undefined，
    // Pi 就会保留上一个模型的 off。
    await performSessionAgentSwitch(h.deps, {
      sessionId: 's1', targetAgentKind: 'codex', model: 'gpt-6-astra', providerId: 'openai',
      effort: 'max', fastMode: false,
    });
    expect(h.pending.get('s1')).toMatchObject({ effort: 'max', thinking: true });
    // 显式改开关时以新值为准，并原样回放到发送结算。
    await performSessionAgentSwitch(h.deps, {
      sessionId: 's1', targetAgentKind: 'codex', model: 'gpt-6-astra', providerId: 'openai',
      effort: 'max', fastMode: false, thinking: false,
    });
    expect(h.pending.get('s1')?.thinking).toBe(false);
    await applyPendingAgentSwitchIfIdle(h.deps, 's1');
    expect(h.apply).toHaveBeenCalledWith(expect.objectContaining({ thinking: false }));
  });

  it('does not inherit a staged thinking intent when the target model changes', async () => {
    const h = selectionHarness();
    await performSessionAgentSwitch(h.deps, { ...validParams, thinking: false });
    expect(h.pending.get('s1')?.thinking).toBe(false);

    // 改选到另一个模型：旧模型的开关不适用，不能继承（否则新模型被串成 off）。
    await performSessionAgentSwitch(h.deps, { ...validParams, model: 'gpt-7-nova' });
    expect(h.pending.get('s1')?.model).toBe('gpt-7-nova');
    expect(h.pending.get('s1')?.thinking).toBeUndefined();
  });

  it('keeps an internal cross-engine apply that already reached its target as a no-op', async () => {
    const h = selectionHarness();
    const select = vi.spyOn(h.deps, 'selectSameAgentModel');
    const result = await performSessionAgentSwitch(h.deps, { ...validParams, applyNow: true });
    expect(result).toMatchObject({ switched: false, engineReady: true });
    expect(select).not.toHaveBeenCalled();
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.row()).toMatchObject({ model: 'gpt-6-astra', providerId: 'openai' });
  });

  it('fails the send on preparation failure and retains the final selection for retry', async () => {
    const h = selectionHarness();
    await performSessionAgentSwitch(h.deps, { ...validParams, providerId: 'xd' });
    h.apply.mockRejectedValueOnce(new Error('target is disconnected'));
    await expect(applyPendingAgentSwitchIfIdle(h.deps, 's1')).rejects.toThrow('target is disconnected');
    expect(h.pending.get('s1')?.providerId).toBe('xd');
    expect(h.row().providerId).toBe('openai');
    await applyPendingAgentSwitchIfIdle(h.deps, 's1');
    expect(h.row().providerId).toBe('xd');
  });

  it('does not apply before a running turn settles, or when send has been canceled', async () => {
    const h = selectionHarness();
    await performSessionAgentSwitch(h.deps, validParams);
    h.deps.getLiveSession = () => ({ isTurnRunning: () => true });
    await applyPendingAgentSwitchIfIdle(h.deps, 's1');
    expect(h.apply).not.toHaveBeenCalled();
    h.deps.getLiveSession = () => ({ isTurnRunning: () => false });
    const abort = new AbortController();
    abort.abort();
    await expect(applyPendingAgentSwitchIfIdle(h.deps, 's1', { signal: abort.signal })).rejects.toThrow('aborted');
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.pending.get('s1')).toBeDefined();
  });

  it('coalesces concurrent sends and does not clear a newer pending selection', async () => {
    const h = selectionHarness();
    await performSessionAgentSwitch(h.deps, validParams);
    let finish!: () => void;
    h.apply.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const first = applyPendingAgentSwitchIfIdle(h.deps, 's1');
    const second = applyPendingAgentSwitchIfIdle(h.deps, 's1');
    h.pending.set('s1', { targetAgentKind: 'codex', model: 'gpt-6-astra', providerId: 'openai', sameAgentSelection: true });
    finish();
    await Promise.all([first, second]);
    expect(h.apply).toHaveBeenCalledTimes(1);
    expect(h.pending.get('s1')?.model).toBe('gpt-6-astra');
  });
});

describe('performSessionAgentSwitch', () => {
  it('stages and forwards the Pi thinking intent across an engine switch', async () => {
    let row = makeRow();
    const bootstraps: Array<{ thinkingEnabled?: boolean } | undefined> = [];
    const remembered: Array<{
      agentKind: string;
      providerId: string | null;
      model: string;
      thinking: boolean;
    }> = [];
    const pendingSwitches = createPendingAgentSwitchRegistry();
    const { deps } = makeDeps({
      pendingSwitches,
      rememberThinkingIntent: (input) => {
        remembered.push(input);
      },
      getSessionRow: async () => ({ ...row }),
      applyAgentSwitchToDb: async (_id, patch) => {
        row = {
          ...row,
          agentKind: patch.agentKind,
          model: patch.model,
          providerId: patch.providerId ?? null,
        };
      },
      bootstrapSwitchedSession: async (_id, opts) => {
        bootstraps.push(opts);
      },
    });

    await performSessionAgentSwitch(deps, {
      sessionId: 's1',
      targetAgentKind: 'pi',
      model: 'deepseek-v4.1-flash',
      providerId: 'opencode-go',
      thinking: true,
    });
    // 跨引擎 intent 也必须记住思考意图，否则发送重建时只能靠被控端镜像/默认值。
    expect(deps.pendingSwitches?.get('s1')?.thinking).toBe(true);

    await applyPendingAgentSwitchIfIdle(deps, 's1', { bootstrapAfterSwitch: true });
    expect(bootstraps.at(-1)).toEqual({ thinkingEnabled: true });
    // 跨引擎提交后把选择落到本机偏好镜像：普通 send 的 lazy-create 只读镜像，
    // 不经过 bootstrap，远端推送未回流时会用到旧值。
    expect(remembered.at(-1)).toEqual({
      agentKind: 'pi',
      providerId: 'opencode-go',
      model: 'deepseek-v4.1-flash',
      thinking: true,
    });
  });

  it('inherits the staged Pi thinking intent when a same-target cross-engine intent is re-registered', async () => {
    const pendingSwitches = createPendingAgentSwitchRegistry();
    const { deps } = makeDeps({
      pendingSwitches,
      getSessionRow: async () => ({ ...makeRow() }),
    });

    await performSessionAgentSwitch(deps, {
      sessionId: 's1',
      targetAgentKind: 'pi',
      model: 'deepseek-v4.1-flash',
      providerId: 'opencode-go',
      thinking: false,
    });
    expect(pendingSwitches.get('s1')?.thinking).toBe(false);

    // 只改档位的重登记（旧调用方/只带 effort）不带思考意图：同一目标必须继承，
    // 否则登记快照被覆盖成 undefined，发送回放时 Pi 新会话会按默认值重新开思考。
    await performSessionAgentSwitch(deps, {
      sessionId: 's1',
      targetAgentKind: 'pi',
      model: 'deepseek-v4.1-flash',
      providerId: 'opencode-go',
      effort: 'high',
    });
    expect(pendingSwitches.get('s1')?.thinking).toBe(false);

    // 改选到别的模型 = 换目标：旧目标的开关不适用，不继承，避免串给新模型。
    await performSessionAgentSwitch(deps, {
      sessionId: 's1',
      targetAgentKind: 'pi',
      model: 'deepseek-v4.2-flash',
      providerId: 'opencode-go',
      effort: 'high',
    });
    expect(pendingSwitches.get('s1')?.thinking).toBeUndefined();
  });

  it('keeps the config-staged identity through resume-fallback recovery re-entry', async () => {
    // 渠道默认触发的跨引擎切换若走 resume 回落恢复, 恢复意图必须保留 configStaged ——
    // 否则被通用路径消费时当成用户选择打上 manual 墓碑, 任务永久脱离跟随
    // (chatgpt-codex-connector P2, PR #5155)。
    let row = makeRow();
    let failFallback = true;
    const onUserRouteSelectionLanded = vi.fn();
    const pending = createPendingAgentSwitchRegistry();
    const { deps } = makeDeps({
      pendingSwitches: pending,
      onUserRouteSelectionLanded,
      getSessionRow: async () => ({ ...row }),
      findParkedEngineSession: async (_id, kind) =>
        kind === 'codex' ? { sdkSessionId: 'broken-codex', watermarkCreatedAt: 0, watermarkRowid: 0 } : null,
      applyAgentSwitchToDb: async (_id, patch) => {
        row = { ...row, ...patch, providerId: patch.providerId ?? null, sdkSessionId: patch.sdkSessionId ?? null };
      },
      insertBoundaryMessage: async () => 'boundary-1',
      bootstrapSwitchedSession: async () => {
        throw new Error('resume failed');
      },
      applyResumeFallbackAtomically: async () => {
        if (failFallback) throw new Error('db locked');
        row.sdkSessionId = null;
      },
    });
    await performSessionAgentSwitch(deps, { ...validParams, configStaged: true });
    await applyPendingAgentSwitchIfIdle(deps, 's1');
    expect(pending.get('s1')?.resumeFallbackRecovery).toBeDefined();
    expect(onUserRouteSelectionLanded).not.toHaveBeenCalled();

    // 恢复尾段重试成功后被消费: 仍然是系统配置切换, 不立碑。
    failFallback = false;
    await applyPendingAgentSwitchIfIdle(deps, 's1');
    expect(onUserRouteSelectionLanded).not.toHaveBeenCalled();
    expect(pending.get('s1')).toBeUndefined();
  });

  it('cycles Claude → Codex → Pi → Claude → Codex and recovers a broken parked thread once', async () => {
    let row = makeRow();
    const parked = new Map<string, string>();
    const boundaries: Array<{ fromAgentKind: string; fromSdkSessionId: string | null; handoff: string }> = [];
    let bootstraps = 0;
    const { deps } = makeDeps({
      getSessionRow: async () => ({ ...row }),
      findParkedEngineSession: async (_sessionId, kind) => {
        const sdkSessionId = parked.get(kind);
        return sdkSessionId ? { sdkSessionId, watermarkCreatedAt: 0, watermarkRowid: 0 } : null;
      },
      applyAgentSwitchToDb: async (_sessionId, patch) => {
        row = { ...row, ...patch, providerId: patch.providerId ?? null, sdkSessionId: patch.sdkSessionId ?? null };
      },
      insertBoundaryMessage: async (_sessionId, boundary) => {
        if (boundary.fromSdkSessionId) parked.set(boundary.fromAgentKind, boundary.fromSdkSessionId);
        boundaries.push(boundary);
        return `boundary-${boundaries.length}`;
      },
      bootstrapSwitchedSession: async () => {
        bootstraps++;
        if (row.sdkSessionId === 'broken-codex') throw new Error('thread history projection expected ordinal 15, got 3');
        row.sdkSessionId ??= `native-${row.agentKind}-${bootstraps}`;
      },
      applyResumeFallbackAtomically: async (_sessionId, boundaryId, boundary) => {
        row.sdkSessionId = null;
        boundaries[Number(boundaryId.split('-')[1]) - 1] = boundary;
      },
    });
    const choices = [
      { targetAgentKind: 'codex', model: 'gpt-6-astra', providerId: 'openai', effort: 'high', fastMode: true },
      { targetAgentKind: 'pi', model: 'grok-4.6', providerId: 'xai', effort: 'high', fastMode: false },
      { targetAgentKind: 'claude-code', model: 'claude-fable-5', providerId: 'xd', effort: 'medium', fastMode: false },
      { targetAgentKind: 'codex', model: 'codex/gpt-5.6-sol', providerId: 'xd', effort: 'high', fastMode: false },
    ];
    for (const [index, choice] of choices.entries()) {
      if (index === 3) parked.set('codex', 'broken-codex');
      const result = await performSessionAgentSwitch(deps, { sessionId: 's1', ...choice, applyNow: true });
      expect(result).toMatchObject({ switched: true, engineReady: true });
      expect(row.model).toBe(choice.model);
      expect(row.providerId).toBe(choice.providerId);
      expect(boundaries.at(-1)?.handoff).toContain('你好');
    }
    expect(bootstraps).toBe(5);
    expect(boundaries).toHaveLength(4);
    expect(row.sdkSessionId).toBe('native-codex-5');
    expect(boundaries.at(-1)).toMatchObject({ resumed: false });
  });

  it('happy path:close → DB 提交 → 边界行 → pending → bootstrap,顺序正确', async () => {
    const { deps, calls } = makeDeps();
    const result = await performSessionAgentSwitch(deps, validParams);
    expect(result).toEqual({ switched: true, agentKind: 'codex', model: 'gpt-5.5', engineReady: true });
    expect(calls).toEqual(['close', 'db', 'provider', 'boundary', 'pending', 'bootstrap']);
    expect(deps.applyAgentSwitchToDb).toHaveBeenCalledWith('s1', {
      agentKind: 'codex',
      model: 'gpt-5.5',
      providerId: null,
      sdkSessionId: null,
    });
    expect(deps.setSessionProvider).toHaveBeenCalledWith('s1', null);
    const boundary = vi.mocked(deps.insertBoundaryMessage).mock.calls[0][1];
    expect(boundary.fromAgentKind).toBe('cc');
    expect(boundary.toAgentKind).toBe('codex');
    expect(boundary.fromModel).toBe('claude-fable-5');
    expect(boundary.toModel).toBe('gpt-5.5');
    expect(boundary.fromProviderId).toBe('xd');
    expect(boundary.toProviderId).toBeNull();
    expect(boundary.fromSdkSessionId).toBe('sdk-old');
    expect(boundary.resumed).toBe(false);
    expect(boundary.consumed).toBe(false);
    expect(boundary.handoff).toContain('Claude Code');
    // close→bootstrap 全程在抑制窗口内(切换的瞬态 close 不得触发 worktree 回收)
    expect(deps.withCloseSuppressed).toHaveBeenCalledTimes(1);
  });

  it('codex → claude-code 方向同样工作', async () => {
    const { deps } = makeDeps({
      getSessionRow: vi.fn(async () => makeRow({ agentKind: 'codex', model: 'gpt-5.5' })),
    });
    const result = await performSessionAgentSwitch(deps, {
      sessionId: 's1',
      targetAgentKind: 'claude-code',
      model: 'claude-fable-5',
    });
    expect(result.switched).toBe(true);
    expect(deps.setSessionProvider).not.toHaveBeenCalled();
    const boundary = vi.mocked(deps.insertBoundaryMessage).mock.calls[0][1];
    expect(boundary.fromAgentKind).toBe('codex');
    expect(boundary.toAgentKind).toBe('cc');
    expect(boundary.fromProviderId).toBe('xd');
    expect(boundary.toProviderId).toBe('xd');
  });

  it('codex → pi + OpenAI 关闭旧会话并保持目标 provider route', async () => {
    const { deps, calls } = makeDeps({
      getSessionRow: vi.fn(async () =>
        makeRow({ agentKind: 'codex', model: 'gpt-5.5-codex', sdkSessionId: 'codex-thread' }),
      ),
    });

    const result = await performSessionAgentSwitch(deps, {
      sessionId: 's1',
      targetAgentKind: 'pi',
      model: 'chatgpt/gpt-5.5',
      providerId: 'openai',
      applyNow: true,
    });

    expect(result).toMatchObject({ switched: true, agentKind: 'pi', engineReady: true });
    expect(calls).toEqual(['close', 'db', 'provider', 'boundary', 'pending', 'bootstrap']);
    expect(deps.applyAgentSwitchToDb).toHaveBeenCalledWith('s1', {
      agentKind: 'pi',
      model: 'chatgpt/gpt-5.5',
      providerId: 'openai',
      sdkSessionId: null,
    });
    expect(deps.setSessionProvider).toHaveBeenCalledWith('s1', 'openai');
  });

  it('claude-code → pi 不会被参数校验拒绝', async () => {
    const { deps } = makeDeps();
    const result = await performSessionAgentSwitch(deps, {
      sessionId: 's1',
      targetAgentKind: 'pi',
      model: 'gpt-5.5',
      applyNow: true,
    });
    expect(result).toMatchObject({ switched: true, agentKind: 'pi' });
    expect(deps.applyAgentSwitchToDb).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ agentKind: 'pi' }),
    );
  });

  it('跨引擎 DB 提交后立即覆盖旧 provider route', async () => {
    const { deps } = makeDeps();

    await performSessionAgentSwitch(deps, {
      ...validParams,
      providerId: 'anthropic',
    });

    expect(deps.setSessionProvider).toHaveBeenCalledWith('s1', 'anthropic');
    expect(vi.mocked(deps.applyAgentSwitchToDb).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deps.setSessionProvider).mock.invocationCallOrder[0],
    );
  });

  it.each([
    ['空白值', '  ', null],
    ['首尾空格', ' anthropic ', 'anthropic'],
  ])('%s providerId 在 DB 与内存路由中使用同一归一化值', async (_case, providerId, expected) => {
    const { deps } = makeDeps();

    await performSessionAgentSwitch(deps, {
      ...validParams,
      providerId,
    });

    expect(deps.applyAgentSwitchToDb).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ providerId: expected }),
    );
    expect(deps.setSessionProvider).toHaveBeenCalledWith('s1', expected);
  });

  it('参数校验:非法 sessionId / targetAgentKind / model 抛 INVALID_PARAMS', async () => {
    const { deps } = makeDeps();
    await expect(performSessionAgentSwitch(deps, { ...validParams, sessionId: 7 })).rejects.toThrow(/INVALID_PARAMS/);
    await expect(
      performSessionAgentSwitch(deps, { ...validParams, targetAgentKind: 'gemini' }),
    ).rejects.toThrow(/INVALID_PARAMS/);
    await expect(performSessionAgentSwitch(deps, { ...validParams, model: '' })).rejects.toThrow(/INVALID_PARAMS/);
  });

  it('会话不存在或已删除抛 NOT_FOUND', async () => {
    const missing = makeDeps({ getSessionRow: vi.fn(async () => null) });
    await expect(performSessionAgentSwitch(missing.deps, validParams)).rejects.toThrow(/NOT_FOUND/);
    const deleted = makeDeps({ getSessionRow: vi.fn(async () => makeRow({ status: 'deleted' })) });
    await expect(performSessionAgentSwitch(deleted.deps, validParams)).rejects.toThrow(/NOT_FOUND/);
  });

  it('Review 审计任务拒绝切换 harness', async () => {
    const { deps, calls } = makeDeps({
      getSessionRow: vi.fn(async () => makeRow({ source: 'review' })),
    });

    await expect(performSessionAgentSwitch(deps, validParams)).rejects.toThrow(
      /Review task settings are fixed/,
    );
    expect(calls).toEqual([]);
  });

  it('远程会话仍拒绝切换，Orca Lead/Worker 复用跨引擎交接事务', async () => {
    const remote = makeDeps({ getSessionRow: vi.fn(async () => makeRow({ remoteHostId: 'host-1' })) });
    await expect(performSessionAgentSwitch(remote.deps, validParams)).rejects.toThrow(/SSH_HARNESS_SWITCH_UNSUPPORTED/);
    const orca = makeDeps({ getSessionRow: vi.fn(async () => makeRow({ orcaRole: 'lead' })) });
    await expect(performSessionAgentSwitch(orca.deps, validParams)).resolves.toMatchObject({
      switched: true,
      agentKind: 'codex',
      model: 'gpt-5.5',
    });
    expect(orca.deps.applyAgentSwitchToDb).toHaveBeenCalledWith('s1', expect.objectContaining({
      agentKind: 'codex',
      model: 'gpt-5.5',
    }));
  });

  it('同引擎目标 = no-op 成功,不发生任何状态变更', async () => {
    const { deps, calls } = makeDeps();
    const result = await performSessionAgentSwitch(deps, {
      ...validParams,
      targetAgentKind: 'claude-code',
      model: 'claude-sonnet-5',
    });
    expect(result.switched).toBe(false);
    expect(calls).toEqual([]);
  });

  it('同引擎 no-op 通过真实 registry CAS 清意图并返回因果修订号', async () => {
    const pendingSwitches = createPendingAgentSwitchRegistry();
    pendingSwitches.set('s1', {
      targetAgentKind: 'codex',
      model: 'gpt-5.5',
      providerId: null,
    });
    const onPendingSwitchChanged = vi.fn();
    const { deps } = makeDeps({ pendingSwitches, onPendingSwitchChanged });

    const result = await performSessionAgentSwitch(deps, {
      ...validParams,
      targetAgentKind: 'claude-code',
      model: 'claude-sonnet-5',
    });

    expect(result).toMatchObject({
      switched: false,
      sameEngineRevision: 2,
    });
    expect(pendingSwitches.get('s1')).toBeUndefined();
    expect(pendingSwitches.revision?.('s1')).toBe(2);
    expect(onPendingSwitchChanged).toHaveBeenCalledWith('s1', null);
  });

  it('回归:同引擎 no-op 在 await 期间被外部 set→clear ABA 超车时不再应用旧选择', async () => {
    const pendingSwitches = createPendingAgentSwitchRegistry();
    pendingSwitches.set('s1', {
      targetAgentKind: 'codex',
      model: 'gpt-5.5',
      providerId: null,
    });
    let releaseRouteCheck!: () => void;
    let routeCheckStarted!: () => void;
    const routeCheckGate = new Promise<void>((resolve) => {
      releaseRouteCheck = resolve;
    });
    const routeCheckEntered = new Promise<void>((resolve) => {
      routeCheckStarted = resolve;
    });
    const onPendingSwitchChanged = vi.fn();
    const { deps } = makeDeps({
      pendingSwitches,
      onPendingSwitchChanged,
      assertModelRouteUsable: vi.fn(async () => {
        routeCheckStarted();
        await routeCheckGate;
        return undefined;
      }),
    });

    const request = performSessionAgentSwitch(deps, {
      ...validParams,
      targetAgentKind: 'claude-code',
      model: 'claude-sonnet-5',
    });
    await routeCheckEntered;
    pendingSwitches.set('s1', {
      targetAgentKind: 'codex',
      model: 'gpt-5.5-codex',
      providerId: 'openai',
    });
    pendingSwitches.clear('s1');
    releaseRouteCheck();

    await expect(request).resolves.toMatchObject({
      switched: false,
      sameEngineSuperseded: true,
    });
    expect(pendingSwitches.revision?.('s1')).toBe(3);
    expect(onPendingSwitchChanged).not.toHaveBeenCalled();
  });

  it('passes the switched task to the route check so a task whose agent runs elsewhere is judged there', async () => {
    const assertModelRouteUsable = vi.fn(async () => undefined);
    const { deps } = makeDeps({ assertModelRouteUsable });
    await performSessionAgentSwitch(deps, validParams);
    expect(assertModelRouteUsable).toHaveBeenCalled();
    for (const call of assertModelRouteUsable.mock.calls as unknown[][]) {
      expect(call[3]).toBe(validParams.sessionId);
    }
  });

  it('turn 进行中抛 SESSION_RUNNING,不触碰任何状态', async () => {
    const { deps, calls } = makeDeps({
      getLiveSession: vi.fn(() => ({ isTurnRunning: () => true })),
    });
    await expect(performSessionAgentSwitch(deps, validParams)).rejects.toThrow(/SESSION_RUNNING/);
    expect(calls).toEqual([]);
  });

  it('无 live session 时跳过 close,其余照常', async () => {
    const { deps, calls } = makeDeps({ getLiveSession: vi.fn(() => null) });
    const result = await performSessionAgentSwitch(deps, validParams);
    expect(result.switched).toBe(true);
    expect(calls).toEqual(['db', 'provider', 'boundary', 'pending', 'bootstrap']);
  });

  it('边界行插入失败降级:仍设 pending 并 bootstrap,返回成功', async () => {
    const { deps, calls } = makeDeps({
      insertBoundaryMessage: vi.fn(async () => {
        throw new Error('db write failed');
      }),
    });
    const result = await performSessionAgentSwitch(deps, validParams);
    expect(result.switched).toBe(true);
    expect(calls).toEqual(['close', 'db', 'provider', 'pending', 'bootstrap']);
    expect(deps.log.warn).toHaveBeenCalled();
  });

  it('bootstrap 失败返回 engineReady=false(切换已提交,下一条消息 lazy-create 重试)', async () => {
    const { deps } = makeDeps({
      bootstrapSwitchedSession: vi.fn(async () => {
        throw new Error('spawn failed');
      }),
    });
    const result = await performSessionAgentSwitch(deps, validParams);
    expect(result).toMatchObject({ switched: true, engineReady: false });
    expect(deps.setPendingHandoff).toHaveBeenCalled();
  });

  it('DB 提交失败原样抛出,不插边界行、不设 pending', async () => {
    const { deps, calls } = makeDeps({
      applyAgentSwitchToDb: vi.fn(async () => {
        throw new Error('db locked');
      }),
    });
    await expect(performSessionAgentSwitch(deps, validParams)).rejects.toThrow('db locked');
    expect(calls).toEqual(['close']);
    expect(deps.setSessionProvider).not.toHaveBeenCalled();
  });
});

describe('deferred switch (turn running)', () => {
  function makeDepsWithPending(overrides: Partial<MakerSessionAgentSwitchHandlerDeps> = {}) {
    const base = makeDeps(overrides);
    const store = new Map<string, PendingAgentSwitchIntent>();
    base.deps.pendingSwitches = {
      set: (id, intent) => void store.set(id, intent),
      get: (id) => store.get(id),
      clear: (id) => void store.delete(id),
    };
    return { ...base, store };
  }

  it('turn 运行中登记 pending 并返回 deferred,不触碰任何状态', async () => {
    const { deps, calls, store } = makeDepsWithPending({
      getLiveSession: vi.fn(() => ({ isTurnRunning: () => true })),
    });
    const result = await performSessionAgentSwitch(deps, validParams);
    expect(result).toMatchObject({ switched: false, deferred: true, agentKind: 'codex', model: 'gpt-5.5' });
    expect(calls).toEqual([]);
    expect(store.get('s1')).toEqual({ targetAgentKind: 'codex', model: 'gpt-5.5', providerId: null });
  });

  it('意图制:空闲时外部调用同样只登记意图(不关引擎/不建交接/不插边界行)', async () => {
    const onPendingSwitchChanged = vi.fn();
    const { deps, calls, store } = makeDepsWithPending({ onPendingSwitchChanged });
    const result = await performSessionAgentSwitch(deps, {
      ...validParams,
      effort: 'xhigh',
      fastMode: true,
    });
    expect(result).toMatchObject({ switched: false, deferred: true });
    expect(calls).toEqual([]);
    expect(deps.listMessagesForHandoff).not.toHaveBeenCalled();
    expect(store.get('s1')).toEqual({
      targetAgentKind: 'codex',
      model: 'gpt-5.5',
      providerId: null,
      effort: 'xhigh',
      fastMode: true,
    });
    expect(onPendingSwitchChanged).toHaveBeenCalledWith('s1', {
      targetAgentKind: 'codex',
      model: 'gpt-5.5',
      providerId: null,
      effort: 'xhigh',
      fastMode: true,
    });
  });

  it('跨引擎意图淘汰较早的 pending credential switch', async () => {
    const supersedePendingCredentialSwitch = vi.fn();
    const { deps, store } = makeDepsWithPending({ supersedePendingCredentialSwitch });

    await performSessionAgentSwitch(deps, validParams);

    expect(supersedePendingCredentialSwitch).toHaveBeenCalledWith('s1');
    expect(store.get('s1')).toMatchObject({
      targetAgentKind: 'codex',
      model: 'gpt-5.5',
    });
  });

  it('意图制:反复改选只覆盖意图,applyNow 才执行真切换', async () => {
    const { deps, calls, store } = makeDepsWithPending();
    await performSessionAgentSwitch(deps, validParams);
    await performSessionAgentSwitch(deps, { ...validParams, model: 'gpt-5.5-codex' });
    expect(calls).toEqual([]);
    expect(store.get('s1')).toMatchObject({ model: 'gpt-5.5-codex' });
    const result = await performSessionAgentSwitch(deps, {
      ...validParams,
      model: 'gpt-5.5-codex',
      applyNow: true,
      skipBootstrap: true,
    });
    expect(result).toMatchObject({ switched: true });
    expect(calls).toEqual(['close', 'db', 'provider', 'boundary', 'pending']);
  });

  it('意图制:effort/fastMode 经意图透传到 applyAgentSwitchToDb', async () => {
    const { deps, store } = makeDepsWithPending();
    store.set('s1', {
      targetAgentKind: 'codex',
      model: 'gpt-5.5',
      providerId: 'openai',
      effort: 'high',
      fastMode: true,
    });
    await applyPendingAgentSwitchIfIdle(deps, 's1');
    expect(deps.applyAgentSwitchToDb).toHaveBeenCalledWith('s1', {
      agentKind: 'codex',
      model: 'gpt-5.5',
      providerId: 'openai',
      sdkSessionId: null,
      effort: 'high',
      fastMode: true,
    });
  });

  it('同引擎 no-op 清除已登记的 pending(用户改主意)', async () => {
    const { deps, store } = makeDepsWithPending();
    store.set('s1', { targetAgentKind: 'codex', model: 'gpt-5.5', providerId: null });
    await performSessionAgentSwitch(deps, { ...validParams, targetAgentKind: 'claude-code', model: 'claude-sonnet-5' });
    expect(store.has('s1')).toBe(false);
  });

  it('applyPendingAgentSwitchIfIdle:空闲时清 pending 并执行切换(skipBootstrap)', async () => {
    const onPendingSwitchChanged = vi.fn();
    const { deps, calls, store } = makeDepsWithPending({ onPendingSwitchChanged });
    store.set('s1', { targetAgentKind: 'codex', model: 'gpt-5.5', providerId: 'openai' });
    await applyPendingAgentSwitchIfIdle(deps, 's1');
    expect(store.has('s1')).toBe(false);
    // skipBootstrap:不含 'bootstrap'
    expect(calls).toEqual(['close', 'db', 'provider', 'boundary', 'pending']);
    expect(deps.applyAgentSwitchToDb).toHaveBeenCalledWith('s1', {
      agentKind: 'codex',
      model: 'gpt-5.5',
      providerId: 'openai',
      sdkSessionId: null,
    });
    expect(onPendingSwitchChanged).toHaveBeenLastCalledWith('s1', null);
  });

  it('只读查询返回公开 intent 投影，不泄露 resume recovery payload', async () => {
    const store = new Map<string, PendingAgentSwitchIntent>();
    store.set('s1', {
      targetAgentKind: 'codex',
      model: 'gpt-5.5',
      providerId: 'openai',
      effort: 'high',
      fastMode: true,
      resumeFallbackRecovery: {
        boundaryClientId: 'boundary-1',
        boundaryContent: {
          fromAgentKind: 'cc',
          toAgentKind: 'codex',
          fromModel: 'claude-fable-5',
          toModel: 'gpt-5.5',
          fromSdkSessionId: 'sdk-old',
          handoff: 'private recovery handoff',
        },
        handoff: 'private recovery handoff',
      },
    });
    const { deps } = makeDeps({
      pendingSwitches: {
        set: (id, intent) => void store.set(id, intent),
        get: (id) => store.get(id),
        clear: (id) => void store.delete(id),
      },
    });
    const ipc = new IpcHarness();
    registerMakerSessionAgentSwitchHandler(ipc, deps);

    await expect(ipc.invoke(MAKER_INVOKE.GET_SESSION_AGENT_SWITCH_INTENT, 's1')).resolves.toEqual({
      targetAgentKind: 'codex',
      model: 'gpt-5.5',
      providerId: 'openai',
      effort: 'high',
      fastMode: true,
    });
    await expect(ipc.invoke(MAKER_INVOKE.GET_SESSION_AGENT_SWITCH_INTENT, '')).rejects.toThrow(/INVALID_PARAMS/);
  });

  it('IPC 切换与 send / SET_MODEL 共用 session 锁', async () => {
    const withSessionLockSpy = vi.fn();
    const withSessionLock: NonNullable<MakerSessionAgentSwitchHandlerDeps['withSessionLock']> =
      async <T>(sessionId: string, task: () => Promise<T>): Promise<T> => {
        withSessionLockSpy(sessionId, task);
        return task();
      };
    const { deps } = makeDeps({ withSessionLock });
    const ipc = new IpcHarness();
    registerMakerSessionAgentSwitchHandler(ipc, deps);

    await ipc.invoke(
      MAKER_INVOKE.SWITCH_SESSION_AGENT,
      's1',
      'claude-code',
      'claude-sonnet-5',
      null,
      undefined,
      undefined,
    );

    expect(withSessionLockSpy).toHaveBeenCalledTimes(1);
    expect(withSessionLockSpy).toHaveBeenCalledWith('s1', expect.any(Function));
  });

  it('applyPendingAgentSwitchIfIdle:直发路径可要求切换后同步 bootstrap', async () => {
    const { deps, store } = makeDepsWithPending();
    store.set('s1', {
      targetAgentKind: 'codex',
      model: 'gpt-5.5-codex',
      providerId: null,
    });

    await applyPendingAgentSwitchIfIdle(deps, 's1', { bootstrapAfterSwitch: true });

    expect(deps.bootstrapSwitchedSession).toHaveBeenCalledWith('s1');
    expect(store.has('s1')).toBe(false);
  });

  it('applyPendingAgentSwitchIfIdle:turn 仍在跑时保留 pending 本次不动', async () => {
    const { deps, calls, store } = makeDepsWithPending({
      getLiveSession: vi.fn(() => ({ isTurnRunning: () => true })),
    });
    store.set('s1', { targetAgentKind: 'codex', model: 'gpt-5.5', providerId: null });
    await applyPendingAgentSwitchIfIdle(deps, 's1');
    expect(store.has('s1')).toBe(true);
    expect(calls).toEqual([]);
  });

  it('applyPendingAgentSwitchIfIdle:无 pending 时 no-op', async () => {
    const { deps, calls } = makeDepsWithPending();
    await applyPendingAgentSwitchIfIdle(deps, 's1');
    expect(calls).toEqual([]);
  });

  it('applyPendingAgentSwitchIfIdle:执行失败吞掉不抛(不阻塞发送),pending 保留供下次重试', async () => {
    const { deps, store } = makeDepsWithPending({
      applyAgentSwitchToDb: vi.fn(async () => {
        throw new Error('db locked');
      }),
    });
    store.set('s1', { targetAgentKind: 'codex', model: 'gpt-5.5', providerId: null });
    await expect(applyPendingAgentSwitchIfIdle(deps, 's1')).resolves.toBeUndefined();
    expect(store.has('s1')).toBe(true);
    expect(deps.log.warn).toHaveBeenCalled();
  });

  it('applyPendingAgentSwitchIfIdle:同 session 并发调用复用同一 in-flight,只执行一次切换', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { deps, store } = makeDepsWithPending({
      applyAgentSwitchToDb: vi.fn(async () => gate),
    });
    store.set('s1', { targetAgentKind: 'codex', model: 'gpt-5.5', providerId: null });
    const first = applyPendingAgentSwitchIfIdle(deps, 's1');
    const second = applyPendingAgentSwitchIfIdle(deps, 's1');
    expect(second).toBe(first);
    release();
    await Promise.all([first, second]);
    expect(deps.applyAgentSwitchToDb).toHaveBeenCalledTimes(1);
    expect(store.has('s1')).toBe(false);
  });

  it('applyPendingAgentSwitchIfIdle:pre-check 后 running 竞态失败仍保留 intent', async () => {
    let reads = 0;
    const { deps, store } = makeDepsWithPending({
      getLiveSession: vi.fn(() => ({ isTurnRunning: () => ++reads > 1 })),
    });
    store.set('s1', { targetAgentKind: 'codex', model: 'gpt-5.5', providerId: null });
    await applyPendingAgentSwitchIfIdle(deps, 's1');
    expect(store.has('s1')).toBe(true);
    expect(deps.applyAgentSwitchToDb).not.toHaveBeenCalled();
  });
  it('applyPendingAgentSwitchIfIdle completes the switch when abort arrives during close', async () => {
    const controller = new AbortController();
    const { deps, store, calls } = makeDepsWithPending({
      closeSession: vi.fn(async () => {
        calls.push('close');
        controller.abort();
      }),
    });
    store.set('s1', { targetAgentKind: 'codex', model: 'gpt-5.5', providerId: null });

    await applyPendingAgentSwitchIfIdle(deps, 's1', { signal: controller.signal });

    expect(calls).toEqual(['close', 'db', 'provider', 'boundary', 'pending']);
    expect(store.has('s1')).toBe(false);
  });
});

describe('SET_MODEL cancels agent switch intent only after success', () => {
  it('成功后清 main intent 并广播 renderer rollback', async () => {
    const registry = {
      set: vi.fn(),
      get: vi.fn(),
      clear: vi.fn(),
    };
    const broadcast = vi.fn();
    await expect(applySetModelThenCancelAgentSwitchIntent(
      registry,
      's1',
      async () => 'ok',
      broadcast,
    )).resolves.toBe('ok');
    expect(registry.clear).toHaveBeenCalledWith('s1');
    expect(broadcast).toHaveBeenCalledWith('s1');
  });

  it('SET_MODEL 失败时 main intent 与 renderer 乐观态都保留', async () => {
    const registry = {
      set: vi.fn(),
      get: vi.fn(),
      clear: vi.fn(),
    };
    const broadcast = vi.fn();
    await expect(applySetModelThenCancelAgentSwitchIntent(
      registry,
      's1',
      async () => { throw new Error('set model failed'); },
      broadcast,
    )).rejects.toThrow('set model failed');
    expect(registry.clear).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });
});

describe('Phase 2:切回停泊引擎(resume + 增量交接)', () => {
  const parked = { sdkSessionId: 'sdk-parked-codex', watermarkCreatedAt: 100, watermarkRowid: 7 };

  function makeResumeDeps(overrides: Partial<MakerSessionAgentSwitchHandlerDeps> = {}) {
    return makeDeps({
      findParkedEngineSession: vi.fn(async () => parked),
      listMessagesForHandoff: vi.fn(async (_sessionId: string, after?: { createdAt: number; rowid: number }) =>
        after
          ? [{ role: 'user', content: '离开期间的问题', createdAt: 200 }]
          : [
              { role: 'user', content: '最早的问题', createdAt: 1 },
              { role: 'tool_use', content: { toolUseId: 't1', toolName: 'Edit', input: { file_path: '/repo/a.ts' } }, createdAt: 2 },
              { role: 'user', content: '离开期间的问题', createdAt: 200 },
            ],
      ),
      ...overrides,
    });
  }

  it.each([false, true])('Agent recovery retains its source and blocks sending (missing boundary=%s)', async (missingBoundary) => {
    const pending = createPendingAgentSwitchRegistry();
    const { deps } = makeResumeDeps({
      pendingSwitches: pending,
      bootstrapSwitchedSession: vi.fn(async () => { throw new Error('resume unavailable'); }),
      applyResumeFallbackAtomically: vi.fn(async () => { throw new Error('transaction unavailable'); }),
      ...(missingBoundary ? { insertBoundaryMessage: vi.fn(async () => { throw new Error('boundary unavailable'); }) } : {}),
    });
    await performSessionAgentSwitch(deps, { ...validParams, runtimeSource: 'agent' });
    await expect(applyPendingAgentSwitchIfIdle(deps, 's1')).rejects.toThrow('recovery is pending');
    expect(pending.get('s1')).toMatchObject({ runtimeSource: 'agent', resumeFallbackRecovery: { boundaryClientId: missingBoundary ? null : 'boundary-client-1' } });
    await expect(applyPendingAgentSwitchIfIdle(deps, 's1')).rejects.toThrow(missingBoundary ? 'boundary unavailable' : 'transaction unavailable');
    expect(pending.get('s1')?.runtimeSource).toBe('agent');
  });

  it('consumes an Agent harness selection through the existing history handoff transaction', async () => {
    const pending = createPendingAgentSwitchRegistry();
    const { deps, calls } = makeResumeDeps({ pendingSwitches: pending });
    await performSessionAgentSwitch(deps, { ...validParams, runtimeSource: 'agent' });
    expect(calls).toEqual([]);
    await applyPendingAgentSwitchIfIdle(deps, 's1');
    expect(calls).toContain('db');
    expect(calls).toContain('boundary');
    expect(calls).toContain('bootstrap');
    expect(pending.get('s1')).toBeUndefined();
  });

  it('有停泊绑定:DB 落停泊 id、交接为增量模式、边界行标 resumed', async () => {
    const { deps } = makeResumeDeps();
    const result = await performSessionAgentSwitch(deps, validParams);
    expect(result).toMatchObject({ switched: true, engineReady: true });
    expect(deps.findParkedEngineSession).toHaveBeenCalledWith('s1', 'codex');
    expect(deps.applyAgentSwitchToDb).toHaveBeenCalledWith('s1', {
      agentKind: 'codex',
      model: 'gpt-5.5',
      providerId: null,
      sdkSessionId: 'sdk-parked-codex',
    });
    // 增量素材按水位线取
    expect(deps.listMessagesForHandoff).toHaveBeenCalledWith('s1', {
      createdAt: 100,
      rowid: 7,
    });
    const boundary = vi.mocked(deps.insertBoundaryMessage).mock.calls[0][1];
    expect(boundary.resumed).toBe(true);
    // 增量 framing(归位续接),且工作状态区来自全量历史
    expect(boundary.handoff).toContain('now it is switching back to you');
    expect(boundary.handoff).toContain('- /repo/a.ts');
    expect(boundary.handoff).not.toContain('最早的问题');
    expect(boundary.handoff).toContain('离开期间的问题');
  });

  it('无停泊绑定(查询返回 null):v1 全量行为不变', async () => {
    const { deps } = makeResumeDeps({ findParkedEngineSession: vi.fn(async () => null) });
    await performSessionAgentSwitch(deps, validParams);
    expect(deps.applyAgentSwitchToDb).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ sdkSessionId: null }),
    );
    const boundary = vi.mocked(deps.insertBoundaryMessage).mock.calls[0][1];
    expect(boundary.resumed).toBe(false);
    expect(boundary.handoff).toContain('最早的问题');
  });

  it('resume 模式无视 skipBootstrap:pending-apply 路径也 eager spawn(回落窗口)', async () => {
    const { deps, calls } = makeResumeDeps();
    await performSessionAgentSwitch(deps, { ...validParams, skipBootstrap: true });
    expect(calls).toContain('bootstrap');
  });

  it('resume bootstrap 失败:清停泊 id → 边界行改写全量交接 → fresh 重试成功', async () => {
    const bootstrap = vi
      .fn(async () => {})
      .mockRejectedValueOnce(new Error('resume transcript missing'));
    const { deps } = makeResumeDeps({ bootstrapSwitchedSession: bootstrap });
    const result = await performSessionAgentSwitch(deps, validParams);
    expect(result).toMatchObject({ switched: true, engineReady: true });
    // 同一原子事务清掉失效 id并改写边界为全量交接 + resumed:false
    const rewritten = vi.mocked(deps.applyResumeFallbackAtomically).mock.calls[0];
    expect(rewritten[1]).toBe('boundary-client-1');
    expect(rewritten[2].resumed).toBe(false);
    expect(rewritten[2].handoff).toContain('最早的问题');
    // pending 最终是全量交接
    const lastPending = vi.mocked(deps.setPendingHandoff).mock.calls.at(-1)![1];
    expect(lastPending).toContain('最早的问题');
    expect(bootstrap).toHaveBeenCalledTimes(2);
  });

  it('resume 原子回落失败:不再重试 spawn,engineReady=false 并保留完整切换意图', async () => {
    const bootstrap = vi.fn(async () => {
      throw new Error('resume transcript missing');
    });
    const store = new Map<string, Parameters<NonNullable<MakerSessionAgentSwitchHandlerDeps['pendingSwitches']>['set']>[1]>();
    const { deps } = makeResumeDeps({
      bootstrapSwitchedSession: bootstrap,
      applyResumeFallbackAtomically: vi.fn(async () => {
        throw new Error('db locked');
      }),
      pendingSwitches: {
        set: (id, intent) => void store.set(id, intent),
        get: (id) => store.get(id),
        clear: (id) => void store.delete(id),
      },
    });
    const result = await performSessionAgentSwitch(deps, { ...validParams, applyNow: true });
    expect(result).toMatchObject({ switched: true, engineReady: false, retryPending: true });
    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(store.get('s1')).toMatchObject({
      targetAgentKind: 'codex',
      model: 'gpt-5.5',
      providerId: null,
      resumeFallbackRecovery: {
        boundaryClientId: 'boundary-client-1',
        boundaryContent: { resumed: false },
      },
    });
  });

  it('resume 原子回落失败后,下一次 send 自动重试恢复并清 intent', async () => {
    const store = new Map<string, Parameters<NonNullable<MakerSessionAgentSwitchHandlerDeps['pendingSwitches']>['set']>[1]>();
    const fallback = vi
      .fn(async () => {})
      .mockRejectedValueOnce(new Error('db temporarily locked'));
    const { deps } = makeResumeDeps({
      bootstrapSwitchedSession: vi.fn(async () => { throw new Error('parked session missing'); }),
      applyResumeFallbackAtomically: fallback,
      pendingSwitches: {
        set: (id, intent) => void store.set(id, intent),
        get: (id) => store.get(id),
        clear: (id) => void store.delete(id),
      },
    });
    store.set('s1', { targetAgentKind: 'codex', model: 'gpt-5.5', providerId: null });

    await applyPendingAgentSwitchIfIdle(deps, 's1');
    expect(store.get('s1')?.resumeFallbackRecovery).toBeDefined();
    await applyPendingAgentSwitchIfIdle(deps, 's1');

    expect(fallback).toHaveBeenCalledTimes(2);
    expect(store.has('s1')).toBe(false);
    expect(deps.setPendingHandoff).toHaveBeenLastCalledWith(
      's1',
      expect.stringContaining('最早的问题'),
      undefined,
    );
  });

  it('resume 两段 bootstrap 都失败:engineReady=false,pending 为全量交接', async () => {
    const bootstrap = vi.fn(async () => {
      throw new Error('spawn failed');
    });
    const { deps } = makeResumeDeps({ bootstrapSwitchedSession: bootstrap });
    const result = await performSessionAgentSwitch(deps, validParams);
    expect(result).toMatchObject({ switched: true, engineReady: false });
    expect(bootstrap).toHaveBeenCalledTimes(2);
    const lastPending = vi.mocked(deps.setPendingHandoff).mock.calls.at(-1)![1];
    expect(lastPending).toContain('最早的问题');
  });

  it('回落覆盖走真实 registry:第二次写入不被自己先前那次的代次挡掉', async () => {
    // mock deps 的 setPendingHandoff 不带代次语义,挡不住这个回归:同一流程内第一次
    // 写入会 bump 代次,第二次若仍拿最初的代次就会被 registry 静默丢弃,引擎只剩缺
    // 早期历史的增量交接。这里接真 registry 验证最终留下的是全量交接。
    const registry = createAgentHandoffPendingRegistry(async () => null);
    const bootstrap = vi.fn(async () => {
      throw new Error('spawn failed');
    });
    const { deps } = makeResumeDeps({
      bootstrapSwitchedSession: bootstrap,
      setPendingHandoff: (sessionId, handoff, expectedGeneration) =>
        registry.set(sessionId, handoff, expectedGeneration),
      readPendingHandoffGeneration: (sessionId) => registry.readGeneration(sessionId),
    });

    await performSessionAgentSwitch(deps, validParams);

    const pending = await registry.peek('s1');
    expect(pending).toContain('最早的问题');
  });
});

describe('settleSystemRouteSwitchIntent', () => {
  const intent = { targetAgentKind: 'codex', model: 'gpt-5.5', providerId: 'openai' };

  it('reports applied once the intent is gone', () => {
    expect(
      settleSystemRouteSwitchIntent({ stagedIntent: intent, remainingIntent: undefined, sessionIdle: true }),
    ).toBe('applied');
  });

  it('keeps a post-commit resume fallback tail staged for the next message', () => {
    const recovery = { ...intent, resumeFallbackRecovery: { boundaryClientId: null } };
    expect(
      settleSystemRouteSwitchIntent({ stagedIntent: recovery, remainingIntent: recovery, sessionIdle: true }),
    ).toBe('staged');
  });

  it('treats a busy session or a superseding pick as staged', () => {
    expect(
      settleSystemRouteSwitchIntent({ stagedIntent: intent, remainingIntent: intent, sessionIdle: false }),
    ).toBe('staged');
    const newer = { ...intent, model: 'gpt-5.6' };
    expect(
      settleSystemRouteSwitchIntent({ stagedIntent: intent, remainingIntent: newer, sessionIdle: true }),
    ).toBe('staged');
  });

  it('flags a swallowed apply failure so the caller withdraws the intent', () => {
    // fail-continue 的跨引擎应用失败会把意图原样留着 —— 不能当「任务正忙」上报,
    // 否则后续消息会反复重试同一个必然失败的切换(PR #5155 review P1)。
    expect(
      settleSystemRouteSwitchIntent({ stagedIntent: intent, remainingIntent: intent, sessionIdle: true }),
    ).toBe('failed');
  });
});

describe('landed user route selection', () => {
  function pickHarness() {
    const pending = createPendingAgentSwitchRegistry();
    const landed: string[] = [];
    const { deps } = makeDeps({
      pendingSwitches: pending,
      selectSameAgentModel: async (id, choice, applyNow) => {
        if (!applyNow) {
          pending.set(id, choice);
          return { deferred: true };
        }
        return { deferred: false };
      },
      onUserRouteSelectionLanded: (id) => {
        landed.push(id);
      },
    });
    return { deps, landed };
  }

  it('reports a user pick when it lands — 同值重选也要永久脱离跟随', async () => {
    const h = pickHarness();
    // 同引擎 picker 选择(sameAgentSelection)。
    await performSessionAgentSwitch(h.deps, {
      sessionId: 's1',
      targetAgentKind: 'claude-code',
      model: 'claude-fable-5',
      providerId: 'xd',
    });
    await applyPendingAgentSwitchIfIdle(h.deps, 's1');
    expect(h.landed).toEqual(['s1']);
  });

  it('reports a cross-engine user pick but not system-staged or agent selections', async () => {
    const h = pickHarness();
    await performSessionAgentSwitch(h.deps, { ...validParams });
    await applyPendingAgentSwitchIfIdle(h.deps, 's1');
    expect(h.landed).toEqual(['s1']);

    h.landed.length = 0;
    // 系统配置对齐(IM 渠道默认跟随 / 伙伴模型对齐)的意图落地不算用户改路由。
    await performSessionAgentSwitch(h.deps, { ...validParams, configStaged: true });
    await applyPendingAgentSwitchIfIdle(h.deps, 's1');
    expect(h.landed).toEqual([]);

    // Agent 自选同样由默认变化覆盖, 不得脱离。
    await performSessionAgentSwitch(h.deps, {
      ...validParams,
      model: 'gpt-6',
      runtimeSource: 'agent',
    });
    await applyPendingAgentSwitchIfIdle(h.deps, 's1');
    expect(h.landed).toEqual([]);
  });

  it('keeps the intent when the manual-override marker cannot be persisted', async () => {
    // 同值重选的唯一证据就是墓碑: 写入失败不得把选择当成功消费 —— 意图保留、
    // 下一条消息重试(PR #5155 review P2)。
    const pending = createPendingAgentSwitchRegistry();
    const { deps } = makeDeps({
      pendingSwitches: pending,
      selectSameAgentModel: async (id, choice, applyNow) => {
        if (!applyNow) {
          pending.set(id, choice);
          return { deferred: true };
        }
        return { deferred: false };
      },
      onUserRouteSelectionLanded: async () => {
        throw new Error('db closed');
      },
    });
    await performSessionAgentSwitch(deps, {
      sessionId: 's1',
      targetAgentKind: 'claude-code',
      model: 'claude-fable-5',
      providerId: 'xd',
    });

    await expect(applyPendingAgentSwitchIfIdle(deps, 's1')).rejects.toThrow('db closed');
    expect(pending.get('s1')).toBeDefined();
  });

  it('blocks the send for a cross-engine pick too when the marker cannot be persisted', async () => {
    // 跨引擎用户意图的 fail-continue 不适用于墓碑失败: 发送继续 + 进程退出会把
    // 同值重选的唯一证据一起丢掉(PR #5155 review P2)。
    const pending = createPendingAgentSwitchRegistry();
    const { deps } = makeDeps({
      pendingSwitches: pending,
      onUserRouteSelectionLanded: async () => {
        throw new Error('db closed');
      },
    });
    await performSessionAgentSwitch(deps, { ...validParams });

    await expect(applyPendingAgentSwitchIfIdle(deps, 's1')).rejects.toThrow('db closed');
    expect(pending.get('s1')).toBeDefined();
  });
});

describe('远程 Agent:选模型时换 Agent 所在电脑', () => {
  function relocationHarness(rowOverrides: Partial<AgentSwitchSessionRow> = {}) {
    const pending = createPendingAgentSwitchRegistry();
    const row = makeRow({ agentDeviceId: 'studio-mac', providerId: 'anthropic', ...rowOverrides });
    const selectSameAgentModel = vi.fn(async (id: string, intent: PendingAgentSwitchIntent) => {
      pending.set(id, intent);
      return { deferred: true };
    });
    const assertAgentDeviceRouteUsable = vi.fn(async () => undefined);
    const findParkedEngineSession = vi.fn(async () => ({
      sdkSessionId: 'sdk-parked',
      watermarkCreatedAt: 1,
      watermarkRowid: 1,
    }));
    const { deps, calls } = makeDeps({
      pendingSwitches: pending,
      getSessionRow: vi.fn(async () => row),
      selectSameAgentModel,
      assertAgentDeviceRouteUsable,
      findParkedEngineSession,
      describeAgentDevice: (deviceId) => (deviceId ? 'Studio Mac' : 'Office PC'),
    });
    return { deps, calls, pending, selectSameAgentModel, assertAgentDeviceRouteUsable, findParkedEngineSession };
  }

  const backToTaskComputer = {
    sessionId: 's1',
    targetAgentKind: 'claude-code',
    model: 'anthropic/claude-opus-5-5[1m]',
    providerId: 'xd',
    agentDeviceId: null,
  };

  it('同引擎改回任务所在电脑:登记带位置的完整切换意图,不走同引擎换模型', async () => {
    const h = relocationHarness();
    const result = await performSessionAgentSwitch(h.deps, backToTaskComputer);
    expect(result).toMatchObject({ deferred: true, switched: false });
    expect(h.selectSameAgentModel).not.toHaveBeenCalled();
    // 改回本机不需要问那台电脑。
    expect(h.assertAgentDeviceRouteUsable).not.toHaveBeenCalled();
    expect(h.pending.get('s1')).toMatchObject({ model: 'anthropic/claude-opus-5-5[1m]', targetAgentDeviceId: null });
    expect(h.calls).toEqual([]);
  });

  it('发送时落地:全量交接、不续接停泊会话、写入新位置并在分隔条记下两台电脑', async () => {
    const h = relocationHarness();
    await performSessionAgentSwitch(h.deps, backToTaskComputer);
    await applyPendingAgentSwitchIfIdle(h.deps, 's1');

    expect(h.findParkedEngineSession).not.toHaveBeenCalled();
    expect(h.calls).toEqual(['close', 'db', 'provider', 'boundary', 'pending']);
    expect(h.deps.applyAgentSwitchToDb).toHaveBeenCalledWith('s1', expect.objectContaining({
      agentKind: 'cc',
      model: 'anthropic/claude-opus-5-5[1m]',
      providerId: 'xd',
      sdkSessionId: null,
      agentDeviceId: null,
    }));
    const boundary = vi.mocked(h.deps.insertBoundaryMessage).mock.calls[0][1];
    expect(boundary).toMatchObject({
      fromAgentKind: 'cc',
      toAgentKind: 'cc',
      fromAgentDeviceId: 'studio-mac',
      toAgentDeviceId: null,
      fromAgentDeviceName: 'Studio Mac',
      toAgentDeviceName: 'Office PC',
      resumed: false,
    });
    expect(boundary.handoff).toContain('Claude Code (on a different computer)');
    expect(boundary).not.toHaveProperty('switchReason');
    expect(h.pending.get('s1')).toBeUndefined();
  });

  it('供应商组按用户确认、为了先用那台的配额换电脑：分隔条写明原因(provider-groups.md §6.2)', async () => {
    const h = relocationHarness();
    await performSessionAgentSwitch(h.deps, {
      ...backToTaskComputer,
      applyNow: true,
      providerGroupRelocation: true,
      providerGroupSwitchReason: 'quota-rebalance',
    });
    expect(vi.mocked(h.deps.insertBoundaryMessage).mock.calls[0][1]).toMatchObject({
      fromAgentDeviceId: 'studio-mac',
      toAgentDeviceId: null,
      switchReason: 'quota-rebalance',
    });
  });

  it('挪到另一台电脑:登记前与落地前都按那台的目录校验', async () => {
    const h = relocationHarness({ agentDeviceId: null, providerId: 'xd' });
    await performSessionAgentSwitch(h.deps, {
      ...backToTaskComputer,
      model: 'claude-opus-5-5',
      providerId: 'anthropic',
      agentDeviceId: 'studio-mac',
    });
    expect(h.assertAgentDeviceRouteUsable).toHaveBeenCalledWith('studio-mac', 'claude-code', 'claude-opus-5-5', 'anthropic');
    expect(h.pending.get('s1')).toMatchObject({ targetAgentDeviceId: 'studio-mac' });

    await applyPendingAgentSwitchIfIdle(h.deps, 's1');
    expect(h.assertAgentDeviceRouteUsable).toHaveBeenCalledTimes(2);
    expect(h.deps.applyAgentSwitchToDb).toHaveBeenCalledWith('s1', expect.objectContaining({ agentDeviceId: 'studio-mac' }));
  });

  it('那台电脑没有这个模型:选择时直接拒绝,不留意图', async () => {
    const h = relocationHarness({ agentDeviceId: null });
    h.assertAgentDeviceRouteUsable.mockRejectedValueOnce(new Error('not offered'));
    await expect(performSessionAgentSwitch(h.deps, {
      ...backToTaskComputer,
      agentDeviceId: 'studio-mac',
    })).rejects.toThrow('not offered');
    expect(h.pending.get('s1')).toBeUndefined();
  });

  it('不带位置(旧控制端 / 内部调用)保持原位置,同引擎仍走换模型', async () => {
    const h = relocationHarness();
    const { agentDeviceId: _omit, ...withoutLocation } = backToTaskComputer;
    await performSessionAgentSwitch(h.deps, withoutLocation);
    expect(h.selectSameAgentModel).toHaveBeenCalledTimes(1);
    expect(h.pending.get('s1')?.targetAgentDeviceId).toBeUndefined();
  });

  it('换位置在发送时失败:挡住这次发送并保留意图,不悄悄留在原来那台继续', async () => {
    const h = relocationHarness({ agentDeviceId: null });
    await performSessionAgentSwitch(h.deps, { ...backToTaskComputer, agentDeviceId: 'studio-mac' });
    h.assertAgentDeviceRouteUsable.mockRejectedValueOnce(new Error('offline'));
    await expect(applyPendingAgentSwitchIfIdle(h.deps, 's1')).rejects.toThrow('offline');
    expect(h.pending.get('s1')).toMatchObject({ targetAgentDeviceId: 'studio-mac' });
    expect(h.calls).toEqual([]);
  });

  it('供应商组替分享的人换电脑:位置不变也强制全量交接、新建会话,分隔条不写电脑名', async () => {
    const h = relocationHarness({ agentDeviceId: 'share:alice-share', providerId: 'alice-anthropic' });
    const result = await performSessionAgentSwitch(h.deps, {
      sessionId: 's1',
      targetAgentKind: 'claude-code',
      model: 'anthropic/claude-opus-5-5[1m]',
      providerId: 'alice-anthropic',
      agentDeviceId: 'share:alice-share',
      applyNow: true,
      forceRelocation: true,
    });
    expect(result).toMatchObject({ switched: true });
    expect(h.selectSameAgentModel).not.toHaveBeenCalled();
    expect(h.findParkedEngineSession).not.toHaveBeenCalled();
    expect(h.assertAgentDeviceRouteUsable).toHaveBeenCalledWith('share:alice-share', 'claude-code', 'anthropic/claude-opus-5-5[1m]', 'alice-anthropic');
    expect(h.deps.applyAgentSwitchToDb).toHaveBeenCalledWith('s1', expect.objectContaining({ sdkSessionId: null }));
    const boundary = vi.mocked(h.deps.insertBoundaryMessage).mock.calls[0][1];
    expect(boundary).toMatchObject({
      fromAgentDeviceId: 'share:alice-share',
      toAgentDeviceId: 'share:alice-share',
      fromAgentDeviceName: null,
      toAgentDeviceName: null,
      resumed: false,
    });
    expect(boundary.handoff).toContain('Claude Code (on a different computer)');
  });

  it('强制换电脑只认内部立即执行:选择器登记与任务所在电脑上的任务都不受影响', async () => {
    const staged = relocationHarness({ agentDeviceId: 'share:alice-share' });
    await performSessionAgentSwitch(staged.deps, {
      ...backToTaskComputer,
      agentDeviceId: 'share:alice-share',
      forceRelocation: true,
    });
    expect(staged.selectSameAgentModel).toHaveBeenCalledTimes(1);
    expect(staged.calls).toEqual([]);

    const local = relocationHarness({ agentDeviceId: null });
    const result = await performSessionAgentSwitch(local.deps, {
      ...backToTaskComputer,
      applyNow: true,
      forceRelocation: true,
    });
    expect(result).toMatchObject({ switched: false });
    expect(local.deps.insertBoundaryMessage).not.toHaveBeenCalled();
  });

  it.each(['lead', 'worker'])('协同任务 %s:用户换电脑与普通任务一样登记意图,发送时落地', async (orcaRole) => {
    const h = relocationHarness({ orcaRole, agentDeviceId: null, providerId: 'xd' });
    await performSessionAgentSwitch(h.deps, {
      ...backToTaskComputer,
      model: 'claude-opus-5-5',
      providerId: 'anthropic',
      agentDeviceId: 'share:alice-share',
    });
    expect(h.selectSameAgentModel).not.toHaveBeenCalled();
    expect(h.assertAgentDeviceRouteUsable).toHaveBeenCalledWith('share:alice-share', 'claude-code', 'claude-opus-5-5', 'anthropic');
    expect(h.pending.get('s1')).toMatchObject({ targetAgentDeviceId: 'share:alice-share' });

    await applyPendingAgentSwitchIfIdle(h.deps, 's1');
    expect(h.deps.applyAgentSwitchToDb).toHaveBeenCalledWith('s1', expect.objectContaining({
      agentDeviceId: 'share:alice-share',
      sdkSessionId: null,
    }));
    expect(h.pending.get('s1')).toBeUndefined();
  });

  it('协同任务:供应商组内部的立即换位置照常可用(同引擎同模型)', async () => {
    const lead = relocationHarness({ orcaRole: 'lead', model: 'anthropic/claude-opus-5-5[1m]' });
    const result = await performSessionAgentSwitch(lead.deps, {
      ...backToTaskComputer,
      providerId: 'anthropic',
      agentDeviceId: 'office-pc',
      applyNow: true,
      providerGroupRelocation: true,
    });
    expect(result).toMatchObject({ switched: true });
    expect(lead.deps.applyAgentSwitchToDb).toHaveBeenCalledWith('s1', expect.objectContaining({
      agentDeviceId: 'office-pc',
      model: 'anthropic/claude-opus-5-5[1m]',
      sdkSessionId: null,
    }));

    const worker = relocationHarness({ orcaRole: 'worker', model: 'anthropic/claude-opus-5-5[1m]' });
    await expect(performSessionAgentSwitch(worker.deps, {
      ...backToTaskComputer,
      agentDeviceId: 'office-pc',
      applyNow: true,
      providerGroupRelocation: true,
    })).resolves.toMatchObject({ switched: true });
  });

  it.each([
    { orcaRole: null, orcaRemoteLead: JSON.stringify({ leadDeviceId: 'lead-device', leadSessionId: 'lead-1', workerLabel: 'worker' }) },
    { orcaRole: null, orcaRemoteLead: JSON.stringify({ leadDeviceId: 'lead-device', leadSessionId: 'lead-1', workerLabel: 'worker', releasedAt: 1 }) },
  ])('execution-device Worker rejects user relocation while preserving harness/model selection: %j', async (identity) => {
    const row = { ...identity, model: 'anthropic/claude-opus-5-5[1m]' };
    const { agentDeviceId: _omit, ...withoutLocation } = backToTaskComputer;
    const userMove = relocationHarness(row);
    await expect(performSessionAgentSwitch(userMove.deps, { ...backToTaskComputer, agentDeviceId: 'office-pc' }))
      .rejects.toThrow(/UNSUPPORTED_CAPABILITY/);
    const staged = relocationHarness(row);
    await expect(performSessionAgentSwitch(staged.deps, {
      ...backToTaskComputer,
      agentDeviceId: 'office-pc',
      providerGroupRelocation: true,
    })).rejects.toThrow(/UNSUPPORTED_CAPABILITY/);
    const otherModel = relocationHarness(row);
    await expect(performSessionAgentSwitch(otherModel.deps, {
      ...withoutLocation,
      model: 'claude-sonnet-5',
      applyNow: true,
    })).resolves.toMatchObject({ switched: false });
    const otherEngine = relocationHarness(row);
    await expect(performSessionAgentSwitch(otherEngine.deps, {
      ...withoutLocation,
      targetAgentKind: 'codex',
      applyNow: true,
      })).resolves.toMatchObject({ switched: true });
    expect(userMove.calls).toEqual([]);
    expect(staged.calls).toEqual([]);
  });

  // PR #6830 merge regression, unit: the scheduled entry materialized inherited
  // null and turned a same-computer Harness switch into a forbidden Worker move.
  // Earlier tests entered the handoff directly. Exercise both production entries;
  // an actual location change must still fail before runtime or database mutation.
  it.each([undefined, null, 'office-pc'])('scheduled execution-device Worker keeps its location boundary: %j', async (agentDeviceId) => {
    const h = relocationHarness({ agentDeviceId: null, orcaRole: null,
      orcaRemoteLead: JSON.stringify({ leadDeviceId: 'lead-device', leadSessionId: 'lead-1', workerLabel: 'worker' }),
    });
    const choice: ScheduledModelSelection = { agentKind: 'codex', agentDeviceId,
      model: 'gpt-5.5', providerId: 'openai', effort: null, fastMode: false };
    const applyModel = vi.fn(async () => {});
    const result = applyScheduledModelSelection(choice, {
      getTarget: async () => ({ agentKind: 'claude-code', agentDeviceId: null, status: 'active' }),
      isBusy: () => false,
      resolveSelection: async (value) => value,
      switchHarness: (value) => performSessionAgentSwitch({ ...h.deps, pendingSwitches: undefined }, {
        sessionId: 's1', targetAgentKind: value.agentKind, model: value.model,
        agentDeviceId: value.agentDeviceId, providerId: value.providerId,
        effort: value.effort, fastMode: value.fastMode, applyNow: true, configStaged: true,
      }),
      applyModel,
    });
    if (agentDeviceId) {
      await expect(result).rejects.toThrow(/UNSUPPORTED_CAPABILITY/);
      expect(h.calls).toEqual([]);
      expect(applyModel).not.toHaveBeenCalled();
    } else {
      await expect(result).resolves.toMatchObject({ agentKind: 'codex', agentDeviceId: null });
      expect(h.deps.applyAgentSwitchToDb).toHaveBeenCalledWith('s1', expect.objectContaining({ agentKind: 'codex' }));
      expect(applyModel).toHaveBeenCalledWith(expect.objectContaining({ agentKind: 'codex', agentDeviceId: null }));
    }
  });

  it('协同 Lead 离开远程电脑:关闭旧远程会话遇链路错误仍提交新位置', async () => {
    const linkError = Object.assign(
      new Error('[REMOTE_AGENT_UNAVAILABLE] [DEVICE_LINK_DEVICE_OFFLINE] target offline'),
      { code: 'DEVICE_OFFLINE' },
    );
    const applyNow = relocationHarness({ orcaRole: 'lead', agentDeviceId: 'office-pc' });
    vi.mocked(applyNow.deps.closeSession).mockImplementationOnce(async () => {
      applyNow.calls.push('close');
      throw linkError;
    });
    await expect(
      performSessionAgentSwitch(applyNow.deps, { ...backToTaskComputer, applyNow: true }),
    ).resolves.toMatchObject({ switched: true });
    expect(applyNow.deps.applyAgentSwitchToDb).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ agentDeviceId: null }),
    );
    expect(applyNow.deps.bootstrapSwitchedSession).toHaveBeenCalledWith('s1');
    expect(applyNow.deps.log.warn).toHaveBeenCalledWith(
      expect.stringMatching(/returning|home|close/i),
      expect.objectContaining({ sessionId: 's1', code: expect.any(String) }),
    );
    expect(applyNow.calls).toEqual(['close', 'db', 'provider', 'boundary', 'pending', 'bootstrap']);

    const pending = relocationHarness({ orcaRole: 'lead', agentDeviceId: 'office-pc' });
    await performSessionAgentSwitch(pending.deps, backToTaskComputer);
    vi.mocked(pending.deps.closeSession).mockImplementationOnce(async () => {
      pending.calls.push('close');
      throw linkError;
    });
    await expect(applyPendingAgentSwitchIfIdle(pending.deps, 's1')).resolves.toBeUndefined();
    expect(pending.deps.applyAgentSwitchToDb).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ agentDeviceId: null }),
    );
    expect(pending.pending.get('s1')).toBeUndefined();
  });

  it('协同 Lead 离开远程电脑:关闭失败非链路类仍中止且不写库', async () => {
    const h = relocationHarness({ orcaRole: 'lead', agentDeviceId: 'office-pc' });
    vi.mocked(h.deps.closeSession).mockImplementationOnce(async () => {
      h.calls.push('close');
      throw new Error('[REMOTE_AGENT_PEER_TOO_OLD] Cindy on the other computer is too old');
    });
    await expect(
      performSessionAgentSwitch(h.deps, { ...backToTaskComputer, applyNow: true }),
    ).rejects.toThrow(/REMOTE_AGENT_PEER_TOO_OLD/);
    expect(h.deps.applyAgentSwitchToDb).not.toHaveBeenCalled();
    expect(h.calls).toEqual(['close']);

    const unavailable = relocationHarness({ orcaRole: 'lead', agentDeviceId: 'office-pc' });
    vi.mocked(unavailable.deps.closeSession).mockRejectedValueOnce(
      new Error('[REMOTE_AGENT_UNAVAILABLE] the agent did not start on that computer'),
    );
    await expect(
      performSessionAgentSwitch(unavailable.deps, { ...backToTaskComputer, applyNow: true }),
    ).rejects.toThrow(/REMOTE_AGENT_UNAVAILABLE/);
    expect(unavailable.deps.applyAgentSwitchToDb).not.toHaveBeenCalled();
  });

  it.each([
    ['DEVICE_OFFLINE', 'target device offline'],
    ['INVOKE_TIMEOUT', 'invoke timed out'],
    ['DEVICE_UNRESPONSIVE', 'device unresponsive'],
    ['NOT_CONNECTED', 'not connected'],
    ['LINK_NOT_OPEN', 'link not open'],
    ['PEER_RESET', 'peer reset'],
    ['BACKPRESSURE', 'request expired before socket write within 10000ms'],
  ] as const)('协同 Lead 离开远程电脑:remoteAgentLinkError(%s) 后仍提交新位置', async (code, message) => {
    const wrapped = remoteAgentLinkError(Object.assign(new Error(message), { code }));
    const h = relocationHarness({ orcaRole: 'lead', agentDeviceId: 'office-pc' });
    vi.mocked(h.deps.closeSession).mockImplementationOnce(async () => {
      h.calls.push('close');
      throw wrapped;
    });
    await expect(
      performSessionAgentSwitch(h.deps, { ...backToTaskComputer, applyNow: true }),
    ).resolves.toMatchObject({ switched: true });
    expect(h.deps.applyAgentSwitchToDb).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ agentDeviceId: null }),
    );
    expect(h.deps.log.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(h.deps.log.warn).mock.calls[0][1]).toEqual({ sessionId: 's1', code });
  });

  it.each([
    ['REMOTE_DISABLED', 'remote control is disabled'],
    ['CHANNEL_NOT_ALLOWED', "channel 'remote-agent' not allowed remotely"],
    ['ACCESS_REVOKED', 'access revoked'],
    ['VERSION_MISMATCH', 'version mismatch'],
    [undefined, '[REMOTE_AGENT_UNAVAILABLE] the agent did not start on that computer'],
    ['TIMEOUT', 'local timeout'],
  ] as const)('协同 Lead 离开远程电脑:非链路码 %s 仍中止且不写库', async (code, message) => {
    const wrapped = code === undefined
      ? new Error(message)
      : remoteAgentLinkError(Object.assign(new Error(message), { code }));
    const h = relocationHarness({ orcaRole: 'lead', agentDeviceId: 'office-pc' });
    vi.mocked(h.deps.closeSession).mockImplementationOnce(async () => {
      throw wrapped;
    });
    await expect(
      performSessionAgentSwitch(h.deps, { ...backToTaskComputer, applyNow: true }),
    ).rejects.toBeDefined();
    expect(h.deps.applyAgentSwitchToDb).not.toHaveBeenCalled();
  });

  it('普通任务关闭旧远程会话遇链路错误仍中止', async () => {
    const wrapped = remoteAgentLinkError(
      Object.assign(new Error('request expired before socket write within 10000ms'), { code: 'BACKPRESSURE' }),
    );
    const h = relocationHarness({ agentDeviceId: 'office-pc' });
    vi.mocked(h.deps.closeSession).mockImplementationOnce(async () => {
      throw wrapped;
    });
    await expect(
      performSessionAgentSwitch(h.deps, { ...backToTaskComputer, applyNow: true }),
    ).rejects.toThrow(/BACKPRESSURE|REMOTE_AGENT_UNAVAILABLE/);
    expect(h.deps.applyAgentSwitchToDb).not.toHaveBeenCalled();
  });

  it('协同 Worker 关闭旧远程会话遇链路错误仍中止(容错只给 Lead)', async () => {
    const wrapped = remoteAgentLinkError(
      Object.assign(new Error('target device offline'), { code: 'DEVICE_OFFLINE' }),
    );
    const h = relocationHarness({ orcaRole: 'worker', agentDeviceId: 'office-pc' });
    vi.mocked(h.deps.closeSession).mockImplementationOnce(async () => {
      throw wrapped;
    });
    await expect(
      performSessionAgentSwitch(h.deps, { ...backToTaskComputer, applyNow: true }),
    ).rejects.toThrow(/REMOTE_AGENT_UNAVAILABLE|offline/);
    expect(h.deps.applyAgentSwitchToDb).not.toHaveBeenCalled();
  });

  it('非法位置参数被拒绝', async () => {
    const h = relocationHarness();
    await expect(performSessionAgentSwitch(h.deps, { ...backToTaskComputer, agentDeviceId: 'bad id!' }))
      .rejects.toThrow(/INVALID_PARAMS/);
    await expect(performSessionAgentSwitch(h.deps, { ...backToTaskComputer, agentDeviceId: 42 }))
      .rejects.toThrow(/INVALID_PARAMS/);
  });

  it('IPC 第 7 参带位置透传;意图投影带上位置', async () => {
    const h = relocationHarness();
    const ipc = new IpcHarness();
    registerMakerSessionAgentSwitchHandler(ipc, h.deps);
    await ipc.invoke(
      MAKER_INVOKE.SWITCH_SESSION_AGENT,
      's1', 'claude-code', 'anthropic/claude-opus-5-5[1m]', 'xd', undefined, undefined,
      { agentDeviceId: null },
    );
    await expect(ipc.invoke(MAKER_INVOKE.GET_SESSION_AGENT_SWITCH_INTENT, 's1')).resolves.toMatchObject({
      model: 'anthropic/claude-opus-5-5[1m]',
      agentDeviceId: null,
    });
  });

  it('passes a local window acknowledgement to same-Agent selection but rejects remote claims', async () => {
    const h = relocationHarness({ orcaRole: 'worker', agentDeviceId: null });
    const ipc = new IpcHarness();
    registerMakerSessionAgentSwitchHandler(ipc, h.deps);
    const select = (confirmedContextWindow: unknown) => ipc.invoke(MAKER_INVOKE.SWITCH_SESSION_AGENT,
      's1', 'claude-code', 'small-model', 'xd', 'high', false, { confirmedContextWindow });
    await select(200000);
    expect(h.pending.get('s1')?.confirmedContextWindow).toBe(200000);
    await expect(runDeviceLinkInvokeContext({ controllerDeviceId: 'controller', channel: MAKER_INVOKE.SWITCH_SESSION_AGENT },
      () => select(100000))).rejects.toThrow(/PRECONDITION_FAILED/);
    for (const invalid of [0, -1, 1.5, Number.NaN, '200000']) {
      await expect(select(invalid)).rejects.toThrow(/INVALID_PARAMS/);
    }
    expect(h.pending.get('s1')?.confirmedContextWindow).toBe(200000);
  });
});

describe('换到供应商组那一项：由组选一台能用的电脑(provider-groups.md §6)', () => {
  function groupHarness(resolve: MakerSessionAgentSwitchHandlerDeps['resolveProviderGroupTarget']) {
    const pending = createPendingAgentSwitchRegistry();
    const row = makeRow({ agentDeviceId: null, providerId: 'xd' });
    const resolveProviderGroupTarget = vi.fn(resolve);
    const { deps } = makeDeps({
      pendingSwitches: pending,
      getSessionRow: vi.fn(async () => row),
      assertAgentDeviceRouteUsable: vi.fn(async () => undefined),
      resolveProviderGroupTarget,
    });
    return { deps, pending, resolveProviderGroupTarget };
  }
  const toGroup = {
    sessionId: 's1',
    targetAgentKind: 'claude-code',
    model: 'claude-opus-5-5',
    providerId: 'anthropic',
    agentDeviceId: 'group-host',
  };

  it('登记时不选，发送时按组此刻的状态选一台，换到那台', async () => {
    const h = groupHarness(async () => ({ agentDeviceId: 'office-pc', providerId: 'anthropic-2' }));
    await performSessionAgentSwitch(h.deps, toGroup);
    expect(h.resolveProviderGroupTarget).not.toHaveBeenCalled();
    expect(h.pending.get('s1')).toMatchObject({ targetAgentDeviceId: 'group-host' });

    await applyPendingAgentSwitchIfIdle(h.deps, 's1');
    expect(h.resolveProviderGroupTarget).toHaveBeenCalledWith('s1', {
      agentKind: 'claude-code',
      model: 'claude-opus-5-5',
      providerId: 'anthropic',
      agentDeviceId: 'group-host',
      current: { agentDeviceId: null, providerId: 'xd' },
    });
    expect(h.deps.applyAgentSwitchToDb).toHaveBeenCalledWith('s1', expect.objectContaining({
      agentDeviceId: 'office-pc',
      providerId: 'anthropic-2',
    }));
    expect(h.pending.get('s1')).toBeUndefined();
  });

  it('不是组那一项时照用户选的位置换', async () => {
    const h = groupHarness(async () => null);
    await performSessionAgentSwitch(h.deps, toGroup);
    await applyPendingAgentSwitchIfIdle(h.deps, 's1');
    expect(h.deps.applyAgentSwitchToDb).toHaveBeenCalledWith('s1', expect.objectContaining({
      agentDeviceId: 'group-host',
      providerId: 'anthropic',
    }));
  });

  it('绑定保存失败不重放已提交的跨电脑切换，仍保留交接并消费意图', async () => {
    const commitBinding = vi.fn(async () => { throw new Error('binding file lock timeout'); });
    const h = groupHarness(async () => ({ agentDeviceId: 'office-pc', providerId: 'anthropic-2', commitBinding }));
    await performSessionAgentSwitch(h.deps, toGroup);
    await expect(applyPendingAgentSwitchIfIdle(h.deps, 's1', { bootstrapAfterSwitch: true })).resolves.toBeUndefined();
    expect(h.deps.applyAgentSwitchToDb).toHaveBeenCalledTimes(1);
    expect(h.deps.insertBoundaryMessage).toHaveBeenCalledWith('s1', expect.objectContaining({
      fromAgentDeviceId: null, toAgentDeviceId: 'office-pc', handoff: expect.stringContaining('你好'),
    }));
    expect(h.deps.setPendingHandoff).toHaveBeenCalledWith('s1', expect.stringContaining('你好'), undefined);
    expect(h.deps.bootstrapSwitchedSession).toHaveBeenCalledTimes(1);
    expect(h.pending.get('s1')).toBeUndefined();
    expect(h.deps.log.warn).toHaveBeenCalledWith(
      'agent-switch: provider group binding save failed after switch committed',
      { sessionId: 's1', err: 'binding file lock timeout' },
    );
    await applyPendingAgentSwitchIfIdle(h.deps, 's1');
    expect(h.deps.applyAgentSwitchToDb).toHaveBeenCalledTimes(1);
    expect(commitBinding).toHaveBeenCalledTimes(1);
  });

  it('切换提交失败时不写组绑定，保留选择等待重试', async () => {
    const commitBinding = vi.fn(async () => undefined);
    const h = groupHarness(async () => ({ agentDeviceId: 'office-pc', providerId: 'anthropic-2', commitBinding }));
    vi.mocked(h.deps.applyAgentSwitchToDb).mockRejectedValueOnce(new Error('db write failed'));
    await performSessionAgentSwitch(h.deps, toGroup);
    await expect(applyPendingAgentSwitchIfIdle(h.deps, 's1')).rejects.toThrow('db write failed');
    expect(commitBinding).not.toHaveBeenCalled();
    expect(h.pending.get('s1')).toBeDefined();
    expect(h.deps.setPendingHandoff).not.toHaveBeenCalled();
  });

  it('组选回当前位置：模型已应用后绑定失败不保留或重放选择', async () => {
    const commitBinding = vi.fn(async () => { throw new Error('disk write failed'); });
    const h = groupHarness(async () => ({ agentDeviceId: null, providerId: 'xd', commitBinding }));
    const select = vi.fn(async () => ({ deferred: false }));
    h.deps.selectSameAgentModel = select;
    await performSessionAgentSwitch(h.deps, toGroup);
    await applyPendingAgentSwitchIfIdle(h.deps, 's1');
    expect(h.pending.get('s1')).toBeUndefined();
    await applyPendingAgentSwitchIfIdle(h.deps, 's1');
    expect(select).toHaveBeenCalledTimes(1);
    expect(commitBinding).toHaveBeenCalledTimes(1);
    expect(h.deps.applyAgentSwitchToDb).not.toHaveBeenCalled();
  });

  it('组里都不能用：不换、不发，意图留着', async () => {
    const h = groupHarness(async () => {
      throw new Error('[REMOTE_AGENT_GROUP_UNAVAILABLE] no computer in the provider group can run this task right now');
    });
    await performSessionAgentSwitch(h.deps, toGroup);
    await expect(applyPendingAgentSwitchIfIdle(h.deps, 's1')).rejects.toThrow('REMOTE_AGENT_GROUP_UNAVAILABLE');
    expect(h.deps.applyAgentSwitchToDb).not.toHaveBeenCalled();
    expect(h.pending.get('s1')).toBeDefined();
  });

  it('供应商组自己换电脑时不再经组选一次', async () => {
    const h = groupHarness(async () => ({ agentDeviceId: 'office-pc', providerId: 'anthropic-2' }));
    await performSessionAgentSwitch(h.deps, { ...toGroup, applyNow: true, providerGroupRelocation: true });
    expect(h.resolveProviderGroupTarget).not.toHaveBeenCalled();
  });

  it('组把这次换电脑选回了当前位置时，新模型还是要落地，不能被同引擎同位置的 no-op 悄悄丢弃(greptile-apps P1, PR #5792 review)', async () => {
    const pending = createPendingAgentSwitchRegistry();
    const row = makeRow({ agentKind: 'cc', model: 'claude-fable-5', providerId: 'xd', agentDeviceId: null });
    const selectSameAgentModel = vi.fn(async (_id: string, intent: PendingAgentSwitchIntent) => {
      row.model = intent.model;
      row.providerId = intent.providerId ?? null;
      return { deferred: false };
    });
    const resolveProviderGroupTarget = vi.fn(async () => ({ agentDeviceId: null, providerId: 'xd' }));
    const { deps } = makeDeps({
      pendingSwitches: pending,
      getSessionRow: vi.fn(async () => row),
      assertAgentDeviceRouteUsable: vi.fn(async () => undefined),
      resolveProviderGroupTarget,
      selectSameAgentModel,
    });
    const toGroupNewModel = {
      sessionId: 's1',
      targetAgentKind: 'claude-code' as const,
      model: 'claude-opus-5-5',
      providerId: 'anthropic',
      agentDeviceId: 'group-host',
    };
    await performSessionAgentSwitch(deps, toGroupNewModel);
    expect(pending.get('s1')).toMatchObject({ model: 'claude-opus-5-5', targetAgentDeviceId: 'group-host' });

    await applyPendingAgentSwitchIfIdle(deps, 's1');
    expect(resolveProviderGroupTarget).toHaveBeenCalledWith('s1', expect.objectContaining({ agentDeviceId: 'group-host' }));
    // 组把位置选回了当前电脑(agentDeviceId: null)，但这次提交要落地的是新模型；必须走过
    // selectSameAgentModel 真正应用，不能让 performSessionAgentSwitch 内部的 no-op 分支将其丢弃。
    // chosen.providerId 是组按它自己状态选定的（本例仍是 'xd'，和用户点选的 'anthropic' 不同），
    // 重点是新模型必须走过 selectSameAgentModel 真正落地。
    expect(selectSameAgentModel).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ model: 'claude-opus-5-5', providerId: 'xd' }),
      true,
      undefined,
      undefined,
    );
    expect(row.model).toBe('claude-opus-5-5');
    expect(pending.get('s1')).toBeUndefined();
  });

  it.each(['lead', 'worker'])('协同任务 %s:组选回当前位置时按交接重建,不走需要点选窗口确认的原地换模型', async (orcaRole) => {
    const pending = createPendingAgentSwitchRegistry();
    const row = makeRow({ agentKind: 'cc', model: 'claude-fable-5', providerId: 'xd', agentDeviceId: null, orcaRole });
    const selectSameAgentModel = vi.fn(async () => ({ deferred: false }));
    const commitBinding = vi.fn(async () => undefined);
    const { deps } = makeDeps({
      pendingSwitches: pending,
      getSessionRow: vi.fn(async () => row),
      assertAgentDeviceRouteUsable: vi.fn(async () => undefined),
      resolveProviderGroupTarget: vi.fn(async () => ({ agentDeviceId: null, providerId: 'xd', commitBinding })),
      selectSameAgentModel,
    });
    await performSessionAgentSwitch(deps, { ...toGroup, model: 'claude-haiku-5-5' });
    await applyPendingAgentSwitchIfIdle(deps, 's1');

    expect(selectSameAgentModel).not.toHaveBeenCalled();
    expect(deps.applyAgentSwitchToDb).toHaveBeenCalledWith('s1', expect.objectContaining({
      model: 'claude-haiku-5-5',
      providerId: 'xd',
      sdkSessionId: null,
    }));
    expect(deps.applyAgentSwitchToDb).not.toHaveBeenCalledWith('s1', expect.objectContaining({ agentDeviceId: expect.anything() }));
    expect(deps.insertBoundaryMessage).toHaveBeenCalledWith('s1', expect.objectContaining({
      fromModel: 'claude-fable-5',
      toModel: 'claude-haiku-5-5',
      resumed: false,
    }));
    expect(deps.setPendingHandoff).toHaveBeenCalledTimes(1);
    expect(commitBinding).toHaveBeenCalledTimes(1);
    expect(pending.get('s1')).toBeUndefined();
  });

  it('协同任务已在另一台电脑:组选回那台时提交带上位置,窗口按那台的目录判断', async () => {
    const pending = createPendingAgentSwitchRegistry();
    const row = makeRow({ agentKind: 'cc', model: 'claude-fable-5', providerId: 'xd', agentDeviceId: 'studio-mac', orcaRole: 'lead' });
    const { deps } = makeDeps({
      pendingSwitches: pending,
      getSessionRow: vi.fn(async () => row),
      assertAgentDeviceRouteUsable: vi.fn(async () => undefined),
      resolveProviderGroupTarget: vi.fn(async () => ({ agentDeviceId: 'studio-mac', providerId: 'xd' })),
      selectSameAgentModel: vi.fn(async () => ({ deferred: false })),
    });
    await performSessionAgentSwitch(deps, { ...toGroup, model: 'claude-haiku-5-5' });
    await applyPendingAgentSwitchIfIdle(deps, 's1');
    expect(deps.applyAgentSwitchToDb).toHaveBeenCalledWith('s1', expect.objectContaining({
      model: 'claude-haiku-5-5',
      agentDeviceId: 'studio-mac',
      sdkSessionId: null,
    }));
  });
});

describe('relocateForFreshStart (opening a task elsewhere when its own computer failed to start)', () => {
  it('drops the native session, records the move from the failed computer and leaves a full handoff for the next send', async () => {
    const { deps, calls } = makeDeps({
      // 调用方已把任务记录改到了目标位置；from 给出真正失败的那台。
      getSessionRow: vi.fn(async () => makeRow({ agentDeviceId: 'studio', providerId: 'anthropic-1' })),
      describeAgentDevice: vi.fn((id: string | null) => (id ? `PC ${id}` : null)),
    });
    await relocateForFreshStart(deps, {
      sessionId: 's1',
      agentDeviceId: 'studio',
      providerId: 'anthropic-1',
      from: { agentDeviceId: 'mini', providerId: 'anthropic' },
    });

    // 不关会话、不 bootstrap：启动重试自己接着打开。
    expect(calls).toEqual(['db', 'provider', 'boundary', 'pending']);
    expect(deps.applyAgentSwitchToDb).toHaveBeenCalledWith('s1', {
      agentKind: 'cc',
      model: 'claude-fable-5',
      providerId: 'anthropic-1',
      sdkSessionId: null,
      agentDeviceId: 'studio',
    });
    const boundary = vi.mocked(deps.insertBoundaryMessage).mock.calls[0][1];
    expect(boundary).toMatchObject({
      fromAgentKind: 'cc',
      toAgentKind: 'cc',
      fromProviderId: 'anthropic',
      toProviderId: 'anthropic-1',
      fromAgentDeviceId: 'mini',
      toAgentDeviceId: 'studio',
      fromAgentDeviceName: 'PC mini',
      toAgentDeviceName: 'PC studio',
      fromSdkSessionId: 'sdk-old',
      resumed: false,
    });
    const handoff = vi.mocked(deps.setPendingHandoff).mock.calls[0][1];
    expect(handoff).toContain('你好!');
    expect(boundary.handoff).toBe(handoff);
  });

  it('hides computer names when the provider group of a share picks the computer', async () => {
    const { deps } = makeDeps({
      getSessionRow: vi.fn(async () => makeRow({ agentDeviceId: 'share:s1', providerId: 'anthropic' })),
      describeAgentDevice: vi.fn(() => 'Friend PC'),
    });
    await relocateForFreshStart(deps, {
      sessionId: 's1',
      agentDeviceId: 'share:s1',
      providerId: 'anthropic',
      sharedRelocation: true,
    });
    const boundary = vi.mocked(deps.insertBoundaryMessage).mock.calls[0][1];
    expect(boundary.fromAgentDeviceName).toBeNull();
    expect(boundary.toAgentDeviceName).toBeNull();
    expect(deps.setPendingHandoff).toHaveBeenCalledTimes(1);
  });

  it('still leaves the handoff when the boundary row cannot be written', async () => {
    const { deps, calls } = makeDeps({
      insertBoundaryMessage: vi.fn(async () => {
        throw new Error('disk full');
      }),
    });
    await relocateForFreshStart(deps, { sessionId: 's1', agentDeviceId: 'studio', providerId: 'xd' });
    expect(calls).toEqual(['db', 'provider', 'pending']);
  });

  it('refuses a task that is gone or has no model', async () => {
    const gone = makeDeps({ getSessionRow: vi.fn(async () => null) });
    await expect(relocateForFreshStart(gone.deps, { sessionId: 's1', agentDeviceId: 'studio', providerId: 'xd' }))
      .rejects.toMatchObject({ message: expect.stringContaining('not found') });
    const noModel = makeDeps({ getSessionRow: vi.fn(async () => makeRow({ model: null })) });
    await expect(relocateForFreshStart(noModel.deps, { sessionId: 's1', agentDeviceId: 'studio', providerId: 'xd' }))
      .rejects.toBeTruthy();
    expect(noModel.deps.applyAgentSwitchToDb).not.toHaveBeenCalled();
  });
});
