/**
 * 私聊话题与群聊复用 ThreadPanel 和根消息行；原文放在话题 Session 的消息滚动区内
 * （回复、工具进度、确认、停止都在里面），所以这里不另做一套消息列表。
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { makerChatStore } from '@/lib/makerChatStore';
import { CCAgentSessionView } from '@/features/cc-agent/CCAgentSessionView';
import type { ComposerBotMention } from '@/lib/fileTypes';
import type { BotChatIdentity } from './BotSessionContentHeader';
import { ThreadPanel, ThreadPanelRoot } from './ThreadPanel';
import { BotGroupTimelineItem } from './BotGroupTimelineItem';
import { botDmThreadReadKey, markBotRead } from './botReadState';

/** The root message as the main chat has it loaded; null while it is not among the loaded rows. */
function useRootMessage(rootSessionId: string, rootClientId: string) {
  const snapshot = useSyncExternalStore(
    (listener) => makerChatStore.subscribe(rootSessionId, listener),
    () => makerChatStore.getSnapshot(rootSessionId),
    () => makerChatStore.getSnapshot(rootSessionId),
  );
  const message = snapshot?.messages?.find((row) => row.clientId === rootClientId);
  return message && (message.role === 'user' || message.role === 'assistant') ? message : null;
}

export type BotDmThreadPanelState =
  | { kind: 'opening' }
  | { kind: 'ready'; sessionId: string }
  | { kind: 'failed'; message: string };

/**
 * The topic beside the private chat: its root message on top, then the topic's own task view.
 * Read while open — the newest companion reply in it counts as seen.
 */
export function BotDmThreadPanel({ bot, rootSessionId, rootClientId, state, mentions, lastAssistantAt, replyCount, onRetry, onClose }: {
  bot: BotChatIdentity;
  rootSessionId: string;
  rootClientId: string;
  state: BotDmThreadPanelState;
  mentions: readonly ComposerBotMention[];
  /** The topic's latest companion reply, from the timeline's topic list. */
  lastAssistantAt: number | null;
  replyCount?: number;
  onRetry: () => void;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const root = useRootMessage(rootSessionId, rootClientId);
  const panelRef = useRef<HTMLElement>(null);
  const threadSessionId = state.kind === 'ready' ? state.sessionId : null;

  // Seen only while the window shows it: a reply that arrived while hidden is read on return.
  useEffect(() => {
    if (!threadSessionId) return;
    const markRead = () => {
      if (document.visibilityState !== 'visible') return;
      markBotRead(botDmThreadReadKey(threadSessionId), Math.max(Date.now(), lastAssistantAt ?? 0));
    };
    markRead();
    document.addEventListener('visibilitychange', markRead);
    window.addEventListener('focus', markRead);
    return () => {
      document.removeEventListener('visibilitychange', markRead);
      window.removeEventListener('focus', markRead);
    };
  }, [lastAssistantAt, threadSessionId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (!panelRef.current?.contains(document.activeElement)) return;
      // The task view's own overlays (menus, approvals) close first.
      if (document.activeElement?.closest('[role="dialog"],[role="menu"]')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const isBot = root?.role === 'assistant';
  const threadRoot = <ThreadPanelRoot replyCount={replyCount}>
      {root ? (
        <section data-dm-thread-root="">
          <BotGroupTimelineItem
            message={{
              id: root.clientId, sequence: 0, kind: 'message',
              authorKind: isBot ? 'bot' : 'user', authorBotId: isBot ? bot.id : null,
              authorName: isBot ? bot.name : t('bots.dmThread.you'), content: root.content,
              mentions: { all: false, botIds: [] }, noticeCode: null, planId: null,
              files: [], attachments: [], createdAt: root.createdAt ? Date.parse(root.createdAt) : 0,
            }}
            continued={false}
            authorName={isBot ? bot.name : t('bots.dmThread.you')}
            avatar={{ name: bot.name, avatar: bot.avatar ?? null, avatarColor: bot.avatarColor ?? null }}
            members={[]}
            mentionLabels={[]}
            locale={i18n.language}
            shareScope={`bot-dm-root:${rootSessionId}:${rootClientId}`}
            sharing={false}
            showActions={false}
            onChanged={() => undefined}
          />
        </section>
      ) : (
        <p className="py-3 text-12 text-[var(--text-tertiary)]">
          {t('bots.dmThread.rootNotLoaded')}
        </p>
      )}
  </ThreadPanelRoot>;
  return (
    <ThreadPanel panelRef={panelRef} rootClientId={rootClientId} onClose={onClose}>
      <div className="flex min-h-0 flex-1 flex-col">
        {state.kind === 'ready' ? (
          <CCAgentSessionView
            key={state.sessionId}
            sessionIdProp={state.sessionId}
            messageStreamHeader={threadRoot}
            compact
            compactToolbar
            focusComposerOnOpen
            viewVisible
            navigationMode="sidebar-embedded"
            sidebarTargetSessionId={rootSessionId}
            botIdentity={{ ...bot, sessionId: state.sessionId }}
            botMentions={mentions}
          />
        ) : (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4 pt-3">{threadRoot}</div>
            {state.kind === 'opening' ? (
              <div className="flex shrink-0 justify-center px-5 py-6">
                <Spinner size={18} className="text-[var(--text-tertiary)]" role="status" aria-label={t('ccAgent.common.loading')} />
              </div>
            ) : (
              <div role="alert" className="flex shrink-0 flex-col items-center gap-3 px-5 py-6 text-center">
                <p className="text-13 leading-5 text-[var(--text-secondary)]">{state.message}</p>
                <Button variant="secondary" size="sm" onClick={onRetry}>{t('bots.retry')}</Button>
              </div>
            )}
          </>
        )}
      </div>
    </ThreadPanel>
  );
}
