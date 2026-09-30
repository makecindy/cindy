/**
 * 设置类页面共用的分组卡片与行(设置页、设置子页、设备管理列表)。
 *
 * 行布局规则(用户定稿):左侧标签 / 说明可换行;右侧取值右对齐、不收缩(过长时截断在
 * 行宽 60% 内)。行标题 16/22 500 textPrimary,取值 16/22 400 textSecondary,
 * 说明 13/18 400 textSecondary;分组标题 13/18 600 textTertiary。
 */
import { Children, isValidElement, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { ChevronDown, ChevronRight } from 'lucide-react-native';
import { Text } from '@/components/AppText';
import { mobileInteractionStyles } from '@/components/mobileInteractionStyles';
import { NativeSwitch } from '@/platform/chrome';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, iconSize, iconStroke, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';

import { DisclosureItem, useDisclosurePrepare } from './listDisclosureTransition';

export const useSettingsRowStyles = () => useThemedStyles(makeSettingsRowStyles);

/**
 * iOS 风格分组:组标题在外侧 gutter,组内一块统一卡片,行间用 inset 分隔线。
 * rows 为空则不渲染卡片;footer 为卡片下方 gutter 里的说明文字(iOS 分组 footer 惯例)。
 */
export function SettingsGroup({
  children,
  footer,
  testID,
  title,
  titleAccessory,
}: {
  children: ReactNode;
  footer?: string;
  testID?: string;
  title?: string;
  titleAccessory?: ReactNode;
}) {
  const styles = useSettingsRowStyles();
  // Children.toArray 会丢弃 null/false 并给每个 child 赋稳定 key(沿用元素自身 key),
  // 比 key={index} 更稳:后续插入/重排行时不会让无关行 remount。
  const rows = Children.toArray(children);
  // 分组、卡片与行都挂列表过渡:可折叠分组展开 / 收起时,卡片从折叠行下拉开、下方分组
  // 平滑让位,收起的行最后淡掉(页面需包在 ListDisclosureScope 里,否则无动画)。
  return (
    <DisclosureItem style={styles.group} testID={testID}>
      {title ? (
        <View style={styles.groupTitleRow}>
          <Text accessibilityRole="header" style={styles.groupTitle}>{title}</Text>
          {titleAccessory}
        </View>
      ) : null}
      {rows.length > 0 ? (
        <DisclosureItem style={styles.card}>
          {rows.map((row, index) => (
            <DisclosureItem exit key={isValidElement(row) && row.key != null ? row.key : index}>
              {index > 0 ? <View style={styles.divider} /> : null}
              {row}
            </DisclosureItem>
          ))}
        </DisclosureItem>
      ) : null}
      {footer && rows.length > 0 ? (
        <Text style={styles.groupFooter}>{footer}</Text>
      ) : null}
    </DisclosureItem>
  );
}

/** 设置项的单选入口行:iOS 由外层原生下拉菜单接管点击,其它平台打开选择面板。 */
export function ChoicePickerRow({
  expanded,
  label,
  onPress,
  testID,
  value,
}: {
  expanded: boolean;
  label: string;
  onPress(): void;
  testID?: string;
  value: string;
}) {
  const styles = useSettingsRowStyles();
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityLabel={`${label}: ${value}`}
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      testID={testID}
    >
      <View style={styles.rowLine}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={styles.rowValue} numberOfLines={1}>{value}</Text>
        <ChevronDown color={colors.textTertiary} size={iconSize.lg} strokeWidth={iconStroke.regular} />
      </View>
    </Pressable>
  );
}

/** 只读信息行:标签左、值右;可选 detail 另起一行。 */
export function InfoRow({
  detail,
  label,
  testID,
  value,
}: {
  detail?: string;
  label: string;
  testID?: string;
  value: string;
}) {
  const styles = useSettingsRowStyles();
  return (
    <View style={styles.row} testID={testID}>
      <View style={styles.rowLine}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={styles.rowValue} numberOfLines={1}>{value}</Text>
      </View>
      {detail ? <Text style={styles.rowDetail}>{detail}</Text> : null}
    </View>
  );
}

/** 可点击信息行:进入子页、轻量编辑或打开外部信息;右侧统一 lg + textTertiary 箭头。 */
export function ActionInfoRow({
  accessibilityLabel,
  accessibilityRole = 'button',
  detail,
  disabled = false,
  label,
  onPress,
  testID,
  value = '',
}: {
  accessibilityLabel: string;
  accessibilityRole?: 'button' | 'link';
  detail?: string;
  disabled?: boolean;
  label: string;
  onPress(): void;
  testID?: string;
  value?: string;
}) {
  const styles = useSettingsRowStyles();
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole={accessibilityRole}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.row, (pressed || disabled) && styles.pressed]}
      testID={testID}
    >
      <View style={styles.rowLine}>
        <Text style={styles.rowLabel}>{label}</Text>
        {value ? <Text style={styles.rowValue} numberOfLines={1}>{value}</Text> : null}
        <ChevronRight color={colors.textTertiary} size={iconSize.lg} strokeWidth={iconStroke.regular} />
      </View>
      {detail ? <Text style={styles.rowDetail}>{detail}</Text> : null}
    </Pressable>
  );
}

/** 卡片内的折叠开关行(如「调试 / 开发者」):展开后其余行接在同一张卡片里。 */
export function SettingsDisclosureRow({
  expanded,
  label,
  onPress,
  testID,
}: {
  expanded: boolean;
  label: string;
  onPress(): void;
  testID?: string;
}) {
  const styles = useSettingsRowStyles();
  const { colors } = useTheme();
  const prepareDisclosure = useDisclosurePrepare();
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      onPress={onPress}
      onPressIn={() => prepareDisclosure()}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      testID={testID}
    >
      <View style={styles.rowLine}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Chevron color={colors.textTertiary} size={iconSize.lg} strokeWidth={iconStroke.regular} />
      </View>
    </Pressable>
  );
}

/** 开关行:标签 + 说明在左(可换行),系统开关在右;accessory 可追加开关右侧的次级入口。 */
export function SettingsSwitchRow({
  accessory,
  accessibilityLabel,
  disabled,
  hint,
  label,
  messages,
  onValueChange,
  switchTestID,
  testID,
  value,
}: {
  accessory?: ReactNode;
  accessibilityLabel?: string;
  disabled?: boolean;
  hint?: string;
  label: string;
  /** 开关下方的附加提示(保存失败、权限被拒等),按 13/18 说明档呈现。 */
  messages?: ReadonlyArray<{ text: string; testID?: string } | null | undefined>;
  onValueChange(value: boolean): void;
  switchTestID?: string;
  testID?: string;
  value: boolean;
}) {
  const styles = useSettingsRowStyles();
  const { colors } = useTheme();
  return (
    <View style={styles.switchRow} testID={testID}>
      <View style={styles.switchTexts}>
        <Text style={styles.rowLabel}>{label}</Text>
        {hint ? <Text style={styles.hint}>{hint}</Text> : null}
        {messages?.map((message, index) => message ? (
          <Text key={message.testID ?? index} style={styles.hint} testID={message.testID}>{message.text}</Text>
        ) : null)}
      </View>
      <NativeSwitch
        accessibilityLabel={accessibilityLabel ?? label}
        disabled={disabled}
        onValueChange={onValueChange}
        seedColor={colors.inputCaret}
        testID={switchTestID}
        value={value}
      />
      {accessory}
    </View>
  );
}

const makeSettingsRowStyles = (colors: ThemeColors) => StyleSheet.create({
  // —— 分组 ——
  group: { gap: spacing.sm },
  groupTitleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xs,
    minHeight: spacing.xl,
    paddingHorizontal: spacing.md,
  },
  groupTitle: { color: colors.textTertiary, flex: 1, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.semibold },
  groupFooter: {
    color: colors.textSecondary,
    fontSize: typeScale.footnote,
    lineHeight: lineHeight.caption,
    paddingHorizontal: spacing.md,
  },
  card: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  divider: { backgroundColor: colors.border, height: StyleSheet.hairlineWidth, marginLeft: spacing.lg },
  // —— 行 ——
  row: { gap: spacing.xs, justifyContent: 'center', minHeight: 52, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  rowLine: { alignItems: 'center', flexDirection: 'row', gap: spacing.md },
  // 左侧标签可换行(flex 1 + shrink);右侧取值右对齐、不收缩,过长截断在行宽 60% 内。
  rowLabel: { color: colors.textPrimary, flex: 1, flexShrink: 1, fontSize: typeScale.body, fontWeight: fontWeight.medium, lineHeight: lineHeight.body, minWidth: 0 },
  rowValue: { color: colors.textSecondary, flexShrink: 0, fontSize: typeScale.body, fontWeight: fontWeight.regular, lineHeight: lineHeight.body, maxWidth: '60%', textAlign: 'right' },
  rowDetail: { color: colors.textSecondary, fontSize: typeScale.footnote, fontWeight: fontWeight.regular, lineHeight: lineHeight.caption },
  switchRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: 52,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  switchTexts: { flex: 1, gap: spacing.xs, minWidth: 0 },
  hint: { color: colors.textSecondary, fontSize: typeScale.footnote, fontWeight: fontWeight.regular, lineHeight: lineHeight.caption },
  pressed: mobileInteractionStyles.pressed,
});
