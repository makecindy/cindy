import { randomUUID } from 'node:crypto';
import type { DesktopCommandContext, DesktopCommandDefinition } from '../commands/registry.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import {
  checkCindyMakeEnvironment,
  initialDoctorReport,
  untilAborted,
  type MakeDoctorEnvironment,
} from './doctor.js';
import {
  isMakeEnvironmentReady,
  type MakeDoctorReport,
  type MakeUpstreamQuery,
} from '../../shared/cindyMakeDoctor.js';
import { searchCindyUpstream } from './upstreamQuery.js';

export function createMakeDoctorCommand<T extends MakeDoctorEnvironment>(deps: {
  name?: 'cindy-make-doctor' | 'cindy-make';
  environment: (ctx: DesktopCommandContext) => T | Promise<T>;
  allowInstallTest?: () => boolean;
  prepare?: (
    runId: string,
    env: T,
    signal: AbortSignal,
    publish: (report: MakeDoctorReport) => void,
  ) => Promise<MakeDoctorReport>;
  description: () => string;
  publish: (ctx: DesktopCommandContext, report: MakeDoctorReport) => void;
  searchUpstream?: (request: string, signal: AbortSignal) => Promise<MakeUpstreamQuery>;
  prepareSource?: (
    runId: string,
    env: T,
    signal: AbortSignal,
    publish: (report: MakeDoctorReport) => void,
    options?: { clearOnly?: boolean },
  ) => Promise<MakeDoctorReport>;
}): DesktopCommandDefinition {
  const active = new Map<
    string,
    { sender: number; controller: AbortController; source: boolean }
  >();
  const name = deps.name ?? 'cindy-make-doctor';
  return {
    name,
    get description() {
      return deps.description();
    },
    async execute(ctx) {
      if (!Number.isInteger(ctx.senderWebContentsId) || !ctx.senderWebContentsId)
        throwIpcError('INVALID_PARAMS', 'A Desktop window is required');
      if (ctx.deviceId || ctx.remoteHostId)
        throwIpcError('UNSUPPORTED_CAPABILITY', 'Make currently supports a local Desktop only');
      if (ctx.forceManagedTools !== undefined && typeof ctx.forceManagedTools !== 'boolean')
        throwIpcError('INVALID_PARAMS', 'Invalid Make test option');
      if (
        ctx.makeRequest !== undefined &&
        (typeof ctx.makeRequest !== 'string' || ctx.makeRequest.length > 4000)
      )
        throwIpcError('INVALID_PARAMS', 'Invalid Make request');
      if (
        ctx.makeAction !== undefined &&
        !['prepare-source', 'clear-source'].includes(ctx.makeAction)
      )
        throwIpcError('INVALID_PARAMS', 'Invalid Make action');
      if (ctx.makeAction && name !== 'cindy-make')
        throwIpcError('INVALID_PARAMS', 'Source preparation requires cindy-make');
      // Source preparation can be started from Settings without a chat request.
      // The request is only required for the initial chat workflow that searches upstream.
      if (ctx.forceManagedTools && !deps.allowInstallTest?.())
        throwIpcError(
          'UNSUPPORTED_CAPABILITY',
          'Make installation testing requires a development build',
        );
      if (ctx.args !== undefined && (typeof ctx.args !== 'string' || ctx.args.trim()))
        throwIpcError(
          'INVALID_PARAMS',
          'The composer retains Make request text; this operation takes no arguments',
        );
      const runId = ctx.doctorRunId ?? randomUUID();
      if (typeof runId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(runId))
        throwIpcError('INVALID_PARAMS', 'Invalid doctor run id');
      if (ctx.doctorAction !== undefined) {
        if (ctx.doctorAction !== 'cancel') throwIpcError('INVALID_PARAMS', 'Invalid doctor action');
        const run = active.get(runId);
        // Source operations are global (Settings and the workflow share one job), so
        // any trusted window may stop them; diagnostics stay private to their window.
        if (run && !run.source && run.sender !== ctx.senderWebContentsId)
          throwIpcError('INVALID_PARAMS', 'Doctor run belongs to another window');
        run?.controller.abort();
        return { success: true };
      }
      const sourceRun = ctx.makeAction !== undefined;
      // Tool provisioning must not run twice at once. Source-only runs may start
      // alongside it: sourcePreparation attaches them to one shared job.
      const toolRuns = [...active.values()].filter((run) => !run.source).length;
      if (
        active.has(runId) ||
        active.size >= 4 ||
        (name === 'cindy-make' && !sourceRun && toolRuns >= 1)
      )
        throwIpcError('DEVICE_BUSY', 'Doctor is already running');
      const controller = new AbortController();
      // Presence (including empty text) distinguishes the chat workflow from Settings preparation.
      const workflow = name === 'cindy-make' && ctx.makeRequest !== undefined && !ctx.makeAction;
      // Includes executable discovery/filesystem reads, not just child processes.
      const timeout = setTimeout(
        () => controller.abort('timeout'),
        name === 'cindy-make' ? 20 * 60_000 : 60_000,
      );
      active.set(runId, { sender: ctx.senderWebContentsId!, controller, source: sourceRun });
      let latest: MakeDoctorReport = {
        ...initialDoctorReport(runId, '', ''),
        mode: name === 'cindy-make' ? 'prepare' : 'check',
        ...(ctx.makeAction ? { checks: [] } : {}),
        ...(workflow ? { upstream: { status: 'pending', items: [] } as MakeUpstreamQuery } : {}),
      };
      let finished = false;
      const publish = (report: MakeDoctorReport) => {
        if (finished) return;
        latest = {
          ...report,
          ...(workflow ? { upstream: report.upstream ?? latest.upstream } : {}),
          ...(ctx.forceManagedTools ? { forceManagedTools: true } : {}),
        };
        deps.publish(ctx, latest);
      };
      try {
        publish(latest);
        const env = await untilAborted(Promise.resolve(deps.environment(ctx)), controller.signal);
        if (ctx.makeAction === 'prepare-source' || ctx.makeAction === 'clear-source') {
          if (!deps.prepareSource)
            throwIpcError('UNSUPPORTED_CAPABILITY', 'Source preparation is unavailable');
          if (ctx.makeAction === 'clear-source') {
            const cleared = await deps.prepareSource(runId, env, controller.signal, publish, {
              clearOnly: true,
            });
            publish({ ...cleared, upstream: latest.upstream });
          } else {
            // Source operations select/check Git themselves; build prerequisites
            // must not block a checkout or rerun the environment doctor.
            const prepared = await deps.prepareSource(runId, env, controller.signal, publish);
            publish(prepared);
          }
          return { success: true, doctorReport: latest };
        }
        const run = name === 'cindy-make' ? deps.prepare : checkCindyMakeEnvironment;
        if (!run) throwIpcError('UNSUPPORTED_CAPABILITY', 'Tool preparation is unavailable');
        const doctorReport = await run(runId, env, controller.signal, (report) => {
          if (controller.signal.aborted) return;
          // The workflow remains running until source preparation and search both finish.
          publish(
            workflow && report.status === 'completed' && isMakeEnvironmentReady(report)
              ? { ...report, status: 'running' }
              : report,
          );
        });
        controller.signal.throwIfAborted();
        if (
          workflow &&
          doctorReport.status === 'completed' &&
          isMakeEnvironmentReady(doctorReport)
        ) {
          if (!ctx.makeRequest?.trim()) {
            publish({ ...doctorReport, upstream: { status: 'needsRequest', items: [] } });
          } else {
            publish({
              ...doctorReport,
              status: 'running',
              source: { status: 'preparing', path: '', phase: 'checking' },
            });
            if (!deps.prepareSource)
              throwIpcError('UNSUPPORTED_CAPABILITY', 'Source preparation is unavailable');
            // Source-only reports have no environment checks. Preserve stage 1
            // throughout stage 2 and never expose a terminal success before stage 3.
            const withEnvironment = (report: MakeDoctorReport): MakeDoctorReport => ({
              ...doctorReport,
              ...report,
              checks: doctorReport.checks,
              source: report.source ?? latest.source,
            });
            const prepared = withEnvironment(
              await untilAborted(
                deps.prepareSource(runId, env, controller.signal, (report) => {
                  if (controller.signal.aborted || finished) return;
                  publish({
                    ...withEnvironment(report),
                    status: report.status === 'completed' ? 'running' : report.status,
                  });
                }),
                controller.signal,
              ),
            );
            controller.signal.throwIfAborted();
            if (
              prepared.status !== 'completed' ||
              prepared.source?.status !== 'ready' ||
              !prepared.source.path
            ) {
              const status =
                prepared.status === 'cancelled' || prepared.source?.status === 'cancelled'
                  ? 'cancelled'
                  : 'failed';
              publish({
                ...prepared,
                status,
                source: {
                  path: '',
                  ...prepared.source,
                  status,
                  progress: undefined,
                  error:
                    prepared.source?.error ?? (status === 'cancelled' ? 'cancelled' : 'gitFailed'),
                },
              });
              return { success: true, doctorReport: latest };
            }
            publish({
              ...prepared,
              status: 'running',
              upstream: { status: 'searching', items: [] },
            });
            const upstream = await untilAborted(
              (deps.searchUpstream ?? searchCindyUpstream)(ctx.makeRequest, controller.signal),
              controller.signal,
            );
            controller.signal.throwIfAborted();
            publish({ ...prepared, upstream });
          }
        } else {
          publish(doctorReport);
        }
        return { success: true, doctorReport: latest };
      } catch {
        const timedOut = controller.signal.reason === 'timeout';
        const cancelled = controller.signal.aborted && !timedOut;
        const doctorReport: MakeDoctorReport = {
          ...latest,
          status: cancelled ? 'cancelled' : 'failed',
          ...(latest.source?.status === 'preparing'
            ? {
                source: {
                  ...latest.source,
                  status: cancelled ? ('cancelled' as const) : ('failed' as const),
                  error: cancelled ? ('cancelled' as const) : ('gitFailed' as const),
                  progress: undefined,
                },
              }
            : {}),
          ...(latest.upstream?.status === 'searching'
            ? {
                upstream: {
                  ...latest.upstream,
                  status: cancelled ? ('cancelled' as const) : ('failed' as const),
                  ...(cancelled
                    ? {}
                    : { failure: timedOut ? ('timeout' as const) : ('network' as const) }),
                },
              }
            : {}),
          checks: latest.checks.map((check) =>
            ['pending', 'checking', 'downloading', 'installing'].includes(check.status)
              ? {
                  ...check,
                  status: cancelled ? 'cancelled' : 'failed',
                  reason: timedOut ? 'timeout' : cancelled ? 'cancelled' : 'probeFailed',
                  progress: undefined,
                }
              : check,
          ),
        };
        publish(doctorReport);
        return { success: true, doctorReport: latest };
      } finally {
        finished = true;
        clearTimeout(timeout);
        active.delete(runId);
      }
    },
  };
}
