/**
 * BlurBackdrop —— 毛玻璃背板(expo-blur BlurView + 半透明叠层)。
 *
 * 双语义(用户定稿 2026-07-21:遮罩双模式恒深):
 *  - scrim 遮罩(不传 overlayColor):modal / sheet 背板遮罩,**LIGHT 模式也恒深**——
 *    BlurView tint 恒 'dark' + 叠层走 colors.overlay 深色遮罩 token。修复 LIGHT 下 scrim 近白
 *    (旧默认沿用 surfaceTranslucentSidebar,light 为近白 rgba(246,246,246,0.90))。
 *  - surface 面板(显式传 overlayColor):sheet 面板 / chrome 玻璃底色,tint 跟随主题
 *    (light='light' / dark='dark'),叠层用调用方传的浅色面板底色——面板表面不被遮罩逻辑染深。
 *
 * 判定依据:overlayColor 是否显式传入。scrim 调用方(SheetModal / SessionActionSheet 背板)
 * 用裸 `<BlurBackdrop />`;面板调用方(SheetSurface / SessionActionSheet 卡片 / 会话顶栏 chrome)
 * 显式传 sheetSurface / sheetActionSurface / chatHeaderSurface。lead 裁决:显式传浅色的调用方
 * 逐个看语义——均为面板/chrome 玻璃,保留主题 tint,不进恒深遮罩口径。
 *
 * 设计:
 *   - BlurView 提供实时模糊(iOS vibrancy / Android 原生 fallback);
 *   - 叠一层半透明底色,即便 Android 模糊弱化也能保证玻璃/遮罩底色;
 *   - pointerEvents="none":触摸穿透到上层 Pressable(背板点按关闭),本组件纯视觉。
 *
 * 范围边界(E4M,lead 裁决):
 *   - 仅用于静态 backdrop(modal scrim / 抽屉背板)与 sheet surface,不用于滚动 sheet surface
 *     (规避 Android 热路径——滚动 sheet 走 SheetSurface 的非滚动叠层);
 *   - session chrome / composer 刻意不走 scrim 语义(顶栏 chrome 走 surface 语义,
 *     守护测试 sessionHeaderDesktopFirst / sessionComposerDesktopFirst 显式禁 BlurView 直用);
 *   - ImageLightbox 保持纯黑背板(媒体查看器惯例),不用本件。
 */
import type { ReactNode } from 'react';
import { BlurView } from 'expo-blur';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '@/theme';

/**
 * Frosting for chrome that floats over scrolling content (session header and
 * composer edge blur, composer activity pills). Pair with a transparent
 * overlay so every floating surface reads as the same glass.
 */
export const FLOATING_CHROME_BLUR_INTENSITY = 55;

export interface BlurBackdropProps {
  /** iOS BlurView intensity(R1 模式1 ≈ 50;模式3 浮层可传更低)。默认 50。 */
  intensity?: number;
  /**
   * 玻璃 / 遮罩上的半透明叠层色。
   *  - 不传 = scrim 遮罩语义:走 colors.overlay(双模式恒深),tint 恒 'dark';
   *  - 传 = surface 面板语义:由调用方给浅色面板底色(如 sheetSurface),tint 跟随主题。
   */
  overlayColor?: string;
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
}

export function BlurBackdrop({ intensity = 50, overlayColor, children, style }: BlurBackdropProps) {
  const { mode, colors } = useTheme();
  // 不传 overlayColor = scrim 遮罩:双模式恒深(tint 恒 'dark' + colors.overlay 深色遮罩 token);
  // 传了 = surface 面板:tint 跟随主题,叠层用调用方底色(面板表面不被遮罩逻辑染深)。
  const isScrim = overlayColor === undefined;
  const tint: 'light' | 'dark' = isScrim ? 'dark' : mode === 'dark' ? 'dark' : 'light';
  const backgroundColor = overlayColor ?? colors.overlay;
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, style]}>
      <BlurView intensity={intensity} tint={tint} style={StyleSheet.absoluteFill} />
      <View style={[StyleSheet.absoluteFill, { backgroundColor }]} />
      {children}
    </View>
  );
}
