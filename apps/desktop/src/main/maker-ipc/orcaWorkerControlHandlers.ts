import { throwIpcError } from '../utils/ipcValidate.js';
import { MAKER_INVOKE } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';
import { throwOrcaServiceFailure } from './orcaServiceFailure.js';

type OrcaWorkerControlResult =
  | { ok: true; workerId?: string }
  | {
      ok: false;
      errorCode: string;
      message: string;
      deferredAcknowledgementRegistered?: true;
    };
type IdleWorkerExpectedStatus = 'done';

export interface OrcaWorkerControlHandlerDeps {
  idleWorker(params: { callerLeadSessionId: string; workerId: string; expectedStatus?: IdleWorkerExpectedStatus }): Promise<OrcaWorkerControlResult>;
  archiveWorker(params: { callerLeadSessionId: string; workerId: string }): Promise<OrcaWorkerControlResult>;
  logInfo(message: string, fields?: Record<string, unknown>): void;
}

/** WORKER_IDLE / WORKER_ARCHIVE 只做 IPC 参数校验和错误码翻译，业务归属检查留在 OrcaTeamService。 */
export function registerOrcaWorkerControlHandlers(
  registry: IpcHandlerRegistry,
  deps: OrcaWorkerControlHandlerDeps,
): void {
  const handleIdle = async (body: unknown, forcedExpectedStatus?: IdleWorkerExpectedStatus) => {
    const b = readWorkerControlPayload(body);

    let result: Awaited<ReturnType<OrcaWorkerControlHandlerDeps['idleWorker']>>;
    try {
      result = await deps.idleWorker({
        callerLeadSessionId: b.leadSessionId,
        workerId: b.workerId,
        ...(forcedExpectedStatus ? { expectedStatus: forcedExpectedStatus } : b.expectedStatus ? { expectedStatus: b.expectedStatus } : {}),
      });
    } catch (err) {
      throwIpcError('INTERNAL', err instanceof Error ? err.message : String(err));
    }
    if (!result.ok) {
      if (forcedExpectedStatus === 'done' && result.deferredAcknowledgementRegistered === true) {
        deps.logInfo('idleWorker deferred to terminal boundary', { workerId: b.workerId });
        return { ok: true as const, workerId: b.workerId, deferred: true as const };
      }
      throwOrcaServiceFailure(result);
    }
    deps.logInfo('idleWorker done', { workerId: b.workerId });
    return result;
  };

  registry.handle(MAKER_INVOKE.WORKER_IDLE, async (_e, body: unknown) => handleIdle(body));
  // This separate channel is the compatibility gate for automatic done acks:
  // pre-feature remote peers reject it instead of silently taking the old idle path.
  registry.handle(MAKER_INVOKE.WORKER_ACKNOWLEDGE_DONE, async (_e, body: unknown) =>
    handleIdle(body, 'done'));

  registry.handle(MAKER_INVOKE.WORKER_ARCHIVE, async (_e, body: unknown) => {
    const b = readWorkerControlPayload(body);

    let result: Awaited<ReturnType<OrcaWorkerControlHandlerDeps['archiveWorker']>>;
    try {
      result = await deps.archiveWorker({
        callerLeadSessionId: b.leadSessionId,
        workerId: b.workerId,
      });
    } catch (err) {
      throwIpcError('INTERNAL', err instanceof Error ? err.message : String(err));
    }
    if (!result.ok) throwOrcaServiceFailure(result);
    deps.logInfo('archiveWorker done', { workerId: b.workerId });
    return result;
  });
}

function readWorkerControlPayload(body: unknown): {
  leadSessionId: string;
  workerId: string;
  expectedStatus?: IdleWorkerExpectedStatus;
} {
  const b = body as Record<string, unknown> | null | undefined;
  if (!b || typeof b.workerId !== 'string') throwIpcError('INVALID_PARAMS', 'workerId required');
  if (typeof b.leadSessionId !== 'string') throwIpcError('INVALID_PARAMS', 'leadSessionId required');
  if (b.expectedStatus !== undefined && b.expectedStatus !== 'done') {
    throwIpcError('INVALID_PARAMS', 'expectedStatus must be done');
  }
  return {
    leadSessionId: b.leadSessionId,
    workerId: b.workerId,
    ...(b.expectedStatus === 'done' ? { expectedStatus: 'done' } : {}),
  };
}
