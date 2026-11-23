/**
 * 头像 → 桌面组件图标的适配层。与对话头像用同一份缓存和预签名路径，
 * 但只做「取一张图」，失败由 `resolveDesktopEntryIcon` 回退到字 / 应用图标。
 */
import { useCallback, useRef } from 'react';

import { useAuth } from '@/auth/AuthContext';
import { DEVICE_LINK_API_BASE_URL, getActiveMobileSessionRealm } from '@/config/env';
import { resolveMobileRemoteMedia, type MobileRemoteMediaPresignResult } from '@/session/remoteMedia';
import { useDeviceLink } from './DeviceLinkContext';
import { resolveDesktopEntryIcon, type DesktopEntryIcon } from './desktopEntryIcon';
import type { DesktopEntryAvatar } from './desktopEntryModel';
import { createMobileMakerTransport } from './mobileMakerTransport';
import { createPeerFileCache } from './peerFileCache';

export interface ResolvableCompanionIcon {
  avatar?: DesktopEntryAvatar | null;
  title: string;
  deviceId: string;
  online: boolean;
}

export function useDesktopEntryIconResolver(): (row: ResolvableCompanionIcon) => Promise<DesktopEntryIcon> {
  const auth = useAuth();
  const { invoke } = useDeviceLink();
  const generation = useRef(auth.accountGeneration);
  generation.current = auth.accountGeneration;
  const userId = auth.user?.id ?? '';
  const apiFetch = auth.apiFetch;

  return useCallback(async (row: ResolvableCompanionIcon) => {
    const realm = getActiveMobileSessionRealm();
    const owner = JSON.stringify([realm, userId]);
    const cache = userId ? await createPeerFileCache(owner).catch(() => null) : null;
    const expected = generation.current;
    const current = () => generation.current === expected;
    const mediaValue = row.avatar?.value?.trim() ?? '';
    return resolveDesktopEntryIcon({
      avatar: row.avatar,
      name: row.title,
      deviceId: row.deviceId,
      cachedAvatarUri: async (identity) => (await cache?.lookupAvatar(identity))?.uri ?? null,
      mediaAvatarUri: row.online && mediaValue
        ? async () => {
          const maker = createMobileMakerTransport({ deviceId: row.deviceId, invoke, isCurrent: current });
          const result = await resolveMobileRemoteMedia({ kind: 'image', url: mediaValue }, {
            fetchRemoteMedia: maker.fetchRemoteMedia,
            presignGet: (key) => apiFetch<MobileRemoteMediaPresignResult>('/api/device-link/media/presign-get', {
              baseUrl: DEVICE_LINK_API_BASE_URL,
              method: 'POST',
              body: { key },
            }),
          }, { thumbnail: true });
          return result.previewable && result.mimeType.startsWith('image/') ? result.url : null;
        }
        : undefined,
    });
  }, [apiFetch, invoke, userId]);
}
