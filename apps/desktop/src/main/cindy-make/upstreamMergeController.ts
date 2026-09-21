import { randomUUID } from 'node:crypto';
import type { CindyMakeTaskOptions } from '../../shared/cindyMakeDoctor.js';
import type { CindyMakeMergeState, MakeFeatureMergePlan } from '../../shared/cindyMakeMerge.js';
import { mergeError, mergeWorktree } from './upstreamMerge.js';

export interface SavedUpstreamMerge {
  state: CindyMakeMergeState;
  sessionOwner?: string;
}
export function parseSavedUpstreamMerge(raw: string, userData: string): SavedUpstreamMerge {
  const saved = JSON.parse(raw) as SavedUpstreamMerge;
  const state = saved?.state;
  if (
    !state ||
    typeof state.id !== 'string' ||
    ![
      'fetching',
      'merging',
      'conflict',
      'resolving',
      'checking',
      'merged',
      'failed',
      'cancelled',
    ].includes(state.status) ||
    typeof state.ref !== 'string' ||
    typeof state.upstreamCommit !== 'string' ||
    (state.upstreamCommit !== '' && !/^[0-9a-f]{40}$/i.test(state.upstreamCommit)) ||
    (state.baselineTree !== undefined && !/^[0-9a-f]{40,64}$/i.test(state.baselineTree)) ||
    (state.strategy !== undefined && state.strategy !== 'rebase') ||
    (state.rebaseBase !== undefined && !/^[0-9a-f]{40}$/i.test(state.rebaseBase)) ||
    (state.rebaseReview !== undefined && typeof state.rebaseReview !== 'boolean') ||
    (state.cancellationRequested !== undefined &&
      typeof state.cancellationRequested !== 'boolean') ||
    (state.cleanupPending !== undefined && typeof state.cleanupPending !== 'boolean') ||
    (state.feature !== undefined && (!validFeaturePlan(state.feature) || !saved.sessionOwner)) ||
    (state.tree !== undefined && !/^[0-9a-f]{40,64}$/i.test(state.tree)) ||
    (state.baselineCommit !== undefined && !/^[0-9a-f]{40}$/i.test(state.baselineCommit)) ||
    (state.sessionId !== undefined &&
      (typeof state.sessionId !== 'string' ||
        !/^[a-zA-Z0-9-]{1,128}$/.test(state.sessionId) ||
        !saved.sessionOwner)) ||
    (saved.sessionOwner !== undefined && typeof saved.sessionOwner !== 'string')
  )
    throw mergeError('unavailable');
  mergeWorktree(userData, state.id);
  return saved;
}
function validFeaturePlan(feature: MakeFeatureMergePlan): boolean {
  const id = /^[a-zA-Z0-9-]{1,128}$/;
  const hash = /^[a-f0-9]{40,64}$/i;
  return (
    !!feature &&
    id.test(feature.runId) &&
    id.test(feature.taskSessionId) &&
    ['integrate', 'revert', 'reapply'].includes(feature.action) &&
    hash.test(feature.taskTree) &&
    (feature.mergeCommit === undefined || hash.test(feature.mergeCommit)) &&
    (feature.awaitingResolution === undefined || typeof feature.awaitingResolution === 'boolean') &&
    Array.isArray(feature.steps) &&
    feature.steps.length <= 10000 &&
    (feature.mergeCommit === undefined || feature.steps.length === 0) &&
    feature.steps.every((step) => !!step && hash.test(step.before) && hash.test(step.after)) &&
    Number.isInteger(feature.nextStep) &&
    feature.nextStep >= 0 &&
    feature.nextStep <= (feature.mergeCommit ? 1 : feature.steps.length)
  );
}
export interface UpstreamMergeDependencies {
  read: () => SavedUpstreamMerge | undefined;
  write: (saved: SavedUpstreamMerge) => void;
  publish: (state: CindyMakeMergeState | undefined) => void;
  owner: () => string;
  hasWorkspace: (state: CindyMakeMergeState) => boolean;
  exclusive: <T>(run: () => Promise<T>) => Promise<T>;
  latest: () => Promise<{ ref: string; commit: string }>;
  prepare: (
    state: CindyMakeMergeState,
    publish: (state: CindyMakeMergeState) => Promise<void>,
  ) => Promise<CindyMakeMergeState>;
  apply: (
    state: CindyMakeMergeState,
    isCurrent: () => boolean,
    publish?: (state: CindyMakeMergeState) => Promise<void>,
  ) => Promise<CindyMakeMergeState>;
  prepareFeature?: (
    state: CindyMakeMergeState,
    plan: MakeFeatureMergePlan,
    publish: (state: CindyMakeMergeState) => Promise<void>,
    isCurrent: () => boolean,
  ) => Promise<CindyMakeMergeState>;
  applied?: (state: CindyMakeMergeState, isCurrent: () => boolean) => Promise<void>;
  session: (
    state: CindyMakeMergeState,
    options: CindyMakeTaskOptions | undefined,
    bind: (id: string) => void,
    isCurrent: () => boolean,
  ) => Promise<string>;
  running: (sessionId: string) => boolean;
  /** Wait between terminal observation and the provider's idle state. */
  sleep?: (milliseconds: number) => Promise<void>;
  refresh: () => Promise<void>;
  cleanup: (state: CindyMakeMergeState, isCurrent: () => boolean) => Promise<boolean>;
  cancel: (state: CindyMakeMergeState, isCurrent: () => boolean) => Promise<void>;
  /** Explicit build cancellation: stop its resolver before discarding the candidate. No Git lock held. */
  discard?: (state: CindyMakeMergeState, isCurrent: () => boolean) => Promise<boolean>;
}
const FINISH_IDLE_RETRY_DELAY_MS = 50;
const FINISH_IDLE_RETRY_COUNT = 20;
const errors = new Set([
  'busy',
  'dirty',
  'localMain',
  'unavailable',
  'gitFailed',
  'baselineChanged',
  'checksFailed',
  'interrupted',
  'startFailed',
  'cancelFailed',
]);

/** Device-local Git operation, with an account-bound resolution task. Never resumes writes on boot. */
export class UpstreamMergeController {
  private saved?: SavedUpstreamMerge;
  private active?: Promise<unknown>;
  private cancelling?: Promise<CindyMakeMergeState | undefined>;
  private interruption?: { operationId: string };
  private stopGeneration = 0;
  private acceptedTurn = 0;
  private readonly waiters = new Set<() => void>();
  constructor(private readonly deps: UpstreamMergeDependencies) {
    this.saved = deps.read();
    if (this.saved) {
      const state = this.saved.state;
      const recovered = {
        ...state,
        hasWorkspace: deps.hasWorkspace(state),
        ...(state.cancellationRequested
          ? { status: 'failed' as const, error: 'cancelFailed' as const }
          : ['fetching', 'merging', 'checking', 'resolving'].includes(state.status)
            ? { status: 'failed' as const, error: 'interrupted' as const }
            : {}),
      };
      if (recovered.status === 'failed' && recovered.error === 'interrupted')
        this.interruption = { operationId: state.id };
      // A completed merge removes its candidate worktree. Recompute this bit on
      // every restore so an older state file cannot keep the UI looking busy.
      if (
        recovered.status !== state.status ||
        recovered.error !== state.error ||
        recovered.hasWorkspace !== state.hasWorkspace
      )
        this.save(recovered);
    }
    this.status();
  }
  status(): CindyMakeMergeState | undefined {
    const state = this.saved?.state;
    const other = !!this.saved?.sessionOwner && this.saved.sessionOwner !== this.deps.owner();
    const projected = state
      ? { ...state, ...(other ? { sessionId: undefined, ownedByAnotherAccount: true } : {}) }
      : undefined;
    this.deps.publish(projected);
    for (const notify of this.waiters) notify();
    return projected;
  }
  /** A build stays alive across the dedicated task, but never across cancellation or restart. */
  waitForCompletion(
    operationId: string,
    signal: AbortSignal,
    observe: (state: CindyMakeMergeState) => void = () => {},
  ): Promise<CindyMakeMergeState> {
    const owner = this.deps.owner();
    const stopGeneration = this.stopGeneration;
    let interrupted = this.interruption?.operationId === operationId;
    return new Promise<CindyMakeMergeState>((resolve, reject) => {
      const finish = (state?: CindyMakeMergeState, error?: unknown) => {
        this.waiters.delete(check);
        signal.removeEventListener('abort', check);
        if (error) reject(error);
        else resolve(state!);
      };
      const check = () => {
        if (signal.aborted) return finish(undefined, signal.reason);
        const state = this.saved?.state;
        if (
          !state ||
          state.id !== operationId ||
          this.deps.owner() !== owner ||
          (this.saved?.sessionOwner && this.saved.sessionOwner !== owner)
        )
          return finish(undefined, mergeError('unavailable'));
        try {
          observe(state);
        } catch (error) {
          return finish(undefined, error);
        }
        // A deliberate later message may resume the task, never the stopped build.
        interrupted ||=
          this.stopGeneration !== stopGeneration || this.interruption?.operationId === operationId;
        // Adoption and cleanup share the active operation. Do not resume a build between them.
        if (this.active) return;
        if (interrupted) finish(undefined, mergeError('interrupted'));
        else if (state.status === 'merged') finish(state);
        else if (state.status === 'failed' || state.status === 'cancelled')
          finish(undefined, mergeError(state.error ?? 'interrupted'));
      };
      this.waiters.add(check);
      signal.addEventListener('abort', check, { once: true });
      check();
    }).catch(async (error) => {
      // Only Stop Making carries this reason. Shutdown and ordinary task Stop
      // preserve the resolver for a later visit. Keep the build waiting for cleanup.
      if (signal.aborted && (signal.reason as { code?: string })?.code === 'cancelled')
        await this.cancelBuild(operationId);
      throw error;
    });
  }
  isApplying(sessionId: string): boolean {
    return (
      this.saved?.state.sessionId === sessionId &&
      (this.saved.state.cancellationRequested ||
        this.saved.state.status === 'cancelled' ||
        this.saved.state.status === 'checking' ||
        (!!this.active &&
          (this.saved.state.status === 'merged' ||
            this.interruption?.operationId === this.saved.state.id)))
    );
  }
  private save(state: CindyMakeMergeState): void {
    // In-flight Git/session callbacks cannot erase a persisted Stop decision.
    if (
      this.saved?.state.id === state.id &&
      this.saved.state.cancellationRequested &&
      state.status !== 'cancelled'
    )
      state = { ...state, cancellationRequested: true };
    if (
      this.interruption?.operationId === state.id &&
      !state.cancellationRequested &&
      state.status !== 'cancelled'
    )
      state = { ...state, status: 'failed', error: 'interrupted' };
    const saved = { ...this.saved, state };
    // Persist before publishing or performing the next mutation.
    this.deps.write(saved);
    this.saved = saved;
    this.status();
  }
  private fail(error: unknown): void {
    const state = this.saved?.state;
    if (!state) return;
    const code = (error as { code?: string })?.code;
    this.save({
      ...state,
      status: 'failed',
      hasWorkspace: this.deps.hasWorkspace(state),
      error: errors.has(code ?? '') ? (code as CindyMakeMergeState['error']) : 'gitFailed',
    });
  }
  private async acceptResult(result: CindyMakeMergeState, isCurrent: () => boolean): Promise<void> {
    if (result.feature && result.status === 'merged') {
      // A crash after Git adoption must resume receipt persistence, not masquerade as fully complete.
      this.save({ ...result, status: 'checking' });
      if (!isCurrent()) throw mergeError('busy');
      await this.deps.applied?.(result, isCurrent);
    }
    this.save(result);
  }
  private async cleanupCompleted(state: CindyMakeMergeState): Promise<void> {
    const owner = this.deps.owner();
    const isCurrent = () =>
      this.saved?.state.id === state.id &&
      this.deps.owner() === owner &&
      (!this.saved.sessionOwner || this.saved.sessionOwner === owner) &&
      (!state.sessionId || !this.deps.running(state.sessionId));
    if (!isCurrent()) return;
    this.save({ ...state, cleanupPending: true });
    const cleaned = await this.deps.cleanup(state, isCurrent).catch(() => false);
    // Cleanup may be deferred (for example after a crash). Read the actual
    // worktree state before clearing the persisted flag.
    if (!isCurrent() || this.saved?.state.status !== 'merged') return;
    const hasWorkspace = this.deps.hasWorkspace(state);
    this.save({ ...this.saved.state, hasWorkspace, cleanupPending: !cleaned || undefined });
  }
  async finishPreviousCleanup(): Promise<void> {
    const state = this.saved?.state;
    if (state?.feature && state.cancellationRequested) {
      await this.cancelBuild(state.id);
      return;
    }
    if (state?.status !== 'merged' || (!state.hasWorkspace && !state.cleanupPending)) return;
    await this.run(async () => {});
    if (this.saved?.state.cleanupPending || this.saved?.state.hasWorkspace)
      throw mergeError('dirty');
  }
  private async run(work: () => Promise<void>): Promise<CindyMakeMergeState | undefined> {
    if (this.active) {
      await this.active.catch(() => undefined);
      return this.status();
    }
    let started = false;
    const pending = Promise.resolve().then(async () => {
      await this.deps.exclusive(async () => {
        started = true;
        await work();
      });
      // Runtime shutdown uses the shared recycle queue, which may itself need
      // the project lock. Release Git exclusivity before awaiting that queue.
      const state = this.saved?.state;
      if (
        state?.status === 'merged' &&
        !state.cancellationRequested &&
        this.interruption?.operationId !== state.id &&
        (state.hasWorkspace || state.cleanupPending)
      )
        await this.cleanupCompleted(state);
    });
    this.active = pending;
    try {
      await pending;
    } catch (error) {
      if (!started) throw error;
      this.fail(error);
    } finally {
      this.active = undefined;
      for (const notify of this.waiters) notify();
    }
    return this.status();
  }
  async update(_options?: CindyMakeTaskOptions): Promise<CindyMakeMergeState | undefined> {
    await this.finishPreviousCleanup();
    const owner = this.deps.owner();
    return this.run(async () => {
      if (
        this.saved?.state.cancellationRequested ||
        (this.saved?.state.hasWorkspace && this.saved.state.status !== 'merged')
      )
        return;
      this.saved = {
        sessionOwner: owner || undefined,
        state: { id: randomUUID(), status: 'fetching', ref: '', upstreamCommit: '' },
      };
      this.save(this.saved.state);
      const latest = await this.deps.latest();
      this.save({ ...this.saved!.state, ref: latest.ref, upstreamCommit: latest.commit });
      const result = await this.deps.prepare(this.saved!.state, async (next) => this.save(next));
      this.save(result);
      // Conflicts wait for an explicit resolve/cancel decision before any Agent task exists.
      await this.deps.refresh().catch(() => undefined);
    });
  }
  async resolve(
    options?: CindyMakeTaskOptions,
    operationId?: string,
  ): Promise<CindyMakeMergeState | undefined> {
    const owner = this.deps.owner();
    const stopGeneration = this.stopGeneration;
    if (operationId !== undefined && this.saved?.state.id !== operationId) throw mergeError('busy');
    if (this.saved?.state.status === 'cancelled' || this.saved?.state.cancellationRequested)
      throw mergeError('busy');
    if (this.saved?.sessionOwner && this.saved.sessionOwner !== owner) throw mergeError('busy');
    return this.run(async () => {
      if (this.deps.owner() !== owner) throw mergeError('busy');
      if (this.stopGeneration !== stopGeneration) return;
      if (this.saved?.state.feature && !this.saved.state.feature.awaitingResolution) {
        // Explicit native retry after an interrupted receipt/check. Opening a
        // resolver below still requires a new dispatched message to resume it.
        this.interruption = undefined;
        const isCurrent = () =>
          this.deps.owner() === owner && this.stopGeneration === stopGeneration;
        let result: CindyMakeMergeState;
        if (this.saved.state.error === 'baselineChanged' && this.deps.prepareFeature) {
          // Keep the old candidate and its task for inspection; retry against the changed personal source.
          const plan = { ...this.saved.state.feature, nextStep: 0, awaitingResolution: false };
          this.save({
            id: randomUUID(),
            status: 'merging',
            ref: 'personal',
            upstreamCommit: '',
            feature: plan,
          });
          result = await this.deps.prepareFeature(
            this.saved.state,
            plan,
            async (next) => this.save(next),
            isCurrent,
          );
        } else
          result = await this.deps.apply(this.saved.state, isCurrent, async (next) =>
            this.save(next),
          );
        await this.acceptResult(result, isCurrent);
        if (result.status === 'merged') return;
      }
      await this.createResolutionTask(options, owner);
    });
  }
  async cancel(operationId: string): Promise<CindyMakeMergeState | undefined> {
    const state = this.saved?.state;
    if (state?.id === operationId && state.feature && state.cancellationRequested)
      return this.cancelBuild(operationId);
    const owner = this.deps.owner();
    if (
      this.active ||
      !state ||
      state.id !== operationId ||
      state.feature ||
      state.sessionId ||
      !['conflict', 'failed', 'cancelled'].includes(state.status) ||
      (this.saved?.sessionOwner && this.saved.sessionOwner !== owner)
    )
      throw mergeError('busy');
    return this.run(async () => {
      const isCurrent = () => this.saved?.state.id === operationId && this.deps.owner() === owner;
      if (!isCurrent()) throw mergeError('busy');
      if (state.status === 'cancelled' && !state.hasWorkspace) return;
      this.save({ ...state, cancellationRequested: true });
      try {
        await this.deps.cancel(state, isCurrent);
      } catch {
        // Retain the decision and recovery entry if Git could not reclaim the candidate.
        throw mergeError('cancelFailed');
      }
      this.save({
        ...state,
        status: 'cancelled',
        hasWorkspace: false,
        cancellationRequested: undefined,
        error: undefined,
      });
      await this.deps.refresh().catch(() => undefined);
    });
  }
  /** Bound to a build-owned operation, never used for an ordinary session Stop or app exit. */
  async cancelBuild(operationId: string): Promise<CindyMakeMergeState | undefined> {
    const state = this.saved?.state;
    const owner = this.deps.owner();
    if (
      !state?.feature ||
      state.id !== operationId ||
      this.saved?.sessionOwner !== owner ||
      !this.deps.discard
    )
      throw mergeError('busy');
    if (this.cancelling) return this.cancelling;
    if (state.status === 'cancelled' && !state.hasWorkspace) return this.status();
    this.save({ ...state, cancellationRequested: true });
    this.interruption = { operationId };
    const isCurrent = () =>
      this.saved?.state.id === operationId &&
      this.saved.sessionOwner === owner &&
      this.deps.owner() === owner;
    const pending = (async () => {
      await this.active?.catch(() => undefined);
      if (!isCurrent()) throw mergeError('busy');
      try {
        if (!(await this.deps.discard!(this.saved!.state, isCurrent)) || !isCurrent())
          throw mergeError('cancelFailed');
        this.save({
          ...this.saved!.state,
          status: 'cancelled',
          hasWorkspace: false,
          cleanupPending: undefined,
          cancellationRequested: undefined,
          error: undefined,
        });
        await this.deps.refresh().catch(() => undefined);
        return this.status();
      } catch {
        if (isCurrent()) this.fail(mergeError('cancelFailed'));
        throw mergeError('cancelFailed');
      }
    })();
    this.cancelling = pending;
    try {
      return await pending;
    } finally {
      this.cancelling = undefined;
    }
  }
  async feature(
    plan: MakeFeatureMergePlan,
    options?: CindyMakeTaskOptions,
    signal?: AbortSignal,
  ): Promise<CindyMakeMergeState | undefined> {
    signal?.throwIfAborted();
    if (!validFeaturePlan(plan) || !this.deps.prepareFeature) throw mergeError('unavailable');
    await this.finishPreviousCleanup();
    const owner = this.deps.owner();
    if (
      !owner ||
      this.active ||
      this.saved?.state.cancellationRequested ||
      (this.saved?.state.hasWorkspace && this.saved.state.status !== 'merged')
    )
      throw mergeError('busy');
    let operationId: string | undefined;
    const markCancelled = () => {
      if (
        !operationId ||
        this.saved?.state.id !== operationId ||
        this.deps.owner() !== owner ||
        !signal?.aborted ||
        (signal.reason as { code?: string })?.code !== 'cancelled'
      )
        return;
      try {
        this.save({ ...this.saved.state, cancellationRequested: true });
        this.interruption = { operationId };
      } catch {
        // The awaited cancellation path retries persistence before discarding anything.
      }
    };
    try {
      const result = await this.run(async () => {
        // A cancelled request queued behind another Git operation owns no candidate.
        if (signal?.aborted) return;
        // Let an in-flight Git adoption finish recording its receipt so rollback
        // can undo it. Cancellation prevents resolver dispatch after this step.
        const isCurrent = () => owner === this.deps.owner();
        if (!isCurrent()) throw mergeError('busy');
        this.saved = {
          sessionOwner: owner,
          state: {
            id: randomUUID(),
            status: 'merging',
            ref: 'personal',
            upstreamCommit: '',
            feature: plan,
          },
        };
        this.save(this.saved.state);
        operationId = this.saved.state.id;
        signal?.addEventListener('abort', markCancelled, { once: true });
        markCancelled();
        const result = await this.deps.prepareFeature!(
          this.saved.state,
          plan,
          async (next) => this.save(next),
          isCurrent,
        );
        await this.acceptResult(result, isCurrent);
        if (
          result.status === 'conflict' &&
          isCurrent() &&
          !signal?.aborted &&
          !this.saved?.state.cancellationRequested
        )
          await this.createResolutionTask(options, owner, signal);
        await this.deps.refresh().catch(() => undefined);
      });
      if (!operationId) {
        signal?.throwIfAborted();
        throw mergeError('busy');
      }
      return result;
    } finally {
      signal?.removeEventListener('abort', markCancelled);
    }
  }
  private async createResolutionTask(
    options: CindyMakeTaskOptions | undefined,
    owner: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const state = this.saved?.state;
    if (!state?.hasWorkspace || ['merged', 'cancelled'].includes(state.status))
      throw mergeError('unavailable');
    const stopGeneration = this.stopGeneration;
    const isCurrent = () =>
      this.saved?.state.id === state.id &&
      this.deps.owner() === owner &&
      this.stopGeneration === stopGeneration &&
      !signal?.aborted &&
      !this.saved.state.cancellationRequested;
    const bind = (sessionId: string) => {
      if (!isCurrent()) throw mergeError('busy');
      this.saved = { ...this.saved!, sessionOwner: owner };
      this.save({
        ...this.saved.state,
        sessionId,
        // Merely opening a retained task does not accept another turn.
        ...(this.interruption?.operationId === state.id
          ? {}
          : { status: 'resolving' as const, error: undefined }),
      });
    };
    if (!isCurrent()) throw mergeError('busy');
    const id = await this.deps.session(state, options, bind, isCurrent);
    bind(id);
  }
  async finish(sessionId: string): Promise<void> {
    const turn = this.acceptedTurn;
    if (this.active && this.saved?.state.sessionId === sessionId)
      await this.active.catch(() => undefined);
    const state = this.saved?.state;
    if (
      this.active ||
      !state ||
      state.sessionId !== sessionId ||
      state.status === 'merged' ||
      state.status === 'cancelled' ||
      state.cancellationRequested ||
      this.interruption?.operationId === state.id ||
      this.acceptedTurn !== turn ||
      this.saved?.sessionOwner !== this.deps.owner()
    )
      return;
    // Providers may retire their running flag after synchronous done listeners return.
    await Promise.resolve();
    const owner = this.deps.owner();
    const isOwned = () =>
      this.saved?.state.id === state.id &&
      !this.saved.state.cancellationRequested &&
      this.interruption?.operationId !== state.id &&
      this.acceptedTurn === turn &&
      this.saved.sessionOwner === owner &&
      this.deps.owner() === owner;
    const isCurrent = () => isOwned() && !this.deps.running(sessionId);
    const sleep =
      this.deps.sleep ??
      ((milliseconds: number) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, milliseconds);
          (timer as unknown as { unref?: () => void }).unref?.();
        }));
    // A successful terminal event can reach this hook before the provider has
    // retired its running flag. Keep the candidate untouched while waiting for
    // that transition, but bound the wait so a genuinely stuck session cannot
    // hold the merge operation forever.
    for (let attempt = 0; attempt < FINISH_IDLE_RETRY_COUNT; attempt += 1) {
      if (!isOwned()) return;
      if (!this.deps.running(sessionId)) break;
      await sleep(FINISH_IDLE_RETRY_DELAY_MS);
    }
    if (!isOwned()) return;
    if (!isCurrent()) {
      this.fail(mergeError('busy'));
      return;
    }
    await this.run(async () => {
      if (!isCurrent()) return;
      this.save({ ...state, status: 'checking', error: undefined });
      const canFinishAdoption = () =>
        this.saved?.state.cancellationRequested
          ? this.saved.state.id === state.id &&
            this.saved.sessionOwner === owner &&
            this.deps.owner() === owner &&
            !this.deps.running(sessionId)
          : isCurrent();
      const result = await this.deps.apply(state, canFinishAdoption, async (next) =>
        this.save(next),
      );
      await this.acceptResult(result, canFinishAdoption);
      if (result.feature && result.status === 'conflict' && isCurrent()) {
        // Unresolved files from this turn are not a new conflict. Stop waiting
        // and retain the task instead of repeatedly spawning another resolver.
        if (!state.feature || result.feature.nextStep <= state.feature.nextStep)
          throw mergeError('checksFailed');
        // Only a later delta continues automatically, in the same task/worktree.
        await this.createResolutionTask(undefined, owner);
      }
      await this.deps.refresh().catch(() => undefined);
    });
  }
  async interrupt(sessionId: string): Promise<void> {
    const state = this.saved?.state;
    if (
      !state ||
      state.sessionId !== sessionId ||
      this.saved?.sessionOwner !== this.deps.owner() ||
      state.cancellationRequested ||
      state.status === 'cancelled' ||
      state.status === 'merged'
    )
      return;
    const interruption = { operationId: state.id };
    this.interruption = interruption;
    this.stopGeneration += 1;
    this.fail(mergeError('interrupted'));
    await this.active?.catch(() => undefined);
    if (
      this.interruption !== interruption ||
      this.saved?.state.sessionId !== sessionId ||
      this.saved.sessionOwner !== this.deps.owner() ||
      this.saved.state.cancellationRequested ||
      this.saved.state.status === 'cancelled' ||
      this.saved.state.status === 'merged'
    )
      return;
    this.fail(mergeError('interrupted'));
  }
  /** Capture before async dispatch; a pre-Stop acceptance cannot resume the task. */
  prepareTurn(sessionId: string): () => void {
    const operationId = this.saved?.state.id;
    const owner = this.deps.owner();
    const stopGeneration = this.stopGeneration;
    let accepted = false;
    return () => {
      const state = this.saved?.state;
      if (
        accepted ||
        !state ||
        state.id !== operationId ||
        this.stopGeneration !== stopGeneration ||
        !state.hasWorkspace ||
        state.status === 'merged' ||
        state.status === 'cancelled' ||
        state.cancellationRequested ||
        state.sessionId !== sessionId ||
        this.saved?.sessionOwner !== owner ||
        this.deps.owner() !== owner
      )
        return;
      accepted = true;
      this.acceptedTurn += 1;
      this.interruption = undefined;
      if (state.status === 'failed' && state.error === 'interrupted')
        this.save({ ...state, status: 'resolving', error: undefined });
    };
  }
}
