import { describe, it, expect } from 'vitest';
import {
  normalizeHudSettings,
  parseHudPatch,
  isHudScreenQuestion,
  getHudTransparency,
} from '../hud';
// Value: HUD user contract. New schema has no previous coverage. Unit, no IO.
describe('HUD settings and explicit screen questions', () => {
  it('preserves independent zero and full transparency, rejects malformed patches', () => {
    const value = normalizeHudSettings({
      backgroundTransparency: 100,
      messageTransparency: 0,
      inputTransparency: 74,
    });
    expect(value.backgroundTransparency).toBe(100);
    expect(value.messageTransparency).toBe(0);
    expect(value.inputTransparency).toBe(74);
    expect(parseHudPatch({ imageTransparency: 101 })).toBeNull();
    expect(parseHudPatch({ allowScreen: 'yes' })).toBeNull();
    expect(parseHudPatch({ passThroughComposer: 'yes' })).toBeNull();
    expect(parseHudPatch({ passThroughComposer: true })).toEqual({ passThroughComposer: true });
    expect(normalizeHudSettings({}).passThroughComposer).toBe(false);
    expect(parseHudPatch({ unknown: 2 })).toBeNull();
    expect(parseHudPatch({ inputPosition: 'top' })).toEqual({ inputPosition: 'top' });
  });
  // Moving changes the presentation only: clamp high values and restore exact saved values.
  it.each([
    [0, 0],
    [40, 44],
    [50, 55],
    [95, 100],
    [100, 100],
  ])('temporarily raises %s transparency to %s', (saved, moving) => {
    expect(getHudTransparency(saved, true)).toBe(moving);
    expect(getHudTransparency(saved, false)).toBe(saved);
  });
  // Five-language direct requests must behave alike. Full-message matching keeps
  // quoted requests and negated/technical continuations from authorizing capture.
  it.each([
    '这个界面说的是什么？',
    '帮我看看当前屏幕',
    'What is on my screen?',
    'Explain this screen',
    '這個畫面是什麼意思？',
    '請幫我看看目前的螢幕',
    'この画面を説明してください。',
    '今の画面には何が表示されていますか？',
    '이 화면을 설명해 주세요.',
    '현재 화면에 무엇이 보이나요?',
  ])('recognizes a direct question: %s', (text) => {
    expect(isHudScreenQuestion(text)).toBe(true);
  });
  it.each([
    '你好',
    '不要看我的屏幕',
    '如何实现屏幕截图功能',
    'Do not capture my screen',
    '他说“看看当前屏幕”是什么意思',
    '看看当前屏幕，但不要截图',
    'Explain this screen capture API',
    'What is on my screen? Do not capture it.',
    '請不要查看我的螢幕',
    '請幫我看看目前的螢幕，但不要擷取畫面',
    '「這個畫面是什麼意思？」用英文怎麼說',
    'この画面を見ないでください',
    '「この画面を説明してください」を翻訳して',
    'この画面を説明してください。ただし撮影しないでください。',
    '이 화면을 보지 마세요',
    '“이 화면을 설명해 주세요”를 번역해 주세요',
    '이 화면을 설명해 주세요. 캡처하지 마세요.',
  ])('does not capture ordinary or negated text: %s', (text) => {
    expect(isHudScreenQuestion(text)).toBe(false);
  });
});
