import { useEffect, useSyncExternalStore } from 'react';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent, isDataOwnerPushCurrent } from '@/contexts/dataOwnerGeneration';
import { refreshBotProfiles, useBotProfiles } from './botStore';
import { subscribeBotReadState } from './botReadState';
import { makerChatStore } from '@/lib/makerChatStore';
import { startBotGroupSync } from './botGroupStore';

/** Main-window lifetime: entering a section is never a read receipt. */
export function useBotUnreadSync(): void {
  const bots = useBotProfiles();
  const owner = getDataOwnerGeneration();
  const running = useSyncExternalStore(makerChatStore.subscribeAll, makerChatStore.getRunningSnapshot, makerChatStore.getRunningSnapshot);
  const runningBots = bots.flatMap(bot => bot.sessions.filter(session => running.get(session.id)?.isRunning).map(session => session.id)).sort().join(',');
  // Final seals patch an existing message; they need not emit messages:created.
  useEffect(() => { refreshBotProfiles(); }, [runningBots, owner]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      if (!isDataOwnerGenerationCurrent(owner) || timer) return;
      timer = setTimeout(() => { timer = undefined; refreshBotProfiles(); }, 120);
    };
    refreshBotProfiles();
    const maker = window.electronAPI?.maker;
    const subscriptions = [
      maker?.onBotProfileChanged?.(refresh),
      maker?.onBotLifecycleChanged?.((_payload, stamp) => { if (isDataOwnerPushCurrent(stamp)) refresh(); }),
      subscribeBotReadState(refresh),
      startBotGroupSync(),
    ];
    window.addEventListener('focus', refresh);
    return () => {
      if (timer) clearTimeout(timer);
      subscriptions.forEach(unsubscribe => unsubscribe?.());
      window.removeEventListener('focus', refresh);
    };
  }, [owner]);
  useEffect(() => {
    const ids = new Set(bots.flatMap(bot => bot.sessions.map(session => session.id)));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = window.electronAPI?.localDb?.messages?.onCreated?.((payload, stamp) => {
      if (!isDataOwnerPushCurrent(stamp) || !isDataOwnerGenerationCurrent(owner) || !ids.has(payload.sessionId) || timer) return;
      timer = setTimeout(() => { timer = undefined; refreshBotProfiles(); }, 120);
    });
    return () => { if (timer) clearTimeout(timer); unsubscribe?.(); };
  }, [bots, owner]);
}
