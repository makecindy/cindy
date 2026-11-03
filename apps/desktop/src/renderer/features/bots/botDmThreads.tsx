/**
 * 私聊话题（docs/product-rules/cindy-bots-runtime.md「私聊话题」）。
 *
 * 主人对私聊里的某条消息开话题：话题是这位伙伴的一条隐藏 Session，开在主对话的这条消息上。
 * 这里读出本私聊的话题入口并保持更新；气泡侧的上下文见 botDmThreadsContext.tsx，
 * 面板见 BotDmThreadViews。
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { getDataOwnerGeneration, isDataOwnerGenerationCurrent, isDataOwnerPushCurrent } from '@/contexts/dataOwnerGeneration';
import { makerChatStore } from '@/lib/makerChatStore';
import type { BotDmThreadSummary } from '../../../shared/botDmThread';
import { isBotDmThreadUnread, subscribeBotReadState } from './botReadState';

/**
 * Load the topics opened on messages of `rootSessionId` (the companion's main Chat) and keep
 * them current: a topic message, a companion reply finishing, window focus or a read change.
 */
export function useBotDmThreadList(botId: string | null, rootSessionId: string | null, topicSessionIds: readonly string[]) {
  const [threads, setThreads] = useState<ReadonlyMap<string, BotDmThreadSummary>>(() => new Map());
  const owner = getDataOwnerGeneration();
  const latest = useRef(0);
  const reload = useCallback(() => {
    if (!botId || !rootSessionId) return;
    const request = ++latest.current;
    void window.electronAPI.localDb.bots.dmThread.list({ botId, rootSessionId })
      .then(rows => {
        if (request !== latest.current || !isDataOwnerGenerationCurrent(owner)) return;
        setThreads(new Map(rows.map(row => [row.rootClientId, row])));
      })
      // A failed read keeps the rows already shown; the next change reads again.
      .catch(() => undefined);
  }, [botId, owner, rootSessionId]);
  const topicIds = topicSessionIds.join(',');
  // A sealed reply patches an existing message, so the running set is watched as well.
  const running = useSyncExternalStore(makerChatStore.subscribeAll, makerChatStore.getRunningSnapshot, makerChatStore.getRunningSnapshot);
  const runningTopics = topicIds ? topicIds.split(',').filter(id => running.get(id)?.isRunning).join(',') : '';
  useEffect(() => { reload(); }, [reload, runningTopics, topicIds]);
  useEffect(() => {
    const ids = new Set(topicIds ? topicIds.split(',') : []);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const later = () => {
      if (timer || !isDataOwnerGenerationCurrent(owner)) return;
      timer = setTimeout(() => { timer = undefined; reload(); }, 120);
    };
    const offCreated = window.electronAPI?.localDb?.messages?.onCreated?.((payload, stamp) => {
      if (isDataOwnerPushCurrent(stamp) && ids.has(payload.sessionId)) later();
    });
    window.addEventListener('focus', later);
    return () => {
      if (timer) clearTimeout(timer);
      offCreated?.();
      window.removeEventListener('focus', later);
    };
  }, [owner, reload, topicIds]);
  // Read positions live in local storage; `readVersion` changes the context value so the
  // unread dots re-render when a topic is read here or in another window.
  const [readVersion, setReadVersion] = useState(0);
  useEffect(() => subscribeBotReadState(() => setReadVersion(version => version + 1)), []);
  return { threads, reload, readVersion };
}

export { isBotDmThreadUnread };
