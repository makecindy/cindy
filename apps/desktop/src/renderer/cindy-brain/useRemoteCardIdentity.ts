import { useEffect, useState } from 'react';
import { REMOTE_RESOURCE_GET_CHANNEL, REMOTE_RESOURCE_PROTOCOL_VERSION, resolveRemoteText, type RemoteText } from '@cindy/device-link';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import type { GhostRemoteCardSource } from './ghostCardStore';

interface Identity { name: string; icon: string | null }

/** One read per plugin and computer; the name and icon of an installed plugin rarely change. */
const identities = new Map<string, Promise<Identity | null>>();

function readIdentity(deviceId: string, sessionId: string, pluginId: string, locale: string): Promise<Identity | null> {
  const key = `${deviceId}\n${pluginId}\n${locale}`;
  let read = identities.get(key);
  if (!read) {
    read = window.electronAPI.deviceLink.invoke(deviceId, REMOTE_RESOURCE_GET_CHANNEL, [{
      client: { protocolVersion: REMOTE_RESOURCE_PROTOCOL_VERSION, primitives: ['image'], locale },
      ref: { collectionId: 'plugin-identities', kind: 'plugin', id: JSON.stringify([sessionId, pluginId]) },
    }]).then((raw) => {
      const resource = raw as { display?: { title?: unknown }; blocks?: Array<{ id?: unknown; data?: unknown }> } | null;
      const title = resource?.display?.title;
      const name = title === undefined ? '' : resolveRemoteText(title as RemoteText, locale);
      const url = (resource?.blocks?.find((block) => block.id === 'icon')?.data as { url?: unknown } | undefined)?.url;
      const icon = typeof url === 'string' && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(url) ? url : null;
      return name ? { name, icon } : null;
    }).catch(() => {
      identities.delete(key);
      return null;
    });
    identities.set(key, read);
  }
  return read;
}

/** Name and icon of a remote card's plugin, as installed on the task's computer. */
export function useRemoteCardIdentity(remote: GhostRemoteCardSource | undefined, pluginId: string, locale: string): Identity | null {
  const [identity, setIdentity] = useState<{ key: string; value: Identity | null } | null>(null);
  const key = remote ? `${remote.deviceId}\n${pluginId}\n${locale}` : '';
  useEffect(() => {
    if (!remote) return;
    let active = true;
    const owner = getDataOwnerGeneration();
    void readIdentity(remote.deviceId, remote.sessionId, pluginId, locale).then((value) => {
      if (active && isDataOwnerGenerationCurrent(owner)) setIdentity({ key, value });
    });
    return () => { active = false; };
    // `key` covers the computer, plugin and language; the session only authorizes the read.
  }, [key]);
  return identity?.key === key ? identity.value : null;
}
