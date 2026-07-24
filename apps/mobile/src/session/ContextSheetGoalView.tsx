/**
 * Context 面板的「目标模式」二级视图(对照设计稿 S3)。
 *
 * 两态:
 *  - 无 goal → 新建表单:目标文案 + 三项限制(留空 = 不限)+「开始目标」。
 *  - 有 goal → 状态视图:状态 chip + 目标文案 + 轮数/token 进度 + 暂停/继续/终止。
 *
 * goal 状态机在被控端 GoalController 执行;这里只发隧道指令(maker:goal:*)并渲染
 * remoteSessionStore 镜像的状态投影。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight } from 'lucide-react-native';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { Text, TextInput } from '@/components/AppText';
import type {
  MobileGoalLimitsInput,
  MobileGoalStatus,
  MobileGoalStatusPayload,
} from '@cindy/maker-shared/device-link-contract';
import { i18n } from '@/i18n';
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

/**
 * 状态标签映射。值用 getter 惰性求值(i18n.t 在访问时调用,不冻结语言),
 * 既保留 `GOAL_STATUS_LABEL[status]` 索引用法给外部调用方,又跟随语言切换。
 */
export const GOAL_STATUS_LABEL: Record<MobileGoalStatus, string> = {
  get active() { return i18n.t('interaction.contextSheet.goalStatus.active'); },
  get paused() { return i18n.t('interaction.contextSheet.goalStatus.paused'); },
  get blocked() { return i18n.t('interaction.contextSheet.goalStatus.blocked'); },
  get complete() { return i18n.t('interaction.contextSheet.goalStatus.complete'); },
  get budgetLimited() { return i18n.t('interaction.contextSheet.goalStatus.budgetLimited'); },
  get usageLimited() { return i18n.t('interaction.contextSheet.goalStatus.usageLimited'); },
};

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
      initial={initialObjective ? { objective: initialObjective } : undefined}
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
  error,
  onSetGoal,
  testID,
  initial,
}: Pick<ContextSheetGoalViewProps, 'busy' | 'error' | 'onSetGoal' | 'testID'> & {
  /** 表单初始值(objective 通常来自 composer 已有文字)。 */
  initial?: { objective: string; limits?: MobileGoalLimitsInput };
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
    if (!trimmed || busy) return;
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
        placeholderTextColor={colors.textTertiary}
        style={styles.objectiveInput}
        testID="contextSheet.goalObjectiveInput"
        value={objective}
      />
      <Pressable
        accessibilityLabel={t('interaction.contextSheet.advancedSettings')}
        accessibilityRole="button"
        accessibilityState={{ expanded: advancedOpen }}
        onPress={() => setAdvancedOpen((open) => !open)}
        style={({ pressed }) => [styles.advancedToggle, pressed && styles.pressed]}
        testID="contextSheet.goalAdvancedToggle"
      >
        {advancedOpen
          ? <ChevronDown color={colors.textSecondary} size={iconSize.md} strokeWidth={iconStroke.regular} />
          : <ChevronRight color={colors.textSecondary} size={iconSize.md} strokeWidth={iconStroke.regular} />}
        <Text style={styles.advancedToggleText}>{t('interaction.contextSheet.advancedSettings')}</Text>
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
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
      <Pressable
        accessibilityLabel={t('interaction.contextSheet.startGoal')}
        accessibilityRole="button"
        accessibilityState={{ disabled: busy || !objective.trim() }}
        disabled={busy || !objective.trim()}
        onPress={submit}
        style={({ pressed }) => [
          styles.ctaButton,
          (busy || !objective.trim()) && styles.ctaButtonDisabled,
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
  return (
    <View testID={testID}>
      <View style={styles.statusHeader}>
        <View style={[styles.statusChip, goal.status === 'active' && styles.statusChipActive]}>
          <Text style={[styles.statusChipText, goal.status === 'active' && styles.statusChipTextActive]}>
            {GOAL_STATUS_LABEL[goal.status]}
          </Text>
        </View>
        <Text style={styles.statusMeta}>
          {t('interaction.contextSheet.goalMeta', { turns: turnsText, tokens: tokensText })}
        </Text>
      </View>
      <Text style={styles.objectiveText} testID="contextSheet.goalObjectiveText">{goal.objective}</Text>
      {goal.lastReason ? <Text style={styles.hintText}>{goal.lastReason}</Text> : null}
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
      <View style={styles.actionRow}>
        {canPause ? (
          <GoalActionButton busy={busy} label={t('interaction.contextSheet.pause')} onPress={onPauseGoal} testID="contextSheet.goalPauseButton" />
        ) : null}
        {canResume ? (
          <GoalActionButton busy={busy} label={t('interaction.contextSheet.resume')} onPress={onResumeGoal} testID="contextSheet.goalResumeButton" />
        ) : null}
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
      style={({ pressed }) => [styles.actionButton, pressed && styles.pressed, busy && styles.ctaButtonDisabled]}
      testID={testID}
    >
      <Text style={[styles.actionButtonText, textColor ? { color: textColor } : null]}>{label}</Text>
    </Pressable>
  );
}

/**
 * 单项上限的 pill 单选组(预设 + 「不限」)。手机端用 pill 组替代桌面的下拉——
 * bottom sheet 里嵌套下拉手感差;当前值不在预设里(历史自定义)时前置保留(对齐桌面)。
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
  const { t } = useTranslation();
  const options = value != null && !presets.includes(value) ? [value, ...presets] : presets;
  return (
    <View style={styles.limitOptionsRow} testID={testID}>
      <Text style={styles.limitLabel}>{label}</Text>
      <View style={styles.limitPillRow}>
        {options.map((preset) => (
          <LimitPill
            disabled={disabled}
            key={preset}
            label={format(preset)}
            onPress={() => onSelect(preset)}
            selected={value === preset}
          />
        ))}
        <LimitPill
          disabled={disabled}
          label={t('interaction.contextSheet.unlimited')}
          onPress={() => onSelect(null)}
          selected={value === null}
        />
      </View>
    </View>
  );
}

function LimitPill({
  label,
  selected,
  onPress,
  disabled,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  disabled?: boolean;
}) {
  const styles = useThemedStyles(makeGoalStyles);
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.limitPill,
        selected && styles.limitPillSelected,
        pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.limitPillText, selected && styles.limitPillTextSelected]}>{label}</Text>
    </Pressable>
  );
}


function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

function makeGoalStyles(colors: ThemeColors) {
  return {
    groupLabel: {
      color: colors.textTertiary,
      fontSize: typeScale.footnote,
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
    advancedToggle: {
      alignItems: 'center' as const,
      flexDirection: 'row' as const,
      gap: spacing.xs,
      paddingTop: spacing.lg,
    },
    advancedToggleText: {
      color: colors.textSecondary,
      fontSize: typeScale.footnote,
      fontWeight: fontWeight.medium,
    },
    limitOptionsRow: {
      paddingTop: spacing.lg,
    },
    limitLabel: {
      color: colors.textPrimary,
      fontSize: typeScale.footnote,
      fontWeight: fontWeight.medium,
    },
    limitPillRow: {
      flexDirection: 'row' as const,
      flexWrap: 'wrap' as const,
      gap: spacing.sm,
      paddingTop: spacing.sm,
    },
    limitPill: {
      alignItems: 'center' as const,
      backgroundColor: colors.surfaceChip,
      borderRadius: radius.pill,
      height: 30,
      justifyContent: 'center' as const,
      paddingHorizontal: spacing.md,
    },
    limitPillSelected: {
      backgroundColor: colors.cta,
    },
    limitPillText: {
      color: colors.textPrimary,
      fontSize: typeScale.footnote,
      fontWeight: fontWeight.medium,
    },
    limitPillTextSelected: {
      color: colors.ctaText,
    },
    hintText: {
      color: colors.textTertiary,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      paddingTop: spacing.md,
    },
    errorText: {
      color: colors.errorText,
      fontSize: typeScale.footnote,
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
      fontWeight: fontWeight.semibold,
    },
    pressed: {
      opacity: 0.7,
    },
    statusHeader: {
      alignItems: 'center' as const,
      flexDirection: 'row' as const,
      gap: spacing.md,
      paddingTop: spacing.lg,
    },
    statusChip: {
      backgroundColor: colors.surfaceChip,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.md,
      paddingVertical: 4,
    },
    statusChipActive: {
      backgroundColor: colors.cta,
    },
    statusChipText: {
      color: colors.textPrimary,
      fontSize: typeScale.caption,
      fontWeight: fontWeight.medium,
    },
    statusChipTextActive: {
      color: colors.ctaText,
    },
    statusMeta: {
      color: colors.textTertiary,
      fontSize: typeScale.caption,
    },
    objectiveText: {
      color: colors.textPrimary,
      fontSize: typeScale.body,
      lineHeight: lineHeight.body,
      paddingTop: spacing.md,
    },
    actionRow: {
      flexDirection: 'row' as const,
      gap: spacing.md,
      paddingTop: spacing.xl,
    },
    actionButton: {
      alignItems: 'center' as const,
      backgroundColor: colors.surfaceChip,
      borderRadius: radius.pill,
      flex: 1,
      height: 44,
      justifyContent: 'center' as const,
    },
    actionButtonText: {
      color: colors.textPrimary,
      fontSize: typeScale.footnote,
      fontWeight: fontWeight.medium,
    },
  };
}
