import { useMemo, useState } from 'react';
import { Host, ListItem } from '@expo/ui';
import { Button, Circle, HStack, List, Section, SwipeActions, Text } from '@expo/ui/swift-ui';
import {
  disabled,
  font,
  foregroundStyle,
  frame,
  labelStyle,
  listRowBackground,
  listStyle,
  refreshable,
  scrollContentBackground,
  tint,
} from '@expo/ui/swift-ui/modifiers';
import { useTranslation } from 'react-i18next';
import { Monitor } from 'lucide-react-native';
import {
  buildDeviceManagementSections,
  DEVICE_MANAGEMENT_OFFLINE_PREVIEW_COUNT,
  deviceManagementStatusText,
  visibleOfflineDeviceRows,
} from '@/session/deviceManagementSections';
import { useTheme } from '@/theme';
import { iconSize, iconStroke, spacing } from '@/theme/tokens';
import type { DeviceManagementListProps } from './DeviceManagementList.types';

/**
 * 设备管理列表(iOS):系统分组列表(insetGrouped),与设置页同样的分组卡片观感。
 * 在线 / 可控的设备在前;离线设备单独成组,默认只露出最近在线的几台。
 * 右滑重命名、左滑删除;下拉刷新走系统 refreshable。
 */
export function DeviceManagementList({
  rows,
  busy,
  onOpen,
  onRename,
  onDelete,
  onRefresh,
}: DeviceManagementListProps) {
  const { mode, colors } = useTheme();
  const { t } = useTranslation();
  const [offlineExpanded, setOfflineExpanded] = useState(false);
  const sections = useMemo(() => buildDeviceManagementSections(rows), [rows]);
  const offlineRows = visibleOfflineDeviceRows(sections.offline, offlineExpanded);
  const renderRow = (row: DeviceManagementListProps['rows'][number]) => {
    const { device } = row;
    return (
      <SwipeActions key={device.deviceId} modifiers={[listRowBackground(colors.surfaceElevated)]}>
        <ListItem
          onPress={() => onOpen(device)}
          leading={
            <Monitor
              size={iconSize.md}
              strokeWidth={iconStroke.regular}
              color={colors.textSecondary}
            />
          }
          supportingText={
            <HStack spacing={spacing.xs} alignment="center">
              {/* 状态点:可控用品牌 teal,其余(离线 / 未开远控 / 已撤销)用 borderStrong(次要图标点)。 */}
              <Circle
                modifiers={[
                  frame({ width: 6, height: 6 }),
                  foregroundStyle(row.canOpen ? colors.statusReady : colors.borderStrong),
                ]}
              />
              <Text
                modifiers={[
                  font({ textStyle: 'caption' }),
                  foregroundStyle({
                    type: 'hierarchical',
                    style: 'secondary',
                  }),
                ]}
              >
                {deviceManagementStatusText(row)}
              </Text>
            </HStack>
          }
          testID={`deviceManagement.open.${device.deviceId}`}
        >
          <Text
            modifiers={[
              font({ textStyle: 'body', weight: 'medium' }),
              foregroundStyle({ type: 'hierarchical', style: 'primary' }),
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
    );
  };
  return (
    <Host
      style={{ flex: 1, backgroundColor: colors.surface }}
      colorScheme={mode}
    >
      <List
        modifiers={[listStyle('insetGrouped'), scrollContentBackground('hidden'), refreshable(onRefresh)]}
        testID="deviceManagement.list"
      >
        {sections.online.length > 0 ? (
          <Section title={t('devices.management.availableSection')}>
            {sections.online.map(renderRow)}
          </Section>
        ) : null}
        {sections.offline.length > 0 ? (
          <Section title={t('devices.management.offlineSection')}>
            {offlineRows.map(renderRow)}
            {sections.offline.length > DEVICE_MANAGEMENT_OFFLINE_PREVIEW_COUNT ? (
              <Button
                label={offlineExpanded
                  ? t('devices.management.showFewerOffline')
                  : t('devices.management.showAllOffline', { count: sections.offline.length })}
                onPress={() => setOfflineExpanded((value) => !value)}
                modifiers={[tint(colors.textPrimary), listRowBackground(colors.surfaceElevated)]}
                testID="deviceManagement.toggleOffline"
              />
            ) : null}
          </Section>
        ) : null}
      </List>
    </Host>
  );
}
