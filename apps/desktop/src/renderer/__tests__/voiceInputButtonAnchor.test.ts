import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const chatInputSource = readFileSync(
  resolve(__dirname, '..', 'components', 'new-chat', 'ChatInput.tsx'),
  'utf8',
).replace(/\r\n?/g, '\n');

/**
 * composer 右下按钮组右对齐,所以「语音按钮与最右主槽之间夹着几个按钮」直接决定语音按钮
 * 自己的屏幕位置。次槽 Stop 只在 streaming 时出现,若它夹在语音与 Send 之间,语音按钮就会
 * 随 streaming / 草稿 / 录音状态整格横跳,而它让出的位置正好被 Stop 占据 —— 用户点完语音想
 * 「原地再点一下停止录音」会误停正在跑的任务。
 * 约束:次槽 Stop 一律在语音按钮左边,语音按钮永远是主槽的左邻。
 */
describe('ChatInput voice button anchor contract', () => {
  // 从次槽 Stop 起、到主槽 sendButtonRef 止,即右下按钮组里语音按钮所在的区间。
  const buttonGroupBlock = extractBetween(
    chatInputSource,
    '{showSecondaryStop && (',
    '<span ref={sendButtonRef}',
  );

  it('renders the secondary stop button to the left of the voice input button', () => {
    const secondaryStopIndex = buttonGroupBlock.indexOf('<SendButton');
    const voiceButtonIndex = buttonGroupBlock.indexOf('<VoiceInputButton');

    expect(secondaryStopIndex).toBeGreaterThanOrEqual(0);
    expect(voiceButtonIndex).toBeGreaterThan(secondaryStopIndex);
  });

  it('keeps the voice input button as the immediate left neighbour of the main send slot', () => {
    const afterVoiceButton = buttonGroupBlock.slice(
      buttonGroupBlock.indexOf('<VoiceInputButton'),
    );

    // 语音按钮与主槽之间不得再插入任何 Send/Stop 控件。
    expect(afterVoiceButton).not.toContain('<SendButton');
  });

  it('does not fork the secondary stop placement on listening state', () => {
    // 只在录音态挪 Stop 是不够的:录音结束且草稿非空时 Stop 会跳回右边,语音按钮同样
    // 左移一格,只是把误点风险推迟到「刚点完停止录音」那一刻。
    expect(chatInputSource).toContain(
      'const showSecondaryStop =\n    showStopButton && (canSend || voiceInput.isBusy) && !sendDispatchInFlight;',
    );
    expect(chatInputSource).toContain(
      'const mainSlotIsStop =\n    showStopButton && (sendDispatchInFlight || (!canSend && !voiceInput.isBusy));',
    );
  });

  it('keeps the slot assignment stable across the whole voice lifecycle', () => {
    // 停止录音 → submitting/refining → 草稿落地之间 canSend 仍为 false;若按 isListening
    // 判定,这一段会退化成 streaming idle,Stop 弹回主槽再弹走,肉眼可见闪一下。
    // isBusy = listening || submitting || refining,覆盖整段生命周期。
    const slotDecisionBlock = extractBetween(
      chatInputSource,
      'const mainSlotIsStop =',
      'useEffect(() => {\n    voiceInputCanStopAndSendRef.current = !sendButtonDisabled;',
    );

    expect(slotDecisionBlock).not.toContain('voiceInput.isListening');
    expect(slotDecisionBlock).toContain('voiceInput.isBusy');
  });

  it('keeps the stop controls enabled while voice input owns the editor lock', () => {
    // The surrounding voice lifecycle lock must not disable the button or
    // shortcut that is needed to end the active recording.
    expect(chatInputSource).toContain('const disabledRef = useRef(composerEditorLocked);');
    expect(chatInputSource).toContain('disabledRef.current = composerEditorLocked;');
    expect(chatInputSource).toContain('disabled={composerEditorLocked || !editor}');
    expect(chatInputSource).not.toContain('disabled={composerMutationLocked || !editor}');
  });
});

function extractBetween(sourceBlock: string, startNeedle: string, endNeedle: string): string {
  const start = sourceBlock.indexOf(startNeedle);
  const end = sourceBlock.indexOf(endNeedle, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return sourceBlock.slice(start, end);
}
