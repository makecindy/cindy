import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { shouldArmComposerVoiceHold } from '@/session/composerVoiceHold';
import type { MobileVoiceState } from '@/session/mobileVoiceInput';

// Execute the production page callbacks, as in composerAudioCleanup.test.ts,
// without mounting the pages' unrelated remote services and native controls.
function readCallbacks(page: string) {
  const source = ts.createSourceFile(page,
    readFileSync(resolve(process.cwd(), 'app/sessions', page), 'utf8'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const callbacks = new Map<string, string>();
  let cardActive = '';
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'composerCardActive' && node.initializer) {
      cardActive = node.initializer.getText(source);
    }
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'createMobileVoiceControllerSession') {
      const options = node.arguments[0];
      if (ts.isObjectLiteralExpression(options)) {
        for (const prop of options.properties) {
          if (ts.isPropertyAssignment(prop) && ['onStateChanged', 'onError'].includes(prop.name.getText(source))) {
            callbacks.set(prop.name.getText(source), prop.initializer.getText(source));
          }
        }
      }
    }
    if (ts.isVariableDeclaration(node) && node.initializer
      && ts.isCallExpression(node.initializer)
      && node.initializer.expression.getText(source) === 'useCallback') {
      callbacks.set(node.name.getText(source), node.initializer.arguments[0].getText(source));
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return (bindings: Record<string, unknown>) => {
    const names = ['handleVoiceButtonPressIn', 'setVoiceState', 'onStateChanged', 'onError'];
    const compiled = ts.transpileModule(
      `return { ${names.map((name) => {
        if (!callbacks.has(name)) throw new Error(`Missing ${page} callback: ${name}`);
        return `${name}: ${callbacks.get(name)}`;
      }).join(',')}, cardActive: (voiceStartPending, voiceIsBusy) => {
        const canUseComposer = true;
        const composerFocused = false, firstMessageInputFocused = false;
        const modelSheetOpen = false, permissionSheetOpen = false, composerVoiceHoldActive = false;
        return ${cardActive};
      } };`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
    ).outputText;
    return new Function(...Object.keys(bindings), compiled)(...Object.values(bindings)) as {
      handleVoiceButtonPressIn(): void;
      setVoiceState(state: MobileVoiceState): void;
      onStateChanged(state: MobileVoiceState): void;
      onError(message: string): void;
      cardActive(pending: boolean, busy: boolean): boolean;
    };
  };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

async function settleCallbacks() {
  // startVoiceRecording -> catch -> finally, without introducing a timer.
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe.each(['new.tsx', '[sessionId].tsx'])('%s voice startup feedback', (page) => {
  const callbacks = readCallbacks(page);
  function setup() {
    let pending = false;
    let state: MobileVoiceState = 'idle';
    let startup = deferred();
    const recording = { current: false };
    const pendingSeq = { current: 0 };
    const startupSeq = { current: 1 };
    const setVoiceError = vi.fn();
    const run = callbacks({
      startupSeq: 1, voiceStartupSeqRef: startupSeq, setVoiceError,
      setVoiceState: (value: MobileVoiceState) => run.setVoiceState(value),
      creating: false, voiceIsProcessing: false, voiceState: 'idle',
      selectedDeviceId: 'host', deviceId: 'host',
      isMobileRealtimeAudioAvailable: () => true,
      prewarmMobileRealtimeAudio: vi.fn(), prewarmMobileVoiceStart: vi.fn(),
      auth: { apiFetch: vi.fn() },
      voiceStartedOnPressInRef: { current: false },
      voiceRecordingActiveRef: recording,
      voiceStartupInFlightRef: { current: false }, voiceStopInFlightRef: { current: false },
      voiceStartPendingSeqRef: pendingSeq,
      setVoiceStartPending: (value: boolean) => { pending = value; },
      startVoiceRecording: () => startup.promise,
      voiceStateTransitionRef: { current: 'idle' },
      shouldArmComposerVoiceHold, setComposerVoiceHoldArmed: vi.fn(),
      setVoiceStateInternal: (value: MobileVoiceState) => { state = value; },
    });
    return {
      press: run.handleVoiceButtonPressIn, state: run.setVoiceState, recording,
      controllerState: run.onStateChanged, controllerError: run.onError, startupSeq, setVoiceError,
      startup: () => startup,
      nextStartup: () => { startup = deferred(); },
      cardExpanded: () => run.cardActive(pending, state === 'listening' || state === 'submitting' || state === 'refining'),
      view: () => ({ expanded: pending || state === 'listening', counting: state === 'listening', pending }),
    };
  }

  it.each([false, true])('stays expanded across startup and first PCM (PCM first=%s)', async (pcmFirst) => {
    const run = setup();
    run.press();
    expect(run.view()).toEqual({ expanded: true, counting: false, pending: true });
    run.recording.current = true;
    if (pcmFirst) run.state('listening');
    run.startup().resolve();
    await settleCallbacks();
    expect(run.view().expanded).toBe(true);
    expect(run.view().counting).toBe(pcmFirst);
    run.state('listening');
    expect(run.view()).toEqual({ expanded: true, counting: true, pending: false });
  });

  it('expands a collapsed composer with the capsule on press, before the first PCM', async () => {
    const run = setup();
    expect(run.cardExpanded()).toBe(false);
    run.press();
    expect(run.cardExpanded()).toBe(true);
    expect(run.view()).toEqual({ expanded: true, counting: false, pending: true });
    run.recording.current = true;
    run.startup().resolve();
    await settleCallbacks();
    expect(run.cardExpanded()).toBe(true);
    expect(run.view().expanded).toBe(true);
    run.state('listening');
    expect(run.cardExpanded()).toBe(true);
    expect(run.view()).toEqual({ expanded: true, counting: true, pending: false });
    run.state('idle');
    expect(run.cardExpanded()).toBe(false);
  });

  it.each(['idle', 'error', 'submitting', 'done'] as const)(
    'clears startup feedback on %s before the first PCM', async (state) => {
      const run = setup();
      run.press();
      run.recording.current = true;
      run.startup().resolve();
      await settleCallbacks();
      run.state(state);
      expect(run.view()).toEqual({ expanded: false, counting: false, pending: false });
    },
  );

  it.each([false, true])('clears feedback if startup creates no recording (reject=%s)', async (reject) => {
    const run = setup();
    run.press();
    if (reject) run.startup().reject(new Error('permission/startup failed'));
    else run.startup().resolve(); // permission cancelled or unavailable
    await settleCallbacks();
    expect(run.view()).toEqual({ expanded: false, counting: false, pending: false });
  });

  it('does not let an old startup completion collapse a new pending press', async () => {
    const run = setup();
    run.press();
    const oldStartup = run.startup();
    run.state('idle');
    run.nextStartup();
    run.press();
    oldStartup.resolve();
    await settleCallbacks();
    expect(run.view()).toEqual({ expanded: true, counting: false, pending: true });
    run.startup().resolve();
    await settleCallbacks();
    expect(run.view().expanded).toBe(false);
  });

  it('ignores late controller states and errors after a new startup claims the page', () => {
    const run = setup();
    run.press();
    run.controllerState('listening');
    expect(run.view()).toEqual({ expanded: true, counting: true, pending: false });
    run.state('idle');
    run.startupSeq.current += 1; // task/device switch invalidates the old controller
    run.nextStartup();
    run.press();
    for (const state of ['done', 'error', 'listening'] as const) run.controllerState(state);
    run.controllerError('old capture failed during cancellation');
    expect(run.view()).toEqual({ expanded: true, counting: false, pending: true });
    expect(run.setVoiceError).not.toHaveBeenCalled();
  });

  it('still surfaces an error from the current controller', () => {
    const run = setup();
    run.press();
    run.controllerError('capture failed');
    expect(run.view()).toEqual({ expanded: false, counting: false, pending: false });
    expect(run.setVoiceError).toHaveBeenCalledWith('capture failed');
  });
});
