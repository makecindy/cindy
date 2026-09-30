/**
 * 群聊里的分工（docs/product-rules/bot-group-chat.md §7，对照桌面 BotGroupPlan.tsx）：
 * 负责人的安排卡、交接消息下的文件、时间线末尾的「下一步 · 继续」「没做完 · 重试」与
 * 「N 步都做完了」。
 *
 * 安排卡一步一行（编号或状态、头像、名字 + 做什么），行间不画分隔线。只有群里未结束的
 * 那张卡能操作：待开始时点某一步换人或删掉，下面是小号「开始」「不用了」；做完一步停下时，
 * 还没做或没做完的步骤仍可换人。按钮是可见 38pt 的紧凑档，hitSlop 补到 44pt 热区。
 *
 * 交接文件在电脑的工作目录里，手机不打开，点一下说明去电脑上看。
 */
import type { ReactNode } from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';
import { CircleAlert, CircleCheck, CircleDashed, FileText, Sparkles } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { botGroupPathBasename, isActiveBotGroupMember, type BotGroupPlanFollowUp } from '@cindy/maker-shared/botGroupPresentation';
import type { BotGroupMemberView, BotGroupPlanStepView, BotGroupPlanView } from '@cindy/maker-shared/botGroupChat';
import { Text } from '@/components/AppText';
import { MainWindowActionButton } from '@/components/MobilePrimitives';
import { mobileInteractionStyles } from '@/components/mobileInteractionStyles';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, iconSize, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';
import {
  BOT_GROUP_INLINE_AVATAR_SIZE,
  BOT_GROUP_STEP_AVATAR_SIZE,
  BotGroupAvatar,
  type BotGroupIdentity,
} from './BotGroupAvatars';
import { BotGroupMenu, type BotGroupMenuSection } from './BotGroupMenu';

/** Compact actions are 38pt tall; this makes their touch target 44pt. */
export const BOT_GROUP_COMPACT_HIT_SLOP = { top: 4, bottom: 4, left: 4, right: 4 } as const;

export type BotGroupPlanCardAction = 'start' | 'dismiss' | 'edit';
export type BotGroupFollowUpAction = 'continue' | 'retry' | 'dismiss';
export type BotGroupIdentityLookup = (botId: string, fallbackName?: string) => BotGroupIdentity;

const REMOVE_STEP_ID = 'remove';

/** Small pill after the organizer's name (plan card and settings member rows). */
export function BotGroupOrganizerTag() {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  return <View style={styles.organizerBadge} testID="botGroup.organizerTag">
    <Text numberOfLines={1} style={styles.organizerBadgeText}>{t('groupChat.organizer')}</Text>
  </View>;
}

function started(plan: BotGroupPlanView): boolean {
  return plan.status !== 'proposed' && plan.status !== 'superseded' && plan.status !== 'dismissed';
}

/** 16pt leading mark: the step number before 开始, its live status afterwards. */
function StepLead({ plan, step, index }: { plan: BotGroupPlanView; step: BotGroupPlanStepView; index: number }) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  if (!started(plan)) return <Text style={styles.stepNumber}>{index + 1}</Text>;
  if (step.status === 'done') return <CircleCheck size={iconSize.md} color={colors.textSecondary} />;
  // Same running mark as the speaking row (Heart Orange).
  if (step.status === 'running') return <Sparkles size={iconSize.sm} color={colors.statusAccent} />;
  if (step.status === 'failed') return <CircleAlert size={iconSize.md} color={colors.errorText} />;
  return <CircleDashed size={iconSize.md} color={colors.textTertiary} />;
}

const STEP_STATUS_KEYS: Partial<Record<BotGroupPlanStepView['status'], string>> = {
  done: 'groupChat.plan.stepDone',
  running: 'groupChat.plan.stepRunning',
  failed: 'groupChat.plan.stepFailed',
};

function StepRowContent({ plan, step, index, identity, deviceId, online, muted }: {
  plan: BotGroupPlanView; step: BotGroupPlanStepView; index: number; identity: BotGroupIdentity;
  deviceId: string; online: boolean; muted: boolean;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const statusKey = started(plan) ? STEP_STATUS_KEYS[step.status] : undefined;
  return <>
    <View style={styles.stepLead}><StepLead plan={plan} step={step} index={index} /></View>
    <View style={muted ? styles.muted : undefined}>
      <BotGroupAvatar deviceId={deviceId} identity={identity} size={BOT_GROUP_STEP_AVATAR_SIZE} online={online} />
    </View>
    <Text numberOfLines={1} style={[styles.stepText, muted && styles.stepTextMuted]}>
      <Text style={[styles.stepName, muted && styles.stepTextMuted]}>{identity.name}</Text>
      {' '}{step.task}
    </Text>
    {statusKey ? <Text numberOfLines={1} style={styles.stepStatus}>{t(statusKey)}</Text> : null}
  </>;
}

function stepAccessibility(t: (key: string, options?: Record<string, unknown>) => string, plan: BotGroupPlanView,
  step: BotGroupPlanStepView, index: number, name: string): string {
  const status = started(plan)
    ? t(STEP_STATUS_KEYS[step.status] ?? 'groupChat.plan.stepPending')
    : `${index + 1}`;
  return [status, name, step.task].filter(Boolean).join(', ');
}

/**
 * Body of the organizer's 安排卡 (the header is the usual Bot header plus the 负责人 tag).
 * `actionable` = the group's open plan, still waiting for 开始; `reassignable` = the open
 * plan stopped after a step (steps not done can change hands before 继续 / 重试).
 */
export function BotGroupPlanCard({
  plan, members, identityFor, deviceId, online, actionable, reassignable, pending, onStart, onDismiss, onEditStep,
}: {
  plan: BotGroupPlanView | undefined;
  members: readonly BotGroupMemberView[];
  identityFor: BotGroupIdentityLookup;
  deviceId: string;
  online: boolean;
  actionable: boolean;
  reassignable: boolean;
  pending: BotGroupPlanCardAction | null;
  onStart(): void;
  onDismiss(): void;
  onEditStep(step: BotGroupPlanStepView, action: 'reassign' | 'remove', botId?: string): void;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  if (!plan) return <Text style={styles.note}>{t('groupChat.plan.missing')}</Text>;
  const muted = plan.status === 'superseded' || plan.status === 'dismissed';
  const finalNote = plan.status === 'superseded' ? 'groupChat.plan.superseded'
    : plan.status === 'dismissed' ? 'groupChat.plan.dismissed'
      : plan.status === 'stopped' ? 'groupChat.plan.stopped' : null;
  const busy = pending !== null;
  const candidates = members.filter(isActiveBotGroupMember);
  return <View testID="botGroup.plan" style={styles.planColumn}>
    <Text selectable style={styles.planIntro}>{t('groupChat.plan.intro', { count: plan.steps.length })}</Text>
    <View style={styles.card} testID={`botGroup.plan.${plan.status}`}>
      {plan.steps.map((step, index) => {
        const identity = identityFor(step.botId, step.botName);
        const editable = online && (actionable || (reassignable && (step.status === 'pending' || step.status === 'failed')));
        const label = stepAccessibility(t, plan, step, index, identity.name);
        if (!editable) {
          return <View key={step.position} accessible accessibilityLabel={label} style={styles.stepRow} testID="botGroup.plan.step">
            <StepRowContent plan={plan} step={step} index={index} identity={identity} deviceId={deviceId} online={online} muted={muted} />
          </View>;
        }
        const sections: BotGroupMenuSection[] = [{
          id: 'members',
          title: t('groupChat.plan.stepMenuTitle'),
          options: candidates.map((member) => ({
            id: `member:${member.botId}`,
            title: identityFor(member.botId, member.name).name,
            selected: member.botId === step.botId,
          })),
        }];
        if (actionable) {
          sections.push({
            id: 'remove',
            options: [{
              id: REMOVE_STEP_ID,
              title: t('groupChat.plan.removeStep'),
              destructive: true,
              disabled: plan.steps.length <= 1,
              ...(plan.steps.length <= 1 ? { subtitle: t('groupChat.plan.keepOneStep') } : {}),
            }],
          });
        }
        return <BotGroupMenu key={step.position} title={t('groupChat.plan.stepMenuTitle')} sections={sections} disabled={busy}
          accessibilityLabel={label} testID={`botGroup.plan.stepMenu.${step.position}`}
          onSelect={(id) => {
            if (id === REMOVE_STEP_ID) onEditStep(step, 'remove');
            else if (id.startsWith('member:') && id.slice('member:'.length) !== step.botId) onEditStep(step, 'reassign', id.slice('member:'.length));
          }}>
          {(open) => <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={busy}
            accessibilityHint={t(actionable ? 'groupChat.plan.editStepHint' : 'groupChat.plan.reassignStepHint')}
            accessibilityState={{ disabled: busy }} onPress={open}
            style={({ pressed }) => [styles.stepRow, pressed && mobileInteractionStyles.pressed, busy && styles.muted]}
            testID="botGroup.plan.step">
            <StepRowContent plan={plan} step={step} index={index} identity={identity} deviceId={deviceId} online={online} muted={false} />
          </Pressable>}
        </BotGroupMenu>;
      })}
      {actionable ? <View style={styles.actions}>
        <MainWindowActionButton density="compact" hitSlop={BOT_GROUP_COMPACT_HIT_SLOP}
          action={{ label: t('groupChat.plan.start'), tone: 'primary', busy: pending === 'start', disabled: busy || !online, onPress: onStart, testID: 'botGroup.plan.start' }} />
        <MainWindowActionButton density="compact" hitSlop={BOT_GROUP_COMPACT_HIT_SLOP}
          action={{ label: t('groupChat.plan.dismiss'), busy: pending === 'dismiss', disabled: busy || !online, onPress: onDismiss, testID: 'botGroup.plan.dismiss' }} />
      </View> : null}
    </View>
    {actionable ? <Text style={styles.note}>{t('groupChat.plan.pauseNote')}</Text>
      : finalNote ? <Text style={styles.note} testID="botGroup.plan.finalNote">{t(finalNote)}</Text> : null}
  </View>;
}

/** Files a step created or changed, under its hand-off message. They live on the computer. */
export function BotGroupHandoffFiles({ files }: { files: readonly string[] }) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  if (files.length === 0) return null;
  return <View style={styles.files} testID="botGroup.files">
    {files.map((file) => {
      const name = botGroupPathBasename(file);
      return <Pressable key={file} accessibilityRole="button" accessibilityLabel={name} accessibilityHint={t('groupChat.files.onComputer')}
        hitSlop={{ top: 6, bottom: 6 }}
        onPress={() => Alert.alert(file, t('groupChat.files.onComputer'))}
        style={({ pressed }) => [styles.fileChip, pressed && mobileInteractionStyles.pressed]} testID="botGroup.file">
        <FileText size={iconSize.sm} color={colors.textSecondary} />
        <Text numberOfLines={1} style={styles.fileName}>{name}</Text>
      </Pressable>;
    })}
  </View>;
}

export function BotGroupDivider({ children, testID }: { children: ReactNode; testID?: string }) {
  const styles = useThemedStyles(makeStyles);
  return <View style={styles.divider} testID={testID}>
    <View style={styles.dividerLine} />
    {children}
    <View style={styles.dividerLine} />
  </View>;
}

/** 「N 步都做完了」 — closes a finished plan in the timeline. */
export function BotGroupPlanEndDivider({ stepCount }: { stepCount: number | null }) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  return <BotGroupDivider testID="botGroup.planEnd">
    <Text style={styles.dividerText}>
      {stepCount ? t('groupChat.timeline.planDone', { count: stepCount }) : t('groupChat.timeline.planDoneGeneric')}
    </Text>
  </BotGroupDivider>;
}

/** Under an open plan that stopped after a step: continue with the next one, or retry. */
export function BotGroupPlanFollowUpRow({ followUp, identityFor, deviceId, online, pending, onContinue, onRetry, onEnd }: {
  followUp: BotGroupPlanFollowUp;
  identityFor: BotGroupIdentityLookup;
  deviceId: string;
  online: boolean;
  pending: BotGroupFollowUpAction | null;
  onContinue(): void;
  onRetry(): void;
  onEnd(): void;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const step = followUp.kind === 'continue' ? followUp.next : followUp.failed;
  const identity = identityFor(step.botId, step.botName);
  const busy = pending !== null;
  const primary = followUp.kind === 'continue' ? 'continue' : 'retry';
  const label = followUp.kind === 'continue'
    ? `${t('groupChat.timeline.nextStep')}${identity.name} ${step.task}`
    : t('groupChat.timeline.stepFailed', { name: identity.name });
  return <View style={styles.followUp} testID={`botGroup.followUpRow.${followUp.kind}`}>
    <View style={styles.followUpText} accessible accessibilityLabel={label}>
      {followUp.kind === 'continue' ? <>
        <Text style={styles.followUpLead}>{t('groupChat.timeline.nextStep')}</Text>
        <BotGroupAvatar deviceId={deviceId} identity={identity} size={BOT_GROUP_INLINE_AVATAR_SIZE} online={online} />
        <Text numberOfLines={1} style={styles.followUpLabel}>
          <Text style={styles.followUpName}>{identity.name}</Text>{' '}{step.task}
        </Text>
      </> : <Text numberOfLines={1} style={styles.followUpLabel}>{label}</Text>}
    </View>
    <MainWindowActionButton density="compact" hitSlop={BOT_GROUP_COMPACT_HIT_SLOP} action={{
      label: t(followUp.kind === 'continue' ? 'groupChat.timeline.continuePlan' : 'groupChat.timeline.retryStep'),
      tone: 'primary', busy: pending === primary, disabled: busy || !online,
      onPress: followUp.kind === 'continue' ? onContinue : onRetry, testID: `botGroup.followUp.${primary}`,
    }} />
    <MainWindowActionButton density="compact" hitSlop={BOT_GROUP_COMPACT_HIT_SLOP} action={{
      label: t('groupChat.timeline.endPlan'), busy: pending === 'dismiss', disabled: busy || !online,
      onPress: onEnd, testID: 'botGroup.followUp.end',
    }} />
  </View>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  organizerBadge: { borderRadius: radius.pill, backgroundColor: colors.surfaceChip, paddingHorizontal: spacing.sm, flexShrink: 0 },
  organizerBadgeText: { color: colors.textSecondary, fontSize: typeScale.micro, lineHeight: lineHeight.micro, fontWeight: fontWeight.semibold },
  planColumn: { gap: spacing.sm, minWidth: 0 },
  planIntro: { color: colors.textPrimary, fontSize: typeScale.bodyLarge, lineHeight: lineHeight.bodyLarge },
  // Floating card: 1px border on the elevated surface (mobile guide §2), no row dividers.
  card: { backgroundColor: colors.surfaceElevated, borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.container, paddingVertical: spacing.xs, overflow: 'hidden' },
  stepRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 44, paddingHorizontal: spacing.md },
  stepLead: { width: iconSize.md, alignItems: 'center', justifyContent: 'center' },
  stepNumber: { color: colors.textTertiary, fontSize: typeScale.caption, lineHeight: lineHeight.caption, fontVariant: ['tabular-nums'] },
  stepText: { flex: 1, minWidth: 0, color: colors.textSecondary, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall },
  stepName: { color: colors.textPrimary, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.medium },
  stepTextMuted: { color: colors.textTertiary, fontWeight: fontWeight.regular },
  stepStatus: { color: colors.textTertiary, fontSize: typeScale.caption, lineHeight: lineHeight.caption, flexShrink: 0 },
  muted: { opacity: 0.6 },
  actions: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.md, paddingTop: spacing.xs, paddingBottom: spacing.sm },
  note: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
  files: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  fileChip: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, minHeight: 32, maxWidth: '100%',
    paddingHorizontal: spacing.md, borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border, backgroundColor: colors.surfaceElevated },
  fileName: { flexShrink: 1, color: colors.textPrimary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
  divider: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 44 },
  dividerLine: { flex: 1, minWidth: spacing.xl, height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  dividerText: { flexShrink: 1, color: colors.textTertiary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, textAlign: 'center' },
  followUp: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 44 },
  followUpText: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  followUpLead: { flexShrink: 0, color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
  followUpLabel: { flexShrink: 1, color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
  followUpName: { color: colors.textPrimary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.medium },
});
