/**
 * ContextSheet —— + 号弹出的可拖动「上下文」面板。
 *
 * 结构：`SheetModal`（背板原地淡入淡出 + 面板自底部滑入滑出的共用外壳）+ `SheetSurface`
 * (底部吸附的可拖动面板表面,grabber / header / 滚动区 / footer 与拖动编排都在那里,
 * 本组件只是「一个浮窗一个 Modal」的薄壳)。
 * 档位模型与手势编排见 contextSheetModel.ts / useContextSheetDrag.ts。
 * 内容由页面以 ContextSheetGroup / ContextSheetRow / ContextSheetFooterButton 组装，
 * 会话页与新建会话页共用本组件（同 MobileComposerInputRow 的共享约定）。
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight } from 'lucide-react-native';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { Text, TextInput } from '@/components/AppText';
import { MainWindowActionButton } from '@/components/MobilePrimitives';
import { mobileInteractionStyles } from '@/components/mobileInteractionStyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { computeContextSheetSnapHeights, type ContextSheetSnap } from '@/session/contextSheetModel';
import { SheetModal } from '@/session/SheetModal';
import { SheetSurface } from '@/session/SheetSurface';
import { fontWeight, iconSize, iconStroke, lineHeight, radius, spacing, typeScale, useTheme, useThemedStyles, type ThemeColors } from '@/theme';

export interface ContextSheetProps {
  visible: boolean;
  onClose: () => void;
  /** header 标题；子视图（目标表单 / 截图列表）由页面换标题与返回键。 */
  title: string;
  /** 提供则 header 左侧显示返回键（子视图）；根视图无关闭键（把手下拉 / 点背板关闭）。 */
  onBack?: () => void;
  keyboardAvoidingBehavior: 'height' | 'padding' | undefined;
  children: ReactNode;
  media?: ReactNode;
  error?: string | null;
  /** 固定在面板底部（滚动区之外）的操作区，如「加入对话」提交按钮。 */
  footer?: ReactNode;
  testID?: string;
}

/** 系统选择器要等面板真正关闭后再呈现，避免叠在面板上（与 iOS ContextSheet 同一语义）。 */
const DismissAction = createContext<(action: () => void) => void>((action) => action());

export function ContextSheet({
  visible,
  onClose,
  title,
  onBack,
  keyboardAvoidingBehavior,
  children,
  media,
  error,
  footer,
  testID,
}: ContextSheetProps) {
  const styles = useThemedStyles(makeContextSheetStyles);
  const { t } = useTranslation();
  const { height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [snap, setSnap] = useState<ContextSheetSnap>('half');
  const pendingAfterClose = useRef<(() => void) | null>(null);

  // 每次重新打开都回到 half 档（与 Cursor 行为一致）；关闭动画中途重开时丢弃上次挂起的
  // 选择器动作，避免之后普通关闭时误弹相册 / 相机 / 文件。
  useEffect(() => {
    if (!visible) return;
    setSnap('half');
    pendingAfterClose.current = null;
  }, [visible]);

  // memo 保持对象身份稳定,避免每次 render 触发 useContextSheetDrag 的吸附 effect 重跑。
  const heights = useMemo(() => computeContextSheetSnapHeights({
    safeAreaTopInset: insets.top,
    screenHeight: windowHeight,
  }), [insets.top, windowHeight]);

  return (
    <DismissAction.Provider
      value={(action) => {
        pendingAfterClose.current = action;
        onClose();
      }}
    >
      <SheetModal
        backdropTestID={testID ? `${testID}.backdrop` : undefined}
        keyboardAvoiding
        keyboardAvoidingBehavior={keyboardAvoidingBehavior}
        onBackdropPress={onClose}
        onClosed={() => {
          const action = pendingAfterClose.current;
          pendingAfterClose.current = null;
          action?.();
        }}
        // Android 返回键 / iOS 关闭手势:两段式(对齐 ModelPickerSheet / SessionMenuSheet 的
        // handleRequestClose 语义)。子视图状态由页面持有,onBack 即「回一级」——目标模式表单 /
        // 截图列表(传了 onBack)按返回先回根视图不丢草稿,根视图(无 onBack)才整关。
        onRequestClose={onBack ?? onClose}
        visible={visible}
      >
        <SheetSurface
          backAccessibilityLabel={t('interaction.contextSheet.backAccessibility')}
          bottomInset={insets.bottom}
          footer={footer}
          heights={heights}
          onBack={onBack}
          onClose={onClose}
          onSnapChange={setSnap}
          snap={snap}
          testID={testID}
          title={title}
        >
          {media}
          {children}
          {error ? <Text style={styles.errorText}>{error}</Text> : null}
        </SheetSurface>
      </SheetModal>
    </DismissAction.Provider>
  );
}

export function ContextSheetGroup({ label, children }: { label: string; children: ReactNode }) {
  const styles = useThemedStyles(makeContextSheetStyles);
  return (
    <View style={styles.group}>
      <Text style={styles.groupLabel}>{label}</Text>
      <GroupRows>{children}</GroupRows>
    </View>
  );
}

/** 行之间自动补 1px 分隔线（对照设计稿分组内 hairline）。 */
function GroupRows({ children }: { children: ReactNode }) {
  const styles = useThemedStyles(makeContextSheetStyles);
  const rows: ReactNode[] = [];
  let index = 0;
  for (const child of flattenChildren(children)) {
    if (index > 0) rows.push(<View key={`sep-${index}`} style={styles.separator} />);
    rows.push(child);
    index += 1;
  }
  return <>{rows}</>;
}

function flattenChildren(children: ReactNode): ReactNode[] {
  if (children === null || children === undefined || typeof children === 'boolean') return [];
  if (Array.isArray(children)) return children.flatMap(flattenChildren);
  return [children];
}

export interface ContextSheetRowProps {
  /** Dismiss the sheet before presenting a system picker. */
  dismissBeforePress?: boolean;
  icon: ReactNode;
  label: string;
  onPress: () => void;
  /** 长按(如协同 Worker 行的管理操作);不传则只有点按。 */
  onLongPress?: () => void;
  /** 'chevron' 表示带二级视图；也可以传自定义 trailing 节点。 */
  trailing?: 'chevron' | ReactNode;
  /** 自定义尾部图标的方形承载尺寸；文字等尾部内容不传，继续按内容布局。 */
  trailingSize?: number;
  disabled?: boolean;
  busy?: boolean;
  accessibilityHint?: string;
  testID?: string;
  /** Destructive actions (delete) read in the destructive text color. */
  destructive?: boolean;
  /** 标签下方的次要说明(如 Worker 的 Agent · 模型)。 */
  detail?: string;
}

export function ContextSheetRow({
  dismissBeforePress = false,
  icon,
  label,
  onPress,
  onLongPress,
  trailing,
  trailingSize,
  disabled,
  busy,
  accessibilityHint,
  testID,
  destructive = false,
  detail,
}: ContextSheetRowProps) {
  const styles = useThemedStyles(makeContextSheetStyles);
  const { colors } = useTheme();
  const dismiss = useContext(DismissAction);
  return (
    <Pressable
      accessibilityHint={accessibilityHint}
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || busy }}
      disabled={disabled || busy}
      onLongPress={onLongPress}
      onPress={() => (dismissBeforePress ? dismiss(onPress) : onPress())}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed, disabled && styles.rowDisabled]}
      testID={testID}
    >
      <View style={styles.rowLeft}>
        {icon}
        {detail ? (
          <View style={styles.rowTextColumn}>
            <Text numberOfLines={1} style={[styles.rowLabel, destructive && { color: colors.destructive }]}>{label}</Text>
            <Text numberOfLines={1} style={styles.rowDetail}>{detail}</Text>
          </View>
        ) : (
          <Text style={[styles.rowLabel, destructive && { color: colors.destructive }]}>{label}</Text>
        )}
      </View>
      <View style={[
        styles.rowTrailing,
        !busy && trailing && trailing !== 'chevron' && trailingSize != null
          ? { width: trailingSize, height: trailingSize, justifyContent: 'center' as const }
          : undefined,
      ]}>
        {busy ? (
          <ActivityIndicator color={colors.textSecondary} size="small" />
        ) : trailing === 'chevron' ? (
          <ChevronRight color={colors.textTertiary} size={iconSize.md} strokeWidth={iconStroke.regular} />
        ) : (
          trailing ?? null
        )}
      </View>
    </Pressable>
  );
}

export interface ContextSheetFooterButtonProps {
  label: string;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
  testID?: string;
}

/** footer 槽用的主操作按钮:共享主按钮(cta 实心 pill;加载只转圈)。 */
export function ContextSheetFooterButton({
  label,
  onPress,
  busy,
  disabled,
  testID,
}: ContextSheetFooterButtonProps) {
  return (
    <MainWindowActionButton
      action={{ busy, disabled, label, onPress, testID, tone: 'primary' }}
    />
  );
}

/** 分组内的说明文字(提示 / 错误),不可点击。 */
export function ContextSheetNote({ text, tone = 'secondary', testID }: {
  text: string;
  tone?: 'secondary' | 'error';
  testID?: string;
}) {
  const styles = useThemedStyles(makeContextSheetStyles);
  return (
    <Text style={[styles.note, tone === 'error' && styles.noteError]} testID={testID}>{text}</Text>
  );
}

export interface ContextSheetChoiceRowProps<T extends string> {
  label: string;
  options: readonly { id: T; label: string }[];
  value: T | null;
  onChange: (value: T) => void;
  disabled?: boolean;
  testID?: string;
}

/** 单选(pill 组;iOS 版为原生 Picker)。 */
export function ContextSheetChoiceRow<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled,
  testID,
}: ContextSheetChoiceRowProps<T>) {
  const styles = useThemedStyles(makeContextSheetStyles);
  return (
    // 标签由外层分组标题承担(iOS 原生 Picker 自带 label),这里只作无障碍分组名。
    <View accessibilityLabel={label} accessibilityRole="radiogroup" style={styles.choiceRow} testID={testID}>
      <View style={styles.choicePills}>
        {options.map((option) => {
          const selected = option.id === value;
          return (
            <Pressable
              accessibilityLabel={option.label}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected, disabled }}
              disabled={disabled}
              key={option.id}
              onPress={() => onChange(option.id)}
              style={styles.choiceHitArea}
              testID={testID ? `${testID}.${option.id}` : undefined}
            >
              {({ pressed }) => (
                <View
                  style={[
                    styles.choicePill,
                    selected && styles.choicePillSelected,
                    pressed && styles.rowPressed,
                    disabled && styles.rowDisabled,
                  ]}
                >
                  <Text style={[styles.choicePillText, selected && styles.choicePillTextSelected]}>{option.label}</Text>
                </View>
              )}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export interface ContextSheetTextFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  accessibilityLabel: string;
  multiline?: boolean;
  disabled?: boolean;
  maxLength?: number;
  testID?: string;
}

/** 文本输入(iOS 版为原生 TextField)。 */
export function ContextSheetTextField({
  value,
  onChange,
  placeholder,
  accessibilityLabel,
  multiline,
  disabled,
  maxLength,
  testID,
}: ContextSheetTextFieldProps) {
  const styles = useThemedStyles(makeContextSheetStyles);
  const { colors } = useTheme();
  return (
    <TextInput
      accessibilityLabel={accessibilityLabel}
      editable={!disabled}
      maxLength={maxLength}
      multiline={multiline}
      onChangeText={onChange}
      placeholder={placeholder}
      placeholderTextColor={colors.textTertiary}
      style={[styles.textField, multiline && styles.textFieldMultiline]}
      testID={testID}
      value={value}
    />
  );
}

const ROW_HEIGHT = 48;

function makeContextSheetStyles(colors: ThemeColors) {
  return {
    // Modal 外壳样式(背板/内容层/键盘规避)已随 SheetModal 抽出;
    // sheet 表面样式(sheet/dragZone/grabber/header/滚动区/footer 容器)已随 SheetSurface 抽出。
    // 说明、提示、报错(成句的话):footnote 13/18 400。
    errorText: {
      color: colors.errorText,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      fontWeight: fontWeight.regular,
    },
    group: {
      paddingTop: spacing.lg,
    },
    groupLabel: {
      color: colors.textTertiary,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
    },
    separator: {
      backgroundColor: colors.border,
      height: StyleSheet.hairlineWidth,
    },
    row: {
      alignItems: 'center' as const,
      flexDirection: 'row' as const,
      minHeight: ROW_HEIGHT,
      justifyContent: 'space-between' as const,
    },
    rowPressed: mobileInteractionStyles.pressed,
    rowDisabled: {
      opacity: 0.4,
    },
    rowLeft: {
      alignItems: 'center' as const,
      flexDirection: 'row' as const,
      flexShrink: 1,
      gap: spacing.md,
    },
    rowLabel: {
      color: colors.textPrimary,
      fontSize: typeScale.body,
      lineHeight: lineHeight.body,
      fontWeight: fontWeight.medium,
    },
    rowTextColumn: {
      flexShrink: 1,
      gap: 2,
    },
    rowDetail: {
      color: colors.textTertiary,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
    },
    note: {
      color: colors.textTertiary,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      paddingVertical: spacing.sm,
    },
    noteError: {
      color: colors.errorText,
    },
    choiceRow: {
      gap: spacing.sm,
      paddingVertical: spacing.sm,
    },
    choicePills: {
      columnGap: spacing.sm,
      flexDirection: 'row' as const,
      flexWrap: 'wrap' as const,
    },
    // 命中区 44pt(可见 pill 仍是 32pt);换行时相邻两行命中区之间的留白就是 pill 的上下余量。
    choiceHitArea: {
      height: 44,
      justifyContent: 'center' as const,
    },
    choicePill: {
      alignItems: 'center' as const,
      backgroundColor: colors.surfaceChip,
      borderRadius: radius.pill,
      height: 32,
      justifyContent: 'center' as const,
      paddingHorizontal: spacing.md,
    },
    choicePillSelected: {
      backgroundColor: colors.cta,
    },
    choicePillText: {
      color: colors.textPrimary,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      fontWeight: fontWeight.medium,
    },
    choicePillTextSelected: {
      color: colors.ctaText,
    },
    // 单行输入按 pill,多行输入按 inner-control 8px(DESIGN.md §5)。
    textField: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      color: colors.textPrimary,
      fontSize: typeScale.body,
      marginVertical: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm + 2,
    },
    textFieldMultiline: {
      borderRadius: radius.control,
      minHeight: 96,
      textAlignVertical: 'top' as const,
    },
    rowTrailing: {
      alignItems: 'center' as const,
      flexDirection: 'row' as const,
      gap: spacing.sm,
    },
  };
}
