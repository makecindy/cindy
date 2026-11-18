import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AsrEvent } from '@cindy/voice-input-core';
import { DictationRefiner } from '@cindy/voice-input-core';

// #6656 / discussion_r4399404049: invoke the handlers registered by real main,
// with the real controller/queue. Only Electron, account services and providers
// are in-memory. The previous queue-only tests could not catch missing wiring,
// detached provider disposal or a stale cancel releasing another run's lease.
// Minimal input: delayed topic start -> replacement -> old runId cancel.
// Unit tier: no socket, credentials, disk or real clock waits.
const m = vi.hoisted(() => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  const deferred = () => {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
  };
  const plans: ReturnType<typeof plan>[] = [];
  function plan() { return { connect: deferred(), disposing: deferred(), disposed: deferred(), started: deferred(), flushing: deferred(), flush: Promise.resolve() }; }
  const providers: Provider[] = [];
  class Provider {
    readonly plan = plans.shift()!;
    readonly activeProviderKind = 'litellm-volcengine-sauc-asr';
    listener?: (event: AsrEvent) => void;
    constructor() { providers.push(this); }
    start = vi.fn(async () => { this.plan.started.resolve(); await this.plan.connect.promise; });
    stop = vi.fn(async () => {});
    flushAudio = vi.fn(async () => { this.plan.flushing.resolve(); await this.plan.flush; this.listener?.({ type: 'stable', text: 'spoken', at: 0 }); });
    appendAudio = vi.fn();
    onEvent(callback: (event: AsrEvent) => void) { this.listener = callback; }
    dispose = vi.fn(async () => { this.plan.disposing.resolve(); await this.plan.disposed.promise; });
  }
  return {
    deferred, plan, plans, providers, Provider, owner: 'owner-a', boundary: false, muted: false,
    handlers: new Map<string, (...args: any[]) => any>(),
    listeners: new Map<string, (...args: any[]) => any>(),
    restore: vi.fn(async (_id: number | symbol | 'remote-desktop') => {}), unregister: vi.fn(),
    setMuted: vi.fn(async (_value: boolean) => {}),
  };
});
vi.mock('electron', () => ({ app: { isPackaged: true, once: vi.fn(), on: vi.fn(),
  getPreferredSystemLanguages: () => ['en'], getLocale: () => 'en', getSystemLocale: () => 'en' },
  ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => m.handlers.set(name, fn),
    on: (name: string, fn: (...args: any[]) => any) => m.listeners.set(name, fn) },
  shell: {}, systemPreferences: { getMediaAccessStatus: () => 'granted' } }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }) }));
vi.mock('../../voice-conversation/index.js', () => ({ registerVoiceConversationIpc: vi.fn() }));
vi.mock('../../voice-conversation/lease.js', () => ({ hasVoiceConversationLease: () => false }));
vi.mock('../../appSessionState.js', () => ({ activeOwnerScopeKey: () => m.owner,
  getActiveAppSession: () => ({ dataOwnerId: m.owner }), isAppSessionBoundaryPending: () => m.boundary }));
vi.mock('../../utility-model/resolveAuxiliaryModelChain.js', () => ({ getEffectiveAuxiliaryModelChainSnapshot: () => 'chain' }));
vi.mock('../../utility-model/oneShotCandidates.js', () => ({ isProviderModelRouteDisabled: () => false,
  isUtilityRouteDisabled: () => false, isUtilityRoutePaymentRequired: () => false, requestUtilityText: vi.fn() }));
vi.mock('../../maker-host/index.js', () => ({ getMaker: vi.fn() }));
vi.mock('../../maker-host/auth-adapters.js', () => ({ desktopCodexAuthAdapter: {}, readOwnerScopedXdGatewayKey: vi.fn() }));
vi.mock('../../maker-host/runtime-configs.js', () => ({ claudeUpstreamEndpoint: () => 'https://example.invalid' }));
vi.mock('../../appCapabilities.js', () => ({ getAppCapabilities: () => ({ canUseCindyAccountServices: true }) }));
vi.mock('../../secrets/providerSecretStore.js', () => ({ getProviderSecretStore: vi.fn() }));
vi.mock('../../security/trustedAppRenderer.js', () => ({ assertTrustedAppRendererEvent: vi.fn() }));
vi.mock('../../model-access/gatewayKeyRejection.js', () => ({ reportCindyGatewayKeyRejected: vi.fn() }));
vi.mock('../FallbackAsrProvider.js', () => ({ FallbackAsrProvider: m.Provider }));
vi.mock('../CindyVoiceSessionClient.js', () => ({ CINDY_MANAGED_REFINER_PROVIDER: 'auto',
  CindyVoiceRunContext: class { refineRequestBudget() { return 1; } }, isCindyVoiceServiceReady: () => true }));
vi.mock('../VoiceInputModelSelection.js', () => ({
  getVoiceInputModelSelection: () => ({ asrProvider: 'litellm-volcengine-sauc-asr', refinerProvider: 'codex-gpt-5.4-mini', serviceMode: 'cindy' }),
  voiceInputModelSelectionSignature: () => 'fixed', effectiveVoiceInputServiceMode: () => 'cindy',
  voiceInputAsrChainForServiceMode: () => ['litellm-volcengine-sauc-asr'],
  getVoiceInputModelSelectionConfigPath: () => 'in-memory', reloadVoiceInputModelSelection: vi.fn(),
  setVoiceInputModelSelection: vi.fn(), validateVoiceInputCustomAsrConfig: vi.fn(),
}));
vi.mock('../VoiceInputDataStore.js', () => ({ registerVoiceInputDataStoreIpc: vi.fn(),
  voiceInputDataStore: { getSettings: () => ({ speakerFilterEnabled: false }), updateSettings: vi.fn() } }));
vi.mock('../speaker/index.js', () => ({ registerVoiceSpeakerFilterIpc: vi.fn(), getSpeakerFilterService: () => ({ createGate: () => undefined }) }));
vi.mock('loudness', () => ({ default: { getMuted: async () => m.muted,
  setMuted: async (value: boolean) => { await m.setMuted(value); m.muted = value; } } }));
// Keep the production guard and OS mutation queue; only the OS API is fake.
vi.mock('../SystemAudioMuteGuard.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../SystemAudioMuteGuard.js')>();
  const guard = new actual.SystemAudioMuteGuard();
  m.restore.mockImplementation(guard.restore.bind(guard));
  return { ...actual, systemAudioMuteGuard: {
    mute: guard.mute.bind(guard), restore: m.restore, restoreAll: guard.restoreAll.bind(guard),
    get hasPendingOrActiveMute() { return guard.hasPendingOrActiveMute; },
  } };
});
vi.mock('../global.js', () => ({ isGlobalVoiceInputOverlaySender: () => false,
  registerActiveInlineVoiceInputWebContents: vi.fn(), unregisterActiveInlineVoiceInputWebContents: m.unregister,
  refreshVoiceInputInputMonitoringPermissionSnapshot: async () => ({ ok: true }),
  getVoiceInputInputMonitoringPermissionCachedSnapshot: () => ({ ok: true }),
  getVoiceInputAccessibilityPermissionSnapshot: () => ({ ok: true }), awaitGlobalOverlayPasteContext: vi.fn(),
  showVoiceInputDictionaryToast: vi.fn(), takeOverlayDictionaryToastAnchor: vi.fn(),
}));
vi.mock('../CodexResponsesTextModelClient.js', () => ({ CodexResponsesTextModelClient: class {}, prewarmCodexResponsesEndpoint: vi.fn() }));
vi.mock('../ElevenLabsScribeProvider.js', () => ({ ElevenLabsScribeProvider: class {} }));
vi.mock('../DictionaryLearningTextModelClient.js', () => ({ DictionaryLearningTextModelClient: class {} }));
vi.mock('../LiteLlmTranscriptionProvider.js', () => ({ LiteLlmTranscriptionProvider: class {}, transcribeLiteLlmAudioFile: vi.fn() }));
vi.mock('../LiteLlmTextModelClient.js', () => ({ LiteLlmTextModelClient: class {}, makeRefinerPromptCacheKey: vi.fn(), prewarmLiteLlmRefinerEndpoint: vi.fn() }));
vi.mock('../RealtimeAsrWebSocketProvider.js', () => ({ RealtimeAsrWebSocketProvider: class {},
  invalidatePrewarmedRealtimeAsrWebSocketSession: vi.fn(), prewarmRealtimeAsrWebSocketSession: vi.fn() }));
vi.mock('../VolcengineSaucAsrProvider.js', () => ({ VolcengineSaucAsrProvider: class {} }));
vi.mock('../VoiceInputProviderHealth.js', () => ({ orderVoiceInputProvidersByHealth: (_kind: string, chain: string[]) => chain }));

import { registerVoiceInputIpc } from '../index.js';
import { systemAudioMuteGuard } from '../SystemAudioMuteGuard.js';

let nextId = 100;
let windows: ReturnType<typeof createWindowEvent>[];
function createWindowEvent() {
  const sender = { id: nextId++, isDestroyed: vi.fn(() => false), send: vi.fn(), once: vi.fn() };
  return { sender };
}
function windowEvent() {
  const event = createWindowEvent();
  windows.push(event);
  return event;
}
const invoke = (name: string, event: ReturnType<typeof windowEvent>, payload?: unknown) => m.handlers.get('voice-input:' + name)!(event, payload);
const start = (event: ReturnType<typeof windowEvent>) => invoke('start', event, { refinementEnabled: false });
function plan() { const p = m.plan(); m.plans.push(p); return p; }
beforeAll(() => registerVoiceInputIpc());
beforeEach(() => { vi.useFakeTimers(); windows = []; m.providers.length = 0; m.owner = 'owner-a'; m.boundary = false; m.restore.mockClear(); m.unregister.mockClear(); });
afterEach(async () => {
  for (const p of [...m.providers.map(provider => provider.plan), ...m.plans]) { p.connect.resolve(); p.disposed.resolve(); }
  for (const event of windows) await invoke('cancel', event);
  await systemAudioMuteGuard.restoreAll();
  m.plans.length = 0;
  vi.clearAllTimers(); vi.useRealTimers();
});

describe('registered main dictation lifecycle (#6656)', () => {
  // PRRT_kwDOTgdRUs62LQU0: existing cancellation tests disabled refinement,
  // so event suppression hid a post-cancel billable dispatch. Real registered
  // handlers/controller; only the external refiner is replaced. Unit tier.
  it.each([false, true])('dispatches refinement after delayed flush only when not cancelled (%s)', async cancelled => {
    const refine = vi.spyOn(DictationRefiner.prototype, 'refine').mockResolvedValue({
      accepted: false, sourceSegmentIds: [], basedOnText: 'spoken', elapsedMs: 0,
    });
    const event = windowEvent(); const provider = plan(); const flush = m.deferred();
    provider.connect.resolve(); provider.disposed.resolve(); provider.flush = flush.promise;
    try {
      const run = await invoke('start', event, { refinementEnabled: true });
      expect(run.ok).toBe(true);
      const stopping = invoke('stop', event); await provider.flushing.promise;
      const cancelling = cancelled ? invoke('cancel', event, { runId: run.runId }) : Promise.resolve();
      flush.resolve(); await stopping; await cancelling;
      expect(refine).toHaveBeenCalledTimes(cancelled ? 0 : 1);
      expect(m.providers.at(-1)!.dispose).toHaveBeenCalledOnce();
    } finally { flush.resolve(); refine.mockRestore(); }
  });
  // The recording-scoped lease must survive neither a rejected ASR stop nor
  // window teardown. Existing error coverage only exercised startup failure.
  it('releases the recording lease and provider when cancellation rejects', async () => {
    const event = windowEvent(); const provider = plan();
    provider.connect.resolve(); provider.disposed.resolve();
    await invoke('mute-system-audio', event, { recordingId: 'cancel-error' });
    await invoke('start', event, { recordingId: 'cancel-error', refinementEnabled: false });
    m.providers.at(-1)!.stop.mockRejectedValueOnce(new Error('ASR stop failed'));
    await expect(invoke('cancel', event)).rejects.toThrow('ASR stop failed');
    expect(m.muted).toBe(false);
    expect(m.providers.at(-1)!.dispose).toHaveBeenCalledOnce();
  });
  it('releases recording leases after a destroyed window encounters an ASR stop error', async () => {
    const event = windowEvent(); const provider = plan();
    provider.connect.resolve(); provider.disposed.resolve();
    await invoke('mute-system-audio', event, { recordingId: 'window-error' });
    await invoke('start', event, { recordingId: 'window-error', refinementEnabled: false });
    m.providers.at(-1)!.stop.mockRejectedValueOnce(new Error('ASR stop failed'));
    event.sender.isDestroyed.mockReturnValue(true);
    event.sender.once.mock.calls.find(([name]) => name === 'destroyed')![1]();
    await vi.waitFor(() => expect(m.muted).toBe(false));
    expect(m.providers.at(-1)!.dispose).toHaveBeenCalledOnce();
  });
  it('reports failed scoped restoration and retains the lease for retry', async () => {
    const event = windowEvent();
    await invoke('mute-system-audio', event, { recordingId: 'retry' });
    m.restore.mockRejectedValueOnce(new Error('OS restore failed'));
    expect((await invoke('restore-system-audio', event, { recordingId: 'retry' })).ok).toBe(false);
    expect(m.muted).toBe(true);
    expect((await invoke('restore-system-audio', event, { recordingId: 'retry' })).ok).toBe(true);
    expect(m.muted).toBe(false);
  });
  it('scopes identical renderer recording IDs to distinct sender windows', async () => {
    const first = windowEvent(); const second = windowEvent();
    await invoke('mute-system-audio', first, { recordingId: 'same' });
    await invoke('mute-system-audio', second, { recordingId: 'same' });
    await invoke('restore-system-audio', first, { recordingId: 'same' });
    expect(m.muted).toBe(true);
    await invoke('restore-system-audio', second, { recordingId: 'same' });
    expect(m.muted).toBe(false);
  });
  it('releases a recording lease when provider startup fails', async () => {
    const event = windowEvent(); const provider = plan(); provider.disposed.resolve();
    await invoke('mute-system-audio', event, { recordingId: 'failed-start' });
    const starting = invoke('start', event, { recordingId: 'failed-start', refinementEnabled: false });
    await provider.started.promise; provider.connect.reject(new Error('connection failed'));
    expect((await starting).ok).toBe(false);
    expect(m.muted).toBe(false);
  });

  // discussion_r4558610003: failure cleanup can precede a cue-delayed mute.
  // Existing startup-failure coverage mutes first and has no pending OS restore.
  // Real start/mute/restore handlers and guard, deferred OS boundary; unit tier.
  it.each(['renderer', 'destroyed'])('releases a late mute after failed startup via %s cleanup', async cleanup => {
    const event = windowEvent();
    await invoke('mute-system-audio', event, { recordingId: 'closed-topic' });
    const restoring = m.deferred(); const enteredRestore = m.deferred();
    m.setMuted.mockImplementationOnce(async () => { enteredRestore.resolve(); await restoring.promise; });
    const oldRestore = invoke('restore-system-audio', event, { recordingId: 'closed-topic' });
    await enteredRestore.promise;
    const provider = plan(); provider.disposed.resolve();
    const starting = invoke('start', event, { recordingId: 'failed-main', refinementEnabled: false });
    await provider.started.promise;
    provider.connect.reject(new Error('connection failed'));
    try {
      await vi.waitFor(() => expect(m.restore).toHaveBeenCalledTimes(2));
      const lateMute = invoke('mute-system-audio', event, { recordingId: 'failed-main' });
      restoring.resolve();
      await oldRestore;
      expect((await starting).ok).toBe(false);
      expect((await lateMute).ok).toBe(true);
      expect(m.muted).toBe(true);
      if (cleanup === 'renderer') {
        expect((await invoke('restore-system-audio', event, { recordingId: 'failed-main' })).ok).toBe(true);
      } else {
        event.sender.isDestroyed.mockReturnValue(true);
        event.sender.once.mock.calls.find(([name]) => name === 'destroyed')![1]();
        await vi.waitFor(() => expect(m.muted).toBe(false));
      }
      expect(m.muted).toBe(false);
      expect(systemAudioMuteGuard.hasPendingOrActiveMute).toBe(false);
    } finally { restoring.resolve(); await oldRestore; await starting; }
  });

  it('rejects malformed recording IDs without muting the OS', async () => {
    const event = windowEvent();
    expect((await invoke('mute-system-audio', event, { recordingId: 'x'.repeat(129) })).ok).toBe(false);
    expect(m.muted).toBe(false);
  });
  it('revokes events before a queued cancel while the real controller is flushing stop', async () => {
    const event = windowEvent(); const provider = plan(); const flush = m.deferred();
    provider.connect.resolve(); provider.disposed.resolve(); provider.flush = flush.promise;
    const run = await start(event);
    event.sender.send.mockClear();
    const stopping = invoke('stop', event); await provider.flushing.promise;
    const cancelling = invoke('cancel', event, { runId: run.runId });
    flush.resolve(); await stopping; await cancelling;
    expect(event.sender.send.mock.calls.some(([, message]) => message.type === 'submitted')).toBe(false);
  });

  it('releases a mute owned by a window destroyed before any start', async () => {
    const event = windowEvent();
    await invoke('mute-system-audio', event, { recordingId: 'pending' });
    expect(m.muted).toBe(true);
    event.sender.isDestroyed.mockReturnValue(true);
    event.sender.once.mock.calls.find(([name]) => name === 'destroyed')![1]();
    await vi.waitFor(() => expect(m.muted).toBe(false));
  });
  // discussion_r4496889755: old disposal must not release a pending new
  // recording's lease. Real main handlers/controller/queue/audio guard.
  it('retains the replacement mute while old cancellation is disposing', async () => {
    const event = windowEvent(); const old = plan(); old.connect.resolve();
    await invoke('mute-system-audio', event, { recordingId: 'old' });
    await invoke('start', event, { recordingId: 'old', refinementEnabled: false });
    const cancelling = invoke('cancel', event);
    await old.disposing.promise;
    const next = plan(); next.connect.resolve(); next.disposed.resolve();
    await invoke('mute-system-audio', event, { recordingId: 'next' });
    const replacement = invoke('start', event, { recordingId: 'next', refinementEnabled: false });
    old.disposed.resolve(); await cancelling; await replacement;
    expect(m.muted).toBe(true);
    await invoke('cancel', event);
    expect(m.muted).toBe(false);
  });
  it.each(['owner', 'destroyed', 'boundary'])('rechecks %s after replacement disposal, before allocating another provider', async boundary => {
    const event = windowEvent(); const old = plan(); old.connect.resolve(); await start(event);
    const unused = plan(); unused.connect.resolve(); unused.disposed.resolve();
    const replacement = start(event); await old.disposing.promise;
    if (boundary === 'owner') m.owner = 'owner-b';
    else if (boundary === 'boundary') m.boundary = true;
    else event.sender.isDestroyed.mockReturnValue(true);
    old.disposed.resolve();
    expect((await replacement).ok).toBe(false);
    expect(m.providers).toHaveLength(1);
  });

  it('releases a pending topic provider before replacement, and stale cancel preserves the new audio route and lease', async () => {
    const event = windowEvent(); const old = plan(); const replacement = plan();
    const first = start(event); await old.started.promise;
    const second = start(event);
    old.connect.resolve(); const a = await first;
    await old.disposing.promise;
    expect(m.providers).toHaveLength(1);
    old.disposed.resolve(); await replacement.started.promise;
    replacement.connect.resolve(); const b = await second;
    expect(a.ok && b.ok && a.runId !== b.runId).toBe(true);
    await invoke('cancel', event, { runId: a.runId });
    expect(m.restore).not.toHaveBeenCalled();
    expect(m.providers[1].stop).not.toHaveBeenCalled();
    const chunk = new ArrayBuffer(32);
    m.listeners.get('voice-input:audio')!(event, { pcm16k: chunk });
    expect(m.providers[1].appendAudio).toHaveBeenCalledWith(chunk, undefined);
    expect(m.providers[0].dispose).toHaveBeenCalledOnce();
  });

  it.each(['stop', 'cancel'])('keeps %s provider disposal and audio restoration ahead of a queued replacement', async operation => {
    const event = windowEvent(); const old = plan(); old.connect.resolve(); await start(event);
    const finish = invoke(operation, event); await old.disposing.promise;
    const replacement = plan(); const second = start(event);
    await Promise.resolve(); expect(m.providers).toHaveLength(1);
    old.disposed.resolve(); await replacement.started.promise;
    expect(m.restore).toHaveBeenCalledExactlyOnceWith(event.sender.id);
    replacement.connect.resolve(); await second; await finish;
    expect(m.providers[0].dispose).toHaveBeenCalledOnce();
  });

  it.each(['owner', 'destroyed'])('rejects an invalid queued %s without allocating a provider', async boundary => {
    const event = windowEvent(); const old = plan();
    const first = start(event); await old.started.promise;
    const second = start(event);
    if (boundary === 'owner') m.owner = 'owner-b'; else event.sender.isDestroyed.mockReturnValue(true);
    old.connect.resolve(); old.disposed.resolve(); await first;
    expect((await second).ok).toBe(false);
    expect(m.providers).toHaveLength(1);
  });
});
