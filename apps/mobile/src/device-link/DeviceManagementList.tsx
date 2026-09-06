import { useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Monitor } from 'lucide-react-native';
import { Text } from '@/components/AppText';
import {
  ClassicSwipeable,
  type ClassicSwipeableMethods,
} from '@/platform/gestureHandler';
import { useTheme } from '@/theme';
import {
  fontWeight,
  iconSize,
  iconStroke,
  spacing,
  typeScale,
} from '@/theme/tokens';
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
  const action = (remove: boolean) => (
    <Pressable
      accessibilityRole="button"
      disabled={busy}
      onPress={() => {
        ref.current?.close();
        (remove ? onDelete : onRename)(row.device);
      }}
      style={[styles.action, { backgroundColor: colors.surfaceElevated }]}
    >
      <Text style={{ color: remove ? colors.destructive : colors.textPrimary }}>
        {t(remove ? 'devices.common.delete' : 'devices.list.menu.renameDevice')}
      </Text>
    </Pressable>
  );
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
          color={row.device.online ? colors.statusReady : colors.textSecondary}
        />
        <View style={styles.labels}>
          <Text
            style={{
              color: row.device.online
                ? colors.textPrimary
                : colors.textTertiary,
              fontSize: typeScale.body,
              fontWeight: row.device.online
                ? fontWeight.medium
                : fontWeight.regular,
            }}
          >
            {row.device.name}
          </Text>
          <Text style={{ color: colors.textSecondary }}>
            {row.statusLabel} · {row.statusDetail}
          </Text>
        </View>
      </Pressable>
    </ClassicSwipeable>
  );
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
  action: {
    minWidth: 88,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
});
