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
}): DesktopCommandDefinition {
  const active = new Map<string, { sender: number; controller: AbortController }>();
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
        if (run && run.sender !== ctx.senderWebContentsId)
          throwIpcError('INVALID_PARAMS', 'Doctor run belongs to another window');
        run?.controller.abort();
        return { success: true };
      }
      if (active.has(runId) || active.size >= (name === 'cindy-make' ? 1 : 4))
        throwIpcError('DEVICE_BUSY', 'Doctor is already running');
      const controller = new AbortController();
      // Presence (including empty text) distinguishes the chat workflow from Settings preparation.
      const workflow = name === 'cindy-make' && ctx.makeRequest !== undefined;
      // Includes executable discovery/filesystem reads, not just child processes.
      const timeout = setTimeout(
        () => controller.abort('timeout'),
        name === 'cindy-make' ? 20 * 60_000 : 60_000,
      );
      active.set(runId, { sender: ctx.senderWebContentsId!, controller });
      let latest: MakeDoctorReport = {
        ...initialDoctorReport(runId, '', ''),
        mode: name === 'cindy-make' ? 'prepare' : 'check',
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
        const run = name === 'cindy-make' ? deps.prepare : checkCindyMakeEnvironment;
        if (!run) throwIpcError('UNSUPPORTED_CAPABILITY', 'Tool preparation is unavailable');
        const doctorReport = await run(runId, env, controller.signal, (report) => {
          if (controller.signal.aborted) return;
          // No terminal environment snapshot while the automatic search is still to come.
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
              upstream: { status: 'searching', items: [] },
            });
            const upstream = await untilAborted(
              (deps.searchUpstream ?? searchCindyUpstream)(ctx.makeRequest, controller.signal),
              controller.signal,
            );
            controller.signal.throwIfAborted();
            publish({ ...doctorReport, upstream });
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
