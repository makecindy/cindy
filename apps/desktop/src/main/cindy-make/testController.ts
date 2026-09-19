import { randomUUID } from 'node:crypto';
import type {
  CindyMakeCompletionMeta,
  CindyMakeTestAction,
  CindyMakeTestStep,
  CindyMakePersonalBuildState,
} from '../../shared/cindyMakeSession.js';
import { parseCindyMakeBuildError } from '../../shared/cindyMakeSession.js';
import type { PersonalArtifact } from './personalBuild.js';
import { makeTestError, type MakeTestProcess, type MakeTestWorkspace } from './testRunner.js';

export interface MakeTestContext extends MakeTestWorkspace {
  title?: string;
  sessionId: string;
  completionId: string;
  meta: CindyMakeCompletionMeta;
  isCurrent(): boolean;
}

export interface MakeTestControllerDeps {
  load(sessionId: string, completionId: string): Promise<MakeTestContext>;
  save(
    context: MakeTestContext,
    patch: Partial<CindyMakeCompletionMeta>,
  ): Promise<CindyMakeCompletionMeta>;
  launch(
    context: MakeTestContext,
    signal: AbortSignal,
    publish: (step: CindyMakeTestStep) => void,
  ): Promise<MakeTestProcess>;
  withUse(context: MakeTestContext, run: () => Promise<void>): Promise<void>;
  build?(
    context: MakeTestContext,
    signal: AbortSignal,
    publish: (state: CindyMakePersonalBuildState) => Promise<void>,
  ): Promise<PersonalArtifact>;
  openBuild?(context: MakeTestContext): Promise<void>;
  /** Publish the same build receipt to Settings and the completion card. */
  onBuildState?(context: MakeTestContext, state: CindyMakePersonalBuildState): void;
  claimBuild?(): () => void;
  now?: () => number;
}

interface TestJob {
  kind: 'test' | 'build';
  context: MakeTestContext;
  controller: AbortController;
  process?: MakeTestProcess;
  testReady?: boolean;
  accepted: Promise<CindyMakeCompletionMeta>;
  finished: Promise<void>;
  buildId?: string;
  startedAt?: number;
  cancelled?: boolean;
  persistence: Promise<unknown>;
  releaseBuild?: () => void;
}

/** Owns test launches independently of any renderer, and never replays a launch after restart. */
export function createMakeTestController(deps: MakeTestControllerDeps) {
  const jobs = new Map<string, TestJob>();
  const stop = (job: TestJob) => {
    job.controller.abort();
    job.process?.stop();
  };
  const saveBuild = (job: TestJob, state: CindyMakePersonalBuildState) => {
    const pending = job.persistence.then(async () => {
      if (!job.context.isCurrent()) throw makeTestError('unavailable');
      if (state.stopping && ['ready', 'failed'].includes(job.context.meta.personal?.status ?? ''))
        return;
      if (job.cancelled && !state.stopping && !['ready', 'failed'].includes(state.status)) return;
      const next = { ...state, buildId: job.buildId, startedAt: job.startedAt };
      job.context.meta = await deps.save(job.context, { lastAction: 'build', personal: next });
      deps.onBuildState?.(job.context, next);
    });
    job.persistence = pending.catch(() => {});
    return pending;
  };
  const execute = async (job: TestJob) => {
    const { context, controller } = job;
    let acceptingProgress = true;
    const check = () => {
      controller.signal.throwIfAborted();
      if (!context.isCurrent()) throw makeTestError('unavailable');
    };
    const ownerWatch = setInterval(() => {
      if (!context.isCurrent()) stop(job);
    }, 1000);
    ownerWatch.unref?.();
    try {
      await deps.withUse(context, async () => {
        check();
        if (job.kind === 'build') {
          if (!deps.build) throw makeTestError('unavailable');
          const artifact = await deps.build(context, controller.signal, async (state) => {
            check();
            await saveBuild(job, state);
          });
          // The builder returns only after publishing the verified artifact. Preserve that
          // receipt even if Continue Editing arrived during its final publication.
          if (!context.isCurrent()) throw makeTestError('unavailable');
          await saveBuild(job, {
            status: 'ready',
            ...artifact,
            generatedAt: (deps.now ?? Date.now)(),
          });
          return;
        }
        job.process = await deps.launch(context, controller.signal, (step) => {
          if (!acceptingProgress || controller.signal.aborted || !context.isCurrent()) return;
          // Serialize step writes with the terminal receipt so late progress cannot revive startup.
          job.persistence = job.persistence
            .then(async () => {
              check();
              if (context.meta.test?.step === step) return;
              context.meta = await deps.save(context, { test: { status: 'starting', step } });
            })
            .catch(() => stop(job));
        });
        try {
          await job.process.ready;
          acceptingProgress = false;
          await job.persistence;
          check();
          context.meta = await deps.save(context, { test: { status: 'ready' } });
          job.testReady = true;
          await job.process.closed;
          if (context.isCurrent())
            context.meta = await deps.save(context, { test: { status: 'stopped' } });
        } finally {
          job.process.stop();
          await job.process.closed;
        }
      });
    } catch (error) {
      acceptingProgress = false;
      await job.persistence;
      job.process?.stop();
      if (context.isCurrent()) {
        const code = (error as { code?: unknown })?.code;
        if (job.kind === 'build') {
          const failure =
            code === 'cleanupFailed'
              ? 'cleanupFailed'
              : controller.signal.aborted
                ? job.cancelled
                  ? 'cancelled'
                  : 'interrupted'
                : parseCindyMakeBuildError(code);
          await saveBuild(job, { status: 'failed', error: failure }).catch(() => {});
          return;
        }
        const errorCode =
          code === 'unavailable' ||
          code === 'changed' ||
          code === 'environment' ||
          code === 'timeout'
            ? code
            : 'launchFailed';
        await deps
          .save(context, {
            test: controller.signal.aborted
              ? { status: 'stopped' }
              : { status: 'failed', step: context.meta.test?.step, error: errorCode },
          })
          .catch(() => {});
      }
    } finally {
      clearInterval(ownerWatch);
      if (jobs.get(context.sessionId) === job) jobs.delete(context.sessionId);
      job.releaseBuild?.();
    }
  };
  return {
    hasActiveJobs: () => jobs.size > 0,
    isUsingSession: (sessionId: string) => jobs.has(sessionId),
    activeBuild: () => {
      const job = [...jobs.values()].find(
        (entry) => entry.kind === 'build' && entry.context.isCurrent(),
      );
      return job?.context.meta.personal;
    },
    async cancelBuild(buildId: string): Promise<void> {
      const job = [...jobs.values()].find((entry) => entry.buildId === buildId);
      if (!job || !job.context.isCurrent() || job.cancelled) return;
      await job.accepted;
      const state = job.context.meta.personal;
      if (!job.context.isCurrent() || !state || ['ready', 'failed'].includes(state.status)) return;
      job.cancelled = true;
      // Keep the lease until execute settles cleanup, and publish Stop before aborting.
      try {
        await saveBuild(job, { ...state, stopping: true });
      } finally {
        stop(job);
      }
    },
    isBuilding: (sessionId: string) => jobs.get(sessionId)?.kind === 'build',
    async stopTestForBuild(sessionId: string): Promise<void> {
      const job = jobs.get(sessionId);
      if (!job || job.kind !== 'test') return;
      if (!job.context.isCurrent()) throw makeTestError('unavailable');
      stop(job);
      await job.accepted.catch(() => {});
      await job.finished;
    },
    isUsingWorkspace(workingDir: string): boolean {
      return [...jobs.values()].some((job) => job.context.workingDir === workingDir);
    },
    stopAll(): void {
      for (const job of jobs.values()) stop(job);
    },
    async act(
      sessionId: string,
      completionId: string,
      action: CindyMakeTestAction,
    ): Promise<CindyMakeCompletionMeta> {
      let context = await deps.load(sessionId, completionId);
      if (!context.isCurrent()) throw makeTestError('unavailable');
      let previous = jobs.get(sessionId);
      const matching =
        previous?.context.completionId === completionId && previous.context.isCurrent();
      if (action === 'continue') {
        if (previous?.kind === 'test' && previous.context.isCurrent() && !previous.testReady)
          throw makeTestError('unavailable');
        if (previous && previous.context.isCurrent()) {
          stop(previous);
          if (previous.kind === 'test') await previous.finished;
        }
        return deps.save(context, { continuedAt: (deps.now ?? Date.now)() });
      }
      if (action === 'status') {
        if (matching) return previous!.accepted.then(() => previous!.context.meta);
        const patch: Partial<CindyMakeCompletionMeta> = {};
        if (['starting', 'ready'].includes(context.meta.test?.status ?? ''))
          patch.test = { ...context.meta.test, status: 'stopped', error: 'interrupted' };
        if (
          ['waiting', 'checking', 'merging', 'packaging', 'publishing'].includes(
            context.meta.personal?.status ?? '',
          )
        )
          patch.personal = {
            ...context.meta.personal,
            status: 'failed',
            stopping: undefined,
            error: 'interrupted',
          };
        if (Object.keys(patch).length) return deps.save(context, patch);
        return context.meta;
      }
      if (action === 'open-build') {
        if (!deps.openBuild || context.meta.personal?.status !== 'ready')
          throw makeTestError('unavailable');
        await deps.openBuild(context);
        return context.meta;
      }
      if (context.meta.continuedAt || !/^[0-9a-f]{7,64}$/i.test(context.commit))
        throw makeTestError('unavailable');
      const kind = action === 'build' ? 'build' : 'test';
      if (kind === 'build' && !deps.build) throw makeTestError('unavailable');
      if (
        kind === 'build' &&
        [...jobs.values()].some(
          (job) => job.kind === 'build' && job.context.sessionId !== sessionId,
        )
      )
        throw makeTestError('unavailable');
      while (previous) {
        if (
          previous.context.completionId === completionId &&
          previous.context.isCurrent() &&
          previous.kind === kind &&
          !previous.controller.signal.aborted
        )
          return previous.accepted.then(() => previous!.context.meta);
        stop(previous);
        await previous.accepted.catch(() => {});
        await previous.finished;
        context = await deps.load(sessionId, completionId);
        if (!context.isCurrent() || context.meta.continuedAt) throw makeTestError('unavailable');
        previous = jobs.get(sessionId);
      }
      const job: TestJob = {
        kind,
        context,
        controller: new AbortController(),
        accepted: Promise.resolve(context.meta),
        finished: Promise.resolve(),
        persistence: Promise.resolve(),
        releaseBuild: kind === 'build' ? deps.claimBuild?.() : undefined,
        ...(kind === 'build' ? { buildId: randomUUID(), startedAt: (deps.now ?? Date.now)() } : {}),
      };
      jobs.set(sessionId, job);
      job.accepted = deps
        .save(
          context,
          kind === 'test'
            ? { lastAction: 'test', test: { status: 'starting', step: 'waiting' } }
            : {
                lastAction: 'build',
                personal: { status: 'waiting', buildId: job.buildId, startedAt: job.startedAt },
              },
        )
        .then((meta) => {
          context.meta = meta;
          if (kind === 'build') deps.onBuildState?.(context, meta.personal!);
          job.finished = execute(job);
          return meta;
        })
        .catch((error) => {
          if (jobs.get(sessionId) === job) jobs.delete(sessionId);
          job.releaseBuild?.();
          throw error;
        });
      return job.accepted;
    },
  };
}
