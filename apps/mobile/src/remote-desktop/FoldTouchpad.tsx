import { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/AppText';
import { BlurBackdrop } from '@/session/BlurBackdrop';
import { radius, spacing, useTheme } from '@/theme';

/** Relative movement shares the viewer's cursor transform; lower-pane coordinates are never remote coordinates. */
export function FoldTouchpad({ send, enabled }: { send(message: object): void; enabled: boolean }) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const touch = useRef<{ x: number; y: number; distance: number; time: number } | null>(null);
  useEffect(() => () => { touch.current = null; send({ type: 'releaseInput' }); }, [enabled, send]);
  return <View testID="remoteDesktop.foldTouchpad"
    accessibilityLabel={t('remoteDesktop.pointer')}
    accessibilityHint={t('remoteDesktop.pointerHint')}
    accessibilityState={{ disabled: !enabled }}
    onStartShouldSetResponder={() => enabled}
    onResponderGrant={(e) => { touch.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY, distance: 0, time: Date.now() }; }}
    onResponderMove={(e) => {
      const last = touch.current;
      if (!last || !enabled) return;
      const dx = e.nativeEvent.pageX - last.x, dy = e.nativeEvent.pageY - last.y;
      last.x = e.nativeEvent.pageX; last.y = e.nativeEvent.pageY; last.distance += Math.abs(dx) + Math.abs(dy);
      send({ type: 'nativeTouchpad', dx, dy });
    }}
    onResponderRelease={() => {
      const last = touch.current; touch.current = null;
      if (enabled && last && last.distance < 8 && Date.now() - last.time < 400) {
        send({ type: 'nativeTouchpad', tap: true });
      }
    }}
    onResponderTerminate={() => { touch.current = null; send({ type: 'releaseInput' }); }}
    style={[styles.pad, { borderColor: colors.border }]}>
    <BlurBackdrop intensity={60} overlayColor={colors.surfaceTranslucent} />
    <Text style={{ color: colors.textTertiary }}>{t('remoteDesktop.pointer')}</Text>
  </View>;
}
const styles = StyleSheet.create({ pad: { flex: 1, minHeight: 44, margin: spacing.sm,
  overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.container, alignItems: 'center', justifyContent: 'center' } });
