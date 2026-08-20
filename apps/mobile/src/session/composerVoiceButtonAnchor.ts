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
  top: '50%' | 'auto';
  bottom: number | 'auto';
  transform: Array<{ translateY: number }>;
  zIndex: number;
};

/**
 * 语音按钮的完整定位。必须一次性写出 top / bottom / transform 三套互斥键,
 * 不能靠 StyleSheet 数组后项写 `undefined` 去覆盖前项:
 * RN 扁平化会跳过 undefined,卡片态就会残留收起态的 `top: '50%'`,麦克风停在
 * 卡片中部(工具排占位空着)。漏写的键在原生侧也可能继续沿用上一帧的 inset。
 */
export function resolveMobileComposerVoiceButtonAnchorStyle(input: {
  cardLayout: boolean;
  floating: boolean;
}): MobileComposerVoiceButtonAnchorStyle {
  const right = input.floating
    ? MOBILE_COMPOSER_VOICE_ANCHOR_RIGHT + MOBILE_COMPOSER_CONTROL_SIZE + MOBILE_COMPOSER_TOOL_GAP
    : MOBILE_COMPOSER_VOICE_ANCHOR_RIGHT;

  if (input.cardLayout) {
    return {
      position: 'absolute',
      right,
      top: 'auto',
      bottom: MOBILE_COMPOSER_VOICE_ANCHOR_CARD_BOTTOM,
      transform: [],
      zIndex: 2,
    };
  }

  return {
    position: 'absolute',
    right,
    top: '50%',
    bottom: 'auto',
    transform: [{ translateY: -MOBILE_COMPOSER_CONTROL_SIZE / 2 }],
    zIndex: 2,
  };
}
