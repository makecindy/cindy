import { describe, expect, it } from 'vitest';
import { spacing } from '@/theme/tokens';
import {
  MOBILE_COMPOSER_CONTROL_SIZE,
  MOBILE_COMPOSER_TOOL_GAP,
  MOBILE_COMPOSER_VOICE_ANCHOR_CARD_BOTTOM,
  MOBILE_COMPOSER_VOICE_ANCHOR_RIGHT,
  resolveMobileComposerVoiceButtonAnchorStyle,
  resolveMobileComposerVoiceButtonPlacement,
} from '@/session/composerVoiceButtonAnchor';

describe('resolveMobileComposerVoiceButtonPlacement', () => {
  it('行尾有 trailing 时向左让位,否则贴行尾', () => {
    expect(resolveMobileComposerVoiceButtonPlacement({ hasTrailingAction: true })).toEqual({
      floating: true,
      inline: false,
    });
    expect(resolveMobileComposerVoiceButtonPlacement({ hasTrailingAction: false })).toEqual({
      floating: false,
      inline: true,
    });
  });
});

describe('resolveMobileComposerVoiceButtonAnchorStyle', () => {
  it('收起态按行垂直居中,不写 bottom 数值', () => {
    const style = resolveMobileComposerVoiceButtonAnchorStyle({
      cardLayout: false,
      floating: false,
    });
    expect(style).toEqual({
      position: 'absolute',
      right: MOBILE_COMPOSER_VOICE_ANCHOR_RIGHT,
      top: '50%',
      bottom: 'auto',
      transform: [{ translateY: -MOBILE_COMPOSER_CONTROL_SIZE / 2 }],
      zIndex: 2,
    });
    expect(style.bottom).toBe('auto');
    expect(style.top).not.toBe('auto');
  });

  it('卡片态钉在工具排底边,显式清掉 top 与 translateY', () => {
    const style = resolveMobileComposerVoiceButtonAnchorStyle({
      cardLayout: true,
      floating: false,
    });
    expect(style).toEqual({
      position: 'absolute',
      right: MOBILE_COMPOSER_VOICE_ANCHOR_RIGHT,
      top: 'auto',
      bottom: MOBILE_COMPOSER_VOICE_ANCHOR_CARD_BOTTOM,
      transform: [],
      zIndex: 2,
    });
    expect(style.top).toBe('auto');
    expect(style.transform).toEqual([]);
    expect(Object.prototype.hasOwnProperty.call(style, 'top')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(style, 'bottom')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(style, 'transform')).toBe(true);
  });

  it('有 trailing 时两态都向左让出发送键宽度', () => {
    const inset = MOBILE_COMPOSER_VOICE_ANCHOR_RIGHT
      + MOBILE_COMPOSER_CONTROL_SIZE
      + MOBILE_COMPOSER_TOOL_GAP;
    expect(resolveMobileComposerVoiceButtonAnchorStyle({
      cardLayout: false,
      floating: true,
    }).right).toBe(inset);
    expect(resolveMobileComposerVoiceButtonAnchorStyle({
      cardLayout: true,
      floating: true,
    }).right).toBe(inset);
    expect(inset).toBe(spacing.md + 34 + 6);
  });

  it('卡片底边与间距 token 同源,避免再写 8 与 paddingBottom 对不齐', () => {
    expect(MOBILE_COMPOSER_VOICE_ANCHOR_CARD_BOTTOM).toBe(spacing.sm);
    expect(MOBILE_COMPOSER_VOICE_ANCHOR_RIGHT).toBe(spacing.md);
  });
});
