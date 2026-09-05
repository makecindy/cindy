import { useRef } from 'react';
import { LayoutAnimation, Platform, UIManager } from 'react-native';
import { useReduceMotionEnabled } from '@/hooks/useReduceMotion';
import { motionDuration } from '@/theme/tokens';
import type { MobileKeyboardState } from '@/session/useMobileKeyboardState';

// 旧架构 Android 需要显式开启 LayoutAnimation;新架构(Fabric)下该开关是 no-op。
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

/**
 * Composer 简洁态 ↔ 聚焦卡片态切换的布局过渡动画。
 *
 * 检测 cardActive 翻转时注册一次 LayoutAnimation，让下一帧的布局变化
 * （输入行变全宽、工具排出现 / 消失、卡片高度与圆角变化、消息列表 padding 联动）
 * 整体平滑过渡，而不是硬切。
 *
 * 收到 iOS frame 的同一轮更新及键盘动画期间不配置另一条动画。焦点先于
 * 键盘事件到达、硬件键盘或面板 / 语音切换时，保留普通尺寸过渡；后续键盘
 * 事件取得动画控制权。沿用已有的 render 阶段布局提交前挂点。
 *
 * 三段动画的分工：
 * - update：存活视图的位置 / 尺寸平滑（卡片长高、输入行变全宽、absolute 锚点的
 *   麦克风从行内滑到工具排——常驻按钮靠它保持连续，不闪不跳）；
 * - create / delete（opacity）：工具排按钮（加号 / 权限 / 模型 / 发送）只在
 *   卡片态挂载，出现时在最终位置原地渐显、收起时原地渐隐，没有位移感。
 */
export function useComposerCardTransition(
  cardActive: boolean,
  keyboard: MobileKeyboardState,
): void {
  const reduceMotion = useReduceMotionEnabled();
  const transition = keyboard.transition.current;
  const prevRef = useRef({ cardActive, transition });
  const previous = prevRef.current;
  prevRef.current = { cardActive, transition };
  const keyboardOwnsTransition = Platform.OS === 'ios' && (
    previous.transition !== transition
    || (transition !== null && Date.now() - transition.startedAt < transition.event.duration)
  );
  if (previous.cardActive !== cardActive && !keyboardOwnsTransition && reduceMotion === false) {
    LayoutAnimation.configureNext({
      create: { property: 'opacity', type: 'easeInEaseOut' },
      delete: { property: 'opacity', type: 'easeInEaseOut' },
      duration: motionDuration.base,
      update: { type: 'easeInEaseOut' },
    });
  }
}
