/**
 * 群聊里的分工（docs/product-rules/bot-group-chat.md §7）：负责人的安排卡、交接消息下的
 * 文件、时间线末尾的「下一步 · 继续」「没做完 · 重试」与「N 步都做完了」。
 *
 * 安排卡是时间线里的一条消息（`kind: 'plan'`），卡上每一步的状态取自 main 随群详情下发
 * 的安排快照，做到哪一步就地更新，不另起消息。只有群里未结束的那张卡可以操作：
 * 待开始时点某一步换人或删掉，底部「开始」「不用了」；做完一步停下时，还没做或没做完的
 * 步骤仍可换人（再点继续 / 重试）。其余状态只读，并注明已更新 / 不用了 / 已停止。
 *
 * 交接文件相对安排的工作目录；点开交给系统默认方式，路径越出工作目录的一律不打开。
 */
import { useState, type ReactNode } from 'react';
import { Check, ChevronDown, ChevronUp, CircleAlert, CircleCheck, CircleDashed, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { FileTypeIcon } from '@/components/ui/file-type-icon';
import { Switch } from '@/components/ui/switch';
import { Tip } from '@/components/ui/tooltip';
import { MENU_ITEM_CLASS } from '@/features/cc-agent/sidebar/menuStyles';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { shouldShowOpenPathError } from '../../../shared/openPathResult';
import type {
  BotGroupMemberView,
  BotGroupPlanStepView,
  BotGroupPlanView,
} from '../../../shared/botGroupChat';
import { formatBotTimelineClock } from '@cindy/maker-shared/botTimeline';
import { BotAvatar } from './BotAvatar';
import { BotGroupElapsed } from './BotGroupElapsed';
import {
  botGroupPathBasename,
  botGroupPlanFilePath,
  isActiveBotGroupMember,
  type BotGroupPlanFollowUp,
} from './botGroupPresentation';

type AvatarIdentity = { name: string; avatar: string | null; avatarColor: string | null };

export type BotGroupPlanCardAction = 'start' | 'dismiss' | 'edit';

/** The step's Bot as it looks now; a removed member keeps its name snapshot. */
function stepIdentity(step: BotGroupPlanStepView, members: readonly BotGroupMemberView[]): AvatarIdentity {
  const member = members.find((candidate) => candidate.botId === step.botId);
  return {
    name: step.botName.trim() || member?.name || '',
    avatar: member?.avatar ?? null,
    avatarColor: member?.avatarColor ?? null,
  };
}

/** Small pill after the organizer's name (群设置成员行与安排卡共用). */
export function BotGroupOrganizerTag() {
  const { t } = useTranslation();
  return (
    <span className="inline-flex min-h-[18px] shrink-0 select-none items-center rounded-full bg-[var(--surface-chip)] px-1.5 py-px text-11 font-medium leading-tight text-[var(--text-secondary)]">
      {t('bots.groupChat.organizer')}
    </span>
  );
}

/** 16px leading mark: the step number before 开始, its live status afterwards. */
function StepLead({ plan, step, index }: { plan: BotGroupPlanView; step: BotGroupPlanStepView; index: number }) {
  const { t } = useTranslation();
  if (plan.status === 'proposed' || plan.status === 'superseded' || plan.status === 'dismissed') {
    return <span className="text-12 tabular-nums text-[var(--text-tertiary)]">{index + 1}</span>;
  }
  if (step.status === 'done') {
    return <CircleCheck size={16} aria-hidden className="text-[var(--text-secondary)]" />;
  }
  if (step.status === 'running') {
    // Same running mark as the group speaking row (DESIGN.md §2 Thinking Orange).
    return <Sparkles size={15} aria-hidden className="text-[var(--status-bar-accent)]" />;
  }
  if (step.status === 'failed') {
    return <CircleAlert size={16} aria-hidden className="text-[var(--error-fg)]" />;
  }
  return (
    <>
      <CircleDashed size={16} aria-hidden className="text-[var(--text-tertiary)]" />
      <span className="sr-only">{t('bots.groupChat.plan.stepPending')}</span>
    </>
  );
}

const STEP_STATUS_KEYS: Partial<Record<BotGroupPlanStepView['status'], string>> = {
  done: 'bots.groupChat.plan.stepDone',
  running: 'bots.groupChat.plan.stepRunning',
  failed: 'bots.groupChat.plan.stepFailed',
};
/** A discussion's turns are spoken, not done. */
const TALK_STATUS_KEYS: Partial<Record<BotGroupPlanStepView['status'], string>> = {
  ...STEP_STATUS_KEYS,
  done: 'bots.groupChat.plan.stepSpoken',
  running: 'bots.groupChat.plan.stepSpeaking',
};

/** What the step is about; a discussion turn without a focus just shares a view. */
export function botGroupStepTask(plan: BotGroupPlanView, step: BotGroupPlanStepView, t: (key: string) => string): string {
  return step.task || (plan.kind === 'talk' ? t('bots.groupChat.plan.talkTurn') : '');
}

/** Live facts for the step status: when the running step started, when done steps finished. */
interface StepTiming {
  runningSince: number | null;
  /** Finish time per 1-based step, from its hand-off message. */
  doneAt?: ReadonlyMap<number, number>;
  locale: string;
}

function StepRowContent({
  plan,
  step,
  index,
  identity,
  muted,
  timing,
}: {
  plan: BotGroupPlanView;
  step: BotGroupPlanStepView;
  index: number;
  identity: AvatarIdentity;
  muted: boolean;
  timing: StepTiming;
}) {
  const { t } = useTranslation();
  const started = plan.status !== 'proposed' && plan.status !== 'superseded' && plan.status !== 'dismissed';
  const statusKey = started ? (plan.kind === 'talk' ? TALK_STATUS_KEYS : STEP_STATUS_KEYS)[step.status] : undefined;
  const doneAt = step.status === 'done' ? timing.doneAt?.get(index + 1) : undefined;
  return (
    <>
      <span className="flex w-4 shrink-0 justify-center">
        <StepLead plan={plan} step={step} index={index} />
      </span>
      <BotAvatar bot={identity} size="xs" className={cn('h-6 w-6 text-12', muted && 'opacity-60')} />
      <span className="min-w-0 flex-1 break-words text-13 leading-normal">
        <span className={cn('font-medium', muted ? 'text-[var(--text-tertiary)]' : 'text-[var(--text-primary)]')}>
          {identity.name}
        </span>{' '}
        <span className={muted ? 'text-[var(--text-tertiary)]' : 'text-[var(--text-secondary)]'}>{botGroupStepTask(plan, step, t)}</span>
      </span>
      {statusKey ? (
        <span
          className={cn(
            'shrink-0 text-12 tabular-nums',
            step.status === 'running' ? 'text-[var(--status-bar-accent)]' : 'text-[var(--text-tertiary)]',
          )}
        >
          {t(statusKey)}
          {step.status === 'running' && plan.status === 'running' && timing.runningSince !== null ? (
            <>
              {' · '}
              <BotGroupElapsed since={timing.runningSince} />
            </>
          ) : null}
          {doneAt !== undefined ? ` · ${formatBotTimelineClock(doneAt, timing.locale)}` : null}
        </span>
      ) : null}
    </>
  );
}

const STEP_ROW_CLASS = 'flex w-full min-w-0 items-center gap-2.5 px-3.5 py-2 text-left';

/** A step of the open, not yet started plan: click to hand it to someone else or remove it. */
function EditableStepRow({
  plan,
  step,
  index,
  identity,
  members,
  disabled,
  allowRemove,
  onEdit,
  timing,
}: {
  plan: BotGroupPlanView;
  step: BotGroupPlanStepView;
  index: number;
  identity: AvatarIdentity;
  members: readonly BotGroupMemberView[];
  disabled: boolean;
  /** Steps are removed only before 开始. */
  allowRemove: boolean;
  onEdit: (step: BotGroupPlanStepView, action: 'reassign' | 'remove', botId?: string) => void;
  timing: StepTiming;
}) {
  const { t } = useTranslation();
  const candidates = members.filter(member => isActiveBotGroupMember(member) && (!member.actorKind || member.actorKind === 'bot'));
  const lastStep = plan.steps.length <= 1;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          data-testid="bot-group-plan-step"
          className={cn(
            STEP_ROW_CLASS,
            'outline-none transition-colors enabled:hover:bg-[var(--model-item-hover)] focus-visible:bg-[var(--model-item-hover)] data-[state=open]:bg-[var(--model-item-hover)] disabled:opacity-60',
          )}
        >
          <StepRowContent plan={plan} step={step} index={index} identity={identity} muted={false} timing={timing} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>
          {t('bots.groupChat.plan.stepMenuTitle')}
        </DropdownMenuLabel>
        {candidates.map((member) => {
          const current = member.botId === step.botId;
          return (
            <DropdownMenuItem
              key={member.botId}
              className={cn(MENU_ITEM_CLASS, current && 'font-medium')}
              onSelect={() => {
                if (!current) onEdit(step, 'reassign', member.botId);
              }}
            >
              <BotAvatar bot={member} size="xs" className="h-6 w-6 text-12" />
              <span className="min-w-0 flex-1 truncate">{member.name}</span>
              {current ? <Check size={14} aria-hidden className="shrink-0 text-[var(--text-secondary)]" /> : null}
            </DropdownMenuItem>
          );
        })}
        {allowRemove ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={lastStep}
              variant="danger"
              className={MENU_ITEM_CLASS}
              onSelect={() => onEdit(step, 'remove')}
            >
              <span className="min-w-0 flex-1 truncate">{t('bots.groupChat.plan.removeStep')}</span>
              {lastStep ? (
                <span className="shrink-0 text-12 leading-[1.33] text-[var(--cmd-palette-item-meta)]">
                  {t('bots.groupChat.plan.keepOneStep')}
                </span>
              ) : null}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const FINAL_NOTE_KEYS: Partial<Record<BotGroupPlanView['status'], string>> = {
  superseded: 'bots.groupChat.plan.superseded',
  dismissed: 'bots.groupChat.plan.dismissed',
  stopped: 'bots.groupChat.plan.stopped',
};

/** A long queue shows this many turns around the current one until it is expanded. */
const QUEUE_VISIBLE_STEPS = 3;

/** The turns a folded queue shows: the one before the current turn, it, and the next. */
export function botGroupQueueWindow(plan: BotGroupPlanView): { start: number; end: number } {
  const count = plan.steps.length;
  // Folding away a single turn saves nothing.
  if (count <= QUEUE_VISIBLE_STEPS + 1) return { start: 0, end: count };
  const active = plan.steps.findIndex((step) => step.status !== 'done');
  const start = Math.min(Math.max((active < 0 ? count - 1 : active) - 1, 0), count - QUEUE_VISIBLE_STEPS);
  return { start, end: start + QUEUE_VISIBLE_STEPS };
}

/**
 * Body of the 安排卡. A legacy plan is the organizer's message (the usual Bot header plus the
 * 负责人 tag). A server queue (`kind: 'talk'`) stands on its own under the request: only its turns,
 * folded to a few around the current one.
 * `actionable` = the group's open plan, still waiting for 开始;
 * `reassignable` = the open plan stopped after a step (steps not done can change hands).
 */
export function BotGroupPlanCard({
  plan,
  members,
  actionable,
  reassignable = false,
  pending,
  runningSince = null,
  doneAt,
  locale = 'en',
  onStart,
  onDismiss,
  onEditStep,
  onAutoContinueChange,
}: {
  plan: BotGroupPlanView | undefined;
  members: readonly BotGroupMemberView[];
  actionable: boolean;
  reassignable?: boolean;
  pending: BotGroupPlanCardAction | null;
  /** When the running step started (its Session's turn, else the plan's last change). */
  runningSince?: number | null;
  /** Finish time of each done step (1-based), from its hand-off message. */
  doneAt?: ReadonlyMap<number, number>;
  locale?: string;
  onStart: () => void;
  onDismiss: () => void;
  onEditStep: (step: BotGroupPlanStepView, action: 'reassign' | 'remove', botId?: string) => void;
  /** Present for whoever may press 继续 on this open 分工: switch between waiting and going on by itself. */
  onAutoContinueChange?: (on: boolean) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  if (!plan) {
    return <p className="text-12 text-[var(--text-tertiary)]">{t('bots.groupChat.plan.missing')}</p>;
  }
  const muted = plan.status === 'superseded' || plan.status === 'dismissed';
  const autoContinue = plan.autoContinue;
  const finalNote = FINAL_NOTE_KEYS[plan.status];
  const busy = pending !== null;
  const timing: StepTiming = { runningSince, doneAt, locale };
  const canReassign = reassignable && plan.steps.some((step) => step.status === 'pending' || step.status === 'failed');
  const underWay = plan.status === 'running' || plan.status === 'waiting';
  // Only a server queue stands on its own; a division of work keeps its organizer card and actions.
  const arranged = plan.kind === 'talk';
  const turns = arranged ? botGroupQueueWindow(plan) : { start: 0, end: plan.steps.length };
  const folded = !expanded && turns.end - turns.start < plan.steps.length;
  const shown = folded ? plan.steps.slice(turns.start, turns.end) : plan.steps;
  return (
    <div data-testid="bot-group-plan" data-plan-status={plan.status} data-plan-kind={plan.kind} className="flex min-w-0 flex-col">
      {arranged ? null : (
        <p className="min-w-0 text-15 font-normal leading-[1.6] text-[var(--msg-assistant-text)]">
          {t('bots.groupChat.plan.intro', { count: plan.steps.length })}
        </p>
      )}
      <div className={cn('w-fit min-w-0 max-w-full overflow-hidden',
        // A legacy plan sits inside the organizer's bubble; an arrangement is its own card.
        arranged ? 'rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)]' : 'mt-2 rounded-lg bg-[var(--surface)]')}>
        <ol className="flex flex-col py-1.5">
          {shown.map((step, shownIndex) => {
            const index = folded ? turns.start + shownIndex : shownIndex;
            const identity = stepIdentity(step, members);
            const editable =
              actionable || (reassignable && (step.status === 'pending' || step.status === 'failed'));
            return (
              <li key={step.position} className="min-w-0">
                {editable ? (
                  <EditableStepRow
                    plan={plan}
                    step={step}
                    index={index}
                    identity={identity}
                    members={members}
                    disabled={busy}
                    allowRemove={actionable}
                    onEdit={onEditStep}
                    timing={timing}
                  />
                ) : (
                  <div data-testid="bot-group-plan-step" className={STEP_ROW_CLASS}>
                    <StepRowContent plan={plan} step={step} index={index} identity={identity} muted={muted} timing={timing} />
                  </div>
                )}
              </li>
            );
          })}
        </ol>
        {actionable ? (
          <div className="flex flex-wrap items-center gap-2 px-3.5 pb-1 pt-1">
            <Button
              type="button"
              variant="cta"
              size="sm"
              compact
              loading={pending === 'start'}
              disabled={busy}
              onClick={onStart}
            >
              {t('bots.groupChat.plan.start')}
            </Button>
            <Button
              type="button"
              variant="secondary"
              tone="quiet"
              size="sm"
              compact
              loading={pending === 'dismiss'}
              disabled={busy}
              onClick={onDismiss}
            >
              {t('bots.groupChat.plan.dismiss')}
            </Button>
          </div>
        ) : null}
        {arranged && turns.end - turns.start < plan.steps.length ? (
          <button
            type="button"
            data-testid="bot-group-plan-fold"
            aria-expanded={expanded}
            onClick={() => setExpanded((open) => !open)}
            className="flex w-full min-w-0 items-center gap-1 border-t border-[var(--border-default)] px-3.5 py-1.5 text-left text-12 leading-4 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            <span className="min-w-0">
              {expanded ? t('bots.groupChat.plan.foldTurns') : t('bots.groupChat.plan.allTurns', { count: plan.steps.length })}
            </span>
            {expanded ? <ChevronUp size={12} aria-hidden /> : <ChevronDown size={12} aria-hidden />}
          </button>
        ) : !arranged && (actionable || underWay) ? (
          // Card footer: how it runs on the left, what the steps offer on the right.
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-[var(--border-default)] px-3.5 py-1.5 text-11 leading-4 text-[var(--text-tertiary)]">
            {onAutoContinueChange ? (
              // Whoever may press 继续 chooses here, before or during the work (§7.4).
              <label className="flex min-w-0 cursor-pointer items-center gap-2 text-12 leading-4 text-[var(--text-secondary)]">
                <Switch
                  data-testid="bot-group-plan-auto"
                  checked={autoContinue === true}
                  disabled={busy}
                  onCheckedChange={onAutoContinueChange}
                />
                <span className="min-w-0">{t('bots.groupChat.plan.autoContinue')}</span>
              </label>
            ) : (
              <span className="min-w-0">{t(autoContinue ? 'bots.groupChat.plan.autoNote' : 'bots.groupChat.plan.pauseNote')}</span>
            )}
            {actionable || canReassign ? (
              <span className="ml-auto min-w-0 truncate">{t('bots.groupChat.plan.editHint')}</span>
            ) : null}
          </div>
        ) : null}
      </div>
      {finalNote ? <p className="mt-1.5 text-12 text-[var(--text-tertiary)]">{t(finalNote)}</p> : null}
    </div>
  );
}

/** Files a step created or changed, under its hand-off message. */
export function BotGroupHandoffFiles({ files, workDir }: { files: readonly string[]; workDir: string | null }) {
  if (files.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {files.map((file) => (
        <BotGroupHandoffFileChip key={file} file={file} workDir={workDir} />
      ))}
    </div>
  );
}

function BotGroupHandoffFileChip({ file, workDir }: { file: string; workDir: string | null }) {
  const { t } = useTranslation();
  const name = botGroupPathBasename(file);
  const open = async () => {
    // Only files inside the plan's work directory open (product rule §7.4).
    const absPath = botGroupPlanFilePath(workDir, file);
    if (!absPath) {
      toast.error(t('bots.groupChat.files.openFailed'));
      return;
    }
    try {
      const result = await window.electronAPI.openPath(absPath);
      if (shouldShowOpenPathError(result)) toast.error(t('bots.groupChat.files.openFailed'));
    } catch {
      toast.error(t('bots.groupChat.files.openFailed'));
    }
  };
  const chip = (
    <button
      type="button"
      onClick={() => void open()}
      className="inline-flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] pl-2.5 pr-3 text-12 text-[var(--text-primary)] outline-none transition-colors hover:bg-[var(--button-secondary-hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
    >
      <FileTypeIcon name={name} size={13} className="shrink-0 text-[var(--text-secondary)]" />
      <span className="min-w-0 truncate">{name}</span>
    </button>
  );
  // Nested files show where they live; the chip itself stays short.
  return name === file ? chip : <Tip text={file}>{chip}</Tip>;
}

function DividerRow({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div data-testid={testId} className="flex select-none items-center gap-3 text-12 text-[var(--text-tertiary)]">
      <span aria-hidden className="h-px min-w-6 flex-1 bg-[var(--border-default)]" />
      {children}
      <span aria-hidden className="h-px min-w-6 flex-1 bg-[var(--border-default)]" />
    </div>
  );
}

/** 「N 步都做完了」 — closes a finished plan in the timeline. */
export function BotGroupPlanEndDivider({ stepCount }: { stepCount: number | null }) {
  const { t } = useTranslation();
  return (
    <DividerRow testId="bot-group-plan-end">
      <span>
        {stepCount
          ? t('bots.groupChat.timeline.planDone', { count: stepCount })
          : t('bots.groupChat.timeline.planDoneGeneric')}
      </span>
    </DividerRow>
  );
}

export type BotGroupFollowUpAction = 'continue' | 'retry' | 'dismiss';

/** Under an open plan that stopped after a step: continue with the next one, or retry. */
export function BotGroupPlanFollowUpRow({
  talk = false,
  plan,
  followUp,
  members,
  pending,
  onContinue,
  onRetry,
  onEnd,
}: {
  /** A discussion's turns: the end button only ends the discussion. */
  talk?: boolean;
  plan?: BotGroupPlanView;
  followUp: BotGroupPlanFollowUp;
  members: readonly BotGroupMemberView[];
  pending: BotGroupFollowUpAction | null;
  onContinue: () => void;
  onRetry: () => void;
  onEnd: () => void;
}) {
  const { t } = useTranslation();
  const step = followUp.kind === 'continue' ? followUp.next : followUp.failed;
  const identity = stepIdentity(step, members);
  const busy = pending !== null;
  return (
    <DividerRow testId="bot-group-plan-follow-up">
      {followUp.kind === 'continue' ? (
        <span className="flex min-w-0 items-center gap-1.5 text-[var(--text-secondary)]">
          <span className="shrink-0">{t('bots.groupChat.timeline.nextStep')}</span>
          <BotAvatar bot={identity} size="xs" />
          <span className="shrink-0 font-medium text-[var(--text-primary)]">{identity.name}</span>
          <span className="min-w-0 truncate">{plan ? botGroupStepTask(plan, step, t) : step.task}</span>
        </span>
      ) : (
        <span className="min-w-0 truncate text-[var(--text-secondary)]">
          {t('bots.groupChat.timeline.stepFailed', { name: identity.name })}
        </span>
      )}
      <span className="flex shrink-0 items-center gap-1">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          compact
          loading={pending === (followUp.kind === 'continue' ? 'continue' : 'retry')}
          disabled={busy}
          onClick={followUp.kind === 'continue' ? onContinue : onRetry}
        >
          {t(followUp.kind === 'continue' ? 'bots.groupChat.timeline.continuePlan' : 'bots.groupChat.timeline.retryStep')}
        </Button>
        <Button
          type="button"
          variant="secondary"
          tone="quiet"
          size="sm"
          compact
          loading={pending === 'dismiss'}
          disabled={busy}
          onClick={onEnd}
        >
          {t(talk ? 'bots.groupChat.timeline.endTalk' : 'bots.groupChat.timeline.endPlan')}
        </Button>
      </span>
    </DividerRow>
  );
}
