import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import type { CindyMakeGlobalState, MakeDoctorReport } from '../../shared/cindyMakeDoctor';
import { MAKE_DOCTOR_CHECK_IDS } from '../../shared/cindyMakeDoctor';
import { extractIpcError } from '@/utils/ipcError';
import { isCindyMakeForceManagedToolsEnabled } from './cindyMakeSettings';

type DoctorApi = Pick<
  Window['electronAPI']['maker'],
  'executeDesktopCommand' | 'onDesktopCommandTriggered'
> & {
  onCindyMakeState?: (listener: (state: CindyMakeGlobalState) => void) => () => void;
};
/** Runs Main-owned diagnostics; the caller owns their placement in chat or Settings. */
export function startMakeDoctor(
  onReport: (report: MakeDoctorReport) => void,
  api: DoctorApi = window.electronAPI.maker,
  command: 'cindy-make-doctor' | 'cindy-make' = 'cindy-make-doctor',
  options: {
    forceManagedTools?: boolean;
    signal?: AbortSignal;
    request?: string;
    makeAction?: 'prepare-source' | 'clear-source';
  } = {},
): string {
  const owner = getDataOwnerGeneration();
  const runId = crypto.randomUUID();
  const forceManagedTools = options.forceManagedTools ?? isCindyMakeForceManagedToolsEnabled();
  const workflow = command === 'cindy-make' && options.request !== undefined && !options.makeAction;
  let latest: MakeDoctorReport = {
    runId,
    platform: '',
    arch: '',
    status: 'running',
    mode: command === 'cindy-make' ? 'prepare' : 'check',
    ...(forceManagedTools ? { forceManagedTools: true } : {}),
    checks: options.makeAction
      ? []
      : MAKE_DOCTOR_CHECK_IDS.map((id) => ({ id, status: 'pending' })),
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
  let unsubscribeState = () => {};
  let pending = false;
  const abort = () => {
    unsubscribe();
    unsubscribeState();
  };
  const fail = (error?: unknown) => {
    if (options.signal?.aborted || !isDataOwnerGenerationCurrent(owner)) return;
    publish({
      ...latest,
      status: 'failed',
      ...(latest.source?.status === 'preparing'
        ? {
            source: {
              ...latest.source,
              status: 'failed' as const,
              error: 'gitFailed' as const,
              progress: undefined,
            },
          }
        : {}),
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
    const stateKey = options.makeAction
      ? options.makeAction === 'prepare-source'
        ? 'sourcePrepare'
        : 'sourceClear'
      : command === 'cindy-make-doctor'
        ? 'environmentCheck'
        : 'environmentPrepare';
    const stateSubscriber =
      api.onCindyMakeState ??
      (typeof window !== 'undefined'
        ? (window.electronAPI as typeof window.electronAPI & DoctorApi).onCindyMakeState
        : undefined);
    if (!workflow) {
      unsubscribeState =
        stateSubscriber?.((state) => {
          const snapshot = state[stateKey];
          if (!snapshot?.active) return;
          const report = snapshot.report;
          const matchesMode = report.mode === latest.mode;
          const matchesForce = (report.forceManagedTools === true) === (forceManagedTools === true);
          if (matchesMode && matchesForce) accept({ ...report, runId });
        }) ?? (() => {});
    }
    pending = true;
    options.signal?.addEventListener('abort', abort, { once: true });
    void api
      .executeDesktopCommand(command, {
        doctorRunId: runId,
        ...(options.makeAction ? { makeAction: options.makeAction } : {}),
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
        unsubscribeState();
      });
  } catch {
    pending = false;
    options.signal?.removeEventListener('abort', abort);
    unsubscribe();
    unsubscribeState();
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
