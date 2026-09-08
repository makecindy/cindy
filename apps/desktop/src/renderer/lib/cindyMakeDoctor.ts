import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import type { MakeDoctorReport } from '../../shared/cindyMakeDoctor';
import { MAKE_DOCTOR_CHECK_IDS } from '../../shared/cindyMakeDoctor';
import { extractIpcError } from '@/utils/ipcError';
import { isCindyMakeForceManagedToolsEnabled } from './cindyMakeSettings';

type DoctorApi = Pick<
  Window['electronAPI']['maker'],
  'executeDesktopCommand' | 'onDesktopCommandTriggered'
>;
/** Runs Main-owned diagnostics; the caller owns their placement in chat or Settings. */
export function startMakeDoctor(
  onReport: (report: MakeDoctorReport) => void,
  api: DoctorApi = window.electronAPI.maker,
  command: 'cindy-make-doctor' | 'cindy-make' = 'cindy-make-doctor',
  options: { forceManagedTools?: boolean; signal?: AbortSignal; request?: string } = {},
): string {
  const owner = getDataOwnerGeneration();
  const runId = crypto.randomUUID();
  const forceManagedTools = options.forceManagedTools ?? isCindyMakeForceManagedToolsEnabled();
  let latest: MakeDoctorReport = {
    runId,
    platform: '',
    arch: '',
    status: 'running',
    mode: command === 'cindy-make' ? 'prepare' : 'check',
    ...(forceManagedTools ? { forceManagedTools: true } : {}),
    checks: MAKE_DOCTOR_CHECK_IDS.map((id) => ({ id, status: 'pending' })),
    ...(command === 'cindy-make' && options.request !== undefined
      ? { upstream: { status: 'pending' as const, items: [] } }
      : {}),
  };
  const publish = (report: MakeDoctorReport) => {
    latest = report;
    onReport(report);
  };
  publish(latest);
  const accept = (report: MakeDoctorReport | undefined) => {
    if (!options.signal?.aborted && report?.runId === runId && isDataOwnerGenerationCurrent(owner))
      publish({ ...report, mode: latest.mode });
  };
  let unsubscribe = () => {};
  let pending = false;
  const abort = () => {
    unsubscribe();
    if (pending)
      void api
        .executeDesktopCommand(command, {
          doctorRunId: runId,
          doctorAction: 'cancel',
        })
        .catch(() => {
          /* View teardown must not leave an unhandled rejection. */
        });
  };
  const fail = (error?: unknown) => {
    if (options.signal?.aborted || !isDataOwnerGenerationCurrent(owner)) return;
    publish({
      ...latest,
      status: 'failed',
      ...(latest.upstream?.status === 'searching'
        ? {
            upstream: {
              ...latest.upstream,
              status: 'failed' as const,
              failure: 'network' as const,
            },
          }
        : {}),
      checks: latest.checks.map((check) =>
        ['pending', 'checking', 'downloading', 'installing'].includes(check.status)
          ? {
              ...check,
              status: 'failed',
              reason:
                extractIpcError(error)?.code === 'DEVICE_BUSY' && check.id === 'platform'
                  ? 'busy'
                  : 'probeFailed',
              progress: undefined,
            }
          : check,
      ),
    });
  };
  if (options.signal?.aborted) return runId;
  try {
    // Subscribe before invocation so even the first platform snapshot cannot be missed.
    unsubscribe = api.onDesktopCommandTriggered((event) => {
      if (event.command === command) accept(event.doctorReport);
    });
    pending = true;
    options.signal?.addEventListener('abort', abort, { once: true });
    void api
      .executeDesktopCommand(command, {
        doctorRunId: runId,
        ...(forceManagedTools ? { forceManagedTools: true } : {}),
        ...(options.request !== undefined ? { makeRequest: options.request } : {}),
      })
      .then((result) => {
        if (result?.doctorReport?.runId === runId) accept(result.doctorReport);
        else fail();
      })
      .catch(fail)
      .finally(() => {
        pending = false;
        options.signal?.removeEventListener('abort', abort);
        unsubscribe();
      });
  } catch {
    pending = false;
    options.signal?.removeEventListener('abort', abort);
    unsubscribe();
    fail();
  }
  return runId;
}

export async function cancelMakeDoctor(
  runId: string,
  mode?: MakeDoctorReport['mode'],
): Promise<void> {
  await window.electronAPI.maker.executeDesktopCommand(
    mode === 'prepare' ? 'cindy-make' : 'cindy-make-doctor',
    {
      doctorRunId: runId,
      doctorAction: 'cancel',
    },
  );
}
