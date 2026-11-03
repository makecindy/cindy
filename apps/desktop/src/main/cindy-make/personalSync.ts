import type { CindyMakeTaskOptions } from '../../shared/cindyMakeDoctor.js';
import type { CindyMakeMergeState } from '../../shared/cindyMakeMerge.js';
import type { CindyMakeRemoteSync } from '../../shared/cindyMakePersonalRemote.js';
import type {
  CindyMakeSyncDone,
  CindyMakeSyncError,
  CindyMakeSyncState,
  CindyMakeSyncStep,
  CindyMakeSyncWaiting,
} from '../../shared/cindyMakeSync.js';
import type { SyncTarget } from './syncTarget.js';
import { resumable } from './upstreamMergeController.js';

/** Sharing through the user's GitHub; absent when the personal version stays on this computer. */
export interface PersonalSyncRemote {
  /** Fetch, take over what is safe and upload established changes; the resulting state. */
  sync(): Promise<CindyMakeRemoteSync | undefined>;
  /** The GitHub version the last fetch saw, with its official base. */
  tips(): Promise<{ commit: string; base: string } | undefined>;
  /** Keep one side when the two cannot be combined; the other stays backed up. */
  keep(side: 'github' | 'local'): Promise<CindyMakeRemoteSync | undefined>;
}

/** What survives a restart: the operation Sync waits for, and the last result. */
export interface PersonalSyncRecord {
  waiting?: string;
  done?: CindyMakeSyncDone;
}

export interface PersonalSyncDeps {
  remote(): PersonalSyncRemote | undefined;
  target(): Promise<SyncTarget>;
  /**
   * Official commit this computer's personal version is based on. Recorded on first
   * use when an older source has none, so every later step reads the same base.
   */
  base(): Promise<string | undefined>;
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  /**
   * The personal version carries changes not generated yet. An official update would
   * rewrite them out of reach of the rollback a failed generation needs, so it waits.
   */
  unbuilt(): Promise<boolean>;
  /** The retained source operation, if any. */
  operation(): CindyMakeMergeState | undefined;
  /** Finish a retained source operation first; opens its conflict task when it has none. */
  resume(options?: CindyMakeTaskOptions): Promise<CindyMakeMergeState | undefined>;
  combine(
    remote: { commit: string; base: string },
    options?: CindyMakeTaskOptions,
  ): Promise<CindyMakeMergeState | undefined>;
  update(
    target: { ref: string; commit: string },
    options?: CindyMakeTaskOptions,
  ): Promise<CindyMakeMergeState | undefined>;
  /** Stop the conflict task and discard its candidate; nothing is adopted. */
  abandon(operationId: string): Promise<CindyMakeMergeState | undefined>;
  /** Use a checked result although some changes are missing from it (the user's decision). */
  accept(operationId: string): Promise<CindyMakeMergeState | undefined>;
  /** Keep builds from starting while Sync moves the source; returns the release. */
  reserve(): () => void;
  load(): PersonalSyncRecord;
  save(record: PersonalSyncRecord): void;
  publish(state: CindyMakeSyncState): void;
  now(): number;
  log?: { warn(message: string, data?: Record<string, unknown>): void };
}

const syncError = (code: CindyMakeSyncError) => Object.assign(new Error(code), { syncCode: code });
function classify(error: unknown): CindyMakeSyncError {
  const own = (error as { syncCode?: CindyMakeSyncError })?.syncCode;
  if (own) return own;
  const code = (error as { code?: string })?.code;
  if (code === 'busy') return 'busy';
  if (code === 'github' || code === 'account' || code === 'workflowScope') return 'github';
  if (code === 'network') return 'network';
  if (code === 'gitOutdated') return 'gitOutdated';
  if (code === 'forkMissing' || code === 'forkUnavailable') return 'forkMissing';
  if (code === 'forkArchived') return 'forkArchived';
  if (code === 'source' || code === 'dirty' || code === 'baselineChanged') return 'source';
  if (code === 'unavailable') return 'unavailable';
  return 'failed';
}

/**
 * The line a retained source operation shows while it is not adopted, or undefined
 * when it is not Sync's to show (finished, a change-history operation, or another
 * account's).
 */
export function syncWaiting(state: CindyMakeMergeState | undefined): CindyMakeSyncWaiting | undefined {
  if (
    !state ||
    state.feature ||
    state.hasWorkspace !== true ||
    !['conflict', 'resolving', 'checking', 'failed'].includes(state.status)
  )
    return undefined;
  // Shown, never handled here: only its own account may continue or abandon it.
  if (state.ownedByAnotherAccount)
    return { kind: state.remote ? 'combine' : 'official', reason: 'otherAccount' };
  // A cancellation that failed is offered again through Abandon, not shown as progress.
  const abandoning = !!state.cancellationRequested && state.status !== 'failed';
  const reason: CindyMakeSyncWaiting['reason'] = abandoning
    ? 'working'
    : state.needsInput
      ? 'input'
      : resumable(state)
        ? 'paused'
        : state.status !== 'failed'
        ? 'working'
        : state.error === 'interrupted'
          ? 'interrupted'
          : state.error === 'checksFailed' && state.missing
            ? 'missing'
            : state.error === 'baselineChanged'
              ? 'stale'
              : 'failed';
  return {
    kind: state.remote ? 'combine' : 'official',
    reason,
    ...(state.sessionId ? { sessionId: state.sessionId } : {}),
    ...(reason === 'missing' ? { missing: state.missing!.count } : {}),
    ...(abandoning ? { abandoning: true } : {}),
  };
}

const sameWaiting = (a?: CindyMakeSyncWaiting, b?: CindyMakeSyncWaiting) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * The single Sync of a personal version. Every step decides from the current Git
 * facts what is left to do, so pressing Sync again, a restart or a finished
 * conflict task simply continue where the work stopped. Durable state lives in
 * the shared source-merge lifecycle and the GitHub binding; Sync only remembers
 * which operation it waits for and its last result.
 */
export class PersonalSync {
  private current: CindyMakeSyncState = {};
  private active?: Promise<void>;
  /** The operation this Sync waits for, and the preferences to continue with. */
  private waitingFor?: { operationId: string; options?: CindyMakeTaskOptions };
  private done?: CindyMakeSyncDone;

  constructor(private readonly deps: PersonalSyncDeps) {
    let record: PersonalSyncRecord = {};
    try {
      record = deps.load();
    } catch {
      // Nothing to continue: Sync starts fresh.
    }
    if (record.waiting) this.waitingFor = { operationId: record.waiting };
    this.done = record.done;
    this.current = this.done ? { done: this.done } : {};
    this.operationChanged(deps.operation(), true);
  }

  state(): CindyMakeSyncState {
    return this.current;
  }

  /** Start Sync (a no-op while one runs); progress arrives through `publish`. */
  sync(options?: CindyMakeTaskOptions, keep?: 'github' | 'local'): CindyMakeSyncState {
    if (!this.active) {
      this.active = this.run(options, keep).finally(() => {
        this.active = undefined;
        // An operation that changed while Sync ran is shown now.
        this.operationChanged(this.deps.operation());
      });
    }
    return this.current;
  }

  settled(): Promise<void> {
    return this.active ?? Promise.resolve();
  }

  /** Give up the operation Sync waits for; both versions stay as they were. */
  async abandon(): Promise<CindyMakeSyncState> {
    const operation = this.deps.operation();
    const line = syncWaiting(operation);
    if (this.active || !operation || !line || line.reason === 'otherAccount') return this.current;
    this.adopt(operation.id);
    try {
      this.operationChanged(await this.deps.abandon(operation.id));
    } catch (error) {
      this.set({ ...this.current, error: classify(error) });
    }
    return this.current;
  }

  /**
   * The two personal versions cannot be combined, or the user gave up combining them:
   * keep one side as chosen, then continue like Sync. Only offered with GitHub.
   */
  keep(side: 'github' | 'local', options?: CindyMakeTaskOptions): CindyMakeSyncState {
    const choosable =
      this.current.error === 'diverged' ||
      (this.current.error === 'cancelled' && this.current.abandoned === 'combine');
    if (this.active || !choosable || !this.deps.remote()) return this.current;
    return this.sync(options, side);
  }

  /** Use the result although the named changes are missing; Sync then continues. */
  async accept(): Promise<CindyMakeSyncState> {
    const operation = this.deps.operation();
    if (this.active || !operation || syncWaiting(operation)?.reason !== 'missing')
      return this.current;
    this.adopt(operation.id);
    try {
      this.operationChanged(await this.deps.accept(operation.id));
    } catch (error) {
      this.set({ ...this.current, error: classify(error) });
    }
    return this.current;
  }

  /**
   * The shared source operation changed: continue a Sync that waited for it, or show it.
   * At startup an operation adopted before the restart is not continued unasked.
   */
  operationChanged(state: CindyMakeMergeState | undefined, restoring = false): void {
    const waiting = this.waitingFor;
    if (waiting && state?.id === waiting.operationId) {
      if (state.status === 'merged') {
        this.wait(undefined);
        if (!restoring) this.sync(waiting.options);
        return;
      }
      if (state.status === 'cancelled') {
        this.wait(undefined);
        if (!this.active)
          this.set({
            error: 'cancelled',
            abandoned: state.remote ? 'combine' : 'official',
            ...this.kept(),
          });
        return;
      }
    } else if (waiting && state && state.id !== waiting.operationId) {
      // Replaced by a newer operation: there is nothing of the old one to continue.
      this.wait(undefined);
    }
    // While Sync runs it publishes its own steps.
    if (this.active) return;
    const line = syncWaiting(state);
    if (line) {
      if (!sameWaiting(this.current.waiting, line)) this.set({ waiting: line, ...this.kept() });
    } else if (this.current.waiting) {
      this.set(this.kept());
    }
  }

  private set(next: CindyMakeSyncState): void {
    this.current = next;
    this.deps.publish(next);
  }

  private kept(): Pick<CindyMakeSyncState, 'done'> {
    return this.done ? { done: this.done } : {};
  }

  private persist(): void {
    try {
      this.deps.save({
        ...(this.waitingFor ? { waiting: this.waitingFor.operationId } : {}),
        ...(this.done ? { done: this.done } : {}),
      });
    } catch {
      // The in-memory state still continues Sync in this session.
    }
  }

  private wait(waiting: PersonalSync['waitingFor']): void {
    this.waitingFor = waiting;
    this.persist();
  }

  /** Sync continues once this operation is adopted, whoever started it. */
  private adopt(operationId: string): void {
    if (this.waitingFor?.operationId !== operationId)
      this.wait({ operationId, options: this.waitingFor?.options });
  }

  private step(step: CindyMakeSyncStep): void {
    if (this.current.running && this.current.step === step) return;
    this.set({ running: true, step, ...this.kept() });
  }

  /** The operation needs its task or the user: remember it and stop until it is adopted. */
  private waits(
    result: CindyMakeMergeState | undefined,
    options: CindyMakeTaskOptions | undefined,
  ): boolean {
    const line = syncWaiting(result);
    if (!line) return false;
    this.wait({ operationId: result!.id, options });
    this.set({ waiting: line, ...this.kept() });
    return true;
  }

  private adopted(result: CindyMakeMergeState | undefined): void {
    if (result?.status === 'merged') return;
    if (result?.status === 'cancelled') throw syncError('cancelled');
    throw Object.assign(new Error(result?.error ?? 'failed'), { code: result?.error });
  }

  private async run(options?: CindyMakeTaskOptions, keep?: 'github' | 'local'): Promise<void> {
    let release: (() => void) | undefined;
    try {
      release = this.deps.reserve();
      // 1. An earlier operation (this session or before a restart) is finished first.
      const retained = this.deps.operation();
      if (retained?.feature && retained.hasWorkspace && retained.status !== 'merged')
        throw syncError('featurePending');
      if (syncWaiting(retained)?.reason === 'otherAccount') {
        this.set({ waiting: syncWaiting(retained)!, ...this.kept() });
        return;
      }
      if ((retained?.hasWorkspace || retained?.cancellationRequested) && retained.status !== 'merged') {
        this.step('resuming');
        if (this.waits(await this.deps.resume(options), options)) return;
      }
      this.step(this.deps.remote() ? 'github' : 'official');
      if (!(await this.deps.base())) throw syncError('source');
      if (keep) {
        const remote = this.deps.remote();
        if (!remote) throw syncError('source');
        await remote.keep(keep);
      }

      let done: Omit<CindyMakeSyncDone, 'at'> = {};
      let sharing: CindyMakeSyncError | undefined;
      // Another computer may upload while this one combines: take that in once more.
      for (let round = 0; round < 2; round += 1) {
        const outcome = await this.round(options);
        if (outcome === 'waiting') return;
        ({ done, sharing } = outcome);
        if (sharing !== 'changed') break;
      }
      this.done = { at: this.deps.now(), ...done };
      this.persist();
      this.set(sharing ? { error: sharing, done: this.done } : { done: this.done });
    } catch (error) {
      const code = classify(error);
      this.deps.log?.warn('cindy-make sync stopped', { code });
      this.set({ error: code, ...this.kept() });
    } finally {
      release?.();
    }
  }

  /** Take in GitHub's changes, move to the official version and upload once. */
  private async round(
    options: CindyMakeTaskOptions | undefined,
  ): Promise<'waiting' | { done: Omit<CindyMakeSyncDone, 'at'>; sharing?: CindyMakeSyncError }> {
    // 2. Changes saved by other computers. Safe cases are taken over by the binding;
    //    overlapping ones are combined in the shared lifecycle. A GitHub problem never
    //    stops the official update on this computer; it is reported at the end.
    const remote = this.deps.remote();
    let sharing: CindyMakeSyncError | undefined;
    let buildFirst = false;
    let tips: { commit: string; base: string } | undefined;
    if (remote) {
      this.step('github');
      try {
        const shared = await remote.sync();
        if (shared === 'diverged') sharing = 'diverged';
        // The source was busy or dirty: nothing was taken in or uploaded this time.
        else if (shared === 'pending') sharing = 'busy';
        else if (shared === 'buildFirst') buildFirst = true;
        else if (shared === 'needsMerge') tips = (await remote.tips()) ?? undefined;
      } catch (error) {
        sharing = classify(error);
      }
      if (tips) {
        this.step('combine');
        const result = await this.deps.combine(tips, options);
        if (this.waits(result, options)) return 'waiting';
        this.adopted(result);
      }
    }

    // 3. The official version, never moving backwards.
    this.step('official');
    const target = await this.deps.target();
    let base = await this.deps.base();
    if (!base) throw syncError('source');
    let generateFirst = false;
    if (base !== target.commit && !(await this.deps.isAncestor(target.commit, base))) {
      if (await this.deps.unbuilt()) generateFirst = true;
      else {
        const result = await this.deps.update(target, options);
        if (this.waits(result, options)) return 'waiting';
        this.adopted(result);
        base = target.commit;
      }
    }

    // 4. Share the result.
    let uploadAfterBuild = false;
    if (remote && !sharing && !buildFirst) {
      this.step('upload');
      try {
        const shared = await remote.sync();
        if (shared === 'diverged') sharing = 'diverged';
        else if (shared === 'pending') sharing = 'busy';
        // Not generated yet: it is uploaded automatically after the next generation.
        else if (shared === 'pendingBuild') uploadAfterBuild = true;
        else if (shared === 'buildFirst') buildFirst = true;
        // Another computer uploaded meanwhile.
        else if (shared === 'needsMerge' || shared === 'remoteAhead') sharing = 'changed';
      } catch (error) {
        sharing = classify(error);
      }
    }
    return {
      done: {
        // On a newer official version than the target (another computer's): no version name;
        // still on an older one because changes wait to be generated: named by Settings.
        ...(base === target.commit ? { ref: target.ref } : generateFirst ? {} : { ahead: true }),
        ...(target.held ? { held: target.held.ref } : {}),
        ...(uploadAfterBuild ? { uploadAfterBuild: true } : {}),
        ...(buildFirst ? { buildFirst: true } : {}),
        ...(generateFirst ? { generateFirst: target.ref } : {}),
      },
      ...(sharing ? { sharing } : {}),
    };
  }
}
