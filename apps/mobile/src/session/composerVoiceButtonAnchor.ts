import { spacing } from '@/theme/tokens';

export const MOBILE_COMPOSER_CONTROL_SIZE = 34;
export const MOBILE_COMPOSER_TOOL_GAP = 6;
/** 语音按钮 absolute 锚点距 composer 内容区右缘的距离。
 * 消息列表的「跳到底部」浮标按同一常量推导麦克风所在列,保持两者圆心同列。 */
export const MOBILE_COMPOSER_VOICE_ANCHOR_RIGHT = spacing.md;
/** 卡片态麦克风贴工具排底边的距离,与 rowCard.paddingBottom 同源。 */
export const MOBILE_COMPOSER_VOICE_ANCHOR_CARD_BOTTOM = spacing.sm;

export interface MobileComposerVoiceButtonPlacement {
  floating: boolean;
  inline: boolean;
}

/**
 * 语音按钮的左右分配：行尾有发送 / 创建 / 停止等 trailing 按钮时向左让位
 * （floating）、否则贴行尾（inline）。判定看「是否有 trailing 按钮」而非
 * 「是否有文字」——附件-only（无文字但发送按钮可见）时同样需要让位。
 * 听写中按钮不隐藏——对齐桌面版设计，同一颗按钮录音中变为「停止录音」形态。
 */
export function resolveMobileComposerVoiceButtonPlacement(input: {
  hasTrailingAction: boolean;
}): MobileComposerVoiceButtonPlacement {
  return {
    floating: input.hasTrailingAction,
    inline: !input.hasTrailingAction,
  };
}

export type MobileComposerVoiceButtonAnchorStyle = {
  position: 'absolute';
  right: number;
  top: 0;
  bottom: 0;
  paddingBottom: number;
  justifyContent: 'center' | 'flex-end';
  alignItems: 'flex-end';
  zIndex: number;
};

/**
 * 语音按钮定位壳的样式。壳铺在整张输入卡上，按钮是壳的 in-flow 子节点：
 * 收起态垂直居中，卡片态贴底（工具排）。
 *
 * 两态都写数字 top / bottom / paddingBottom，禁止 `top: '50%'` / `'auto'` /
 * `undefined`：
 * RN 扁平化会跳过 undefined，Yoga 也清不掉已经生效的百分比 top，麦克风会
 * 停在卡片中部挡住文字（#3053 用 `top: 'auto'` 仍失败）。justifyContent
 * 负责垂直落点，不靠 transform / 百分比。卡片态让壳延伸到卡片底边，再用
 * paddingBottom 保持按钮视觉位置：直接父层在按钮下方仍有空间，不会裁掉 hitSlop。
 */
export function resolveMobileComposerVoiceButtonAnchorStyle(input: {
  cardLayout: boolean;
  floating: boolean;
}): MobileComposerVoiceButtonAnchorStyle {
  const right = input.floating
    ? MOBILE_COMPOSER_VOICE_ANCHOR_RIGHT + MOBILE_COMPOSER_CONTROL_SIZE + MOBILE_COMPOSER_TOOL_GAP
    : MOBILE_COMPOSER_VOICE_ANCHOR_RIGHT;

  return {
    position: 'absolute',
    right,
    top: 0,
    bottom: 0,
    paddingBottom: input.cardLayout ? MOBILE_COMPOSER_VOICE_ANCHOR_CARD_BOTTOM : 0,
    justifyContent: input.cardLayout ? 'flex-end' : 'center',
    alignItems: 'flex-end',
    zIndex: 2,
  };
}
