import { useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { useAdaptiveWindow } from '@/platform/AdaptiveWindowContext';
import { SessionHeaderNativeBlur } from '@/session/SessionHeaderNativeControls';
import { useOptionalHeaderHeight } from '@/session/useOptionalHeaderHeight';
import { homeModeIndex, useHomeModeSlide } from './HomeModeTransition';
import type { HomeMode } from './homeViewPreferenceStore';

/** Keep visited panes alive: search, expansion and scroll belong to each tab. */
export function HomeModePanes({ mode, tasks, teammates }: { mode: HomeMode; tasks: ReactNode; teammates: ReactNode }) {
  const progress = useHomeModeSlide();
  // Same distance as the wide resident list, so both layers stay adjacent mid-slide.
  const { width } = useAdaptiveWindow();
  const headerHeight = useOptionalHeaderHeight();
  const [visited, setVisited] = useState({ tasks: true, teammates: mode === 'teammates' });
  if (!visited[mode]) setVisited({ ...visited, [mode]: true });
  return <View style={styles.viewport}>
    {(['tasks', 'teammates'] as const).map(pane => visited[pane] || mode === pane ?
      <HomePane key={pane} pane={pane} active={mode === pane} width={width} progress={progress}>
        {pane === 'tasks' ? tasks : teammates}
      </HomePane> : null)}
    {/* The native bar does not slide, so neither does its blur. */}
    <SessionHeaderNativeBlur height={headerHeight} />
  </View>;
}

function HomePane({ pane, active, width, progress, children }: {
  pane: HomeMode; active: boolean; width: number; progress: SharedValue<number>; children: ReactNode;
}) {
  const index = homeModeIndex(pane);
  const slide = useAnimatedStyle(() => ({ transform: [{ translateX: (index - progress.value) * width }] }));
  return <Animated.View testID={'home.pane.' + pane} style={[StyleSheet.absoluteFill, slide]}
    pointerEvents={active ? 'auto' : 'none'} accessibilityElementsHidden={!active}
    importantForAccessibility={active ? 'auto' : 'no-hide-descendants'}>
    {children}
  </Animated.View>;
}

const styles = StyleSheet.create({
  viewport: { flex: 1, overflow: 'hidden' },
});
