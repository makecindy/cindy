import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const chatInputSource = readFileSync(
  resolve(__dirname, '..', 'components', 'new-chat', 'ChatInput.tsx'),
  'utf8',
).replace(/\r\n?/g, '\n');
const voiceInputSource = readFileSync(
  resolve(__dirname, '..', 'voice-input', 'useVoiceInput.ts'),
  'utf8',
).replace(/\r\n?/g, '\n');

describe('ChatInput voice input Enter-to-send contract', () => {
  it('routes Enter while listening through the same stop-and-send path as the send button', () => {
    const keydownBlock = extractBetween(
      chatInputSource,
      'const handleKeyDown = (event: KeyboardEvent) => {',
      'const handleKeyUp = (event: KeyboardEvent) => {',
    );

    expect(chatInputSource).toContain(
      'const voiceInputStopAndSendRef = useRef<(deliveryMode?: MessageDeliveryMode) => void | Promise<void>>(() => {});',
    );
    expect(chatInputSource).toContain('const voiceInputCanStopAndSendRef = useRef(false);');
    expect(chatInputSource).toContain('voiceInputStopAndSendRef.current = handleClickSend;');
    expect(chatInputSource).toContain('voiceInputCanStopAndSendRef.current = !sendButtonDisabled;');
    expect(keydownBlock).toContain("currentState === 'listening'");
    expect(keydownBlock).toContain('voiceInputCanStopAndSendRef.current');
    expect(keydownBlock).toContain('isVoiceInputEnterTarget(event.target)');
    expect(keydownBlock).toContain('resolveComposerEnterIntent(');
    expect(keydownBlock).toContain('getComposerSendShortcutPreference()');
    expect(keydownBlock).toContain('const platform = window.electronAPI?.platform;');
    expect(keydownBlock).toContain('turnRunning: showStopButtonRef.current');
    expect(keydownBlock).toContain("(enterIntent === 'queue' || enterIntent === 'steer')");
    expect(keydownBlock).toContain('!isVoiceInputShortcutMatch(event, voiceShortcutRef.current)');
    expect(keydownBlock).toContain('event.preventDefault();');
    expect(keydownBlock).toContain('event.stopPropagation();');
    expect(keydownBlock).toContain('void voiceInputStopAndSendRef.current(enterIntent);');
    expect(keydownBlock).not.toContain('composerCanSubmitRef.current');
  });

  it('allows voice Enter-to-send only when the event target itself falls back to the document body', () => {
    const keydownSetupBlock = extractBetween(
      chatInputSource,
      'const isComposerEnterTarget = (target: EventTarget | null) => {',
      'const handleKeyDown = (event: KeyboardEvent) => {',
    );

    expect(keydownSetupBlock).toContain('const isVoiceInputEnterTarget = (target: EventTarget | null) => {');
    expect(keydownSetupBlock).toContain('if (isComposerEnterTarget(target)) return true;');
    expect(keydownSetupBlock).toContain('target === document.body');
    expect(keydownSetupBlock).toContain('target === document.documentElement');
    expect(keydownSetupBlock).not.toContain('document.activeElement');
    expect(keydownSetupBlock).toContain('return true;');
    expect(keydownSetupBlock).toContain('return false;');
  });

  it('keeps finish-and-send enabled while listening before ASR draft arrives', () => {
    expect(chatInputSource).toContain('!voiceInput.isListening && !canSend && !hasVoiceDraftText');
  });

  it('routes Enter from the Tiptap editor through stop-and-send or stop-and-steer while listening', () => {
    const tiptapKeydownBlock = extractBetween(
      chatInputSource,
      'handleKeyDown(view, event) {',
      'return false;\n      },\n    },',
    );
    const enterBlock = extractBetween(
      tiptapKeydownBlock,
      '// Resolve the configurable send shortcut after structured list handling.',
      'void voiceInputStopAndSendRef.current(enterIntent);',
    );

    expect(enterBlock).toContain("if (enterIntent === 'queue' || enterIntent === 'steer') {");
    expect(enterBlock).toContain("voiceInputStateRef.current === 'listening'");
    expect(enterBlock).toContain('voiceInputCanStopAndSendRef.current');
    expect(enterBlock).toContain('const isEditorEnterTarget = event.target instanceof Node && view.dom.contains(event.target);');
    expect(enterBlock).toContain('isEditorEnterTarget');
    expect(enterBlock).not.toContain('isComposerEnterTarget(event.target)');
    expect(enterBlock).toContain('!isVoiceInputShortcutMatch(event, voiceShortcutRef.current)');
    expect(enterBlock).toContain('resolveComposerEnterIntent(');
    expect(enterBlock).toContain('getComposerSendShortcutPreference()');
    expect(enterBlock).toContain('platform: window.electronAPI?.platform');
    expect(enterBlock).toContain('turnRunning: showStopButtonRef.current');
    expect(enterBlock).toContain('event.stopPropagation();');
    expect(chatInputSource).toContain('void voiceInputStopAndSendRef.current(enterIntent);');
  });

  it('uses the configured composer shortcut in send and voice tooltips', () => {
    expect(chatInputSource).toContain(
      'const { preference: composerSendShortcutPreference } = useComposerSendShortcutPreference();',
    );
    expect(chatInputSource).toContain(
      'const composerSendShortcutLabel = getComposerSendShortcutLabel(',
    );
    expect(chatInputSource).toContain('window.electronAPI?.platform');
    expect(chatInputSource).toContain(
      "`${t('newChat.chatInput.voiceInput.finishAndSend')} · ${composerSendShortcutLabel}`",
    );
    expect(chatInputSource).toContain(
      "`${t('newChat.sendButton.send')} · ${composerSendShortcutLabel}`",
    );
    expect(chatInputSource).toContain("t('newChat.sendButton.queueTooltipSendMode', {");
    expect(chatInputSource).toContain('shortcut: composerSendShortcutLabel');
    expect(chatInputSource).not.toContain(
      "`${t('newChat.chatInput.voiceInput.finishAndSend')} · Enter`",
    );
    expect(chatInputSource).not.toContain("`${t('newChat.sendButton.send')} · Enter`");
  });

  it('allows release-to-send while listening before ASR draft arrives', () => {
    expect(chatInputSource).toContain(
      'const canReleaseVoiceToSend = Boolean(!disabled && (voiceInput.isListening || canSend || hasVoiceDraftText));',
    );
  });

  it('keeps stop/refine/send alive when the active conversation changes', () => {
    const handleClickSendBlock = extractBetween(
      chatInputSource,
      "const handleClickSend = useCallback(async (deliveryMode: MessageDeliveryMode = 'queue') => {",
      'useEffect(() => {\n    voiceInputStopAndSendRef.current = handleClickSend;',
    );
    expect(handleClickSendBlock).toContain('voiceInput.isBusy');
    expect(handleClickSendBlock).toContain('voiceInputStopAndSendPromiseRef.current = stopAndSend;');
    expect(handleClickSendBlock).toContain("await handleVoiceInputStop({ waitForRefinement: true });");
    expect(handleClickSendBlock).toContain('Do not send the pre-existing draft/attachments');
    expect(handleClickSendBlock).toContain('catch {\n            // Voice stop failures');
    expect(handleClickSendBlock).toContain('await dispatchSend(deliveryMode);');
    expect(handleClickSendBlock).toContain('!voiceInput.isListening && !currentCanSend');

    const restoreEffectBlock = extractBetween(
      chatInputSource,
      'const pendingStopAndSend = voiceInputStopAndSendPromiseRef.current;',
      "// storageKey actually changed — swap the editor's content.",
    );
    expect(restoreEffectBlock).toContain('await pendingStopAndSend;');
    expect(restoreEffectBlock).toContain("await voiceInputStopRef.current({ waitForRefinement: true });");
    expect(restoreEffectBlock).toContain('if (isCurrentTransition()) {');
    expect(restoreEffectBlock).toContain('restoreNextDraft();');
    expect(chatInputSource).toContain('}, [editor, storageKey, voiceInput.isBusy]);');
    expect(chatInputSource).not.toContain('}, [editor, handleVoiceInputStop, storageKey, voiceInput.isBusy]);');
  });

  it('keeps storageKey hydration and stop completion safe across switch races', () => {
    const initialHydrationBlock = extractBetween(
      chatInputSource,
      'if (prevEditorKey === storageKey) {',
      'editorStorageKeyRef.current = storageKey;',
    );
    expect(initialHydrationBlock).toContain('storageKey !== undefined');
    expect(initialHydrationBlock).not.toContain('editor.isEditable');

    const restoreEffectBlock = extractBetween(
      chatInputSource,
      'const transitionSeq = storageKeyTransitionSeqRef.current + 1;',
      "// storageKey actually changed — swap the editor's content.",
    );
    expect(chatInputSource).toContain('const latestStorageKeyRef = useRef<string | undefined>(storageKey);');
    expect(restoreEffectBlock).toContain('if (!hasHydratedRef.current) return;');
    expect(restoreEffectBlock).toContain('let cancelled = false;');
    expect(restoreEffectBlock).toContain('!cancelled');
    expect(restoreEffectBlock).toContain('!editor.isDestroyed');
    expect(restoreEffectBlock).toContain('latestStorageKeyRef.current === storageKey');
    expect(restoreEffectBlock).toContain('if (!isCurrentTransition()) return;');
    expect(restoreEffectBlock).toContain('return () => {\n        cancelled = true;\n      };');

    const waitForBusyCompletionBlock = extractBetween(
      voiceInputSource,
      'const waitForBusyCompletion = useCallback((waitForRefinement: boolean) => {',
      'const stop = useCallback(async (options?: VoiceInputStopOptions) => {',
    );
    expect(voiceInputSource).toContain('type StopCompletionWaiter = {');
    expect(voiceInputSource).toContain('const stopCompletionWaitersRef = useRef<StopCompletionWaiter[]>([]);');
    expect(waitForBusyCompletionBlock).toContain('stopCompletionWaitersRef.current = [...stopCompletionWaitersRef.current, waiter];');
    expect(waitForBusyCompletionBlock).toContain('stopCompletionWaitersRef.current.filter((item) => item !== waiter)');

    const resolveStopCompletionBlock = extractBetween(
      voiceInputSource,
      "const resolveStopCompletion = useCallback((mode: 'raw' | 'all' = 'all') => {",
      'const stopEngine = useCallback(async () => {',
    );
    expect(resolveStopCompletionBlock).toContain("if (mode === 'raw' && waiter.waitForRefinement)");
    expect(voiceInputSource).toContain("resolveStopCompletion('raw');");

    const stopBlock = extractBetween(
      voiceInputSource,
      'const stop = useCallback(async (options?: VoiceInputStopOptions) => {',
      'const cancel = useCallback(async () => {',
    );
    expect(stopBlock).toContain("if (stateRef.current === 'error')");
    expect(stopBlock).toContain("throw new Error(lastErrorRef.current ?? 'Voice input failed.')");
    expect(stopBlock).toContain('const stopWithGate = useCallback(async (options?: VoiceInputStopOptions) => {');
    expect(stopBlock).toContain('if (stopInFlightPromiseRef.current) return stopInFlightPromiseRef.current;');
    expect(voiceInputSource).toContain('const stopInFlightPromiseRef = useRef<Promise<void> | null>(null);');
    expect(stopBlock).toContain('throw new Error(startResult.error);');
    const startFailureBlock = extractBetween(
      stopBlock,
      'if (!startResult.ok) {',
      'throw new Error(startResult.error);\n        }\n        runId = startResult.runId;',
    );
    expect(startFailureBlock).toContain('resolveStopCompletion();');
    const noStartBlock = extractBetween(
      stopBlock,
      '} else {\n        invalidateStartAttempt();',
      'return;\n      }\n    } else {',
    );
    expect(noStartBlock).toContain('resolveStopCompletion();');
  });

  it('waits for refinement before finishing a plain voice stop', () => {
    expect(chatInputSource).toContain('const handleVoiceInputPlainStop = useCallback(() => (');
    expect(chatInputSource).toContain('handleVoiceInputStop({ waitForRefinement: true })');
    expect(chatInputSource).toContain('handleVoiceInputStop({ waitForRefinement: true }).catch(() => undefined)');
    expect(chatInputSource).toContain('const handleVoiceInputStopWithRefinement = useCallback((options?: { waitForRefinement?: boolean }) => (');
    expect(chatInputSource).toContain('handleVoiceInputStop({ waitForRefinement: options?.waitForRefinement ?? true })');
    expect(chatInputSource).toContain('handleVoiceInputStop({ waitForRefinement: options?.waitForRefinement ?? true }).catch(() => undefined)');
    expect(chatInputSource).toContain('const voiceInputStopRef = useRef(handleVoiceInputStopWithRefinement);');
    expect(chatInputSource).toContain('voiceInputStopRef.current = handleVoiceInputStopWithRefinement;');
    expect(chatInputSource).toContain('await voiceInputStopRef.current({ waitForRefinement: true });');
    expect(chatInputSource).toContain('onStop={handleVoiceInputPlainStop}');
  });

  it('defines the finish-and-send tooltip label in every locale', () => {
    for (const locale of ['zh-CN', 'en', 'ja', 'ko']) {
      const raw = readFileSync(
        resolve(__dirname, '..', 'i18n', 'locales', locale, 'common.json'),
        'utf8',
      );
      const json = JSON.parse(raw) as {
        newChat?: {
          chatInput?: {
            voiceInput?: {
              finishAndSend?: unknown;
            };
          };
        };
      };
      expect(json.newChat?.chatInput?.voiceInput?.finishAndSend).toEqual(expect.any(String));
      expect(json.newChat?.chatInput?.voiceInput?.finishAndSend).not.toBe('');
    }
  });
});

function extractBetween(sourceBlock: string, startNeedle: string, endNeedle: string): string {
  const start = sourceBlock.indexOf(startNeedle);
  const end = sourceBlock.indexOf(endNeedle, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return sourceBlock.slice(start, end);
}
