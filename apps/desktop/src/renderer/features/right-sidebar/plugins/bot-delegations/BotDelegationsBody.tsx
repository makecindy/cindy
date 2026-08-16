import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, ArrowLeft, ExternalLink, LoaderCircle, Paperclip, RefreshCw, Share2, Square } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  isDataOwnerPushCurrent,
} from '@/contexts/dataOwnerGeneration';
import { isSidebarWindow } from '@/lib/sidebarWindow';
import type { BotDelegationStatus, BotDelegationView } from '../../../../../shared/botDelegation';
import type { TabKindHostContext } from '../../types';
import type { BotDelegationsState } from './index';

const ACTIVE_STATUSES = new Set<BotDelegationStatus>(['queued', 'waiting', 'running']);

interface Props {
  state: BotDelegationsState;
  ctx: TabKindHostContext;
  active?: boolean;
  shellVisible?: boolean;
}

function formatDuration(start: number, end: number): string {
  const seconds = Math.max(0, Math.floor((end - start) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function statusClass(status: BotDelegationStatus): string {
  if (status === 'completed') return 'text-[var(--status-success)]';
  if (status === 'failed' || status === 'timed-out') return 'text-[var(--status-danger)]';
  if (status === 'cancelled') return 'text-[var(--text-tertiary)]';
  return 'text-[var(--status-info)]';
}

export function BotDelegationsBody({ state, ctx, active = true, shellVisible = true }: Props) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const navigate = useNavigate();
  const visible = active && shellVisible;
  const [rows, setRows] = useState<BotDelegationView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [retryingDeliveryId, setRetryingDeliveryId] = useState<string | null>(null);
  const selected = useMemo(
    () => rows.find((row) => row.id === state.selectedDelegationId) ?? null,
    [rows, state.selectedDelegationId],
  );

  const load = useCallback(async () => {
    const owner = getDataOwnerGeneration();
    setLoading(true);
    try {
      const result = await window.electronAPI.maker.listBotDelegations(ctx.sessionId);
      if (!isDataOwnerGenerationCurrent(owner)) return;
      if (!result.ok) throw new Error(result.message);
      setRows(result.delegations);
      setError(null);
    } catch (loadError) {
      if (isDataOwnerGenerationCurrent(owner)) {
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    } finally {
      if (isDataOwnerGenerationCurrent(owner)) setLoading(false);
    }
  }, [ctx.sessionId]);

  useEffect(() => {
    if (!visible) return;
    void load();
    const off = window.electronAPI.maker.onBotDelegationChanged((payload, ownerStamp) => {
      if (!isDataOwnerPushCurrent(ownerStamp) || payload.parentSessionId !== ctx.sessionId) return;
      void load();
    });
    return off;
  }, [ctx.sessionId, load, visible]);

  useEffect(() => {
    if (!visible) return;
    const requestingBotId = rows[0]?.requestingBotId;
    if (!requestingBotId) return;
    return window.electronAPI.maker.botDeliveries.onChanged((payload, ownerStamp) => {
      if (!isDataOwnerPushCurrent(ownerStamp) || payload.botId !== requestingBotId) return;
      void load();
    });
  }, [load, rows, visible]);

  const openChild = useCallback(async (row: BotDelegationView) => {
    if (!row.childSessionId) return;
    if (isSidebarWindow()) {
      await window.electronAPI.maker.openSessionInNewWindow(row.childSessionId);
      return;
    }
    navigate(`/bots/${encodeURIComponent(row.targetBotId)}/session/${encodeURIComponent(row.childSessionId)}`);
  }, [navigate]);

  const cancel = useCallback(async (row: BotDelegationView) => {
    setCancellingId(row.id);
    try {
      const result = await window.electronAPI.maker.cancelBotDelegation(ctx.sessionId, row.id);
      if (!result.ok) throw new Error(result.message);
      await load();
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : String(cancelError));
    } finally {
      setCancellingId(null);
    }
  }, [ctx.sessionId, load]);

  const retryCompletionDelivery = useCallback(async (row: BotDelegationView) => {
    const delivery = row.completionDelivery;
    if (!delivery) return;
    const duplicateRisk = delivery.diagnostic?.retrySafe === false;
    if (duplicateRisk) {
      const approved = await confirm({
        title: t('bots.lifecycle.deliveries.duplicateTitle'),
        description: t('bots.lifecycle.deliveries.duplicateDescription', {
          count: delivery.diagnostic?.sentMediaCount ?? 0,
        }),
        confirmText: t('bots.lifecycle.deliveries.duplicateConfirm'),
        cancelText: t('commonUi.confirmDialog.cancel'),
        confirmVariant: 'destructive',
      });
      if (!approved) return;
    }
    setRetryingDeliveryId(delivery.id);
    try {
      await window.electronAPI.maker.botDeliveries.retry(
        row.requestingBotId,
        delivery.id,
        duplicateRisk,
      );
      await load();
    } catch (retryError) {
      setError(retryError instanceof Error ? retryError.message : String(retryError));
    } finally {
      setRetryingDeliveryId(null);
    }
  }, [confirm, load, t]);

  if (loading && rows.length === 0) {
    return <div className="flex min-h-0 flex-1 items-center justify-center text-[var(--text-tertiary)]"><span className="inline-flex animate-spin motion-reduce:animate-none"><LoaderCircle size={20} /></span></div>;
  }
  if (error && rows.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-8 text-center">
        <AlertCircle size={20} className="text-[var(--status-danger)]" />
        <p className="mt-3 text-12 text-[var(--text-secondary)]">{error}</p>
        <button type="button" onClick={() => void load()} className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--border-default)] px-3 text-12 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"><RefreshCw size={13} />{t('rightSidebar.botDelegations.retry')}</button>
      </div>
    );
  }
  if (selected) {
    const endedAt = selected.completedAt ?? Date.now();
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-default)] px-3">
          <button type="button" onClick={() => ctx.patchState({ selectedDelegationId: null })} aria-label={t('rightSidebar.botDelegations.back')} className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"><ArrowLeft size={15} /></button>
          <span className="min-w-0 flex-1 truncate text-13 font-medium text-[var(--text-primary)]">{selected.targetBotName}</span>
          <span className={`text-11 ${statusClass(selected.status)}`}>{t(`rightSidebar.botDelegations.status.${selected.status}`)}</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-12">
            <dt className="text-[var(--text-tertiary)]">{t('rightSidebar.botDelegations.duration')}</dt><dd className="text-[var(--text-secondary)]">{formatDuration(selected.createdAt, endedAt)}</dd>
            <dt className="text-[var(--text-tertiary)]">{t('rightSidebar.botDelegations.tokens')}</dt><dd className="text-[var(--text-secondary)]">{selected.tokensUsed}{selected.budgetTokens ? ` / ${selected.budgetTokens}` : ''}</dd>
            <dt className="text-[var(--text-tertiary)]">{t('rightSidebar.botDelegations.depth')}</dt><dd className="text-[var(--text-secondary)]">{selected.depth}</dd>
          </dl>
          <h3 className="mb-2 mt-5 text-11 font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)]">{t('rightSidebar.botDelegations.objective')}</h3>
          <p className="whitespace-pre-wrap text-12 leading-5 text-[var(--text-primary)]">{selected.objective}</p>
          {selected.resultSummary ? <><h3 className="mb-2 mt-5 text-11 font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)]">{t('rightSidebar.botDelegations.result')}</h3><p className="whitespace-pre-wrap text-12 leading-5 text-[var(--text-primary)]">{selected.resultSummary}</p></> : null}
          {selected.outputArtifacts.length > 0 ? (
            <div className="mt-5">
              <h3 className="mb-2 inline-flex items-center gap-1.5 text-11 font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)]">
                <Paperclip size={12} />
                {t('bots.automations.outputArtifacts', { count: selected.outputArtifacts.length })}
              </h3>
              <ul className="flex flex-col gap-1.5">
                {selected.outputArtifacts.map((artifact) => (
                  <li key={`${artifact.kind}:${artifact.ref}`} className="break-all rounded-lg bg-[var(--surface-subtle)] px-3 py-2 text-11 text-[var(--text-secondary)]">
                    <span className="mr-2 text-[var(--text-tertiary)]">{artifact.kind}</span>
                    {artifact.ref}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {selected.completionDelivery ? (
            <div className="mt-5 rounded-lg bg-[var(--surface-subtle)] px-3 py-2 text-11">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[var(--text-tertiary)]">{t('bots.lifecycle.deliveries.title')}</span>
                <span className={selected.completionDelivery.status === 'delivered'
                  ? 'text-[var(--status-success)]'
                  : selected.completionDelivery.status === 'failed' || selected.completionDelivery.status === 'dead-letter'
                    ? 'text-[var(--status-danger)]'
                    : 'text-[var(--text-tertiary)]'}>
                  {t(`bots.lifecycle.deliveries.status.${selected.completionDelivery.status}`)}
                </span>
              </div>
              {selected.completionDelivery.lastError ? (
                <p className="mt-1 whitespace-pre-wrap text-[var(--status-danger)]">{selected.completionDelivery.lastError}</p>
              ) : null}
              {selected.completionDelivery.status === 'failed' || selected.completionDelivery.status === 'dead-letter' ? (
                <button
                  type="button"
                  disabled={retryingDeliveryId !== null}
                  onClick={() => void retryCompletionDelivery(selected)}
                  className="mt-2 inline-flex items-center gap-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50"
                >
                  <span className={retryingDeliveryId === selected.completionDelivery.id ? 'inline-flex animate-spin motion-reduce:animate-none' : 'inline-flex'}>
                    <RefreshCw size={12} />
                  </span>
                  {retryingDeliveryId === selected.completionDelivery.id
                    ? t('bots.lifecycle.deliveries.retrying')
                    : t('bots.lifecycle.deliveries.retry')}
                </button>
              ) : null}
            </div>
          ) : null}
          {selected.lastError ? <p className="mt-4 rounded-lg bg-[var(--surface-subtle)] px-3 py-2 text-12 text-[var(--status-danger)]">{selected.lastError}</p> : null}
          <div className="mt-5 flex gap-2">
            {selected.childSessionId ? <button type="button" onClick={() => void openChild(selected)} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--border-default)] px-3 text-12 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"><ExternalLink size={13} />{t('rightSidebar.botDelegations.openTask')}</button> : null}
            {ACTIVE_STATUSES.has(selected.status) ? <button type="button" disabled={cancellingId === selected.id} onClick={() => void cancel(selected)} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--border-default)] px-3 text-12 text-[var(--status-danger)] hover:bg-[var(--surface-hover)] disabled:opacity-60"><Square size={12} />{t('rightSidebar.botDelegations.stop')}</button> : null}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-default)] px-4"><Share2 size={15} className="text-[var(--text-secondary)]" /><h2 className="text-13 font-medium text-[var(--text-primary)]">{t('rightSidebar.tabs.kinds.botDelegations')}</h2></div>
      {error ? <div className="mx-3 mt-3 rounded-lg bg-[var(--surface-subtle)] px-3 py-2 text-11 text-[var(--status-danger)]">{error}</div> : null}
      {rows.length === 0 ? <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-8 text-center"><Share2 size={20} className="text-[var(--text-tertiary)]" /><p className="mt-3 text-13 font-medium text-[var(--text-secondary)]">{t('rightSidebar.botDelegations.empty')}</p><p className="mt-1 text-12 leading-5 text-[var(--text-tertiary)]">{t('rightSidebar.botDelegations.emptyDetail')}</p></div> : <div className="min-h-0 flex-1 overflow-y-auto p-2">{rows.map((row) => <button key={row.id} type="button" onClick={() => ctx.patchState({ selectedDelegationId: row.id })} className="mb-1 flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-[var(--surface-hover)]"><Share2 size={14} className={`mt-0.5 shrink-0 ${statusClass(row.status)}`} /><span className="min-w-0 flex-1"><span className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate text-12 font-medium text-[var(--text-primary)]">{row.targetBotName}</span><span className={`shrink-0 text-10 ${statusClass(row.status)}`}>{t(`rightSidebar.botDelegations.status.${row.status}`)}</span></span><span className="mt-0.5 line-clamp-2 text-11 leading-4 text-[var(--text-tertiary)]">{row.objective}</span></span></button>)}</div>}
    </div>
  );
}
