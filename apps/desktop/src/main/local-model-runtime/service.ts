import os from 'node:os';
import path from 'node:path';

import { createLogger } from '../logger.js';
import {
  canonicalOllamaModelRef,
  isCuratedQwen38Tag,
  isOllamaModelName,
  normalizeOllamaPullName,
  ollamaModelRefsEqual,
  recommendForHost,
  recommendQwen38,
  resolveManagedOllamaAgents,
  resolveOllamaModelLists,
  type CuratedOllamaModel,
  type LocalInstalledModel,
  type LocalModelPullProgress,
  type LocalRecommendReason,
  type LocalRuntimeInstallProgress,
  type LocalRuntimeStatus,
  type RecommendedLocalModel,
} from '../../shared/localModelRuntime.js';
import {
  deleteOllamaModel,
  fetchOllamaShow,
  fetchOllamaTags,
  streamOllamaPull,
  type OllamaFetch,
} from './ollamaClient.js';
import {
  purgeCancelledOllamaPull,
  resolveOllamaModelsDir,
  waitForIncompleteBlobsToSettle,
} from './ollamaPurge.js';
import {
  createPausedPullStore,
  progressFromPausedRecord,
  type PausedPullRecord,
} from './pausedPullStore.js';
import {
  applyOllamaPullEvent,
  createPullSpeedTracker,
  createThrottledEmitter,
} from './pullProgress.js';
import { detectLocalConnectPresets } from './localConnectDetect.js';
import { installOfficialSidecar } from './ollamaInstall.js';
import { supportsManagedOllamaInstall } from './ollamaRelease.js';
import { probeOllamaStatus, startOfficialOllamaApp } from './ollamaRuntime.js';
import {
  ensureManagedOllamaProvider,
  managedOllamaRemovalGeneration,
  syncManagedOllamaAgentProjections,
  readManagedOllamaProvider,
  removeManagedOllamaModel,
  toPlainRuntimeModel,
  toQwenRuntimeModel,
  upsertManagedOllamaModel,
  upsertManagedOllamaModels,
  type ManagedEnsureResult,
} from './managedOllamaProvider.js';

const log = createLogger('local-model-runtime');

export type LocalModelOwnerScope = { dataOwnerId: string | null; generation: number };

export class PullBusyError extends Error {
  readonly code = 'PULL_BUSY';
  constructor() {
    super('cannot change this model while it is downloading');
    this.name = 'PullBusyError';
  }
}

export class OwnerChangedError extends Error {
  readonly code = 'OWNER_CHANGED';
  constructor() {
    super('active account changed during local model download');
    this.name = 'OwnerChangedError';
  }
}

export interface LocalModelListResult {
  status: LocalRuntimeStatus;
  models: LocalInstalledModel[];
  recommended: RecommendedLocalModel | null;
  catalog: CuratedOllamaModel[];
  featured: CuratedOllamaModel[];
  memoryGb: number;
  recommendReason: LocalRecommendReason;
  appleSilicon: boolean;
  pull: LocalModelPullProgress | null;
  pulls: LocalModelPullProgress[];
  pausedPull: LocalModelPullProgress | null;
  detectedLocalPresetIds: string[];
  catalogDirty?: boolean;
}

export interface LocalModelService {
  status(): Promise<LocalRuntimeStatus>;
  start(): Promise<LocalRuntimeStatus>;
  list(opts?: {
    owner?: LocalModelOwnerScope | null;
    ownerStillActive?: () => boolean;
  }): Promise<LocalModelListResult>;
  pull(
    name: string,
    opts?: {
      owner?: LocalModelOwnerScope | null;
      ownerStillActive?: () => boolean;
    },
  ): Promise<void>;
  abortPull(reason: 'pause' | 'cancel', name: string): Promise<{ ok: true }>;
  ensureProvider(opts?: {
    owner?: LocalModelOwnerScope | null;
    ownerStillActive?: () => boolean;
  }): Promise<ManagedEnsureResult>;
  setModelInPicker(
    name: string,
    enabled: boolean,
    opts?: {
      owner?: LocalModelOwnerScope | null;
      ownerStillActive?: () => boolean;
    },
  ): Promise<ManagedEnsureResult>;
  deleteInstalled(
    name: string,
    opts?: {
      owner?: LocalModelOwnerScope | null;
      ownerStillActive?: () => boolean;
    },
  ): Promise<ManagedEnsureResult>;
  discardPaused(name: string): Promise<void>;
  installRuntime(): Promise<LocalRuntimeStatus>;
  abortInstall(): Promise<{ ok: true }>;
  recommend(): RecommendedLocalModel | null;
  activePull(): LocalModelPullProgress | null;
  activePulls(): LocalModelPullProgress[];
}

export interface LocalModelServiceDeps {
  platform?: NodeJS.Platform;
  arch?: string;
  totalmem?: () => number;
  fetchImpl?: OllamaFetch;
  streamPull?: typeof streamOllamaPull;
  deleteModel?: (name: string) => Promise<void>;
  purgeCancelledPull?: (opts: {
    name: string;
    digests: readonly string[];
    deleteAllIncomplete?: boolean;
    pruneUnreferenced?: boolean;
    deleteManifest?: boolean;
    keepDigests?: readonly string[];
    touchedSinceMs?: number;
  }) => Promise<unknown>;
  waitForCancelledBlobs?: (opts?: { digests?: readonly string[] }) => Promise<void>;
  onStatus?: (status: LocalRuntimeStatus) => void;
  onPullProgress?: (progress: LocalModelPullProgress) => void;
  onInstallProgress?: (progress: LocalRuntimeInstallProgress) => void;
  pausedPullStore?: ReturnType<typeof createPausedPullStore>;
  userDataDir?: string;
}

interface ActivePull {
  name: string;
  owner: LocalModelOwnerScope | null;
  promise: Promise<void>;
  lastProgress: LocalModelPullProgress;
  removalGeneration: number;
  abort: AbortController;
  stopReason: 'pause' | 'cancel' | null;
  digests: Set<string>;
}

export class PullAbortedError extends Error {
  readonly reason: 'pause' | 'cancel';
  constructor(reason: 'pause' | 'cancel') {
    super(reason === 'pause' ? 'download paused' : 'download cancelled');
    this.name = 'PullAbortedError';
    this.reason = reason;
  }
}

export function createLocalModelService(deps: LocalModelServiceDeps = {}): LocalModelService {
  const platform = deps.platform ?? process.platform;
  const arch = (deps.arch ?? process.arch) as NodeJS.Architecture;
  const fetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init));
  const streamPull = deps.streamPull ?? streamOllamaPull;
  const deleteModel = deps.deleteModel ?? ((name: string) => deleteOllamaModel(fetchImpl, name));
  const modelsDir = () => resolveOllamaModelsDir();
  const purgeCancelledPull =
    deps.purgeCancelledPull ??
    ((opts: {
      name: string;
      digests: readonly string[];
      deleteAllIncomplete?: boolean;
      pruneUnreferenced?: boolean;
      deleteManifest?: boolean;
      keepDigests?: readonly string[];
      touchedSinceMs?: number;
    }) =>
      purgeCancelledOllamaPull({
        modelsDir: modelsDir(),
        name: opts.name,
        digests: opts.digests,
        deleteAllIncomplete: opts.deleteAllIncomplete,
        pruneUnreferenced: opts.pruneUnreferenced,
        deleteManifest: opts.deleteManifest,
        keepDigests: opts.keepDigests,
        touchedSinceMs: opts.touchedSinceMs,
      }));
  const waitForCancelledBlobs =
    deps.waitForCancelledBlobs ??
    ((opts?: { digests?: readonly string[] }) =>
      waitForIncompleteBlobsToSettle({ modelsDir: modelsDir(), digests: opts?.digests }));
  const pausedPullStore =
    deps.pausedPullStore ??
    createPausedPullStore(
      path.join(
        deps.userDataDir ?? os.tmpdir(),
        'local-model-paused-pull.json',
      ),
    );
  const actives = new Map<string, ActivePull>();
  const pausedByName = new Map<string, LocalModelPullProgress>();
  const unclaimedByName = new Map<string, LocalModelOwnerScope>();

  function findActive(name: string): ActivePull | undefined {
    const direct = actives.get(name);
    if (direct) return direct;
    for (const op of actives.values()) {
      if (ollamaModelRefsEqual(op.name, name)) return op;
    }
    return undefined;
  }

  function unclaimedOwner(name: string): LocalModelOwnerScope | undefined {
    const direct = unclaimedByName.get(name);
    if (direct) return direct;
    for (const [key, owner] of unclaimedByName) {
      if (ollamaModelRefsEqual(key, name)) return owner;
    }
    return undefined;
  }

  function clearUnclaimed(name: string): void {
    for (const key of [...unclaimedByName.keys()]) {
      if (ollamaModelRefsEqual(key, name)) unclaimedByName.delete(key);
    }
  }

  function tagsIncludeModel(
    tags: readonly { name: string }[],
    name: string,
  ): boolean {
    return tags.some((tag) => ollamaModelRefsEqual(tag.name, name));
  }

  let startInFlight: Promise<LocalRuntimeStatus> | null = null;
  let installInFlight: Promise<LocalRuntimeStatus> | null = null;
  let installAbort: AbortController | null = null;

  const runtimeDeps = () => ({
    platform,
    arch,
    fetchImpl,
    userDataDir: deps.userDataDir,
  });

  async function installRuntime(): Promise<LocalRuntimeStatus> {
    if (installInFlight) return installInFlight;
    if (!supportsManagedOllamaInstall(platform, arch)) {
      throw new Error('managed ollama install is not available on this system');
    }
    if (!deps.userDataDir) {
      throw new Error('managed ollama install needs a userData directory');
    }
    const userDataDir = deps.userDataDir;
    installAbort = new AbortController();
    const signal = installAbort.signal;
    const run = (async () => {
      deps.onStatus?.({
        runtime: 'ollama',
        kind: 'starting',
        appInstalled: false,
        canInstallRuntime: true,
      });
      try {
        await installOfficialSidecar(userDataDir, {
          platform,
          arch,
          signal,
          onProgress: deps.onInstallProgress,
        });
        if (signal.aborted) throw new Error('aborted');
        deps.onInstallProgress?.({ phase: 'starting', done: false });
        const next = await startOfficialOllamaApp({ ...runtimeDeps(), signal });
        if (signal.aborted) throw new Error('aborted');
        deps.onStatus?.(next);
        if (next.kind === 'ready') {
          deps.onInstallProgress?.({ phase: 'success', version: next.version, done: true });
        } else if (!signal.aborted) {
          deps.onInstallProgress?.({
            phase: 'error',
            done: true,
            error: next.message ?? next.kind,
          });
        }
        return next;
      } catch (error) {
        const aborted = signal.aborted || (error instanceof Error && /abort/i.test(error.message));
        const message = error instanceof Error ? error.message : String(error);
        deps.onInstallProgress?.({
          phase: aborted ? 'cancelled' : 'error',
          done: true,
          error: aborted ? undefined : message,
        });
        const next = await probeStatus();
        deps.onStatus?.(next);
        if (aborted) throw new PullAbortedError('cancel');
        throw error;
      }
    })().finally(() => {
      installInFlight = null;
      installAbort = null;
    });
    installInFlight = run;
    return run;
  }

  async function abortInstall(): Promise<{ ok: true }> {
    installAbort?.abort();
    if (installInFlight) await installInFlight.catch(() => undefined);
    return { ok: true };
  }

  async function loadPausedRecords(): Promise<PausedPullRecord[]> {
    if (pausedPullStore.readAll) return pausedPullStore.readAll();
    const one = await pausedPullStore.read();
    return one ? [one] : [];
  }

  function loadPausedRecordsSync(): PausedPullRecord[] {
    if (pausedPullStore.readAllSync) return pausedPullStore.readAllSync();
    const one = pausedPullStore.readSync?.() ?? null;
    return one ? [one] : [];
  }

  async function rememberedPaused(): Promise<LocalModelPullProgress[]> {
    for (const record of await loadPausedRecords()) {
      if (!pausedByName.has(record.name)) {
        pausedByName.set(record.name, progressFromPausedRecord(record));
      }
    }
    return [...pausedByName.values()];
  }

  async function rememberPaused(progress: LocalModelPullProgress, digests: readonly string[]): Promise<void> {
    const next: LocalModelPullProgress = {
      ...progress,
      phase: 'paused',
      status: 'paused',
      done: true,
      bytesPerSecond: undefined,
    };
    pausedByName.set(next.name, next);
    await pausedPullStore.write(next, digests);
  }

  async function forgetPaused(name?: string): Promise<PausedPullRecord | null> {
    if (!name) {
      pausedByName.clear();
      await pausedPullStore.clear();
      return null;
    }
    const records = await loadPausedRecords();
    const record = records.find((item) => ollamaModelRefsEqual(item.name, name)) ?? null;
    for (const key of [...pausedByName.keys()]) {
      if (ollamaModelRefsEqual(key, name)) pausedByName.delete(key);
    }
    if (pausedPullStore.remove) {
      await pausedPullStore.remove(record?.name ?? name);
      return record;
    }
    const current = await pausedPullStore.read();
    if (current && ollamaModelRefsEqual(current.name, name)) await pausedPullStore.clear();
    return record;
  }

  function visiblePulls(extraPaused: readonly LocalModelPullProgress[] = []): LocalModelPullProgress[] {
    const byName = new Map<string, LocalModelPullProgress>();
    for (const item of extraPaused) byName.set(canonicalOllamaModelRef(item.name), item);
    for (const op of actives.values()) byName.set(canonicalOllamaModelRef(op.name), op.lastProgress);
    return [...byName.values()];
  }

  async function probeStatus(): Promise<LocalRuntimeStatus> {
    return probeOllamaStatus(runtimeDeps());
  }

  async function status(): Promise<LocalRuntimeStatus> {
    if (actives.size > 0) {
      const next: LocalRuntimeStatus = {
        runtime: 'ollama',
        kind: 'pulling',
        appInstalled: true,
      };
      deps.onStatus?.(next);
      return next;
    }
    const next = await probeStatus();
    deps.onStatus?.(next);
    return next;
  }

  async function start(): Promise<LocalRuntimeStatus> {
    if (startInFlight) return startInFlight;
    const run = (async () => {
      deps.onStatus?.({ runtime: 'ollama', kind: 'starting', appInstalled: true });
      const next = await startOfficialOllamaApp(runtimeDeps());
      deps.onStatus?.(next);
      return next;
    })().finally(() => {
      startInFlight = null;
    });
    startInFlight = run;
    return run;
  }

  function recommend(): RecommendedLocalModel | null {
    const input = {
      platform,
      arch: deps.arch ?? process.arch,
      totalmemBytes: (deps.totalmem ?? os.totalmem)(),
    };
    return (
      recommendQwen38(input) ??
      (() => {
        const primary = recommendForHost(input).primary;
        return {
          id: primary.libraryName,
          name: primary.name,
          libraryName: primary.libraryName,
          sizeBytes: primary.sizeBytes,
          minUnifiedMemoryGb: primary.minUnifiedMemoryGb,
          appleSiliconOnly: primary.appleSiliconOnly,
        };
      })()
    );
  }

  async function cindyModelIds(): Promise<Set<string>> {
    const existing = await readManagedOllamaProvider();
    return new Set(
      (existing?.runtimes.pi?.models ?? []).map((model) => canonicalOllamaModelRef(model.id)),
    );
  }

  function listsForHost() {
    return resolveOllamaModelLists({
      platform,
      arch: deps.arch ?? process.arch,
      totalmemBytes: (deps.totalmem ?? os.totalmem)(),
    });
  }

  async function list(opts?: {
    owner?: LocalModelOwnerScope | null;
    ownerStillActive?: () => boolean;
  }): Promise<LocalModelListResult> {
    const detectedLocalPresetIdsPromise = detectLocalConnectPresets({ platform }).catch(() => []);
    const current = await status();
    const { catalog, featured, memoryGb, recommendReason, appleSilicon } = listsForHost();
    const recommended = recommend() ?? featured[0] ?? null;
    const pulls = visiblePulls(await rememberedPaused());
    const pull = pulls[0] ?? null;
    const pausedPull = pulls.find((item) => item.phase === 'paused') ?? null;
    const catalogDirty = await syncManagedOllamaAgentProjections(
      resolveManagedOllamaAgents({ version: current.version }),
      { stillActive: opts?.ownerStillActive },
    ).catch(() => false);
    const detectedLocalPresetIds = await detectedLocalPresetIdsPromise;
    if (current.kind !== 'ready' && current.kind !== 'pulling') {
      return {
        status: current,
        models: [],
        recommended,
        catalog,
        featured,
        memoryGb,
        recommendReason,
        appleSilicon,
        pull,
        pulls,
        pausedPull,
        detectedLocalPresetIds,
        catalogDirty,
      };
    }
    let tags: Awaited<ReturnType<typeof fetchOllamaTags>> = [];
    let tagsOk = false;
    try {
      tags = await fetchOllamaTags(fetchImpl);
      tagsOk = true;
    } catch (error) {
      log.warn('ollama tags failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const imported = tagsOk
      ? await importLocalOllamaTags(tags, opts).catch((error) => {
          log.warn('import local ollama tags failed', {
            error: error instanceof Error ? error.message : String(error),
          });
          return false;
        })
      : false;
    const inCindy = await cindyModelIds();
    const models: LocalInstalledModel[] = [];
    for (const tag of tags) {
      let contextLength: number | undefined;
      try {
        contextLength = (await fetchOllamaShow(fetchImpl, tag.name)).contextLength;
      } catch (error) {
        log.warn('ollama show failed', {
          name: tag.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      models.push({
        name: tag.name,
        sizeBytes: tag.size,
        digest: tag.digest,
        contextLength,
        inCindy: inCindy.has(canonicalOllamaModelRef(tag.name)),
      });
    }
    return {
      status: current,
      models,
      recommended,
      catalog,
      featured,
      memoryGb,
      recommendReason,
      appleSilicon,
      pull,
      pulls,
      catalogDirty: catalogDirty || imported,
      detectedLocalPresetIds,
      pausedPull,
    };
  }

  async function pull(
    name: string,
    opts?: {
      owner?: LocalModelOwnerScope | null;
      ownerStillActive?: () => boolean;
    },
  ): Promise<void> {
    const pullName = typeof name === 'string' ? normalizeOllamaPullName(name) : null;
    if (!pullName) {
      throw new Error('invalid ollama model name');
    }
    name = pullName;
    const existing = findActive(name);
    if (existing) return existing.promise;
    const removalGeneration = managedOllamaRemovalGeneration();
    const owner = opts?.owner ?? null;
    const op: ActivePull = {
      name,
      owner,
      promise: Promise.resolve(),
      lastProgress: { name, status: 'starting', phase: 'starting', done: false },
      removalGeneration,
      abort: new AbortController(),
      stopReason: null,
      digests: new Set<string>(),
    };
    actives.set(name, op);
    let checkpointTimer: ReturnType<typeof setTimeout> | null = null;
    let persistCheckpoints = true;
    const disarmCheckpoint = () => {
      persistCheckpoints = false;
      if (checkpointTimer) {
        clearTimeout(checkpointTimer);
        checkpointTimer = null;
      }
    };
    const checkpoint = (force = false) => {
      const write = () => {
        checkpointTimer = null;
        if (!persistCheckpoints) return;
        void rememberPaused(op.lastProgress, [...op.digests]).catch((error) => {
          log.warn('checkpoint in-flight pull failed', {
            name,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      };
      if (force) {
        if (checkpointTimer) clearTimeout(checkpointTimer);
        write();
        return;
      }
      if (!checkpointTimer) checkpointTimer = setTimeout(write, 1_000);
    };
    checkpoint(true);
    const run = (async () => {
      deps.onStatus?.({ runtime: 'ollama', kind: 'pulling', appInstalled: true });
      const layers = new Map<string, { completed: number; total: number }>();
      const speed = createPullSpeedTracker();
      const emitter = createThrottledEmitter((progress) => {
        op.lastProgress = progress;
        deps.onPullProgress?.(progress);
        checkpoint();
      });
      emitter.push(op.lastProgress, true);
      try {
        let alreadyLocal = false;
        try {
          const tags = await fetchOllamaTags(fetchImpl);
          alreadyLocal = tagsIncludeModel(tags, name);
        } catch {
          alreadyLocal = false;
        }
        if (!alreadyLocal) {
          await streamPull(
            name,
            (event) => {
              if (event.digest) op.digests.add(event.digest);
              const fromStatus = /sha256:([a-f0-9]{64})/i.exec(event.status ?? '');
              if (fromStatus) op.digests.add(`sha256:${fromStatus[1]}`);
              emitter.push(applyOllamaPullEvent(name, layers, event, speed), Boolean(event.error));
            },
            op.abort.signal,
          );
        }
        disarmCheckpoint();
        await forgetPaused(name);
        const { model, agents } = await describePulledModel(name);
        if (managedOllamaRemovalGeneration() !== removalGeneration) {
          log.info('skip managed upsert after provider removed during pull', { name });
          return;
        }
        const upserted = await upsertManagedOllamaModel(model, agents, {
          stillActive: opts?.ownerStillActive,
        });
        if (!upserted.ok) {
          if (upserted.code === 'OWNER_CHANGED') {
            if (opts?.owner) unclaimedByName.set(name, opts.owner);
            throw new OwnerChangedError();
          }
          throw new Error('MANAGED_ID_CONFLICT');
        }
        emitter.flush();
        const done: LocalModelPullProgress = {
          name,
          status: 'success',
          phase: 'success',
          percent: 100,
          done: true,
        };
        op.lastProgress = done;
        deps.onPullProgress?.(done);
      } catch (error) {
        disarmCheckpoint();
        const aborted = op.stopReason ?? (isAbortError(error) ? 'cancel' : null);
        if (aborted) {
          emitter.flush();
          const stopped: LocalModelPullProgress = {
            ...op.lastProgress,
            name,
            status: aborted,
            phase: aborted === 'pause' ? 'paused' : 'cancelled',
            done: true,
            bytesPerSecond: undefined,
          };
          op.lastProgress = stopped;
          deps.onPullProgress?.(stopped);
          if (aborted === 'pause') {
            await rememberPaused(stopped, [...op.digests]);
          } else {
            await forgetPaused(name);
          }
          throw new PullAbortedError(aborted);
        }
        const message = error instanceof Error ? error.message : String(error);
        emitter.flush();
        const failed: LocalModelPullProgress = {
          name,
          status: 'error',
          phase: 'error',
          done: true,
          error: message,
        };
        op.lastProgress = failed;
        deps.onPullProgress?.(failed);
        throw error;
      }
    })().finally(() => {
      if (actives.get(name) === op) actives.delete(name);
    });
    op.promise = run;
    return run;
  }

  async function abortPull(reason: 'pause' | 'cancel', name: string): Promise<{ ok: true }> {
    const pullName = normalizeOllamaPullName(name);
    if (!pullName) throw new Error('invalid ollama model name');
    const op = findActive(pullName);
    if (!op) return { ok: true };
    op.stopReason = reason;
    op.abort.abort();
    await op.promise.catch(() => undefined);
    if (reason === 'cancel') {
      await removeCancelledDownload(op.name, [...op.digests]);
    }
    return { ok: true };
  }

  async function removeCancelledDownload(name: string, digests: readonly string[]): Promise<void> {
    let keepInstalled = true;
    try {
      const tags = await fetchOllamaTags(fetchImpl);
      keepInstalled = tagsIncludeModel(tags, name);
    } catch {
      keepInstalled = true;
    }
    if (!keepInstalled) {
      try {
        await deleteModel(name);
      } catch (error) {
        log.warn('delete cancelled ollama pull failed', {
          name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    try {
      await waitForCancelledBlobs({ digests });
    } catch (error) {
      log.warn('wait for cancelled ollama blobs failed', {
        name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      await purgeCancelledPull({
        name,
        digests,
        deleteAllIncomplete: false,
        pruneUnreferenced: false,
        deleteManifest: !keepInstalled,
        keepDigests: otherPullDigests(name),
      });
    } catch (error) {
      log.warn('purge cancelled ollama blobs failed', {
        name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function otherPullDigests(exceptName: string): string[] {
    const kept = new Set<string>();
    for (const [name, op] of actives) {
      if (ollamaModelRefsEqual(name, exceptName)) continue;
      for (const digest of op.digests) kept.add(digest);
    }
    for (const record of loadPausedRecordsSync()) {
      if (ollamaModelRefsEqual(record.name, exceptName)) continue;
      for (const digest of record.digests) kept.add(digest);
    }
    return [...kept];
  }

  function isAbortError(error: unknown): boolean {
    return error instanceof Error && /abort/i.test(error.message);
  }

  async function setModelInPicker(
    name: string,
    enabled: boolean,
    opts?: {
      owner?: LocalModelOwnerScope | null;
      ownerStillActive?: () => boolean;
    },
  ): Promise<ManagedEnsureResult> {
    const pullName = normalizeOllamaPullName(name);
    if (!pullName) {
      throw new Error('invalid ollama model name');
    }
    name = pullName;
    const writeOpts = { stillActive: opts?.ownerStillActive };
    if (!enabled) return removeManagedOllamaModel(name, writeOpts);
    const { model, agents } = await describePulledModel(name);
    return upsertManagedOllamaModel(model, agents, writeOpts);
  }

  async function deleteInstalled(
    name: string,
    opts?: {
      owner?: LocalModelOwnerScope | null;
      ownerStillActive?: () => boolean;
    },
  ): Promise<ManagedEnsureResult> {
    const pullName = normalizeOllamaPullName(name);
    if (!pullName) {
      throw new Error('invalid ollama model name');
    }
    name = pullName;
    if (findActive(name)) {
      throw new PullBusyError();
    }
    await deleteModel(name);
    return removeManagedOllamaModel(name, { stillActive: opts?.ownerStillActive });
  }

  async function discardPaused(name: string): Promise<void> {
    const pullName = normalizeOllamaPullName(name);
    if (!pullName) {
      throw new Error('invalid ollama model name');
    }
    name = pullName;
    if (findActive(name)) {
      await abortPull('cancel', name);
      return;
    }
    const record = await forgetPaused(name);
    await removeCancelledDownload(name, record?.digests ?? []);
  }

  async function importLocalOllamaTags(
    tags: readonly { name: string }[],
    opts?: {
      owner?: LocalModelOwnerScope | null;
      ownerStillActive?: () => boolean;
    },
  ): Promise<boolean> {
    const owner = opts?.owner;
    if (!(opts?.ownerStillActive?.() ?? true)) return false;
    if (!(await readManagedOllamaProvider())) return false;
    const named = tags.filter((tag) => {
      if (!isOllamaModelName(tag.name)) return false;
      const held = unclaimedOwner(tag.name);
      if (!held) return true;
      return Boolean(owner && held.dataOwnerId === owner.dataOwnerId);
    });
    const entries = [];
    for (const tag of named) {
      entries.push(await describePulledModel(tag.name));
    }
    const retainCanonicalIds = new Set([
      ...named.map((tag) => canonicalOllamaModelRef(tag.name)),
      ...keepPullNames().map((name) => canonicalOllamaModelRef(name)),
    ]);
    const result = await upsertManagedOllamaModels(entries, {
      stillActive: opts?.ownerStillActive,
      retainCanonicalIds,
    });
    if (result.ok) {
      for (const tag of named) clearUnclaimed(tag.name);
    }
    return result.ok;
  }

  function keepPullNames(): string[] {
    const names: string[] = [];
    for (const name of actives.keys()) names.push(name);
    for (const record of loadPausedRecordsSync()) names.push(record.name);
    return names;
  }

  async function describePulledModel(name: string) {
    const probed = await probeStatus();
    let contextLength: number | undefined;
    let capabilities: string[] | undefined;
    let requires: string | undefined;
    try {
      const show = await fetchOllamaShow(fetchImpl, name);
      contextLength = show.contextLength;
      capabilities = show.capabilities;
      requires = show.requires;
    } catch {
      /* show is best-effort */
    }
    const model = isCuratedQwen38Tag(name)
      ? toQwenRuntimeModel(name, contextLength)
      : toPlainRuntimeModel(name, contextLength);
    return {
      model,
      agents: resolveManagedOllamaAgents({
        version: probed.version,
        capabilities,
        requires,
      }),
    };
  }

  function activePulls(): LocalModelPullProgress[] {
    if (actives.size > 0) return [...actives.values()].map((op) => op.lastProgress);
    if (pausedByName.size > 0) return [...pausedByName.values()];
    for (const record of loadPausedRecordsSync()) {
      pausedByName.set(record.name, progressFromPausedRecord(record));
    }
    return [...pausedByName.values()];
  }

  return {
    status,
    start,
    list,
    pull,
    abortPull,
    ensureProvider: async (opts?: {
      owner?: LocalModelOwnerScope | null;
      ownerStillActive?: () => boolean;
    }) => {
      const ensured = await ensureManagedOllamaProvider({
        stillActive: opts?.ownerStillActive,
      });
      if (ensured.ok) {
        try {
          const tags = await fetchOllamaTags(fetchImpl);
          await importLocalOllamaTags(tags, opts);
        } catch (error) {
          log.warn('import local ollama tags after ensure failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return ensured;
    },
    setModelInPicker,
    deleteInstalled,
    discardPaused,
    installRuntime,
    abortInstall,
    recommend,
    activePull: () => activePulls()[0] ?? null,
    activePulls,
  };
}
