/**
 * 群聊时间线里图片附件的取件（docs/product-rules/bot-group-chat.md §8）。
 *
 * 图片存在电脑的媒体库（`cindy-media://`），与会话消息里的电脑图片走同一条远程媒体链路：
 * `resolveMobileRemoteMedia`（缩略图随回包到手，看原图时再取整张）+ 会话页同款取件队列
 * （同图去重、并发上限、失败冷却）。离开群聊页或换电脑时，把本页取件产生的中转对象删掉。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useAuth } from '@/auth/AuthContext';
import { DEVICE_LINK_API_BASE_URL } from '@/config/env';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { createMobileMakerTransport } from '@/device-link/mobileMakerTransport';
import {
  resolveMobileRemoteMedia,
  type MobileRemoteMediaPresignResult,
  type MobileResolvedRemoteMedia,
  type ResolveRemoteMediaFn,
} from './remoteMedia';
import { createRemoteMediaResolveQueue } from './remoteMediaResolveQueue';

export function useBotGroupRemoteMedia(deviceId: string): ResolveRemoteMediaFn {
  const auth = useAuth();
  const { invoke } = useDeviceLink();
  const depsRef = useRef({ apiFetch: auth.apiFetch, invoke });
  // Layout effect: thumbnails start fetching in their own effects and must see current deps.
  useLayoutEffect(() => { depsRef.current = { apiFetch: auth.apiFetch, invoke }; }, [auth.apiFetch, invoke]);

  const deleteObject = useCallback((media: MobileResolvedRemoteMedia) => {
    // Inline thumbnails and direct transfers leave no relay object behind.
    if (!media.ossKey) return;
    void depsRef.current.apiFetch('/api/device-link/media', {
      baseUrl: DEVICE_LINK_API_BASE_URL,
      method: 'DELETE',
      body: { key: media.ossKey },
    }).catch(() => undefined);
  }, []);

  const queue = useMemo(() => createRemoteMediaResolveQueue({
    resolve: (media, opts) => {
      const { apiFetch, invoke: send } = depsRef.current;
      const maker = createMobileMakerTransport({ deviceId, invoke: send });
      return resolveMobileRemoteMedia(media, {
        fetchRemoteMedia: maker.fetchRemoteMedia,
        presignGet: (key) => apiFetch<MobileRemoteMediaPresignResult>('/api/device-link/media/presign-get', {
          baseUrl: DEVICE_LINK_API_BASE_URL,
          method: 'POST',
          body: { key },
        }),
      }, { ...opts, ...(media.thumbnail ? { thumbnail: true } : {}) });
    },
    onOrphanResolved: deleteObject,
  }, { maxCacheBytes: 16 * 1024 * 1024 }), [deleteObject, deviceId]);

  useEffect(() => () => {
    for (const media of queue.releaseAll()) deleteObject(media);
  }, [deleteObject, queue]);

  return useCallback<ResolveRemoteMediaFn>((media, opts) => queue.request(media, opts), [queue]);
}
