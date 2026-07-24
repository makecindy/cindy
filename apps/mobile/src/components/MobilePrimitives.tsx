import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft } from 'lucide-react-native';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  View,
  type AccessibilityRole,
  type AccessibilityState,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Text } from '@/components/AppText';
import { fontWeight, iconSize, iconStroke, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { lineHeight, radius, spacing, typeScale } from '@/theme/tokens';

type PillTone = 'default' | 'primary' | 'attention';
type MainWindowActionTone = 'danger' | 'primary' | 'secondary';
type MainWindowActionDensity = 'compact' | 'default';

export interface MainWindowAction {
  accessibilityLabel?: string;
  active?: boolean;
  busy?: boolean;
  disabled?: boolean;
  label: string;
  onPress?: () => void;
  testID?: string;
  tone?: MainWindowActionTone;
}

export function MainWindowOptionButton({
  accessibilityLabel,
  accessibilityRole = 'button',
  accessibilityState,
  density = 'compact',
  disabled = false,
  label,
  onPress,
  selected = false,
  style,
  testID,
  variant = 'pill',
}: {
  accessibilityLabel?: string;
  accessibilityRole?: AccessibilityRole;
  accessibilityState?: AccessibilityState;
  density?: MainWindowActionDensity;
  disabled?: boolean;
  label: string;
  onPress?: () => void;
  selected?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  variant?: 'pill' | 'segmented';
}) {
  const styles = useThemedStyles(makeStyles);
  const compact = density === 'compact';
  const interactionDisabled = disabled || !onPress;
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole={accessibilityRole}
      accessibilityState={{ ...accessibilityState, disabled: interactionDisabled, selected }}
      disabled={interactionDisabled}
      onPress={interactionDisabled ? undefined : onPress}
      style={({ pressed }) => [
        styles.mainOptionButton,
        compact && styles.mainOptionButtonCompact,
        variant === 'segmented' && styles.mainOptionButtonSegmented,
        selected && styles.mainOptionButtonSelected,
        pressed && styles.pressed,
        interactionDisabled && styles.disabled,
        style,
      ]}
      testID={testID}
    >
      <Text
        numberOfLines={1}
        style={[
          styles.mainOptionButtonText,
          selected && styles.mainOptionButtonTextSelected,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function MainWindowRowButton({
  accessibilityLabel,
  accessibilityRole = 'button',
  accessibilityState,
  children,
  disabled = false,
  expanded,
  onLongPress,
  onPress,
  selected = false,
  selectedTone = 'default',
  style,
  testID,
}: {
  accessibilityLabel: string;
  accessibilityRole?: AccessibilityRole;
  accessibilityState?: AccessibilityState;
  children: ReactNode;
  disabled?: boolean;
  expanded?: boolean;
  onLongPress?: () => void;
  onPress?: () => void;
  selected?: boolean;
  selectedTone?: 'default' | 'primary';
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const interactionDisabled = disabled || (!onPress && !onLongPress);
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole={accessibilityRole}
      accessibilityState={{ ...accessibilityState, disabled: interactionDisabled, expanded, selected }}
      disabled={interactionDisabled}
      onLongPress={interactionDisabled ? undefined : onLongPress}
      onPress={interactionDisabled ? undefined : onPress}
      style={({ pressed }) => [
        styles.mainRowButton,
        selected && selectedTone === 'default' && styles.mainRowButtonSelected,
        selected && selectedTone === 'primary' && styles.mainRowButtonSelectedPrimary,
        pressed && styles.pressed,
        interactionDisabled && styles.disabled,
        style,
      ]}
      testID={testID}
    >
      {children}
    </Pressable>
  );
}

export function MainWindowCardButton({
  accessibilityLabel,
  accessibilityRole = 'button',
  accessibilityState,
  children,
  disabled = false,
  onPress,
  selected = false,
  style,
  testID,
}: {
  accessibilityLabel: string;
  accessibilityRole?: AccessibilityRole;
  accessibilityState?: AccessibilityState;
  children: ReactNode;
  disabled?: boolean;
  onPress?: () => void;
  selected?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const interactionDisabled = disabled || !onPress;
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole={accessibilityRole}
      accessibilityState={{ ...accessibilityState, disabled: interactionDisabled, selected }}
      disabled={interactionDisabled}
      onPress={interactionDisabled ? undefined : onPress}
      style={({ pressed }) => [
        styles.mainCardButton,
        style,
        selected && styles.mainCardButtonSelected,
        pressed && styles.pressed,
        interactionDisabled && styles.disabled,
      ]}
      testID={testID}
    >
      {children}
    </Pressable>
  );
}

export function StatusDot({
  tone,
  pulsing = false,
}: {
  tone: 'ready' | 'busy' | 'muted' | 'off';
  pulsing?: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!pulsing) {
      pulse.setValue(1);
      return undefined;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          duration: 680,
          easing: Easing.inOut(Easing.ease),
          toValue: 0.42,
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          duration: 680,
          easing: Easing.inOut(Easing.ease),
          toValue: 1,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
    };
  }, [pulse, pulsing]);

  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={[
        styles.statusDot,
        tone === 'ready' && styles.statusDotReady,
        tone === 'busy' && styles.statusDotBusy,
        tone === 'muted' && styles.statusDotMuted,
        tone === 'off' && styles.statusDotOff,
        pulsing && styles.statusDotPulsing,
        pulsing && {
          opacity: pulse,
          transform: [{
            scale: pulse.interpolate({
              inputRange: [0.42, 1],
              outputRange: [0.78, 1],
            }),
          }],
        },
      ]}
    />
  );
}

export function ActionPill({
  accessibilityHint,
  accessibilityLabel,
  active = false,
  disabled = false,
  label,
  onPress,
  style,
  testID,
}: {
  accessibilityHint?: string;
  accessibilityLabel?: string;
  active?: boolean;
  disabled?: boolean;
  label: string;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const interactionDisabled = disabled || !onPress;
  return (
    <Pressable
      accessibilityHint={accessibilityHint}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole="button"
      accessibilityState={{ disabled: interactionDisabled, selected: active || undefined }}
      disabled={interactionDisabled}
      onPress={interactionDisabled ? undefined : onPress}
      style={({ pressed }) => [
        styles.actionPill,
        active && styles.actionPillActive,
        pressed && styles.pressed,
        interactionDisabled && styles.disabled,
        style,
      ]}
      testID={testID}
    >
      <Text numberOfLines={1} style={styles.actionPillText}>
        {label}
      </Text>
    </Pressable>
  );
}

export function InfoPill({
  label,
  strong = false,
  testID,
  tone = 'default',
}: {
  label: string;
  strong?: boolean;
  testID?: string;
  tone?: PillTone;
}) {
  const styles = useThemedStyles(makeStyles);
  const inverted = tone === 'primary' || tone === 'attention';
  return (
    <View
      style={[
        styles.infoPill,
        strong && styles.infoPillStrong,
        tone === 'primary' && styles.infoPillPrimary,
        tone === 'attention' && styles.infoPillAttention,
      ]}
      testID={testID}
    >
      <Text numberOfLines={1} style={[styles.infoPillText, strong && styles.infoPillTextStrong, inverted && styles.infoPillTextInverted]}>
        {label}
      </Text>
    </View>
  );
}

export function ScreenHeader({
  action,
  backTestID,
  density = 'default',
  eyebrow,
  onBack,
  right,
  subtitle,
  title,
  titleTestID,
}: {
  action?: MainWindowAction;
  backTestID?: string;
  density?: 'default' | 'compact';
  /** 标题上方的小字导语;不传则不渲染(如设置页只要「设置」两个字)。 */
  eyebrow?: string;
  onBack?: () => void;
  right?: ReactNode;
  subtitle?: string | null;
  title: string;
  titleTestID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const compact = density === 'compact';
  return (
    <View style={[styles.screenHeader, compact && styles.screenHeaderCompact]}>
      {onBack ? (
        <ScreenBackButton
          compact={compact}
          onPress={onBack}
          testID={backTestID ?? 'screen.backButton'}
        />
      ) : null}
      <View style={styles.headerText}>
        {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
        <Text numberOfLines={1} style={[styles.headerTitle, compact && styles.headerTitleCompact]} testID={titleTestID}>
          {title}
        </Text>
        {subtitle ? (
          <Text numberOfLines={1} style={styles.headerSubtitle}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right ?? (action ? <MainWindowActionButton action={action} density="compact" style={styles.headerActionButton} /> : null)}
    </View>
  );
}

export function ScreenBackButton({
  compact = false,
  hitSlop,
  onPress,
  style,
  testID,
}: {
  compact?: boolean;
  hitSlop?: PressableProps['hitSlop'];
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  testID: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const interactionDisabled = !onPress;
  return (
    <Pressable
      accessibilityLabel={t('shared.back')}
      accessibilityRole="button"
      accessibilityState={{ disabled: interactionDisabled }}
      disabled={interactionDisabled}
      hitSlop={hitSlop}
      onPress={interactionDisabled ? undefined : onPress}
      style={({ pressed }) => [
        styles.backButton,
        compact && styles.backButtonCompact,
        pressed && styles.pressed,
        interactionDisabled && styles.disabled,
        style,
      ]}
      testID={testID}
    >
      <ChevronLeft color={colors.textPrimary} size={iconSize.action} strokeWidth={iconStroke.regular} />
    </Pressable>
  );
}

export function SummaryStrip({
  children,
  style,
  testID,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={[styles.summaryStrip, style]} testID={testID}>
      {children}
    </View>
  );
}

export function MainWindowMetric({
  accessibilityLabel,
  label,
  onPress,
  selected = false,
  style,
  testID,
  urgent = false,
  value,
  valueSize = 'body',
  variant = 'tile',
}: {
  accessibilityLabel?: string;
  label: string;
  onPress?: () => void;
  selected?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  urgent?: boolean;
  value: number | string;
  valueSize?: 'body' | 'large';
  variant?: 'pill' | 'tile';
}) {
  const styles = useThemedStyles(makeStyles);
  const highlighted = urgent || selected;
  const content = (
    <>
      <Text
        numberOfLines={variant === 'tile' ? 2 : 1}
        style={[
          styles.mainMetricValue,
          valueSize === 'large' && styles.mainMetricValueLarge,
          highlighted && styles.mainMetricTextInverted,
        ]}
      >
        {value}
      </Text>
      <Text
        numberOfLines={1}
        style={[
          styles.mainMetricLabel,
          highlighted && styles.mainMetricTextInverted,
        ]}
      >
        {label}
      </Text>
    </>
  );
  const metricStyle = [
    styles.mainMetric,
    variant === 'pill' ? styles.mainMetricPill : styles.mainMetricTile,
    highlighted && styles.mainMetricHighlighted,
    style,
  ];

  if (onPress) {
    return (
      <Pressable
        accessibilityLabel={accessibilityLabel ?? `${label} ${value}`}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        onPress={onPress}
        style={({ pressed }) => [
          ...metricStyle,
          pressed && styles.pressed,
        ]}
        testID={testID}
      >
        {content}
      </Pressable>
    );
  }

  return (
    <View style={metricStyle} testID={testID}>
      {content}
    </View>
  );
}

export function MainWindowEmptyState({
  children,
  copy,
  centered = false,
  dashed = false,
  style,
  testID,
  title,
}: {
  children?: ReactNode;
  copy: string;
  centered?: boolean;
  dashed?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  title: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View
      style={[
        styles.mainEmptyState,
        centered && styles.mainEmptyStateCentered,
        dashed && styles.mainEmptyStateDashed,
        style,
      ]}
      testID={testID}
    >
      <Text style={[styles.mainEmptyTitle, centered && styles.mainEmptyTextCentered]}>{title}</Text>
      <Text style={[styles.mainEmptyCopy, centered && styles.mainEmptyTextCentered]}>{copy}</Text>
      {children}
    </View>
  );
}

/**
 * 远端列表首同步延迟 loading 出现阈值:正常 1-2s 内完成的首同步保持原"干净空白"
 * 不闪指示;只有同步被慢链路 / 连接翻覆拖长时才浮现。
 */
const REMOTE_LIST_SYNCING_DELAY_MS = 800;

/**
 * 远端列表(设备会话列表 / 自动化列表)首同步窗口的占位:前 REMOTE_LIST_SYNCING_DELAY_MS
 * 渲染空白(快同步不闪,与"首同步前不画错误空状态"的既有设计一致),超过阈值仍未
 * 同步完成则显示「正在同步」指示——替代无限期纯白。背景:连接翻覆时首同步可能被拖到
 * 10-30s,此前用户只能对着全白列表干等,无从判断是卡死还是在等数据。
 */
export function RemoteListSyncingPlaceholder({ testID }: { testID?: string }) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), REMOTE_LIST_SYNCING_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
  if (!visible) return null;
  return (
    <View style={styles.remoteSyncingPlaceholder} testID={testID}>
      <ActivityIndicator color={colors.textTertiary} size="small" />
      <Text style={styles.remoteSyncingText}>{t('shared.syncing')}</Text>
    </View>
  );
}

export function MainWindowActionButton({
  action,
  density = 'default',
  grow = false,
  style,
}: {
  action: MainWindowAction;
  density?: MainWindowActionDensity;
  grow?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const tone = action.tone ?? 'secondary';
  const compact = density === 'compact';
  const disabled = action.disabled || action.busy || !action.onPress;
  return (
    <Pressable
      accessibilityLabel={action.accessibilityLabel ?? action.label}
      accessibilityRole="button"
      accessibilityState={{
        busy: action.busy || undefined,
        disabled,
        selected: action.active || undefined,
      }}
      disabled={disabled}
      onPress={disabled ? undefined : action.onPress}
      style={({ pressed }) => [
        styles.mainActionButton,
        compact && styles.mainActionButtonCompact,
        grow && styles.mainActionButtonGrow,
        action.active && tone === 'secondary' && styles.mainActionButtonActive,
        tone === 'primary' && styles.mainActionButtonPrimary,
        tone === 'danger' && styles.mainActionButtonDanger,
        pressed && styles.pressed,
        disabled && styles.disabled,
        style,
      ]}
      testID={action.testID}
    >
      {action.busy ? (
        <ActivityIndicator color={tone === 'primary' ? colors.ctaText : colors.textSecondary} size="small" />
      ) : (
        <Text
          numberOfLines={1}
          style={[
            styles.mainActionButtonText,
            compact && styles.mainActionButtonTextCompact,
            tone === 'primary' && styles.mainActionButtonPrimaryText,
            tone === 'danger' && styles.mainActionButtonDangerText,
          ]}
        >
          {action.label}
        </Text>
      )}
    </Pressable>
  );
}

export function MainWindowActionGroup({
  cancelAction,
  dangerActions = [],
  density = 'default',
  growActions = true,
  primaryActions = [],
  secondaryActions = [],
  testID,
}: {
  cancelAction?: MainWindowAction;
  dangerActions?: readonly MainWindowAction[];
  density?: MainWindowActionDensity;
  growActions?: boolean;
  primaryActions?: readonly MainWindowAction[];
  secondaryActions?: readonly MainWindowAction[];
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.mainActionGroup} testID={testID}>
      {primaryActions.length > 0 ? (
        <View style={styles.mainActionPrimaryRow}>
          {primaryActions.map((action) => (
            <MainWindowActionButton action={action} density={density} grow={growActions} key={action.testID ?? action.label} />
          ))}
        </View>
      ) : null}
      {secondaryActions.length > 0 ? (
        <View style={styles.mainActionSecondaryRow}>
          {secondaryActions.map((action) => (
            <MainWindowActionButton action={action} density={density} grow={growActions} key={action.testID ?? action.label} />
          ))}
        </View>
      ) : null}
      {dangerActions.length > 0 ? (
        <View style={styles.mainActionDangerRow}>
          {dangerActions.map((action) => (
            <MainWindowActionButton action={action} density={density} grow={growActions} key={action.testID ?? action.label} />
          ))}
        </View>
      ) : null}
      {/* 次序固定 primary→secondary→danger→cancel:取消永远最底;无取消时破坏性动作居底(iOS 惯例)。
          确认对的取消必须走 cancelAction,不要塞 secondaryActions。 */}
      {cancelAction ? (
        <View style={styles.mainActionSecondaryRow}>
          <MainWindowActionButton action={cancelAction} density={density} grow={growActions} />
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  screenHeader: {
    alignItems: 'center',
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 72,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  screenHeaderCompact: {
    minHeight: 58,
    paddingVertical: spacing.xs,
  },
  backButton: {
    alignItems: 'center',
    borderRadius: radius.pill,
    height: 44,
    justifyContent: 'center',
    marginLeft: -spacing.sm,
    width: 44,
  },
  backButtonCompact: {
    height: 36,
    width: 36,
  },
  headerText: {
    flex: 1,
    minWidth: 0,
  },
  eyebrow: {
    color: colors.textTertiary,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
    textTransform: 'uppercase',
  },
  headerTitle: {
    color: colors.textPrimary,
    fontSize: typeScale.title,
    fontWeight: fontWeight.medium,
  },
  headerTitleCompact: {
    fontSize: typeScale.subtitle,
  },
  headerSubtitle: {
    color: colors.textSecondary,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
    marginTop: 2,
  },
  headerActionButton: {
    flexShrink: 0,
    minWidth: 64,
  },
  actionPill: {
    alignItems: 'center',
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
    minHeight: 38,
    minWidth: 0,
    paddingHorizontal: spacing.md,
  },
  actionPillActive: {
    backgroundColor: colors.surfaceChip,
    borderColor: colors.borderStrong,
  },
  actionPillText: {
    color: colors.textPrimary,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
  },
  infoPill: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
    minHeight: 26,
    paddingHorizontal: spacing.sm,
  },
  infoPillStrong: {
    borderColor: colors.borderStrong,
  },
  infoPillPrimary: {
    backgroundColor: colors.cta,
    borderColor: colors.cta,
  },
  infoPillAttention: {
    backgroundColor: colors.cta,
    borderColor: colors.cta,
    minHeight: 32,
    paddingHorizontal: spacing.md,
  },
  infoPillText: {
    color: colors.textSecondary,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
  },
  infoPillTextStrong: {
    color: colors.textPrimary,
  },
  infoPillTextInverted: {
    color: colors.ctaText,
  },
  pressed: {
    opacity: 0.72,
  },
  disabled: {
    opacity: 0.45,
  },
  mainOptionButton: {
    alignItems: 'center',
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
    minHeight: 36,
    paddingHorizontal: spacing.lg,
  },
  mainOptionButtonCompact: {
    minHeight: 32,
    paddingHorizontal: spacing.md,
  },
  mainOptionButtonSegmented: {
    borderWidth: 0,
    minWidth: 58,
  },
  mainOptionButtonSelected: {
    backgroundColor: colors.cta,
    borderColor: colors.cta,
  },
  mainOptionButtonText: {
    color: colors.textSecondary,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
  },
  mainOptionButtonTextSelected: {
    color: colors.ctaText,
  },
  mainRowButton: {
    alignItems: 'center',
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    width: '100%',
  },
  mainRowButtonSelected: {
    backgroundColor: colors.surfaceElevated,
  },
  mainRowButtonSelectedPrimary: {
    backgroundColor: colors.cta,
  },
  mainCardButton: {
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
  },
  mainCardButtonSelected: {
    backgroundColor: colors.surfaceChip,
    borderColor: colors.borderStrong,
  },
  statusDot: {
    borderRadius: radius.pill,
    height: 8,
    width: 8,
  },
  statusDotReady: {
    backgroundColor: colors.statusReady,
  },
  statusDotBusy: {
    backgroundColor: colors.textSecondary,
  },
  statusDotMuted: {
    backgroundColor: colors.borderStrong,
  },
  statusDotOff: {
    backgroundColor: colors.border,
  },
  statusDotPulsing: {
    opacity: 0.72,
  },
  summaryStrip: {
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  mainMetric: {
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
  },
  mainMetricTile: {
    backgroundColor: colors.surfaceElevated,
    borderRadius: radius.container,
    flex: 1,
    gap: 2,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  mainMetricPill: {
    alignItems: 'baseline',
    borderRadius: radius.pill,
    flexDirection: 'row',
    flexGrow: 1,
    gap: spacing.xs,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  mainMetricHighlighted: {
    backgroundColor: colors.cta,
    borderColor: colors.cta,
  },
  mainMetricValue: {
    color: colors.textPrimary,
    fontSize: typeScale.body,
    fontWeight: fontWeight.medium,
    lineHeight: lineHeight.body,
  },
  mainMetricValueLarge: {
    fontSize: typeScale.headline,
    lineHeight: lineHeight.headline,
  },
  mainMetricLabel: {
    color: colors.textSecondary,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
  },
  mainMetricTextInverted: {
    color: colors.ctaText,
  },
  mainEmptyState: {
    alignItems: 'flex-start',
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
  },
  mainEmptyStateCentered: {
    alignItems: 'center',
  },
  mainEmptyStateDashed: {
    borderStyle: 'dashed',
  },
  mainEmptyTitle: {
    color: colors.textPrimary,
    fontSize: typeScale.body,
    fontWeight: fontWeight.medium,
  },
  mainEmptyCopy: {
    color: colors.textSecondary,
    fontSize: typeScale.body,
    lineHeight: lineHeight.body,
  },
  mainEmptyTextCentered: {
    textAlign: 'center',
  },
  remoteSyncingPlaceholder: {
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xxl,
  },
  remoteSyncingText: {
    color: colors.textTertiary,
    fontSize: typeScale.body,
  },
  mainActionGroup: {
    gap: spacing.sm,
  },
  mainActionPrimaryRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  mainActionSecondaryRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  mainActionDangerRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  mainActionButton: {
    alignItems: 'center',
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
    minHeight: 44,
    minWidth: 112,
    paddingHorizontal: spacing.lg,
  },
  mainActionButtonCompact: {
    minHeight: 38,
    minWidth: 72,
    paddingHorizontal: spacing.md,
  },
  mainActionButtonGrow: {
    flex: 1,
  },
  mainActionButtonActive: {
    backgroundColor: colors.surfaceChip,
  },
  mainActionButtonPrimary: {
    backgroundColor: colors.cta,
    borderColor: colors.cta,
  },
  mainActionButtonDanger: {
    borderColor: colors.errorBorder,
  },
  mainActionButtonText: {
    color: colors.textPrimary,
    fontSize: typeScale.body,
    fontWeight: fontWeight.medium,
  },
  mainActionButtonTextCompact: {
    fontSize: typeScale.caption,
  },
  mainActionButtonPrimaryText: {
    color: colors.ctaText,
  },
  mainActionButtonDangerText: {
    color: colors.destructive,
  },
});
