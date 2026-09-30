import { useCallback, useMemo, useRef, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Monitor, Pencil, Trash2 } from 'lucide-react-native';
import { Text } from '@/components/AppText';
import { StatusDot } from '@/components/MobilePrimitives';
import { mobileInteractionStyles } from '@/components/mobileInteractionStyles';
import {
  ClassicSwipeable,
  type ClassicSwipeableMethods,
} from '@/platform/gestureHandler';
import {
  buildDeviceManagementSections,
  DEVICE_MANAGEMENT_OFFLINE_PREVIEW_COUNT,
  deviceManagementStatusText,
  visibleOfflineDeviceRows,
} from '@/session/deviceManagementSections';
import { SettingsGroup, useSettingsRowStyles } from '@/session/SettingsGroupRows';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, iconSize, iconStroke, lineHeight, spacing, typeScale } from '@/theme/tokens';
import type { DeviceManagementListProps } from './DeviceManagementList.types';

/**
 * 设备管理列表(Android / 非 iOS):与设置页同一套分组卡片。
 * 在线 / 可控的设备在前;离线设备单独成组,默认只露出最近在线的几台。
 * 右滑重命名、左滑删除;下拉刷新。
 */
export function DeviceManagementList(props: DeviceManagementListProps) {
  const openRow = useRef<ClassicSwipeableMethods | null>(null);
  const { t } = useTranslation();
  const { colors } = useTheme();
  const rowStyles = useSettingsRowStyles();
  const styles = useThemedStyles(makeStyles);
  const [offlineExpanded, setOfflineExpanded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const sections = useMemo(() => buildDeviceManagementSections(props.rows), [props.rows]);
  const offlineRows = visibleOfflineDeviceRows(sections.offline, offlineExpanded);
  const { onRefresh } = props;
  const refresh = useCallback(() => {
    setRefreshing(true);
    void onRefresh().finally(() => setRefreshing(false));
  }, [onRefresh]);
  const onWillOpen = (ref: ClassicSwipeableMethods | null) => {
    if (openRow.current !== ref) openRow.current?.close();
    openRow.current = ref;
  };
  const renderRow = (row: DeviceManagementListProps['rows'][number]) => (
    <DeviceRow key={row.device.deviceId} {...props} row={row} onWillOpen={onWillOpen} />
  );
  return (
    <ScrollView
      contentContainerStyle={styles.content}
      onScrollBeginDrag={() => openRow.current?.close()}
      refreshControl={(
        <RefreshControl
          colors={[colors.textSecondary]}
          onRefresh={refresh}
          progressBackgroundColor={colors.surfaceElevated}
          refreshing={refreshing}
          tintColor={colors.textSecondary}
        />
      )}
      style={styles.scroll}
      testID="deviceManagement.list"
    >
      {sections.online.length > 0 ? (
        <SettingsGroup title={t('devices.management.availableSection')}>
          {sections.online.map(renderRow)}
        </SettingsGroup>
      ) : null}
      {sections.offline.length > 0 ? (
        <SettingsGroup title={t('devices.management.offlineSection')}>
          {offlineRows.map(renderRow)}
          {sections.offline.length > DEVICE_MANAGEMENT_OFFLINE_PREVIEW_COUNT ? (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: offlineExpanded }}
              key="toggle-offline"
              onPress={() => setOfflineExpanded((value) => !value)}
              style={({ pressed }) => [rowStyles.row, pressed && rowStyles.pressed]}
              testID="deviceManagement.toggleOffline"
            >
              <Text style={styles.toggleLabel}>
                {offlineExpanded
                  ? t('devices.management.showFewerOffline')
                  : t('devices.management.showAllOffline', { count: sections.offline.length })}
              </Text>
            </Pressable>
          ) : null}
        </SettingsGroup>
      ) : null}
    </ScrollView>
  );
}

function DeviceRow({
  row,
  busy,
  onOpen,
  onRename,
  onDelete,
  onWillOpen,
}: DeviceManagementListProps & {
  row: DeviceManagementListProps['rows'][number];
  onWillOpen(ref: ClassicSwipeableMethods | null): void;
}) {
  const ref = useRef<ClassicSwipeableMethods | null>(null);
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  // 与 iOS 滑动操作一致:只放图标(重命名=铅笔、删除=红色垃圾桶),文字留给读屏。
  const action = (remove: boolean) => {
    const Icon = remove ? Trash2 : Pencil;
    return (
      <Pressable
        accessibilityLabel={t(remove ? 'devices.common.delete' : 'devices.list.menu.renameDevice')}
        accessibilityRole="button"
        accessibilityState={{ disabled: busy }}
        disabled={busy}
        onPress={() => {
          ref.current?.close();
          (remove ? onDelete : onRename)(row.device);
        }}
        style={({ pressed }) => [
          styles.action,
          pressed && mobileInteractionStyles.pressed,
          busy && styles.actionDisabled,
        ]}
        testID={`deviceManagement.${remove ? 'delete' : 'rename'}.${row.device.deviceId}`}
      >
        <Icon
          color={remove ? colors.destructive : colors.textPrimary}
          size={iconSize.xl}
          strokeWidth={iconStroke.regular}
        />
      </Pressable>
    );
  };
  return (
    <ClassicSwipeable
      ref={ref}
      renderLeftActions={() => action(false)}
      renderRightActions={() => action(true)}
      overshootLeft={false}
      overshootRight={false}
      onSwipeableWillOpen={() => onWillOpen(ref.current)}
    >
      <Pressable
        accessibilityLabel={t('devices.management.openDevice', { name: row.device.name })}
        accessibilityRole="button"
        onPress={() => onOpen(row.device)}
        testID={`deviceManagement.open.${row.device.deviceId}`}
        style={({ pressed }) => [styles.row, pressed && mobileInteractionStyles.pressed]}
      >
        <Monitor
          size={iconSize.md}
          strokeWidth={iconStroke.regular}
          color={colors.textSecondary}
        />
        <View style={styles.labels}>
          <Text numberOfLines={1} style={styles.name}>{row.device.name}</Text>
          <View style={styles.status}>
            {/* 状态点:可控用品牌 teal,其余(离线 / 未开远控 / 已撤销)用 muted(borderStrong)。 */}
            <StatusDot tone={row.canOpen ? 'ready' : 'muted'} />
            <Text numberOfLines={1} style={styles.statusText}>
              {deviceManagementStatusText(row)}
            </Text>
          </View>
        </View>
      </Pressable>
    </ClassicSwipeable>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  scroll: { flex: 1 },
  content: { gap: spacing.xl, paddingBottom: spacing.xxl, paddingHorizontal: spacing.lg, paddingTop: spacing.lg },
  row: {
    alignItems: 'center',
    backgroundColor: colors.surfaceElevated,
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: 60,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  labels: { flex: 1, gap: spacing.xs, minWidth: 0 },
  name: { color: colors.textPrimary, fontSize: typeScale.body, fontWeight: fontWeight.medium, lineHeight: lineHeight.body },
  status: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  statusText: { color: colors.textTertiary, flexShrink: 1, fontSize: typeScale.caption, fontWeight: fontWeight.regular, lineHeight: lineHeight.caption },
  toggleLabel: { color: colors.textPrimary, fontSize: typeScale.body, fontWeight: fontWeight.medium, lineHeight: lineHeight.body },
  action: {
    alignItems: 'center',
    backgroundColor: colors.surfaceChip,
    justifyContent: 'center',
    minHeight: 44,
    minWidth: 72,
    padding: spacing.lg,
  },
  actionDisabled: { opacity: 0.45 },
});
