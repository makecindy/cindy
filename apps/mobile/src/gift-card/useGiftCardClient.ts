import { useEffect, useMemo, useRef } from 'react';
import { useAuth } from '@/auth/AuthContext';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { getActiveMobileSessionRealm, getMobileEndpointForRealm, loadMobileEndpointsForRealm } from '@/config/env';
import { createGiftCardApi } from './giftCardApi';

/**
 * 当前账号的礼品卡接口。绑定到账号、登录代次与区域：切换账号后，旧账号发起的
 * 请求不会带着新账号的凭证发出，它的结果也不会被当成新账号的。
 */
export function useGiftCardClient() {
  const auth = useAuth();
  const realm = getActiveMobileSessionRealm();
  const owner = `${auth.user?.id ?? ''}:${auth.accountGeneration}:${realm}`;
  const active = useRef(owner); active.current = owner;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const deps = useRef(auth); deps.current = auth;
  const client = useMemo(() => {
    const authOwner = getMobileAuthOwner();
    const current = () => mounted.current && active.current === owner
      && getActiveMobileSessionRealm() === realm && isMobileAuthOwnerCurrent(authOwner);
    const check = () => { if (!current()) throw new Error('OWNER_CHANGED'); };
    const baseUrl = () => {
      const url = getMobileEndpointForRealm(realm, 'modelAccessApiBaseUrl').replace(/\/+$/, '');
      if (!url) throw new Error('GIFT_CARD_ENDPOINT_UNAVAILABLE');
      return url;
    };
    const endpoint = async () => {
      check();
      try { return baseUrl(); } catch { /* 该区域的端点清单可能还没加载。 */ }
      await loadMobileEndpointsForRealm(realm, { refresh: true });
      check();
      return baseUrl();
    };
    const api = createGiftCardApi(async (path, body, signal) => {
      const url = await endpoint();
      const result = await deps.current.apiFetch<unknown>(path, {
        baseUrl: url, method: 'POST', body, cache: 'no-store', redirect: 'error',
        ...(signal ? { signal } : {}), assertCurrent: check,
      });
      check();
      return result;
    });
    return { ...api, owner, realm, current };
  }, [owner, realm]);
  // 礼品卡的钱进个人账户：组织身份领不了。界面据此直接说明，不必先问一次服务端。
  const personal = auth.user?.membershipKind !== 'org';
  return useMemo(() => ({ ...client, personal }), [client, personal]);
}
