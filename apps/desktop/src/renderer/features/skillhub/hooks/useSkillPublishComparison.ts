import { useEffect, useState } from 'react';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent, type DataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import type { SkillhubPublishComparison } from '../../../../shared/skillhubPublishComparison';

export type PublishComparisonState = SkillhubPublishComparison | { status: 'checking' };
const FRESH_MS = 30_000;
const listeners = new Set<(path?: string) => void>();
let revision = 0;
const pathRevisions = new Map<string, number>();
let lastFocusRefresh = 0;
let active = 0;
const queue: Array<() => void> = [];
const inFlight = new Map<string, { promise: Promise<SkillhubPublishComparison>; consumers: Set<() => boolean> }>();
const cache = new Map<string, { path: string; value: SkillhubPublishComparison; at: number }>();
let cacheOwner: DataOwnerGeneration | undefined;
let retryAfter = 0;

export function invalidatePublishComparison(path?: string): void {
  if (path) pathRevisions.set(path, (pathRevisions.get(path) ?? 0) + 1);
  else { revision++; pathRevisions.clear(); }
  for (const [key, entry] of cache) if (!path || entry.path === path) cache.delete(key);
  listeners.forEach((listener) => listener(path));
}

function onFocus(): void {
  if (document.visibilityState === 'hidden' || Date.now() - lastFocusRefresh < 200) return;
  lastFocusRefresh = Date.now();
  // Reuse fresh results on rapid focus/navigation; local mutations explicitly invalidate them.
  listeners.forEach((listener) => listener());
}

function drain(): void {
  while (active < 3 && queue.length) queue.shift()?.();
}

function compare(key: string, skillId: string, absolutePath: string, owner: DataOwnerGeneration, current: () => boolean) {
  if (cacheOwner !== owner) { cache.clear(); cacheOwner = owner; retryAfter = 0; }
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < FRESH_MS) return Promise.resolve(cached.value);
  const existing = inFlight.get(key);
  if (existing) { existing.consumers.add(current); return existing.promise; }
  const consumers = new Set([current]);
  const promise = new Promise<SkillhubPublishComparison>((resolve) => {
    queue.push(() => {
      // Leaving a page also cancels work that has not reached the IPC yet.
      if (![...consumers].some((consumer) => consumer())) { resolve({ status: 'unavailable' }); return; }
      const finish = (value: SkillhubPublishComparison) => {
        if (isDataOwnerGenerationCurrent(owner)) {
          if (cache.size >= 256) cache.delete(cache.keys().next().value!);
          cache.set(key, { path: absolutePath, value, at: Date.now() });
        }
        resolve(value);
      };
      if (Date.now() < retryAfter) { finish({ status: 'unavailable' }); return; }
      active++;
      Promise.resolve().then(() => window.electronAPI.skillhub.comparePublished({ skillId, absolutePath }))
        .then((result): SkillhubPublishComparison => result && ['same', 'different', 'not-owner', 'unavailable'].includes(result.status)
          ? result : { status: 'unavailable' }, (): SkillhubPublishComparison => ({ status: 'unavailable' }))
        .then((value) => {
          // A failing service must not turn the remaining queue into a request burst.
          if (value.status === 'unavailable' && value.reason === 'service' && isDataOwnerGenerationCurrent(owner)) retryAfter = Date.now() + FRESH_MS;
          finish(value);
        }).finally(() => { active--; drain(); });
    });
  }).finally(() => { inFlight.delete(key); });
  inFlight.set(key, { promise, consumers });
  // Let StrictMode's cleanup/remount subscribe before evaluating queued consumers.
  queueMicrotask(drain);
  return promise;
}

/** Owner-scoped short-lived results; explicit mutations refresh immediately, with no polling. */
export function useSkillPublishComparison(skill: SkillhubSkill | null) {
  const absolutePath = skill?.kind === 'skill' && !skill.builtIn ? skill.absolutePath : null;
  const skillId = skill?.id ?? '';
  const [refresh, setRefresh] = useState(0);
  const owner = getDataOwnerGeneration();
  const key = JSON.stringify([
    owner, absolutePath, skillId, skill?.registrySkillName ?? skill?.name,
    skill?.registryEntry?.catalogScope, skill?.registryEntry?.version,
    skill?.registryEntry?.folderHash, skill?.registryEntry?.updatedAt,
    revision, absolutePath ? pathRevisions.get(absolutePath) ?? 0 : 0,
  ]);
  const [result, setResult] = useState<{ key: string; refresh: number; value: PublishComparisonState } | null>(null);

  useEffect(() => {
    if (!absolutePath) return;
    const listener = (path?: string) => {
      if (!path || path === absolutePath) setRefresh((value) => value + 1);
    };
    if (!listeners.size) {
      window.addEventListener('focus', onFocus);
      document.addEventListener('visibilitychange', onFocus);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) {
        window.removeEventListener('focus', onFocus);
        document.removeEventListener('visibilitychange', onFocus);
      }
    };
  }, [absolutePath]);

  useEffect(() => {
    if (!absolutePath) return;
    let cancelled = false;
    const current = () => !cancelled && isDataOwnerGenerationCurrent(owner);
    void compare(key, skillId, absolutePath, owner, current).then((value) => {
      if (current()) setResult({ key, refresh, value });
    });
    return () => { cancelled = true; };
  }, [key, refresh, absolutePath, skillId, owner]);

  const comparison: PublishComparisonState = !absolutePath ? { status: 'not-owner' }
    : result?.key === key && result.refresh === refresh ? result.value : { status: 'checking' };
  return { comparison, refresh };
}
