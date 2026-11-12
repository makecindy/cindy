import {
  KeyboardAvoidingView,
  Platform,
  View,
  type KeyboardAvoidingViewProps,
} from 'react-native';
import type { MobileKeyboardState } from '@/session/useMobileKeyboardState';

interface ComposerKeyboardAvoidingViewProps extends KeyboardAvoidingViewProps {
  keyboard: MobileKeyboardState;
  /** 全屏页面外层 SafeAreaView 已经扣除的底部高度，避免新建页重复上抬。 */
  bottomInset?: number;
}

/**
 * 任务 / 新建页都是无系统 header 的全屏布局。iOS 使用同一键盘状态控制底部
 * 留白，让输入卡片尺寸与消息视口同批更新；Android 继续由 KAV 处理缩窗。
 */
export function ComposerKeyboardAvoidingView({
  keyboard,
  bottomInset = 0,
  behavior,
  keyboardVerticalOffset = 0,
  enabled = true,
  contentContainerStyle,
  style,
  ...props
}: ComposerKeyboardAvoidingViewProps) {
  if (Platform.OS === 'ios') {
    const paddingBottom =
      enabled && keyboard.visible
        ? Math.max(0, keyboard.height - bottomInset + keyboardVerticalOffset)
        : 0;
    return <View {...props} style={[style, { paddingBottom }]} />;
  }
  return (
    <KeyboardAvoidingView
      {...props}
      behavior={behavior}
      contentContainerStyle={contentContainerStyle}
      enabled={enabled}
      keyboardVerticalOffset={keyboardVerticalOffset}
      style={style}
    />
  );
}
