import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const chatInputSource = readFileSync(
  resolve(__dirname, '..', 'components', 'new-chat', 'ChatInput.tsx'),
  'utf8',
).replace(/\r\n?/g, '\n');
const pendingQueuePanelSource = readFileSync(
  resolve(__dirname, '..', 'components', 'new-chat', 'PendingQueuePanel.tsx'),
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
      '// Plain Enter keeps the existing queue semantics.',
      'return true;\n        }\n        return false;',
    );
    const windowComposerSteerBlock = extractBetween(
      windowKeydownBlock,
      'if (\n        showStopButtonRef.current &&',
      "if (\n        currentState === 'listening'",
    );
    const editorSteerChoice = extractBetween(
      editorEnterBlock,
      'const wantsSteer =',
      "void dispatchSendRef.current(wantsSteer ? 'steer' : 'queue');",
    );

    expect(chatInputSource).toContain('const composerCanSubmitRef = useRef(false);');
    expect(chatInputSource).toContain('composerCanSubmitRef.current = !sendButtonDisabled;');
    expect(windowKeydownBlock).toContain('showStopButtonRef.current');
    expect(windowKeydownBlock).toContain('isComposerEnterTarget(event.target)');
    expect(windowKeydownBlock).toContain("event.key === 'Enter'");
    expect(windowKeydownBlock).toContain('event.metaKey || event.ctrlKey');
    expect(windowKeydownBlock).toContain('!event.altKey');
    expect(windowKeydownBlock).toContain("currentState !== 'listening'");
    expect(windowKeydownBlock).toContain("void dispatchSendRef.current('steer');");
    expect(chatInputSource).toContain("'Alt-Enter': () => this.editor.commands.setHardBreak()");
    expect(chatInputSource).toContain('ComposerHardBreak');
    expect(chatInputSource).toContain('turnRunning={showStopButton}');
    expect(chatInputSource).toContain('onSteer={onQueueSteer ? handleQueueSteer : undefined}');
    expect(editorEnterBlock).toContain("event.key === 'Enter' && !event.shiftKey && !event.altKey");
    expect(editorEnterBlock).toContain("voiceInputStateRef.current !== 'listening'");
    expect(editorEnterBlock).toContain(
      "void dispatchSendRef.current(wantsSteer ? 'steer' : 'queue');",
    );
    // Tiptap's document is current before React's send-button effect updates
    // composerCanSubmitRef. The shortcut must not use that lagging UI mirror
    // to choose between steer and normal queue delivery.
    expect(windowComposerSteerBlock).not.toContain('composerCanSubmitRef.current');
    expect(editorSteerChoice).not.toContain('composerCanSubmitRef.current');
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
});

function extractBetween(sourceBlock: string, startNeedle: string, endNeedle: string): string {
  const start = sourceBlock.indexOf(startNeedle);
  const end = sourceBlock.indexOf(endNeedle, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return sourceBlock.slice(start, end);
}
