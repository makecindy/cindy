import { useEffect, useState } from 'react';
import { ExternalLink, Megaphone, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import type { BotCollaborationMeta } from '../../../shared/botCollaboration';
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
  const parentSessionId = meta.parentSessionId ?? sessionId ?? null;
  const { row, resolved } = useBotDelegation(parentSessionId, meta.delegationId);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const active = row ? isActiveDelegationStatus(row.status) : false;
  const childSessionId = row?.childSessionId ?? meta.childSessionId;

  // 只在还在干活时起秒级 tick，收拢后不再空转。
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);

  const openChildTask = (): void => {
    if (!childSessionId) return;
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

  /*
    row 为空有两种含义，必须分开说：
      - 还没拉到（resolved=false）→ 照常显示「正在开始」+ 呼吸点，这是真的在等；
      - 拉完了却没有这一行（resolved=true）→ 首次列表请求失败，或持久记录不存在。
        此时我们**核实不了**它现在什么样；不能伪造进行状态，但仍可用锚点里的
        childSessionId 打开任务过程。
        以前这里一律回落到「正在开始」，结果就是一张永远在呼吸、永远停不掉的卡 ——
        一个纯粹画出来的进行中状态。改成如实说「状态查不到了」，并且不再画呼吸点。
  */
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
  const taskTitle = row?.title || meta.objective.trim().split('\n')[0] || t('bots.collab.backgroundTask');
  const artifacts = row?.artifacts ?? [];

  return (
    <div className="my-2 w-full max-w-[560px] rounded-xl border border-[var(--border-default)] bg-[var(--surface-chip)] px-4 py-3 text-12">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-11 text-[var(--text-tertiary)]">
            {t('bots.collab.backgroundTask')}
          </div>
          <div className="mt-0.5 line-clamp-2 break-words text-14 font-medium text-[var(--text-primary)]">
            {taskTitle}
          </div>
        </div>
        <span
          className={cn(
            'shrink-0 rounded-full bg-[var(--surface-subtle)] px-2.5 py-1 text-11 font-medium',
            taskStatusClass,
          )}
        >
          {statusLabel}
        </span>
      </div>
      <div className="mt-2.5 flex items-center gap-2 border-t border-[var(--border-default)] pt-2.5 text-[var(--text-tertiary)]">
        <span
          aria-hidden="true"
          className={cn(
            'size-[7px] shrink-0 rounded-full bg-[var(--text-tertiary)]',
            (!resolved || active) && !unverifiable && 'animate-pulse motion-reduce:animate-none',
          )}
        />
        <span className="min-w-0 flex-1 truncate">{t('bots.collab.trackedTask')}</span>
        {duration ? (
          <span className="shrink-0 tabular-nums text-11 text-[var(--text-tertiary)]">
            {duration}
          </span>
        ) : null}
      </div>
      {row?.status === 'waiting' && row.pendingInteraction ? (
        <p className="mt-1.5 whitespace-pre-wrap text-11 leading-4 text-[var(--text-tertiary)]">
          {row.pendingInteraction.summary}
        </p>
      ) : row?.status === 'waiting' ? (
        <p className="mt-1.5 text-11 text-[var(--text-tertiary)]">{t('bots.collab.retrying')}</p>
      ) : null}
      {row?.resultSummary ? (
        <p className="mt-2 whitespace-pre-wrap break-words text-[var(--text-secondary)]">
          {row.resultSummary}
        </p>
      ) : null}
      {row?.lastError && (row.status === 'failed' || row.status === 'timed-out') ? (
        <p className="mt-2 whitespace-pre-wrap break-words text-[var(--error-fg)]">
          {row.lastError.replace(/^[A-Z_]+:\s*/, '')}
        </p>
      ) : null}
      {artifacts.length > 0 ? (
        <ul className="mt-2 space-y-1 text-11 text-[var(--text-tertiary)]">
          {artifacts.map((artifact) => (
            <li key={`${artifact.status}:${artifact.absolutePath}`} className="truncate">
              {artifact.path}
            </li>
          ))}
        </ul>
      ) : null}
      {active || childSessionId ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {active ? (
            <button
              type="button"
              disabled={pending || !parentSessionId}
              onClick={() => {
                if (!parentSessionId) return;
                void runAction(async () =>
                  window.electronAPI.maker.cancelBotDelegation(parentSessionId, meta.delegationId),
                );
              }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-default)] px-2.5 py-1 text-11 text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] disabled:opacity-50"
            >
              <Square size={11} aria-hidden="true" />
              {t('bots.collab.stopTask')}
            </button>
          ) : null}
          {childSessionId ? (
            <button
              type="button"
              onClick={openChildTask}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-default)] px-2.5 py-1 text-11 text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
            >
              <ExternalLink size={11} aria-hidden="true" />
              {watchWorkLabel}
            </button>
          ) : null}
        </div>
      ) : null}
      {actionError ? <p className="mt-2 text-11 text-[var(--error-fg)]">{actionError}</p> : null}
    </div>
  );
}
