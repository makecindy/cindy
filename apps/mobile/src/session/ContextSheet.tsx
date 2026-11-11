import { ErrorNotice } from '@/components/ErrorNotice';
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
import { ChevronDown, ChevronRight, Plus } from 'lucide-react-native';
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
import { MOBILE_COMPOSER_CONTROL_SIZE } from '@/session/composerVoiceButtonAnchor';
import { computeContextSheetSnapHeights, type ContextSheetSnap } from '@/session/contextSheetModel';
import { SheetModal } from '@/session/SheetModal';
import { SheetSurface } from '@/session/SheetSurface';
import { AnchoredPullDownMenu } from '@/platform/chrome/AnchoredPullDownMenu';
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
          {error ? <ErrorNotice message={error} /> : null}
        </SheetSurface>
      </SheetModal>
    </DismissAction.Provider>
  );
}

export interface ContextSheetGroupProps {
  /** 分组小标签;行自己带名称的分组(如 iOS 下拉行)传空串,不再重复一遍。 */
  label: string;
  children: ReactNode;
  /**
   * 卡片下方的说明(设置类分组惯例,对齐 SettingsGroup 的 footer):卡片里只放
   * 「名称 + 取值 / 开关 / 箭头」,成句的说明与校验提示写在这里。一组只配一段。
   */
  footer?: string | null;
  footerTone?: 'secondary' | 'error';
  footerTestID?: string;
}

export function ContextSheetGroup({ label, children, footer, footerTone, footerTestID }: ContextSheetGroupProps) {
  const styles = useThemedStyles(makeContextSheetStyles);
  return (
    <View style={styles.group}>
      {label ? <Text style={styles.groupLabel}>{label}</Text> : null}
      <GroupRows>{children}</GroupRows>
      {footer ? <ContextSheetNote text={footer} tone={footerTone} testID={footerTestID} /> : null}
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
  /** 行首图标;设置类表单行只放名称与取值,不传。 */
  icon?: ReactNode;
  label: string;
  /** 右侧取值(16/22 400 textSecondary),在箭头之前;过长截断。 */
  value?: string;
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
  /** 次要说明最多显示几行；默认 1 行。 */
  detailLines?: number;
}

export function ContextSheetRow({
  dismissBeforePress = false,
  icon,
  label,
  value,
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
  detailLines = 1,
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
            <Text numberOfLines={detailLines} style={styles.rowDetail}>{detail}</Text>
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
        ) : (
          <>
            {value ? <Text numberOfLines={1} style={styles.rowValue}>{value}</Text> : null}
            {trailing === 'chevron' ? (
              <ChevronRight color={colors.textTertiary} size={iconSize.lg} strokeWidth={iconStroke.regular} />
            ) : (
              trailing ?? null
            )}
          </>
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

/** 独立操作失败；字段校验继续使用 ContextSheetNote。 */
export function ContextSheetError({ text, testID }: { text: string; testID?: string }) {
  return <ErrorNotice message={text} messageTestID={testID} />;
}

export interface ContextSheetChoiceRowProps<T extends string> {
  label: string;
  options: readonly { id: T; label: string }[];
  value: T | null;
  onChange: (value: T) => void;
  disabled?: boolean;
  testID?: string;
}

export interface ContextSheetSelectRowProps {
  label: string;
  options: readonly { id: string; label: string; detail?: string; disabled?: boolean }[];
  value: string;
  onChange(value: string): void;
  disabled?: boolean;
  testID?: string;
}

/** 有界滚动的设备等长列表，不把选项平铺到表单里。iOS 复用原生 menu Picker。 */
export function ContextSheetSelectRow(props: ContextSheetSelectRowProps) {
  const { colors } = useTheme();
  const row = (
    <ContextSheetRow
      icon={null}
      disabled={props.disabled}
      label={props.options.find((option) => option.id === props.value)?.label ?? props.label}
      onPress={() => undefined}
      trailing={<ChevronDown color={colors.textSecondary} size={iconSize.lg} strokeWidth={iconStroke.regular} />}
    />
  );
  if (props.disabled) return row;
  return (
    <AnchoredPullDownMenu
      accessibilityLabel={props.label}
      actions={props.options.map((option) => ({
        id: option.id,
        title: option.label,
        subtitle: option.detail,
        disabled: props.disabled || option.disabled,
        state: option.id === props.value ? 'on' : 'off',
      }))}
      onAction={(id) => {
        if (!props.disabled && props.options.some((option) => option.id === id && !option.disabled)) {
          props.onChange(id);
        }
      }}
      testID={props.testID}
    >
      {row}
    </AnchoredPullDownMenu>
  );
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

export interface ContextSheetChipRowProps {
  /** 这一排的名字(读屏分组名)。 */
  label: string;
  chips: readonly { id: string; label: string }[];
  /** 选中的那个；null = 都没选中(如正在添加)。 */
  value: string | null;
  onChange: (id: string) => void;
  /** 长按一个 chip(如移除角色)；不传则只有点按。 */
  onLongPress?: (id: string) => void;
  /** 长按能做什么，读给读屏用户。 */
  longPressHint?: string;
  /** 末尾的加号；selected 表示正在添加。 */
  add?: { label: string; selected: boolean; onPress: () => void };
  disabled?: boolean;
  testID?: string;
}

/** 一排可点的小标签(角色等)，末尾可带加号；iOS 版横向滑动，这里自动换行。 */
export function ContextSheetChipRow({
  label,
  chips,
  value,
  onChange,
  onLongPress,
  longPressHint,
  add,
  disabled,
  testID,
}: ContextSheetChipRowProps) {
  const styles = useThemedStyles(makeContextSheetStyles);
  const { colors } = useTheme();
  return (
    <View accessibilityLabel={label} accessibilityRole="radiogroup" style={styles.choiceRow} testID={testID}>
      <View style={styles.choicePills}>
        {chips.map((chip) => {
          const selected = chip.id === value;
          return (
            <Pressable
              accessibilityHint={onLongPress ? longPressHint : undefined}
              accessibilityLabel={chip.label}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected, disabled }}
              disabled={disabled}
              key={chip.id}
              onLongPress={onLongPress ? () => onLongPress(chip.id) : undefined}
              onPress={() => onChange(chip.id)}
              style={styles.choiceHitArea}
              testID={testID ? `${testID}.${chip.id}` : undefined}
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
                  <Text numberOfLines={1} style={[styles.choicePillText, selected && styles.choicePillTextSelected]}>{chip.label}</Text>
                </View>
              )}
            </Pressable>
          );
        })}
        {add ? (
          <Pressable
            accessibilityLabel={add.label}
            accessibilityRole="button"
            accessibilityState={{ selected: add.selected, disabled }}
            disabled={disabled}
            onPress={add.onPress}
            style={styles.choiceHitArea}
            testID={testID ? `${testID}.add` : undefined}
          >
            {({ pressed }) => (
              <View
                style={[
                  styles.choicePill,
                  styles.choicePillIcon,
                  add.selected && styles.choicePillSelected,
                  pressed && styles.rowPressed,
                  disabled && styles.rowDisabled,
                ]}
              >
                <Plus
                  color={add.selected ? colors.ctaText : colors.textPrimary}
                  size={iconSize.md}
                  strokeWidth={iconStroke.regular}
                />
              </View>
            )}
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

export interface ContextSheetToolbarRowProps {
  /**
   * 左侧只放图标的菜单(如权限)，对齐输入框里的权限圆钮：点开在旁边列出选项，当前项打勾。
   * 图标与着色由调用方按当前取值给。
   */
  menu?: {
    accessibilityLabel: string;
    icon: ReactNode;
    value: string;
    options: readonly { id: string; label: string }[];
    onChange: (id: string) => void;
    testID?: string;
  } | null;
  /** 右侧带文字的入口(如模型)。 */
  action: {
    label: string;
    accessibilityLabel: string;
    onPress: () => void;
    /** 先收起面板再执行(系统 sheet 不能叠开)。 */
    dismissBeforePress?: boolean;
    testID?: string;
  };
  disabled?: boolean;
}

/** 输入框里底部的一行工具：与聊天输入框同序，左边是只有图标的菜单，右边是带文字的入口。 */
function ContextSheetToolbarRow({ menu, action, disabled }: ContextSheetToolbarRowProps) {
  const styles = useThemedStyles(makeContextSheetStyles);
  const { colors } = useTheme();
  const dismiss = useContext(DismissAction);
  const menuButton = menu ? (
    <View style={[styles.toolbarIconButton, disabled && styles.rowDisabled]}>{menu.icon}</View>
  ) : null;
  return (
    <View style={styles.toolbarRow}>
      {menu && menuButton ? (
        disabled ? menuButton : (
          <AnchoredPullDownMenu
            accessibilityLabel={menu.accessibilityLabel}
            actions={menu.options.map((option) => ({
              id: option.id,
              title: option.label,
              state: option.id === menu.value ? 'on' as const : 'off' as const,
            }))}
            onAction={(id) => {
              if (menu.options.some((option) => option.id === id)) menu.onChange(id);
            }}
            testID={menu.testID}
          >
            {menuButton}
          </AnchoredPullDownMenu>
        )
      ) : null}
      <View style={styles.toolbarSpacer} />
      <Pressable
        accessibilityLabel={action.accessibilityLabel}
        accessibilityRole="button"
        accessibilityState={{ disabled }}
        disabled={disabled}
        hitSlop={8}
        onPress={() => (action.dismissBeforePress ? dismiss(action.onPress) : action.onPress())}
        style={({ pressed }) => [styles.toolbarAction, pressed && styles.rowPressed, disabled && styles.rowDisabled]}
        testID={action.testID}
      >
        <Text numberOfLines={1} style={styles.toolbarActionText}>{action.label}</Text>
        <ChevronDown color={colors.textTertiary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
      </Pressable>
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
  /** 出现时直接聚焦(如点加号后的角色名输入)。 */
  autoFocus?: boolean;
  testID?: string;
  /** 输入框里底部的一行工具(如权限与模型)，和输入框连成一块，像聊天输入框那样。 */
  toolbar?: ContextSheetToolbarRowProps;
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
  autoFocus,
  testID,
  toolbar,
}: ContextSheetTextFieldProps) {
  const styles = useThemedStyles(makeContextSheetStyles);
  const { colors } = useTheme();
  const input = (
    <TextInput
      accessibilityLabel={accessibilityLabel}
      autoFocus={autoFocus}
      editable={!disabled}
      maxLength={maxLength}
      multiline={multiline}
      onChangeText={onChange}
      placeholder={placeholder}
      placeholderTextColor={colors.textTertiary}
      style={[styles.textField, multiline && styles.textFieldMultiline, toolbar && styles.textFieldInBox]}
      testID={testID}
      value={value}
    />
  );
  if (!toolbar) return input;
  // 边框画在外层，输入区和工具行同在一个框里。
  return (
    <View style={styles.textFieldBox}>
      {input}
      <ContextSheetToolbarRow {...toolbar} disabled={toolbar.disabled ?? disabled} />
    </View>
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
    // 分组小标签:13/18 600 textTertiary(设置类分组同一档)。
    groupLabel: {
      color: colors.textTertiary,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      fontWeight: fontWeight.semibold,
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
    // 行右侧取值:16/22 400 textSecondary。
    rowValue: {
      color: colors.textSecondary,
      flexShrink: 1,
      fontSize: typeScale.body,
      lineHeight: lineHeight.body,
      fontWeight: fontWeight.regular,
      maxWidth: '60%' as const,
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
    // 说明、提示(成句的话):13/18 400 textSecondary。
    note: {
      color: colors.textSecondary,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      fontWeight: fontWeight.regular,
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
    // 只放图标的 pill(加号)：与文字 pill 同高的圆。
    choicePillIcon: {
      paddingHorizontal: 0,
      width: 32,
    },
    textFieldBox: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: radius.control,
      borderWidth: StyleSheet.hairlineWidth,
      marginVertical: spacing.sm,
    },
    textFieldInBox: {
      backgroundColor: 'transparent',
      borderWidth: 0,
      marginVertical: 0,
    },
    toolbarRow: {
      alignItems: 'center' as const,
      flexDirection: 'row' as const,
      gap: spacing.sm,
      minHeight: 44,
      paddingHorizontal: spacing.sm,
    },
    toolbarSpacer: {
      flex: 1,
    },
    // 与输入框里的权限圆钮同款：只有图标的圆钮。
    toolbarIconButton: {
      alignItems: 'center' as const,
      backgroundColor: colors.sheetActionSurface,
      borderColor: colors.sheetActionBorder,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      height: MOBILE_COMPOSER_CONTROL_SIZE,
      justifyContent: 'center' as const,
      width: MOBILE_COMPOSER_CONTROL_SIZE,
    },
    // 与输入框里的模型 pill 同款。
    toolbarAction: {
      alignItems: 'center' as const,
      backgroundColor: colors.sheetActionSurface,
      borderColor: colors.sheetActionBorder,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row' as const,
      flexShrink: 1,
      gap: spacing.xs,
      minHeight: MOBILE_COMPOSER_CONTROL_SIZE,
      minWidth: 0,
      paddingHorizontal: spacing.md,
    },
    toolbarActionText: {
      color: colors.textPrimary,
      flexShrink: 1,
      fontSize: typeScale.caption,
      lineHeight: lineHeight.caption,
      fontWeight: fontWeight.medium,
      minWidth: 0,
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
      flexShrink: 1,
      gap: spacing.sm,
    },
  };
}
