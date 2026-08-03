import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  resolveComposerEnterIntent,
  type ComposerEnterEvent,
  type ComposerEnterIntent,
} from '@/hooks/useComposerSendShortcutPreference';

const chatInputSource = readFileSync(
  resolve(__dirname, '..', 'components', 'new-chat', 'ChatInput.tsx'),
  'utf8',
).replace(/\r\n?/g, '\n');
const pendingQueuePanelSource = readFileSync(
  resolve(__dirname, '..', 'components', 'new-chat', 'PendingQueuePanel.tsx'),
  'utf8',
).replace(/\r\n?/g, '\n');
const composerSettingsSource = readFileSync(
  resolve(__dirname, '..', 'components', 'settings', 'ComposerSendShortcutSection.tsx'),
  'utf8',
).replace(/\r\n?/g, '\n');

describe('ChatInput steer shortcut contract', () => {
  it('routes Cmd/Ctrl+Enter in the composer through steer while a turn is running', () => {
    const windowKeydownBlock = extractBetween(
      chatInputSource,
      'const handleKeyDown = (event: KeyboardEvent) => {',
      'const handleKeyUp = (event: KeyboardEvent) => {',
    );
    const editorEnterBlock = extractBetween(
      chatInputSource,
      '// Resolve the configurable send shortcut after structured list handling.',
      'return false;\n      },\n    },',
    );
    const windowComposerCaptureBlock = extractBetween(
      windowKeydownBlock,
      'const enterIntent = resolveComposerEnterIntent(',
      "if (\n        currentState === 'listening'",
    );
    expect(chatInputSource).toContain('const composerCanSubmitRef = useRef(false);');
    expect(chatInputSource).toContain('composerCanSubmitRef.current = !sendButtonDisabled;');
    expect(windowKeydownBlock).toContain('showStopButtonRef.current');
    expect(windowKeydownBlock).toContain('const platform = window.electronAPI?.platform;');
    expect(windowKeydownBlock).toContain('isComposerEnterTarget(event.target)');
    expect(windowKeydownBlock).toContain('resolveComposerEnterIntent(');
    expect(windowKeydownBlock).toContain('getComposerSendShortcutPreference()');
    expect(windowKeydownBlock).toContain(
      'const isModifiedEnter = hasComposerModifier(event, platform);',
    );
    expect(windowKeydownBlock).toContain("(enterIntent === 'queue' || enterIntent === 'steer')");
    expect(windowKeydownBlock).toContain("currentState !== 'listening'");
    expect(windowKeydownBlock).toContain('void dispatchSendRef.current(enterIntent);');
    expect(chatInputSource).toContain("'Alt-Enter': () => this.editor.commands.setHardBreak()");
    expect(chatInputSource).toContain('ComposerHardBreak');
    expect(chatInputSource).toContain('turnRunning={showStopButton}');
    expect(chatInputSource).toContain('onSteer={onQueueSteer ? handleQueueSteer : undefined}');
    expect(editorEnterBlock).toContain('resolveComposerEnterIntent(');
    expect(editorEnterBlock).toContain('getComposerSendShortcutPreference()');
    expect(editorEnterBlock).toContain('turnRunning: showStopButtonRef.current');
    expect(editorEnterBlock).toContain('platform: window.electronAPI?.platform');
    expect(editorEnterBlock).toContain("if (enterIntent === 'native') return false;");
    expect(editorEnterBlock).toContain("if (enterIntent === 'ignore')");
    expect(editorEnterBlock).toContain('void dispatchSendRef.current(enterIntent);');
    // Tiptap's document is current before React's send-button effect updates
    // composerCanSubmitRef. The resolver must not use that lagging UI mirror.
    expect(windowComposerCaptureBlock).not.toContain('composerCanSubmitRef.current');
    expect(editorEnterBlock).not.toContain('composerCanSubmitRef.current');
  });

  it('steers without an interrupt confirmation gate (same-turn injection)', () => {
    // 2026-07-12 统一同轮注入后,插话不再打断当前任务,二次确认弹窗随之移除。
    // 回归防线:确认门相关符号不得重新出现在 ChatInput 里。
    const handleQueueSteerBlock = extractBetween(
      chatInputSource,
      'const handleQueueSteer = useCallback(async (clientId: string) => {',
      "const handleClickSend = useCallback(async (deliveryMode: MessageDeliveryMode = 'queue') => {",
    );

    expect(handleQueueSteerBlock).toContain('return onQueueSteer(clientId);');
    expect(handleQueueSteerBlock).toContain('[onQueueSteer]');
    expect(chatInputSource).not.toContain('runAfterInterruptConfirmation');
    expect(chatInputSource).not.toContain('confirmInterruptSteer');
    expect(chatInputSource).not.toContain('interruptConfirm');
    expect(pendingQueuePanelSource).toContain('turnRunning?: boolean;');
    expect(pendingQueuePanelSource).toContain(
      "const base = t(turnRunning ? 'newChat.pendingQueue.steerRunningTip' : 'newChat.pendingQueue.steerPausedTip');",
    );
  });

  it('keeps mode A queue and running-turn steer semantics on the Tiptap path', () => {
    expect(
      resolveComposerEnterIntent(makeEnterEvent(), 'enter', {
        turnRunning: false,
        platform: 'darwin',
      }),
    ).toBe('queue');
    expect(
      resolveComposerEnterIntent(makeEnterEvent({ metaKey: true }), 'enter', {
        turnRunning: true,
        platform: 'darwin',
      }),
    ).toBe('steer');
    expect(
      resolveComposerEnterIntent(makeEnterEvent({ ctrlKey: true }), 'enter', {
        turnRunning: false,
        platform: 'darwin',
      }),
    ).toBe('queue');
  });

  it('maps mode B modifier send and native/boundary cases without list interception', () => {
    const modeB = (event: ComposerEnterEvent): ComposerEnterIntent =>
      resolveComposerEnterIntent(event, 'modifier-enter', {
        turnRunning: true,
        platform: 'darwin',
      });

    expect(modeB(makeEnterEvent())).toBe('native');
    expect(modeB(makeEnterEvent({ metaKey: true }))).toBe('queue');
    expect(modeB(makeEnterEvent({ ctrlKey: true }))).toBe('queue');
    expect(modeB(makeEnterEvent({ shiftKey: true }))).toBeNull();
    expect(modeB(makeEnterEvent({ altKey: true }))).toBeNull();
    expect(modeB(makeEnterEvent({ isComposing: true }))).toBe('native');
    expect(modeB(makeEnterEvent({ repeat: true }))).toBe('native');
    expect(modeB(makeEnterEvent({ metaKey: true, repeat: true }))).toBe('ignore');
  });

  it('wires Settings preference updates to ChatInput copy while preserving row-level steer', () => {
    expect(composerSettingsSource).toContain('useComposerSendShortcutPreference()');
    expect(composerSettingsSource).toContain("setPreference(enabled ? 'modifier-enter' : 'enter')");
    expect(composerSettingsSource).toContain("setPreference('enter');");
    expect(chatInputSource).toContain('useComposerSendShortcutPreference()');
    expect(chatInputSource).toContain('getComposerSendShortcutLabel(');
    expect(chatInputSource).toContain("composerSendShortcutPreference === 'modifier-enter'");
    expect(chatInputSource).toContain('newChat.sendButton.queueTooltipSendMode');
    expect(pendingQueuePanelSource).toContain('isPendingQueueSteerShortcut');
    expect(pendingQueuePanelSource).toContain('void onSteer(entry.clientId);');
  });
});

function makeEnterEvent(overrides: Partial<ComposerEnterEvent> = {}): ComposerEnterEvent {
  return {
    key: 'Enter',
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ctrlKey: false,
    repeat: false,
    isComposing: false,
    ...overrides,
  };
}

function extractBetween(sourceBlock: string, startNeedle: string, endNeedle: string): string {
  const start = sourceBlock.indexOf(startNeedle);
  const end = sourceBlock.indexOf(endNeedle, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return sourceBlock.slice(start, end);
}
