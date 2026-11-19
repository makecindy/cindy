/**
 * 私聊话题与群聊复用 ThreadPanel 和根消息行；原文放在话题 Session 的消息滚动区内
 * （回复、工具进度、确认、停止都在里面），所以这里不另做一套消息列表。
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { makerChatStore, type ChatMessage } from '@/lib/makerChatStore';
import { aroundMessagesByClientIdFor } from '@/lib/makerTransport';
import { createCoalescedRefresh } from '@/lib/coalescedRefresh';
import { isWindowHidden } from '@/lib/hiddenAnimationGate';
import { parseUserContent } from '@/lib/imageRef';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { CCAgentSessionView } from '@/features/cc-agent/CCAgentSessionView';
import type { ComposerBotMention } from '@/lib/fileTypes';
import type { BotChatIdentity } from './BotSessionContentHeader';
import { ThreadPanel, ThreadPanelRoot } from './ThreadPanel';
import type { ThreadPanelResize } from './useThreadPanelResize';
import { BotGroupTimelineItem } from './BotGroupTimelineItem';
import { usePluginUiMessageCandidates } from '@/cindy-brain/PluginUiContributions';
import { botDmThreadReadKey, markBotRead } from './botReadState';
import type { BotGroupAttachment } from '../../../shared/botGroupChat';

type RootMessage = Pick<ChatMessage, 'clientId' | 'role' | 'content' | 'createdAt' | 'images' | 'files'>;

/** Keep attachment pointers intact; the shared row owns previews and missing-file states. */
function rootAttachments(root: RootMessage): BotGroupAttachment[] {
  return [
    ...(root.images ?? []).map((image, index): BotGroupAttachment => ({
      id: `${root.clientId}:image:${index}`, name: image.originalName ?? '', category: 'image',
      mimeType: image.mimeType, size: 'size' in image ? image.size ?? 0 : 0,
      url: 'url' in image ? image.url : `data:${image.mimeType};base64,${image.base64}`, path: null,
    })),
    ...(root.files ?? []).map((file, index): BotGroupAttachment => ({
      id: `${root.clientId}:file:${index}`, name: file.name, category: 'file',
      mimeType: 'application/octet-stream', size: 0, url: null, path: file.path,
    })),
  ];
}

/** Resolve the exact root even when restoring an older topic outside the main chat window. */
function useRootMessage(rootSessionId: string, rootClientId: string) {
  const snapshot = useSyncExternalStore(
    (listener) => makerChatStore.subscribe(rootSessionId, listener),
    () => makerChatStore.getSnapshot(rootSessionId),
    () => makerChatStore.getSnapshot(rootSessionId),
  );
  const historyEpoch = useSyncExternalStore(
    (listener) => makerChatStore.subscribe(rootSessionId, listener),
    () => makerChatStore.getMessageHistoryEpoch(rootSessionId),
    () => makerChatStore.getMessageHistoryEpoch(rootSessionId),
  );
  const message = snapshot?.messages?.find((row) => row.clientId === rootClientId);
  const owner = getDataOwnerGeneration();
  // Keep the existing coordinator across history epochs, not across roots/owners.
  const refresh = useMemo(() => createCoalescedRefresh<void>(), [rootSessionId, rootClientId, owner]);
  const [loaded, setLoaded] = useState<(RootMessage & { sessionId: string;
    owner: ReturnType<typeof getDataOwnerGeneration>; historyEpoch: number }) | null>(null);
  useEffect(() => {
    if (message) return;
    let cancelled = false;
    setLoaded(null);
    let started = false;
    let windowHidden = isWindowHidden();
    // Invalidate display immediately, but let the coordinator finish the active
    // read before the latest epoch. Recheck visibility/lifecycle at actual start.
    const canRead = () => !cancelled && !windowHidden && document.visibilityState !== 'hidden'
      && isDataOwnerGenerationCurrent(owner)
      && makerChatStore.getMessageHistoryEpoch(rootSessionId) === historyEpoch;
    const load = () => {
      if (started || !canRead()) return;
      started = true;
      void refresh(async () => {
        if (!canRead()) { started = false; return; }
        const rows = await aroundMessagesByClientIdFor(rootSessionId, rootClientId, { radius: 0 });
        if (cancelled || !isDataOwnerGenerationCurrent(owner)
          || makerChatStore.getMessageHistoryEpoch(rootSessionId) !== historyEpoch) return;
        const row = rows.find(candidate => candidate.sessionId === rootSessionId && candidate.clientId === rootClientId);
        if (row && (row.role === 'user' || row.role === 'assistant')) {
          const parsed = row.role === 'user' ? parseUserContent(row.content) : {
            text: typeof row.content === 'string' ? row.content : JSON.stringify(row.content),
            images: [], files: [],
          };
          setLoaded({ sessionId: rootSessionId, clientId: rootClientId, role: row.role,
            content: parsed.text, images: parsed.images, files: parsed.files, createdAt: row.createdAt, owner, historyEpoch });
        }
      }).catch(() => { /* Keep the existing unavailable-root presentation; never substitute another message. */ });
    };
    document.addEventListener('visibilitychange', load);
    const offHidden = window.electronAPI?.onWindowHiddenChange?.(hidden => {
      windowHidden = hidden;
      load();
    });
    load();
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', load);
      offHidden?.();
    };
  }, [message, rootClientId, rootSessionId, historyEpoch, owner, refresh]);
  if (message) return message.role === 'user' || message.role === 'assistant' ? message : null;
  return loaded?.sessionId === rootSessionId && loaded.clientId === rootClientId
    && loaded.historyEpoch === historyEpoch
    && isDataOwnerGenerationCurrent(loaded.owner) ? loaded : null;
}

export type BotDmThreadPanelState =
  | { kind: 'opening' }
  | { kind: 'ready'; sessionId: string }
  | { kind: 'failed'; message: string };

/**
 * The topic beside the private chat: its root message on top, then the topic's own task view.
 * Read while open — the newest companion reply in it counts as seen.
 */
export function BotDmThreadPanel({ bot, rootSessionId, rootClientId, state, mentions, lastAssistantAt, replyCount, onRetry, onClose, resize }: {
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
  /** Drag and arrow-key sizing supplied by the host, shared with group topics. */
  resize?: ThreadPanelResize;
}) {
  const { t, i18n } = useTranslation();
  const pluginUi = usePluginUiMessageCandidates();
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
            pluginUi={pluginUi}
            message={{
              id: root.clientId, sequence: 0, kind: 'message',
              authorKind: isBot ? 'bot' : 'user', authorBotId: isBot ? bot.id : null,
              authorName: isBot ? bot.name : t('bots.dmThread.you'), content: root.content,
              mentions: { all: false, botIds: [] }, noticeCode: null, planId: null,
              files: [], attachments: rootAttachments(root), createdAt: root.createdAt ? Date.parse(root.createdAt) : 0,
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
    <ThreadPanel panelRef={panelRef} rootClientId={rootClientId} onClose={onClose} resize={resize}>
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
