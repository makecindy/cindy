/**
 * 主题 barrel —— 组件统一从 `@/theme` 取 token 与主题 hook。
 * (node 单测如需校验纯数据,直接 import `@/theme/tokens`,避免经此 barrel 拉入 react-native。)
 */
export {
  darkColors,
  fontWeight,
  iconSize,
  iconStroke,
  lightColors,
  lineHeight,
  motionDuration,
  motionEasing,
  palettes,
  radius,
  spacing,
  textStyles,
  typeScale,
  type ThemeColors,
  type ThemeMode,
} from './tokens';
export { monoFont } from './monoFont';
export { ThemeOverrideProvider, ThemeProvider, useTheme, useThemedStyles } from './ThemeProvider';
