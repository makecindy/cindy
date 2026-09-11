import { useEffect, useState } from 'react';
import { FileText, GitPullRequest, Megaphone, Square, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { prStatusKey, sessionPrUrl } from '@cindy/maker-shared';
import { usePrActions, usePrRefsForSession, usePrStatuses } from '@/contexts/PrRefsContext';
import { PR_STATUS_COLOR, PR_STATUS_ICON } from '@/features/cc-agent/gitContextPrVisuals';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';

import type { BotCollaborationMeta } from '../../../shared/botCollaboration';
import { makerApiForSticky } from '@/lib/makerTransport';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { useRemoteBots } from './useRemoteBots';
import { cn } from '@/lib/utils';
import { readBotCollaborationMeta } from '../../../shared/botCollaboration';
import { isActiveDelegationStatus, useBotDelegation } from './botDelegationLive';

/**
 * 「用时」是说给人听的，不是给日志看的：中文界面里 `8s` 和「用时」并排是两套语言。
 * 单位走 i18n，按秒 / 分 / 时+分显示。
 */
export function formatBotCollaborationDuration(
  t: (key: string, options?: Record<string, unknown>) => string,
  startedAt: number,
  endedAt: number,
): string {
  const seconds = Math.max(0, Math.floor((endedAt - startedAt) / 1_000));
  if (seconds < 60) return t('bots.collab.duration.seconds', { n: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('bots.collab.duration.minutes', { n: minutes });
  return t('bots.collab.duration.hoursMinutes', {
    h: Math.floor(minutes / 60),
    m: minutes % 60,
  });
}

/** 只认结构化标记；形状不对就当没有卡，交回普通文本渲染。 */
export function readBotCollaborationCardData(
  data: Record<string, unknown> | undefined,
): { meta: BotCollaborationMeta; text: string } | null {
  const meta = readBotCollaborationMeta(data);
  if (!meta) return null;
  return { meta, text: typeof data?.text === 'string' ? data.text : '' };
}

interface Props {
  data?: Record<string, unknown>;
  /** 卡片所在的父任务。 */
  sessionId?: string;
}

/**
 * 伙伴启动后台任务后留在父任务消息流里的唯一任务卡。
 * 状态来自持久任务行；卡片不会被额外的顶部状态条或右栏面板重复展示。
 */
export function BotSessionTaskCard({ data, sessionId }: Props) {
  const parsed = readBotCollaborationCardData(data);
  if (!parsed || parsed.meta.role !== 'delegation-request') return null;
  return <SessionTaskCardBody meta={parsed.meta} sessionId={sessionId} />;
}

/** A quiet persisted trace for a message added to an already-running task. */
export function BotSessionTaskMessageTrace({ data }: Pick<Props, 'data'>) {
  const parsed = readBotCollaborationCardData(data);
  const { t } = useTranslation();
  if (!parsed || parsed.meta.role !== 'interjection') return null;
  return (
    <div className="my-1.5 flex items-start gap-2 text-12 leading-relaxed text-[var(--text-tertiary)]">
      <Megaphone size={13} className="mt-[3px] shrink-0" aria-hidden="true" />
      <span className="min-w-0">
        {t('bots.collab.messageSent')}
        {parsed.text ? (
          <span className="text-[var(--text-secondary)]">{`：${parsed.text}`}</span>
        ) : null}
      </span>
    </div>
  );
}

function SessionTaskCardBody({
  meta,
  sessionId,
}: {
  meta: BotCollaborationMeta;
  sessionId?: string;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const parentSessionId = sessionId ?? meta.parentSessionId ?? null;
  const [sourceDeviceId] = useState(() =>
    parentSessionId ? remoteProjectsStore.getSessionDeviceId(parentSessionId) : undefined,
  );
  const remoteBots = useRemoteBots();
  const online =
    !sourceDeviceId || remoteBots.some((bot) => bot.deviceId === sourceDeviceId && bot.online);
  const { row, resolved, stale } = useBotDelegation(parentSessionId, meta.delegationId);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const active = row ? isActiveDelegationStatus(row.status) : false;
  const childSessionId = row?.childSessionId ?? meta.childSessionId;
  const { registerPrConsumer, invalidateRemotePrRefs } = usePrActions();
  const pullRequests = usePrRefsForSession(childSessionId ?? '');
  const { statuses } = usePrStatuses(childSessionId ?? '');
  useEffect(() => {
    if (!childSessionId) return;
    return registerPrConsumer(childSessionId, sourceDeviceId);
  }, [childSessionId, sourceDeviceId, registerPrConsumer]);
  useEffect(() => {
    if (childSessionId && sourceDeviceId && row?.updatedAt !== undefined) {
      invalidateRemotePrRefs(childSessionId);
    }
  }, [childSessionId, sourceDeviceId, row?.updatedAt, invalidateRemotePrRefs]);
  const prIcon = (ref: (typeof pullRequests)[number]) => {
    const result = statuses.get(prStatusKey(ref));
    const kind = result?.ok ? result.status : null;
    const Icon = kind ? PR_STATUS_ICON[kind] : GitPullRequest;
    return (
      <Icon
        size={14}
        aria-hidden="true"
        style={{ color: kind ? PR_STATUS_COLOR[kind] : 'var(--text-tertiary)' }}
      />
    );
  };

  // 只在还在干活时起秒级 tick，收拢后不再空转。
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);

  const openChildTask = (): void => {
    if (!childSessionId) return;
    const deviceId = sourceDeviceId;
    const existingOrigin = remoteProjectsStore.getSessionDeviceId(childSessionId);
    if (deviceId && existingOrigin && existingOrigin !== deviceId) {
      setActionError(t('bots.collab.actionFailed'));
      return;
    }
    if (deviceId) remoteProjectsStore.pinSessionOrigin(deviceId, childSessionId);
    navigate(`/cc-agent/${encodeURIComponent(childSessionId)}`);
  };

  const watchWorkLabel = t('bots.collab.watchWork');

  const runAction = async (action: () => Promise<{ ok: boolean; message?: string }>) => {
    setPending(true);
    setActionError(null);
    try {
      const result = await action();
      if (!result.ok) setActionError(result.message ?? t('bots.collab.actionFailed'));
      return result.ok;
    } catch {
      setActionError(t('bots.collab.actionFailed'));
      return false;
    } finally {
      setPending(false);
    }
  };

  const unverifiable = resolved && !row;
  const statusLabel = row
    ? t(`bots.collab.status.${row.status}`)
    : unverifiable
      ? t('bots.collab.status.unknown')
      : t('bots.collab.status.queued');
  const startedAt = row?.createdAt ?? null;
  const endedAt = row && !active ? (row.completedAt ?? row.updatedAt) : now;
  const duration =
    startedAt === null ? null : formatBotCollaborationDuration(t, startedAt, endedAt);
  const taskStatusClass =
    !row || row.status === 'queued'
      ? 'text-[var(--text-tertiary)]'
      : row.status === 'completed'
        ? 'text-[var(--status-success)]'
        : row.status === 'failed' || row.status === 'timed-out'
          ? 'text-[var(--status-danger)]'
          : row.status === 'cancelled'
            ? 'text-[var(--text-tertiary)]'
            : 'text-[var(--status-info)]';
  const taskTitle =
    row?.title || meta.objective.trim().split('\n')[0] || t('bots.collab.backgroundTask');
  const artifacts = row?.artifacts ?? [];
  const actionClass = 'w-full min-w-[104px] gap-1.5 px-3';
  const openPr = (url: string) => {
    setActionError(null);
    void window.electronAPI
      .openExternal(url)
      .then((result) => {
        if (!result.success) setActionError(t('bots.collab.actionFailed'));
      })
      .catch(() => setActionError(t('bots.collab.actionFailed')));
  };
  const prButton = (
    <Button
      variant="secondary"
      size="md"
      className={actionClass}
      onClick={pullRequests.length === 1 ? () => openPr(sessionPrUrl(pullRequests[0])) : undefined}
    >
      {pullRequests.length === 1 ? (
        prIcon(pullRequests[0])
      ) : (
        <GitPullRequest size={14} aria-hidden="true" />
      )}
      {t('bots.collab.viewPr')}
    </Button>
  );

  return (
    <div className="my-2 w-full max-w-[560px] rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-3 text-12">
      <div className="flex items-start gap-3">
        <div
          title={taskTitle}
          className="min-w-0 flex-1 line-clamp-2 break-words text-14 font-medium leading-5 text-[var(--text-primary)]"
        >
          {taskTitle}
        </div>
        <span
          className={cn('flex shrink-0 items-center gap-1.5 text-12 leading-5', taskStatusClass)}
        >
          <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
          {statusLabel}
        </span>
      </div>
      <div className="mt-1 flex min-h-4 flex-wrap items-center gap-x-3 gap-y-1 text-[var(--text-tertiary)]">
        {duration ? <span className="tabular-nums">{duration}</span> : null}
        {artifacts.length > 0 ? (
          <span>{t('bots.collab.artifactCount', { count: artifacts.length })}</span>
        ) : null}
        {pullRequests.length === 1 ? (
          <span className="min-w-0 truncate" title={pullRequests[0].url}>
            {pullRequests[0].owner}/{pullRequests[0].repo} #{pullRequests[0].prNumber}
          </span>
        ) : null}
        {pullRequests.length > 1 ? (
          <span>{t('bots.collab.prCount', { count: pullRequests.length })}</span>
        ) : null}
      </div>
      {(stale ||
        !online ||
        pullRequests.some((ref) => statuses.get(prStatusKey(ref))?.ok === false)) &&
      row ? (
        <p className="mt-1.5 flex items-center gap-1.5 text-[var(--text-tertiary)]">
          <TriangleAlert size={13} aria-hidden="true" />
          {t('bots.collab.stale')}
        </p>
      ) : null}
      {row?.status === 'waiting' ? (
        <p className="mt-1.5 line-clamp-2 break-words text-[var(--text-secondary)]">
          {row.pendingInteraction?.summary || t('bots.collab.retrying')}
        </p>
      ) : null}
      {row?.lastError && (row.status === 'failed' || row.status === 'timed-out') ? (
        <p className="mt-1.5 line-clamp-2 break-words text-[var(--error-fg)]">
          {row.lastError.replace(/^[A-Z_]+:\s*/, '')}
        </p>
      ) : null}
      {active || childSessionId || pullRequests.length > 0 ? (
        <div
          className={cn(
            'mt-2.5 grid w-fit max-w-full items-center gap-2',
            Number(active) + Number(Boolean(childSessionId)) + Number(pullRequests.length > 0) > 1
              ? 'grid-cols-2'
              : 'grid-cols-1',
          )}
        >
          {pullRequests.length === 1 ? (
            prButton
          ) : pullRequests.length > 1 ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>{prButton}</DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {pullRequests.map((pr) => (
                  <DropdownMenuItem key={pr.url} onSelect={() => openPr(sessionPrUrl(pr))}>
                    {prIcon(pr)} {pr.owner}/{pr.repo} #{pr.prNumber}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          {childSessionId ? (
            <Button variant="secondary" size="md" className={actionClass} onClick={openChildTask}>
              <FileText size={14} aria-hidden="true" />
              {watchWorkLabel}
            </Button>
          ) : null}
          {active ? (
            <Button
              variant="secondary"
              size="md"
              className={actionClass}
              disabled={pending || !parentSessionId || !online}
              onClick={() => {
                if (!parentSessionId || !online || pending) return;
                void runAction(async () =>
                  makerApiForSticky(parentSessionId).cancelBotDelegation(
                    parentSessionId,
                    meta.delegationId,
                  ),
                );
              }}
            >
              <Square size={14} aria-hidden="true" />
              {t('bots.collab.stopTask')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {actionError ? (
        <p role="alert" className="mt-2 text-11 text-[var(--error-fg)]">
          {actionError}
        </p>
      ) : null}
    </div>
  );
}
