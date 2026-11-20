/**
 * Window-level GitHub Release update facts for confirmed local plugins whose manifest declares
 * `githubRelease`.
 *
 * Inputs: the installed ghost snapshot and Main's `ghosts:github-release` check / update replies.
 * Outputs: the available updates the Plugin page banner, card badges and the update-all batch
 * offer, plus the shared check entry used by the plugin settings release row.
 *
 * Request budget: one GitHub API read per plugin and installed version. The Plugin page asks only
 * while the window is visible, one plugin at a time, and reuses a completed result for
 * GITHUB_RELEASE_CHECK_TTL_MS; the settings row forces a fresh read when it opens. Concurrent
 * asks for the same plugin share one request. "Not signed in" is decided by Main without a network
 * read, so it is asked again on the next trigger. Main re-checks the release before downloading,
 * so a cached fact only decides what is offered, never what is installed.
 *
 * Every fact belongs to the data owner generation that read it; a switch hides the old ones.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { getGhostGithubReleaseRepository } from '@cindy/plugin-protocol';

import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  isDataOwnerPushCurrent,
  type DataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';
import { isWindowHidden } from '@/lib/hiddenAnimationGate';
import type { InstalledGhost } from '../../../../shared/ghost';
import type {
  GithubPluginRelease,
  GithubPluginReleaseCheck,
  GithubPluginReleaseResult,
} from '../../../../shared/githubPluginRelease';
import { installedGhostStoragePart, LOCAL_PLUGIN_NAMESPACE } from '../../../../shared/pluginIdentity';
import { reportPluginInstallProgress } from './pluginInstallProgress';

export const GITHUB_RELEASE_CHECK_TTL_MS = 30 * 60_000;

/** The installed instance Main checks; the same gate Main applies before any GitHub read. */
export interface GithubReleaseTarget {
  instanceId: string;
  repository: string;
  installedVersion: string;
}

export interface GithubReleaseUpdate {
  instanceId: string;
  ghostId: string;
  fromVersion: string;
  version: string;
  /** The checked asset; Main installs only when its fresh check still points at it. */
  assetId: number;
}

type GhostLike = Pick<InstalledGhost, 'manifest' | 'namespace' | 'namespaceState'> &
  Partial<Pick<InstalledGhost, 'retirement'>> &
  Parameters<typeof installedGhostStoragePart>[0];

export function githubReleaseTarget(ghost: GhostLike): GithubReleaseTarget | null {
  if (ghost.retirement) return null;
  if (ghost.namespace !== LOCAL_PLUGIN_NAMESPACE || ghost.namespaceState !== 'confirmed') return null;
  const repository = getGhostGithubReleaseRepository(ghost.manifest);
  if (!repository) return null;
  return {
    instanceId: installedGhostStoragePart(ghost),
    repository,
    installedVersion: ghost.manifest.version,
  };
}

interface Fact {
  /** null when the check itself failed (IPC error); retried after the TTL like any result. */
  result: GithubPluginReleaseCheck | null;
  checkedAt: number;
}

let facts: ReadonlyMap<string, Fact> = new Map();
const pending = new Map<string, Promise<GithubPluginReleaseResult | boolean>>();
const listeners = new Set<() => void>();
let queue: Array<{
  owner: DataOwnerGeneration;
  target: GithubReleaseTarget;
  isActive: () => boolean;
}> = [];
let draining = false;

function factKey(owner: DataOwnerGeneration, target: GithubReleaseTarget): string {
  return JSON.stringify([
    owner.dataOwnerId,
    owner.generation,
    target.instanceId,
    target.repository,
    target.installedVersion,
  ]);
}

function setFact(owner: DataOwnerGeneration, target: GithubReleaseTarget, fact: Fact): void {
  if (!isDataOwnerGenerationCurrent(owner)) return;
  const prefix = JSON.stringify([owner.dataOwnerId, owner.generation]).slice(0, -1) + ',';
  const next = new Map<string, Fact>();
  // Keep only the current owner's facts so the map cannot grow across account switches.
  for (const [key, value] of facts) if (key.startsWith(prefix)) next.set(key, value);
  next.set(factKey(owner, target), fact);
  facts = next;
  listeners.forEach((listener) => listener());
}

function isCheck(reply: GithubPluginReleaseResult | boolean): reply is GithubPluginReleaseCheck {
  return typeof reply === 'object' && reply !== null && reply.status !== 'updated';
}

/** Record whatever Main answered for this installed version (check or update action). */
export function recordGithubReleaseReply(
  owner: DataOwnerGeneration,
  target: GithubReleaseTarget,
  reply: GithubPluginReleaseResult | boolean,
  installedRelease?: GithubPluginRelease,
): void {
  const checkedAt = Date.now();
  if (typeof reply === 'object' && reply?.status === 'updated') {
    // The new version is current against the release just installed; no extra read needed.
    if (installedRelease?.version === reply.version) {
      setFact(owner, { ...target, installedVersion: reply.version }, {
        result: { status: 'current', release: installedRelease },
        checkedAt,
      });
    }
    return;
  }
  setFact(owner, target, { result: isCheck(reply) ? reply : null, checkedAt });
}

function isFresh(fact: Fact | undefined, now: number): boolean {
  if (!fact) return false;
  if (fact.result?.status === 'sign-in') return false;
  return now - fact.checkedAt < GITHUB_RELEASE_CHECK_TTL_MS;
}

/**
 * Ask Main for the latest release of this installed version. `force` skips a fresh result (the
 * settings row reads on open); a request already in flight is always shared.
 */
export function checkGithubRelease(
  target: GithubReleaseTarget,
  options: { force?: boolean } = {},
): Promise<GithubPluginReleaseResult | boolean> {
  const owner = getDataOwnerGeneration();
  const key = factKey(owner, target);
  const inflight = pending.get(key);
  if (inflight) return inflight;
  const fact = facts.get(key);
  if (!options.force && fact?.result && isFresh(fact, Date.now())) return Promise.resolve(fact.result);
  const request = window.electronAPI.ghosts
    .githubRelease('check', target.instanceId, undefined)
    .then(
      (reply) => {
        recordGithubReleaseReply(owner, target, reply);
        return reply;
      },
      (error: unknown) => {
        recordGithubReleaseReply(owner, target, false);
        throw error;
      },
    )
    .finally(() => pending.delete(key));
  pending.set(key, request);
  return request;
}

/** Check stale targets one at a time; the Plugin page calls this while the window is visible. */
export function ensureGithubReleaseChecks(
  targets: readonly GithubReleaseTarget[],
  isActive: () => boolean = () => true,
): void {
  const owner = getDataOwnerGeneration();
  const now = Date.now();
  queue = queue.filter((item) => item.isActive());
  const queued = new Set(queue.map((item) => factKey(item.owner, item.target)));
  for (const target of targets) {
    const key = factKey(owner, target);
    if (queued.has(key) || pending.has(key) || isFresh(facts.get(key), now)) continue;
    queue.push({ owner, target, isActive });
    queued.add(key);
  }
  void drain();
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    for (let item = queue.shift(); item; item = queue.shift()) {
      // A check queued for a previous account or generation is not this owner's question.
      if (!item.isActive() || !isDataOwnerGenerationCurrent(item.owner)) continue;
      const key = factKey(item.owner, item.target);
      if (pending.has(key) || isFresh(facts.get(key), Date.now())) continue;
      await checkGithubRelease(item.target).catch(() => undefined);
    }
  } finally {
    draining = false;
  }
}

/**
 * Update through Main with progress forwarded to the shared install progress entry `progressKey`
 * (the runner begins and ends it). Main re-checks first; when a newer asset was published since the
 * offer it answers "available" with that asset, and we follow it once.
 */
export async function runGithubReleaseUpdate(input: {
  target: GithubReleaseTarget;
  assetId: number;
  progressKey: string;
}): Promise<GithubPluginReleaseResult> {
  const { target, progressKey } = input;
  const owner = getDataOwnerGeneration();
  const stop = window.electronAPI.ghosts.onGithubReleaseProgress?.((event, ownerStamp) => {
    if (!isDataOwnerGenerationCurrent(owner) || !isDataOwnerPushCurrent(ownerStamp)) return;
    if (event.instanceId !== target.instanceId) return;
    reportPluginInstallProgress(progressKey, event.progress);
  });
  try {
    let assetId = input.assetId;
    for (let attempt = 0; ; attempt += 1) {
      const offered = facts.get(factKey(owner, target))?.result;
      const offeredRelease = offered && 'release' in offered ? offered.release : undefined;
      const reply = await window.electronAPI.ghosts.githubRelease('update', target.instanceId, assetId);
      if (!isDataOwnerGenerationCurrent(owner) || typeof reply === 'boolean') return { status: 'unavailable' };
      recordGithubReleaseReply(
        owner,
        target,
        reply,
        offeredRelease?.assetId === assetId ? offeredRelease : undefined,
      );
      if (reply.status !== 'available' || reply.release.assetId === assetId || attempt > 0) return reply;
      assetId = reply.release.assetId;
    }
  } finally {
    stop?.();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getFacts(): ReadonlyMap<string, Fact> {
  return facts;
}

/** Available GitHub updates for these installed ghosts, from the current owner's facts. */
export function githubReleaseUpdatesFor(
  ghosts: readonly GhostLike[],
  current: ReadonlyMap<string, Fact> = facts,
): GithubReleaseUpdate[] {
  const owner = getDataOwnerGeneration();
  return ghosts.flatMap((ghost) => {
    const target = githubReleaseTarget(ghost);
    const result = target ? current.get(factKey(owner, target))?.result : undefined;
    if (!target || result?.status !== 'available') return [];
    return [{
      instanceId: target.instanceId,
      ghostId: ghost.manifest.id,
      fromVersion: target.installedVersion,
      version: result.release.version,
      assetId: result.release.assetId,
    }];
  });
}

/**
 * Plugin page hook: keeps the release checks of installed plugins fresh while the window is
 * visible and returns the updates found so far. Re-runs only when the set of targets changes or
 * the window becomes visible again — never on a timer.
 */
export function useGithubReleaseUpdates(ghosts: readonly InstalledGhost[]): GithubReleaseUpdate[] {
  const current = useSyncExternalStore(subscribe, getFacts);
  const targets = useMemo(
    () => ghosts.flatMap((ghost) => {
      const target = githubReleaseTarget(ghost);
      return target ? [target] : [];
    }),
    [ghosts],
  );
  const targetsKey = JSON.stringify(targets);
  useEffect(() => {
    const list = JSON.parse(targetsKey) as GithubReleaseTarget[];
    if (list.length === 0) return undefined;
    let windowHidden = isWindowHidden();
    let mounted = true;
    const isActive = () => mounted && !windowHidden && document.visibilityState !== 'hidden';
    const checkWhenVisible = () => {
      if (isActive()) ensureGithubReleaseChecks(list, isActive);
    };
    checkWhenVisible();
    document.addEventListener('visibilitychange', checkWhenVisible);
    const unsubscribe = window.electronAPI.onWindowHiddenChange?.((hidden) => {
      windowHidden = hidden;
      checkWhenVisible();
    });
    return () => {
      mounted = false;
      queue = queue.filter((item) => item.isActive !== isActive);
      document.removeEventListener('visibilitychange', checkWhenVisible);
      unsubscribe?.();
    };
  }, [targetsKey]);
  return useMemo(() => githubReleaseUpdatesFor(ghosts, current), [ghosts, current]);
}

/** Test only: drop every fact, queued check and in-flight share. */
export function __resetGithubReleaseUpdatesForTest(): void {
  facts = new Map();
  pending.clear();
  queue = [];
  draining = false;
  listeners.clear();
}
