/**
 * SheetModal —— 底部 sheet 共用的 Modal 外壳(背板淡入淡出 + 面板自底部滑入滑出)。
 *
 * 动机:此前 5 个底部 sheet 都用 `<Modal animationType="slide">` 且压暗背板放在 Modal
 * 内容里,导致背板跟着面板一起从底部升起(视觉跳变,违反规则 7)。本组件把两层动画拆开:
 *   - 背板:absoluteFill,原地纯透明度淡入(150ms easeOut)/ 淡出(120ms easeIn),
 *     对齐 DeviceMenuModal 的 §14.4 ≤150ms 纯透明度过渡模式;
 *   - 内容层:justifyContent flex-end,translateY 由同一 progress 驱动自底部滑入滑出,
 *     面板(SheetSurface 或 ad-hoc 面板)由调用方作为 children 放入。
 * 关闭动画播完才卸载 Modal(mounted 状态),避免面板/背板瞬间消失的空白帧。
 * mounted/progress/进场时机(iOS onShow)/onClosed 延迟触发统一走 useModalFadeLifecycle。
 *
 * 调用方始终渲染 `<SheetModal visible={...}>`(不要再写 `visible ? <Modal/> : null`):
 * 「不可见时不渲染」的效果由内部 Modal 的 visible={mounted} 承担。
 */
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Animated,
  KeyboardAvoidingView,
  Modal,
  Pressable,
  StyleSheet,
  useWindowDimensions,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { BlurBackdrop } from '@/session/BlurBackdrop';
import { useModalFadeLifecycle } from '@/session/useModalFadeLifecycle';
import { useThemedStyles, type ThemeColors } from '@/theme';

export interface SheetModalProps {
  visible: boolean;
  /** Android 返回键 / iOS 关闭手势(调用方可做两段式:二级先回一级)。 */
  onRequestClose: () => void;
  /** 点背板关闭(与 onRequestClose 分开:二级叠层场景两者语义不同)。 */
  onBackdropPress: () => void;
  backdropTestID?: string;
  /** 内容层外包 KeyboardAvoidingView(含输入框的 sheet 传 true)。 */
  keyboardAvoiding?: boolean;
  /** KeyboardAvoidingView 的 behavior(沿用各页面 nativeShellLayout 的平台推导值)。 */
  keyboardAvoidingBehavior?: 'height' | 'padding' | undefined;
  /** 淡出动画完成、Modal 真正卸载后触发(如需在关闭后再开另一个 Modal)。 */
  onClosed?: () => void;
  children: ReactNode;
}

export function SheetModal({
  visible,
  onRequestClose,
  onBackdropPress,
  backdropTestID,
  keyboardAvoiding = false,
  keyboardAvoidingBehavior,
  onClosed,
  children,
}: SheetModalProps) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const { height: windowHeight } = useWindowDimensions();
  // 背板淡入 + 面板滑入共用一条 progress;关闭淡出/滑出播完后再卸载 Modal。
  const { mounted, progress, onShowStartIn } = useModalFadeLifecycle(visible, {
    inMs: 150,
    outMs: 120,
    onClosed,
  });

  // 快速重开的高度残留窗口:拖拽下拉 dismiss 会让 SheetSurface 内部 heightAnim 停在低位;
  // 若用户在 ~120ms 淡出播完前重新打开,children 一直没卸载,面板会卡在残高。
  // 用 closingRef 标记「淡出播放中」:visible 在该窗口翻回 true 时 bump contentEpoch,
  // 以 epoch 作内容层 key 强制 children 重挂载(重建 heightAnim);淡出播完(mounted 翻 false,
  // children 已自然卸载)则清标记,正常重开不多付一次重挂。
  // useLayoutEffect:bump 必须赶在本次提交上屏前,否则残高面板会先闪一帧(规则 7)。
  const closingRef = useRef(false);
  const [contentEpoch, setContentEpoch] = useState(0);
  useLayoutEffect(() => {
    if (!mounted) {
      closingRef.current = false;
      return;
    }
    if (visible) {
      if (closingRef.current) setContentEpoch((epoch) => epoch + 1);
      closingRef.current = false;
    } else {
      closingRef.current = true;
    }
  }, [visible, mounted]);

  // 滑距取整窗高:从全屏下方滑入,保证任何高度的面板(队列 sheet 可达 ~0.88 屏高)
  // 首帧完全在屏外,不会「顶部凭空出现」;矮面板滑速稍快,但 150ms 内不可辨。
  // progress 是 ref 稳定的 Animated.Value,styles 随主题变——全部 memo,避免会话页
  // 常驻的多个 SheetModal 实例在流式输出每次父 render 时重建原生动画节点(热路径纪律)。
  const translateY = useMemo(
    () => progress.interpolate({ inputRange: [0, 1], outputRange: [windowHeight, 0] }),
    [progress, windowHeight],
  );
  const contentLayerStyle = useMemo(
    () => [styles.contentLayer, { transform: [{ translateY }] }],
    [styles, translateY],
  );
  const backdropStyle = useMemo(
    () => [styles.backdrop, { opacity: progress }],
    [styles, progress],
  );

  // 内容层 box-none:空白区域的点击穿透到下层背板 Pressable,面板本体照常接收触摸。
  const content = (
    <Animated.View key={contentEpoch} pointerEvents="box-none" style={contentLayerStyle}>
      {children}
    </Animated.View>
  );

  return (
    <Modal
      animationType="none"
      onRequestClose={onRequestClose}
      onShow={onShowStartIn}
      presentationStyle="overFullScreen"
      transparent
      visible={mounted}
    >
      <Animated.View style={backdropStyle}>
        <BlurBackdrop />
        <Pressable
          accessibilityLabel={t('shared.closePanel')}
          accessibilityRole="button"
          onPress={onBackdropPress}
          style={styles.backdropPressable}
          testID={backdropTestID}
        />
      </Animated.View>
      {keyboardAvoiding ? (
        <KeyboardAvoidingView
          behavior={keyboardAvoidingBehavior}
          keyboardVerticalOffset={0}
          pointerEvents="box-none"
          style={styles.keyboardLayer}
        >
          {content}
        </KeyboardAvoidingView>
      ) : (
        content
      )}
    </Modal>
  );
}

function makeStyles(colors: ThemeColors) {
  return {
    backdrop: {
      ...StyleSheet.absoluteFill,
    },
    backdropPressable: {
      flex: 1,
    },
    keyboardLayer: {
      flex: 1,
    },
    contentLayer: {
      flex: 1,
      justifyContent: 'flex-end' as const,
    },
  };
}
