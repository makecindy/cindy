import type { ReactNode } from 'react';
import { Platform, ScrollView, View } from 'react-native';
import { useAdaptiveWindow } from './AdaptiveWindowContext';
import { modalLayout } from './modalLayout';
import { useMobileKeyboardState } from '@/session/useMobileKeyboardState';
import { spacing } from '@/theme';

/** The modal backdrop stays full-screen; form controls fit one usable, scrollable region. */
export function ModalContentArea({ children }: { children: ReactNode }) {
  const geometry = useAdaptiveWindow();
  const keyboard = useMobileKeyboardState();
  const { region: area } = modalLayout(geometry, Platform.OS === 'android' ? 0 : keyboard.height);
  return <View pointerEvents="box-none" style={{ position: 'absolute', left: area.x, top: area.y,
    width: area.width, height: area.height }}>
    <ScrollView keyboardShouldPersistTaps="handled" style={{ flex: 1 }}
      contentContainerStyle={{ flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg }}>
      {children}
    </ScrollView>
  </View>;
}
