import { getEventListeners } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GHOST_CONTROL_POINTS,
  type GhostPipeEventPush,
  type InstalledGhost,
} from '../../../shared/ghost.js';
import { createSubscriptionGatewayReader } from '../runtimePluginHostCore.js';
import { GhostSubscriptionGateway, type GhostSubscriptionGatewayDeps } from '../subscriptionGateway.js';

// §3.2, unit. Exercise the real gateway's message, control, and observer entry points.
// The profile hold must not convert a block policy into allow or leave a fuse behind.
// Existing gateway tests exercise ordinary failure and timeout, without a pause signal.
// Four held calls, aborting a pending call, and switching to a fresh signal isolate the
// new branches with fake timers. No pages, processes, or profile storage are involved.

const plugin: InstalledGhost = {
  manifest: {
    schemaVersion: 2,
    id: 'fixture',
    name: 'Fixture',
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    subscribe: {
      topics: ['session'],
      hooks: ['will-user-message', 'will-assistant-message', 'will-compose-context', 'will-tool-call', 'did-tool-result'],
    },
  },
  dir: '/fixture',
  enabled: true,
  approval: { state: 'approved', revision: 'fixture-v1' },
};

const message = { sessionId: 'task', text: 'message' };
const nativeCall = { sessionId: 'task', engine: 'pi', phase: 'call', toolName: 'read', toolCallId: 'call', input: {} } as const;
const block = { pluginId: 'fixture', onFailure: 'block' } as const;
const blocked = { action: 'block', failure: true, ghostId: 'fixture' };

function fixture(overrides: Partial<GhostSubscriptionGatewayDeps> = {}) {
  let pause = new AbortController();
  let sequence = 0;
  const send = vi.fn((_id: string, _event: GhostPipeEventPush) => {
    if (pause.signal.aborted) throw new Error('page closed');
  });
  const wake = vi.fn(async () => {
    if (pause.signal.aborted) throw new Error('wake refused');
  });
  const warning = vi.fn();
  const fused = vi.fn();
  const deps: GhostSubscriptionGatewayDeps = {
    listGhosts: () => [plugin],
    isRunning: () => true,
    wake,
    sendToGhost: send,
    now: Date.now,
    newHookId: () => 'hook-' + ++sequence,
    resolveMessageHookContext: () => ({}),
    onHookFused: fused,
    log: { info: vi.fn(), warn: warning },
    hookDeliveryPauseSignal: () => pause.signal,
    ...overrides,
  };
  const gateway = new GhostSubscriptionGateway(deps);
  return {
    gateway, send, wake, warning, fused, deps,
    signal: () => pause.signal,
    hold: () => pause.abort(),
    release: () => { pause = new AbortController(); },
  };
}

function verdict(gateway: GhostSubscriptionGateway, hookId: string, answer: object) {
  gateway.handleVerdict('fixture', { type: 'event-verdict', hookId, ...answer });
}

describe('intentional plugin hook suspension', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps message hooks fail-open and task policies intact across four held calls', async () => {
    const { gateway, hold, release, send, wake, warning, fused } = fixture();
    hold();
    for (let call = 0; call < 4; call++) {
      await expect(gateway.screenUserMessage(message)).resolves.toEqual({ action: 'allow' });
      await expect(gateway.screenAssistantMessage(message)).resolves.toEqual({ action: 'allow' });
      await expect(gateway.screenControlPoint('will-compose-context', message, { ...block, onFailure: 'skip' }))
        .resolves.toMatchObject({ action: 'skip', failure: true });
      await expect(gateway.screenControlPoint('will-tool-call', nativeCall, block)).resolves.toMatchObject(blocked);
      await expect(gateway.screenControlPoint('did-tool-result', { ...nativeCall, phase: 'result', result: {} }, block))
        .resolves.toMatchObject(blocked);
    }
    expect(send).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
    expect(fused).not.toHaveBeenCalled();
    expect(warning.mock.calls.every(([message]) => message === 'control point unanswered')).toBe(true);

    release();
    const pending = gateway.screenUserMessage(message);
    expect(send).toHaveBeenCalledTimes(1);
    verdict(gateway, 'hook-1', { action: 'rewrite', text: 'rewritten' });
    await expect(pending).resolves.toMatchObject({ action: 'rewrite', text: 'rewritten' });
  });

  it.each(['waking', 'accepted'])('settles a %s hook immediately on hold and discards its late verdict', async phase => {
    let finishWake!: () => void;
    let running = phase === 'accepted';
    const { gateway, hold, release, send } = fixture({
      isRunning: () => running,
      wake: () => new Promise<void>(resolve => { finishWake = resolve; }),
    });
    const oldResult = vi.fn();
    const old = gateway.screenControlPoint('will-tool-call', nativeCall, block).then(oldResult);
    expect(send).toHaveBeenCalledTimes(running ? 1 : 0);
    hold();
    await vi.advanceTimersByTimeAsync(0);
    expect(oldResult).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(blocked));
    await old;
    expect(vi.getTimerCount()).toBe(0);

    release();
    running = true;
    finishWake?.();
    const nextResult = vi.fn();
    const next = gateway.screenControlPoint('will-tool-call', nativeCall, block).then(nextResult);
    verdict(gateway, 'hook-1', { action: 'block' });
    await vi.advanceTimersByTimeAsync(0);
    expect(nextResult).not.toHaveBeenCalled();
    verdict(gateway, 'hook-2', { action: 'allow' });
    await next;
    expect(nextResult).toHaveBeenCalledExactlyOnceWith({ action: 'allow' });
    expect(send).toHaveBeenCalledTimes(phase === 'accepted' ? 2 : 1);
  });

  it('honors block while held for an already fused native hook and keeps that fuse on release', async () => {
    const send = vi.fn(() => { throw new Error('ordinary delivery error'); });
    const { gateway, hold, release } = fixture({ sendToGhost: send });
    const screen = () => gateway.screenControlPoint('will-tool-call', nativeCall, block);
    for (let call = 0; call < 3; call++) await expect(screen()).resolves.toMatchObject(blocked);
    await expect(screen()).resolves.toEqual({ action: 'allow' });
    hold();
    await expect(screen()).resolves.toMatchObject(blocked);
    release();
    await expect(screen()).resolves.toEqual({ action: 'allow' });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it.each(['user', 'assistant'] as const)('lets a pending %s message through on hold without counting a hook failure', async kind => {
    let hookId = 0;
    const newHookId = vi.fn(() => 'hook-' + ++hookId);
    const resolveMessageHookContext = vi.fn(() => ({}));
    const { gateway, hold, release, signal, send, wake, fused } = fixture({
      newHookId, resolveMessageHookContext, isRunning: () => !signal().aborted,
    });
    const screen = () => kind === 'user' ? gateway.screenUserMessage(message) : gateway.screenAssistantMessage(message);
    for (let call = 1; call <= 3; call++) {
      const settled = vi.fn();
      const pending = screen().then(settled);
      expect(send).toHaveBeenCalledTimes(call);
      expect(settled).not.toHaveBeenCalled();
      hold();
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toHaveBeenCalledExactlyOnceWith({ action: 'allow' });
      await pending;
      release();
    }
    expect(fused).not.toHaveBeenCalled();
    const resumed = screen();
    expect(send).toHaveBeenCalledTimes(4);
    verdict(gateway, 'hook-4', { action: 'rewrite', text: 'after hold' });
    await expect(resumed).resolves.toMatchObject({ action: 'rewrite', text: 'after hold' });

    // Admission was open when the message loop selected the hook. A synchronous
    // context reader can close it before the gateway allocates a request.
    resolveMessageHookContext.mockImplementationOnce(() => { hold(); return {}; });
    await expect(screen()).resolves.toEqual({ action: 'allow' });
    expect(newHookId).toHaveBeenCalledTimes(4);
    release();

    // Close the hold while admitting the request. The registered listener
    // settles it, and dispatch must not attempt to wake an already stopped page.
    newHookId.mockImplementationOnce(() => { hold(); return 'hook-' + ++hookId; });
    await expect(screen()).resolves.toEqual({ action: 'allow' });
    expect(send).toHaveBeenCalledTimes(4);
    expect(wake).not.toHaveBeenCalled();
  });

  it.each(['verdict', 'delivery failure', 'deadline', 'hold'])('removes the pause listener after %s', async outcome => {
    const send = vi.fn(() => {
      if (outcome === 'delivery failure') throw new Error('ordinary delivery error');
    });
    const { gateway, hold, signal } = fixture({ sendToGhost: send });
    const result = gateway.screenControlPoint('will-tool-call', nativeCall, block);
    expect(getEventListeners(signal(), 'abort')).toHaveLength(1);
    if (outcome === 'verdict') verdict(gateway, 'hook-1', { action: 'allow' });
    if (outcome === 'deadline') await vi.advanceTimersByTimeAsync(GHOST_CONTROL_POINTS['will-tool-call'].timeoutMs);
    if (outcome === 'hold') hold();
    await expect(result).resolves.toMatchObject(outcome === 'delivery failure' || outcome === 'hold' ? blocked : { action: 'allow' });
    expect(getEventListeners(signal(), 'abort')).toHaveLength(0);
  });

  it('passes the optional signal through the shared runtime assembly', async () => {
    const { hold, release, signal } = fixture();
    const sendToGhostLogic = vi.fn((_id: string, _payload: GhostPipeEventPush) => true);
    const reader = createSubscriptionGatewayReader({
      availableGhosts: () => [plugin],
      listGhostNotificationCandidates: async () => [plugin],
      findGhostNotificationTarget: () => plugin,
      getGhostRuntime: () => ({ stateOf: () => 'running', spawn: async () => ({ ok: true }) }),
      sendToGhostLogic,
      broadcastGhostWindowPush: vi.fn(),
      log: { info: vi.fn(), warn: vi.fn() },
      hookDeliveryPauseSignal: signal,
    });
    const gateway = reader.getGhostSubscriptionGateway();
    hold();
    const held = vi.fn();
    const request = gateway.screenControlPoint('will-tool-call', nativeCall, block).then(held);
    await vi.advanceTimersByTimeAsync(0);
    expect(held).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(blocked));
    await request;
    expect(sendToGhostLogic).not.toHaveBeenCalled();

    release();
    const pending = gateway.screenControlPoint('will-tool-call', nativeCall, block);
    const payload = sendToGhostLogic.mock.calls.at(-1)?.[1];
    if (!payload || !('hookId' in payload)) throw new Error('expected a live hook envelope');
    verdict(gateway, payload.hookId, { action: 'allow' });
    await expect(pending).resolves.toEqual({ action: 'allow' });
  });

  it('drops held observer events and delayed discovery without replay on release', async () => {
    let resolveDiscovery!: (ghosts: InstalledGhost[]) => void;
    const listGhostsAsync = vi.fn(() => new Promise<InstalledGhost[]>(resolve => { resolveDiscovery = resolve; }));
    const data = { sessionId: 'task' };
    const { gateway, hold, release, send, wake } = fixture({ listGhostsAsync });
    const prepared = gateway.preparePublish('session');
    resolveDiscovery([plugin]);
    const publishPrepared = await prepared;
    expect(publishPrepared).not.toBeNull();
    gateway.publish('session', 'did-session-switched', data);
    hold();
    gateway.publish('session', 'did-session-switched', data);
    gateway.publishIndexed([plugin], 'session', 'did-session-switched', data);
    expect(listGhostsAsync).toHaveBeenCalledTimes(2);

    release();
    publishPrepared?.('did-session-switched', data);
    resolveDiscovery([plugin]);
    await vi.advanceTimersByTimeAsync(0);
    expect(send).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();

    gateway.publishIndexed([plugin], 'session', 'did-session-switched', data);
    expect(send).toHaveBeenCalledExactlyOnceWith('fixture', expect.objectContaining({ name: 'did-session-switched', seq: 1 }), plugin);
  });
});
