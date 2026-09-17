import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { makerChatStore } from './makerChatStore';
import * as sessionService from './sessionService';
import { sessionsStore } from './sessionsStore';
import { startMakeDoctor } from './cindyMakeDoctor';
import type { MakeDoctorReport, MakeUpstreamDecision } from '../../shared/cindyMakeDoctor';
import type { CindyMakeInvocation } from './cindyMakeCommand';
import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';
import i18n from '@/i18n';

// Only coalesce concurrent clicks. The created task id lives in the persisted card.
const codeSessionStarts = new Map<string, Promise<string | null>>();

export function startMakeCodeSession(sessionId: string, runId: string): Promise<string | null> {
  const owner = getDataOwnerGeneration();
  const key = [owner.dataOwnerId, owner.generation, sessionId, runId].join(':');
  const pending = codeSessionStarts.get(key);
  if (pending) return pending;
  if (getStickySessionDeviceId(sessionId)) return Promise.resolve(null);
  const message = makerChatStore
    .getSnapshot(sessionId)
    .messages.find(
      (row) =>
        row.systemCardType === 'cindy-make' &&
        (row.systemCardData?.report as MakeDoctorReport | undefined)?.runId === runId,
    );
  const data = message?.systemCardData;
  const report = data?.report as MakeDoctorReport | undefined;
  const request = typeof data?.request === 'string' ? data.request : '';
  if (!message || !request.trim() || !report || data?.decision !== 'personal')
    return Promise.resolve(null);
  if (typeof data.codeSessionId === 'string') return Promise.resolve(data.codeSessionId);
  const update = (patch: Record<string, unknown>) => {
    if (isDataOwnerGenerationCurrent(owner))
      makerChatStore.updateSystemCardData(sessionId, message.clientId, patch);
  };
  const start = async () => {
    update({ codeStartPhase: 'session', codeSessionError: false });
    try {
      const requestChars = Array.from(request.replace(/\s+/gu, ' ').trim());
      const title = i18n.t('cindyMake.code.taskTitle', {
        request:
          requestChars.length > 60
            ? requestChars.slice(0, 60).join('') + '…'
            : requestChars.join(''),
      });
      const createdId = await window.electronAPI.startCindyMakeTask({
        originSessionId: sessionId,
        runId,
        request,
        title,
      });
      if (!isDataOwnerGenerationCurrent(owner)) return null;
      update({ codeSessionId: createdId, codeStartPhase: undefined, codeSessionError: false });
      makerChatStore.setSessionRuntime(createdId, { autoTitleDisabled: true });
      const session = await sessionService.get(createdId).catch(() => null);
      if (!isDataOwnerGenerationCurrent(owner)) return null;
      if (session) sessionsStore.prependCreated(session);
      return createdId;
    } catch {
      update({ codeSessionError: true, codeStartPhase: undefined });
      return null;
    }
  };
  const result = start().finally(() => codeSessionStarts.delete(key));
  codeSessionStarts.set(key, result);
  return result;
}

/** Reuse an existing task, or create only the home-page command's chat container, without an Agent turn. */
export async function ensureMakeTask(input: {
  sessionId?: string;
  createOptions: Parameters<typeof sessionService.create>[0];
  title?: string;
  isCurrent: () => boolean;
}): Promise<string | null> {
  const owner = getDataOwnerGeneration();
  if (!input.isCurrent()) return null;
  if (input.sessionId) return input.sessionId;
  let session = await sessionService.create(input.createOptions);
  if (!isDataOwnerGenerationCurrent(owner)) return null;
  if (input.title && typeof sessionService.update === 'function') {
    try {
      session = await sessionService.update(session.id, { title: input.title });
    } catch {
      // The task still exists if the best-effort title write loses a race.
    }
  }
  if (!isDataOwnerGenerationCurrent(owner)) return null;
  sessionsStore.prependCreated(session);
  return input.isCurrent() ? session.id : null;
}

/** One message per invocation; progress and retries update that message, even after switching views. */
export function startMakeDoctorInStream(
  sessionId: string,
  input: CindyMakeInvocation | { retryRunId: string; request?: string } = {
    command: 'cindy-make-doctor',
  },
  api?: Parameters<typeof startMakeDoctor>[1],
  options: { modalOnly?: boolean } = {},
): string | null {
  if (!sessionId) return null;
  const owner = getDataOwnerGeneration();
  const retryRunId = 'retryRunId' in input ? input.retryRunId : undefined;
  if ('command' in input && input.command === 'cindy-make' && !input.request.trim()) return null;
  const retryMessage = retryRunId
    ? makerChatStore
        .getSnapshot(sessionId)
        .messages.find(
          (message) =>
            (message.systemCardType === 'cindy-make-doctor' ||
              message.systemCardType === 'cindy-make') &&
            (message.systemCardData?.report as MakeDoctorReport | undefined)?.runId === retryRunId,
        )
    : undefined;
  // The card may have been removed, or another click may already have started its retry.
  if (retryRunId && !retryMessage) return null;
  if ((retryMessage?.systemCardData?.report as MakeDoctorReport | undefined)?.status === 'running')
    return null;
  const request =
    'request' in input && typeof input.request === 'string'
      ? input.request
      : typeof retryMessage?.systemCardData?.request === 'string'
        ? retryMessage.systemCardData.request
        : undefined;
  if (
    (retryMessage?.systemCardType === 'cindy-make' ||
      ('command' in input && input.command === 'cindy-make')) &&
    (!request || !request.trim())
  )
    return null;
  if (request !== undefined && request.length > 4000) return null;
  let clientId = retryMessage?.clientId ?? null;
  let first = true;
  return startMakeDoctor(
    (report) => {
      if (!isDataOwnerGenerationCurrent(owner)) return;
      if (!clientId) {
        if (!('command' in input)) return;
        clientId = makerChatStore.insertSystemCard(sessionId, input.command, {
          report,
          ...(input.command === 'cindy-make' ? { request: input.request } : {}),
          ...(options.modalOnly ? { modalOnly: true } : {}),
        });
      } else {
        const current = makerChatStore
          .getSnapshot(sessionId)
          .messages.find(
            (message) =>
              message.clientId === clientId &&
              (message.systemCardType === 'cindy-make-doctor' ||
                message.systemCardType === 'cindy-make'),
          );
        const currentReport = current?.systemCardData?.report as MakeDoctorReport | undefined;
        if (!currentReport || currentReport.runId !== (first ? retryRunId : report.runId)) return;
        makerChatStore.updateSystemCardData(sessionId, clientId, {
          report,
          request,
          ...(first ? { decision: undefined } : {}),
        });
      }
      first = false;
    },
    api,
    ('command' in input ? input.command : retryMessage?.systemCardType) === 'cindy-make'
      ? 'cindy-make'
      : 'cindy-make-doctor',
    {
      request,
    },
  );
}

export async function chooseMakeUpstream(
  sessionId: string,
  runId: string,
  decision: MakeUpstreamDecision,
): Promise<string | null> {
  const message = makerChatStore
    .getSnapshot(sessionId)
    .messages.find(
      (row) =>
        row.systemCardType === 'cindy-make' &&
        (row.systemCardData?.report as MakeDoctorReport | undefined)?.runId === runId,
    );
  const report = message?.systemCardData?.report as MakeDoctorReport | undefined;
  if (
    !message ||
    report?.status !== 'completed' ||
    !['found', 'notFound'].includes(report.upstream?.status ?? '') ||
    message.systemCardData?.decision
  )
    return null;
  makerChatStore.updateSystemCardData(sessionId, message.clientId, { decision });
  return decision === 'personal' ? startMakeCodeSession(sessionId, runId) : null;
}

export async function prepareMakeSourceInStream(
  sessionId: string,
  runId: string,
): Promise<string | null> {
  const message = makerChatStore
    .getSnapshot(sessionId)
    .messages.find(
      (row) =>
        row.systemCardType === 'cindy-make' &&
        (row.systemCardData?.report as MakeDoctorReport | undefined)?.runId === runId,
    );
  if (!message || getStickySessionDeviceId(sessionId)) return null;
  makerChatStore.updateSystemCardData(sessionId, message.clientId, { decision: 'personal' });
  return startMakeCodeSession(sessionId, runId);
}
