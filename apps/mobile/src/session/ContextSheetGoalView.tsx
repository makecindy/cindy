/**
 * Context 面板的「目标模式」二级视图(对照设计稿 S3)。
 *
 * 两态(交互与 ContextSheetGoalView.ios.tsx 同构,外观保持 Android RN 自绘):
 *  - 无 goal → 新建表单:目标文案 +「高级设置」折叠(默认收起;展开后是说明 + 三项上限下拉,
 *    NativePullDownMenu,包里没有 MenuView 时退回行内选项)+「开始目标」。
 *  - 有 goal → 状态视图:状态分组标题 → 目标文案 → 轮数/token 进度 → 原因;
 *    操作行竖排:暂停 / 继续 → 终止(危险色)。
 *
 * goal 状态机在被控端 GoalController 执行;这里只发隧道指令(maker:goal:*)并渲染
 * remoteSessionStore 镜像的状态投影。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, ChevronRight, ChevronsUpDown } from 'lucide-react-native';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { Text, TextInput } from '@/components/AppText';
import { NativePullDownMenu, usesNativePullDownMenu } from '@/platform/chrome';
import { mobileInteractionStyles } from '@/components/mobileInteractionStyles';
import type {
  MobileGoalLimitsInput,
  MobileGoalStatus,
  MobileGoalStatusPayload,
} from '@cindy/maker-shared/device-link-contract';
import { GOAL_STATUS_LABEL, goalReasonText, goalStatusLabel } from '@/session/goalStatusLabel';
import { fontWeight, iconSize, iconStroke, lineHeight, radius, spacing, typeScale, useTheme, useThemedStyles, type ThemeColors } from '@/theme';

/** 三项上限的推荐预设(与桌面 GoalAdvancedLimits 一致,2026-06 与用户确认)。 */
const MAX_TURNS_PRESETS = [10, 20, 50, 100];
const BUDGET_PRESETS = [500_000, 1_000_000, 2_000_000, 5_000_000];
const NO_PROGRESS_PRESETS = [2, 3, 5];

/** 系统默认上限(与桌面 DEFAULT_GOAL_LIMITS / main goal-settings-store 一致):
 *  轮数与预算不限,无进展上限 3。 */
const DEFAULT_GOAL_LIMITS: MobileGoalLimitsInput = {
  budgetTokens: null,
  maxTurns: null,
  noProgressLimit: 3,
};

/** token 预设的紧凑标签:500000→500K、1000000→1M(对齐桌面)。 */
function formatTokenPreset(n: number): string {
  if (n % 1_000_000 === 0) return `${n / 1_000_000}M`;
  if (n % 1000 === 0) return `${n / 1000}K`;
  return String(n);
}

// 状态标签映射与 reason 文案的纯逻辑住在 goalStatusLabel.ts(组件文件会拉进
// react-native, 单测跑不起来; 那边有完整注释与用例)。这里 re-export 保持既有 import
// 路径可用 —— 渲染一律走 goalStatusLabel(status, lastReason), 不按状态直取映射表:
// 过载退避与账号限流共用 usageLimited, 直取会重新显示成「用量受限」(review #844)。
export { GOAL_STATUS_LABEL, goalReasonText, goalStatusLabel };

export interface ContextSheetGoalViewProps {
  /** undefined = 状态尚未拉取(unknown);此时仍渲染新建表单,覆盖保护在提交端补查。 */
  goal: MobileGoalStatusPayload | null | undefined;
  busy: boolean;
  error: string | null;
  onSetGoal: (input: { objective: string; limits?: MobileGoalLimitsInput }) => void;
  onPauseGoal: () => void;
  onResumeGoal: () => void;
  onClearGoal: () => void;
  /** 打开表单时的默认目标内容(对齐桌面 NewGoalDialog:composer 里已有的文字带入)。 */
  initialObjective?: string;
  /**
   * 失败接回时的完整表单初始值(codex review P2):新建页 goal.set 失败跳转时经
   * 路由参数带入 objective + limits;优先于 initialObjective(后者仅 composer 文字,
   * 带不回 limits)。平时 undefined → 走 initialObjective / 空表单,与旧行为一致。
   */
  initial?: { objective: string; limits?: MobileGoalLimitsInput };
  testID?: string;
}

export function ContextSheetGoalView({
  goal,
  busy,
  error,
  onSetGoal,
  onPauseGoal,
  onResumeGoal,
  onClearGoal,
  initialObjective,
  initial,
  testID,
}: ContextSheetGoalViewProps) {
  return goal ? (
    <GoalStatusView
      busy={busy}
      error={error}
      goal={goal}
      onClearGoal={onClearGoal}
      onPauseGoal={onPauseGoal}
      onResumeGoal={onResumeGoal}
      testID={testID}
    />
  ) : (
    <ContextSheetGoalCreateForm
      busy={busy}
      error={error}
      initial={initial ?? (initialObjective ? { objective: initialObjective } : undefined)}
      onSetGoal={onSetGoal}
      testID={testID}
    />
  );
}

/**
 * 目标新建表单(会话页 goal=null 分支 / 新建会话页直接复用)。
 * 提交即开始:onSetGoal 走 goal.set(被控端落目标消息并自动开跑第一轮)。
 */
export function ContextSheetGoalCreateForm({
  busy,
  disabled = false,
  disabledHint,
  error,
  onSetGoal,
  testID,
  initial,
}: Pick<ContextSheetGoalViewProps, 'busy' | 'error' | 'onSetGoal' | 'testID'> & {
  /** 表单初始值(objective 通常来自 composer 已有文字)。 */
  initial?: { objective: string; limits?: MobileGoalLimitsInput };
  /** 外层创建合同尚未就绪时只禁用提交，目标草稿仍可编辑。 */
  disabled?: boolean;
  disabledHint?: string;
}) {
  const styles = useThemedStyles(makeGoalStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const [objective, setObjective] = useState(initial?.objective ?? '');
  const [limits, setLimits] = useState<MobileGoalLimitsInput>(initial?.limits ?? DEFAULT_GOAL_LIMITS);
  // 规则 20:只有用户显式改过上限才回传 limits;从未改动 → 省略,让被控端
  // GoalController 走 getDefaults()(系统默认 + 用户 override),避免把本地
  // 推荐值快照成 override(被控端改过默认/系统默认演进时手机建的目标能跟上)。
  const [limitsTouched, setLimitsTouched] = useState(initial?.limits != null);
  // 「高级设置」默认收起(对齐桌面 GoalAdvancedLimits)。
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const patchLimits = (patch: Partial<MobileGoalLimitsInput>) => {
    setLimitsTouched(true);
    setLimits((current) => ({ ...current, ...patch }));
  };

  const submit = () => {
    const trimmed = objective.trim();
    if (!trimmed || busy || disabled) return;
    onSetGoal({ objective: trimmed, ...(limitsTouched ? { limits } : {}) });
  };

  return (
    <View testID={testID}>
      <Text style={styles.groupLabel}>{t('interaction.contextSheet.goalLabel')}</Text>
      <TextInput
        accessibilityLabel={t('interaction.contextSheet.goalObjectiveAccessibility')}
        editable={!busy}
        multiline
        onChangeText={setObjective}
        placeholder={t('interaction.contextSheet.goalPlaceholder')}
        placeholderTextColor={colors.textPlaceholder}
        style={styles.objectiveInput}
        testID="contextSheet.goalObjectiveInput"
        value={objective}
      />
      {/* 与 iOS DisclosureGroup 同构:整行可点,标题在左、展开指示在右。 */}
      <Pressable
        accessibilityLabel={t('interaction.contextSheet.advancedSettings')}
        accessibilityRole="button"
        accessibilityState={{ expanded: advancedOpen }}
        onPress={() => setAdvancedOpen((open) => !open)}
        style={({ pressed }) => [styles.advancedToggle, pressed && styles.pressed]}
        testID="contextSheet.goalAdvancedToggle"
      >
        <Text style={styles.advancedToggleText}>{t('interaction.contextSheet.advancedSettings')}</Text>
        {advancedOpen
          ? <ChevronDown color={colors.textTertiary} size={iconSize.md} strokeWidth={iconStroke.regular} />
          : <ChevronRight color={colors.textTertiary} size={iconSize.md} strokeWidth={iconStroke.regular} />}
      </Pressable>
      {advancedOpen ? (
        <>
          <Text style={styles.hintText}>{t('interaction.contextSheet.limitsHint')}</Text>
          <LimitOptionsRow
            disabled={busy}
            format={(n) => String(n)}
            label={t('interaction.contextSheet.maxTurns')}
            onSelect={(next) => patchLimits({ maxTurns: next })}
            presets={MAX_TURNS_PRESETS}
            testID="contextSheet.goalMaxTurnsOptions"
            value={limits.maxTurns}
          />
          <LimitOptionsRow
            disabled={busy}
            format={formatTokenPreset}
            label={t('interaction.contextSheet.tokenBudget')}
            onSelect={(next) => patchLimits({ budgetTokens: next })}
            presets={BUDGET_PRESETS}
            testID="contextSheet.goalBudgetOptions"
            value={limits.budgetTokens}
          />
          <LimitOptionsRow
            disabled={busy}
            format={(n) => String(n)}
            label={t('interaction.contextSheet.noProgressLimit')}
            onSelect={(next) => patchLimits({ noProgressLimit: next })}
            presets={NO_PROGRESS_PRESETS}
            testID="contextSheet.goalNoProgressOptions"
            value={limits.noProgressLimit}
          />
        </>
      ) : null}
      {error ? (
        <Text style={styles.errorText}>{error}</Text>
      ) : disabled && disabledHint ? (
        <Text style={styles.hintText} testID="contextSheet.goalDisabledHint">{disabledHint}</Text>
      ) : null}
      <Pressable
        accessibilityHint={disabled ? disabledHint : undefined}
        accessibilityLabel={t('interaction.contextSheet.startGoal')}
        accessibilityRole="button"
        accessibilityState={{ disabled: busy || disabled || !objective.trim() }}
        disabled={busy || disabled || !objective.trim()}
        onPress={submit}
        style={({ pressed }) => [
          styles.ctaButton,
          (busy || disabled || !objective.trim()) && styles.ctaButtonDisabled,
          pressed && styles.pressed,
        ]}
        testID="contextSheet.goalStartButton"
      >
        {busy ? (
          <ActivityIndicator color={colors.ctaText} size="small" />
        ) : (
          <Text style={styles.ctaLabel}>{t('interaction.contextSheet.startGoal')}</Text>
        )}
      </Pressable>
    </View>
  );
}

function GoalStatusView({
  busy,
  error,
  goal,
  onClearGoal,
  onPauseGoal,
  onResumeGoal,
  testID,
}: {
  busy: boolean;
  error: string | null;
  goal: MobileGoalStatusPayload;
  onClearGoal: () => void;
  onPauseGoal: () => void;
  onResumeGoal: () => void;
  testID?: string;
}) {
  const styles = useThemedStyles(makeGoalStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const canPause = goal.status === 'active';
  const canResume = goal.status === 'paused' || goal.status === 'blocked' || goal.status === 'usageLimited';
  const turnsText = `${goal.turnsUsed}${goal.maxTurns !== null ? ` / ${goal.maxTurns}` : ''}`;
  const tokensText = `${formatTokens(goal.tokensUsed)}${goal.budgetTokens !== null ? ` / ${formatTokens(goal.budgetTokens)}` : ''}`;
  // 只取一次: 这里原本直接用 goal.lastReason(取值免费), 换成函数后条件与正文各调一次
  // 属于无谓重复(copilot 低置信提示)。
  const reasonText = goalReasonText(goal.lastReason);
  return (
    <View testID={testID}>
      <Text style={styles.groupLabel} testID="contextSheet.goalStatusLabel">
        {goalStatusLabel(goal.status, goal.lastReason)}
      </Text>
      <Text style={styles.objectiveText} testID="contextSheet.goalObjectiveText">{goal.objective}</Text>
      <Text style={styles.statusMeta}>
        {t('interaction.contextSheet.goalMeta', { turns: turnsText, tokens: tokensText })}
      </Text>
      {reasonText ? <Text style={styles.hintText}>{reasonText}</Text> : null}
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
      <View style={styles.actionGroup}>
        {canPause ? (
          <GoalActionButton busy={busy} label={t('interaction.contextSheet.pause')} onPress={onPauseGoal} testID="contextSheet.goalPauseButton" />
        ) : null}
        {canResume ? (
          <GoalActionButton busy={busy} label={t('interaction.contextSheet.resume')} onPress={onResumeGoal} testID="contextSheet.goalResumeButton" />
        ) : null}
        {canPause || canResume ? <View style={styles.separator} /> : null}
        <GoalActionButton
          busy={busy}
          label={t('interaction.contextSheet.clearGoal')}
          onPress={onClearGoal}
          testID="contextSheet.goalClearButton"
          textColor={colors.statusRecording}
        />
      </View>
    </View>
  );
}

function GoalActionButton({
  busy,
  label,
  onPress,
  testID,
  textColor,
}: {
  busy: boolean;
  label: string;
  onPress: () => void;
  testID?: string;
  textColor?: string;
}) {
  const styles = useThemedStyles(makeGoalStyles);
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled: busy }}
      disabled={busy}
      onPress={onPress}
      style={({ pressed }) => [styles.actionRow, pressed && styles.pressed, busy && styles.ctaButtonDisabled]}
      testID={testID}
    >
      <Text style={[styles.actionRowText, textColor ? { color: textColor } : null]}>{label}</Text>
    </Pressable>
  );
}

/**
 * 单项上限的下拉选择(预设 + 「不限」),与 iOS Picker(menu) 同构:整行显示「名称 … 当前值」,
 * 点开是系统下拉菜单(NativePullDownMenu);包里没有 MenuView 时退回行内展开的单选行。
 * 当前值不在预设里(历史自定义)时前置保留(对齐桌面)。
 */
function LimitOptionsRow({
  label,
  presets,
  value,
  onSelect,
  format,
  disabled,
  testID,
}: {
  label: string;
  presets: number[];
  value: number | null;
  onSelect: (value: number | null) => void;
  format: (n: number) => string;
  disabled?: boolean;
  testID?: string;
}) {
  const styles = useThemedStyles(makeGoalStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const nativeMenu = usesNativePullDownMenu();
  const options = value != null && !presets.includes(value) ? [value, ...presets] : presets;
  const unlimited = t('interaction.contextSheet.unlimited');
  const currentLabel = value === null ? unlimited : format(value);
  const choose = (id: string) => {
    if (disabled) return;
    if (id === 'unlimited') onSelect(null);
    else {
      const next = Number(id);
      if (options.includes(next)) onSelect(next);
    }
    setExpanded(false);
  };
  const choices = [
    ...options.map((option) => ({ id: String(option), title: format(option), selected: value === option })),
    { id: 'unlimited', title: unlimited, selected: value === null },
  ];
  return (
    <View testID={testID}>
      <NativePullDownMenu
        disabled={disabled}
        actions={choices.map((choice) => ({
          id: choice.id,
          title: choice.title,
          state: choice.selected ? 'on' : 'off',
          disabled,
        }))}
        onAction={choose}
        testID={`${testID}.menu`}
      >
        <Pressable
          accessibilityLabel={`${label}, ${currentLabel}`}
          accessibilityRole="button"
          accessibilityState={{ disabled: !!disabled, expanded: nativeMenu ? undefined : expanded }}
          disabled={disabled}
          onPress={() => {
            if (!nativeMenu) setExpanded((open) => !open);
          }}
          style={({ pressed }) => [styles.limitRow, disabled && styles.ctaButtonDisabled, pressed && styles.pressed]}
          testID={`${testID}.trigger`}
        >
          <Text numberOfLines={1} style={styles.limitLabel}>{label}</Text>
          <Text numberOfLines={1} style={styles.limitValue}>{currentLabel}</Text>
          <ChevronsUpDown color={colors.textTertiary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
        </Pressable>
      </NativePullDownMenu>
      {!nativeMenu && expanded
        ? choices.map((choice) => (
            <Pressable
              accessibilityLabel={choice.title}
              accessibilityRole="button"
              accessibilityState={{ disabled: !!disabled, selected: choice.selected }}
              disabled={disabled}
              key={choice.id}
              onPress={() => choose(choice.id)}
              style={({ pressed }) => [styles.limitChoice, pressed && styles.pressed]}
              testID={`${testID}.option.${choice.id}`}
            >
              <Text numberOfLines={1} style={styles.limitChoiceText}>{choice.title}</Text>
              {choice.selected ? (
                <Check color={colors.textPrimary} size={iconSize.md} strokeWidth={iconStroke.medium} />
              ) : null}
            </Pressable>
          ))
        : null}
    </View>
  );
}

/** 与 iOS 同口径的进度数字:1.0M 写作 1M、千位用大写 K。 */
function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

function makeGoalStyles(colors: ThemeColors) {
  return {
    groupLabel: {
      color: colors.textTertiary,
      fontSize: typeScale.footnote,
      fontWeight: fontWeight.semibold,
      lineHeight: lineHeight.caption,
      paddingTop: spacing.lg,
    },
    objectiveInput: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: radius.container,
      borderWidth: StyleSheet.hairlineWidth,
      color: colors.textPrimary,
      fontSize: typeScale.body,
      lineHeight: lineHeight.body,
      marginTop: spacing.sm,
      minHeight: 120,
      padding: spacing.md + 2,
      textAlignVertical: 'top' as const,
    },
    // 「高级设置」折叠行:整行 44pt 可点,标题在左、展开指示在右(对齐 iOS DisclosureGroup)。
    advancedToggle: {
      alignItems: 'center' as const,
      flexDirection: 'row' as const,
      gap: spacing.sm,
      justifyContent: 'space-between' as const,
      marginTop: spacing.md,
      minHeight: 44,
    },
    advancedToggleText: {
      color: colors.textPrimary,
      flex: 1,
      fontSize: typeScale.body,
      lineHeight: lineHeight.body,
      fontWeight: fontWeight.medium,
    },
    limitRow: {
      alignItems: 'center' as const,
      flexDirection: 'row' as const,
      gap: spacing.sm,
      minHeight: 44,
    },
    limitLabel: {
      color: colors.textPrimary,
      flex: 1,
      fontSize: typeScale.body,
      lineHeight: lineHeight.body,
      fontWeight: fontWeight.medium,
    },
    limitValue: {
      color: colors.textSecondary,
      flexShrink: 1,
      fontSize: typeScale.body,
      lineHeight: lineHeight.body,
      fontWeight: fontWeight.regular,
    },
    limitChoice: {
      alignItems: 'center' as const,
      flexDirection: 'row' as const,
      gap: spacing.sm,
      minHeight: 44,
      paddingLeft: spacing.lg,
    },
    limitChoiceText: {
      color: colors.textPrimary,
      flex: 1,
      fontSize: typeScale.bodySmall,
      lineHeight: lineHeight.bodySmall,
      fontWeight: fontWeight.medium,
    },
    hintText: {
      color: colors.textSecondary,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      paddingTop: spacing.sm,
    },
    errorText: {
      color: colors.errorText,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      paddingTop: spacing.md,
    },
    ctaButton: {
      alignItems: 'center' as const,
      backgroundColor: colors.cta,
      borderRadius: radius.pill,
      height: 50,
      justifyContent: 'center' as const,
      marginTop: spacing.xl,
    },
    ctaButtonDisabled: {
      opacity: 0.4,
    },
    ctaLabel: {
      color: colors.ctaText,
      fontSize: typeScale.body,
      lineHeight: lineHeight.body,
      fontWeight: fontWeight.medium,
    },
    pressed: mobileInteractionStyles.pressed,
    statusMeta: {
      color: colors.textSecondary,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      fontWeight: fontWeight.regular,
      paddingTop: spacing.xs,
    },
    objectiveText: {
      color: colors.textPrimary,
      fontSize: typeScale.body,
      lineHeight: lineHeight.body,
      paddingTop: spacing.sm,
    },
    // 操作行竖排成一组(对齐 iOS 同一 Section 内的暂停/继续 → 终止),行间 hairline。
    actionGroup: {
      paddingTop: spacing.lg,
    },
    separator: {
      backgroundColor: colors.border,
      height: StyleSheet.hairlineWidth,
    },
    actionRow: {
      justifyContent: 'center' as const,
      minHeight: 44,
    },
    actionRowText: {
      color: colors.textPrimary,
      fontSize: typeScale.body,
      lineHeight: lineHeight.body,
      fontWeight: fontWeight.medium,
    },
  };
}
