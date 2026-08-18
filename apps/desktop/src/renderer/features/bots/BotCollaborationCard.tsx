import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, ChevronDown, ChevronRight, ExternalLink, Megaphone, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import type {
  BotCollaborationMeta,
  BotCollaborationRole,
} from '../../../shared/botCollaboration';
import { readBotCollaborationMeta } from '../../../shared/botCollaboration';
import type { BotDelegationView } from '../../../shared/botDelegation';
import { makeBotArtifact, type BotArtifactItem } from '../../../shared/botArtifact';
import { openBotArtifactsTab } from '@/features/right-sidebar/lib/openBotArtifactsTab';
import { BotArtifactCard } from './BotArtifactCard';
import { useBotArtifactOpen } from './useBotArtifactOpen';
import { BotAvatar } from './BotAvatar';
import { isActiveDelegationStatus, useBotDelegation } from './botDelegationLive';
import { useBotProfiles } from './botStore';

/** 与右栏 Bot 协同 tab、输入框上方状态条同一档位（s / m / h m）。 */
function formatDuration(startedAt: number, endedAt: number): string {
  const seconds = Math.max(0, Math.floor((endedAt - startedAt) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function terminalKey(status: BotDelegationView['status']): string {
  if (status === 'completed') return 'done';
  if (status === 'cancelled') return 'stopped';
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
  const row = useBotDelegation(sessionId ?? meta.parentSessionId, meta.delegationId);
  const [expanded, setExpanded] = useState(false);
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const inputRef = useRef<HTMLInputElement | null>(null);
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
    if (!value || !sessionId) return;
    const ok = await runAction(async () =>
      window.electronAPI.maker.interjectBotDelegation(sessionId, meta.delegationId, value),
    );
    if (ok) {
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
    const elapsed = formatDuration(row.createdAt, row.completedAt ?? row.updatedAt);
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
            {t(`bots.collab.report.${terminalKey(row.status)}`, {
              name: to.name,
              duration: elapsed,
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
                {t('bots.collab.openTask', { name: to.name })}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  const statusLabel = row
    ? t(`bots.collab.status.${row.status}`, { name: to.name })
    : t('bots.collab.status.queued', { name: to.name });
  const startedAt = row?.createdAt ?? null;

  return (
    <div className="my-2 max-w-[440px] rounded-xl border border-[var(--border-default)] bg-[var(--surface-chip)] px-3.5 py-3 text-12">
      <div className="flex items-center gap-2.5">
        {heads}
        <span className="min-w-0 flex-1 truncate text-13 font-medium text-[var(--text-primary)]">
          {t('bots.collab.joined', { name: to.name })}
        </span>
      </div>
      <div className="mt-2.5 flex items-center gap-2 border-t border-[var(--border-default)] pt-2.5">
        <span
          aria-hidden="true"
          className="size-[7px] shrink-0 animate-pulse rounded-full bg-[var(--text-tertiary)] motion-reduce:animate-none"
        />
        <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]">{statusLabel}</span>
        {startedAt !== null ? (
          <span className="shrink-0 tabular-nums text-11 text-[var(--text-tertiary)]">
            {formatDuration(startedAt, now)}
          </span>
        ) : null}
      </div>
      {row ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
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
          {row.childSessionId ? (
            <button
              type="button"
              onClick={openChildTask}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-default)] px-2.5 py-1 text-11 text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
            >
              <ExternalLink size={11} aria-hidden="true" />
              {t('bots.collab.openTask', { name: to.name })}
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
