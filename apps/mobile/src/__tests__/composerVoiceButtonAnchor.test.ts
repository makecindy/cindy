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
  it('收起态铺满父高、垂直居中,不写百分比 top', () => {
    const style = resolveMobileComposerVoiceButtonAnchorStyle({
      cardLayout: false,
      floating: false,
    });
    expect(style).toEqual({
      position: 'absolute',
      right: MOBILE_COMPOSER_VOICE_ANCHOR_RIGHT,
      top: 0,
      bottom: 0,
      paddingBottom: 0,
      justifyContent: 'center',
      alignItems: 'flex-end',
      zIndex: 2,
    });
    expect(style.top).toBe(0);
    expect(style.bottom).toBe(0);
  });

  it('卡片态壳延伸到底边,靠 paddingBottom + flex-end 保持按钮位置与纵向 hitSlop', () => {
    const style = resolveMobileComposerVoiceButtonAnchorStyle({
      cardLayout: true,
      floating: false,
    });
    expect(style).toEqual({
      position: 'absolute',
      right: MOBILE_COMPOSER_VOICE_ANCHOR_RIGHT,
      top: 0,
      bottom: 0,
      paddingBottom: MOBILE_COMPOSER_VOICE_ANCHOR_CARD_BOTTOM,
      justifyContent: 'flex-end',
      alignItems: 'flex-end',
      zIndex: 2,
    });
    expect(style.top).toBe(0);
    expect(style.bottom).toBe(0);
    expect(style.paddingBottom).toBe(MOBILE_COMPOSER_VOICE_ANCHOR_CARD_BOTTOM);
    expect(style.justifyContent).toBe('flex-end');
    expect(Object.prototype.hasOwnProperty.call(style, 'top')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(style, 'bottom')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(style, 'transform')).toBe(false);
  });

  it('两态都不用百分比 top 或 auto,避免 RN 残留把麦克风停在卡片中部', () => {
    for (const cardLayout of [false, true]) {
      for (const floating of [false, true]) {
        const style = resolveMobileComposerVoiceButtonAnchorStyle({ cardLayout, floating });
        expect(style.top).toBe(0);
        expect(style.bottom).toBe(0);
        expect(typeof style.paddingBottom).toBe('number');
        expect(style).not.toHaveProperty('transform');
      }
    }
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
