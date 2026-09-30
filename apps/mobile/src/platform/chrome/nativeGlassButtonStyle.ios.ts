import {
  background, buttonBorderShape, buttonStyle, contentShape, controlSize,
  foregroundStyle, font, frame, glassEffect, shapes,
} from '@expo/ui/swift-ui/modifiers';
import { useLiquidGlassAvailable } from '@/session/useLiquidGlassAvailable';
import { iconSize, navigationChrome, useTheme } from '@/theme';

/** Shared native styling only. SwiftUI Button owns activation and feedback. */
export function useNativeGlassButtonStyle({
  shape = 'capsule', prominent = false, clear = false, size = navigationChrome.target, dimensions,
}: { shape?: 'circle' | 'capsule'; prominent?: boolean; clear?: boolean; size?: number;
  dimensions?: { width?: number; height: number } } = {}) {
  const glass = useLiquidGlassAvailable();
  const { colors, mode } = useTheme();
  if (shape === 'circle' || dimensions) {
    const palette = navigationChrome.clear[mode];
    const outline = shape === 'circle' ? shapes.circle() : shapes.capsule();
    // Explicit glass after the frame respects chrome and floating-action sizes. Adding
    // the system's large button padding here enlarges the visible circle.
    return [
      buttonStyle('borderless'),
      font({ size: iconSize.action }),
      frame(dimensions ? { ...dimensions, ...(dimensions.width == null ? { maxWidth: Infinity } : {}) } : { width: size, height: size }),
      contentShape(outline),
      ...(glass ? [glassEffect({ glass: { variant: clear ? 'clear' : 'regular', interactive: true, ...(prominent ? { tint: colors.cta } : {}) }, shape })]
        : [background(prominent ? colors.cta : colors.surfaceElevated, outline)]),
      ...(clear && glass ? [foregroundStyle(palette.foreground), background(palette.scrim, outline)] : []),
    ];
  }
  return [
    buttonStyle(glass ? (prominent ? 'glassProminent' : 'glass') : (prominent ? 'borderedProminent' : 'bordered')),
    buttonBorderShape(shape),
    controlSize('regular'),
    frame({ minHeight: navigationChrome.target }),
  ];
}

/** A toolbar shares one material; its children remain native borderless Buttons. */
export function useNativeGlassGroupStyle(variant: 'regular' | 'clear' = 'regular') {
  const glass = useLiquidGlassAvailable();
  const { colors, mode } = useTheme();
  return glass
    ? [glassEffect({ glass: { variant }, shape: 'capsule' }),
       ...(variant === 'clear' ? [background(navigationChrome.clear[mode].scrim, shapes.capsule())] : [])]
    : [background(colors.surfaceElevated, shapes.capsule())];
}
