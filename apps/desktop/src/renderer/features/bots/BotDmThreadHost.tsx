/**
 * The private chat's topics around its timeline: provides the topic list to the message bubbles
 * and shows the open topic beside the chat (docs/product-rules/cindy-bots-runtime.md「私聊话题」).
 * Only the companion's own main Chat on this computer has topics.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { makerChatStore } from '@/lib/makerChatStore';
import { cn } from '@/lib/utils';
import type { ComposerBotMention } from '@/lib/fileTypes';
import type { BotChatIdentity } from './BotSessionContentHeader';
import { BotDmThreadPanel, type BotDmThreadPanelState } from './BotDmThreadViews';
import { isBotDmThreadUnread, useBotDmThreadList } from './botDmThreads';
import { BotDmThreadsProvider, type BotDmThreadsValue } from './botDmThreadsContext';
import { useBotProfiles } from './botStore';
import { BOT_DM_THREAD_PARAM } from './botDmThreadRoute';
import { useThreadPanelResize } from './useThreadPanelResize';


const TITLE_LIMIT = 60;
const NO_OPENING_MOTION = () => {};

function topicTitle(text: string | undefined): string {
  const line = text?.replace(/\s+/g, ' ').trim() ?? '';
  return line.length > TITLE_LIMIT ? `${line.slice(0, TITLE_LIMIT - 1)}…` : line;
}

export function BotDmThreadHost({ enabled, bot, rootSessionId, mentions, children }: {
  /** False for read-only copies, history and channel routes: no topics there. */
  enabled: boolean;
  bot: BotChatIdentity;
  /** The companion's main Chat (the timeline the topics hang off). */
  rootSessionId: string;
  mentions: readonly ComposerBotMention[];
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const profile = useBotProfiles().find((candidate) => candidate.id === bot.id);
  const topicProjections = useMemo(() => (profile?.sessions ?? []).filter((session) =>
    session.role === 'thread' && session.status !== 'deleted' && session.threadRoot?.rootSessionId === rootSessionId), [profile?.sessions, rootSessionId]);
  const topicSessionIds = useMemo(() => topicProjections.map((session) => session.id).sort(), [topicProjections]);
  const { threads, reload, readVersion } = useBotDmThreadList(enabled ? bot.id : null, enabled ? rootSessionId : null, topicSessionIds);

  const [open, setOpen] = useState<{ rootClientId: string; state: BotDmThreadPanelState } | null>(null);
  // Same divider as group topics; the chosen width survives switching and reopening topics here.
  const layoutRef = useRef<HTMLDivElement>(null);
  const resize = useThreadPanelResize(layoutRef, enabled ? open?.rootClientId ?? null : null, NO_OPENING_MOTION);
  const attempt = useRef(0);
  const ensure = useCallback((rootClientId: string) => {
    const request = ++attempt.current;
    const owner = getDataOwnerGeneration();
    setOpen({ rootClientId, state: { kind: 'opening' } });
    const root = makerChatStore.getSnapshot(rootSessionId).messages.find((message) => message.clientId === rootClientId);
    void window.electronAPI.localDb.bots.dmThread.ensure({
      botId: bot.id, rootSessionId, rootClientId, title: topicTitle(root?.content),
    }).then((result) => {
      if (request !== attempt.current || !isDataOwnerGenerationCurrent(owner)) return;
      if (!result.ok) {
        setOpen({ rootClientId, state: { kind: 'failed', message: t(result.errorCode === 'ROOT_UNAVAILABLE'
          ? 'bots.dmThread.rootUnavailable' : 'bots.dmThread.openFailed') } });
        return;
      }
      setOpen({ rootClientId, state: { kind: 'ready', sessionId: result.sessionId } });
      handledLink.current = result.sessionId;
      setSearchParams((params) => {
        const next = new URLSearchParams(params);
        next.set(BOT_DM_THREAD_PARAM, result.sessionId);
        return next;
      }, { replace: true });
      reload();
    }).catch(() => {
      if (request !== attempt.current || !isDataOwnerGenerationCurrent(owner)) return;
      setOpen({ rootClientId, state: { kind: 'failed', message: t('bots.dmThread.openFailed') } });
    });
  }, [bot.id, reload, rootSessionId, setSearchParams, t]);

  const close = useCallback(() => {
    attempt.current += 1;
    setOpen(null);
    setSearchParams((params) => {
      if (!params.has(BOT_DM_THREAD_PARAM)) return params;
      const next = new URLSearchParams(params);
      next.delete(BOT_DM_THREAD_PARAM);
      return next;
    }, { replace: true });
    reload();
  }, [reload, setSearchParams]);

  // A link or notification names the topic's Session: open it, or switch to it from another open
  // topic, once its root is known. Each link value is followed once, so closing the panel (which
  // drops the parameter a render later) sticks; once the parameter is gone the same link works again.
  const linked = searchParams.get(BOT_DM_THREAD_PARAM);
  const handledLink = useRef<string | null>(null);
  const openSessionId = open?.state.kind === 'ready' ? open.state.sessionId : null;
  useEffect(() => {
    if (!linked) { handledLink.current = null; return; }
    if (!enabled || handledLink.current === linked) return;
    const projection = topicProjections.find((session) => session.id === linked);
    if (!projection?.threadRoot) return;
    handledLink.current = linked;
    if (openSessionId !== linked) ensure(projection.threadRoot.rootClientId);
  }, [enabled, ensure, linked, openSessionId, topicProjections]);

  const value = useMemo<BotDmThreadsValue | null>(() => enabled ? {
    botId: bot.id,
    botName: bot.name,
    bot,
    rootSessionId,
    threads,
    openRootClientId: open?.rootClientId ?? null,
    isUnread: (thread) => isBotDmThreadUnread(thread),
    openThread: (rootClientId) => { if (open?.rootClientId !== rootClientId || open.state.kind === 'failed') ensure(rootClientId); },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- readVersion re-renders the unread dots
  } : null, [bot, enabled, ensure, open, rootSessionId, threads, readVersion]);

  const openThread = open ? threads.get(open.rootClientId) : undefined;
  return (
    <BotDmThreadsProvider value={value}>
      <div ref={layoutRef} className={cn('flex h-full min-w-0 flex-1', resize.isDragging && 'select-none [&_*]:cursor-col-resize')}>
        <div className="flex min-w-0 flex-1 flex-col">{children}</div>
        {enabled && open ? (
          <BotDmThreadPanel
            key={open.rootClientId}
            bot={bot}
            rootSessionId={rootSessionId}
            rootClientId={open.rootClientId}
            state={open.state}
            mentions={mentions}
            lastAssistantAt={openThread?.lastAssistantAt ?? null}
            replyCount={openThread?.replyCount}
            onRetry={() => ensure(open.rootClientId)}
            onClose={close}
            resize={resize}
          />
        ) : null}
      </div>
    </BotDmThreadsProvider>
  );
}
