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
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight } from 'lucide-react-native';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { Text } from '@/components/AppText';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { computeContextSheetSnapHeights, type ContextSheetSnap } from '@/session/contextSheetModel';
import { SheetModal } from '@/session/SheetModal';
import { SheetSurface } from '@/session/SheetSurface';
import {
  fontWeight,
  iconSize,
  iconStroke,
  radius,
  spacing,
  typeScale,
  useTheme,
  useThemedStyles,
  type ThemeColors,
} from '@/theme';

export interface ContextSheetProps {
  visible: boolean;
  onClose: () => void;
  /** header 标题；子视图（目标表单 / 截图列表）由页面换标题与返回键。 */
  title: string;
  /** 提供则 header 左侧显示返回键（子视图）；根视图无关闭键（把手下拉 / 点背板关闭）。 */
  onBack?: () => void;
  keyboardAvoidingBehavior: 'height' | 'padding' | undefined;
  children: ReactNode;
  /** 固定在面板底部（滚动区之外）的操作区，如「加入对话」提交按钮。 */
  footer?: ReactNode;
  testID?: string;
}

export function ContextSheet({
  visible,
  onClose,
  title,
  onBack,
  keyboardAvoidingBehavior,
  children,
  footer,
  testID,
}: ContextSheetProps) {
  const styles = useThemedStyles(makeContextSheetStyles);
  const { t } = useTranslation();
  const { height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [snap, setSnap] = useState<ContextSheetSnap>('half');

  // 每次重新打开都回到 half 档（与 Cursor 行为一致）。
  useEffect(() => {
    if (visible) setSnap('half');
  }, [visible]);

  // memo 保持对象身份稳定,避免每次 render 触发 useContextSheetDrag 的吸附 effect 重跑。
  const heights = useMemo(() => computeContextSheetSnapHeights({
    safeAreaTopInset: insets.top,
    screenHeight: windowHeight,
  }), [insets.top, windowHeight]);

  return (
    <SheetModal
      backdropTestID={testID ? `${testID}.backdrop` : undefined}
      keyboardAvoiding
      keyboardAvoidingBehavior={keyboardAvoidingBehavior}
      onBackdropPress={onClose}
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
        {children}
      </SheetSurface>
    </SheetModal>
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
  icon: ReactNode;
  label: string;
  onPress: () => void;
  /** 'chevron' 表示带二级视图；也可以传自定义 trailing 节点。 */
  trailing?: 'chevron' | ReactNode;
  disabled?: boolean;
  busy?: boolean;
  accessibilityHint?: string;
  testID?: string;
}

export function ContextSheetRow({
  icon,
  label,
  onPress,
  trailing,
  disabled,
  busy,
  accessibilityHint,
  testID,
}: ContextSheetRowProps) {
  const styles = useThemedStyles(makeContextSheetStyles);
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityHint={accessibilityHint}
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed, disabled && styles.rowDisabled]}
      testID={testID}
    >
      <View style={styles.rowLeft}>
        {icon}
        <Text style={styles.rowLabel}>{label}</Text>
      </View>
      <View style={styles.rowTrailing}>
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

/** footer 槽用的主操作按钮（黑底 pill，对照 Cursor「Add N」）。 */
export function ContextSheetFooterButton({
  label,
  onPress,
  busy,
  disabled,
  testID,
}: ContextSheetFooterButtonProps) {
  const styles = useThemedStyles(makeContextSheetStyles);
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.footerButton,
        disabled && styles.footerButtonDisabled,
        pressed && styles.footerButtonPressed,
      ]}
      testID={testID}
    >
      {busy ? (
        <ActivityIndicator color={colors.ctaText} size="small" />
      ) : (
        <Text style={styles.footerButtonLabel}>{label}</Text>
      )}
    </Pressable>
  );
}

const ROW_HEIGHT = 48;

function makeContextSheetStyles(colors: ThemeColors) {
  return {
    // Modal 外壳样式(背板/内容层/键盘规避)已随 SheetModal 抽出;
    // sheet 表面样式(sheet/dragZone/grabber/header/滚动区/footer 容器)已随 SheetSurface 抽出。
    footerButton: {
      alignItems: 'center' as const,
      backgroundColor: colors.cta,
      borderRadius: radius.pill,
      height: 50,
      justifyContent: 'center' as const,
    },
    footerButtonDisabled: {
      opacity: 0.4,
    },
    footerButtonPressed: {
      opacity: 0.7,
    },
    footerButtonLabel: {
      color: colors.ctaText,
      fontSize: typeScale.body,
      fontWeight: fontWeight.semibold,
    },
    group: {
      paddingTop: spacing.lg,
    },
    groupLabel: {
      color: colors.textTertiary,
      fontSize: typeScale.footnote,
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
    rowPressed: {
      opacity: 0.6,
    },
    rowDisabled: {
      opacity: 0.4,
    },
    rowLeft: {
      alignItems: 'center' as const,
      flexDirection: 'row' as const,
      gap: spacing.md,
    },
    rowLabel: {
      color: colors.textPrimary,
      fontSize: typeScale.body,
      fontWeight: fontWeight.medium,
    },
    rowTrailing: {
      alignItems: 'center' as const,
      flexDirection: 'row' as const,
      gap: spacing.sm,
    },
  };
}
