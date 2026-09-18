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
    !['fetching', 'merging', 'conflict', 'resolving', 'checking', 'merged', 'failed'].includes(
      state.status,
    ) ||
    typeof state.ref !== 'string' ||
    typeof state.upstreamCommit !== 'string' ||
    (state.upstreamCommit !== '' && !/^[0-9a-f]{40}$/i.test(state.upstreamCommit)) ||
    (state.baselineTree !== undefined && !/^[0-9a-f]{40,64}$/i.test(state.baselineTree)) ||
    (state.strategy !== undefined && state.strategy !== 'rebase') ||
    (state.rebaseBase !== undefined && !/^[0-9a-f]{40}$/i.test(state.rebaseBase)) ||
    (state.rebaseReview !== undefined && typeof state.rebaseReview !== 'boolean') ||
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
  refresh: () => Promise<void>;
  cleanup: (state: CindyMakeMergeState) => Promise<void>;
}
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
]);

/** Device-local Git operation, with an account-bound resolution task. Never resumes writes on boot. */
export class UpstreamMergeController {
  private saved?: SavedUpstreamMerge;
  private active?: Promise<unknown>;
  constructor(private readonly deps: UpstreamMergeDependencies) {
    this.saved = deps.read();
    if (this.saved && this.saved.state.status !== 'merged') {
      const state = this.saved.state;
      this.save({
        ...state,
        hasWorkspace: deps.hasWorkspace(state),
        ...(['fetching', 'merging', 'checking'].includes(state.status)
          ? { status: 'failed' as const, error: 'interrupted' as const }
          : {}),
      });
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
    return projected;
  }
  isApplying(sessionId: string): boolean {
    return this.saved?.state.sessionId === sessionId && this.saved?.state.status === 'checking';
  }
  private save(state: CindyMakeMergeState): void {
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
  private async run(work: () => Promise<void>): Promise<CindyMakeMergeState | undefined> {
    if (this.active) {
      await this.active.catch(() => undefined);
      return this.status();
    }
    let started = false;
    const pending = Promise.resolve().then(() =>
      this.deps.exclusive(async () => {
        started = true;
        await work();
      }),
    );
    this.active = pending;
    try {
      await pending;
    } catch (error) {
      if (!started) throw error;
      this.fail(error);
    } finally {
      this.active = undefined;
    }
    return this.status();
  }
  async update(options?: CindyMakeTaskOptions): Promise<CindyMakeMergeState | undefined> {
    const owner = this.deps.owner();
    return this.run(async () => {
      if (this.saved?.state.hasWorkspace && this.saved.state.status !== 'merged') return;
      this.saved = undefined;
      this.save({ id: randomUUID(), status: 'fetching', ref: '', upstreamCommit: '' });
      const latest = await this.deps.latest();
      this.save({ ...this.saved!.state, ref: latest.ref, upstreamCommit: latest.commit });
      const result = await this.deps.prepare(this.saved!.state, async (next) => this.save(next));
      this.save(result);
      if (result.status === 'conflict' && owner && this.deps.owner() === owner) {
        await this.createResolutionTask(options, owner);
      }
      if (result.status === 'merged') await this.deps.cleanup(result);
      await this.deps.refresh().catch(() => undefined);
    });
  }
  async resolve(options?: CindyMakeTaskOptions): Promise<CindyMakeMergeState | undefined> {
    const owner = this.deps.owner();
    if (this.saved?.sessionOwner && this.saved.sessionOwner !== owner) throw mergeError('busy');
    return this.run(async () => {
      if (this.saved?.state.feature && !this.saved.state.feature.awaitingResolution) {
        const isCurrent = () => this.deps.owner() === owner;
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
        if (result.status === 'merged') {
          await this.deps.cleanup(result);
          return;
        }
      }
      await this.createResolutionTask(options, owner);
    });
  }
  async feature(
    plan: MakeFeatureMergePlan,
    options?: CindyMakeTaskOptions,
  ): Promise<CindyMakeMergeState | undefined> {
    if (!validFeaturePlan(plan) || !this.deps.prepareFeature) throw mergeError('unavailable');
    const owner = this.deps.owner();
    if (
      !owner ||
      this.active ||
      (this.saved?.state.hasWorkspace && this.saved.state.status !== 'merged')
    )
      throw mergeError('busy');
    return this.run(async () => {
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
      const result = await this.deps.prepareFeature!(
        this.saved.state,
        plan,
        async (next) => this.save(next),
        isCurrent,
      );
      await this.acceptResult(result, isCurrent);
      if (result.status === 'merged') {
        await this.deps.cleanup(result);
      } else if (result.status === 'conflict' && isCurrent())
        await this.createResolutionTask(options, owner);
      await this.deps.refresh().catch(() => undefined);
    });
  }
  private async createResolutionTask(
    options: CindyMakeTaskOptions | undefined,
    owner: string,
  ): Promise<void> {
    const state = this.saved?.state;
    if (!state?.hasWorkspace || state.status === 'merged') throw mergeError('unavailable');
    const isCurrent = () => this.deps.owner() === owner;
    if (!isCurrent()) throw mergeError('busy');
    const id = await this.deps.session(
      state,
      options,
      (sessionId) => {
        if (!isCurrent()) throw mergeError('busy');
        this.saved = { ...this.saved!, sessionOwner: owner };
        this.save({ ...this.saved.state, sessionId, status: 'resolving', error: undefined });
      },
      isCurrent,
    );
    this.save({ ...this.saved!.state, sessionId: id, status: 'resolving', error: undefined });
  }
  async finish(sessionId: string): Promise<void> {
    if (this.active && this.saved?.state.sessionId === sessionId)
      await this.active.catch(() => undefined);
    const state = this.saved?.state;
    if (
      this.active ||
      !state ||
      state.sessionId !== sessionId ||
      state.status === 'merged' ||
      this.saved?.sessionOwner !== this.deps.owner()
    )
      return;
    // Providers may retire their running flag after synchronous done listeners return.
    await Promise.resolve();
    const owner = this.deps.owner();
    const isCurrent = () =>
      this.saved?.sessionOwner === owner &&
      this.deps.owner() === owner &&
      !this.deps.running(sessionId);
    if (!isCurrent()) return;
    await this.run(async () => {
      if (!isCurrent()) return;
      this.save({ ...state, status: 'checking', error: undefined });
      const result = await this.deps.apply(state, isCurrent, async (next) => this.save(next));
      await this.acceptResult(result, isCurrent);
      if (result.feature && result.status === 'conflict' && isCurrent()) {
        // Another delta of the same undo conflicted after resolving the preceding one.
        this.save({ ...result, sessionId: undefined });
        await this.createResolutionTask(undefined, owner);
      }
      await this.deps.refresh().catch(() => undefined);
    });
  }
}
