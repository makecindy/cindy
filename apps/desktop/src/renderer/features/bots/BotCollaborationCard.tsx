import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, ChevronDown, ChevronRight, ExternalLink, Megaphone, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import type {
  BotCollaborationMeta,
  BotCollaborationRole,
} from '../../../shared/botCollaboration';
import { cn } from '@/lib/utils';
import { readBotCollaborationMeta } from '../../../shared/botCollaboration';
import type { BotDelegationView } from '../../../shared/botDelegation';
import { makeBotArtifact, type BotArtifactItem } from '../../../shared/botArtifact';
import { openBotArtifactsTab } from '@/features/right-sidebar/lib/openBotArtifactsTab';
import { BotArtifactCard } from './BotArtifactCard';
import { useBotArtifactOpen } from './useBotArtifactOpen';
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

function terminalKey(status: BotDelegationView['status']): string {
  if (status === 'completed') return 'done';
  if (status === 'cancelled') return 'stopped';
  // 超时和失败不是一回事：超时是「等到点了还没回来」，用户下一步多半是重发或改
  // 拆分；混进「失败」里会让人去查一个并不存在的报错。后端本来就分得清,前台
  // 别把它抹平。
  if (status === 'timed-out') return 'timedOut';
  return 'failed';
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
 * 发起方消息流里的内联协作卡。
 *
 * 它替代的是「一条纯文本委派记录 + 输入框上方一条细状态条」：委派发生在对话的哪一
 * 刻，卡就留在哪一行；谁把活交给了谁、现在干到哪、用了多久、最后交没交，都在原地
 * 看得到，并且可以就地催一下 / 叫停 / 跳过去看 TA 的完整对话。
 *
 * 身份来自消息上冻结的结构化标记（当时谁委派给谁），状态来自 delegation 行的实时
 * 推送。二者分开是有意的：名字改了不该改写历史，状态变了必须立刻反映。
 */
export function BotCollaborationCard({ data, sessionId }: Props) {
  const parsed = readBotCollaborationCardData(data);
  if (!parsed) return null;
  return <CollaborationCardBody meta={parsed.meta} text={parsed.text} sessionId={sessionId} />;
}

function CollaborationCardBody({
  meta,
  text,
  sessionId,
}: {
  meta: BotCollaborationMeta;
  text: string;
  sessionId?: string;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const profiles = useBotProfiles();
  // 委派行永远挂在发起方任务上。目标主任务里的入站卡必须按 parentSessionId 去读,
  // 否则会拿目标伙伴自己的出向清单去对,永远对不上。
  const { row, resolved } = useBotDelegation(meta.parentSessionId, meta.delegationId);
  const inbound = meta.role === 'guest-request' || meta.role === 'result-mirror';
  const [expanded, setExpanded] = useState(false);
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const inputRef = useRef<HTMLInputElement | null>(null);
  /**
   * 插话的幂等键。它跟着「这一句话」走，不是跟着这次点击走：双击发送、失败后重试
   * 都复用同一个 token，服务端按 clientId 去重，对方只会被真的催一次。改了正文就
   * 换新 token —— 否则新的一句会被当成旧那句的重放而被静默吞掉。
   */
  const interjectionTokenRef = useRef<{ text: string; token: string } | null>(null);
  const { openArtifact, artifactLightboxes } = useBotArtifactOpen();

  const active = row ? isActiveDelegationStatus(row.status) : false;

  // 只在还在干活时起秒级 tick，收拢后不再空转。
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);

  useEffect(() => {
    if (composing) inputRef.current?.focus();
  }, [composing]);

  const avatarOf = useMemo(
    () => (botId: string, fallbackName: string) => {
      const profile = profiles.find((item) => item.id === botId);
      return {
        name: profile?.name || fallbackName || botId,
        avatar: profile?.avatar ?? null,
        avatarColor: profile?.avatarColor ?? null,
      };
    },
    [profiles],
  );

  const from = avatarOf(meta.fromBotId, meta.fromBotName);
  const to = avatarOf(meta.toBotId, meta.toBotName);

  if (meta.role === 'interjection') {
    return (
      <div className="my-1.5 flex items-start gap-2 text-12 leading-relaxed text-[var(--text-tertiary)]">
        <Megaphone size={13} className="mt-[3px] shrink-0" aria-hidden="true" />
        <span className="min-w-0">
          {t('bots.collab.interjected', { name: to.name })}
          {text ? <span className="text-[var(--text-secondary)]">{`：${text}`}</span> : null}
        </span>
      </div>
    );
  }

  const openChildTask = (): void => {
    const childSessionId = row?.childSessionId ?? meta.childSessionId;
    if (!childSessionId) return;
    navigate(
      `/bots/${encodeURIComponent(meta.toBotId)}/session/${encodeURIComponent(childSessionId)}`,
    );
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

  const submitInterjection = async (): Promise<void> => {
    const value = draft.trim();
    if (!value || !sessionId || pending) return;
    const cached = interjectionTokenRef.current;
    const token =
      cached && cached.text === value ? cached.token : globalThis.crypto.randomUUID();
    interjectionTokenRef.current = { text: value, token };
    const ok = await runAction(async () =>
      window.electronAPI.maker.interjectBotDelegation(
        sessionId,
        meta.delegationId,
        value,
        token,
      ),
    );
    if (ok) {
      interjectionTokenRef.current = null;
      setDraft('');
      setComposing(false);
    }
  };

  const heads = (
    <span className="flex shrink-0 items-center gap-1.5">
      <BotAvatar bot={from} size="xs" />
      <ArrowRight size={11} className="text-[var(--text-tertiary)]" aria-hidden="true" />
      <BotAvatar bot={to} size={active || !row ? 'sm' : 'xs'} />
    </span>
  );

  // 终态：收拢成一行战报，点开才看细节。
  if (row && !active) {
    const elapsed = formatBotCollaborationDuration(
      t,
      row.createdAt,
      row.completedAt ?? row.updatedAt,
    );
    const deliveredCount = row.outputArtifacts.length;
    // 定稿的战报一行是「本本 · 用时 8 秒 · 交付 1 份文档」——「完成」只说了事情结束了，
    // 「交付 N 件」才说了它到底交出来什么。真有产物时用后者。
    //
    // 失败时另说：只写「失败」等于要用户自己点开找原因，而最常见的原因（没登录）
    // 恰恰是一句话就能说清、也一句话就能解决的。所以有原因就把原因摆在折叠行上。
    const failureReason = row.status === 'failed' && row.lastError
      ? row.lastError.replace(/^[A-Z_]+:\s*/, '')
      : null;
    const reportKey =
      row.status === 'completed' && deliveredCount > 0
        ? 'delivered'
        : failureReason
          ? 'failedReason'
          : terminalKey(row.status);
    return (
      <div className="my-2 max-w-[440px] rounded-xl border border-[var(--border-default)] bg-[var(--surface-chip)] text-12">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
        >
          {heads}
          <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]">
            {t(`bots.collab.report.${reportKey}`, {
              name: to.name,
              duration: elapsed,
              count: deliveredCount,
              reason: failureReason ?? '',
            })}
          </span>
          {expanded ? (
            <ChevronDown size={13} className="shrink-0 text-[var(--text-tertiary)]" />
          ) : (
            <ChevronRight size={13} className="shrink-0 text-[var(--text-tertiary)]" />
          )}
        </button>
        {expanded ? (
          <div className="border-t border-[var(--border-default)] px-3.5 py-2.5">
            {/*
              展开区先给结论、再给当初的目标。战报一行只说「交了几件」，
              「TA 到底得出了什么」的唯一落点就是这段 resultSummary —— 与右栏
              Bot 协同 tab 同一段文本，不另造摘要。展开是用户主动动作，即使下方
              还有客座气泡也照给：那是「再读一遍结论」，不是啰嗦。
            */}
            {row.resultSummary ? (
              <p className="mb-2 whitespace-pre-wrap break-words text-[var(--text-primary)]">
                {row.resultSummary}
              </p>
            ) : null}
            <p className="whitespace-pre-wrap break-words text-[var(--text-secondary)]">
              {meta.objective}
            </p>
            {row.lastError ? (
              <p className="mt-2 whitespace-pre-wrap break-words text-[var(--error-fg)]">
                {row.lastError}
              </p>
            ) : null}
            {/* 委派回传的产物:与本轮产出文件用同一张交付物卡,来源不同不代表长相不同。 */}
            {row.outputArtifacts.length > 0 ? (
              <div className="mt-2.5 flex flex-col gap-1.5">
                {row.outputArtifacts.map((artifact) =>
                  makeBotArtifact({
                    source: 'delegation',
                    target: artifact.ref,
                    isRef: true,
                    createdAt: row.completedAt ?? row.updatedAt,
                    sessionId: row.childSessionId,
                    delegationId: row.id,
                  }),
                ).map((item) => (
                  <BotArtifactCard
                    key={item.id}
                    item={item}
                    onOpen={(target) => void openArtifact(target)}
                    {...(sessionId
                      ? {
                          onReveal: (target: BotArtifactItem) =>
                            void openBotArtifactsTab(sessionId, { focusArtifactId: target.id }),
                        }
                      : {})}
                  />
                ))}
                {artifactLightboxes}
              </div>
            ) : null}
            {row.childSessionId ? (
              <button
                type="button"
                onClick={openChildTask}
                className="mt-2.5 inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-default)] px-2.5 py-1 text-11 text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
              >
                <ExternalLink size={11} aria-hidden="true" />
                {watchWorkLabel}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

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

  return (
    <div className="my-2 max-w-[440px] rounded-xl border border-[var(--border-default)] bg-[var(--surface-chip)] px-3.5 py-3 text-12">
      <div className="flex items-center gap-2.5">
        {heads}
        <span className="min-w-0 flex-1 truncate text-13 font-medium text-[var(--text-primary)]">
          {inbound
            ? t('bots.collab.inboundJoined', { name: from.name })
            : t('bots.collab.joined', { name: to.name })}
        </span>
      </div>
      <div className="mt-2.5 flex items-center gap-2 border-t border-[var(--border-default)] pt-2.5">
        <span
          aria-hidden="true"
          className={cn(
            'size-[7px] shrink-0 rounded-full bg-[var(--text-tertiary)]',
            // 核实不了的卡不再"呼吸"——那颗动着的点本身就是一句"它还在跑"的断言。
            !unverifiable && 'animate-pulse motion-reduce:animate-none',
          )}
        />
        <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]">{statusLabel}</span>
        {startedAt !== null ? (
          <span className="shrink-0 tabular-nums text-11 text-[var(--text-tertiary)]">
            {formatBotCollaborationDuration(t, startedAt, now)}
          </span>
        ) : null}
      </div>
      {/*
        waiting = 第一句话没能送进对方的任务，正在退避重试。以前这里什么都不说，
        卡片和「正在做」长得一模一样——用户以为对方在干活，其实一次都没开始。
        重试有次数上限，用完会翻成失败终态；在那之前至少要如实说「还没开始」。
      */}
      {row?.status === 'waiting' ? (
        <p className="mt-1.5 text-11 text-[var(--text-tertiary)]">{t('bots.collab.retrying')}</p>
      ) : null}
      {row ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {!inbound ? (
            <>
              <button
                type="button"
                disabled={pending || !sessionId}
                onClick={() => setComposing((value) => !value)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-default)] px-2.5 py-1 text-11 text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] disabled:opacity-50"
              >
                <Megaphone size={11} aria-hidden="true" />
                {t('bots.collab.nudge')}
              </button>
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
                {t('bots.collab.stop')}
              </button>
            </>
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
      {composing ? (
        <div className="mt-2 flex items-center gap-1.5">
          <input
            ref={inputRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void submitInterjection();
              }
              if (event.key === 'Escape') setComposing(false);
            }}
            placeholder={t('bots.collab.nudgePlaceholder')}
            aria-label={t('bots.collab.nudgeAria', { name: to.name })}
            maxLength={4_000}
            className="h-7 min-w-0 flex-1 rounded-lg border border-[var(--border-default)] bg-[hsl(var(--content-area))] px-2.5 text-12 text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
          />
          <button
            type="button"
            disabled={pending || draft.trim().length === 0}
            onClick={() => void submitInterjection()}
            className="inline-flex h-7 shrink-0 items-center rounded-lg border border-[var(--border-default)] px-2.5 text-11 text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] disabled:opacity-50"
          >
            {t('bots.collab.nudgeSend')}
          </button>
        </div>
      ) : null}
      {actionError ? (
        <p className="mt-2 text-11 text-[var(--error-fg)]">{actionError}</p>
      ) : null}
    </div>
  );
}

export type { BotCollaborationRole };
