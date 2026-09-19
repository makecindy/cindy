import type {
  CindyMakeCompletionMeta,
  CindyMakeTestAction,
  CindyMakePersonalBuildState,
} from '../../shared/cindyMakeSession.js';
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
  launch(context: MakeTestContext, signal: AbortSignal): Promise<MakeTestProcess>;
  withUse(context: MakeTestContext, run: () => Promise<void>): Promise<void>;
  build?(
    context: MakeTestContext,
    signal: AbortSignal,
    publish: (state: CindyMakePersonalBuildState) => Promise<void>,
  ): Promise<PersonalArtifact>;
  openBuild?(context: MakeTestContext): Promise<void>;
  now?: () => number;
}

interface TestJob {
  kind: 'test' | 'build';
  context: MakeTestContext;
  controller: AbortController;
  process?: MakeTestProcess;
  accepted: Promise<CindyMakeCompletionMeta>;
  finished: Promise<void>;
}

/** Owns test launches independently of any renderer, and never replays a launch after restart. */
export function createMakeTestController(deps: MakeTestControllerDeps) {
  const jobs = new Map<string, TestJob>();
  const stop = (job: TestJob) => {
    job.controller.abort();
    job.process?.stop();
  };
  const execute = async (job: TestJob) => {
    const { context, controller } = job;
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
            context.meta = await deps.save(context, { personal: state });
          });
          // The builder returns only after publishing the verified artifact. Preserve that
          // receipt even if Continue Editing arrived during its final publication.
          if (!context.isCurrent()) throw makeTestError('unavailable');
          context.meta = await deps.save(context, {
            personal: { status: 'ready', ...artifact, generatedAt: (deps.now ?? Date.now)() },
          });
          return;
        }
        job.process = await deps.launch(context, controller.signal);
        try {
          await job.process.ready;
          check();
          context.meta = await deps.save(context, { test: { status: 'ready' } });
          await job.process.closed;
          if (context.isCurrent())
            context.meta = await deps.save(context, { test: { status: 'stopped' } });
        } finally {
          job.process.stop();
          await job.process.closed;
        }
      });
    } catch (error) {
      job.process?.stop();
      if (context.isCurrent()) {
        const code = (error as { code?: unknown })?.code;
        if (job.kind === 'build') {
          const known = [
            'unavailable',
            'changed',
            'environment',
            'missingShell',
            'checksFailed',
            'conflict',
            'baselineChanged',
            'interrupted',
          ];
          const failure = controller.signal.aborted
            ? 'interrupted'
            : typeof code === 'string' && known.includes(code)
              ? (code as CindyMakePersonalBuildState['error'])
              : 'buildFailed';
          await deps
            .save(context, { personal: { status: 'failed', error: failure } })
            .catch(() => {});
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
              : { status: 'failed', error: errorCode },
          })
          .catch(() => {});
      }
    } finally {
      clearInterval(ownerWatch);
      if (jobs.get(context.sessionId) === job) jobs.delete(context.sessionId);
    }
  };
  return {
    hasActiveJobs: () => jobs.size > 0,
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
        if (previous && previous.context.isCurrent()) stop(previous);
        return deps.save(context, { continuedAt: (deps.now ?? Date.now)() });
      }
      if (action === 'status') {
        if (matching) return previous!.accepted.then(() => previous!.context.meta);
        const patch: Partial<CindyMakeCompletionMeta> = {};
        if (['starting', 'ready'].includes(context.meta.test?.status ?? ''))
          patch.test = { status: 'stopped', error: 'interrupted' };
        if (
          ['waiting', 'checking', 'merging', 'packaging', 'publishing'].includes(
            context.meta.personal?.status ?? '',
          )
        )
          patch.personal = { status: 'failed', error: 'interrupted' };
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
      };
      jobs.set(sessionId, job);
      job.accepted = deps
        .save(
          context,
          kind === 'test'
            ? { lastAction: 'test', test: { status: 'starting' } }
            : { lastAction: 'build', personal: { status: 'waiting' } },
        )
        .then(
          (meta) => {
            context.meta = meta;
            job.finished = execute(job);
            return meta;
          },
          (error) => {
            if (jobs.get(sessionId) === job) jobs.delete(sessionId);
            throw error;
          },
        );
      return job.accepted;
    },
  };
}
