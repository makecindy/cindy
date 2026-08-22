/**
 * Bot Automation tab — list-first, like a system scheduled-task list.
 *
 * Shape: a header with one "New" button, then the routines themselves (name +
 * plain-language schedule + on/off + Run now + status dot; click a row for its
 * detail and run history). Creating one asks two questions — what to do and
 * when — and everything else (project, delivery, run limits, notes space, time
 * zone) sits behind Advanced with a working default, so a routine can be
 * created without opening it. The IPC payload shape is unchanged; the defaults
 * live in `automationForm.ts`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Archive,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  LoaderCircle,
  Pencil,
  Paperclip,
  Play,
  Plus,
  RefreshCcw,
} from 'lucide-react';
import { useBotTranslation } from './botPronounContext';

import type { BotAutomation, BotAutomationRun } from '../../../shared/botAutomation';
import {
  AUTOMATION_TEMPLATES,
  SCHEDULE_MODES,
  automationFormValueFrom,
  automationSubmission,
  canSubmitAutomationForm,
  defaultDurableNoteNamespace,
  describeAutomationSchedule,
  emptyAutomationFormValue,
  suggestAutomationName,
  type AutomationFormValue,
  type AutomationPolicyDraft,
  type AutomationSubmission,
} from './automationForm';
import { BotAvatar } from './BotAvatar';
import { BotSettingsBlockHeading, BOT_SETTINGS_BLOCK_CLASS } from './BotSettingsBlock';
import { useBotProfiles, type BotProfile } from './botStore';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';

type ProjectBindings = NonNullable<BotProfile['projectBindings']>;
type ChannelRoutes = NonNullable<BotProfile['routes']>;

const INPUT_CLASS =
  'h-9 rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-12 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-placeholder)] focus:border-[var(--focus-ring)]';
const FIELD_CLASS = 'flex flex-col gap-1.5 text-11 text-[var(--text-secondary)]';

function readError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatTime(value?: number): string {
  return value ? new Date(value).toLocaleString() : '—';
}

function statusTone(status: string): string {
  if (status === 'success' || status === 'delivered' || status === 'active') {
    return 'text-[var(--status-success)]';
  }
  if (status === 'failed' || status === 'dead-letter' || status === 'error') {
    return 'text-[var(--text-danger)]';
  }
  return 'text-[var(--text-secondary)]';
}

/** Status dot fill mirrors `statusTone`, reusing the same registered tokens. */
function statusDotClass(status: string): string {
  if (status === 'active') return 'bg-[var(--status-success)]';
  if (status === 'error') return 'bg-[var(--text-danger)]';
  return 'bg-[var(--text-tertiary)]';
}

function RunHistory({
  automation,
  onOpenTask,
}: {
  automation: BotAutomation;
  onOpenTask: (sessionId: string) => void;
}) {
  const { t } = useBotTranslation();
  const { confirm } = useConfirmDialog();
  const [runs, setRuns] = useState<BotAutomationRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryingRunId, setRetryingRunId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRuns(await window.electronAPI.maker.botAutomations.listRuns(automation.id, 50));
    } catch (cause) {
      setError(readError(cause));
    } finally {
      setLoading(false);
    }
  }, [automation.id]);

  useEffect(() => {
    void load();
    return window.electronAPI.maker.botAutomations.onChanged((payload) => {
      if (payload.automationId === automation.id) void load();
    });
  }, [automation.id, load]);

  const retryDelivery = async (run: BotAutomationRun) => {
    const allowDuplicateRisk = run.deliveryDiagnostic?.retrySafe === false;
    if (allowDuplicateRisk) {
      const confirmed = await confirm({
        title: t('bots.automations.retryDuplicateTitle'),
        description: t('bots.automations.retryDuplicateDescription', {
          count: run.deliveryDiagnostic?.sentMediaCount ?? 0,
        }),
        confirmText: t('bots.automations.retryDuplicateConfirm'),
        cancelText: t('commonUi.confirmDialog.cancel'),
        confirmVariant: 'destructive',
      });
      if (!confirmed) return;
    }
    setRetryingRunId(run.id);
    setError(null);
    try {
      await window.electronAPI.maker.botAutomations.retryDelivery(
        automation.id,
        run.id,
        allowDuplicateRisk,
      );
      await load();
    } catch (cause) {
      setError(readError(cause));
    } finally {
      setRetryingRunId(null);
    }
  };

  if (loading) {
    return <p className="py-3 text-11 text-[var(--text-tertiary)]">{t('bots.automations.loading')}</p>;
  }
  if (error) {
    return <p className="break-words py-3 text-11 text-[var(--text-danger)] [overflow-wrap:anywhere]">{error}</p>;
  }
  if (runs.length === 0) {
    return <p className="py-3 text-11 text-[var(--text-tertiary)]">{t('bots.automations.noRuns')}</p>;
  }

  return (
    <div className="mt-2 flex flex-col gap-2">
      {runs.map((run) => (
        <div key={run.id} className="rounded-lg bg-[var(--surface-chip)] px-3 py-2 text-11">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className={statusTone(run.status)}>{t(`bots.automations.runStatus.${run.status}`)}</span>
              <span className="text-[var(--text-tertiary)]">v{run.profileVersion}</span>
            </div>
            <span className="text-[var(--text-tertiary)]">{formatTime(run.finishedAt ?? run.firedAt)}</span>
          </div>
          {run.resultText ? (
            <p className="mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-[var(--text-secondary)] [overflow-wrap:anywhere]">{run.resultText}</p>
          ) : null}
          {run.errorMessage ? (
            <p className="mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-[var(--text-danger)] [overflow-wrap:anywhere]">{run.errorMessage}</p>
          ) : null}
          {run.worktreePath ? (
            <p className="mt-2 break-all text-[var(--text-tertiary)]">
              {t('bots.automations.worktree')}: {run.worktreePath}
            </p>
          ) : null}
          {run.outputArtifacts.length > 0 ? (
            <p className="mt-2 inline-flex items-center gap-1 text-[var(--text-tertiary)]">
              <Paperclip size={12} />
              {t('bots.automations.outputArtifacts', { count: run.outputArtifacts.length })}
            </p>
          ) : null}
          {run.deliveryDiagnostic ? (
            <p className="mt-2 text-[var(--text-tertiary)]">
              {[
                run.deliveryDiagnostic.textMessageId
                  ? t('bots.automations.deliveryProgressText')
                  : null,
                run.deliveryDiagnostic.sentMediaCount > 0
                  ? t('bots.automations.deliveryProgressMedia', {
                      count: run.deliveryDiagnostic.sentMediaCount,
                    })
                  : null,
                run.deliveryDiagnostic.committedFinal
                  ? t('bots.automations.deliveryCommitted')
                  : null,
              ].filter(Boolean).join(' · ')}
            </p>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <span className={statusTone(run.deliveryStatus)}>
              {t('bots.automations.delivery')}: {t(`bots.automations.deliveryStatus.${run.deliveryStatus}`)}
            </span>
            <span className="flex items-center gap-3">
              {run.deliveryStatus === 'failed'
              || run.deliveryStatus === 'dead-letter'
              || run.deliveryStatus === 'enqueue-failed' ? (
                <button
                  type="button"
                  disabled={retryingRunId !== null}
                  onClick={() => void retryDelivery(run)}
                  className="inline-flex items-center gap-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50"
                >
                  <span className={retryingRunId === run.id ? 'inline-flex animate-spin motion-reduce:animate-none' : 'inline-flex'}>
                    <RefreshCcw size={12} />
                  </span>
                  {retryingRunId === run.id
                    ? t('bots.automations.retryingDelivery')
                    : t('bots.automations.retryDelivery')}
                </button>
              ) : null}
              {run.sessionId ? (
                <button
                  type="button"
                  onClick={() => onOpenTask(run.sessionId!)}
                  className="inline-flex items-center gap-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                >
                  <ExternalLink size={12} />
                  {t('bots.automations.openTask')}
                </button>
              ) : null}
            </span>
          </div>
          {run.deliveryError ? (
            <p className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-[var(--text-danger)] [overflow-wrap:anywhere]">{run.deliveryError}</p>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function ScheduleModePicker({
  mode,
  onChange,
}: {
  mode: AutomationFormValue['mode'];
  onChange: (mode: AutomationFormValue['mode']) => void;
}) {
  const { t } = useBotTranslation();
  return (
    <div
      role="radiogroup"
      aria-label={t('bots.automations.whenToRun')}
      className="inline-flex items-center gap-1 rounded-full border border-[var(--border-default)] p-1"
    >
      {SCHEDULE_MODES.map((candidate) => (
        <button
          key={candidate}
          type="button"
          role="radio"
          aria-checked={mode === candidate}
          onClick={() => onChange(candidate)}
          className={cn(
            'h-7 rounded-full px-3 text-11 transition-colors',
            mode === candidate
              ? 'bg-[var(--surface-chip)] font-medium text-[var(--text-primary)]'
              : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
          )}
        >
          {t(`bots.automations.mode.${candidate}`)}
        </button>
      ))}
    </div>
  );
}

function AutomationAdvancedFields({
  value,
  onChange,
  projects,
  routes,
  bots,
  currentBotId,
}: {
  value: AutomationFormValue;
  onChange: (patch: Partial<AutomationFormValue>) => void;
  projects: ProjectBindings;
  routes: ChannelRoutes;
  bots: BotProfile[];
  currentBotId: string;
}) {
  const { t } = useBotTranslation();
  const policy = value.policy;
  const updatePolicy = (patch: Partial<AutomationPolicyDraft>) =>
    onChange({ policy: { ...policy, ...patch } });
  const delegateBots = bots.filter(
    (candidate) => candidate.id !== currentBotId && candidate.enabled,
  );
  const namespacePlaceholder =
    defaultDurableNoteNamespace(value.name.trim() || suggestAutomationName(value.prompt)) ?? '';

  return (
    <div className="mt-3 rounded-xl bg-[var(--surface-chip)] p-3">
      <div className="grid gap-3 md:grid-cols-2">
        <label className={FIELD_CLASS}>
          {t('bots.automations.project')}
          <select
            value={value.projectBindingId}
            onChange={(event) => onChange({ projectBindingId: event.target.value })}
            className={INPUT_CLASS}
          >
            <option value="">{t('bots.automations.defaultProject')}</option>
            {projects.map((item) => (
              <option key={item.id} value={item.id}>{item.workingDir}</option>
            ))}
          </select>
        </label>
        <label className={FIELD_CLASS}>
          {t('bots.automations.deliveryRoute')}
          <select
            value={value.targetRouteId}
            onChange={(event) => onChange({ targetRouteId: event.target.value })}
            className={INPUT_CLASS}
          >
            <option value="">{t('bots.automations.canonicalTask')}</option>
            {routes.map((item) => (
              <option key={item.id} value={item.id}>{item.routeKey}</option>
            ))}
          </select>
        </label>
      </div>
      <label className={cn(FIELD_CLASS, 'mt-3')}>
        {t('bots.automations.timezone')}
        <input
          value={value.timezone}
          onChange={(event) => onChange({ timezone: event.target.value })}
          className={INPUT_CLASS}
        />
      </label>
      <label className={cn(FIELD_CLASS, 'mt-3')}>
        {t('bots.automations.noteNamespace')}
        <input
          value={value.durableNoteNamespace}
          placeholder={namespacePlaceholder}
          onChange={(event) => onChange({ durableNoteNamespace: event.target.value })}
          className={INPUT_CLASS}
        />
        <span className="text-[var(--text-tertiary)]">{t('bots.automations.noteNamespaceHint')}</span>
      </label>

      <p className="mt-4 text-11 font-medium text-[var(--text-primary)]">
        {t('bots.automations.executionPolicy')}
      </p>
      <p className="mt-1 text-11 leading-5 text-[var(--text-tertiary)]">
        {t('bots.automations.executionPolicyDescription')}
      </p>
      <div className="mt-3 grid gap-3 md:grid-cols-3">
        <label className={FIELD_CLASS}>
          {t('bots.automations.timeoutMinutes')}
          <input
            type="number"
            min={1}
            max={1440}
            value={policy.timeoutMinutes}
            onChange={(event) => updatePolicy({ timeoutMinutes: Number(event.target.value) })}
            className={INPUT_CLASS}
          />
        </label>
      </div>
      <label className={cn(FIELD_CLASS, 'mt-3')}>
        {t('bots.automations.delegateTargets')}
        <select
          value={policy.delegateTargetMode}
          onChange={(event) =>
            updatePolicy({
              delegateTargetMode: event.target.value as AutomationPolicyDraft['delegateTargetMode'],
              allowedDelegateBotIds:
                event.target.value === 'allowlist' ? policy.allowedDelegateBotIds : [],
            })
          }
          className={INPUT_CLASS}
        >
          <option value="none">{t('bots.automations.delegateNone')}</option>
          <option value="allowlist">{t('bots.automations.delegateAllowlist')}</option>
          <option value="all-active">{t('bots.automations.delegateAllActive')}</option>
        </select>
      </label>
      {/*
        Token 预算与最大协同深度**只有委派路径读它们**:runner 把它们放进
        `plan.limits`,唯一消费方是 botDelegationService 的子任务准入与结算。
        「可协作的伙伴」停在默认的「不允许调用其它伙伴」时,这条 Routine 永远不会
        派活,这两个输入框于是完全惰性 —— 填了不生效、也没有任何地方会告诉用户。
        两个能填、能存、却什么都不管的框就是假开关,所以它们跟着委派开关一起出现:
        真的会派活时才摆出来,并就地说明它们管的是子任务、不是这条 Routine 自己。
      */}
      {policy.delegateTargetMode === 'none' ? null : (
        <>
          <p className="mt-3 text-11 leading-5 text-[var(--text-tertiary)]">
            {t('bots.automations.delegateLimitsHint')}
          </p>
          <div className="mt-2 grid gap-3 md:grid-cols-2">
            <label className={FIELD_CLASS}>
              {t('bots.automations.budgetTokens')}
              <input
                inputMode="numeric"
                value={policy.budgetTokens}
                placeholder={t('bots.automations.unlimited')}
                onChange={(event) =>
                  updatePolicy({ budgetTokens: event.target.value.replace(/\D/g, '') })
                }
                className={INPUT_CLASS}
              />
            </label>
            <label className={FIELD_CLASS}>
              {t('bots.automations.maxDelegationDepth')}
              <input
                type="number"
                min={1}
                max={5}
                value={policy.maxDelegationDepth}
                onChange={(event) =>
                  updatePolicy({ maxDelegationDepth: Number(event.target.value) })
                }
                className={INPUT_CLASS}
              />
            </label>
          </div>
        </>
      )}
      {policy.delegateTargetMode === 'allowlist' ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {delegateBots.length === 0 ? (
            <span className="text-11 text-[var(--text-tertiary)]">
              {t('bots.automations.noDelegateBots')}
            </span>
          ) : delegateBots.map((candidate) => {
            const checked = policy.allowedDelegateBotIds.includes(candidate.id);
            return (
              <label
                key={candidate.id}
                className="inline-flex items-center gap-2 rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-2.5 py-2 text-11 text-[var(--text-secondary)]"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() =>
                    updatePolicy({
                      allowedDelegateBotIds: checked
                        ? policy.allowedDelegateBotIds.filter((id) => id !== candidate.id)
                        : [...policy.allowedDelegateBotIds, candidate.id],
                    })
                  }
                />
                {/* Shared mark instead of raw `avatar` text: a Bot on the
                    official Cindy avatar stores a sentinel, not a grapheme. */}
                <BotAvatar bot={candidate} size="sm" className="h-4 w-4 text-11" />
                <span>{candidate.name}</span>
              </label>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function AutomationForm({
  initial,
  submitLabel,
  submittingLabel,
  fallbackCronExpr,
  projects,
  routes,
  bots,
  currentBotId,
  onSubmit,
  onCancel,
}: {
  initial: AutomationFormValue;
  submitLabel: string;
  submittingLabel: string;
  fallbackCronExpr?: string;
  projects: ProjectBindings;
  routes: ChannelRoutes;
  bots: BotProfile[];
  currentBotId: string;
  onSubmit: (submission: AutomationSubmission) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useBotTranslation();
  const [value, setValue] = useState<AutomationFormValue>(initial);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = (patch: Partial<AutomationFormValue>) =>
    setValue((current) => ({ ...current, ...patch }));

  // On success both call sites close the form, so `submitting` is only cleared
  // on failure — the form stays disabled while it is being torn down.
  const submit = async () => {
    const submission = automationSubmission(value, { fallbackCronExpr });
    if (!submission) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(submission);
    } catch (cause) {
      setError(readError(cause));
      setSubmitting(false);
    }
  };

  return (
    <div className="mt-4 rounded-xl border border-[var(--border-default)] p-4">
      <label className={FIELD_CLASS}>
        <span className="text-12 font-medium text-[var(--text-primary)]">
          {t('bots.automations.whatToDo')}
        </span>
        <textarea
          value={value.prompt}
          onChange={(event) => update({ prompt: event.target.value })}
          rows={3}
          placeholder={t('bots.automations.whatToDoPlaceholder')}
          className="resize-y rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-2 text-12 leading-5 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-placeholder)] focus:border-[var(--focus-ring)]"
        />
      </label>

      <div className="mt-4 flex flex-col gap-2">
        <span className="text-12 font-medium text-[var(--text-primary)]">
          {t('bots.automations.whenToRun')}
        </span>
        <div className="flex flex-wrap items-end gap-3">
          <ScheduleModePicker mode={value.mode} onChange={(mode) => update({ mode })} />
          {value.mode === 'daily' ? (
            <label className={FIELD_CLASS}>
              {t('bots.automations.dailyTime')}
              <input
                type="time"
                value={value.dailyTime}
                onChange={(event) => update({ dailyTime: event.target.value })}
                className={INPUT_CLASS}
              />
            </label>
          ) : null}
          {value.mode === 'interval' ? (
            <label className={FIELD_CLASS}>
              {t('bots.automations.intervalMinutes')}
              <input
                type="number"
                min={1}
                value={value.intervalMinutes}
                onChange={(event) => update({ intervalMinutes: Number(event.target.value) })}
                className={cn(INPUT_CLASS, 'w-28')}
              />
            </label>
          ) : null}
          {value.mode === 'cron' ? (
            <label className={FIELD_CLASS}>
              {t('bots.automations.cronExpr')}
              <input
                value={value.cronExpr}
                onChange={(event) => update({ cronExpr: event.target.value })}
                className={cn(INPUT_CLASS, 'w-44 font-mono')}
              />
            </label>
          ) : null}
        </div>
        <p className="text-11 leading-5 text-[var(--text-tertiary)]">
          {value.mode === 'manual'
            ? t('bots.automations.manualHint')
            : value.mode === 'cron'
              ? t('bots.automations.cronHint')
              : t('bots.automations.timezoneHint', { timezone: value.timezone })}
        </p>
      </div>

      <label className={cn(FIELD_CLASS, 'mt-4 max-w-sm')}>
        {t('bots.automations.name')}
        <input
          value={value.name}
          placeholder={suggestAutomationName(value.prompt) || t('bots.automations.nameAuto')}
          onChange={(event) => update({ name: event.target.value })}
          className={INPUT_CLASS}
        />
      </label>

      <button
        type="button"
        aria-expanded={advancedOpen}
        onClick={() => setAdvancedOpen((current) => !current)}
        className="mt-4 inline-flex items-center gap-1.5 text-11 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
      >
        {advancedOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {t('bots.automations.advanced')}
        <span className="text-[var(--text-tertiary)]">{t('bots.automations.advancedHint')}</span>
      </button>
      {advancedOpen ? (
        <AutomationAdvancedFields
          value={value}
          onChange={update}
          projects={projects}
          routes={routes}
          bots={bots}
          currentBotId={currentBotId}
        />
      ) : null}

      {error ? (
        <p className="mt-3 break-words text-11 text-[var(--text-danger)] [overflow-wrap:anywhere]">{error}</p>
      ) : null}
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          disabled={submitting}
          onClick={onCancel}
          className="h-9 rounded-full px-4 text-12 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
        >
          {t('bots.cancel')}
        </button>
        <button
          type="button"
          disabled={submitting || !canSubmitAutomationForm(value)}
          onClick={() => void submit()}
          className="inline-flex h-9 items-center gap-2 rounded-full bg-[var(--accent-cta-bg)] px-4 text-12 font-medium text-[var(--accent-pure-cta-fg)] disabled:opacity-50"
        >
          {submitting ? submittingLabel : submitLabel}
        </button>
      </div>
    </div>
  );
}

function AutomationRow({
  automation,
  projects,
  routes,
  currentProfileVersion,
  bots,
  currentBotId,
  onChanged,
  onOpenTask,
}: {
  automation: BotAutomation;
  projects: ProjectBindings;
  routes: ChannelRoutes;
  currentProfileVersion: number;
  bots: BotProfile[];
  currentBotId: string;
  onChanged: () => Promise<void>;
  onOpenTask: (sessionId: string) => void;
}) {
  const { t } = useBotTranslation();
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<'toggle' | 'run' | 'archive' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (kind: NonNullable<typeof busy>, action: () => Promise<unknown>) => {
    setBusy(kind);
    setError(null);
    try {
      await action();
      await onChanged();
    } catch (cause) {
      setError(readError(cause));
    } finally {
      setBusy(null);
    }
  };

  const schedule = describeAutomationSchedule(automation);
  const statusLabel = t(`bots.automations.status.${automation.status}`);
  const running = automation.activeRunCount > 0;
  const enabled = automation.status === 'active';

  return (
    <div className="rounded-xl border border-[var(--border-default)]">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          {expanded ? (
            <ChevronDown className="shrink-0 text-[var(--text-tertiary)]" size={14} />
          ) : (
            <ChevronRight className="shrink-0 text-[var(--text-tertiary)]" size={14} />
          )}
          <span className="min-w-0">
            <span className="block truncate text-13 font-medium text-[var(--text-primary)]">
              {automation.name}
            </span>
            <span className="mt-0.5 block truncate text-11 text-[var(--text-tertiary)]">
              {t(schedule.key, schedule.params)}
            </span>
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-1.5">
          {running ? (
            <LoaderCircle
              size={13}
              className="animate-spin text-[var(--text-secondary)] motion-reduce:animate-none"
              aria-label={t('bots.automations.activeRuns', { count: automation.activeRunCount })}
            />
          ) : (
            <span
              role="img"
              aria-label={statusLabel}
              title={statusLabel}
              className={cn('h-2 w-2 rounded-full', statusDotClass(automation.status))}
            />
          )}
          <button
            type="button"
            disabled={busy !== null || !enabled}
            onClick={() =>
              void act('run', () => window.electronAPI.maker.botAutomations.runNow(automation.id))
            }
            className="inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-11 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] disabled:opacity-50"
          >
            <Play size={12} />
            {t('bots.automations.runNow')}
          </button>
          <Switch
            checked={enabled}
            disabled={busy !== null}
            aria-label={t('bots.automations.enableRoutine')}
            onCheckedChange={(next) =>
              void act('toggle', () =>
                next
                  ? window.electronAPI.maker.botAutomations.resume(automation.id)
                  : window.electronAPI.maker.botAutomations.pause(automation.id),
              )
            }
          />
        </div>
      </div>

      {expanded ? (
        <div className="border-t border-[var(--border-default)] px-3 pb-3 pt-3">
          <p className="whitespace-pre-wrap break-words text-11 leading-5 text-[var(--text-secondary)] [overflow-wrap:anywhere]">
            {automation.prompt}
          </p>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-11 text-[var(--text-tertiary)]">
            <span>{t('bots.automations.nextRun')}: {formatTime(automation.nextFireAt)}</span>
            <span>
              {t('bots.automations.lastRun')}: {formatTime(automation.lastFinishedAt ?? automation.lastFiredAt)}
            </span>
            <span>{t('bots.automations.timezone')}: {automation.timezone}</span>
            <span>{t('bots.automations.nextProfileVersion', { version: currentProfileVersion })}</span>
          </div>
          {error ? (
            <p className="mt-3 break-words text-11 text-[var(--text-danger)] [overflow-wrap:anywhere]">{error}</p>
          ) : null}
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <button
              type="button"
              disabled={busy !== null || automation.activeRunCount > 0}
              onClick={() => setEditing((current) => !current)}
              className="inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-11 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
            >
              <Pencil size={13} /> {t('bots.automations.edit')}
            </button>
            <button
              type="button"
              disabled={busy !== null || automation.activeRunCount > 0}
              onClick={() =>
                void act('archive', () =>
                  window.electronAPI.maker.botAutomations.delete(automation.id),
                )
              }
              className="inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-11 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
            >
              <Archive size={13} /> {t('bots.automations.archive')}
            </button>
          </div>
          {editing ? (
            <AutomationForm
              initial={automationFormValueFrom(automation)}
              submitLabel={t('bots.save')}
              submittingLabel={t('bots.automations.saving')}
              fallbackCronExpr={automation.cronExpr}
              projects={projects}
              routes={routes}
              bots={bots}
              currentBotId={currentBotId}
              onSubmit={async (submission) => {
                await window.electronAPI.maker.botAutomations.update(automation.id, submission);
                await onChanged();
                setEditing(false);
              }}
              onCancel={() => setEditing(false)}
            />
          ) : null}
          <p className="mt-4 text-11 font-medium text-[var(--text-primary)]">
            {t('bots.automations.runHistory')}
          </p>
          <RunHistory automation={automation} onOpenTask={onOpenTask} />
        </div>
      ) : null}
    </div>
  );
}

export function BotAutomationSettings({
  bot,
  trusted,
  onOpenTask,
}: {
  bot: BotProfile;
  trusted: boolean;
  onOpenTask: (sessionId: string) => void;
}) {
  const { t } = useBotTranslation();
  const bots = useBotProfiles();
  const [automations, setAutomations] = useState<BotAutomation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<AutomationFormValue | null>(null);

  /*
    Trusted is the one precondition that stays.

    别把它和刚下线的那些假开关混为一谈 —— 判据是「这个门背后有没有真实约束,
    以及用户有没有地方去开」:

     - `capabilities.automation`(「定时干活」):没有真实约束(Routine 建了就跑),
       开关却常年显示「关」→ 已归一为标配,开关删除。
     - `capabilities.sessionControlMode`(「其它任务权限」):委派链路根本不查它,
       默认值还写着「不可访问」→ 下拉删除。
     - `capabilities.permissions`(这一条):**约束是真的** —— 无人值守跑的时候
       没有人能回答 canUseTool 的授权卡,所以 'ask' 的伙伴跑不了 Routine。
       同一条判定在另外两处也拦着,不是 UI 装饰:
         · maker-ipc/bot-automation.ts(创建时 INVALID_PARAMS)
         · scheduler-host/bot-automation-runner.ts(每次触发前)
       而且它有真实控制点:和 TA 的对话里、输入框上的权限选择(选「完全访问」
       即 bypassPermissions,经 botComposerRuntime 回写成 permissions:'trusted')。
       `bots.automations.trustedRequired` 那句话就指向那里 —— 旧文案说的
       「权限模式设为"信任操作"并保存」指的是已经删掉的设置页开关。
  */
  const canCreate = trusted;
  const activeProjects = useMemo(
    () => (bot.projectBindings ?? []).filter((item) => item.status === 'active'),
    [bot.projectBindings],
  );
  const activeRoutes = useMemo(
    () => (bot.routes ?? []).filter((item) => item.status === 'active'),
    [bot.routes],
  );
  const visibleAutomations = useMemo(
    () => automations.filter((item) => item.status !== 'archived'),
    [automations],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setAutomations(await window.electronAPI.maker.botAutomations.list(bot.id));
    } catch (cause) {
      setError(readError(cause));
    } finally {
      setLoading(false);
    }
  }, [bot.id]);

  useEffect(() => {
    void load();
    return window.electronAPI.maker.botAutomations.onChanged((payload) => {
      if (payload.botId === bot.id) void load();
    });
  }, [bot.id, load]);

  return (
    <section className={BOT_SETTINGS_BLOCK_CLASS}>
      {/* 主路径上这一块叫「TA 的日程」,不叫「伙伴自动化」——它跟「TA 是谁 /
          TA 会的 / TA 懂的」是同一排的一块,得说同一种话。「自动化」「Routine」
          这类实现词留在高级里。 */}
      <BotSettingsBlockHeading
        icon={CalendarClock}
        title={t('bots.settingsBlocks.schedule')}
        /* 「到点自己干,不用你在」只在还没有日程时说 —— 已经排了活的人不需要再被
           讲一遍这块是干什么的。空态本身也会解释,所以这句一旦有内容就撤掉。 */
        hint={visibleAutomations.length === 0 ? t('bots.settingsBlocks.scheduleDescription') : undefined}
        action={
          <>
            <button
              type="button"
              onClick={() => void load()}
              className="inline-flex h-9 w-9 items-center justify-center rounded-full text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)]"
              aria-label={t('bots.automations.refresh')}
            >
              <RefreshCcw
                size={14}
                className={loading ? 'animate-spin motion-reduce:animate-none' : undefined}
              />
            </button>
            {canCreate ? (
              <button
                type="button"
                onClick={() => setDraft((current) => (current ? null : emptyAutomationFormValue()))}
                className="inline-flex h-9 items-center gap-1.5 rounded-full bg-[var(--accent-cta-bg)] px-4 text-12 font-medium text-[var(--accent-pure-cta-fg)]"
              >
                <Plus size={13} />
                {t('bots.automations.newRoutine')}
              </button>
            ) : null}
          </>
        }
      />

      {!trusted ? (
        <p className="mt-4 rounded-xl bg-[var(--warning-bg-soft)] px-3 py-3 text-12 text-[var(--warning-fg)]">
          {t('bots.automations.trustedRequired')}
        </p>
      ) : null}

      {canCreate && draft ? (
        <AutomationForm
          initial={draft}
          submitLabel={t('bots.automations.create')}
          submittingLabel={t('bots.automations.creating')}
          projects={activeProjects}
          routes={activeRoutes}
          bots={bots}
          currentBotId={bot.id}
          onSubmit={async (submission) => {
            await window.electronAPI.maker.botAutomations.create({
              botId: bot.id,
              ...submission,
            });
            setDraft(null);
            await load();
          }}
          onCancel={() => setDraft(null)}
        />
      ) : null}

      {loading ? (
        <p className="mt-4 text-12 text-[var(--text-tertiary)]">{t('bots.automations.loading')}</p>
      ) : error ? (
        <p className="mt-4 break-words text-12 text-[var(--text-danger)] [overflow-wrap:anywhere]">{error}</p>
      ) : visibleAutomations.length > 0 ? (
        <div className="mt-4 flex flex-col gap-2">
          {visibleAutomations.map((automation) => (
            <AutomationRow
              key={automation.id}
              automation={automation}
              projects={activeProjects}
              routes={activeRoutes}
              currentProfileVersion={bot.currentVersion ?? automation.createdWithProfileVersion}
              bots={bots}
              currentBotId={bot.id}
              onChanged={load}
              onOpenTask={onOpenTask}
            />
          ))}
        </div>
      ) : draft ? null : (
        <div className="mt-4 rounded-xl border border-dashed border-[var(--border-default)] px-4 py-5">
          <p className="text-12 leading-5 text-[var(--text-secondary)]">
            {t('bots.automations.empty')}
          </p>
          {canCreate ? (
            <>
              <p className="mt-3 text-11 text-[var(--text-tertiary)]">
                {t('bots.automations.templates.hint')}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {AUTOMATION_TEMPLATES.map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    onClick={() =>
                      setDraft(
                        emptyAutomationFormValue({
                          ...template.value,
                          prompt: t(`bots.automations.templates.${template.id}.prompt`),
                        }),
                      )
                    }
                    className="rounded-full border border-[var(--border-default)] px-3 py-1.5 text-11 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
                  >
                    {t(`bots.automations.templates.${template.id}.name`)}
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </div>
      )}
    </section>
  );
}
