import { AuxiliaryErrorDetail, auxiliaryErrorSummary } from '@/components/settings/AuxiliaryErrorDetail';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, CircleCheck, CirclePause, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useAuxiliaryRouteHealth } from '@/hooks/useAuxiliaryRouteHealth';
import { isDataOwnerPushStampCurrent } from '@/contexts/dataOwnerGeneration';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from '@/lib/toast';
import type { AuxiliaryModelHealthEvent } from '../../../shared/auxiliaryModelHealth';

const SETTINGS_PATH = '/settings?tab=model-groups&section=personalization.auxiliaryModels';

function noticeKind(row: AuxiliaryModelHealthEvent) {
  if (row.status === 'recovered') return 'recovered';
  return row.operation ?? 'unavailable';
}

function HealthCard({ active, recovered, onDismiss }: {
  active: AuxiliaryModelHealthEvent[];
  recovered: AuxiliaryModelHealthEvent | null;
  onDismiss: (noticeId: number) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const detailId = useId();
  const latest = active[0] ?? recovered;
  if (!latest) return null;
  const kind = noticeKind(latest);
  const Icon = kind === 'recovered' ? CircleCheck : CirclePause;
  return (
    <div className="mx-3 my-2 shrink-0 rounded-xl border border-[color-mix(in_srgb,var(--notice-color)_30%,var(--border-default))] bg-[color-mix(in_srgb,var(--notice-color)_6%,var(--surface-elevated))] px-3 py-2.5 text-[var(--text-primary)]"
      style={{ '--notice-color': kind === 'recovered' ? 'var(--status-success)' : 'var(--warning-accent)' } as React.CSSProperties}>
      <div className="flex items-start gap-2.5">
        <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-full bg-[color-mix(in_srgb,var(--notice-color)_14%,var(--surface-elevated))] text-[var(--notice-color)]">
          <Icon size={18} />
        </span>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
          <div role="status" className="min-w-0 flex-[1_1_15rem]">
            <p className="text-14 font-medium leading-[1.429]">{t(`settings.auxiliaryModels.notice.${kind}`)}</p>
            <p className="mt-0.5 text-12 leading-[1.5] text-[var(--text-secondary)]">{t(`settings.auxiliaryModels.notice.${kind === 'recovered' ? 'recoveredBody' : 'unavailableBody'}`)}</p>
          </div>
          {active.length > 0 && <div className="flex max-w-full flex-wrap items-center gap-1">
            <Button variant="secondary" tone="quiet" compact size="sm" aria-expanded={expanded} aria-controls={detailId} onClick={() => setExpanded(!expanded)}>
              {t('settings.auxiliaryModels.notice.details')}
              <ChevronDown aria-hidden="true" size={13} className={cn(expanded && 'rotate-180')} />
            </Button>
            <Button variant="secondary" compact size="sm" onClick={() => navigate(SETTINGS_PATH)}>
              {t('settings.auxiliaryModels.notice.settings')}
            </Button>
          </div>}
        </div>
        {latest.noticeId !== undefined && <Button type="button" variant="secondary" tone="quiet" compact size="md"
          className="-mr-1 -mt-1 size-9 shrink-0 p-0 pointer-coarse:size-11"
          aria-label={t('settings.auxiliaryModels.notice.dismiss')} onClick={() => onDismiss(latest.noticeId!)}>
          <X size={16} aria-hidden="true" />
        </Button>}
      </div>
      {active.length > 0 && <div id={detailId} hidden={!expanded} className="mt-2 max-h-[min(12rem,28vh)] overflow-auto border-t border-[var(--border-default)] text-12 leading-relaxed [overflow-wrap:anywhere]">
        {active.map(row => <div className="pt-2" key={row.auxiliaryRef ?? JSON.stringify([row.providerId, row.model])}>
          <p className="text-[var(--text-secondary)]"><bdi className="font-medium text-[var(--text-primary)]">{row.model}</bdi>
            {' · '}{t(row.status === 'isolated' ? 'settings.auxiliaryModels.healthPaused' : 'settings.auxiliaryModels.healthMonitoring')}
            {row.attemptCount > 0 && <> · {t('settings.auxiliaryModels.attempts', { failed: row.failureCount, total: row.attemptCount })}</>}
          </p>
          <p>{auxiliaryErrorSummary(row, t)}</p>
          <AuxiliaryErrorDetail message={row.upstreamMessage} />
        </div>)}
        {recovered && <p className="pt-2">{t('settings.auxiliaryModels.healthRecovered', { model: recovered.model })}</p>}
      </div>}
    </div>
  );
}

export function AuxiliaryModelHealthBanner({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const { dataOwnerId, dataOwnerGeneration } = useAuth();
  const [recovery, setRecovery] = useState<AuxiliaryModelHealthEvent | null>(null);
  const [dismissedId, setDismissedId] = useState<number>();
  const notification = useRef<{ id: string; route: string; kind: ReturnType<typeof noticeKind> } | null>(null);
  const onChange = useCallback((event: AuxiliaryModelHealthEvent) => {
    const route = event.auxiliaryRef ?? JSON.stringify([event.providerId, event.model]);
    if (event.removed) {
      if (notification.current?.route === route) {
        toast.dismiss(notification.current.id);
        notification.current = null;
      }
      setRecovery(previous => previous?.auxiliaryRef === event.auxiliaryRef ? null : previous);
      return;
    }
    if (event.sessionId !== sessionId || event.switchedToBackup) return;
    if (event.status === 'recovered') setRecovery(event);
    if (event.notify && document.hasFocus()) {
      if (notification.current) toast.dismiss(notification.current.id);
      const id = event.status === 'recovered'
        ? toast.success(t('settings.auxiliaryModels.healthRecovered', { model: event.model }))
        : toast.warning(t(`settings.auxiliaryModels.notice.${noticeKind(event)}`));
      notification.current = { id, route, kind: noticeKind(event) };
    }
  }, [sessionId, t]);
  const rows = useAuxiliaryRouteHealth(onChange, sessionId);
  useEffect(() => {
    const current = notification.current;
    if (current && !rows.some(row => row.sessionId === sessionId && noticeKind(row) === current.kind)) {
      toast.dismiss(current.id);
      notification.current = null;
    }
  }, [rows, sessionId]);
  useEffect(() => () => {
    if (notification.current) toast.dismiss(notification.current.id);
  }, [sessionId, dataOwnerId, dataOwnerGeneration]);
  useEffect(() => {
    if (!recovery) return;
    const timer = window.setTimeout(() => setRecovery(null), 5000);
    return () => window.clearTimeout(timer);
  }, [recovery]);
  const active = rows.filter(row => !row.switchedToBackup && (!row.sessionId || row.sessionId === sessionId) &&
    (row.status === 'isolated' || row.status === 'warning')).sort((a, b) => b.lastErrorAt - a.lastErrorAt || (b.errorRevision ?? 0) - (a.errorRevision ?? 0));
  const restored = recovery && isDataOwnerPushStampCurrent(recovery.ownerStamp) &&
    (!recovery.sessionId || recovery.sessionId === sessionId) &&
    !active.some(row => row.model === recovery.model && row.providerId === recovery.providerId);
  const visible = active[0] ?? (restored ? recovery : null);
  if (!visible || (dismissedId !== undefined && dismissedId === visible.noticeId)) return null;
  const dismiss = (noticeId: number) => {
    setDismissedId(noticeId);
    if (notification.current) {
      toast.dismiss(notification.current.id);
      notification.current = null;
    }
    void window.electronAPI.maker.auxiliaryModelHealthDismiss(sessionId, noticeId)
      .catch(() => setDismissedId(current => current === noticeId ? undefined : current));
  };
  return <HealthCard key={JSON.stringify([sessionId, dataOwnerId, dataOwnerGeneration])} onDismiss={dismiss} active={active} recovered={restored ? recovery : null} />;
}
