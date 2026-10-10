/**
 * 群聊里的分工（docs/product-rules/bot-group-chat.md §7，对照桌面 BotGroupPlan.tsx）：
 * 负责人的安排卡、交接消息下的文件、时间线末尾的「下一步」「没做完」卡与「N 步都做完了」。
 *
 * 安排卡、下一步、没做完都用伙伴卡片的统一外壳（K1 / K9）：眉题写「分工」和进度，标题写要做的事，
 * 步骤一行一个（编号或状态、头像、名字 + 做什么），行间不画分隔线，底部是等宽的两个按钮
 * （CompanionCardButton，可见 38pt，hitSlop 补到 44pt）。只有群里未结束的那张卡能操作：待开始时
 * 点某一步换人或删掉；做完一步停下时，还没做或没做完的步骤仍可换人。
 *
 * 交接文件在电脑的工作目录里，手机不打开，点一下说明去电脑上看。
 */
import type { ReactNode } from 'react';
import { Alert, Animated as RNAnimated, Easing, Pressable, StyleSheet, View } from 'react-native';
import { useEffect, useRef } from 'react';
import { CircleAlert, CircleCheck, CircleDashed, FileText, ListChecks } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { botGroupPathBasename, isActiveBotGroupMember, type BotGroupPlanFollowUp } from '@cindy/maker-shared/botGroupPresentation';
import type { BotGroupMemberView, BotGroupPlanStepView, BotGroupPlanView } from '@cindy/maker-shared/botGroupChat';
import { Text } from '@/components/AppText';
import { mobileInteractionStyles } from '@/components/mobileInteractionStyles';
import { motionDuration, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { useReduceMotionEnabled } from '@/hooks/useReduceMotion';
import { CompanionFadeIn } from './CompanionEntering';
import { CompanionCardActions, CompanionCardButton } from './CompanionCardButton';
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

/** The running step: an 8pt Heart Orange dot breathing like every running mark. */
function RunningDot() {
  const styles = useThemedStyles(makeStyles);
  const animate = useReduceMotionEnabled() === false;
  const opacity = useRef(new RNAnimated.Value(1)).current;
  useEffect(() => {
    if (!animate) { opacity.setValue(1); return; }
    const step = (toValue: number) => RNAnimated.timing(opacity, { toValue, duration: 750, easing: Easing.inOut(Easing.ease), useNativeDriver: true });
    const loop = RNAnimated.loop(RNAnimated.sequence([step(0.3), step(1)]));
    loop.start();
    return () => loop.stop();
  }, [animate, opacity]);
  return <RNAnimated.View style={[styles.runningDot, { opacity }]} testID="botGroup.plan.running" />;
}

/** 16pt leading mark: the step number before 开始, its live status afterwards. */
function StepLead({ plan, step, index }: { plan: BotGroupPlanView; step: BotGroupPlanStepView; index: number }) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  if (!started(plan)) return <Text style={styles.stepNumber}>{index + 1}</Text>;
  // M8: a finished step's check eases in (fast 150ms, from 0.6) when it changes while on screen.
  if (step.status === 'done') return <CompanionFadeIn play={started(plan) && plan.status !== 'done'} distance={0} scaleFrom={0.6} duration={motionDuration.fast}>
    <CircleCheck size={iconSize.md} color={colors.textSecondary} />
  </CompanionFadeIn>;
  // K7: running breathes in Heart Orange, the list's running language.
  if (step.status === 'running') return <RunningDot />;
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
  const { t, i18n } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  if (!plan) return <Text style={styles.note}>{t('groupChat.plan.missing')}</Text>;
  const muted = plan.status === 'superseded' || plan.status === 'dismissed';
  const finalNote = plan.status === 'superseded' ? 'groupChat.plan.superseded'
    : plan.status === 'dismissed' ? 'groupChat.plan.dismissed'
      : plan.status === 'stopped' ? 'groupChat.plan.stopped' : null;
  const busy = pending !== null;
  const candidates = members.filter(member => isActiveBotGroupMember(member) && (!member.actorKind || member.actorKind === 'bot'));
  const steps = plan.steps.length;
  const done = plan.steps.filter((step) => step.status === 'done').length;
  const progress = plan.status === 'proposed' ? t('groupChat.plan.awaitingStart')
    : plan.status === 'running' ? t('groupChat.plan.progressRunning', { current: Math.min(done + 1, steps), total: steps })
    : plan.status === 'waiting' ? t('groupChat.plan.progressDone', { done, total: steps })
    : plan.status === 'done' ? t('groupChat.plan.allDone')
    : finalNote ? t(finalNote) : '';
  // K9: one card — eyebrow with progress, the plan as its title, steps, then the decision.
  return <View testID="botGroup.plan" style={[styles.card, muted && styles.cardMuted]}>
    <View style={styles.eyebrow}>
      <ListChecks size={iconSize.sm} color={colors.textSecondary} />
      <Text style={styles.eyebrowText}>{t('groupChat.plan.eyebrow', { count: steps })}</Text>
      {progress ? <Text style={styles.eyebrowStatus} testID={finalNote ? 'botGroup.plan.finalNote' : `botGroup.plan.${plan.status}`}>{progress}</Text> : null}
    </View>
    <Text selectable style={styles.planTitle}>{t('groupChat.plan.intro', { count: steps })}</Text>
    <View style={styles.steps}>
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
    </View>
    {actionable ? <>
      {/* Two sentences: Chinese and Japanese run them together, other languages need a space. */}
      <Text style={styles.note}>{[t('groupChat.plan.pauseNote'), t('groupChat.plan.editHint')].join(/^(zh|ja)/.test(i18n.language) ? '' : ' ')}</Text>
      <CompanionCardActions>
        <CompanionCardButton label={t('groupChat.plan.dismiss')} busy={pending === 'dismiss'} disabled={busy || !online}
          onPress={onDismiss} testID="botGroup.plan.dismiss" />
        <CompanionCardButton primary label={t('groupChat.plan.start')} busy={pending === 'start'} disabled={busy || !online}
          onPress={onStart} testID="botGroup.plan.start" />
      </CompanionCardActions>
    </> : null}
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

/**
 * Under an open plan that stopped after a step (K9): the same card shell as every companion card —
 * what comes next (or what did not finish), then 「结束分工」 and the primary 「继续 / 重试」.
 */
export function BotGroupPlanFollowUpRow({ followUp, identityFor, deviceId, online, pending, stepNumber, stepTotal, onContinue, onRetry, onEnd }: {
  followUp: BotGroupPlanFollowUp;
  identityFor: BotGroupIdentityLookup;
  deviceId: string;
  online: boolean;
  pending: BotGroupFollowUpAction | null;
  /** 1-based position of the step shown, and how many steps the plan has. */
  stepNumber: number;
  stepTotal: number;
  onContinue(): void;
  onRetry(): void;
  onEnd(): void;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const step = followUp.kind === 'continue' ? followUp.next : followUp.failed;
  const identity = identityFor(step.botId, step.botName);
  const busy = pending !== null;
  const primary = followUp.kind === 'continue' ? 'continue' : 'retry';
  const failed = followUp.kind === 'retry';
  const label = failed
    ? t('groupChat.timeline.stepFailed', { name: identity.name })
    : `${t('groupChat.timeline.nextStep')}${identity.name} ${step.task}`;
  return <View style={styles.card} testID={`botGroup.followUpRow.${followUp.kind}`}>
    <View style={styles.eyebrow} accessible accessibilityLabel={label}>
      {failed ? <CircleAlert size={iconSize.sm} color={colors.statusError} /> : <ListChecks size={iconSize.sm} color={colors.textSecondary} />}
      <Text style={styles.eyebrowText}>{failed ? t('groupChat.followUp.failedStep', { step: stepNumber }) : t('groupChat.followUp.next')}</Text>
      <Text style={styles.eyebrowStatus}>{`${stepNumber} / ${stepTotal}`}</Text>
    </View>
    <View style={styles.who}>
      <View style={styles.whoAvatar}><BotGroupAvatar deviceId={deviceId} identity={identity} size={BOT_GROUP_INLINE_AVATAR_SIZE} online={online} /></View>
      <Text numberOfLines={2} style={styles.whoText}><Text style={styles.whoName}>{identity.name}</Text>{` ${step.task}`}</Text>
    </View>
    <CompanionCardActions>
      <CompanionCardButton label={t('groupChat.timeline.endPlan')} busy={pending === 'dismiss'} disabled={busy || !online}
        onPress={onEnd} testID="botGroup.followUp.end" />
      <CompanionCardButton primary label={t(failed ? 'groupChat.timeline.retryStep' : 'groupChat.timeline.continuePlan')}
        busy={pending === primary} disabled={busy || !online}
        onPress={failed ? onRetry : onContinue} testID={`botGroup.followUp.${primary}`} />
    </CompanionCardActions>
  </View>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  organizerBadge: { borderRadius: radius.pill, backgroundColor: colors.surfaceChip, paddingHorizontal: spacing.sm, flexShrink: 0 },
  organizerBadgeText: { color: colors.textSecondary, fontSize: typeScale.micro, lineHeight: lineHeight.micro, fontWeight: fontWeight.semibold },
  // K1 card shell: raised surface, hairline border, radius 12, padding 16; steps have no row dividers.
  card: { backgroundColor: colors.surfaceElevated, borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.container, padding: spacing.lg, gap: spacing.xs, overflow: 'hidden' },
  cardMuted: { opacity: 0.6 },
  eyebrow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs + 2, minHeight: lineHeight.caption },
  eyebrowText: { flex: 1, minWidth: 0, color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.medium },
  eyebrowStatus: { flexShrink: 0, color: colors.textTertiary, fontSize: typeScale.caption, lineHeight: lineHeight.caption, fontVariant: ['tabular-nums'] },
  planTitle: { marginTop: 2, color: colors.textPrimary, fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.medium },
  steps: { marginTop: spacing.xs },
  stepRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 40 },
  runningDot: { width: 8, height: 8, borderRadius: radius.pill, backgroundColor: colors.statusAccent },
  who: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, marginTop: 2 },
  whoAvatar: { marginTop: 1 },
  whoText: { flex: 1, minWidth: 0, color: colors.textPrimary, fontSize: typeScale.body, lineHeight: lineHeight.body },
  whoName: { color: colors.textPrimary, fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.medium },
  stepLead: { width: iconSize.md, alignItems: 'center', justifyContent: 'center' },
  stepNumber: { color: colors.textTertiary, fontSize: typeScale.caption, lineHeight: lineHeight.caption, fontVariant: ['tabular-nums'] },
  stepText: { flex: 1, minWidth: 0, color: colors.textSecondary, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall },
  stepName: { color: colors.textPrimary, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.medium },
  stepTextMuted: { color: colors.textTertiary, fontWeight: fontWeight.regular },
  stepStatus: { color: colors.textTertiary, fontSize: typeScale.caption, lineHeight: lineHeight.caption, flexShrink: 0 },
  muted: { opacity: 0.6 },
  note: { marginTop: spacing.xs, color: colors.textTertiary, fontSize: typeScale.caption, lineHeight: lineHeight.caption },
  files: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  fileChip: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, minHeight: 32, maxWidth: '100%',
    paddingHorizontal: spacing.md, borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border, backgroundColor: colors.surfaceElevated },
  fileName: { flexShrink: 1, color: colors.textPrimary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
  divider: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 44 },
  dividerLine: { flex: 1, minWidth: spacing.xl, height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  dividerText: { flexShrink: 1, color: colors.textTertiary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, textAlign: 'center' },
});
