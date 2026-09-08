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

/** Reuse an existing task, or create only the home-page command's chat container, without an Agent turn. */
export async function ensureMakeTask(input: {
  sessionId?: string;
  createOptions: Parameters<typeof sessionService.create>[0];
  isCurrent: () => boolean;
}): Promise<string | null> {
  const owner = getDataOwnerGeneration();
  if (!input.isCurrent()) return null;
  if (input.sessionId) return input.sessionId;
  const session = await sessionService.create(input.createOptions);
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

/** Records a choice in this card only. Source preparation is a later, Main-owned stage. */
export function chooseMakeUpstream(
  sessionId: string,
  runId: string,
  decision: MakeUpstreamDecision,
): void {
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
    !report ||
    report.status !== 'completed' ||
    !['found', 'notFound'].includes(report.upstream?.status ?? '') ||
    message.systemCardData?.decision
  )
    return;
  makerChatStore.updateSystemCardData(sessionId, message.clientId, { decision });
}
