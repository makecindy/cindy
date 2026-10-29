import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

// Execute each production start callback, with the native/network boundaries
// mocked. In particular, an already-prewarmed ASR must not hide a slow keychain.
function readStart(page: string) {
  const source = ts.createSourceFile(page, readFileSync(resolve(process.cwd(), 'app/sessions', page), 'utf8'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback = '';
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'startVoiceRecording'
      && node.initializer && ts.isCallExpression(node.initializer)) {
      callback = node.initializer.arguments[0].getText(source);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!callback) throw new Error(`Missing ${page} start callback`);
  const compiled = ts.transpileModule(`return (${callback});`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return (bindings: Record<string, unknown>) =>
    new Function(...Object.keys(bindings), compiled)(...Object.values(bindings)) as () => Promise<void>;
}

describe.each(['new.tsx', '[sessionId].tsx'])('%s speaker gate startup', page => {
  const start = readStart(page);
  function setup(pendingStart = false) {
    let finishGate!: (gate: object | undefined) => void;
    const pendingGate = new Promise<object | undefined>(resolve => { finishGate = resolve; });
    const createGate = vi.fn(() => pendingGate);
    let finishStart!: () => void;
    const startReady = pendingStart
      ? new Promise<void>(resolve => { finishStart = resolve; })
      : Promise.resolve();
    const controller = { start: vi.fn(() => startReady), cancel: vi.fn(async () => {}) };
    const createController = vi.fn((_options: Record<string, unknown>) => controller);
    const prewarmed = { credential: { settings: {} }, voiceContext: {}, asr: { stop: vi.fn(async () => {}) } };
    const startupSeq = { current: 0 };
    const setVoiceError = vi.fn();
    const bindings: Record<string, unknown> = {
      voiceState: 'idle', voiceIsProcessing: false,
      voicePermissionRequestInFlightRef: { current: false },
      voicePermissionRequestSeqRef: { current: 0 }, voicePermissionRequestAbortRef: { current: null },
      voiceStartupInFlightRef: { current: false }, voiceStartupSeqRef: startupSeq,
      voiceStopInFlightRef: { current: false }, voiceRecordingActiveRef: { current: false },
      voiceStopAfterStartRef: { current: false }, voiceLongPressActiveRef: { current: false },
      voiceControllerSessionRef: { current: null }, finishVoiceRecordingRef: { current: null },
      voiceStopGestureSelectionGuardRef: { current: false }, voiceSelectionUserOwnedRef: { current: false },
      voicePendingSelectionEchoesRef: { current: [] },
      deviceId: 'fixture-host', selectedDeviceId: 'fixture-host',
      setVoiceError, setVoiceState: vi.fn(), setVoiceReleaseToSendActive: vi.fn(),
      isMobileRealtimeAudioAvailable: () => true,
      AppState: { currentState: 'active' },
      getRecordingPermissionsAsync: vi.fn(), requestRecordingPermissionsAsync: vi.fn(),
      resolveMobileVoiceRecordingPermission: async () => 'granted',
      openLink: async () => {}, refreshMobileVoiceDictionary: async () => {},
      takePrewarmedMobileVoiceAsr: () => Promise.resolve(prewarmed),
      getMobileVoiceInputHistoryForHost: async () => [], hydrateMobileVoiceDictionary: async () => {},
      createMobileSpeakerGate: createGate, createMobileVoiceControllerSession: createController,
      draftRef: { current: '' }, composerDocumentRef: { current: {} }, composerInputRef: { current: null },
      firstMessageRef: { current: '' }, firstMessageSelectionRef: { current: { start: 0, end: 0 } },
      takeRefinementContextTail: (value: string) => value,
      buildMobileVoiceSessionRefinementContext: () => ({}), renderItems: [],
      formatRemoteError: String,
      prewarmAgentOnTyping: () => {},
    };
    return { run: start(bindings), createGate, createController, controller, startupSeq, finishGate, pendingGate, finishStart, prewarmed, setVoiceError };
  }

  // PR #7126: opening capture now overlaps hydration; the real controller tests
  // enforce filtering before ASR. These unit cases execute both page callbacks
  // to protect the promise handoff and cancellation of an in-flight startup.
  it('starts the first controller with pending hydration instead of waiting for it', async () => {
    const test = setup();
    const pending = test.run();
    await vi.waitFor(() => expect(test.createGate).toHaveBeenCalledOnce());
    expect(test.createController).toHaveBeenCalledWith(expect.objectContaining({ audioGate: test.pendingGate }));
    expect(test.controller.start).toHaveBeenCalledOnce();
    const gate = { fixture: 'saved speaker gate' };
    test.finishGate(gate);
    await pending;
    await expect(test.pendingGate).resolves.toBe(gate);
    expect(test.setVoiceError).toHaveBeenCalledExactlyOnceWith(null);
  });

  it('cancels the opened controller when the page abandons startup during hydration', async () => {
    const test = setup(true);
    const pending = test.run();
    await vi.waitFor(() => expect(test.controller.start).toHaveBeenCalledOnce());
    test.startupSeq.current += 1; // Page teardown/background cancels this startup.
    test.finishGate({});
    test.finishStart();
    await pending;
    expect(test.controller.cancel).toHaveBeenCalledOnce();
    expect(test.setVoiceError).toHaveBeenCalledExactlyOnceWith(null);
  });

  it('still records when the gate is disabled or unavailable', async () => {
    const test = setup();
    test.finishGate(undefined);
    await test.run();
    expect(test.createController).toHaveBeenCalledWith(expect.objectContaining({ audioGate: test.pendingGate }));
    await expect(test.pendingGate).resolves.toBeUndefined();
    expect(test.controller.start).toHaveBeenCalledOnce();
    expect(test.setVoiceError).toHaveBeenCalledExactlyOnceWith(null);
  });
});
