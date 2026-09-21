import { Stack } from 'expo-router';
import { Platform } from 'react-native';
import { useAdaptiveWindow } from '../AdaptiveWindowContext';
import { useTheme } from '@/theme';

export function useSystemNavigationBack() {
  const window = useAdaptiveWindow();
  return Platform.OS === 'ios' && window.barEdge !== 'none';
}

/** Keep real toolbar items: Toolbar.View custom content loses Duo's vertical
 * adaptation and returns to the horizontal header, overlapping the sidebar. */
export function SystemNavigationBack({ onPress, label, disabled = false, close = false, available = true, newTask }: {
  newTask?: { onPress(): void; label: string };
  onPress(): void; label: string; disabled?: boolean; close?: boolean; available?: boolean;
}) {
  const enabled = useSystemNavigationBack();
  const { colors } = useTheme();
  return <>
    <Stack.Screen options={{ headerShown: enabled && available, headerTransparent: true,
      headerShadowVisible: false, headerBackVisible: false, headerTitle: '',
      headerTintColor: colors.textPrimary }} />
    {enabled && available ? <Stack.Toolbar placement="left">
      <Stack.Toolbar.Button icon={close ? 'xmark' : 'chevron.backward'}
        accessibilityLabel={label} disabled={disabled} onPress={onPress} />
    </Stack.Toolbar> : null}
    {enabled && available && newTask ? <Stack.Toolbar placement="right">
      <Stack.Toolbar.Button icon="square.and.pencil" accessibilityLabel={newTask.label} onPress={newTask.onPress} />
    </Stack.Toolbar> : null}
  </>;
}
