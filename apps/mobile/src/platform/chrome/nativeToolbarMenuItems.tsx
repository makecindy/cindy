import type { ComponentProps, ReactNode } from 'react';
import { Stack } from 'expo-router';
import type { NativePullDownAction } from './NativePullDownMenu';

const filterReminderIcon = require('../../../assets/navigation/filter-reminder.png');

// Return actual toolbar elements: Expo Router inspects their types before rendering.

export function nativeToolbarMenuItems(actions: readonly NativePullDownAction[], onAction: (id: string) => void): ReactNode {
  return actions.map(action => action.subactions?.length ? (
    <Stack.Toolbar.Menu key={action.id} title={action.title} inline={action.displayInline}
      subtitle={action.subtitle}
      icon={action.filterReminder ? filterReminderIcon : action.image as ComponentProps<typeof Stack.Toolbar.Menu>['icon']}
      iconRenderingMode={action.filterReminder ? 'original' : undefined}
      disabled={action.disabled} destructive={action.destructive}>
      {nativeToolbarMenuItems(action.subactions, onAction)}
    </Stack.Toolbar.Menu>
  ) : (
    <Stack.Toolbar.MenuAction key={action.id} disabled={action.disabled}
      destructive={action.destructive} isOn={action.state === 'on'} subtitle={action.subtitle}
      icon={action.filterReminder ? filterReminderIcon : action.image as ComponentProps<typeof Stack.Toolbar.MenuAction>['icon']}
      iconRenderingMode={action.filterReminder ? 'original' : undefined}
      unstable_keepPresented={action.keepPresented} onPress={() => onAction(action.id)}>
      {action.title}
    </Stack.Toolbar.MenuAction>
  ));
}
