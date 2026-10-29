import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AsrEvent } from '@cindy/voice-input-core';

// #6656 / discussion_r4399404049: invoke the handlers registered by real main,
// with the real controller/queue. Only Electron, account services and providers
// are in-memory. The previous queue-only tests could not catch missing wiring,
// detached provider disposal or a stale cancel releasing another run's lease.
// Minimal input: delayed topic start -> replacement -> old runId cancel.
// Unit tier: no socket, credentials, disk or real clock waits.
const m = vi.hoisted(() => {
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
  };
  const plans: ReturnType<typeof plan>[] = [];
  function plan() { return { connect: deferred(), disposing: deferred(), disposed: deferred(), started: deferred() }; }
  const providers: Provider[] = [];
  class Provider {
    readonly plan = plans.shift()!;
    readonly activeProviderKind = 'litellm-volcengine-sauc-asr';
    listener?: (event: AsrEvent) => void;
    constructor() { providers.push(this); }
    start = vi.fn(async () => { this.plan.started.resolve(); await this.plan.connect.promise; });
    stop = vi.fn(async () => {});
    flushAudio = vi.fn(async () => { this.listener?.({ type: 'stable', text: 'spoken', at: 0 }); });
    appendAudio = vi.fn();
    onEvent(callback: (event: AsrEvent) => void) { this.listener = callback; }
    dispose = vi.fn(async () => { this.plan.disposing.resolve(); await this.plan.disposed.promise; });
  }
  return {
    deferred, plan, plans, providers, Provider, owner: 'owner-a', boundary: false,
    handlers: new Map<string, (...args: any[]) => any>(),
    listeners: new Map<string, (...args: any[]) => any>(),
    restore: vi.fn(async (_id: number) => {}), unregister: vi.fn(),
  };
});
vi.mock('electron', () => ({ app: { isPackaged: true, once: vi.fn(),
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
  CindyVoiceRunContext: class {}, isCindyVoiceServiceReady: () => true }));
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
vi.mock('../SystemAudioMuteGuard.js', () => ({ systemAudioMuteGuard: { restore: m.restore, restoreAll: vi.fn(), hasPendingOrActiveMute: false } }));
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
  m.plans.length = 0;
  vi.clearAllTimers(); vi.useRealTimers();
});

describe('registered main dictation lifecycle (#6656)', () => {
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
