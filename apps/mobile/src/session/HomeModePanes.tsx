import { useState, type ReactNode } from 'react';
import { View } from 'react-native';
import type { HomeMode } from './homeViewPreferenceStore';

/** Keep visited panes alive: local searches, expansion and list positions belong to each mode. */
export function HomeModePanes({ mode, tasks, teammates }: { mode: HomeMode; tasks: ReactNode; teammates: ReactNode }) {
  const [visited, setVisited] = useState({ tasks: mode === 'tasks', teammates: mode === 'teammates' });
  if (!visited[mode]) setVisited({ ...visited, [mode]: true });
  return <View style={{ flex: 1 }}>
    {(['tasks', 'teammates'] as const).map(pane => visited[pane] || mode === pane ?
      <View key={pane} testID={`home.pane.${pane}`} style={{ flex: 1, display: mode === pane ? 'flex' : 'none' }}
        pointerEvents={mode === pane ? 'auto' : 'none'} accessibilityElementsHidden={mode !== pane}
        importantForAccessibility={mode === pane ? 'auto' : 'no-hide-descendants'}>
        {pane === 'tasks' ? tasks : teammates}
      </View> : null)}
  </View>;
}
