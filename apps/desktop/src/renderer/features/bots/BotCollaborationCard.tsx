import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, Megaphone, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import type { BotCollaborationMeta, BotCollaborationRole } from '../../../shared/botCollaboration';
import { cn } from '@/lib/utils';
import { readBotCollaborationMeta } from '../../../shared/botCollaboration';
import type { BotDelegationView } from '../../../shared/botDelegation';
import { BotAvatar } from './BotAvatar';
import { isActiveDelegationStatus, useBotDelegation } from './botDelegationLive';
import { useBotProfiles } from './botStore';

/**
 * 「用时」是说给人听的，不是给日志看的：中文界面里 `8s` 和「用时」并排是两套语言。
 * 单位走 i18n，档位仍与右栏 Bot 协同 tab 一致（秒 / 分 / 时+分）。
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
  /** 卡片所在的任务（= 委派发起方任务）。 */
  sessionId?: string;
}

/**
 * 一次 call 在消息流里的内联任务卡。
 *
 * 它替代的是「一条纯文本委派记录 + 输入框上方一条细状态条」：委派发生在对话的哪一
 * 刻，卡就留在哪一行；执行者、目标、状态、用时与结果都在原地看得到，并且可以
 * 叫停或打开独立任务查看工作过程。伙伴私聊走 bot-direct-message，不使用本卡。
 *
 * 身份来自消息上冻结的结构化标记（当时谁委派给谁），状态来自 delegation 行的实时
 * 推送。二者分开是有意的：名字改了不该改写历史，状态变了必须立刻反映。
 */
export function BotTaskCallCard({ data, sessionId }: Props) {
  const parsed = readBotCollaborationCardData(data);
  if (!parsed || parsed.meta.role === 'interjection') return null;
  return <CollaborationCardBody meta={parsed.meta} sessionId={sessionId} />;
}

/** A quiet persisted trace for a message added to an already-running task. */
export function BotCollaborationTrace({ data }: Pick<Props, 'data'>) {
  const parsed = readBotCollaborationCardData(data);
  const { t } = useTranslation();
  if (!parsed || parsed.meta.role !== 'interjection') return null;
  const name = parsed.meta.toBotName || parsed.meta.toBotId || '';
  return (
    <div className="my-1.5 flex items-start gap-2 text-12 leading-relaxed text-[var(--text-tertiary)]">
      <Megaphone size={13} className="mt-[3px] shrink-0" aria-hidden="true" />
      <span className="min-w-0">
        {t('bots.collab.interjected', { name })}
        {parsed.text ? (
          <span className="text-[var(--text-secondary)]">{`：${parsed.text}`}</span>
        ) : null}
      </span>
    </div>
  );
}

/** @deprecated Use BotTaskCallCard or BotCollaborationTrace according to the projected card type. */
export function BotCollaborationCard(props: Props) {
  const parsed = readBotCollaborationCardData(props.data);
  if (parsed?.meta.role === 'interjection') return <BotCollaborationTrace data={props.data} />;
  return <BotTaskCallCard {...props} />;
}

function CollaborationCardBody({
  meta,
  sessionId,
}: {
  meta: BotCollaborationMeta;
  sessionId?: string;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const profiles = useBotProfiles();
  // 委派行永远挂在发起方任务上。目标主任务里的入站卡必须按 parentSessionId 去读,
  // 否则会拿目标伙伴自己的出向清单去对,永远对不上。
  const { row, resolved } = useBotDelegation(meta.parentSessionId, meta.delegationId);
  const inbound = meta.role === 'guest-request' || meta.role === 'result-mirror';
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const active = row ? isActiveDelegationStatus(row.status) : false;

  // 只在还在干活时起秒级 tick，收拢后不再空转。
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);

  const avatarOf = useMemo(
    // botId 可能是 null:委派目标是一条普通 Cindy 任务而非另一个伙伴时，
    // 后端已经把 fallbackName 填成 'Cindy'，这里只要不因 null 崩掉即可。
    () => (botId: string | null, fallbackName: string) => {
      const profile = botId ? profiles.find((item) => item.id === botId) : undefined;
      return {
        name: profile?.name || fallbackName || botId || '',
        avatar: profile?.avatar ?? null,
        avatarColor: profile?.avatarColor ?? null,
      };
    },
    [profiles],
  );

  const from = avatarOf(meta.fromBotId, meta.fromBotName);
  const to = avatarOf(meta.toBotId, meta.toBotName);

  const openChildTask = (): void => {
    const childSessionId = row?.childSessionId ?? meta.childSessionId;
    if (!childSessionId) return;
    // 目标为 null 时委派对象是一条普通 Cindy 任务，走主任务路由而非伙伴会话路由。
    if (meta.toBotId) {
      navigate(
        `/bots/${encodeURIComponent(meta.toBotId)}/session/${encodeURIComponent(childSessionId)}`,
      );
    } else {
      navigate(`/cc-agent/${encodeURIComponent(childSessionId)}`);
    }
  };

  const watchWorkLabel = t('bots.collab.watchWork', { name: to.name });

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
      - 拉完了却没有这一行（resolved=true）→ 列表请求失败，或这条委派已经掉出
        listDelegations 的 100 行上限。此时我们**核实不了**它现在什么样，却又没有
        任何按钮可以停止或查看（下面的操作区 `row ? … : null` 整块不渲染）。
        以前这里一律回落到「正在开始」，结果就是一张永远在呼吸、永远停不掉的卡 ——
        一个纯粹画出来的进行中状态。改成如实说「状态查不到了」，并且不再画呼吸点。
  */
  const unverifiable = resolved && !row;
  const statusLabel = row
    ? t(`bots.collab.status.${row.status}`, { name: to.name })
    : unverifiable
      ? t('bots.collab.status.unknown', { name: to.name })
      : t('bots.collab.status.queued', { name: to.name });
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
  const taskTitle = meta.objective.trim().split('\n')[0] || t('bots.collab.backgroundTask');
  const taskKindLabel = inbound
    ? t('bots.collab.taskFrom', { name: from.name })
    : meta.toBotId
      ? t('bots.collab.taskAssignedTo', { name: to.name })
      : t('bots.collab.backgroundTask');
  const artifacts = row?.artifacts ?? [];

  return (
    <div className="my-2 w-full max-w-[560px] rounded-xl border border-[var(--border-default)] bg-[var(--surface-chip)] px-4 py-3 text-12">
      <div className="flex items-start gap-3">
        {meta.toBotId ? <BotAvatar bot={to} size="sm" /> : null}
        <div className="min-w-0 flex-1">
          <div className="text-11 text-[var(--text-tertiary)]">{taskKindLabel}</div>
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
      {row?.lastError ? (
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
      {row ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {!inbound && active ? (
            <button
              type="button"
              disabled={pending || !sessionId}
              onClick={() => {
                if (!sessionId) return;
                void runAction(async () =>
                  window.electronAPI.maker.cancelBotDelegation(sessionId, meta.delegationId),
                );
              }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-default)] px-2.5 py-1 text-11 text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] disabled:opacity-50"
            >
              <Square size={11} aria-hidden="true" />
              {t('bots.collab.stopTask')}
            </button>
          ) : null}
          {row.childSessionId ? (
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

export type { BotCollaborationRole };
