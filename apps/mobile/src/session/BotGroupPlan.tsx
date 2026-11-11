import type { ReactNode } from 'react';
import { Alert, Animated as RNAnimated, Easing, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronUp, Circle, CircleAlert, CircleCheck, CircleDashed, CircleMinus, FileText, ListChecks, Minus, Sparkles } from 'lucide-react-native';
import { botGroupPlanStepState, botGroupQueueWindow, canSkipBotGroupPlanStep } from '@cindy/maker-shared/botGroupPresentation';
import { useTranslation } from 'react-i18next';
import { botGroupPathBasename, isActiveBotGroupMember, type BotGroupPlanFollowUp } from '@cindy/maker-shared/botGroupPresentation';
import type { BotGroupMemberView, BotGroupPlanStepView, BotGroupPlanView } from '@cindy/maker-shared/botGroupChat';
import { Text } from '@/components/AppText';
import { mobileInteractionStyles } from '@/components/mobileInteractionStyles';
import { motionDuration, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { useReduceMotionEnabled } from '@/hooks/useReduceMotion';
import { CompanionFadeIn } from './CompanionEntering';
import { fontWeight, iconSize, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';
import {
  BOT_GROUP_INLINE_AVATAR_SIZE,
  BOT_GROUP_STEP_AVATAR_SIZE,
  BotGroupAvatar,
  type BotGroupIdentity,
} from './BotGroupAvatars';
import { formatLocalizedSeconds } from './sessionDurationFormat';
import { BotGroupMenu, type BotGroupMenuSection } from './BotGroupMenu';
import { NativeSwitch } from '@/platform/chrome/NativeSwitch';
import { BotGroupPlanActions } from './BotGroupPlanActions';
import { CompanionSheet } from './CompanionSheet';

export const BOT_GROUP_COMPACT_HIT_SLOP = { top: 4, bottom: 4, left: 4, right: 4 } as const;

export type BotGroupPlanCardAction = 'start' | 'dismiss' | 'edit' | 'auto-continue' | 'continue' | 'retry';
export type BotGroupIdentityLookup = (botId: string, fallbackName?: string) => BotGroupIdentity;

const REMOVE_STEP_ID = 'remove';

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

// Stopped snapshots can retain a running step.
function stepState(plan: BotGroupPlanView, step: BotGroupPlanStepView) {
  const state = botGroupPlanStepState(plan, step);
  if (state === 'running' && plan.status === 'stopped') return 'stopped';
  if (state === 'running' && step.executionStatus === 'queued') return 'queued';
  return state;
}

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

function StepStatusMark({ plan, step }: { plan: BotGroupPlanView; step: BotGroupPlanStepView }) {
  const { colors } = useTheme();
  const state = stepState(plan, step);
  if (state === 'skipped') return <CircleMinus size={iconSize.md} color={colors.textTertiary} />;
  if (state === 'done') return <CompanionFadeIn play={started(plan) && plan.status !== 'done'} distance={0} scaleFrom={0.6} duration={motionDuration.fast}>
    <CircleCheck size={iconSize.md} color={colors.textSecondary} />
  </CompanionFadeIn>;
  if (state === 'running') return <RunningDot />;
  if (state === 'failed') return <CircleAlert size={iconSize.md} color={colors.errorText} />;
  return <CircleDashed size={iconSize.md} color={colors.textTertiary} />;
}

const STEP_STATUS_KEYS: Partial<Record<ReturnType<typeof botGroupPlanStepState>, string>> = {
  queued: 'groupChat.plan.stepQueued',
  skipped: 'groupChat.plan.stepSkipped',
  stopped: 'groupChat.plan.stopped',
  done: 'groupChat.plan.stepDone',
  running: 'groupChat.plan.stepRunning',
  failed: 'groupChat.plan.stepFailed',
};

function stepStatusKey(plan: BotGroupPlanView, step: BotGroupPlanStepView) {
  const state = stepState(plan, step);
  return plan.kind === 'talk' && state === 'running' ? 'groupChat.plan.stepExecuting' : STEP_STATUS_KEYS[state];
}

function StepRowContent({ plan, step, identity, deviceId, online, muted, runningSince, doneAt }: {
  plan: BotGroupPlanView; step: BotGroupPlanStepView; identity: BotGroupIdentity;
  deviceId: string; online: boolean; muted: boolean; runningSince: number | null; doneAt?: number;
}) {
  const { t, i18n } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const statusKey = started(plan) ? stepStatusKey(plan, step) ?? 'groupChat.plan.stepPending' : undefined;
  const running = plan.status === 'running' && stepState(plan, step) === 'running' && runningSince !== null && Number.isFinite(runningSince) && runningSince > 0;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running, runningSince]);
  const timing = running ? formatLocalizedSeconds((now - runningSince!) / 1000)
    : step.status === 'done' && doneAt !== undefined && Number.isFinite(doneAt) && doneAt > 0 ? new Date(doneAt).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' }) : null;
  // In a running plan the mark carries routine state; only exceptions need another label.
  const focused = plan.status === 'running';
  const state = stepState(plan, step);
  const status = focused && ['done', 'running', 'pending'].includes(state) ? timing : statusKey ? [t(statusKey), timing].filter(Boolean).join(' · ') : null;
  return <>
    <View style={muted ? styles.muted : undefined}>
      <BotGroupAvatar deviceId={deviceId} identity={identity} size={BOT_GROUP_STEP_AVATAR_SIZE} online={online} />
    </View>
    <View style={styles.stepBody}>
        <View style={styles.stepHeading}>
          <Text numberOfLines={1} ellipsizeMode="tail" style={[styles.stepName, muted && styles.stepTextMuted]}>{identity.name}</Text>
          {statusKey ? <View style={styles.workStatus}>
            <StepStatusMark plan={plan} step={step} />
            {status ? <Text style={styles.stepStatus}>{status}</Text> : null}
          </View> : null}
        </View>
        {step.task ? <Text numberOfLines={2} ellipsizeMode="tail" style={[styles.stepText, focused && state === 'running' && styles.currentTask, muted && styles.stepTextMuted]}>{step.task}</Text> : null}
    </View>
  </>;
}

function stepAccessibility(t: (key: string, options?: Record<string, unknown>) => string, plan: BotGroupPlanView,
  step: BotGroupPlanStepView, index: number, name: string): string {
  const status = started(plan)
    ? t(stepStatusKey(plan, step) ?? 'groupChat.plan.stepPending')
    : `${index + 1}`;
  return [status, name, step.task].filter(Boolean).join(', ');
}

function BotGroupTalkCard({ plan, identityFor, deviceId, online, pending, onEditStep }: {
  plan: BotGroupPlanView;
  identityFor: BotGroupIdentityLookup;
  deviceId: string;
  online: boolean;
  pending: BotGroupPlanCardAction | null;
  onEditStep(step: BotGroupPlanStepView, action: 'reassign' | 'remove' | 'skip', botId?: string): void;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState(false);
  // Avoid a narrow name column that wraps past two lines.
  const [wideNames, setWideNames] = useState<ReadonlySet<string>>(() => new Set());
  const cardWidth = useRef<number | null>(null);
  const turns = botGroupQueueWindow(plan);
  const foldable = turns.end - turns.start < plan.steps.length;
  const shown = foldable && !expanded ? plan.steps.slice(turns.start, turns.end) : plan.steps;
  const current = plan.steps.find(step => step.position === plan.currentStep);
  const statusKey = (step: BotGroupPlanStepView) => stepState(plan, step) === 'done' ? 'groupChat.plan.stepSpoken'
    : stepStatusKey(plan, step) ?? 'groupChat.plan.talkPending';
  const progress = plan.status === 'done' ? t('groupChat.plan.queueEnded')
    : plan.status === 'waiting' ? t(current?.status === 'failed' ? 'groupChat.plan.stepFailed' : 'groupChat.plan.queueWaiting')
    : ['stopped', 'superseded', 'dismissed'].includes(plan.status) ? t(`groupChat.plan.${plan.status}`)
    : current ? `${t(statusKey(current))} · ${current.position + 1} / ${plan.steps.length}` : '';
  const busy = pending !== null;
  const waiting = plan.status === 'waiting' && current?.status !== 'failed';
  return <View style={[styles.talkCard, waiting && styles.refinedCard]} testID="botGroup.plan" onLayout={event => {
    const width = event.nativeEvent.layout.width;
    if (cardWidth.current !== null && cardWidth.current !== width) setWideNames(new Set());
    cardWidth.current = width;
  }}>
    <View style={styles.talkHeader}>
      {!waiting ? <Circle size={iconSize.md} color={colors.textTertiary} /> : null}
      <Text style={[styles.talkTitle, waiting && styles.refinedTitle]}>{t('groupChat.plan.talkTitle')}</Text>
      <Text style={styles.talkProgress}>{progress}</Text>
    </View>
    <View style={styles.steps}>
      {shown.map(step => {
        const identity = identityFor(step.botId, step.botName);
        const nameKey = `${step.position}:${identity.name}`;
        const state = stepState(plan, step);
        return <View key={step.position} style={styles.talkRow} testID="botGroup.plan.step">
          <View style={styles.talkAvatar}>
            <BotGroupAvatar deviceId={deviceId} identity={identity} size={BOT_GROUP_INLINE_AVATAR_SIZE} online={online} />
          </View>
          <View style={styles.talkMember}>
            <Text style={[styles.talkName, wideNames.has(nameKey) && styles.talkNameWide]}
              accessibilityLabel={waiting && (state === 'done' || state === 'pending') ? `${identity.name}, ${t(statusKey(step))}` : undefined}
              onTextLayout={wideNames.has(nameKey) ? undefined : event => {
                if (event.nativeEvent.lines.length > 2) setWideNames(previous => previous.has(nameKey) ? previous : new Set([...previous, nameKey]));
              }}>{identity.name}</Text>
            <View style={[styles.talkTail, canSkipBotGroupPlanStep(plan, step) && styles.talkActionTail]}>
              <View style={styles.talkStatus}>
                {state === 'done' ? <Check size={iconSize.sm} color={colors.statusDone} />
                  : state === 'running' ? <Sparkles size={iconSize.sm} color={colors.statusAccent} />
                  : state === 'skipped' || state === 'stopped' ? <Minus size={iconSize.sm} color={colors.textTertiary} />
                  : state === 'failed' ? <CircleAlert size={iconSize.sm} color={colors.statusError} /> : null}
                {!(waiting && (state === 'done' || state === 'pending')) ? <Text style={styles.stepStatus}>{t(statusKey(step))}</Text> : null}
              </View>
              {canSkipBotGroupPlanStep(plan, step) ? <Pressable accessibilityRole="button"
                accessibilityLabel={t('groupChat.plan.skipTurnLabel', { name: identity.name })}
                accessibilityState={{ disabled: busy || !online, busy }} disabled={busy || !online}
                hitSlop={{ top: 8, bottom: 8 }} testID="botGroup.plan.skipTurn" onPress={() => onEditStep(step, 'skip')}
                style={({ pressed }) => [styles.talkButton, pressed && mobileInteractionStyles.pressed, (busy || !online) && styles.muted]}>
                <Text style={styles.talkButtonLabel}>{t(busy ? 'groupChat.plan.skippingTurn' : 'groupChat.plan.skipTurn')}</Text>
              </Pressable> : null}
            </View>
          </View>
        </View>;
      })}
    </View>
    {foldable ? <Pressable accessibilityRole="button" accessibilityState={{ expanded }}
      accessibilityLabel={expanded ? t('groupChat.plan.foldTurns') : t('groupChat.plan.allTurns', { count: plan.steps.length })}
      hitSlop={{ top: 8, bottom: 8 }} onPress={() => setExpanded(open => !open)} testID="botGroup.plan.fold"
      style={({ pressed }) => [styles.talkFold, waiting && styles.refinedFold, pressed && mobileInteractionStyles.pressed]}>
      <Text style={[styles.talkButtonLabel, waiting && styles.refinedFoldLabel]}>{expanded ? t('groupChat.plan.foldTurns') : t('groupChat.plan.allTurns', { count: plan.steps.length })}</Text>
      {expanded ? <ChevronUp size={iconSize.sm} color={colors.textSecondary} /> : <ChevronDown size={iconSize.sm} color={colors.textSecondary} />}
    </Pressable> : null}
  </View>;
}

export function BotGroupPlanCard({
  plan, fallback, members, identityFor, deviceId, online, actionable, reassignable, pending, runningSince = null, doneAt, onStart, onDismiss, onEditStep, onAutoContinueChange,
}: {
  plan: BotGroupPlanView | undefined;
  fallback?: string;
  runningSince?: number | null;
  doneAt?: ReadonlyMap<number, number>;
  members: readonly BotGroupMemberView[];
  identityFor: BotGroupIdentityLookup;
  deviceId: string;
  online: boolean;
  actionable: boolean;
  reassignable: boolean;
  pending: BotGroupPlanCardAction | null;
  onStart(): void;
  onDismiss(): void;
  onEditStep(step: BotGroupPlanStepView, action: 'reassign' | 'remove' | 'skip', botId?: string): void;
  onAutoContinueChange?: (on: boolean) => void;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const [detailsPosition, setDetailsPosition] = useState<number | null>(null);
  useEffect(() => setDetailsPosition(null), [plan?.id, plan?.revision, deviceId]);
  if (!plan) return <View style={styles.card}>
    {fallback ? <Text selectable style={styles.stepText}>{fallback}</Text> : null}
    <Text style={styles.note}>{t('groupChat.plan.missing')}</Text>
  </View>;
  if (plan.kind === 'talk') return <BotGroupTalkCard plan={plan} identityFor={identityFor} deviceId={deviceId}
    online={online} pending={pending} onEditStep={onEditStep} />;
  const muted = plan.status === 'superseded' || plan.status === 'dismissed';
  const finalNote = plan.status === 'superseded' ? 'groupChat.plan.superseded'
    : plan.status === 'dismissed' ? 'groupChat.plan.dismissed'
      : plan.status === 'stopped' ? 'groupChat.plan.stopped' : null;
  const busy = pending !== null;
  const showAutoContinue = plan.canSetAutoContinue === true && typeof plan.autoContinue === 'boolean' && onAutoContinueChange !== undefined;
  const candidates = members.filter(member => isActiveBotGroupMember(member) && (!member.actorKind || member.actorKind === 'bot'));
  const steps = plan.steps.length;
  const current = plan.steps.find(step => step.position === plan.currentStep);
  const progress = plan.status === 'proposed' ? t('groupChat.plan.awaitingStart')
    : plan.status === 'running' ? current && stepState(plan, current) === 'queued' ? t('groupChat.plan.stepQueued')
      : t('groupChat.plan.progressRunning', { current: current ? current.position + 1 : 1, total: steps })
    : plan.status === 'waiting' ? t(current?.status === 'failed' ? 'groupChat.plan.stepFailed' : 'groupChat.plan.queueWaiting')
    : plan.status === 'done' ? t('groupChat.plan.allDone')
    : finalNote ? t(finalNote) : '';
  const refined = plan.status === 'proposed' || plan.status === 'running';
  return <View testID="botGroup.plan" style={[styles.card, refined && styles.refinedCard, muted && styles.cardMuted]}>
    <View style={styles.eyebrow} testID={plan.status === 'proposed' ? 'botGroup.plan.proposed' : undefined}>
      {!refined ? <ListChecks size={iconSize.md} color={colors.textSecondary} /> : null}
      <Text style={[styles.eyebrowText, refined && styles.refinedTitle]}>{t('groupChat.plan.eyebrow', { count: steps })}</Text>
      {progress && plan.status !== 'proposed' ? <Text style={styles.eyebrowStatus} testID={finalNote ? 'botGroup.plan.finalNote' : `botGroup.plan.${plan.status}`}>{progress}</Text> : null}
    </View>
    <View style={[styles.steps, refined && styles.workSteps]}>
      {plan.steps.map((step, index) => {
        const identity = identityFor(step.botId, step.botName);
        const editable = online && (actionable || (reassignable && (step.status === 'pending' || step.status === 'failed')));
        const label = stepAccessibility(t, plan, step, index, identity.name);
        if (!editable) {
          return <Pressable key={step.position} accessibilityRole="button" accessibilityLabel={label}
            accessibilityHint={t('interaction.companion.details')} onPress={() => setDetailsPosition(step.position)}
            style={({ pressed }) => [styles.stepRow, refined && styles.workStepRow, pressed && mobileInteractionStyles.pressed]} testID="botGroup.plan.step">
            <StepRowContent plan={plan} step={step} identity={identity} deviceId={deviceId} online={online} muted={muted} runningSince={runningSince} doneAt={doneAt?.get(step.position)} />
          </Pressable>;
        }
        const sections: BotGroupMenuSection[] = [{ id: 'details', options: [{ id: 'details', title: t('interaction.companion.details') }] }, {
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
        return <BotGroupMenu key={`${plan.id}:${plan.revision ?? ''}:${step.position}`} title={t('groupChat.plan.stepMenuTitle')} sections={sections} disabled={busy}
          accessibilityLabel={label} testID={`botGroup.plan.stepMenu.${step.position}`}
          onSelect={(id) => {
            if (id === 'details') setDetailsPosition(step.position);
            else if (id === REMOVE_STEP_ID) onEditStep(step, 'remove');
            else if (id.startsWith('member:') && id.slice('member:'.length) !== step.botId) onEditStep(step, 'reassign', id.slice('member:'.length));
          }}>
          {(open) => <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={busy}
            accessibilityHint={t(actionable ? 'groupChat.plan.editStepHint' : 'groupChat.plan.reassignStepHint')}
            accessibilityState={{ disabled: busy }} onPress={open}
            style={({ pressed }) => [styles.stepRow, refined && styles.workStepRow, pressed && mobileInteractionStyles.pressed, busy && styles.muted]}
            testID="botGroup.plan.step">
            <StepRowContent plan={plan} step={step} identity={identity} deviceId={deviceId} online={online} muted={false} runningSince={runningSince} doneAt={doneAt?.get(step.position)} />
          </Pressable>}
        </BotGroupMenu>;
      })}
    </View>
    {showAutoContinue ? <View style={[styles.autoContinue, refined && styles.refinedSetting]}>
      {refined ? <Text style={styles.settingLabel}>{t('groupChat.plan.autoContinue')}</Text> : null}
      <NativeSwitch accessibilityLabel={t('groupChat.plan.autoContinue')} testID="botGroup.plan.autoContinue"
        value={plan.autoContinue === true} disabled={busy || !online} onValueChange={onAutoContinueChange!} />
      {!refined ? <Text style={styles.autoContinueLabel}>{t('groupChat.plan.autoContinue')}</Text> : null}
    </View> : actionable ? <Text style={styles.note}>{t(plan.autoContinue ? 'groupChat.plan.autoNote' : 'groupChat.plan.pauseNote')}</Text> : null}
    {actionable ? <View style={styles.refinedActions}><BotGroupPlanActions actions={[
      { label: t('groupChat.plan.dismiss'), busy: pending === 'dismiss', disabled: busy || !online, onPress: onDismiss, testID: 'botGroup.plan.dismiss' },
      { label: t('groupChat.plan.start'), tone: 'primary', busy: pending === 'start', disabled: busy || !online, onPress: onStart, testID: 'botGroup.plan.start' },
    ]} /></View> : null}
    <CompanionSheet visible={detailsPosition !== null} title={t('interaction.companion.details')}
      onClose={() => setDetailsPosition(null)} testID="botGroup.plan.stepDetails">
      <ScrollView contentContainerStyle={styles.stepDetails}>
        {plan.steps.filter(step => step.position === detailsPosition).map(step => <View key={step.position} style={styles.stepDetailsText}>
          <Text selectable style={styles.detailsName}>{identityFor(step.botId, step.botName).name}</Text>
          <Text selectable style={styles.stepText}>{step.task}</Text>
        </View>)}
      </ScrollView>
    </CompanionSheet>
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

export function BotGroupPlanEndDivider({ stepCount }: { stepCount: number | null }) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  return <BotGroupDivider testID="botGroup.planEnd">
    <Text style={styles.dividerText}>
      {stepCount ? t('groupChat.timeline.planDone', { count: stepCount }) : t('groupChat.timeline.planDoneGeneric')}
    </Text>
  </BotGroupDivider>;
}

export function BotGroupPlanFollowUpRow({ plan, followUp, identityFor, deviceId, online, pending, onContinue, onRetry, onEnd }: {
  plan?: BotGroupPlanView;
  followUp: BotGroupPlanFollowUp;
  identityFor: BotGroupIdentityLookup;
  deviceId: string;
  online: boolean;
  pending: BotGroupPlanCardAction | null;
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
  const failed = followUp.kind === 'retry';
  const [stackedActions, setStackedActions] = useState(false);
  return <View style={styles.followUp} testID={`botGroup.followUpRow.${followUp.kind}`}>
    <View style={[styles.followUpHeader, stackedActions && styles.followUpHeaderStacked]}>
      {failed ? <Text style={[styles.followUpText, styles.followUpWho, stackedActions && styles.followUpWhoStacked]}>{t('groupChat.timeline.stepFailed', { name: identity.name })}</Text>
        : <View style={[styles.followUpWho, stackedActions && styles.followUpWhoStacked]}>
          <Text style={styles.followUpText}>{t('groupChat.timeline.nextStep')}</Text>
          <BotGroupAvatar deviceId={deviceId} identity={identity} size={BOT_GROUP_INLINE_AVATAR_SIZE} online={online} />
          <Text style={styles.followUpName} numberOfLines={1} ellipsizeMode="tail">{identity.name}</Text>
        </View>}
      <View style={[styles.followUpActions, Platform.OS !== 'ios' && styles.followUpActionsBounded, stackedActions && styles.followUpActionsStacked]}>
        <BotGroupPlanActions onStacked={() => setStackedActions(true)} actions={[
          { label: t(plan?.kind === 'talk' ? 'groupChat.timeline.endTalk' : 'groupChat.timeline.endPlan'), busy: pending === 'dismiss', disabled: busy || !online, onPress: onEnd, testID: 'botGroup.followUp.end' },
          { label: t(failed ? 'groupChat.timeline.retryStep' : 'groupChat.timeline.continuePlan'), tone: 'primary', busy: pending === primary, disabled: busy || !online, onPress: failed ? onRetry : onContinue, testID: `botGroup.followUp.${primary}` },
        ]} />
      </View>
    </View>
    {!failed && step.task ? <Text style={styles.followUpTask}>{step.task}</Text> : null}
  </View>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  followUp: { backgroundColor: colors.surfaceElevated, borderColor: colors.border, borderWidth: 1,
    borderRadius: radius.container, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, gap: spacing.xs },
  followUpHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 44 },
  followUpHeaderStacked: { flexDirection: 'column', alignItems: 'stretch' },
  followUpWho: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  followUpWhoStacked: { flex: 0 },
  followUpText: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
  followUpName: { flex: 1, minWidth: 0, color: colors.textPrimary, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.regular },
  followUpTask: { color: colors.textSecondary, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall },
  followUpActions: { flexDirection: 'row', flexShrink: 0, alignItems: 'center', gap: spacing.xs },
  followUpActionsBounded: { flexShrink: 1, maxWidth: '60%' },
  followUpActionsStacked: { width: '100%', maxWidth: '100%' },
  talkCard: { backgroundColor: colors.surfaceElevated, borderColor: colors.border, borderWidth: 1,
    borderRadius: radius.container, padding: spacing.md, width: '100%', maxWidth: 720 },
  talkHeader: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: spacing.sm, rowGap: spacing.xs },
  talkTitle: { flexGrow: 1, flexShrink: 1, color: colors.textPrimary, fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.semibold },
  talkProgress: { color: colors.textTertiary, fontSize: typeScale.caption, lineHeight: lineHeight.bodyRelaxed, fontVariant: ['tabular-nums'] },
  talkRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, minHeight: 44 },
  talkAvatar: { minHeight: 44, justifyContent: 'center' },
  talkMember: { flex: 1, minWidth: 0, minHeight: 44, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', alignContent: 'center', columnGap: spacing.sm, rowGap: spacing.xs },
  talkName: { flexGrow: 1, flexShrink: 1, minWidth: 0, color: colors.textPrimary, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.regular },
  talkNameWide: { width: '100%', flexGrow: 0, flexShrink: 0 },
  talkTail: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center', alignContent: 'center', gap: spacing.sm, minHeight: lineHeight.bodySmall, marginLeft: 'auto' },
  // Keep the expanded hitSlop inside the parent's bounds on native platforms.
  talkActionTail: { minHeight: 44 },
  talkStatus: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  talkButton: { minHeight: 28, paddingHorizontal: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  talkButtonLabel: { color: colors.textPrimary, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.medium },
  talkFold: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: spacing.xs, minHeight: 28, paddingHorizontal: spacing.md, marginTop: spacing.xs, borderRadius: radius.pill },

  organizerBadge: { borderRadius: radius.pill, backgroundColor: colors.surfaceChip, paddingHorizontal: spacing.sm, flexShrink: 0 },
  organizerBadgeText: { color: colors.textSecondary, fontSize: typeScale.micro, lineHeight: lineHeight.micro, fontWeight: fontWeight.semibold },
  card: { backgroundColor: colors.surfaceElevated, borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.container, padding: spacing.md, gap: spacing.xs, overflow: 'hidden' },
  cardMuted: { opacity: 0.6 },
  refinedCard: { padding: spacing.lg, gap: spacing.sm, borderWidth: StyleSheet.hairlineWidth },
  refinedTitle: { fontSize: typeScale.subtitle, lineHeight: lineHeight.subtitle, fontWeight: fontWeight.medium },
  refinedSetting: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border, paddingTop: spacing.sm, marginTop: spacing.sm, justifyContent: 'space-between' },
  settingLabel: { flex: 1, minWidth: 0, color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
  refinedActions: { alignItems: 'flex-end', marginTop: spacing.xs },
  refinedFold: { paddingHorizontal: 0 },
  refinedFoldLabel: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular },
  currentTask: { color: colors.textPrimary },
  eyebrow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs + 2, minHeight: lineHeight.caption },
  eyebrowText: { flex: 1, minWidth: 0, color: colors.textPrimary, fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.semibold },
  eyebrowStatus: { flexShrink: 0, color: colors.textTertiary, fontSize: typeScale.caption, lineHeight: lineHeight.caption, fontVariant: ['tabular-nums'] },
  steps: { marginTop: spacing.xs },
  workSteps: { marginTop: spacing.sm, gap: spacing.lg },
  workStepRow: { paddingVertical: 0 },
  stepRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, minHeight: 44, paddingVertical: spacing.xs },
  runningDot: { width: 8, height: 8, borderRadius: radius.pill, backgroundColor: colors.statusAccent },
  stepBody: { flex: 1, minWidth: 0, gap: spacing.xs },
  stepHeading: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  workStatus: { flexShrink: 0, flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  stepText: { color: colors.textSecondary, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall },
  stepName: { flex: 1, minWidth: 0, color: colors.textPrimary, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.regular },
  stepDetails: { padding: spacing.lg },
  stepDetailsText: { gap: spacing.sm },
  detailsName: { color: colors.textPrimary, fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.regular },
  stepTextMuted: { color: colors.textTertiary, fontWeight: fontWeight.regular },
  stepStatus: { color: colors.textTertiary, fontSize: typeScale.caption, lineHeight: lineHeight.caption, flexShrink: 0 },
  muted: { opacity: 0.6 },
  note: { marginTop: spacing.xs, color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
  autoContinue: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 44, marginTop: spacing.xs },
  autoContinueLabel: { flex: 1, minWidth: 0, color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
  files: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  fileChip: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, minHeight: 32, maxWidth: '100%',
    paddingHorizontal: spacing.md, borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border, backgroundColor: colors.surfaceElevated },
  fileName: { flexShrink: 1, color: colors.textPrimary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
  divider: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 44 },
  dividerLine: { flex: 1, minWidth: spacing.xl, height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  dividerText: { flexShrink: 1, color: colors.textTertiary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, textAlign: 'center' },
});
