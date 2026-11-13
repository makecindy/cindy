import { Stack } from 'expo-router';
import { useMemo } from 'react';
import { Platform } from 'react-native';
import { useAdaptiveWindow } from '../AdaptiveWindowContext';
import { useTheme } from '@/theme';
import { useNavigationCallback } from './useNavigationCallback';

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
  const pressBack = useNavigationCallback(onPress);
  const pressNewTask = useNavigationCallback(newTask?.onPress);
  const newTaskLabel = newTask?.label;
  // expo-router applies screen options in a layout effect. Keep this object
  // stable across unrelated store updates, otherwise setOptions can feed a
  // rerender back into this route indefinitely.
  const screenOptions = useMemo(() => ({
    headerShown: enabled && available,
    headerTransparent: true,
    headerShadowVisible: false,
    headerBackVisible: false,
    headerTitle: '',
    headerTintColor: colors.textPrimary,
  }), [available, colors.textPrimary, enabled]);
  // Toolbar children also participate in the composition registry's layout
  // effect. Memoizing only Stack.Screen options leaves that feedback loop open.
  const backButton = useMemo(() => <Stack.Toolbar.Button icon={close ? 'xmark' : 'chevron.backward'}
    accessibilityLabel={label} disabled={disabled} onPress={pressBack} />,
  [close, label, disabled, pressBack]);
  const newTaskButton = useMemo(() => <Stack.Toolbar.Button icon="square.and.pencil"
    accessibilityLabel={newTaskLabel} onPress={pressNewTask} />, [newTaskLabel, pressNewTask]);
  return <>
    <Stack.Screen options={screenOptions} />
    {enabled && available ? <Stack.Toolbar placement="left">{backButton}</Stack.Toolbar> : null}
    {enabled && available && newTask ? <Stack.Toolbar placement="right">{newTaskButton}</Stack.Toolbar> : null}
  </>;
}
