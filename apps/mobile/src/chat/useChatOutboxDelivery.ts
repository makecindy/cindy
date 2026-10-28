import { useEffect } from 'react';
import { AppState } from 'react-native';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { mobileDurableOutbox } from '@/session/mobileDurableOutbox';
import { forgetRemoteResource } from '@/device-link/remoteResourceCache';
import { createChatOutboxDelivery, suspendChatOutbox } from './chatOutbox';
import { forgetChatMessages, subscribeChatInvalidation } from './chatMessageCache';
import { useChatClient } from './useChatServer';

/** Mounted with MobileOutboxBridge so leaving a group does not stop its saved sends. */
export function useChatOutboxDelivery(accountId: string) {
  const api = useChatClient();
  useEffect(() => {
    if (!accountId || !api.enabled) return;
    const owner = getMobileAuthOwner();
    let active = true;
    const current = () => active && api.current() && isMobileAuthOwnerCurrent(owner)
      && owner.accountKey === accountId && owner.accountId === api.userId;
    const runner = createChatOutboxDelivery({ store: mobileDurableOutbox, client: api.client, current,
      canRun: () => AppState.currentState === 'active',
      accessLost: async roomId => {
        if (!current()) return;
        await Promise.all([forgetChatMessages(roomId), forgetRemoteResource(api.userId, roomId)]);
      } });
    const run = () => { if (current()) void runner.run().catch(() => undefined); };
    const off = mobileDurableOutbox.subscribe(run);
    const offInvalidation = subscribeChatInvalidation(roomId => {
      if (current()) void suspendChatOutbox(mobileDurableOutbox, roomId).catch(() => undefined);
    });
    const timer = setInterval(run, 5_000);
    const app = AppState.addEventListener('change', state => { if (state === 'active') run(); });
    run();
    return () => { active = false; off(); offInvalidation(); clearInterval(timer); app.remove(); };
  }, [accountId, api]);
}
