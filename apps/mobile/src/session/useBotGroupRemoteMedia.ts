/**
 * 群聊时间线里图片附件的取件（docs/product-rules/bot-group-chat.md §8）。
 *
 * 图片存在电脑的媒体库（`cindy-media://`），与会话消息里的电脑图片走同一条远程媒体链路和
 * 同一份手机磁盘缓存（`createCachedRemoteMediaQueue`）：缩略图随回包到手并落盘，看原图时再取
 * 整张并落盘；之后再进群、滚回或重启 App 直接显示本地副本。离开群聊页或换电脑时，把本页取件
 * 产生的中转对象删掉（磁盘副本保留）。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useAuth } from '@/auth/AuthContext';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { createMobileMakerTransport } from '@/device-link/mobileMakerTransport';
import { createCachedRemoteMediaQueue, remoteMediaDiskSource } from './cachedRemoteMediaQueue';
import type { ResolveRemoteMediaFn } from './remoteMedia';

export function useBotGroupRemoteMedia(deviceId: string): ResolveRemoteMediaFn {
  const auth = useAuth();
  const { invoke } = useDeviceLink();
  const depsRef = useRef({ apiFetch: auth.apiFetch, invoke, userId: auth.user?.id });
  // Layout effect: thumbnails start fetching in their own effects and must see current deps.
  useLayoutEffect(() => {
    depsRef.current = { apiFetch: auth.apiFetch, invoke, userId: auth.user?.id };
  }, [auth.apiFetch, auth.user?.id, invoke]);

  const cached = useMemo(() => createCachedRemoteMediaQueue(() => {
    const { apiFetch, invoke: send, userId } = depsRef.current;
    return {
      apiFetch,
      fetchRemoteMedia: createMobileMakerTransport({ deviceId, invoke: send }).fetchRemoteMedia,
      diskSource: (url) => remoteMediaDiskSource(userId, deviceId, url),
    };
  }, { maxCacheBytes: 16 * 1024 * 1024 }), [deviceId]);

  useEffect(() => () => cached.releaseAll(), [cached]);

  return useCallback<ResolveRemoteMediaFn>((media, opts) => cached.queue.request(media, opts), [cached]);
}
