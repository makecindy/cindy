import { Host, ListItem } from '@expo/ui';
import { Button, List, SwipeActions, Text } from '@expo/ui/swift-ui';
import {
  disabled,
  font,
  foregroundStyle,
  labelStyle,
  listRowBackground,
  listStyle,
  scrollContentBackground,
  tint,
} from '@expo/ui/swift-ui/modifiers';
import { useTranslation } from 'react-i18next';
import { Monitor } from 'lucide-react-native';
import { useTheme } from '@/theme';
import { iconSize, iconStroke } from '@/theme/tokens';
import type { DeviceManagementListProps } from './DeviceManagementList.types';

export function DeviceManagementList({
  rows,
  busy,
  onOpen,
  onRename,
  onDelete,
}: DeviceManagementListProps) {
  const { mode, colors } = useTheme();
  const { t } = useTranslation();
  return (
    <Host
      style={{ flex: 1, backgroundColor: colors.surface }}
      colorScheme={mode}
    >
      <List
        modifiers={[listStyle('plain'), scrollContentBackground('hidden')]}
        testID="deviceManagement.list"
      >
        {rows.map(({ device, statusLabel, statusDetail }) => (
          <SwipeActions
            key={device.deviceId}
            modifiers={[listRowBackground(colors.surface)]}
          >
            <ListItem
              onPress={() => onOpen(device)}
              leading={
                <Monitor
                  size={iconSize.md}
                  strokeWidth={iconStroke.regular}
                  color={
                    device.online ? colors.statusReady : colors.textSecondary
                  }
                />
              }
              supportingText={
                <Text
                  modifiers={[
                    font({ textStyle: 'caption' }),
                    foregroundStyle({
                      type: 'hierarchical',
                      style: 'secondary',
                    }),
                  ]}
                >
                  {device.online
                    ? statusLabel
                    : `${statusLabel} · ${statusDetail}`}
                </Text>
              }
              testID={`deviceManagement.open.${device.deviceId}`}
            >
              <Text
                modifiers={[
                  font({
                    textStyle: 'body',
                    weight: device.online ? 'medium' : 'regular',
                  }),
                  foregroundStyle({
                    type: 'hierarchical',
                    style: device.online ? 'primary' : 'secondary',
                  }),
                ]}
              >
                {device.name}
              </Text>
            </ListItem>
            <SwipeActions.Actions edge="leading" allowsFullSwipe={false}>
              <Button
                label={t('devices.list.menu.renameDevice')}
                systemImage="pencil"
                onPress={() => onRename(device)}
                modifiers={[disabled(busy), labelStyle('iconOnly')]}
                testID={`deviceManagement.rename.${device.deviceId}`}
              />
            </SwipeActions.Actions>
            <SwipeActions.Actions edge="trailing" allowsFullSwipe={false}>
              <Button
                label={t('devices.common.delete')}
                systemImage="trash"
                onPress={() => onDelete(device)}
                modifiers={[
                  disabled(busy),
                  tint(colors.destructive),
                  labelStyle('iconOnly'),
                ]}
                testID={`deviceManagement.delete.${device.deviceId}`}
              />
            </SwipeActions.Actions>
          </SwipeActions>
        ))}
      </List>
    </Host>
  );
}
