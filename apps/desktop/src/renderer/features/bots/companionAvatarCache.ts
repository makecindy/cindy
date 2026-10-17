/**
 * Renderer side of the local avatar cache (main `companion-cloud/avatarCache.ts`): an avatar
 * held by another computer or the cloud is looked up locally first. A miss shows the original
 * address as before and keeps a copy in the background, so the next time (an offline main
 * computer, a restart) it comes from this computer.
 */
import { useEffect, useState } from 'react';

import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';

export interface CompanionAvatarSource {
  avatar: string;
  /** The computer holding a `cindy-media://` avatar; null for a public cloud image. */
  deviceId: string | null;
}

type Api = { resolveCompanionAvatar?: (request: { avatar: string; deviceId?: string | null; fetch?: boolean }) => Promise<string | null> };

/** Resolved local addresses (null = not cached) per owner; never shared across accounts. */
let ownerKey = '';
let resolved = new Map<string, string | null>();
const pending = new Map<string, Promise<string | null>>();

function api(): Api['resolveCompanionAvatar'] | null {
  if (typeof window === 'undefined') return null;
  const maker = (window as { electronAPI?: { maker?: Api } }).electronAPI?.maker;
  return typeof maker?.resolveCompanionAvatar === 'function' ? maker.resolveCompanionAvatar.bind(maker) : null;
}

function scoped(): Map<string, string | null> {
  const owner = getDataOwnerGeneration();
  const key = `${owner.dataOwnerId}:${owner.generation}`;
  if (key !== ownerKey) { ownerKey = key; resolved = new Map(); pending.clear(); }
  return resolved;
}

const keyOf = (source: CompanionAvatarSource) => `${source.deviceId ?? ''}\n${source.avatar}`;

function lookup(source: CompanionAvatarSource): Promise<string | null> {
  const resolve = api();
  const map = scoped();
  const key = keyOf(source);
  if (!resolve) return Promise.resolve(null);
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  const run = resolve({ avatar: source.avatar, deviceId: source.deviceId }).catch(() => null).then((url) => {
    if (scoped() === map) map.set(key, url);
    // Not cached yet: keep a copy for next time; this mount keeps the original address.
    // A failed copy is forgotten, so a later display asks again (the main process paces retries).
    if (!url) void resolve({ avatar: source.avatar, deviceId: source.deviceId, fetch: true }).catch(() => null)
      .then((copy) => { if (scoped() !== map) return; if (copy) map.set(key, copy); else map.delete(key); });
    return url;
  }).finally(() => { pending.delete(key); });
  pending.set(key, run);
  return run;
}

/**
 * Local address for `source`: undefined while the (fast, local) lookup runs, null when there is
 * no copy here yet (show the original), or a `cindy-media://` address.
 */
export function useCachedCompanionAvatar(source: CompanionAvatarSource | null): string | null | undefined {
  const key = source ? keyOf(source) : null;
  const known = () => (source ? (api() ? scoped().get(keyOf(source)) : null) : null);
  const [value, setValue] = useState<string | null | undefined>(known);
  useEffect(() => {
    if (!source) { setValue(null); return; }
    const hit = known();
    setValue(hit);
    if (hit !== undefined) return;
    let live = true;
    void lookup(source).then((url) => { if (live) setValue(url); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the source address
  }, [key]);
  return source ? value : null;
}

/** Test-only reset. */
export function resetCompanionAvatarCacheForTests(): void {
  ownerKey = '';
  resolved = new Map();
  pending.clear();
}
