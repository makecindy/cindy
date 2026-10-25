/**
 * 私聊话题面板（docs/product-rules/cindy-bots-runtime.md「私聊话题」）：沿用群聊话题面板的外观；正文是话题 Session 自己的完整任务视图
 * （回复、工具进度、确认、停止都在里面），所以这里不另做一套消息列表。
 */
import { useEffect, useId, useRef, useSyncExternalStore } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import { makerChatStore } from '@/lib/makerChatStore';
import { CCAgentSessionView } from '@/features/cc-agent/CCAgentSessionView';
import type { ComposerBotMention } from '@/lib/fileTypes';
import type { BotChatIdentity } from './BotSessionContentHeader';
import { BotAvatar } from './BotAvatar';
import { botDmThreadReadKey, markBotRead } from './botReadState';

const groupKey = (name: string) => `bots.groupChat.server.${name}`;

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
export function BotDmThreadPanel({ bot, rootSessionId, rootClientId, state, mentions, lastAssistantAt, onRetry, onClose }: {
  bot: BotChatIdentity;
  rootSessionId: string;
  rootClientId: string;
  state: BotDmThreadPanelState;
  mentions: readonly ComposerBotMention[];
  /** The topic's latest companion reply, from the timeline's topic list. */
  lastAssistantAt: number | null;
  onRetry: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const titleId = useId();
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
  return (
    <aside ref={panelRef} aria-labelledby={titleId} data-dm-thread-panel={rootClientId}
      className="flex h-full min-w-0 w-1/2 max-w-[min(50%,28rem)] shrink-0 flex-col overflow-hidden border-l border-[var(--border-default)] bg-[var(--surface)]">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--border-default)] px-5">
        <h2 id={titleId} className="text-15 font-medium text-[var(--text-primary)]">{t(groupKey('topic'))}</h2>
        <Tip text={t('bots.close')}>
          <Button variant="secondary" tone="quiet" size="md"
            className="w-8 rounded-none px-0 [&::before]:rounded-full"
            aria-label={t('bots.close')} onClick={onClose}><X size={17} aria-hidden /></Button>
        </Tip>
      </header>
      {root ? (
        <section className="max-h-48 shrink-0 overflow-y-auto border-b border-[var(--border-default)] px-5 py-3" data-dm-thread-root="">
          <div className="mb-1 flex items-center gap-2 text-12 text-[var(--text-secondary)]">
            {isBot ? (
              <span aria-hidden className="flex shrink-0">
                <BotAvatar size="xs" className="h-[18px] w-[18px] text-11"
                  bot={{ name: bot.name, avatar: bot.avatar ?? null, avatarColor: bot.avatarColor ?? null }} />
              </span>
            ) : null}
            <span className="font-medium text-[var(--text-primary)]">{isBot ? bot.name : t('bots.dmThread.you')}</span>
          </div>
          <div className="text-14 leading-6 text-[var(--text-primary)]">
            <MarkdownRenderer workingDir="" content={root.content} allowPrivilegedLinks={false} />
          </div>
        </section>
      ) : (
        <p className="shrink-0 border-b border-[var(--border-default)] px-5 py-3 text-12 text-[var(--text-tertiary)]">
          {t('bots.dmThread.rootNotLoaded')}
        </p>
      )}
      <div className="min-h-0 flex-1">
        {state.kind === 'ready' ? (
          <CCAgentSessionView
            key={state.sessionId}
            sessionIdProp={state.sessionId}
            compact
            compactToolbar
            viewVisible
            navigationMode="sidebar-embedded"
            sidebarTargetSessionId={rootSessionId}
            botIdentity={{ ...bot, sessionId: state.sessionId }}
            botMentions={mentions}
          />
        ) : state.kind === 'opening' ? (
          <div className="flex h-full items-center justify-center">
            <Spinner size={18} className="text-[var(--text-tertiary)]" role="status" aria-label={t('ccAgent.common.loading')} />
          </div>
        ) : (
          <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <p className="text-13 leading-5 text-[var(--text-secondary)]">{state.message}</p>
            <Button variant="secondary" size="sm" onClick={onRetry}>{t('bots.retry')}</Button>
          </div>
        )}
      </div>
    </aside>
  );
}
