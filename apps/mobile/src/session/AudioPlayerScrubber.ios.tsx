import { Host, Slider } from '@expo/ui/swift-ui';
import { accessibilityLabel, accessibilityValue, disabled, frame, tint } from '@expo/ui/swift-ui/modifiers';
import { useRef } from 'react';
import { useScreenReaderEnabled } from '@/hooks/useScreenReaderEnabled';
import { useTheme } from '@/theme';
import type { AudioPlayerScrubberProps } from './AudioPlayerScrubber';

export function AudioPlayerScrubber({ enabled, time, duration, label, valueText, onPreview, onSeek }: AudioPlayerScrubberProps) {
  const { mode, colors } = useTheme();
  const screenReader = useScreenReaderEnabled();
  const editing = useRef(false);
  const pending = useRef<number | null>(null);
  return (
    <Host colorScheme={mode} ignoreSafeArea="all" style={{ height: 44 }}>
      <Slider min={0} max={duration > 0 ? duration : 1} value={time} testID="message.audioProgress.native"
        modifiers={[frame({ minHeight: 44 }), tint(colors.cta), disabled(!enabled), accessibilityLabel(label), accessibilityValue(valueText)]}
        onEditingChanged={(active) => {
          editing.current = active;
          if (active) {
            pending.current = null;
            if (enabled) onPreview(time);
          } else {
            if (enabled && pending.current !== null) onSeek(pending.current);
            pending.current = null;
            onPreview(null);
          }
        }}
        onValueChange={(target) => {
          if (!enabled) return;
          if (editing.current) {
            pending.current = target;
            onPreview(target);
          } else if (screenReader && Math.abs(target - time) > 0.01) {
            // VoiceOver adjusts the slider without a touch editing session.
            onSeek(target);
          }
        }} />
    </Host>
  );
}
