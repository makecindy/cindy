import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Archive,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  CirclePause,
  CirclePlay,
  ExternalLink,
  Pencil,
  Paperclip,
  Plus,
  RefreshCcw,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type {
  BotAutomation,
  BotAutomationExecutionPolicy,
  BotAutomationRun,
  CreateBotAutomationInput,
  UpdateBotAutomationInput,
} from '../../../shared/botAutomation';
import { DEFAULT_BOT_AUTOMATION_EXECUTION_POLICY } from '../../../shared/botAutomation';
import { BotAvatar } from './BotAvatar';
import { useBotProfiles, type BotProfile } from './botStore';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';

type ScheduleMode = 'manual' | 'daily' | 'interval' | 'cron';

interface AutomationPolicyDraft {
  timeoutMinutes: number;
  budgetTokens: string;
  maxDelegationDepth: number;
  delegateTargetMode: BotAutomationExecutionPolicy['delegateTargetMode'];
  allowedDelegateBotIds: string[];
}

function policyDraft(policy: BotAutomationExecutionPolicy): AutomationPolicyDraft {
  return {
    timeoutMinutes: Math.max(1, Math.round(policy.timeoutMs / 60_000)),
    budgetTokens: policy.budgetTokens === null ? '' : String(policy.budgetTokens),
    maxDelegationDepth: policy.maxDelegationDepth,
    delegateTargetMode: policy.delegateTargetMode,
    allowedDelegateBotIds: policy.allowedDelegateBotIds,
  };
}

function executionPolicyFromDraft(draft: AutomationPolicyDraft): BotAutomationExecutionPolicy {
  const parsedBudget = Number(draft.budgetTokens);
  return {
    timeoutMs: Math.max(1, Math.floor(draft.timeoutMinutes)) * 60_000,
    budgetTokens: draft.budgetTokens.trim() && Number.isSafeInteger(parsedBudget) && parsedBudget > 0
      ? parsedBudget
      : null,
    maxDelegationDepth: Math.max(1, Math.min(5, Math.floor(draft.maxDelegationDepth))),
    delegateTargetMode: draft.delegateTargetMode,
    allowedDelegateBotIds: draft.delegateTargetMode === 'allowlist'
      ? draft.allowedDelegateBotIds
      : [],
  };
}

function AutomationPolicyFields({
  draft,
  onChange,
  bots,
  currentBotId,
}: {
  draft: AutomationPolicyDraft;
  onChange: (draft: AutomationPolicyDraft) => void;
  bots: BotProfile[];
  currentBotId: string;
}) {
  const { t } = useTranslation();
  const delegateBots = bots.filter((candidate) => candidate.id !== currentBotId && candidate.enabled);
  return (
    <div className="mt-3 rounded-xl bg-[var(--surface-chip)] p-3">
      <p className="text-11 font-medium text-[var(--text-primary)]">
        {t('bots.automations.executionPolicy')}
      </p>
      <p className="mt-1 text-11 leading-5 text-[var(--text-tertiary)]">
        {t('bots.automations.executionPolicyDescription')}
      </p>
      <div className="mt-3 grid gap-3 md:grid-cols-3">
        <label className="flex flex-col gap-1.5 text-11 text-[var(--text-secondary)]">
          {t('bots.automations.timeoutMinutes')}
          <input type="number" min={1} max={1440} value={draft.timeoutMinutes} onChange={(event) => onChange({ ...draft, timeoutMinutes: Number(event.target.value) })} className="h-9 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-12 text-[var(--text-primary)]" />
        </label>
        <label className="flex flex-col gap-1.5 text-11 text-[var(--text-secondary)]">
          {t('bots.automations.budgetTokens')}
          <input inputMode="numeric" value={draft.budgetTokens} onChange={(event) => onChange({ ...draft, budgetTokens: event.target.value.replace(/\D/g, '') })} placeholder={t('bots.automations.unlimited')} className="h-9 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-12 text-[var(--text-primary)]" />
        </label>
        <label className="flex flex-col gap-1.5 text-11 text-[var(--text-secondary)]">
          {t('bots.automations.maxDelegationDepth')}
          <input type="number" min={1} max={5} value={draft.maxDelegationDepth} onChange={(event) => onChange({ ...draft, maxDelegationDepth: Number(event.target.value) })} className="h-9 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-12 text-[var(--text-primary)]" />
        </label>
      </div>
      <label className="mt-3 flex flex-col gap-1.5 text-11 text-[var(--text-secondary)]">
        {t('bots.automations.delegateTargets')}
        <select value={draft.delegateTargetMode} onChange={(event) => onChange({ ...draft, delegateTargetMode: event.target.value as AutomationPolicyDraft['delegateTargetMode'], allowedDelegateBotIds: event.target.value === 'allowlist' ? draft.allowedDelegateBotIds : [] })} className="h-9 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-12 text-[var(--text-primary)]">
          <option value="none">{t('bots.automations.delegateNone')}</option>
          <option value="allowlist">{t('bots.automations.delegateAllowlist')}</option>
          <option value="all-active">{t('bots.automations.delegateAllActive')}</option>
        </select>
      </label>
      {draft.delegateTargetMode === 'allowlist' ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {delegateBots.length === 0 ? (
            <span className="text-11 text-[var(--text-tertiary)]">{t('bots.automations.noDelegateBots')}</span>
          ) : delegateBots.map((candidate) => {
            const checked = draft.allowedDelegateBotIds.includes(candidate.id);
            return (
              <label key={candidate.id} className="inline-flex items-center gap-2 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-2.5 py-2 text-11 text-[var(--text-secondary)]">
                <input type="checkbox" checked={checked} onChange={() => onChange({ ...draft, allowedDelegateBotIds: checked ? draft.allowedDelegateBotIds.filter((id) => id !== candidate.id) : [...draft.allowedDelegateBotIds, candidate.id] })} />
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

function localTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

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

function modeForAutomation(automation: BotAutomation): ScheduleMode {
  if (automation.manual) return 'manual';
  if (automation.intervalMs) return 'interval';
  return /^\d{1,2} \d{1,2} \* \* \*$/.test(automation.cronExpr) ? 'daily' : 'cron';
}

function dailyTimeForAutomation(automation: BotAutomation): string {
  const match = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(automation.cronExpr);
  if (!match) return '09:00';
  return `${match[2]!.padStart(2, '0')}:${match[1]!.padStart(2, '0')}`;
}

function RunHistory({
  automation,
  onOpenTask,
}: {
  automation: BotAutomation;
  onOpenTask: (sessionId: string) => void;
}) {
  const { t } = useTranslation();
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
    <div className="mt-3 flex flex-col gap-2 border-t border-[var(--border-default)] pt-3">
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

function AutomationEditForm({
  automation,
  projects,
  routes,
  bots,
  currentBotId,
  onSaved,
  onCancel,
}: {
  automation: BotAutomation;
  projects: NonNullable<BotProfile['projectBindings']>;
  routes: NonNullable<BotProfile['routes']>;
  bots: BotProfile[];
  currentBotId: string;
  onSaved: () => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(automation.name);
  const [prompt, setPrompt] = useState(automation.prompt);
  const [mode, setMode] = useState<ScheduleMode>(() => modeForAutomation(automation));
  const [dailyTime, setDailyTime] = useState(() => dailyTimeForAutomation(automation));
  const [intervalMinutes, setIntervalMinutes] = useState(
    Math.max(1, Math.round((automation.intervalMs ?? 60 * 60_000) / 60_000)),
  );
  const [cronExpr, setCronExpr] = useState(automation.cronExpr);
  const [timezone, setTimezone] = useState(automation.timezone);
  const [projectBindingId, setProjectBindingId] = useState(automation.projectBindingId ?? '');
  const [targetRouteId, setTargetRouteId] = useState(automation.targetRouteId ?? '');
  const [durableNoteNamespace, setDurableNoteNamespace] = useState(
    automation.durableNoteNamespace ?? '',
  );
  const [executionPolicy, setExecutionPolicy] = useState<AutomationPolicyDraft>(() =>
    policyDraft(automation.executionPolicy),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!name.trim() || !prompt.trim()) return;
    setSaving(true);
    setError(null);
    try {
      let cadence: Pick<
        UpdateBotAutomationInput,
        'cronExpr' | 'recurring' | 'manual' | 'intervalMs'
      >;
      if (mode === 'manual') {
        cadence = {
          cronExpr: automation.cronExpr || '0 0 * * *',
          recurring: false,
          manual: true,
          intervalMs: undefined,
        };
      } else if (mode === 'daily') {
        const [hour, minute] = dailyTime.split(':').map(Number);
        cadence = {
          cronExpr: `${minute || 0} ${hour || 0} * * *`,
          recurring: true,
          manual: false,
          intervalMs: undefined,
        };
      } else if (mode === 'interval') {
        cadence = {
          cronExpr: automation.cronExpr || '0 * * * *',
          recurring: true,
          manual: false,
          intervalMs: Math.max(1, intervalMinutes) * 60_000,
        };
      } else {
        cadence = {
          cronExpr: cronExpr.trim(),
          recurring: true,
          manual: false,
          intervalMs: undefined,
        };
      }
      await window.electronAPI.maker.botAutomations.update(automation.id, {
        name: name.trim(),
        prompt: prompt.trim(),
        timezone: timezone.trim() || 'UTC',
        ...cadence,
        projectBindingId: projectBindingId || null,
        targetRouteId: targetRouteId || null,
        durableNoteNamespace: durableNoteNamespace.trim() || null,
        executionPolicy: executionPolicyFromDraft(executionPolicy),
      });
      await onSaved();
    } catch (cause) {
      setError(readError(cause));
      return;
    } finally {
      setSaving(false);
    }
    onCancel();
  };

  return (
    <div className="mt-3 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-3">
      <div className="grid gap-3 md:grid-cols-2">
        <label className="flex flex-col gap-1.5 text-11 text-[var(--text-secondary)]">
          {t('bots.automations.name')}
          <input value={name} onChange={(event) => setName(event.target.value)} className="h-9 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-12 text-[var(--text-primary)]" />
        </label>
        <label className="flex flex-col gap-1.5 text-11 text-[var(--text-secondary)]">
          {t('bots.automations.schedule')}
          <select value={mode} onChange={(event) => setMode(event.target.value as ScheduleMode)} className="h-9 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-12 text-[var(--text-primary)]">
            <option value="manual">{t('bots.automations.manual')}</option>
            <option value="daily">{t('bots.automations.daily')}</option>
            <option value="interval">{t('bots.automations.interval')}</option>
            <option value="cron">Cron</option>
          </select>
        </label>
      </div>
      <label className="mt-3 flex flex-col gap-1.5 text-11 text-[var(--text-secondary)]">
        {t('bots.automations.instruction')}
        <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={4} className="resize-y rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-2 text-12 text-[var(--text-primary)]" />
      </label>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {mode === 'daily' ? (
          <label className="flex flex-col gap-1.5 text-11 text-[var(--text-secondary)]">{t('bots.automations.dailyTime')}<input type="time" value={dailyTime} onChange={(event) => setDailyTime(event.target.value)} className="h-9 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-12 text-[var(--text-primary)]" /></label>
        ) : mode === 'interval' ? (
          <label className="flex flex-col gap-1.5 text-11 text-[var(--text-secondary)]">{t('bots.automations.intervalMinutes')}<input type="number" min={1} value={intervalMinutes} onChange={(event) => setIntervalMinutes(Number(event.target.value))} className="h-9 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-12 text-[var(--text-primary)]" /></label>
        ) : mode === 'cron' ? (
          <label className="flex flex-col gap-1.5 text-11 text-[var(--text-secondary)]">Cron<input value={cronExpr} onChange={(event) => setCronExpr(event.target.value)} className="h-9 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 font-mono text-12 text-[var(--text-primary)]" /></label>
        ) : <div />}
        {mode !== 'manual' ? (
          <label className="flex flex-col gap-1.5 text-11 text-[var(--text-secondary)]">{t('bots.automations.timezone')}<input value={timezone} onChange={(event) => setTimezone(event.target.value)} className="h-9 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-12 text-[var(--text-primary)]" /></label>
        ) : null}
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-3">
        <label className="flex flex-col gap-1.5 text-11 text-[var(--text-secondary)]">{t('bots.automations.project')}<select value={projectBindingId} onChange={(event) => setProjectBindingId(event.target.value)} className="h-9 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-2 text-11 text-[var(--text-primary)]"><option value="">{t('bots.automations.defaultProject')}</option>{projects.map((item) => <option key={item.id} value={item.id}>{item.workingDir}</option>)}</select></label>
        <label className="flex flex-col gap-1.5 text-11 text-[var(--text-secondary)]">{t('bots.automations.deliveryRoute')}<select value={targetRouteId} onChange={(event) => setTargetRouteId(event.target.value)} className="h-9 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-2 text-11 text-[var(--text-primary)]"><option value="">{t('bots.automations.canonicalTask')}</option>{routes.map((item) => <option key={item.id} value={item.id}>{item.routeKey}</option>)}</select></label>
        <label className="flex flex-col gap-1.5 text-11 text-[var(--text-secondary)]">{t('bots.automations.noteNamespace')}<input value={durableNoteNamespace} onChange={(event) => setDurableNoteNamespace(event.target.value)} className="h-9 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-11 text-[var(--text-primary)]" /></label>
      </div>
      <AutomationPolicyFields
        draft={executionPolicy}
        onChange={setExecutionPolicy}
        bots={bots}
        currentBotId={currentBotId}
      />
      {error ? <p className="mt-3 text-11 text-[var(--text-danger)]">{error}</p> : null}
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" disabled={saving} onClick={onCancel} className="h-8 rounded-lg px-3 text-11 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-50">{t('bots.cancel')}</button>
        <button type="button" disabled={saving || !name.trim() || !prompt.trim()} onClick={() => void save()} className="h-8 rounded-lg bg-[var(--accent-cta-bg)] px-3 text-11 font-medium text-[var(--accent-pure-cta-fg)] disabled:opacity-50">{saving ? t('bots.automations.saving') : t('bots.save')}</button>
      </div>
    </div>
  );
}

function AutomationCard({
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
  projects: NonNullable<BotProfile['projectBindings']>;
  routes: NonNullable<BotProfile['routes']>;
  currentProfileVersion: number;
  bots: BotProfile[];
  currentBotId: string;
  onChanged: () => Promise<void>;
  onOpenTask: (sessionId: string) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<'pause' | 'resume' | 'run' | 'archive' | null>(null);
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

  return (
    <div className="rounded-xl border border-[var(--border-default)] p-4">
      <div className="flex items-start justify-between gap-3">
        <button type="button" onClick={() => setExpanded((value) => !value)} className="flex min-w-0 items-start gap-2 text-left">
          {expanded ? <ChevronDown className="mt-0.5 shrink-0" size={14} /> : <ChevronRight className="mt-0.5 shrink-0" size={14} />}
          <span className="min-w-0">
            <span className="block truncate text-13 font-medium text-[var(--text-primary)]">{automation.name}</span>
            <span className="mt-1 block text-11 text-[var(--text-tertiary)]">
              {automation.manual
                ? t('bots.automations.manual')
                : automation.intervalMs
                  ? t('bots.automations.everyMinutes', { count: Math.round(automation.intervalMs / 60_000) })
                  : `${automation.cronExpr} · ${automation.timezone}`}
            </span>
          </span>
        </button>
        <span className={statusTone(automation.status)}>{t(`bots.automations.status.${automation.status}`)}</span>
      </div>
      <p className="mt-3 line-clamp-3 whitespace-pre-wrap text-11 leading-5 text-[var(--text-secondary)]">{automation.prompt}</p>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-11 text-[var(--text-tertiary)]">
        <span>{t('bots.automations.nextRun')}: {formatTime(automation.nextFireAt)}</span>
        <span>{t('bots.automations.nextProfileVersion', { version: currentProfileVersion })}</span>
        <span>{t('bots.automations.activeRuns', { count: automation.activeRunCount })}</span>
      </div>
      {error ? <p className="mt-3 text-11 text-[var(--text-danger)]">{error}</p> : null}
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <button type="button" disabled={busy !== null || automation.activeRunCount > 0} onClick={() => setEditing((value) => !value)} className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-11 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-50">
          <Pencil size={13} /> {t('bots.automations.edit')}
        </button>
        {automation.status === 'active' ? (
          <button type="button" disabled={busy !== null} onClick={() => void act('pause', () => window.electronAPI.maker.botAutomations.pause(automation.id))} className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-11 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-50">
            <CirclePause size={13} /> {t('bots.automations.pause')}
          </button>
        ) : automation.status === 'paused' || automation.status === 'error' ? (
          <button type="button" disabled={busy !== null} onClick={() => void act('resume', () => window.electronAPI.maker.botAutomations.resume(automation.id))} className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-11 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-50">
            <CirclePlay size={13} /> {t('bots.automations.resume')}
          </button>
        ) : null}
        <button type="button" disabled={busy !== null || automation.status !== 'active'} onClick={() => void act('run', () => window.electronAPI.maker.botAutomations.runNow(automation.id))} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--border-default)] px-2.5 text-11 text-[var(--text-primary)] hover:bg-[var(--surface-hover)] disabled:opacity-50">
          <CirclePlay size={13} /> {t('bots.automations.runNow')}
        </button>
        <button type="button" disabled={busy !== null || automation.activeRunCount > 0} onClick={() => void act('archive', () => window.electronAPI.maker.botAutomations.delete(automation.id))} className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-11 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-50">
          <Archive size={13} /> {t('bots.automations.archive')}
        </button>
      </div>
      {editing ? (
        <AutomationEditForm
          automation={automation}
          projects={projects}
          routes={routes}
          bots={bots}
          currentBotId={currentBotId}
          onSaved={onChanged}
          onCancel={() => setEditing(false)}
        />
      ) : null}
      {expanded ? <RunHistory automation={automation} onOpenTask={onOpenTask} /> : null}
    </div>
  );
}

export function BotAutomationSettings({
  bot,
  enabled,
  trusted,
  onOpenTask,
}: {
  bot: BotProfile;
  enabled: boolean;
  trusted: boolean;
  onOpenTask: (sessionId: string) => void;
}) {
  const { t } = useTranslation();
  const bots = useBotProfiles();
  const [automations, setAutomations] = useState<BotAutomation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState<ScheduleMode>('manual');
  const [dailyTime, setDailyTime] = useState('09:00');
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const [cronExpr, setCronExpr] = useState('0 9 * * *');
  const [timezone, setTimezone] = useState(localTimezone);
  const [projectBindingId, setProjectBindingId] = useState('');
  const [targetRouteId, setTargetRouteId] = useState('');
  const [durableNoteNamespace, setDurableNoteNamespace] = useState('');
  const [executionPolicy, setExecutionPolicy] = useState<AutomationPolicyDraft>(() =>
    policyDraft(DEFAULT_BOT_AUTOMATION_EXECUTION_POLICY),
  );

  const activeProjects = useMemo(() => (bot.projectBindings ?? []).filter((item) => item.status === 'active'), [bot.projectBindings]);
  const activeRoutes = useMemo(() => (bot.routes ?? []).filter((item) => item.status === 'active'), [bot.routes]);

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

  const create = async () => {
    if (!name.trim() || !prompt.trim()) return;
    setCreating(true);
    setError(null);
    try {
      let schedule: Pick<CreateBotAutomationInput, 'cronExpr' | 'recurring' | 'manual' | 'intervalMs'>;
      if (mode === 'manual') {
        schedule = { cronExpr: '0 0 * * *', recurring: false, manual: true };
      } else if (mode === 'daily') {
        const [hour, minute] = dailyTime.split(':').map(Number);
        schedule = { cronExpr: `${minute || 0} ${hour || 0} * * *`, recurring: true, manual: false };
      } else if (mode === 'interval') {
        schedule = { cronExpr: '0 * * * *', recurring: true, manual: false, intervalMs: Math.max(1, intervalMinutes) * 60_000 };
      } else {
        schedule = { cronExpr: cronExpr.trim(), recurring: true, manual: false };
      }
      await window.electronAPI.maker.botAutomations.create({
        botId: bot.id,
        name: name.trim(),
        prompt: prompt.trim(),
        timezone: timezone.trim() || 'UTC',
        ...schedule,
        projectBindingId: projectBindingId || null,
        targetRouteId: targetRouteId || null,
        durableNoteNamespace: durableNoteNamespace.trim() || null,
        executionPolicy: executionPolicyFromDraft(executionPolicy),
      });
      setName('');
      setPrompt('');
      setDurableNoteNamespace('');
      await load();
    } catch (cause) {
      setError(readError(cause));
    } finally {
      setCreating(false);
    }
  };

  return (
    <section className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5">
      <div className="flex items-center gap-2 text-14 font-medium text-[var(--text-primary)]">
        <CalendarClock size={16} />
        {t('bots.automations.title')}
      </div>
      <p className="mt-1 text-12 leading-5 text-[var(--text-secondary)]">{t('bots.automations.description')}</p>
      {!enabled ? (
        <p className="mt-4 rounded-xl border border-dashed border-[var(--border-default)] px-3 py-3 text-12 text-[var(--text-tertiary)]">{t('bots.automations.enableFirst')}</p>
      ) : !trusted ? (
        <p className="mt-4 rounded-xl bg-[var(--warning-bg-soft)] px-3 py-3 text-12 text-[var(--warning-fg)]">{t('bots.automations.trustedRequired')}</p>
      ) : null}

      {enabled && trusted ? (
        <div className="mt-4 rounded-xl border border-[var(--border-default)] p-4">
          <p className="text-12 font-medium text-[var(--text-primary)]">{t('bots.automations.addTitle')}</p>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <label className="flex flex-col gap-1.5 text-11 text-[var(--text-secondary)]">
              {t('bots.automations.name')}
              <input value={name} onChange={(event) => setName(event.target.value)} className="h-9 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-12 text-[var(--text-primary)] outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)]" />
            </label>
            <label className="flex flex-col gap-1.5 text-11 text-[var(--text-secondary)]">
              {t('bots.automations.schedule')}
              <select value={mode} onChange={(event) => setMode(event.target.value as ScheduleMode)} className="h-9 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-12 text-[var(--text-primary)] outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)]">
                <option value="manual">{t('bots.automations.manual')}</option>
                <option value="daily">{t('bots.automations.daily')}</option>
                <option value="interval">{t('bots.automations.interval')}</option>
                <option value="cron">Cron</option>
              </select>
            </label>
          </div>
          <label className="mt-3 flex flex-col gap-1.5 text-11 text-[var(--text-secondary)]">
            {t('bots.automations.instruction')}
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={4} className="resize-y rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-2 text-12 text-[var(--text-primary)] outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)]" />
          </label>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            {mode === 'daily' ? (
              <label className="flex flex-col gap-1.5 text-11 text-[var(--text-secondary)]">{t('bots.automations.dailyTime')}<input type="time" value={dailyTime} onChange={(event) => setDailyTime(event.target.value)} className="h-9 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-12 text-[var(--text-primary)]" /></label>
            ) : mode === 'interval' ? (
              <label className="flex flex-col gap-1.5 text-11 text-[var(--text-secondary)]">{t('bots.automations.intervalMinutes')}<input type="number" min={1} value={intervalMinutes} onChange={(event) => setIntervalMinutes(Number(event.target.value))} className="h-9 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-12 text-[var(--text-primary)]" /></label>
            ) : mode === 'cron' ? (
              <label className="flex flex-col gap-1.5 text-11 text-[var(--text-secondary)]">Cron<input value={cronExpr} onChange={(event) => setCronExpr(event.target.value)} className="h-9 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 font-mono text-12 text-[var(--text-primary)]" /></label>
            ) : <div />}
            {mode !== 'manual' ? (
              <label className="flex flex-col gap-1.5 text-11 text-[var(--text-secondary)]">{t('bots.automations.timezone')}<input value={timezone} onChange={(event) => setTimezone(event.target.value)} className="h-9 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-12 text-[var(--text-primary)]" /></label>
            ) : null}
          </div>
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            <label className="flex flex-col gap-1.5 text-11 text-[var(--text-secondary)]">{t('bots.automations.project')}<select value={projectBindingId} onChange={(event) => setProjectBindingId(event.target.value)} className="h-9 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-2 text-11 text-[var(--text-primary)]"><option value="">{t('bots.automations.defaultProject')}</option>{activeProjects.map((item) => <option key={item.id} value={item.id}>{item.workingDir}</option>)}</select></label>
            <label className="flex flex-col gap-1.5 text-11 text-[var(--text-secondary)]">{t('bots.automations.deliveryRoute')}<select value={targetRouteId} onChange={(event) => setTargetRouteId(event.target.value)} className="h-9 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-2 text-11 text-[var(--text-primary)]"><option value="">{t('bots.automations.canonicalTask')}</option>{activeRoutes.map((item) => <option key={item.id} value={item.id}>{item.routeKey}</option>)}</select></label>
            <label className="flex flex-col gap-1.5 text-11 text-[var(--text-secondary)]">{t('bots.automations.noteNamespace')}<input value={durableNoteNamespace} onChange={(event) => setDurableNoteNamespace(event.target.value)} placeholder="daily-report" className="h-9 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-11 text-[var(--text-primary)]" /></label>
          </div>
          <AutomationPolicyFields
            draft={executionPolicy}
            onChange={setExecutionPolicy}
            bots={bots}
            currentBotId={bot.id}
          />
          <div className="mt-4 flex justify-end">
            <button type="button" disabled={creating || !name.trim() || !prompt.trim()} onClick={() => void create()} className="inline-flex h-8 items-center gap-2 rounded-lg bg-[var(--accent-cta-bg)] px-3 text-11 font-medium text-[var(--accent-pure-cta-fg)] disabled:opacity-50"><Plus size={13} />{creating ? t('bots.automations.creating') : t('bots.automations.create')}</button>
          </div>
        </div>
      ) : null}

      <div className="mt-4 flex items-center justify-between gap-3">
        <p className="text-12 font-medium text-[var(--text-primary)]">{t('bots.automations.listTitle')}</p>
        <button type="button" onClick={() => void load()} className="rounded-lg p-1.5 text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)]" aria-label={t('bots.automations.refresh')}><RefreshCcw size={14} /></button>
      </div>
      {loading ? <p className="mt-3 text-12 text-[var(--text-tertiary)]">{t('bots.automations.loading')}</p> : error ? <p className="mt-3 text-12 text-[var(--text-danger)]">{error}</p> : automations.filter((item) => item.status !== 'archived').length === 0 ? <p className="mt-3 rounded-xl border border-dashed border-[var(--border-default)] px-3 py-3 text-12 text-[var(--text-tertiary)]">{t('bots.automations.empty')}</p> : <div className="mt-3 flex flex-col gap-3">{automations.filter((item) => item.status !== 'archived').map((automation) => <AutomationCard key={automation.id} automation={automation} projects={activeProjects} routes={activeRoutes} currentProfileVersion={bot.currentVersion ?? automation.createdWithProfileVersion} bots={bots} currentBotId={bot.id} onChanged={load} onOpenTask={onOpenTask} />)}</div>}
    </section>
  );
}
