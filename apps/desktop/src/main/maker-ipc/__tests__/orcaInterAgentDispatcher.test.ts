import type { SessionSendOptions, SessionSendResult, UserMessage } from '@cindy/maker-core';
import type { AgentEvent, Logger, Maker, Session } from '@cindy/maker-core';
import { createOrcaWorkerBridgeMcpProvider } from '@cindy/orca-workflow';
import { AUTO_REVIEW_DELEGATED_CONTINUATION, appendAutoReviewUserIntent, AUTO_REVIEW_USER_INTENT } from '@cindy/maker-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

import type { AgentInputQueuedMessage, AgentInputMakerMessage } from '../../../shared/agentInputQueue.js';
import {
  createOrcaInterAgentDispatcher,
  type OrcaInterAgentDispatcherDeps,
  type OrcaInterAgentDispatcher,
} from '../orcaInterAgentDispatcher.js';
import { AgentInputCoordinator, type AgentInputSendOpts } from '../agent-input-coordinator.js';
import { createOrcaWorkerReportQueue } from '../orcaWorkerReportQueue.js';
import { AUTO_BRIDGE_BATCH_MAX_CHARS, AUTO_BRIDGE_BATCH_MAX_ITEMS } from '../orcaAutoBridgeBatch.js';

const mocks = vi.hoisted(() => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => mocks.logger,
}));

interface TestSessionMeta {
  agentKind: 'claude-code' | 'codex' | 'pi';
  workDir: string;
  model: string;
}

function createLiveSession(
  send: (message: UserMessage, opts?: SessionSendOptions) => Promise<SessionSendResult>,
  agentKind: TestSessionMeta['agentKind'] = 'codex',
) {
  return {
    id: 'target-session',
    agentKind,
    isTurnRunning: vi.fn(() => false),
    send: vi.fn(send),
  };
}

function createHarness(overrides: Partial<OrcaInterAgentDispatcherDeps<TestSessionMeta>> = {}) {
  const order: string[] = [];
  const queuedItems: AgentInputQueuedMessage[] = [];
  const createOpts = {
    agentKind: 'codex' as const,
    workingDir: 'C:\\repo',
    model: 'gpt-5.4',
    permissionMode: 'bypassPermissions',
  };
  const meta: TestSessionMeta = {
    agentKind: 'codex',
    workDir: 'C:\\repo',
    model: 'gpt-5.4',
  };
  const dbRow = {
    title: 'Target Session',
    status: 'active',
    userSendAt: Date.parse('2026-06-12T01:02:03.000Z'),
  };
  const liveSession = createLiveSession(async (_message, opts) => {
    order.push('send-called');
    await opts?.onAccepted?.();
    order.push('vendor-released');
    return { accepted: true };
  });
  const deps: OrcaInterAgentDispatcherDeps<TestSessionMeta> = {
    createId: vi.fn(() => 'client-1'),
    onDirectInputDispatched: vi.fn(async () => {}),
    getSessionMeta: vi.fn(async () => meta),
    getSessionRowSnapshot: vi.fn(async () => dbRow),
    getLiveSession: vi.fn(() => liveSession),
    shouldQueueNewTurn: vi.fn(() => false),
    hasSendToSessionLock: vi.fn(() => false),
    buildCreateOptsForQueuedSession: vi.fn(async () => createOpts),
    enqueueQueuedMessage: vi.fn((_sessionId, item) => {
      queuedItems.push(item);
    }),
    reserveNextQueuedMessage: vi.fn(async (_sessionId, item, onReserved) => {
      queuedItems.unshift(item);
      onReserved?.();
      return true;
    }),
    sendToSessionInternal: vi.fn(async () => ({
      ok: true,
      targetSessionId: 'target-session',
      agentKind: 'codex',
      wakeKind: 'resumed',
      targetTitle: dbRow.title,
      targetLastUserSendAt: new Date(dbRow.userSendAt).toISOString(),
    } as const)),
    createDbMessage: vi.fn(async () => {
      order.push('db');
    }),
    beginDirectTurnChangeSet: vi.fn(async () => {
      order.push('change-set');
    }),
    abortDirectTurnChangeSet: vi.fn(() => {
      order.push('abort-change-set');
    }),
    resolveWorkerSenderLabel: vi.fn(async (_workerId, fallback) => fallback),
    isSessionRunningError: vi.fn((err) =>
      err instanceof Error && (err as { code?: string }).code === 'SESSION_RUNNING'
    ),
    log: mocks.logger,
    ...overrides,
  };
  const dispatcher = createOrcaInterAgentDispatcher(deps);
  return { dispatcher, deps, order, queuedItems, liveSession };
}

function firstQueuedItem(items: AgentInputQueuedMessage[]): AgentInputQueuedMessage {
  const item = items[0];
  expect(item).toBeDefined();
  if (!item) throw new Error('expected a queued item');
  return item;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('sender-chosen steering into an active turn', () => {
  const report = {
    targetSessionId: 'target-session', rawContent: 'Completed work', source: 'worker' as const,
    senderLabel: 'Worker', workerId: 'worker-1', meta: { source: 'orca', context: 'report-test' },
  };
  const steerReport = { ...report, delivery: 'steer' as const };
  // #9346, unit: healthy live reports bypassed the empty Stop, including a Stop
  // arriving during preparation. Lead dispatch is not a Worker report.
  it.each(['initial', 'preparation', 'history', 'handoff'])('queues a Worker report behind an empty Stop (%s)', async timing => {
    let stopped = timing === 'initial';
    const h = createHarness({ shouldQueueNewTurn: (_sid, orcaReport) => stopped && orcaReport === true,
      prepareUnhealthySession: async () => { if (timing === 'preparation') stopped = true; },
      readAutoReviewHistory: async () => { if (timing === 'history') stopped = true; return []; },
      peekPendingHandoff: async () => { if (timing === 'handoff') stopped = true; return null; } });
    const result = await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage(report);
    expect(result).toMatchObject({ ok: true, mode: 'queued' });
    expect(h.queuedItems).toHaveLength(1);
    expect(h.liveSession.send).not.toHaveBeenCalled();
    const lead = await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({ ...report, source: 'lead' });
    expect(lead).toMatchObject({ ok: true, mode: 'dispatched' });
    expect(h.liveSession.send).toHaveBeenCalledOnce();
  });
  // #9346 P1, unit: preparation can fail before a report reaches any queue/send.
  // Existing cancellation tests start inside send; retaining these untouched
  // reports as unknown permanently blocks automatic recovery after preparation heals.
  it.each(['health', 'history', 'handoff', 'queue-preparation', 'row-read', 'image-validation'] as const)(
    'proves an untouched report can retry after %s recovers', async stage => {
      let failing = true;
      const prepare = async () => { if (failing) throw new Error('preparation unavailable'); };
      const h = createHarness({
        ...(stage === 'health' ? { prepareUnhealthySession: prepare } : {}),
        ...(stage === 'history' ? { readAutoReviewHistory: async () => { await prepare(); return []; } } : {}),
        ...(stage === 'handoff' ? { peekPendingHandoff: async () => { await prepare(); return null; } } : {}),
        ...(stage === 'queue-preparation' ? { shouldQueueNewTurn: () => true } : {}),
        ...(stage === 'image-validation' ? { validateImageAttachments: async () => {
          await prepare(); return { ok: true as const, images: [] };
        } } : {}),
      });
      if (stage === 'queue-preparation') {
        const build = h.deps.buildCreateOptsForQueuedSession;
        h.deps.buildCreateOptsForQueuedSession = async (...args) => { await prepare(); return build(...args); };
      }
      if (stage === 'row-read') {
        const read = h.deps.getSessionRowSnapshot;
        h.deps.getSessionRowSnapshot = async id => { await prepare(); return read(id); };
      }
      const input = { ...report, reportClientId: 'durable-report',
        ...(stage === 'image-validation' ? { imagePaths: ['/report.png'] } : {}) };
      await expect(h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage(input))
        .resolves.toMatchObject({ ok: false, reportRejected: true });
      expect(h.liveSession.send).not.toHaveBeenCalled();
      expect(h.deps.enqueueQueuedMessage).not.toHaveBeenCalled();
      failing = false;
      await expect(h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage(input)).resolves.toMatchObject({ ok: true });
      expect(h.liveSession.send.mock.calls.length + vi.mocked(h.deps.enqueueQueuedMessage).mock.calls.length).toBe(1);
    },
  );
  // Route application can allocate/open an Agent even before session.send. A
  // report needing that work must first reach the durable coordinator, whose
  // recoveryBlocked checkpoint owns startup and unknown-allocation recovery.
  it.each([true, undefined])('retains a report before a pending or uninspectable route can bootstrap (%s)', async pending => {
    const apply = vi.fn(async () => { throw new Error('[SHARED_TASK_STAGE_allocation] [SHARED_TASK_RECOVERY_timeout]'); });
    const h = createHarness({ applyPendingAgentSwitch: apply,
      ...(pending === undefined ? {} : { hasPendingAgentSwitch: () => pending }),
    });
    await expect(h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({ ...report, reportClientId: 'durable-report' }))
      .resolves.toMatchObject({ ok: true, mode: 'queued', clientId: 'durable-report' });
    expect(apply).not.toHaveBeenCalled();
    expect(h.liveSession.send).not.toHaveBeenCalled();
    expect(firstQueuedItem(h.queuedItems)).toMatchObject({ clientId: 'durable-report', durableDelivery: true,
      orcaReportDelivery: { workerId: 'worker-1' } });
  });
  it('keeps a healthy report direct without entering the route bootstrap path', async () => {
    const apply = vi.fn(async () => { throw new Error('must not bootstrap'); });
    const h = createHarness({ applyPendingAgentSwitch: apply, hasPendingAgentSwitch: () => false });
    await expect(h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({ ...report, reportClientId: 'durable-report' }))
      .resolves.toMatchObject({ ok: true, mode: 'dispatched' });
    expect(apply).not.toHaveBeenCalled();
    expect(h.liveSession.send).toHaveBeenCalledOnce();
    expect(h.deps.enqueueQueuedMessage).not.toHaveBeenCalled();
  });
  it('keeps an uncertain queue write unconfirmed even if it throws before returning a receipt', async () => {
    const h = createHarness({ getLiveSession: () => null, enqueueQueuedMessage: async () => { throw new Error('queue receipt lost'); } });
    await expect(h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({ ...report, reportClientId: 'durable-report' }))
      .rejects.toThrow('queue receipt lost');
  });
  it('does not requeue a report when send throws SESSION_RUNNING without a rejection receipt', async () => {
    const session = createLiveSession(async () => { throw Object.assign(new Error('unknown send'), { code: 'SESSION_RUNNING' }); });
    const h = createHarness({ getLiveSession: () => session });
    const result = await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({ ...report, reportClientId: 'durable-report' });
    expect(result).toMatchObject({ ok: false });
    expect(result).not.toHaveProperty('reportRejected');
    expect(h.deps.enqueueQueuedMessage).not.toHaveBeenCalled();
  });
  it.each(['cancelled', 'throw', 'accepted-then-error'] as const)('only stamps proven report rejection: %s', async mode => {
    const session = createLiveSession(async () => {
      if (mode === 'throw') throw new Error('send result unknown');
      return mode === 'cancelled' ? { accepted: false, reason: 'cancelled-before-dispatch' } : { accepted: true };
    });
    const h = createHarness({ getLiveSession: () => session,
      onDirectInputDispatched: async () => { throw new Error('activity write failed after acceptance'); },
    });
    const result = await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({ ...report, reportClientId: 'durable-report' });
    expect(result.ok).toBe(false);
    expect('reportRejected' in result ? result.reportRejected : undefined).toBe(mode === 'cancelled' ? true : undefined);
  });
  // #9346 P2, unit: a retained edit/merge survived its old admission failure,
  // but dispatcher cleanup removed the only callback that captures Lead output.
  // Exercise the actual Main enqueue adapter, coordinator, Worker queue tools,
  // bridge send/read and Session events; persistence is the injected I/O boundary.
  it.each(['edited', 'merged'] as const)('keeps reply capture after a retained %s admission fails', async mode => {
    const sid = 'target-session', workerSessionId = 'worker-session';
    let live = false, delayFailure = false;
    let releaseFailure!: () => void, admissionReady!: () => void, sent!: () => void;
    const failure = new Promise<void>(resolve => { releaseFailure = resolve; });
    const admission = new Promise<void>(resolve => { admissionReady = resolve; });
    const delivered = new Promise<void>(resolve => { sent = resolve; });
    const listeners = new Set<(event: AgentEvent) => void>();
    const lead = { id: sid, getStatus: () => 'idle', isTurnRunning: () => false,
      onEvent: (fn: (event: AgentEvent) => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    } as unknown as Session;
    let dispatcher!: OrcaInterAgentDispatcher;
    const snapshots: AgentInputQueuedMessage[][] = [];
    const coordinator = new AgentInputCoordinator({
      sendToAgent: async (_sid, _message, _opts, sendOpts) => {
        await sendOpts.persistUserMessage?.onPersisted?.();
        for (const fn of listeners) fn({ type: 'text', data: { text: 'Lead reply after retained admission', isFinal: true } } as AgentEvent);
        for (const fn of listeners) fn({ type: 'done', data: {} } as AgentEvent);
        const result = { kind: 'session-dispatch', source: 'test', dispatched: true } as const;
        await dispatcher.settleQueuedOrcaInterAgentAcceptedCallback(sid, sendOpts, result);
        sent();
        return result;
      },
      steerToAgent: async () => {}, abortSession: async () => {}, isTurnRunning: () => false,
      hasPendingInteraction: () => false, getAgentKind: () => 'codex', getSdkSessionId: async () => undefined,
      emitProjection: () => {}, persistQueueSnapshot: (_sid, items) => { snapshots.push(JSON.parse(JSON.stringify(items))); },
      awaitQueuePersistence: async () => {
        if (delayFailure) { admissionReady(); await failure; throw new Error('old admission receipt failed'); }
      },
      onAcceptedQueuedMessage: (sessionId, item, restored) => dispatcher.runQueuedOrcaInterAgentAcceptedCallback(sessionId, item, restored),
      onDiscardedQueuedMessage: (_sid, item) => dispatcher.discardQueuedOrcaInterAgentAcceptedCallback(item.clientId),
      loadQueueSnapshot: async () => [], loadClearBoundary: async () => null,
      touchUserSend: async () => {}, createUserMessage: vi.fn(),
    });
    const source = readFileSync(new URL('../register.ts', import.meta.url), 'utf8');
    const start = source.indexOf('    enqueueQueuedMessage: async');
    const end = source.indexOf('    reserveNextQueuedMessage:', start);
    if (start < 0 || end < start) throw new Error('Main enqueue adapter unavailable');
    const enqueue = new Function('inputCoordinator', 'activeOwnerScopeKey', 'isAppSessionBoundaryPending',
      ts.transpileModule('return ({' + source.slice(start, end) + '}).enqueueQueuedMessage;',
        { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
    )(coordinator, () => 'owner', () => false);
    dispatcher = createHarness({
      getLiveSession: () => null, shouldQueueNewTurn: () => true,
      enqueueQueuedMessage: (sessionId, item, onQueueOwned) => enqueue(sessionId, item, onQueueOwned),
      resolveWorkerSessionLink: async () => ({ leadSessionId: sid, workerSessionId }),
    }).dispatcher;
    const log = { ...mocks.logger, debug: vi.fn(), child: () => log } as unknown as Logger;
    const provider = createOrcaWorkerBridgeMcpProvider({
      getMaker: () => ({ getSession: () => live ? lead : undefined }) as unknown as Maker,
      logger: log, persistUserMessage: vi.fn(), wireSession: vi.fn(),
      dispatchInterAgentMessage: params => dispatcher.dispatchOrEnqueueOrcaInterAgentMessage(params),
      orcaTeamStore: { updateWorkerStatus: vi.fn(), getWorkerLink: async () => ({
        workerId: 'worker-1', workerSessionId, workflowId: 'team-1', leadSessionId: sid,
        leadSession: { sessionId: sid, agentKind: 'codex', workingDir: '/repo', model: 'model' },
      }) },
    });
    const ctx = { sessionId: workerSessionId, agentKind: 'codex' as const, workingDir: '/repo',
      mcpCallerAttested: true, mcpCallerKind: 'root' as const,
      vendorOptions: { orcaRole: 'worker', orcaWorkerId: 'worker-1' } };
    const pending = () => coordinator.getQueueControlSnapshot(sid).pendingQueue;
    const reports = createOrcaWorkerReportQueue({
      getSessionQueueSnapshot: async () => ({ pendingQueue: pending(), consumingClientIds: [],
        isWorking: false, willQueue: true, queuePaused: true }),
      ensureQueueRestored: async () => true,
      replaceQueuedMessage: (id, cid, item) => coordinator.replaceQueuedMessage(id, cid, item),
      removeQueuedMessage: (id, cid) => { coordinator.remove(id, cid); return true; },
      mergeQueuedMessages: (id, ids, build) => coordinator.mergeQueuedMessagesAtomically(id, ids, build).merged,
      resolveWorkerRole: async () => 'reviewer', reportWithdrawalStanding: () => 'other-assignment',
      adoptQueuedReport: () => {}, log: mocks.logger,
    });
    const identity = { workerId: 'worker-1', workerSessionId, leadSessionId: sid };
    try {
      await coordinator.ensureQueueRestored(sid);
      coordinator.setExecutionPaused(sid, true);
      if (mode === 'merged') {
        const first = await provider.invokeTool(ctx, 'send_to_lead', { worker_id: 'worker-1', message: 'Report A' },
          { manageWorkerStatus: false, reportClientId: 'capture-a' });
        expect(first.isError).not.toBe(true);
      }
      delayFailure = true;
      const sending = provider.invokeTool(ctx, 'send_to_lead', { worker_id: 'worker-1', message: 'Report B' },
        { manageWorkerStatus: false, reportClientId: 'capture-b' });
      await admission;
      if (mode === 'merged') {
        coordinator.move(sid, 'capture-b', 0);
        expect(await reports.merge({ ...identity, queuedMessageIds: ['capture-b', 'capture-a'], message: 'Edited combined report' }))
          .toMatchObject({ ok: true });
      } else expect(await reports.update({ ...identity, queuedMessageId: 'capture-b', message: 'Edited report' }))
        .toMatchObject({ ok: true });
      expect(pending()).toHaveLength(1);
      expect(pending()[0].orcaReportDelivery).toBeUndefined();
      expect(snapshots.at(-1)?.[0].clientId).toBe('capture-b');
      delayFailure = false;
      releaseFailure();
      expect((await sending).isError).toBe(true);
      expect(listeners.size).toBe(0);
      live = true;
      coordinator.setExecutionPaused(sid, false);
      coordinator.resume(sid);
      await delivered;
      const result = await provider.invokeTool(ctx, 'read_lead', { worker_id: 'worker-1' });
      expect(result.isError).toBe(false);
      expect(JSON.parse(result.content[0]!.text)).toMatchObject({ status: 'done', result: 'Lead reply after retained admission' });
    } finally {
      delayFailure = false;
      releaseFailure();
      coordinator.clearSession(sid);
    }
  });

  // Failed preparation owns only its own registration, never a newer or
  // already queue-owned callback with the same id.
  it.each(['unowned', 'newer', 'existing'] as const)('cleans only its callback registration after an %s queue failure', async mode => {
    const own = vi.fn(), other = vi.fn();
    let dispatcher!: OrcaInterAgentDispatcher, item!: AgentInputQueuedMessage;
    dispatcher = createHarness({ getLiveSession: () => null,
      enqueueQueuedMessage: (_sid, queued) => {
        item = queued;
        if (mode === 'newer') dispatcher.registerQueuedOrcaInterAgentAcceptedCallback('callback-id', other);
        throw new Error('queue unavailable before ownership');
      },
    }).dispatcher;
    if (mode === 'existing') dispatcher.registerQueuedOrcaInterAgentAcceptedCallback('callback-id', other);
    await expect(dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({ ...report, reportClientId: 'callback-id', onAccepted: own }))
      .rejects.toThrow('queue unavailable before ownership');
    await dispatcher.runQueuedOrcaInterAgentAcceptedCallback('target-session', item);
    expect(own).not.toHaveBeenCalled();
    expect(other).toHaveBeenCalledTimes(mode === 'unowned' ? 0 : 1);
    dispatcher.discardQueuedOrcaInterAgentAcceptedCallback('callback-id');
  });

  // #9346 P2, unit: persist the real dispatcher's cold report, then recreate both
  // dispatcher and bridge provider. Existing capture tests kept the old closure.
  it.each(['complete', 'cancelled'] as const)('rebinds a restored report capture at acceptance: %s', async mode => {
    const cold = createHarness({ getLiveSession: () => null });
    await cold.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({ ...report, reportClientId: 'durable-report' });
    const item = JSON.parse(JSON.stringify(firstQueuedItem(cold.queuedItems))) as AgentInputQueuedMessage;
    expect(item.clientId).toBe('durable-report');
    const listeners = new Set<(event: AgentEvent) => void>();
    const lead = { id: 'target-session', getStatus: () => 'idle', isTurnRunning: () => false,
      onEvent: (handler: (event: AgentEvent) => void) => { listeners.add(handler); return () => { listeners.delete(handler); }; },
    } as unknown as Session;
    const log = { ...mocks.logger, debug: vi.fn(), child: () => log } as unknown as Logger;
    const provider = createOrcaWorkerBridgeMcpProvider({
      getMaker: () => ({ getSession: () => lead }) as unknown as Maker,
      logger: log, persistUserMessage: vi.fn(), wireSession: vi.fn(),
      orcaTeamStore: { updateWorkerStatus: vi.fn(), getWorkerLink: async () => ({
        workerId: 'worker-1', workerSessionId: 'worker-session', workflowId: 'team-1',
        leadSessionId: 'target-session', leadSession: { sessionId: 'target-session', agentKind: 'codex', workingDir: '/repo', model: 'model' },
      }) },
    });
    const restored = createHarness({ prepareRestoredReportAcceptance: provider.prepareLeadReportAcceptance });
    // Startup / inspection does not capture or mark a turn running.
    expect(listeners.size).toBe(0);
    await restored.dispatcher.runQueuedOrcaInterAgentAcceptedCallback('target-session', item, true);
    if (mode === 'complete') {
      for (const fn of listeners) fn({ type: 'text', data: { text: 'Lead reply after restart', isFinal: true } } as AgentEvent);
      for (const fn of listeners) fn({ type: 'done', data: {} } as AgentEvent);
    }
    await restored.dispatcher.settleQueuedOrcaInterAgentAcceptedCallback('target-session', {
      persistUserMessage: { clientId: item.clientId, content: 'Review complete', delivery: 'turn' },
    }, mode === 'complete' ? { kind: 'session-dispatch', source: 'maker-ipc', dispatched: true }
      : { kind: 'session-dispatch', source: 'maker-ipc', dispatched: false,
        reason: 'cancelled-before-dispatch', context: 'restored-report', message: 'Cancelled before dispatch' });
    const result = await provider.invokeTool({ sessionId: 'worker-session', agentKind: 'codex', workingDir: '/repo',
      mcpCallerAttested: true, mcpCallerKind: 'root', vendorOptions: { orcaRole: 'worker', orcaWorkerId: 'worker-1' },
    }, 'read_lead', { worker_id: 'worker-1' });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject(mode === 'complete'
      ? { status: 'done', result: 'Lead reply after restart' } : { status: 'idle', result: '' });
  });
  function setup(outcome: 'steered' | 'queued' | 'not-attempted' | 'rejected' = 'steered') {
    const live = { ...createLiveSession(async () => ({ accepted: true })),
      isTurnRunning: vi.fn(() => true), getTurnGeneration: vi.fn(() => 7),
      capabilities: { sameTurnSteer: { supported: true } }, remoteHostId: null as string | null };
    const steer = vi.fn<NonNullable<OrcaInterAgentDispatcherDeps<TestSessionMeta>['steerControlInput']>>(async () => outcome);
    const lock = vi.fn(async (_id: string, task: () => Promise<unknown>) => task());
    const h = createHarness({ getLiveSession: () => live, steerControlInput: steer,
      withSendToSessionLock: lock as OrcaInterAgentDispatcherDeps<TestSessionMeta>['withSendToSessionLock'],
      shouldQueueNewTurn: () => true,
      resolveWorkerSenderLabel: async () => 'reviewer',
      resolveWorkerSessionLink: async () => ({ leadSessionId: 'target-session', workerSessionId: 'worker-session' }),
    });
    return { ...h, live, steer, lock };
  }
  // Unit regression: no-live reports used to bootstrap before retaining the
  // message, and a queued ACK could precede persistence. Exercise the dispatcher.
  it('retains a cold Lead report and waits for its queue receipt before acknowledging', async () => {
    let release!: () => void;
    const persisted = new Promise<void>(resolve => { release = resolve; });
    const h = createHarness({ getLiveSession: () => null,
      enqueueQueuedMessage: vi.fn(async () => persisted),
    });
    let accepted = false;
    const pending = h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session', rawContent: 'Review complete', source: 'worker',
      senderLabel: 'reviewer', workerId: 'worker-1', meta: { source: 'mcp-tool', context: 'report' },
    }).then(result => { accepted = true; return result; });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(h.deps.sendToSessionInternal).not.toHaveBeenCalled();
    expect(h.deps.enqueueQueuedMessage).toHaveBeenCalledOnce();
    expect(accepted).toBe(false);
    release();
    await expect(pending).resolves.toMatchObject({ ok: true, mode: 'queued', clientId: 'client-1' });
  });

  it('uses same-turn delivery with Orca identity and never runs turn-start callbacks', async () => {
    const h = setup();
    const order: string[] = [];
    const result = await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({ ...steerReport,
      onAccepted: () => { order.push('accepted'); }, onAcceptedCommit: () => { order.push('commit'); },
    });
    expect(result).toMatchObject({ ok: true, mode: 'steered', clientId: 'client-1' });
    expect(result).not.toHaveProperty('steerFallbackReason');
    expect(h.steer).toHaveBeenCalledWith('target-session', expect.objectContaining({
      clientId: 'client-1', text: '[From Orca Worker reviewer (worker_id: worker-1)]\nCompleted work',
      persistedContent: '{"orcaSource":"worker","content":"Completed work"}',
      autoReviewUserText: { kind: 'delegated-continuation' },
      origin: { kind: 'orca', senderLabel: 'reviewer', senderSessionId: 'worker-session', displayText: 'Completed work' },
    }), { session: h.live, turnGeneration: 7 });
    // The message joined the running turn; accepted/commit would claim a new turn's identity.
    expect(order).toEqual([]);
    const item = h.steer.mock.calls[0]?.[1];
    if (!item) throw new Error('expected steered item');
    expect(h.dispatcher.runQueuedOrcaInterAgentAcceptedCallback('target-session', item)).toBeUndefined();
    expect(h.lock).toHaveBeenCalledOnce();
    expect(h.deps.enqueueQueuedMessage).not.toHaveBeenCalled();
    expect(h.live.send).not.toHaveBeenCalled();
    expect(h.deps.createDbMessage).not.toHaveBeenCalled();
    expect(h.deps.beginDirectTurnChangeSet).not.toHaveBeenCalled();
  });
  it.each(['worker', 'lead'] as const)('keeps %s messages queued unless the sender asks to steer', async (source) => {
    const h = setup();
    expect(await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({ ...report, source }))
      .toMatchObject({ ok: true, mode: 'queued' });
    const [, queued] = vi.mocked(h.deps.enqueueQueuedMessage).mock.calls[0] ?? [];
    expect(queued).toBeDefined();
    expect(h.steer).not.toHaveBeenCalled();
    expect(await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({ ...report, source }))
      .not.toHaveProperty('steerFallbackReason');
  });
  it('steers Lead messages into a worker turn when chosen', async () => {
    const h = setup();
    expect(await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      ...steerReport, source: 'lead', senderLabel: 'Lead',
    })).toMatchObject({ ok: true, mode: 'steered' });
    expect(h.steer).toHaveBeenCalledOnce();
  });
  it('dispatches directly to an idle target without a fallback reason', async () => {
    const h = setup();
    h.live.isTurnRunning.mockReturnValue(false);
    h.deps.shouldQueueNewTurn = () => false;
    const result = await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage(steerReport);
    expect(result).toMatchObject({ ok: true, mode: 'dispatched' });
    expect(result).not.toHaveProperty('steerFallbackReason');
    expect(h.steer).not.toHaveBeenCalled();
  });
  it('acknowledges retained queue ownership without enqueueing a duplicate', async () => {
    const h = setup('queued');
    const accepted = vi.fn();
    const commit = vi.fn();
    const result = await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({ ...steerReport, onAccepted: accepted, onAcceptedCommit: commit });
    expect(result).toMatchObject({ ok: true, mode: 'queued', clientId: 'client-1', steerFallbackReason: 'STEER_UNCERTAIN' });
    expect(accepted).not.toHaveBeenCalled();
    expect(h.deps.enqueueQueuedMessage).not.toHaveBeenCalled();
    const item = h.steer.mock.calls[0]?.[1];
    if (!item) throw new Error('expected retained report');
    await h.dispatcher.runQueuedOrcaInterAgentAcceptedCallback('target-session', item);
    await h.dispatcher.settleQueuedOrcaInterAgentAcceptedCallback('target-session',
      { persistUserMessage: { clientId: 'client-1', content: item.persistedContent, delivery: 'turn' } },
      { kind: 'session-dispatch', dispatched: true, source: 'test' });
    expect(accepted).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledOnce();
  });
  it('fails a screening rejection instead of retrying it through the queue', async () => {
    const h = setup('rejected');
    const accepted = vi.fn();
    expect(await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({ ...steerReport, onAccepted: accepted }))
      .toMatchObject({ ok: false, dispatchOutcome: { code: 'SEND_FAILED' } });
    expect(h.deps.enqueueQueuedMessage).not.toHaveBeenCalled();
    expect(h.live.send).not.toHaveBeenCalled();
    expect(accepted).not.toHaveBeenCalled();
  });
  it('falls back to the ordinary path after an undelivered attempt without a stale callback', async () => {
    const h = setup('not-attempted');
    const accepted = vi.fn();
    const result = await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({ ...steerReport, onAccepted: accepted });
    expect(result).toMatchObject({ ok: true, mode: 'queued', steerFallbackReason: 'INPUT_BOUNDARY_BUSY' });
    expect(h.deps.enqueueQueuedMessage).toHaveBeenCalledOnce();
    expect(accepted).not.toHaveBeenCalled();
    const [, queued] = vi.mocked(h.deps.enqueueQueuedMessage).mock.calls[0] ?? [];
    if (!queued) throw new Error('expected queued report');
    await h.dispatcher.runQueuedOrcaInterAgentAcceptedCallback('target-session', queued);
    expect(accepted).toHaveBeenCalledOnce();
  });
  it.each([
    ['unsupported', 'STEER_UNSUPPORTED', 0],
    ['remote', 'STEER_UNSUPPORTED', 0],
    ['send-lock', 'INPUT_BOUNDARY_BUSY', 0],
    ['guarded', 'INPUT_BOUNDARY_BUSY', 1],
    ['generation', 'INPUT_BOUNDARY_BUSY', 0],
    ['replacement', 'INPUT_BOUNDARY_BUSY', 0],
  ] as const)('queues with a reason for %s', async (reason, steerFallbackReason, steerCalls) => {
    const h = setup(reason === 'guarded' ? 'not-attempted' : 'steered');
    if (reason === 'unsupported') h.live.capabilities.sameTurnSteer.supported = false;
    if (reason === 'remote') h.live.remoteHostId = 'ssh-host';
    if (reason === 'send-lock') h.deps.hasSendToSessionLock = () => true;
    if (reason === 'generation') h.deps.buildCreateOptsForQueuedSession = async () => {
      h.live.getTurnGeneration.mockReturnValue(8);
      return { agentKind: 'codex', model: 'gpt-5.4', workingDir: 'C:\\repo' };
    };
    if (reason === 'replacement') h.deps.buildCreateOptsForQueuedSession = async () => {
      h.deps.getLiveSession = () => ({ ...h.live });
      return { agentKind: 'codex', model: 'gpt-5.4', workingDir: 'C:\\repo' };
    };
    expect(await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage(steerReport))
      .toMatchObject({ ok: true, mode: 'queued', steerFallbackReason });
    expect(h.deps.enqueueQueuedMessage).toHaveBeenCalledOnce();
    expect(h.steer).toHaveBeenCalledTimes(steerCalls);
  });
});

describe('Orca lead/worker dispatcher', () => {
  it.each([false, true])('restores human restrictions for ordinary direct continuation (unavailable=%s)', async unavailable => {
    const h = createHarness({readAutoReviewHistory: async () => {
      if(unavailable) throw new Error('unavailable');
      return [{clientId:'human',role:'user',content:{text:'Do not deploy'},agentMeta:{delivery:'turn',autoReviewUserText:'Do not deploy'}}];
    }});
    const result = await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({targetSessionId:'target-session',rawContent:'Deploy now',source:'lead',senderLabel:'Lead',workerId:'worker-1',meta:{source:'orca',context:'test'}});
    if (unavailable) {
      expect(result).toMatchObject({ok:false});
      expect(h.liveSession.send).not.toHaveBeenCalled();
    } else expect(h.liveSession.send.mock.calls[0]?.[1]?.[AUTO_REVIEW_USER_INTENT]).toBe('Do not deploy');
  });
  it('runs direct accepted side effects after DB persistence and before vendor turn release', async () => {
    const h = createHarness();
    const commit = vi.fn();

    const result = await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      rawContent: 'Implement feature',
      source: 'lead',
      senderLabel: 'Lead',
      workerId: 'worker-1',
      meta: { source: 'orca', context: 'direct-test' },
      onAccepted: async () => {
        h.order.push('accepted');
      },
      onAcceptedCommit: commit,
    });

    expect(result).toMatchObject({
      ok: true,
      mode: 'dispatched',
      clientId: 'client-1',
      dispatchOutcome: { kind: 'session-dispatch', source: 'orca', dispatched: true },
      targetTitle: 'Target Session',
      targetLastUserSendAt: '2026-06-12T01:02:03.000Z',
    });
    expect(h.order).toEqual(['send-called', 'db', 'change-set', 'accepted', 'vendor-released']);
    expect(h.deps.onDirectInputDispatched).toHaveBeenCalledExactlyOnceWith('target-session');
    expect(commit).toHaveBeenCalledTimes(1);
    expect(h.deps.beginDirectTurnChangeSet).toHaveBeenCalledWith('target-session', 'client-1');
    expect(h.deps.abortDirectTurnChangeSet).not.toHaveBeenCalled();
    expect(h.deps.createDbMessage).toHaveBeenCalledWith('target-session', {
      clientId: 'client-1',
      role: 'user',
      content: '{"orcaSource":"lead","content":"Implement feature"}',
      agentMeta: {
        origin: { kind: 'orca', senderLabel: 'Lead', displayText: 'Implement feature' },
        autoReviewUserText: { kind: 'delegated-continuation' },
        delivery: 'turn',
      },
    });
    expect(h.liveSession.send).toHaveBeenCalledWith(
      {
        type: 'user',
        content:
          '[From Orca Lead]\nImplement feature\n\n---\n(Bridge note: your worker_id for tool calls is worker-1.)',
      },
      expect.objectContaining({ throwOnStartFailure: true, [AUTO_REVIEW_DELEGATED_CONTINUATION]: true }),
    );
  });

  it('attaches validated images as blocks on live send and files on queued entries', async () => {
    const validateImageAttachments = vi.fn(async (paths: string[]) => ({
      ok: true as const,
      images: paths.map((p) => ({
        path: p, name: p.split(/[\\/]/).pop() ?? p, ext: '.png', size: 10, mimeType: 'image/png',
      })),
    }));
    const live = createHarness({ validateImageAttachments });
    const result = await live.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      rawContent: 'Check this screenshot',
      source: 'lead',
      senderLabel: 'Lead',
      imagePaths: ['C:/tmp/a.png', 'C:/tmp/b.png'],
      meta: { source: 'orca', context: 'images-live-test' },
    });
    expect(result).toMatchObject({ ok: true, mode: 'dispatched' });
    expect(validateImageAttachments).toHaveBeenCalledWith(['C:/tmp/a.png', 'C:/tmp/b.png']);
    expect(live.liveSession.send.mock.calls[0]?.[0]).toEqual({
      type: 'user',
      content: [
        { type: 'text', text: expect.stringContaining('Check this screenshot') },
        { type: 'image', path: 'C:/tmp/a.png', mimeType: 'image/png', pathOrigin: 'desktop-host' },
        { type: 'image', path: 'C:/tmp/b.png', mimeType: 'image/png', pathOrigin: 'desktop-host' },
      ],
    });

    const queued = createHarness({
      validateImageAttachments,
      shouldQueueNewTurn: vi.fn(() => true),
    });
    await queued.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      rawContent: 'Check this screenshot',
      source: 'lead',
      senderLabel: 'Lead',
      imagePaths: ['C:/tmp/a.png'],
      meta: { source: 'orca', context: 'images-queued-test' },
    });
    const item = firstQueuedItem(queued.queuedItems);
    expect(item.files).toEqual([expect.objectContaining({
      path: 'C:/tmp/a.png', category: 'image', mimeType: 'image/png', pathOrigin: 'desktop-host',
    })]);
  });

  it('rejects images for remote targets and invalid files without sending', async () => {
    const remote = createHarness({
      getSessionRowSnapshot: vi.fn(async () => ({
        title: 'Target Session',
        status: 'active',
        userSendAt: Date.parse('2026-06-12T01:02:03.000Z'),
        remoteHostId: 'host-1',
      })),
    });
    const remoteResult = await remote.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      rawContent: 'Look',
      source: 'lead',
      senderLabel: 'Lead',
      imagePaths: ['C:/tmp/a.png'],
      meta: { source: 'orca', context: 'images-remote-test' },
    });
    expect(remoteResult).toMatchObject({ ok: false });
    expect(remote.liveSession.send).not.toHaveBeenCalled();

    const invalid = createHarness({
      validateImageAttachments: vi.fn(async () => ({ ok: false as const, message: 'image not found: C:/tmp/missing.png' })),
    });
    const invalidResult = await invalid.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      rawContent: 'Look',
      source: 'lead',
      senderLabel: 'Lead',
      imagePaths: ['C:/tmp/missing.png'],
      meta: { source: 'orca', context: 'images-invalid-test' },
    });
    expect(invalidResult).toMatchObject({ ok: false });
    expect(invalid.deps.sendToSessionInternal).not.toHaveBeenCalled();
    expect(invalid.liveSession.send).not.toHaveBeenCalled();
  });

  it('queues image attachments for a no-live target instead of failing after rollover', async () => {
    const validateImageAttachments = vi.fn(async (paths: string[]) => ({
      ok: true as const,
      images: paths.map((p) => ({
        path: p, name: p.split(/[\\/]/).pop() ?? p, ext: '.png', size: 10, mimeType: 'image/png',
      })),
    }));
    const h = createHarness({
      validateImageAttachments,
      prepareUnhealthySession: vi.fn(async () => true),
      getLiveSession: vi.fn(() => null),
    });

    const result = await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      rawContent: 'Check after rollover',
      source: 'lead',
      senderLabel: 'Lead',
      imagePaths: ['C:/tmp/a.png'],
      meta: { source: 'orca', context: 'images-no-live-test' },
    });

    expect(result).toMatchObject({ ok: true, mode: 'queued', clientId: 'client-1' });
    const item = firstQueuedItem(h.queuedItems);
    expect(item.files?.map((file) => file.path)).toEqual(['C:/tmp/a.png']);
    expect(h.deps.sendToSessionInternal).not.toHaveBeenCalled();
  });

  it('prepares an unhealthy live session before direct send and does not reuse the closed handle', async () => {
    const closed = { current: false };
    const liveSession = createLiveSession(async (_message, opts) => {
      await opts?.onAccepted?.();
      return { accepted: true };
    });
    const prepareUnhealthySession = vi.fn(async () => {
      closed.current = true;
      return true;
    });
    const h = createHarness({
      getLiveSession: vi.fn(() => (closed.current ? null : liveSession)),
      prepareUnhealthySession,
    });

    const result = await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      rawContent: 'Continue after compact failure',
      source: 'lead',
      senderLabel: 'Lead',
      meta: { source: 'orca', context: 'prepare-test' },
    });

    expect(result).toMatchObject({ ok: true, mode: 'dispatched' });
    expect(prepareUnhealthySession).toHaveBeenCalledWith('target-session');
    expect(h.deps.sendToSessionInternal).toHaveBeenCalledWith(expect.objectContaining({
      autoReviewUserText: {kind:'delegated-continuation'},
      targetSessionId: 'target-session',
      clientId: 'client-1',
    }));
    expect(liveSession.send).not.toHaveBeenCalled();
  });

  it('recycles a drifted runtime before live dispatch and rebuilds via the queued path', async () => {
    // Orca 直发绕过发送事务:漂移时先回收(重建窗口内),本条消息转
    // sendToSessionInternal 的 lazy/queued 路径重扫重建投递,不拿旧 argv 跑。
    const recycleProjectResourceRuntime = vi.fn(async () => true);
    const h = createHarness({ recycleProjectResourceRuntime });

    const result = await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      rawContent: 'Run with the refreshed skill set',
      source: 'lead',
      senderLabel: 'Lead',
      meta: { source: 'orca', context: 'drift-recycle-test' },
    });

    expect(recycleProjectResourceRuntime).toHaveBeenCalledWith('target-session');
    expect(h.liveSession.send).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, mode: 'dispatched' });
    expect(h.deps.sendToSessionInternal).toHaveBeenCalledWith(expect.objectContaining({
      targetSessionId: 'target-session',
      clientId: 'client-1',
    }));
  });

  it('still sends through the live handle after prepare leaves it open', async () => {
    const prepareUnhealthySession = vi.fn(async () => false);
    const h = createHarness({ prepareUnhealthySession });

    const result = await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      rawContent: 'Healthy live send',
      source: 'lead',
      senderLabel: 'Lead',
      meta: { source: 'orca', context: 'healthy-prepare-test' },
    });

    expect(result).toMatchObject({ ok: true, mode: 'dispatched' });
    expect(prepareUnhealthySession).toHaveBeenCalledWith('target-session');
    expect(h.liveSession.send).toHaveBeenCalled();
    expect(h.deps.sendToSessionInternal).not.toHaveBeenCalled();
  });

  // Regression: collaboration started from the panel marks an already-live session as Lead
  // without rebuilding it. A Worker report then started a Lead turn that had no Lead
  // instructions or Orca tools, and the Lead ended the turn with an empty answer.
  it('rebuilds a live target that lacks Orca hydration and delivers to the rebuilt runtime', async () => {
    const accept = async (_message: UserMessage, opts?: SessionSendOptions): Promise<SessionSendResult> => {
      await opts?.onAccepted?.();
      return { accepted: true };
    };
    const staleSession = createLiveSession(accept);
    const hydratedSession = createLiveSession(accept);
    let current = staleSession;
    const hydrateOrcaSessionIfNeeded = vi.fn(async () => {
      current = hydratedSession;
    });
    const h = createHarness({
      getLiveSession: vi.fn(() => current),
      hydrateOrcaSessionIfNeeded,
    });

    const result = await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      rawContent: 'Review finished',
      source: 'worker',
      senderLabel: 'Worker',
      workerId: 'worker-1',
      meta: { source: 'orca', context: 'hydrate-test' },
    });

    expect(result).toMatchObject({ ok: true, mode: 'dispatched' });
    expect(hydrateOrcaSessionIfNeeded).toHaveBeenCalledWith(
      'target-session',
      expect.objectContaining({ agentKind: 'codex' }),
    );
    expect(staleSession.send).not.toHaveBeenCalled();
    expect(hydratedSession.send).toHaveBeenCalledTimes(1);
  });

  it('still delivers the message when the hydration rebuild fails', async () => {
    const h = createHarness({
      hydrateOrcaSessionIfNeeded: vi.fn(async () => {
        throw new Error('bootstrap failed');
      }),
    });

    const result = await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      rawContent: 'Review finished',
      source: 'worker',
      senderLabel: 'Worker',
      workerId: 'worker-1',
      meta: { source: 'orca', context: 'hydrate-failure-test' },
    });

    expect(result).toMatchObject({ ok: true, mode: 'dispatched' });
    expect(h.liveSession.send).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent live prepare/send on the per-session lock', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let lockChain: Promise<unknown> = Promise.resolve();
    let lockHeld = false;
    let overlapping = false;
    const withSendToSessionLock = async <T>(_sessionId: string, task: () => Promise<T>): Promise<T> => {
      const run = lockChain.then(async () => {
        if (lockHeld) overlapping = true;
        lockHeld = true;
        try {
          return await task();
        } finally {
          lockHeld = false;
        }
      });
      lockChain = run.then(() => undefined, () => undefined);
      return run;
    };
    const prepareUnhealthySession = vi.fn(async () => {
      if (prepareUnhealthySession.mock.calls.length === 1) await firstGate;
      return false;
    });
    const h = createHarness({
      createId: vi.fn()
        .mockReturnValueOnce('client-1')
        .mockReturnValueOnce('client-2'),
      withSendToSessionLock,
      prepareUnhealthySession,
    });

    const first = h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      rawContent: 'First',
      source: 'lead',
      senderLabel: 'Lead',
      meta: { source: 'orca', context: 'lock-first' },
    });
    const second = h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      rawContent: 'Second',
      source: 'lead',
      senderLabel: 'Lead',
      meta: { source: 'orca', context: 'lock-second' },
    });
    await vi.waitFor(() => {
      expect(prepareUnhealthySession).toHaveBeenCalledTimes(1);
    });
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ ok: true, mode: 'dispatched', clientId: 'client-1' }),
      expect.objectContaining({ ok: true, mode: 'dispatched', clientId: 'client-2' }),
    ]);
    expect(overlapping).toBe(false);
    expect(prepareUnhealthySession).toHaveBeenCalledTimes(2);
    expect(h.liveSession.send).toHaveBeenCalledTimes(2);
  });

  it('delays queued accepted side effects until the coordinator accepted hook runs', async () => {
    const accepted = vi.fn();
    const h = createHarness({
      shouldQueueNewTurn: vi.fn(() => true),
    });

    const result = await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      rawContent: 'Queued task',
      source: 'lead',
      senderLabel: 'Lead',
      meta: { source: 'orca', context: 'queued-test' },
      onAccepted: accepted,
    });

    expect(result).toMatchObject({ ok: true, mode: 'queued' });
    expect(accepted).not.toHaveBeenCalled();
    expect(h.queuedItems).toHaveLength(1);
    expect(h.deps.beginDirectTurnChangeSet).not.toHaveBeenCalled();

    await h.dispatcher.runQueuedOrcaInterAgentAcceptedCallback('target-session', firstQueuedItem(h.queuedItems));

    expect(accepted).toHaveBeenCalledTimes(1);
  });

  it('discards queued accepted callbacks without rollback when the queued item never ran', async () => {
    const accepted = vi.fn();
    const rollback = vi.fn();
    const h = createHarness({
      shouldQueueNewTurn: vi.fn(() => true),
    });

    await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      rawContent: 'Discard me',
      source: 'lead',
      senderLabel: 'Lead',
      meta: { source: 'orca', context: 'discard-test' },
      onAccepted: accepted,
      onAcceptedRollback: rollback,
    });

    const queued = firstQueuedItem(h.queuedItems);
    h.dispatcher.discardQueuedOrcaInterAgentAcceptedCallback(queued.clientId);
    await h.dispatcher.rollbackQueuedOrcaInterAgentAcceptedCallback('target-session', queued.clientId);

    expect(accepted).not.toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
  });

  it('does not roll back direct dispatch failures before accepted runs', async () => {
    const accepted = vi.fn();
    const rollback = vi.fn();
    const h = createHarness({
      getLiveSession: vi.fn(() =>
        createLiveSession(async () => {
          h.order.push('send-called');
          return { accepted: false, reason: 'cancelled-before-dispatch' };
        })
      ),
    });

    const result = await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      rawContent: 'Will fail before accepted',
      source: 'lead',
      senderLabel: 'Lead',
      meta: { source: 'orca', context: 'pre-accept-failure-test' },
      onAccepted: accepted,
      onAcceptedRollback: rollback,
    });

    expect(result).toMatchObject({
      ok: false,
      dispatchOutcome: {
        kind: 'session-dispatch',
        source: 'orca',
        dispatched: false,
        reason: 'cancelled-before-dispatch',
      },
    });
    expect(h.order).toEqual(['send-called']);
    expect(h.deps.createDbMessage).not.toHaveBeenCalled();
    expect(accepted).not.toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
  });

  it('rolls back direct accepted side effects when dispatch fails after accepted', async () => {
    const accepted = vi.fn(() => {
      h.order.push('accepted');
    });
    const rollback = vi.fn(() => {
      h.order.push('rollback');
    });
    const h = createHarness({
      getLiveSession: vi.fn(() =>
        createLiveSession(async (_message, opts) => {
          h.order.push('send-called');
          await opts?.onAccepted?.();
          h.order.push('send-returned-cancelled');
          return { accepted: false, reason: 'cancelled-before-dispatch' };
        })
      ),
    });

    const result = await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      rawContent: 'Will cancel',
      source: 'lead',
      senderLabel: 'Lead',
      meta: { source: 'orca', context: 'rollback-test' },
      onAccepted: accepted,
      onAcceptedRollback: rollback,
    });

    expect(result).toMatchObject({
      ok: false,
      dispatchOutcome: {
        kind: 'session-dispatch',
        source: 'orca',
        dispatched: false,
        reason: 'cancelled-before-dispatch',
      },
    });
    expect(h.order).toEqual([
      'send-called',
      'db',
      'change-set',
      'accepted',
      'send-returned-cancelled',
      'abort-change-set',
      'rollback',
    ]);
    expect(h.deps.abortDirectTurnChangeSet).toHaveBeenCalledWith('target-session');
    expect(rollback).toHaveBeenCalledTimes(1);
  });

  it.each(['claude-code', 'codex', 'pi'] as const)('leaves lazy-resume turn capture to sendToSessionInternal and reports its %s Agent', async (agentKind) => {
    const h = createHarness({
      getLiveSession: vi.fn(() => null),
      sendToSessionInternal: vi.fn(async () => ({
        ok: true, targetSessionId: 'target-session', agentKind, wakeKind: 'resumed',
        targetTitle: 'Resumed target', targetLastUserSendAt: null,
      } as const)),
    });

    const result = await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      rawContent: 'Resume target',
      source: 'lead',
      senderLabel: 'Lead',
      meta: { source: 'orca', context: 'resume-test' },
    });

    expect(result).toMatchObject({ ok: true, mode: 'dispatched', agentKind });
    expect(h.deps.sendToSessionInternal).toHaveBeenCalledWith(expect.objectContaining({
      targetSessionId: 'target-session',
      clientId: 'client-1',
    }));
    expect(h.deps.beginDirectTurnChangeSet).not.toHaveBeenCalled();
    expect(h.deps.abortDirectTurnChangeSet).not.toHaveBeenCalled();
  });

  it.each(['cancelled-before-dispatch', 'provider-rejected-before-dispatch'] as const)('passes only explicit cancellation to queued rollback: %s', async (reason) => {
    const accepted = vi.fn();
    const rollback = vi.fn();
    const commit = vi.fn();
    const h = createHarness({
      shouldQueueNewTurn: vi.fn(() => true),
    });

    await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      rawContent: 'Queued failure',
      source: 'lead',
      senderLabel: 'Lead',
      meta: { source: 'orca', context: 'queued-rollback-test' },
      onAccepted: accepted,
      onAcceptedRollback: rollback,
      onAcceptedCommit: commit,
    });

    const queued = firstQueuedItem(h.queuedItems);
    await h.dispatcher.runQueuedOrcaInterAgentAcceptedCallback('target-session', queued);
    await h.dispatcher.settleQueuedOrcaInterAgentAcceptedCallback(
      'target-session',
      {
        persistUserMessage: {
          clientId: queued.clientId,
          content: queued.persistedContent,
          delivery: 'turn',
        },
      },
      {
        kind: 'session-dispatch',
        source: 'maker-ipc',
        dispatched: false,
        reason,
        context: 'queued-rollback-test',
        message: 'Session send was cancelled before vendor dispatch: queued-rollback-test',
      },
    );

    expect(accepted).toHaveBeenCalledTimes(1);
    expect(rollback).toHaveBeenCalledExactlyOnceWith(reason === 'cancelled-before-dispatch' ? reason : undefined);
    expect(commit).not.toHaveBeenCalled();
  });

  it('rolls back a live accepted race before queueing and accepts it again on drain', async () => {
    const accepted = vi.fn();
    const rollback = vi.fn();
    const commit = vi.fn();
    const liveSession = createLiveSession(async (_message, opts) => {
      await opts?.onAccepted?.();
      throw Object.assign(new Error('already running'), { code: 'SESSION_RUNNING' });
    });
    const h = createHarness({ getLiveSession: vi.fn(() => liveSession) });

    await expect(
      h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
        targetSessionId: 'target-session',
        rawContent: 'Queue after live race',
        source: 'lead',
        senderLabel: 'Lead',
        meta: { source: 'orca', context: 'live-requeue-test' },
        onAccepted: accepted,
        onAcceptedRollback: rollback,
        onAcceptedCommit: commit,
      }),
    ).resolves.toMatchObject({ ok: true, mode: 'queued' });

    expect(accepted).toHaveBeenCalledTimes(1);
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
    const queued = firstQueuedItem(h.queuedItems);
    await h.dispatcher.runQueuedOrcaInterAgentAcceptedCallback('target-session', queued);
    await h.dispatcher.settleQueuedOrcaInterAgentAcceptedCallback(
      'target-session',
      {
        persistUserMessage: {
          clientId: queued.clientId,
          content: queued.persistedContent,
          delivery: 'turn',
        },
      },
      { kind: 'session-dispatch', source: 'maker-ipc', dispatched: true },
    );
    expect(accepted).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('rolls back a resumed accepted race before queueing and accepts it again on drain', async () => {
    const accepted = vi.fn();
    const rollback = vi.fn();
    const commit = vi.fn();
    const h = createHarness({ getLiveSession: vi.fn(() => null) });
    vi.mocked(h.deps.sendToSessionInternal).mockImplementation(async (params) => {
      await params.onAccepted?.();
      h.dispatcher.registerQueuedOrcaInterAgentAcceptedCallback(
        params.clientId,
        params.onAccepted!,
        params.onAcceptedRollback,
        params.onAcceptedCommit,
      );
      return {
        ok: true,
        targetSessionId: 'target-session',
        agentKind: 'codex',
        wakeKind: 'queued',
        targetTitle: 'Target Session',
        targetLastUserSendAt: null,
      };
    });

    await expect(
      h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
        targetSessionId: 'target-session',
        rawContent: 'Queue after resume race',
        source: 'lead',
        senderLabel: 'Lead',
        meta: { source: 'orca', context: 'resume-requeue-test' },
        onAccepted: accepted,
        onAcceptedRollback: rollback,
        onAcceptedCommit: commit,
      }),
    ).resolves.toMatchObject({ ok: true, mode: 'queued' });

    expect(accepted).toHaveBeenCalledTimes(1);
    expect(rollback).toHaveBeenCalledTimes(1);
    const queued = { clientId: 'client-1' } as AgentInputQueuedMessage;
    await h.dispatcher.runQueuedOrcaInterAgentAcceptedCallback('target-session', queued);
    await h.dispatcher.settleQueuedOrcaInterAgentAcceptedCallback(
      'target-session',
      {
        persistUserMessage: {
          clientId: queued.clientId,
          content: 'persisted',
          delivery: 'turn',
        },
      },
      { kind: 'session-dispatch', source: 'maker-ipc', dispatched: true },
    );
    expect(accepted).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('commits queued accepted side effects only after vendor dispatch succeeds', async () => {
    const accepted = vi.fn();
    const rollback = vi.fn();
    const commit = vi.fn();
    const h = createHarness({
      shouldQueueNewTurn: vi.fn(() => true),
    });

    await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      rawContent: 'Queued success',
      source: 'lead',
      senderLabel: 'Lead',
      meta: { source: 'orca', context: 'queued-commit-test' },
      onAccepted: accepted,
      onAcceptedRollback: rollback,
      onAcceptedCommit: commit,
    });

    const queued = firstQueuedItem(h.queuedItems);
    await h.dispatcher.runQueuedOrcaInterAgentAcceptedCallback('target-session', queued);
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
    await h.dispatcher.settleQueuedOrcaInterAgentAcceptedCallback(
      'target-session',
      {
        persistUserMessage: {
          clientId: queued.clientId,
          content: queued.persistedContent,
          delivery: 'turn',
        },
      },
      { kind: 'session-dispatch', source: 'maker-ipc', dispatched: true },
    );

    expect(commit).toHaveBeenCalledTimes(1);
    expect(rollback).not.toHaveBeenCalled();
  });

  it('returns receipt fields and preserves queued Orca origin metadata', async () => {
    const h = createHarness({
      shouldQueueNewTurn: vi.fn(() => true),
      resolveWorkerSenderLabel: vi.fn(async () => 'Reviewer'),
    });

    const result = await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      rawContent: 'Done',
      source: 'worker',
      senderLabel: 'Worker',
      workerId: 'worker-1',
      meta: { source: 'orca', context: 'receipt-test' },
    });

    expect(result).toEqual({
      ok: true,
      mode: 'queued',
      clientId: 'client-1',
      dispatchOutcome: {
        kind: 'session-dispatch',
        source: 'orca',
        dispatched: true,
        wakeKind: 'queued',
      },
      targetTitle: 'Target Session',
      targetLastUserSendAt: '2026-06-12T01:02:03.000Z',
    });
    expect(h.queuedItems[0]).toMatchObject({
      clientId: 'client-1',
      text: '[From Orca Worker Reviewer (worker_id: worker-1)]\nDone',
      persistedContent: '{"orcaSource":"worker","content":"Done"}',
      origin: {
        kind: 'orca',
        senderLabel: 'Reviewer',
        displayText: 'Done',
      },
    });
  });
  it('names the sending worker by role and worker_id on direct, internal and reserved paths', async () => {
    const resolveWorkerSenderLabel = vi.fn(async () => 'Backend');
    const params = {
      targetSessionId: 'target-session',
      rawContent: '[Auto-bridged: worker 异常终止]\n\nboom',
      source: 'worker' as const,
      senderLabel: 'Worker',
      workerId: 'worker-7',
      meta: { source: 'orca', context: 'worker-prefix-test' },
    };
    const expectedText = '[From Orca Worker Backend (worker_id: worker-7)]\n[Auto-bridged: worker 异常终止]\n\nboom';

    const direct = createHarness({ resolveWorkerSenderLabel });
    await direct.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage(params);
    expect(direct.liveSession.send).toHaveBeenCalledWith(
      { type: 'user', content: expectedText },
      expect.anything(),
    );
    expect(direct.deps.createDbMessage).toHaveBeenCalledWith(
      'target-session',
      expect.objectContaining({
        content: JSON.stringify({ orcaSource: 'worker', content: params.rawContent }),
        agentMeta: expect.objectContaining({
          origin: { kind: 'orca', senderLabel: 'Backend', displayText: params.rawContent },
        }),
      }),
    );
    // 文本与来源标签共用一次 role 反查。
    expect(resolveWorkerSenderLabel).toHaveBeenCalledTimes(1);
    expect(resolveWorkerSenderLabel).toHaveBeenCalledWith('worker-7', '');

    const internal = createHarness({ resolveWorkerSenderLabel, getLiveSession: vi.fn(() => null) });
    await internal.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage(params);
    expect(internal.deps.enqueueQueuedMessage).toHaveBeenCalledWith(
      params.targetSessionId, expect.objectContaining({ text: expectedText }), expect.any(Function),
    );

    const reserved = createHarness({ resolveWorkerSenderLabel });
    await reserved.dispatcher.reserveNextOrcaInterAgentMessage(params);
    expect(reserved.queuedItems[0]).toMatchObject({
      text: expectedText,
      origin: { kind: 'orca', senderLabel: 'Backend' },
    });
  });

  it('keeps worker_id in the prefix and the caller label in origin when the role is unknown', async () => {
    const h = createHarness({ shouldQueueNewTurn: vi.fn(() => true) });

    await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      rawContent: 'Done',
      source: 'worker',
      senderLabel: 'Worker',
      workerId: 'worker-1',
      meta: { source: 'orca', context: 'unknown-role-test' },
    });

    expect(h.queuedItems[0]).toMatchObject({
      text: '[From Orca Worker (worker_id: worker-1)]\nDone',
      origin: { kind: 'orca', senderLabel: 'Worker', displayText: 'Done' },
    });
  });

  it('records the sending Lead or Worker session so the receiver can link back to it', async () => {
    const resolveWorkerSessionLink = vi.fn(async () => ({
      leadSessionId: 'lead-session',
      workerSessionId: 'worker-session',
    }));
    const h = createHarness({ shouldQueueNewTurn: vi.fn(() => true), resolveWorkerSessionLink });

    await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      rawContent: 'Implement feature',
      source: 'lead',
      senderLabel: 'Lead',
      workerId: 'worker-1',
      meta: { source: 'orca', context: 'origin-test' },
    });
    await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      rawContent: 'Done',
      source: 'worker',
      senderLabel: 'Worker',
      workerId: 'worker-1',
      meta: { source: 'orca', context: 'origin-test' },
    });

    expect(resolveWorkerSessionLink).toHaveBeenCalledWith('worker-1');
    expect(h.queuedItems.map((queued) => queued.origin)).toEqual([
      expect.objectContaining({ kind: 'orca', senderSessionId: 'lead-session' }),
      expect.objectContaining({ kind: 'orca', senderSessionId: 'worker-session' }),
    ]);
  });

  it('still delivers when the sender session cannot be resolved', async () => {
    const h = createHarness({
      shouldQueueNewTurn: vi.fn(() => true),
      resolveWorkerSessionLink: vi.fn(async () => {
        throw new Error('db unavailable');
      }),
    });

    const result = await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      rawContent: 'Implement feature',
      source: 'lead',
      senderLabel: 'Lead',
      workerId: 'worker-1',
      meta: { source: 'orca', context: 'origin-test' },
    });

    expect(result).toMatchObject({ ok: true, mode: 'queued' });
    expect(h.queuedItems[0]?.origin).toEqual({
      kind: 'orca',
      senderLabel: 'Lead',
      displayText: 'Implement feature',
    });
  });

  it('builds the standard Orca queue item and runs the reserve hook at the head boundary', async () => {
    const order: string[] = [];
    const reserveNextQueuedMessage = vi.fn(async (_sessionId, item, onReserved) => {
      order.push(`reserved:${item.clientId}`);
      onReserved?.();
      order.push('after-hook');
      return true;
    });
    const h = createHarness({ reserveNextQueuedMessage });

    const result = await h.dispatcher.reserveNextOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      rawContent: 'Replace current task',
      source: 'lead',
      senderLabel: 'Lead',
      workerId: 'worker-1',
      meta: { source: 'orca', context: 'interrupt-test' },
      onReserved: () => order.push('stop-requested'),
    });

    expect(result).toMatchObject({ ok: true, mode: 'queued', clientId: 'client-1' });
    expect(order).toEqual(['reserved:client-1', 'stop-requested', 'after-hook']);
    expect(reserveNextQueuedMessage).toHaveBeenCalledWith(
      'target-session',
      expect.objectContaining({
        clientId: 'client-1',
        origin: { kind: 'orca', senderLabel: 'Lead', displayText: 'Replace current task' },
      }),
      expect.any(Function),
      undefined,
    );
  });

  it.each([false, true])('checks authority after production queue restore before interrupt reservation: revoked=%s', async revoked => {
    let restored = false;
    const stop = vi.fn();
    const inputCoordinator = {
      ensureQueueRestored: async () => { restored = true; },
      isQueueRestored: () => restored,
      reserveNextInput: vi.fn((_id, _item, opts) => { opts.onReserved(); return { reserved: true }; }),
    };
    const source = readFileSync(new URL('../register.ts', import.meta.url), 'utf8');
    const start = source.indexOf('    reserveNextQueuedMessage: async');
    const adapter = source.slice(start, source.indexOf('    sendToSessionInternal,', start));
    const reserveNextQueuedMessage = new Function('inputCoordinator', ts.transpileModule(`return ({${adapter}}).reserveNextQueuedMessage;`, {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText)(inputCoordinator);
    const h = createHarness({ reserveNextQueuedMessage });
    const result = await h.dispatcher.reserveNextOrcaInterAgentMessage({
      targetSessionId: 'target-session', rawContent: 'replacement', source: 'lead', senderLabel: 'Lead',
      meta: { source: 'orca', context: 'restore-check' }, onReserved: stop,
      beforeReserve: async () => { if (restored && revoked) throw new Error('revoked during restore'); },
    });
    expect(restored).toBe(true);
    expect(result.ok).toBe(!revoked);
    expect(inputCoordinator.reserveNextInput).toHaveBeenCalledTimes(revoked ? 0 : 1);
    expect(stop).toHaveBeenCalledTimes(revoked ? 0 : 1);
  });

  it('discards the accepted callback when priority reservation throws', async () => {
    const accepted = vi.fn();
    const h = createHarness({
      reserveNextQueuedMessage: vi.fn(async () => {
        throw new Error('restore failed');
      }),
    });

    await expect(
      h.dispatcher.reserveNextOrcaInterAgentMessage({
        targetSessionId: 'target-session',
        rawContent: 'replacement',
        source: 'lead',
        senderLabel: 'Lead',
        meta: { source: 'orca', context: 'reserve-throw-test' },
        onAccepted: accepted,
      }),
    ).resolves.toMatchObject({ ok: false });

    await h.dispatcher.runQueuedOrcaInterAgentAcceptedCallback('target-session', {
      clientId: 'client-1',
    } as AgentInputQueuedMessage);
    expect(accepted).not.toHaveBeenCalled();
  });
});

it.each(['Do not publish', ''])('ordinary live continuation retains the last accepted intent %j', async live => {
  const h = createHarness();
  h.liveSession.send.mockImplementation(async (message, opts) => {
    expect(opts?.[AUTO_REVIEW_DELEGATED_CONTINUATION]).toBe(true);
    expect(appendAutoReviewUserIntent(live, message.content, opts)).toBe(live);
    await opts?.onAccepted?.();
    return {accepted:true};
  });
  const result=await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({targetSessionId:'target-session',rawContent:'Publish now',source:'lead',senderLabel:'Lead',meta:{source:'orca',context:'ordinary-live'}});
  expect(result.ok).toBe(true);
});

const switchAgentKinds = ['claude-code', 'codex', 'pi'] as const;
const directSwitchCases = (['lead', 'worker'] as const).flatMap((source) =>
  switchAgentKinds.flatMap((from) => switchAgentKinds.filter((to) => to !== from).map((to) => ({
    source, from, to, name: `${source} delivery: ${from} → ${to}`,
  }))),
);
it('passes the dispatcher Agent receipt through the host worker adapter', async () => {
  const register = readFileSync(new URL('../register.ts', import.meta.url), 'utf8');
  const start = register.indexOf('    dispatchWorkerMessage: async ({');
  const end = register.indexOf('    reserveWorkerMessage:', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const dispatched = vi.fn(async () => ({
    ok: true, mode: 'dispatched', agentKind: 'pi', clientId: 'worker-input',
    dispatchOutcome: { kind: 'session-dispatch', source: 'orca', dispatched: true },
  }));
  const compiled = ts.transpileModule(`return ({${register.slice(start, end)}}).dispatchWorkerMessage;`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const dispatchWorkerMessage = new Function('dispatchOrEnqueueOrcaInterAgentMessage', compiled)(dispatched);
  await expect(dispatchWorkerMessage({
    targetSessionId: 'worker-session', message: 'Continue', workerId: 'worker-1',
    dispatchMeta: { source: 'orca', context: 'switched-agent-receipt' },
  })).resolves.toMatchObject({ ok: true, agentKind: 'pi' });
});

it.each(directSwitchCases)('applies a deferred Agent switch before direct $name', async ({ source, from, to }) => {
  const switched = createLiveSession(async (_message, opts) => {
    await opts?.onAccepted?.();
    return { accepted: true };
  }, to);
  let current: ReturnType<typeof createLiveSession>;
  let handoff: string | null = null;
  const consume = vi.fn(() => { handoff = null; });
  const h = createHarness({
    applyPendingAgentSwitch: vi.fn(async () => {
      h.order.push('apply-switch');
      if (current !== switched) handoff = 'History from the previous engine';
      current = switched;
    }),
    getLiveSession: () => current,
    hasPendingAgentSwitch: () => false,
    peekPendingHandoff: async () => handoff,
    consumePendingHandoff: consume,
  });
  const previous = createLiveSession(async () => { throw new Error('must not send to the previous Agent'); }, from);
  current = previous;

  const message = {
    targetSessionId: 'target-session',
    rawContent: 'Continue on the new engine',
    source,
    senderLabel: 'Lead',
    meta: { source: 'orca', context: 'agent-switch-boundary' },
  };
  const result = await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage(message);

  expect(result).toMatchObject({ ok: true, mode: 'dispatched', agentKind: to });
  expect(h.deps.applyPendingAgentSwitch).toHaveBeenCalledWith('target-session');
  expect(previous.send).not.toHaveBeenCalled();
  expect(current.agentKind).toBe(to);
  const content = switched.send.mock.calls[0]?.[0].content;
  expect(content).toContain('History from the previous engine');
  expect(content).toContain(source === 'lead' ? '[From Orca Lead]' : '[From Orca Worker]');
  expect(content).toContain(message.rawContent);
  expect(consume).toHaveBeenCalledExactlyOnceWith('target-session');
  expect(h.deps.createDbMessage).toHaveBeenCalledWith('target-session', expect.objectContaining({
    content: JSON.stringify({ orcaSource: source, content: message.rawContent }),
  }));
  await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage(message);
  expect(switched.send.mock.calls[1]?.[0].content).not.toContain('History from the previous engine');
  expect(consume).toHaveBeenCalledTimes(1);
});

it.each([true, false])('blocks delivery and resume when a failed switch retains its intent (live=%s)', async (hasLive) => {
  const accepted = vi.fn();
  const h = createHarness({
    applyPendingAgentSwitch: vi.fn(async () => undefined),
    hasPendingAgentSwitch: () => true,
  });
  if (!hasLive) vi.mocked(h.deps.getLiveSession).mockReturnValue(undefined);
  const result = await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
    targetSessionId: 'target-session', rawContent: 'Retry after recovery', source: 'lead', senderLabel: 'Lead',
    meta: { source: 'orca', context: 'pending-switch' }, onAccepted: accepted,
  });
  expect(result).toMatchObject({ ok: false, dispatchOutcome: { code: 'SEND_FAILED' } });
  expect(h.deps.hasPendingAgentSwitch?.('target-session')).toBe(true);
  expect(h.liveSession.send).not.toHaveBeenCalled();
  expect(h.deps.sendToSessionInternal).not.toHaveBeenCalled();
  expect(h.deps.createDbMessage).not.toHaveBeenCalled();
  expect(accepted).not.toHaveBeenCalled();
});

it.each(['rejected', 'throw', 'running'] as const)('keeps history for retry after %s direct delivery', async (failure) => {
  const consume = vi.fn();
  const h = createHarness({
    peekPendingHandoff: async () => 'Pending history',
    consumePendingHandoff: consume,
  });
  h.liveSession.send.mockImplementation(async () => {
    if (failure === 'rejected') return { accepted: false, reason: 'cancelled-before-dispatch' };
    if (failure === 'running') throw Object.assign(new Error('already running'), { code: 'SESSION_RUNNING' });
    throw new Error('transport failed');
  });
  const result = await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
    targetSessionId: 'target-session', rawContent: 'Continue', source: 'lead', senderLabel: 'Lead',
    meta: { source: 'orca', context: 'handoff-retry' },
  });
  expect(result.ok).toBe(failure === 'running');
  expect(h.liveSession.send.mock.calls[0]?.[0].content).toContain('Pending history');
  expect(consume).not.toHaveBeenCalled();
  expect(h.deps.createDbMessage).not.toHaveBeenCalled();
  if (failure === 'running') {
    expect(result).toMatchObject({ mode: 'queued' });
    expect(firstQueuedItem(h.queuedItems).text).not.toContain('Pending history');
    expect(firstQueuedItem(h.queuedItems).persistedContent).not.toContain('Pending history');
  }
});

// 测试价值：Orca 系统兜底回报在 Lead 忙碌时逐条入队，旧实现派发时仍逐条唤醒 Lead，
// 多 Worker 同时完成会制造多个本可合并的 turn。规则依据：orca-team-architecture.md
// 「消息派发与 auto-bridge」与用户批准的“仅系统兜底回报合批”。现有 dispatcher 测试只覆盖
// 单条派发/插话，coordinator 手动 merge 测试不覆盖 drain 前自动合批。最小失败输入：两条连续
// origin.autoBridge=true 的 Worker 回报；tier=unit，直接调用生产 coordinator/dispatcher。
describe('Orca auto-bridge queue coalescing at dispatch', () => {
  const sid = 'lead-auto-bridge';

  function report(clientId: string, workerId: string, body: string, status: 'done' | 'error' = 'done'): AgentInputQueuedMessage {
    const raw = `[Auto-bridged: worker ${status === 'done' ? '已完成，系统自动回传结果' : '异常终止'}]\n\n${body}`;
    const text = `[From Orca Worker ${workerId} (worker_id: ${workerId})]\n${raw}`;
    const persistedContent = JSON.stringify({ orcaSource: 'worker', content: raw });
    return {
      clientId,
      text,
      persistedContent,
      model: 'gpt-5.4',
      effort: 'medium',
      permissionMode: 'bypassPermissions',
      workingDir: 'C:\\repo',
      chatMessage: { clientId, role: 'user', content: persistedContent, createdAt: '2026-11-10T00:00:00.000Z' },
      createOpts: { agentKind: 'codex', workingDir: 'C:\\repo', model: 'gpt-5.4', permissionMode: 'bypassPermissions' },
      origin: {
        kind: 'orca', senderLabel: workerId, senderSessionId: `${workerId}-session`,
        displayText: raw, autoBridge: true,
      },
    };
  }

  function createQueueHarness(opts: { restored?: AgentInputQueuedMessage[]; failFirstDispatch?: 'session-running'; canRestoreReport?: (item: AgentInputQueuedMessage) => boolean; awaitPersistence?: () => Promise<void> } = {}) {
    let nextId = 0;
    let dispatchCalls = 0;
    const sent: Array<{ message: AgentInputMakerMessage; opts: AgentInputSendOpts }> = [];
    const snapshots: AgentInputQueuedMessage[][] = [];
    let running = true;
    const discarded = vi.fn();
    const steered = vi.fn(async () => {});
    const coordinator = new AgentInputCoordinator({
      sendToAgent: async (_sessionId, message, _createOpts, sendOpts) => {
        dispatchCalls += 1;
        if (opts.failFirstDispatch === 'session-running' && dispatchCalls === 1) {
          throw Object.assign(new Error('[SESSION_RUNNING] busy'), { code: 'SESSION_RUNNING' });
        }
        sent.push({ message, opts: sendOpts });
        await sendOpts.persistUserMessage?.onPersisted?.();
        running = true;
        return { kind: 'session-dispatch', source: 'test', dispatched: true };
      },
      steerToAgent: steered,
      abortSession: async () => {},
      isTurnRunning: () => running,
      hasPendingInteraction: () => false,
      getAgentKind: () => 'codex',
      getSdkSessionId: async () => undefined,
      emitProjection: () => {},
      persistQueueSnapshot: (_sessionId, items) => { snapshots.push(JSON.parse(JSON.stringify(items))); },
      awaitQueuePersistence: opts.awaitPersistence ?? (async () => {}),
      canRestoreOrcaReport: async (_sessionId, item) => opts.canRestoreReport?.(item) ?? true,
      onDiscardedQueuedMessage: discarded,
      loadQueueSnapshot: async () => opts.restored ?? [],
      loadClearBoundary: async () => null,
      touchUserSend: async () => {},
      createUserMessage: vi.fn(),
    });
    const h = createHarness({
      createId: () => `q-${++nextId}`,
      getLiveSession: () => undefined,
      shouldQueueNewTurn: () => running,
      enqueueQueuedMessage: (sessionId, item) => { coordinator.enqueue(sessionId, item); },
      // 真实链路里 dispatcher 经 resolveWorkerSessionLink 写入 senderSessionId；夹具必须注入，
      // 否则产出的 origin 天生无来源，会掩盖“合批丢授权证据”这条 P1。
      resolveWorkerSessionLink: async (workerId) => ({ leadSessionId: sid, workerSessionId: `${workerId}-session` }),
    });
    return { coordinator, sent, steered, snapshots, discarded, dispatcher: h.dispatcher, setRunning: (value: boolean) => { running = value; } };
  }

  function sentText(message: AgentInputMakerMessage): string {
    return typeof message === 'string' ? message : String(message.content);
  }

  // #9346 integration regression, unit: real dispatcher receipts were stripped
  // by host coalescing. Legacy batch fixtures have no durable report metadata.
  // Minimal input: two cold Worker reports; a restart must retain the whole
  // batch and resume without a new user message, with every relationship intact.
  it('retains durable member identities and automatically restores the coalesced report', async () => {
    const h = createQueueHarness();
    await h.coordinator.ensureQueueRestored(sid);
    for (const workerId of ['backend', 'frontend']) {
      await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
        targetSessionId: sid, source: 'worker', senderLabel: workerId, workerId,
        rawContent: `${workerId} complete`, autoBridge: true,
        meta: { source: 'maker-ipc/auto-bridge', context: 'durable-batch' },
      });
    }
    h.setRunning(false);
    h.coordinator.wakeSession(sid, 'idle');
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    const snapshot = h.snapshots.find(items => items[0]?.origin?.kind === 'orca'
      && items[0].origin.autoBridgeBatchCount === 2);
    expect(snapshot?.[0]?.orcaReportDelivery?.members).toEqual([
      { clientId: 'q-1', workerId: 'backend', senderSessionId: 'backend-session' },
      { clientId: 'q-2', workerId: 'frontend', senderSessionId: 'frontend-session' },
    ]);
    expect(snapshot?.[0]?.mergedDeliveryClientIds).toEqual(['q-2']);
    const retained = JSON.parse(JSON.stringify(snapshot)) as AgentInputQueuedMessage[];
    expect(retained[0]!.orcaReportDelivery!.recoveryBlocked).toBeUndefined();
    const restarted = createQueueHarness({ restored: retained });
    restarted.setRunning(false);
    await restarted.coordinator.ensureQueueRestored(sid);
    await vi.waitFor(() => expect(restarted.sent).toHaveLength(1));
    expect(sentText(restarted.sent[0]!.message)).toContain('backend complete');
    expect(sentText(restarted.sent[0]!.message)).toContain('frontend complete');
  });

  // #9346, unit: Worker-requested public merges must transfer durable IDs by
  // the same persistence boundary as automatic batching, without inheriting
  // automatic recovery. The previous auto-only case never used this entry.
  it.each(['healthy', 'drain-write-failed', 'steer-write-failed'] as const)('retains durable identities through a public merge and a later edit: %s', async mode => {
    let failed = false;
    const persisted = vi.fn(async () => { if (failed) throw new Error('snapshot unavailable'); });
    const h = createQueueHarness({ awaitPersistence: persisted });
    await h.coordinator.ensureQueueRestored(sid);
    for (const clientId of ['r1', 'r2']) h.coordinator.enqueue(sid, {
      ...report(clientId, 'backend', clientId), durableDelivery: true,
      orcaReportDelivery: { workerId: 'backend' },
    });
    expect(h.coordinator.mergeQueuedMessagesAtomically(sid, ['r1', 'r2'], rows => ({
      ...rows[0]!, text: 'merged reports', persistedContent: 'merged reports',
      chatMessage: { ...rows[0]!.chatMessage, content: 'merged reports' },
    })).merged).toBe(true);
    expect(h.snapshots.at(-1)?.[0]).toMatchObject({ clientId: 'r1', mergedDeliveryClientIds: ['r2'], durableDelivery: true });
    expect(h.snapshots.at(-1)?.[0].orcaReportDelivery).toBeUndefined();
    expect(h.discarded).toHaveBeenCalledWith(sid, expect.objectContaining({ clientId: 'r2' }), { mergedInto: 'r1' });
    h.coordinator.updateText(sid, 'r1', 'owner edit');
    expect(h.snapshots.at(-1)?.[0]).toMatchObject({ text: 'owner edit', mergedDeliveryClientIds: ['r2'] });
    expect(h.coordinator.getProjection(sid).pendingQueue[0]).not.toHaveProperty('mergedDeliveryClientIds');
    if (mode !== 'healthy') {
      failed = true;
      if (mode === 'steer-write-failed') {
        await h.coordinator.steer(sid, h.snapshots.at(-1)![0]!, { removeFromQueue: true });
      } else {
        h.setRunning(false);
        h.coordinator.wakeSession(sid, 'idle');
        await vi.waitFor(() => expect(persisted).toHaveBeenCalled());
        await new Promise(resolve => setImmediate(resolve));
      }
      expect(h.sent).toHaveLength(0);
      expect(h.steered).not.toHaveBeenCalled();
      expect(h.snapshots.at(-1)?.[0]?.mergedDeliveryClientIds).toEqual(['r2']);
    }
  });

  it('merges only the contiguous auto-bridge prefix when the Lead becomes idle', async () => {
    const h = createQueueHarness();
    await h.coordinator.ensureQueueRestored(sid);
    const first = report('r1', 'backend', 'API ready');
    const second = report('r2', 'frontend', 'UI ready', 'error');
    const tail = { ...report('r3', 'tester', 'tests passed'), origin: { kind: 'orca' as const, senderLabel: 'Lead', displayText: 'next task' } };
    h.coordinator.enqueue(sid, first);
    h.coordinator.enqueue(sid, second);
    h.coordinator.enqueue(sid, tail);
    expect(h.coordinator.getProjection(sid).pendingQueue.map(item => item.clientId)).toEqual(['r1', 'r2', 'r3']);
    expect(h.sent).toHaveLength(0);

    h.setRunning(false);
    h.coordinator.wakeSession(sid, 'idle');
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));

    const dispatched = h.sent[0]!;
    const text = sentText(dispatched.message);
    expect(text.startsWith('[Auto-bridged batch: 2 worker reports]\n\n')).toBe(true);
    expect(text).toContain(first.text);
    expect(text).toContain(second.text);
    expect(dispatched.opts.persistUserMessage?.clientId).toBe('r1');
    expect(dispatched.opts.persistUserMessage?.origin).toMatchObject({ kind: 'orca', autoBridge: true, autoBridgeBatchCount: 2, senderLabel: '', senderSessionId: 'backend-session' });
    // P1 回归：批次仍保留首条来源作 Host 团队授权证据（taskActionHost.readOrcaTeam 承重，见 taskActionAuthorization.test.ts）。
    expect(h.coordinator.getAcceptedInputProvenance(sid)).toMatchObject({ originKind: 'orca', orcaSenderSessionId: 'backend-session' });
    const persisted = JSON.parse(dispatched.opts.persistUserMessage?.content ?? '{}');
    expect(persisted.orcaSource).toBe('worker');
    // 可见正文与单条一致：留 role 前缀、去 worker_id；worker_id 只在 agent text 里供路由。
    expect(persisted.content).toContain('[From Orca Worker backend]');
    expect(persisted.content).toContain('[From Orca Worker frontend]');
    expect(persisted.content).not.toContain('(worker_id:');
    expect(persisted.content).toContain('API ready');
    expect(persisted.content).toContain('UI ready');
    expect(persisted.content).toContain('异常终止');
    expect(h.coordinator.getProjection(sid).pendingQueue.map(item => item.clientId)).toEqual(['r3']);
    expect(h.snapshots.some(items => items.length === 2 && items[0]?.clientId === 'r1' && items[0]?.origin?.kind === 'orca' && items[0].origin.autoBridgeBatchCount === 2)).toBe(true);
  });

  it('stamps only host auto-bridge reports on queued and direct paths', async () => {
    const params = { targetSessionId: 'target-session', rawContent: 'done', source: 'worker' as const, senderLabel: 'Worker', workerId: 'worker-1', meta: { source: 'orca', context: 'auto-bridge-mark' } };
    const queued = createHarness({ shouldQueueNewTurn: () => true });
    await queued.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({ ...params, autoBridge: true });
    expect(firstQueuedItem(queued.queuedItems).origin).toMatchObject({ kind: 'orca', autoBridge: true });
    const manual = createHarness({ shouldQueueNewTurn: () => true });
    await manual.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage(params);
    const manualOrigin = firstQueuedItem(manual.queuedItems).origin;
    expect(manualOrigin?.kind === 'orca' ? manualOrigin.autoBridge : undefined).toBeUndefined();
    const direct = createHarness();
    await direct.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({ ...params, autoBridge: true });
    expect(direct.deps.createDbMessage).toHaveBeenCalledWith('target-session', expect.objectContaining({
      agentMeta: expect.objectContaining({ origin: expect.objectContaining({ kind: 'orca', autoBridge: true }) }),
    }));
  });

  it('keeps worker_id in agent text for routing, hides it from the visible body, and preserves authorization evidence', async () => {
    const h = createQueueHarness();
    await h.coordinator.ensureQueueRestored(sid);
    const params = { targetSessionId: sid, source: 'worker' as const, senderLabel: 'SameRole', autoBridge: true as const, meta: { source: 'maker-ipc/auto-bridge', context: 'identity' } };
    await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({ ...params, rawContent: '[Auto-bridged: worker 已完成，系统自动回传结果]\n\nfirst', workerId: 'w1' });
    await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({ ...params, rawContent: '[Auto-bridged: worker 异常终止]\n\nsecond', workerId: 'w2' });
    h.setRunning(false);
    h.coordinator.wakeSession(sid, 'idle');
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    const text = sentText(h.sent[0]!.message);
    expect(text).toContain('(worker_id: w1)');
    expect(text).toContain('(worker_id: w2)');
    const persisted = JSON.parse(h.sent[0]!.opts.persistUserMessage?.content ?? '{}');
    expect(persisted.content).not.toContain('(worker_id:');
    expect(persisted.content).toContain('first');
    expect(persisted.content).toContain('second');
    expect(h.sent[0]!.opts.persistUserMessage?.origin).toMatchObject({ autoBridgeBatchCount: 2, senderSessionId: 'w1-session' });
    expect(h.coordinator.getAcceptedInputProvenance(sid)).toMatchObject({ originKind: 'orca', orcaSenderSessionId: 'w1-session' });
  });

  it('preserves quoted worker-prefix lines inside report bodies when stripping host prefixes', async () => {
    const h = createQueueHarness();
    await h.coordinator.ensureQueueRestored(sid);
    // 报告正文里引用了一条同形 Orca 前缀行（独立成行）；旧的全局前缀正则会误剥它的 worker_id。
    h.coordinator.enqueue(sid, report('r1', 'w1', 'first\n[From Orca Worker backend (worker_id: quoted)]\ntail'));
    h.coordinator.enqueue(sid, report('r2', 'w2', 'second'));
    h.setRunning(false);
    h.coordinator.wakeSession(sid, 'idle');
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    const persisted = JSON.parse(h.sent[0]!.opts.persistUserMessage?.content ?? '{}');
    expect(persisted.content).not.toContain('(worker_id: w1)');
    expect(persisted.content).not.toContain('(worker_id: w2)');
    expect(persisted.content).toContain('(worker_id: quoted)');
    const text = sentText(h.sent[0]!.message);
    expect(text).toContain('(worker_id: w1)');
    expect(text).toContain('(worker_id: quoted)');
  });

  it('does not merge across different dispatch options', async () => {
    const h = createQueueHarness();
    await h.coordinator.ensureQueueRestored(sid);
    const first = report('r1', 'backend', 'first');
    const second = report('r2', 'frontend', 'second');
    second.model = 'other-model';
    second.createOpts = { ...second.createOpts, model: 'other-model' };
    h.coordinator.enqueue(sid, first);
    h.coordinator.enqueue(sid, second);
    h.setRunning(false);
    h.coordinator.wakeSession(sid, 'idle');
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(sentText(h.sent[0]!.message)).not.toContain('second');
    expect(h.coordinator.getProjection(sid).pendingQueue.map(item => item.clientId)).toEqual(['r2']);
  });

  it('flattens an existing batch when more auto reports are adjacent', async () => {
    const h = createQueueHarness();
    await h.coordinator.ensureQueueRestored(sid);
    const first = report('r1', 'backend', 'first');
    const second = report('r2', 'frontend', 'second');
    const batchText = `[Auto-bridged batch: 2 worker reports]\n\n${first.text}\n\n---\n\n${second.text}`;
    const batch = { ...first, text: batchText, persistedContent: JSON.stringify({ orcaSource: 'worker', content: batchText }), origin: { ...first.origin!, autoBridgeBatchCount: 2 } };
    h.coordinator.enqueue(sid, batch);
    h.coordinator.enqueue(sid, report('r3', 'tester', 'third'));
    h.setRunning(false);
    h.coordinator.wakeSession(sid, 'idle');
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    const text = sentText(h.sent[0]!.message);
    expect(text.startsWith('[Auto-bridged batch: 3 worker reports]\n\n')).toBe(true);
    expect(text).not.toContain('[Auto-bridged batch: 2 worker reports]');
    expect(text).toContain('third');
    expect(h.sent[0]!.opts.persistUserMessage?.origin).toMatchObject({ autoBridgeBatchCount: 3 });
  });

  it('coalesces restored auto reports before a later user input', async () => {
    const restored = [report('r1', 'backend', 'first'), report('r2', 'frontend', 'second')];
    const h = createQueueHarness({ restored });
    await h.coordinator.ensureQueueRestored(sid);
    h.setRunning(false);
    h.coordinator.enqueue(sid, { ...report('user', 'owner', 'go'), text: 'go', persistedContent: 'go', origin: undefined });
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    const text = sentText(h.sent[0]!.message);
    expect(text).toContain(restored[0]!.text);
    expect(text).toContain(restored[1]!.text);
    expect(h.sent[0]!.opts.persistUserMessage?.clientId).toBe('r1');
    expect(h.coordinator.getProjection(sid).pendingQueue.map(item => item.clientId)).toEqual(['user']);
  });

  // #9346 P1, unit: only the restored head was checked before batching; a
  // revoked tail could cross its pause with that head. Existing fixtures grant
  // both reports. Two restored reports with just B revoked must dispatch A only.
  it('leaves an ineligible restored tail paused while delivering the eligible head', async () => {
    const restored = [report('r1', 'backend', 'allowed'), report('r2', 'frontend', 'revoked')]
      .map(item => ({ ...item, durableDelivery: true as const,
        orcaReportDelivery: { workerId: item.clientId === 'r1' ? 'backend' : 'frontend' } }));
    const h = createQueueHarness({ restored, canRestoreReport: item => item.clientId === 'r1' });
    h.setRunning(false);
    await h.coordinator.ensureQueueRestored(sid);
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(sentText(h.sent[0]!.message)).toContain('allowed');
    expect(sentText(h.sent[0]!.message)).not.toContain('revoked');
    expect(h.coordinator.getProjection(sid).pendingQueue.map(item => item.clientId)).toEqual(['r2']);
    h.setRunning(false);
    h.coordinator.wakeSession(sid, 'idle');
    await Promise.resolve();
    expect(h.sent).toHaveLength(1);
    expect(h.coordinator.getProjection(sid).queuePaused).toBe(true);
  });

  it('never merges across a user message', async () => {
    const h = createQueueHarness();
    await h.coordinator.ensureQueueRestored(sid);
    h.coordinator.enqueue(sid, report('r1', 'backend', 'first'));
    h.coordinator.enqueue(sid, { ...report('user', 'owner', 'user input'), origin: undefined });
    h.coordinator.enqueue(sid, report('r2', 'frontend', 'second'));
    h.setRunning(false);
    h.coordinator.wakeSession(sid, 'idle');
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(sentText(h.sent[0]!.message)).toContain('first');
    expect(sentText(h.sent[0]!.message)).not.toContain('second');
    expect(h.coordinator.getProjection(sid).pendingQueue.map(item => item.clientId)).toEqual(['user', 'r2']);
  });

  it('does not merge ordinary Orca messages without the host auto-bridge mark', async () => {
    const h = createQueueHarness();
    await h.coordinator.ensureQueueRestored(sid);
    const first = report('r1', 'backend', 'manual report');
    const second = report('r2', 'frontend', 'another manual report');
    h.coordinator.enqueue(sid, { ...first, origin: { kind: 'orca', senderLabel: 'backend', displayText: 'manual report' } });
    h.coordinator.enqueue(sid, { ...second, origin: { kind: 'orca', senderLabel: 'frontend', displayText: 'another manual report' } });
    h.setRunning(false);
    h.coordinator.wakeSession(sid, 'idle');
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(sentText(h.sent[0]!.message)).not.toContain('another manual report');
    expect(h.coordinator.getProjection(sid).pendingQueue.map(item => item.clientId)).toEqual(['r2']);
  });

  it('keeps original rows when a persisted payload cannot be batched', async () => {
    const h = createQueueHarness();
    await h.coordinator.ensureQueueRestored(sid);
    const malformed = { ...report('r1', 'backend', 'first'), persistedContent: '{not json' };
    h.coordinator.enqueue(sid, malformed);
    h.coordinator.enqueue(sid, report('r2', 'frontend', 'second'));
    h.setRunning(false);
    h.coordinator.wakeSession(sid, 'idle');
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(h.sent[0]!.opts.persistUserMessage?.clientId).toBe('r1');
    expect(h.sent[0]!.opts.persistUserMessage?.content).toBe('{not json');
    expect(h.coordinator.getProjection(sid).pendingQueue.map(item => item.clientId)).toEqual(['r2']);
  });

  it('does not coalesce or drain a paused queue', async () => {
    const h = createQueueHarness();
    await h.coordinator.ensureQueueRestored(sid);
    h.coordinator.enqueue(sid, report('r1', 'backend', 'first'));
    h.coordinator.enqueue(sid, report('r2', 'frontend', 'second'));
    h.coordinator.stop(sid, { keepQueue: true, pauseQueue: true });
    h.setRunning(false);
    h.coordinator.wakeSession(sid, 'idle');
    await Promise.resolve();
    expect(h.sent).toHaveLength(0);
    expect(h.coordinator.getProjection(sid).pendingQueue.map(item => item.clientId)).toEqual(['r1', 'r2']);
  });

  it('does not merge when a non-head target is edit-locked', async () => {
    const h = createQueueHarness();
    await h.coordinator.ensureQueueRestored(sid);
    h.coordinator.enqueue(sid, report('r1', 'backend', 'first'));
    h.coordinator.enqueue(sid, report('r2', 'frontend', 'second'));
    // 锁的是非队首的第二条：drain 的队首编辑锁闸门拦不到，必须由合批预检拦下。
    h.coordinator.setEditLock(sid, 'r2', true);
    h.setRunning(false);
    h.coordinator.wakeSession(sid, 'idle');
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(sentText(h.sent[0]!.message)).toContain('first');
    expect(sentText(h.sent[0]!.message)).not.toContain('second');
    expect(h.coordinator.getProjection(sid).pendingQueue.map(item => item.clientId)).toEqual(['r2']);
  });

  const unbatchableHeadCases: Array<{ name: string; mutate: (r: AgentInputQueuedMessage) => void }> = [
    { name: 'zero batch count', mutate: r => { if (r.origin?.kind === 'orca') r.origin.autoBridgeBatchCount = 0; } },
    { name: 'negative batch count', mutate: r => { if (r.origin?.kind === 'orca') r.origin.autoBridgeBatchCount = -1; } },
    { name: 'fractional batch count', mutate: r => { if (r.origin?.kind === 'orca') r.origin.autoBridgeBatchCount = 1.5; } },
    { name: 'an attachment', mutate: r => { r.files = [{ id: 'f1', name: 'a.png', path: '/a.png', ext: '.png', size: 1, category: 'image', mimeType: 'image/png' }]; } },
    { name: 'a mention', mutate: r => { r.mentions = [{ type: 'file', name: 'a', path: '/a' }]; } },
    { name: 'a session reference', mutate: r => { r.sessionRefs = [{ sessionId: 'other' }]; } },
    { name: 'an agent reference', mutate: r => { r.agentReferences = [{ kind: 'session', start: 0, end: 1, href: 'cindy://session/other', sessionId: 'other', title: 'Other' }]; } },
  ];
  it.each(unbatchableHeadCases)('does not merge a head report carrying $name', async ({ mutate }) => {
    const h = createQueueHarness();
    await h.coordinator.ensureQueueRestored(sid);
    const first = report('r1', 'backend', 'first');
    mutate(first);
    h.coordinator.enqueue(sid, first);
    h.coordinator.enqueue(sid, report('r2', 'frontend', 'second'));
    h.setRunning(false);
    h.coordinator.wakeSession(sid, 'idle');
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    // 带附件/引用的队首仍正常单独派发，但不参与合批；第二条留在队里。
    expect(h.sent[0]!.opts.persistUserMessage?.clientId).toBe('r1');
    expect(h.coordinator.getProjection(sid).pendingQueue.map(item => item.clientId)).toEqual(['r2']);
  });

  it('does not merge when a non-head report carries an attachment', async () => {
    const h = createQueueHarness();
    await h.coordinator.ensureQueueRestored(sid);
    const second = report('r2', 'frontend', 'second');
    second.files = [{ id: 'f1', name: 'a.png', path: '/a.png', ext: '.png', size: 1, category: 'image', mimeType: 'image/png' }];
    h.coordinator.enqueue(sid, report('r1', 'backend', 'first'));
    h.coordinator.enqueue(sid, second);
    h.setRunning(false);
    h.coordinator.wakeSession(sid, 'idle');
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    // 队首干净但第二条带附件：合批在第二条处 break，队首单独派发。
    expect(h.sent[0]!.opts.persistUserMessage?.clientId).toBe('r1');
    expect(sentText(h.sent[0]!.message)).not.toContain('second');
    expect(h.coordinator.getProjection(sid).pendingQueue.map(item => item.clientId)).toEqual(['r2']);
  });

  const configMismatchCases: Array<{ name: string; mutate: (r: AgentInputQueuedMessage) => void }> = [
    { name: 'effort', mutate: r => { r.effort = 'high'; } },
    { name: 'permissionMode', mutate: r => { r.permissionMode = 'auto'; } },
    { name: 'workingDir', mutate: r => { r.workingDir = 'D:\\other'; } },
    { name: 'createOpts', mutate: r => { r.createOpts = { ...r.createOpts, model: 'other-model' }; } },
    { name: 'vendorOptions', mutate: r => { r.vendorOptions = { foo: 'bar' }; } },
  ];
  it.each(configMismatchCases)('does not merge across a differing $name', async ({ mutate }) => {
    const h = createQueueHarness();
    await h.coordinator.ensureQueueRestored(sid);
    const second = report('r2', 'frontend', 'second');
    mutate(second);
    h.coordinator.enqueue(sid, report('r1', 'backend', 'first'));
    h.coordinator.enqueue(sid, second);
    h.setRunning(false);
    h.coordinator.wakeSession(sid, 'idle');
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(sentText(h.sent[0]!.message)).not.toContain('second');
    expect(h.coordinator.getProjection(sid).pendingQueue.map(item => item.clientId)).toEqual(['r2']);
  });

  it('requeues a failed batch as one item and re-flattens it with a later report', async () => {
    const h = createQueueHarness({ failFirstDispatch: 'session-running' });
    await h.coordinator.ensureQueueRestored(sid);
    h.coordinator.enqueue(sid, report('r1', 'backend', 'first'));
    h.coordinator.enqueue(sid, report('r2', 'frontend', 'second'));
    h.setRunning(false);
    h.coordinator.wakeSession(sid, 'idle');
    // 首次派发撞 SESSION_RUNNING：整批回队（不丢、不拆），无阻塞 recovery。
    await vi.waitFor(() => {
      const origin = h.coordinator.getProjection(sid).pendingQueue[0]?.origin;
      expect(origin?.kind === 'orca' ? origin.autoBridgeBatchCount : undefined).toBe(2);
    });
    expect(h.sent).toHaveLength(0);
    h.coordinator.enqueue(sid, report('r3', 'tester', 'third'));
    h.coordinator.wakeSession(sid, 'retry');
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    const text = sentText(h.sent[0]!.message);
    expect(text.startsWith('[Auto-bridged batch: 3 worker reports]\n\n')).toBe(true);
    expect(text).not.toContain('[Auto-bridged batch: 2 worker reports]');
    expect(text).toContain('first');
    expect(text).toContain('second');
    expect(text).toContain('third');
    expect(h.sent[0]!.opts.persistUserMessage?.origin).toMatchObject({ autoBridgeBatchCount: 3 });
  });

  it('keeps every worker_id out of the visible body when a requeued batch is re-merged', async () => {
    const h = createQueueHarness({ failFirstDispatch: 'session-running' });
    await h.coordinator.ensureQueueRestored(sid);
    h.coordinator.enqueue(sid, report('r1', 'w1', 'first'));
    h.coordinator.enqueue(sid, report('r2', 'w2', 'second'));
    h.setRunning(false);
    h.coordinator.wakeSession(sid, 'idle');
    await vi.waitFor(() => {
      const origin = h.coordinator.getProjection(sid).pendingQueue[0]?.origin;
      expect(origin?.kind === 'orca' ? origin.autoBridgeBatchCount : undefined).toBe(2);
    });
    h.coordinator.enqueue(sid, report('r3', 'w3', 'third'));
    h.coordinator.wakeSession(sid, 'retry');
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    const persisted = JSON.parse(h.sent[0]!.opts.persistUserMessage?.content ?? '{}');
    expect(persisted.content).not.toContain('(worker_id:');
    expect(persisted.content).toContain('first');
    expect(persisted.content).toContain('second');
    expect(persisted.content).toContain('third');
    const text = sentText(h.sent[0]!.message);
    expect(text).toContain('(worker_id: w1)');
    expect(text).toContain('(worker_id: w2)');
    expect(text).toContain('(worker_id: w3)');
  });

  it('does not merge a retry recovery copy with a fresh report', async () => {
    const h = createQueueHarness();
    await h.coordinator.ensureQueueRestored(sid);
    h.coordinator.enqueue(sid, { ...report('a', 'w1', 'A'), retrySourceClientId: 'orig-a' });
    h.coordinator.enqueue(sid, report('b', 'w2', 'B'));
    h.setRunning(false);
    h.coordinator.wakeSession(sid, 'idle');
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(sentText(h.sent[0]!.message)).not.toContain('[Auto-bridged batch:');
    expect(sentText(h.sent[0]!.message)).toContain('A');
    // 恢复副本单独派发，B 未被合批吞掉，仍留在队列等待送达。
    expect(h.coordinator.getProjection(sid).pendingQueue.map((i) => i.clientId)).toEqual(['b']);
  });

  it('preserves report order in the batch', async () => {
    const h = createQueueHarness();
    await h.coordinator.ensureQueueRestored(sid);
    h.coordinator.enqueue(sid, report('r1', 'backend', 'alpha'));
    h.coordinator.enqueue(sid, report('r2', 'frontend', 'beta'));
    h.coordinator.enqueue(sid, report('r3', 'tester', 'gamma'));
    h.setRunning(false);
    h.coordinator.wakeSession(sid, 'idle');
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    const text = sentText(h.sent[0]!.message);
    expect(text.indexOf('alpha')).toBeLessThan(text.indexOf('beta'));
    expect(text.indexOf('beta')).toBeLessThan(text.indexOf('gamma'));
    expect(text.indexOf('(worker_id: backend)')).toBeLessThan(text.indexOf('(worker_id: frontend)'));
    expect(text.indexOf('(worker_id: frontend)')).toBeLessThan(text.indexOf('(worker_id: tester)'));
    expect(h.sent[0]!.opts.persistUserMessage?.origin).toMatchObject({ autoBridgeBatchCount: 3 });
  });

  it('caps a batch at the item limit and leaves the rest for the next turn', async () => {
    const h = createQueueHarness();
    await h.coordinator.ensureQueueRestored(sid);
    for (let i = 1; i <= AUTO_BRIDGE_BATCH_MAX_ITEMS + 1; i++) h.coordinator.enqueue(sid, report(`r${i}`, `w${i}`, `body ${i}`));
    h.setRunning(false);
    h.coordinator.wakeSession(sid, 'idle');
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(h.sent[0]!.opts.persistUserMessage?.origin).toMatchObject({ autoBridgeBatchCount: AUTO_BRIDGE_BATCH_MAX_ITEMS });
    expect(h.coordinator.getProjection(sid).pendingQueue.map(i => i.clientId)).toEqual([`r${AUTO_BRIDGE_BATCH_MAX_ITEMS + 1}`]);
  });

  it('does not let a requeued full batch absorb more reports on retry', async () => {
    const h = createQueueHarness({ failFirstDispatch: 'session-running' });
    await h.coordinator.ensureQueueRestored(sid);
    for (let i = 1; i <= AUTO_BRIDGE_BATCH_MAX_ITEMS; i++) h.coordinator.enqueue(sid, report(`r${i}`, `w${i}`, `body ${i}`));
    h.setRunning(false);
    h.coordinator.wakeSession(sid, 'idle');
    // 首派撞 SESSION_RUNNING：count=8 的批次整体回队为一行。
    await vi.waitFor(() => {
      const origin = h.coordinator.getProjection(sid).pendingQueue[0]?.origin;
      expect(origin?.kind === 'orca' ? origin.autoBridgeBatchCount : undefined).toBe(AUTO_BRIDGE_BATCH_MAX_ITEMS);
    });
    expect(h.sent).toHaveLength(0);
    // 追加第 9 条：已满批次不得在 retry 时把它吸收进去（上限按真实报告数，而非队列行数）。
    h.coordinator.enqueue(sid, report('r9', 'w9', 'body 9'));
    h.coordinator.wakeSession(sid, 'retry');
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(h.sent[0]!.opts.persistUserMessage?.origin).toMatchObject({ autoBridgeBatchCount: AUTO_BRIDGE_BATCH_MAX_ITEMS });
    expect(h.coordinator.getProjection(sid).pendingQueue.map(i => i.clientId)).toEqual(['r9']);
  });

  it('does not merge two reports whose combined body plus packaging exceeds the char budget', async () => {
    const h = createQueueHarness();
    await h.coordinator.ensureQueueRestored(sid);
    const body = 'x'.repeat(16_000);
    h.coordinator.enqueue(sid, report('r1', 'backend', body));
    h.coordinator.enqueue(sid, report('r2', 'frontend', body));
    h.setRunning(false);
    h.coordinator.wakeSession(sid, 'idle');
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    // 两条各 ~16000，加批次头/分隔符会超 32000：不得合并，队首独发、第二条留队。
    expect(sentText(h.sent[0]!.message)).not.toContain('[Auto-bridged batch');
    expect(h.sent[0]!.opts.persistUserMessage?.clientId).toBe('r1');
    expect(h.coordinator.getProjection(sid).pendingQueue.map(i => i.clientId)).toEqual(['r2']);
  });

  it('keeps the merged batch body within the char budget including packaging', async () => {
    const h = createQueueHarness();
    await h.coordinator.ensureQueueRestored(sid);
    for (let i = 1; i <= 5; i++) h.coordinator.enqueue(sid, report(`r${i}`, `w${i}`, 'y'.repeat(6_000)));
    h.setRunning(false);
    h.coordinator.wakeSession(sid, 'idle');
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    const text = sentText(h.sent[0]!.message);
    expect(text).toContain('[Auto-bridged batch:');
    expect(text.length).toBeLessThanOrEqual(AUTO_BRIDGE_BATCH_MAX_CHARS);
  });

  it('does not let a restored full batch absorb more reports', async () => {
    const parts = Array.from({ length: AUTO_BRIDGE_BATCH_MAX_ITEMS }, (_, i) => report(`r${i + 1}`, `w${i + 1}`, `body ${i + 1}`));
    const batchText = `[Auto-bridged batch: ${AUTO_BRIDGE_BATCH_MAX_ITEMS} worker reports]\n\n${parts.map(p => p.text).join('\n\n---\n\n')}`;
    const batchPersisted = JSON.stringify({ orcaSource: 'worker', content: batchText });
    const base = parts[0]!;
    const batch = {
      ...base,
      text: batchText,
      persistedContent: batchPersisted,
      chatMessage: { ...base.chatMessage, content: batchPersisted },
      origin: { kind: 'orca' as const, senderLabel: '', senderSessionId: 'w1-session', displayText: batchText, autoBridge: true as const, autoBridgeBatchCount: AUTO_BRIDGE_BATCH_MAX_ITEMS },
    };
    const h = createQueueHarness({ restored: [batch, report('r9', 'w9', 'body 9')] });
    await h.coordinator.ensureQueueRestored(sid);
    h.setRunning(false);
    h.coordinator.enqueue(sid, { ...report('user', 'owner', 'go'), text: 'go', persistedContent: 'go', origin: undefined });
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    // 恢复的满额批次独发，不吸收 r9；r9 与用户消息留队。
    expect(h.sent[0]!.opts.persistUserMessage?.origin).toMatchObject({ autoBridgeBatchCount: AUTO_BRIDGE_BATCH_MAX_ITEMS });
    expect(h.coordinator.getProjection(sid).pendingQueue.map(i => i.clientId)).toEqual(['r9', 'user']);
  });

  it('caps a batch at the char budget and dispatches the remainder next turn', async () => {
    const h = createQueueHarness();
    await h.coordinator.ensureQueueRestored(sid);
    const bodySize = 10_000;
    const expected = Math.floor(AUTO_BRIDGE_BATCH_MAX_CHARS / (bodySize + 100));
    for (let i = 1; i <= expected + 1; i++) h.coordinator.enqueue(sid, report(`r${i}`, `w${i}`, 'x'.repeat(bodySize)));
    h.setRunning(false);
    h.coordinator.wakeSession(sid, 'idle');
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(h.sent[0]!.opts.persistUserMessage?.origin).toMatchObject({ autoBridgeBatchCount: expected });
    expect(h.coordinator.getProjection(sid).pendingQueue.map(i => i.clientId)).toEqual([`r${expected + 1}`]);
    h.setRunning(false);
    h.coordinator.onTurnEvent(sid, 'done');
    await vi.waitFor(() => expect(h.sent).toHaveLength(2));
    expect(h.sent[1]!.opts.persistUserMessage?.clientId).toBe(`r${expected + 1}`);
  });

  it('dispatches an over-budget head alone without blocking or truncating', async () => {
    const h = createQueueHarness();
    await h.coordinator.ensureQueueRestored(sid);
    h.coordinator.enqueue(sid, report('r1', 'backend', 'x'.repeat(AUTO_BRIDGE_BATCH_MAX_CHARS + 1000) + 'TAIL_SENTINEL'));
    h.coordinator.enqueue(sid, report('r2', 'frontend', 'small'));
    h.setRunning(false);
    h.coordinator.wakeSession(sid, 'idle');
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(h.sent[0]!.opts.persistUserMessage?.clientId).toBe('r1');
    expect(sentText(h.sent[0]!.message)).not.toContain('[Auto-bridged batch');
    expect(sentText(h.sent[0]!.message)).toContain('TAIL_SENTINEL');
    expect(h.coordinator.getProjection(sid).pendingQueue.map(i => i.clientId)).toEqual(['r2']);
  });
});
