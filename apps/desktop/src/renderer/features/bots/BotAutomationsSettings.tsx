import { useMemo, useState } from 'react';
import { ChevronRight, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { Schedule } from '@cindy/maker-scheduler';
import { teammateFolderName, teammateFolderOfProjectPath } from '@cindy/maker-shared/teammate-project';
import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import { useSchedules } from '../scheduler/hooks/useSchedules';
import { cronToHuman } from '../../../shared/scheduleCronLabel';
import { formatLastRun, formatNextRun } from '../scheduler/lib/formatters';
import { useBotTranslation } from './botPronounContext';

/** The automations of a teammate's own project, as in the Automations page. */
export function teammateProjectSchedules(schedules: readonly Schedule[], botId: string): Schedule[] {
  const folder = teammateFolderName(botId);
  return schedules.filter((schedule) => schedule.workspaceKind !== 'dialogue'
    && teammateFolderOfProjectPath(schedule.workingDir) === folder);
}

/**
 * The 「自动化」 page of a V2 teammate (2026-11-10 owner): its project's automations with their timing
 * and an on/off switch. Editing stays in the Automations page, which each row opens.
 */
export function BotAutomationsSettings({ bot, beforeLeave }: {
  bot: { id: string; name: string; homeDir?: string | null };
  /** Saves pending profile edits before leaving for the Automations page. */
  beforeLeave?: () => Promise<boolean>;
}) {
  const { t } = useBotTranslation();
  const { t: tr, i18n } = useTranslation();
  const navigate = useNavigate();
  const { confirm } = useConfirmDialog();
  const { schedules, loading, error, refresh } = useSchedules();
  const [pending, setPending] = useState<string | null>(null);
  const items = useMemo(() => teammateProjectSchedules(schedules, bot.id)
    .sort((a, b) => a.name.localeCompare(b.name)), [schedules, bot.id]);
  const workspace = items[0]?.workingDir ?? (bot.homeDir ? `${bot.homeDir.replace(/[\\/]+$/, '')}/workspace` : null);

  const open = async (path: string) => {
    if (beforeLeave && !(await beforeLeave())) return;
    navigate(path);
  };
  const toggle = async (schedule: Schedule, on: boolean) => {
    if (pending) return;
    setPending(schedule.id);
    try {
      if (on) {
        await window.electronAPI.maker.schedule.resume(schedule.id);
      } else {
        // Same as the Automations page: pausing stops runs in progress, so ask first.
        const inflight = await window.electronAPI.maker.schedule.getInflightCount(schedule.id).catch(() => 0);
        if (inflight > 0 && !(await confirm({
          title: tr('scheduler.confirm.pause.title', { name: schedule.name }),
          description: tr('scheduler.confirm.pause.withInflight', { count: inflight }),
          confirmText: tr('scheduler.confirm.pause.confirm'),
          cancelText: tr('scheduler.confirm.pause.cancel'),
        }))) return;
        await window.electronAPI.maker.schedule.pause(schedule.id);
      }
    } catch (e) {
      toast.error(tr('scheduler.toast.actionFailed', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setPending(null);
    }
  };
  const timing = (schedule: Schedule) => {
    const frequency = schedule.manual
      ? tr(schedule.webhookTrigger ? 'scheduler.webhook.title' : 'scheduler.cell.subtitleManual')
      : schedule.recurring
        ? cronToHuman(schedule.cronExpr, tr, i18n.resolvedLanguage ?? i18n.language)
        : tr('scheduler.cell.subtitleOnce');
    const last = formatLastRun(schedule.lastFiredAt, Date.now(), tr);
    const next = schedule.status === 'active' && !schedule.manual ? formatNextRun(schedule.nextFireAt, Date.now(), tr) : null;
    const when = schedule.status === 'paused' ? tr('scheduler.cell.subtitlePaused')
      : [last, next].filter(Boolean).join(' · ');
    return { frequency, when };
  };

  return <div className="space-y-4 py-3">
    <p className="text-13 leading-6 text-[var(--text-secondary)]">{t('bots.automations.description', { name: bot.name })}</p>
    {error ? <div role="alert" className="flex items-center justify-between gap-3 text-13 text-[var(--text-danger)]">
      <span>{t('bots.automations.failed')}</span>
      <Button variant="secondary" compact onClick={() => void refresh()}>{t('bots.memory.useLatest')}</Button>
    </div> : null}
    {loading ? <Spinner size={18} /> : null}
    {items.length > 0 ? <ul className="divide-y divide-[var(--border-default)] overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)]">
      {items.map((schedule) => {
        const { frequency, when } = timing(schedule);
        const expired = schedule.status === 'expired';
        return <li key={schedule.id} className="flex items-center gap-1 pr-4">
          <button type="button" onClick={() => void open(`/cc-agent/scheduled?focus=${encodeURIComponent(schedule.id)}`)}
            className="flex min-h-14 min-w-0 flex-1 items-center gap-2 py-3 pl-4 text-left outline-none hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]">
            <span className="min-w-0 flex-1">
              <span className={`block truncate text-14 ${schedule.status === 'active' ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}>{schedule.name}</span>
              <span className="mt-0.5 block truncate text-12 text-[var(--text-secondary)]">{frequency}</span>
              {when ? <span className="mt-0.5 block truncate text-12 tabular-nums text-[var(--text-tertiary)]">{when}</span> : null}
            </span>
            <ChevronRight size={14} className="shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
          </button>
          <Switch aria-label={t('bots.automations.toggle', { name: schedule.name })} checked={schedule.status === 'active'}
            disabled={expired || pending !== null} onCheckedChange={(value) => void toggle(schedule, value === true)} />
        </li>;
      })}
    </ul> : !loading && !error ? <p className="py-3 text-13 text-[var(--text-tertiary)]">{t('bots.automations.empty', { name: bot.name })}</p> : null}
    {workspace ? <Button variant="secondary" onClick={() => void open(`/cc-agent/scheduled?workingDir=${encodeURIComponent(workspace)}`)}>
      {items.length ? null : <Plus size={16} />}{t(items.length ? 'bots.automations.manage' : 'bots.automations.create')}
    </Button> : null}
  </div>;
}
