import { Host, Slider } from '@expo/ui/jetpack-compose';
import { fillMaxWidth, semantics, testID } from '@expo/ui/jetpack-compose/modifiers';
import { useRef } from 'react';
import { useTheme } from '@/theme';
import type { AudioPlayerScrubberProps } from './AudioPlayerScrubber';

export function AudioPlayerScrubber({ enabled, time, duration, label, valueText, onPreview, onSeek }: AudioPlayerScrubberProps) {
  const { mode, colors } = useTheme();
  const pending = useRef<number | null>(null);
  return (
    <Host colorScheme={mode} style={{ height: 48 }}>
      <Slider min={0} max={duration > 0 ? duration : 1} value={time} enabled={enabled}
        colors={{ activeTrackColor: colors.cta, thumbColor: colors.cta, inactiveTrackColor: colors.borderStrong }}
        modifiers={[fillMaxWidth(), semantics({ contentDescription: `${label}, ${valueText}` }), testID('message.audioProgress.native')]}
        onValueChange={(target) => {
          if (!enabled) return;
          pending.current = target;
          onPreview(target);
        }}
        onValueChangeFinished={() => {
          if (enabled && pending.current !== null) onSeek(pending.current);
          pending.current = null;
          onPreview(null);
        }} />
    </Host>
  );
}
