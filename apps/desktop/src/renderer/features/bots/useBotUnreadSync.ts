import { useEffect, useSyncExternalStore } from 'react';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent, isDataOwnerPushCurrent } from '@/contexts/dataOwnerGeneration';
import { getBotProfiles, refreshBotProfiles, useBotProfiles } from './botStore';
import { subscribeBotReadState } from './botReadState';
import { makerChatStore } from '@/lib/makerChatStore';
import { startBotGroupSync } from './botGroupStore';

/** Per-window list mirrors; entering a section is never a read receipt. */
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
      timer = setTimeout(() => {
        timer = undefined;
        if (isDataOwnerGenerationCurrent(owner)) refreshBotProfiles();
      }, 120);
    };
    const maker = window.electronAPI?.maker;
    const subscriptions = [
      maker?.onBotProfileChanged?.(refresh),
      maker?.onBotLifecycleChanged?.((_payload, stamp) => { if (isDataOwnerPushCurrent(stamp)) refresh(); }),
      subscribeBotReadState(refresh),
      startBotGroupSync(),
      window.electronAPI?.localDb?.messages?.onCreated?.((payload, stamp) => {
        if (!isDataOwnerPushCurrent(stamp) || !isDataOwnerGenerationCurrent(owner)) return;
        // During a live turn only sealed replies enter the preview. Its state
        // transition above refreshes again after the final seal. Unknown/stopped
        // sessions still refresh: late tool rows can change legacy visibility.
        const role = payload.message?.role;
        if ((role === 'tool_use' || role === 'tool_result' || role === 'thinking')
          && makerChatStore.getRunningSnapshot().get(payload.sessionId)?.isRunning) return;
        // Read current membership without tying the subscription or its pending
        // refresh to a profile array that an older list request may replace.
        if (getBotProfiles().some(bot => bot.sessions.some(session => session.id === payload.sessionId))) refresh();
      }),
    ];
    window.addEventListener('focus', refresh);
    return () => {
      if (timer) clearTimeout(timer);
      subscriptions.forEach(unsubscribe => unsubscribe?.());
      window.removeEventListener('focus', refresh);
    };
  }, [owner]);
}
