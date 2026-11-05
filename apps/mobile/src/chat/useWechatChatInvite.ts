import { useEffect } from 'react';
import { Platform } from 'react-native';
import { AUTH_REGION, getActiveMobileSessionRealm, getMobileEndpointForRealm } from '@/config/env';
import { parseChatInviteLink, receiveChatInviteLink } from './chatInviteIntent';

export function useWechatChatInvite(): void {
  useEffect(() => {
    if ((AUTH_REGION !== 'cn' && AUTH_REGION !== 'dev') || (Platform.OS !== 'ios' && Platform.OS !== 'android')) return;
    let disposed = false;
    let subscription: { remove(): void } | undefined;
    let draining = Promise.resolve();
    void import('xdt-wechat-login').then(native => {
      if (disposed) return;
      const drain = () => {
        draining = draining.then(async () => {
          if (disposed) return;
          const ids = await native.consumeWechatLaunchInfos();
          if (disposed) return;
          const base = getMobileEndpointForRealm(getActiveMobileSessionRealm(), 'shareBaseUrl');
          if (!base) return;
          for (const id of ids) {
            if (typeof id !== 'string' || id.length !== 32 || !/^[A-Za-z0-9_-]{32}$/.test(id)) continue;
            const link = parseChatInviteLink(`${base.replace(/\/+$/, '')}/chat-invite/${id}`);
            if (link) receiveChatInviteLink(link);
          }
        }).catch(() => undefined);
      };
      subscription = native.addWechatLaunchListener(drain);
      drain();
    }).catch(() => undefined);
    return () => { disposed = true; subscription?.remove(); };
  }, []);
}
