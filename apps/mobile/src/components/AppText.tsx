import { Text as RNText, TextInput as RNTextInput } from 'react-native';
import type { TextInputProps, TextProps } from 'react-native';
import type { Ref } from 'react';
import { useTheme } from '@/theme/ThemeProvider';

/**
 * 全局字体缩放限幅包装 —— 应用内所有 `Text` / `TextInput` 的唯一来源。
 *
 * 背景:RN 默认跟随系统字体缩放(iOS Dynamic Type / Android 字体大小)且不设上限,
 * 而应用布局里大量固定高度容器 + token 化行高,超大系统字号会把布局撑爆。
 * React 19 起函数组件的 `defaultProps` 被忽略,`Text.defaultProps` 全局兜底已失效,
 * 因此用包装组件统一注入 `maxFontSizeMultiplier`:尊重系统缩放,但封顶 1.2 倍。
 *
 * 规则:业务代码一律从本模块 import { Text, TextInput },不许直接从 react-native 引
 * (typographyTokenDiscipline 守护测试拦截);个别场景需要更严限幅时显式覆写该 prop。
 */
export const MAX_FONT_SIZE_MULTIPLIER = 1.2;

export function Text({ ref, ...props }: TextProps & { ref?: Ref<RNText> }) {
  return <RNText ref={ref} maxFontSizeMultiplier={MAX_FONT_SIZE_MULTIPLIER} {...props} />;
}

/** ref 直接透传给原生 TextInput(React 19 ref-as-prop),`focus()` 等命令式调用不受影响。 */
export function TextInput({ ref, ...props }: TextInputProps & { ref?: Ref<RNTextInput> }) {
  const { colors } = useTheme();
  return (
    <RNTextInput
      ref={ref}
      cursorColor={colors.inputCaret}
      maxFontSizeMultiplier={MAX_FONT_SIZE_MULTIPLIER}
      selectionColor={colors.inputCaret}
      {...props}
    />
  );
}
