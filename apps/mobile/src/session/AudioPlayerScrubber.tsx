import { useState } from 'react';
import { StyleSheet, View, type GestureResponderEvent } from 'react-native';
import { radius, useThemedStyles, type ThemeColors } from '@/theme';

export type AudioPlayerScrubberProps = {
  enabled: boolean;
  time: number;
  duration: number;
  label: string;
  valueText: string;
  onPreview(time: number | null): void;
  onSeek(time: number): void;
};

const THUMB_SIZE = 12;

export function AudioPlayerScrubber({ enabled, time, duration, label, valueText, onPreview, onSeek }: AudioPlayerScrubberProps) {
  const styles = useThemedStyles(makeStyles);
  const [width, setWidth] = useState(0);
  const length = Math.max(0, width - THUMB_SIZE);
  const position = duration > 0 ? (time / duration) * length : 0;
  const clampTime = (value: number) => Math.max(0, Math.min(value, duration));
  const timeAtTouch = ({ nativeEvent }: GestureResponderEvent) =>
    clampTime(((nativeEvent.locationX - THUMB_SIZE / 2) / length) * duration);
  return (
    <View
      accessible={enabled}
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ text: valueText }}
      accessibilityActions={enabled ? [{ name: 'increment' }, { name: 'decrement' }] : undefined}
      onAccessibilityAction={({ nativeEvent: { actionName } }) => {
        if (!enabled || (actionName !== 'increment' && actionName !== 'decrement')) return;
        const step = Math.min(10, duration / 10);
        onSeek(clampTime(time + (actionName === 'increment' ? step : -step)));
      }}
      onLayout={({ nativeEvent }) => setWidth(nativeEvent.layout.width)}
      onStartShouldSetResponder={() => enabled && length > 0}
      onResponderTerminationRequest={() => false}
      onResponderGrant={(event) => onPreview(timeAtTouch(event))}
      onResponderMove={(event) => onPreview(timeAtTouch(event))}
      onResponderRelease={(event) => {
        onPreview(null);
        if (enabled && length > 0) onSeek(timeAtTouch(event));
      }}
      onResponderTerminate={() => onPreview(null)}
      style={styles.track}
      testID="message.audioProgress"
    >
      <View pointerEvents="none" style={styles.rail}>
        <View style={[styles.fill, { width: position }]} />
      </View>
      {enabled && length > 0 ? <View pointerEvents="none" style={[styles.thumb, { left: position }]} /> : null}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  track: { height: 44, justifyContent: 'center' },
  rail: { marginHorizontal: THUMB_SIZE / 2, height: 3, borderRadius: radius.pill, backgroundColor: colors.borderStrong },
  fill: { height: '100%', borderRadius: radius.pill, backgroundColor: colors.textPrimary },
  thumb: { position: 'absolute', width: THUMB_SIZE, height: THUMB_SIZE, borderRadius: radius.pill, backgroundColor: colors.textPrimary },
});
