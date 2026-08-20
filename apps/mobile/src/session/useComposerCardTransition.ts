import { useEffect } from 'react';
import { Easing, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';

import { getCachedReduceMotionEnabled } from '@/hooks/useReduceMotion';
import { motionDuration, motionEasing } from '@/theme/tokens';

/** 展开:重浮层入场档(250ms),与 iOS 键盘弹出同量级,保持「卡片展开与键盘上滑是同一段运动」。 */
const CARD_EXPAND_EASING = Easing.bezier(...motionEasing.out);
/** 收起:尺寸变化档退场曲线。 */
const CARD_COLLAPSE_EASING = Easing.bezier(...motionEasing.in);

/**
 * Composer 简洁态 ↔ 聚焦卡片态切换的过渡进度(0 = 简洁态,1 = 卡片态)。
 *
 * 曾经用 LayoutAnimation.configureNext 实现整段过渡,但 LayoutAnimation 是
 * **全局**的:同一次布局提交里所有 frame 变化的视图(消息列表 padding、
 * 「跳到底部」浮标、KAV 重排下的任意兄弟视图)都会被卷进动画;而 cardActive
 * 翻转的 250ms 窗口恰好与键盘起落重叠,动画被打断时原生 animator 不回滚
 * transform,把无关视图冻结在中间态(胶囊缩在半空、浮标压在输入文字上,
 * 都是这个竞态的实测截图)。因此这里改为 Reanimated 驱动的**局部**进度值:
 * 只有显式消费 progress 的样式跟着动,withTiming 天然可中断重定向,
 * 竞态窗口内被打断也只是平滑改道,不存在冻结中间态。
 *
 * 消费方(MobileComposerInputRow)把圆角 / 内边距 / 工具排高度 / 语音让位
 * 都插值在这一个 progress 上;语音按钮的 absolute 锚点不需要单独动画——
 * 它跟随容器形变逐帧重排,与旧 LayoutAnimation 时代的位移路径一致。
 *
 * reduce-motion(含首帧缓存未知的窗口)直切,对齐 useReduceMotion
 * 「只有 === false 才播」的约定。
 */
export function useComposerCardTransition(cardActive: boolean): SharedValue<number> {
  const progress = useSharedValue(cardActive ? 1 : 0);

  useEffect(() => {
    const target = cardActive ? 1 : 0;
    if (getCachedReduceMotionEnabled() !== false) {
      progress.value = target;
      return;
    }
    progress.value = withTiming(target, {
      duration: cardActive ? motionDuration.enter : motionDuration.base,
      easing: cardActive ? CARD_EXPAND_EASING : CARD_COLLAPSE_EASING,
    });
  }, [cardActive, progress]);

  return progress;
}
