import SegmentedControl from '@expo/ui/community/segmented-control';
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { MainWindowOptionButton } from '@/components/MobilePrimitives';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { radius, spacing } from '@/theme/tokens';

export interface FileBrowserSegmentOption<T extends string> {
  value: T;
  label: string;
  accessibilityLabel?: string;
  testID?: string;
}

/**
 * 文件浏览 / 预览页的二选一切换(搜索范围、渲染 / 源码)。
 * 与远程桌面同一平台惯例:iOS 用系统分段控件,其它端用共享分段选项
 * (胶囊外框 + tab 角色 + 选中态,选中只换色不加粗)。两端命中高度都是 44。
 */
export function FileBrowserSegmentedControl<T extends string>({
  accessibilityLabel,
  onChange,
  options,
  style,
  testID,
  value,
}: {
  accessibilityLabel: string;
  onChange(next: T): void;
  options: readonly FileBrowserSegmentOption<T>[];
  style?: StyleProp<ViewStyle>;
  testID?: string;
  value: T;
}) {
  const styles = useThemedStyles(makeStyles);
  const { mode } = useTheme();
  const selectedIndex = options.findIndex((option) => option.value === value);

  if (Platform.OS === 'ios') {
    return (
      <View accessibilityLabel={accessibilityLabel} style={style} testID={testID}>
        <SegmentedControl
          appearance={mode}
          onChange={({ nativeEvent }) => {
            const next = options[nativeEvent.selectedSegmentIndex];
            if (next && next.value !== value) onChange(next.value);
          }}
          selectedIndex={selectedIndex}
          style={styles.native}
          values={options.map((option) => option.label)}
        />
      </View>
    );
  }

  return (
    <View
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="tablist"
      style={[styles.track, style]}
      testID={testID}
    >
      {options.map((option) => (
        <MainWindowOptionButton
          accessibilityLabel={option.accessibilityLabel ?? option.label}
          accessibilityRole="tab"
          density="default"
          key={option.value}
          label={option.label}
          onPress={() => onChange(option.value)}
          selected={option.value === value}
          style={styles.option}
          testID={option.testID}
          variant="segmented"
        />
      ))}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  native: { height: 44 },
  track: {
    backgroundColor: colors.surfaceChip,
    borderRadius: radius.pill,
    flexDirection: 'row',
    padding: spacing.xs,
  },
  option: { flex: 1, minHeight: 44 },
});
