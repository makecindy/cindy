import { useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Monitor, Pencil, Trash2 } from 'lucide-react-native';
import { Text } from '@/components/AppText';
import { mobileInteractionStyles } from '@/components/mobileInteractionStyles';
import {
  ClassicSwipeable,
  type ClassicSwipeableMethods,
} from '@/platform/gestureHandler';
import { useTheme } from '@/theme';
import { fontWeight, iconSize, iconStroke, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';
import type { DeviceManagementListProps } from './DeviceManagementList.types';

export function DeviceManagementList(props: DeviceManagementListProps) {
  const openRow = useRef<ClassicSwipeableMethods | null>(null);
  return (
    <ScrollView onScrollBeginDrag={() => openRow.current?.close()}>
      {props.rows.map((row) => (
        <DeviceRow
          key={row.device.deviceId}
          {...props}
          row={row}
          onWillOpen={(ref) => {
            if (openRow.current !== ref) openRow.current?.close();
            openRow.current = ref;
          }}
        />
      ))}
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
          { backgroundColor: colors.surfaceElevated },
          pressed && styles.pressed,
          busy && styles.disabled,
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
        accessibilityRole="button"
        onPress={() => onOpen(row.device)}
        testID={`deviceManagement.open.${row.device.deviceId}`}
        style={[
          styles.row,
          { backgroundColor: colors.surface, borderBottomColor: colors.border },
        ]}
      >
        <Monitor
          size={iconSize.md}
          strokeWidth={iconStroke.regular}
          color={colors.textSecondary}
        />
        <View style={styles.labels}>
          <Text
            style={{
              // 离线用二级字色,与 iOS 列表的 secondary 层级一致。
              color: row.device.online
                ? colors.textPrimary
                : colors.textSecondary,
              fontSize: typeScale.body,
              lineHeight: lineHeight.body,
              fontWeight: row.device.online
                ? fontWeight.medium
                : fontWeight.regular,
            }}
          >
            {row.device.name}
          </Text>
          <View style={styles.status}>
            <View
              style={[
                styles.statusDot,
                { backgroundColor: row.device.online ? colors.statusReady : colors.textTertiary },
              ]}
            />
            <Text
              style={{ color: colors.textSecondary, flexShrink: 1, fontSize: typeScale.caption, lineHeight: lineHeight.caption }}
            >
              {deviceManagementStatusLine(row)}
            </Text>
          </View>
        </View>
      </Pressable>
    </ClassicSwipeable>
  );
}
/** 与 iOS 一致:在线只写「在线」,离线写「状态 · 详情」。 */
function deviceManagementStatusLine(
  row: Pick<DeviceManagementListProps['rows'][number], 'device' | 'statusLabel' | 'statusDetail'>,
): string {
  return row.device.online ? row.statusLabel : `${row.statusLabel} · ${row.statusDetail}`;
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 60,
    padding: spacing.lg,
    gap: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  labels: { flex: 1, gap: spacing.xs },
  status: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  statusDot: { width: 6, height: 6, borderRadius: radius.pill, flexShrink: 0 },
  action: {
    minWidth: 72,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  pressed: mobileInteractionStyles.pressed,
  disabled: { opacity: 0.45 },
});
