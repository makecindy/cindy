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
import { plainTextToTiptapDoc, saveDraft } from './composerDraftStore';

// Only coalesce concurrent clicks. The created task id lives in the persisted card.
const codeSessionStarts = new Map<string, Promise<string | null>>();

/** Create an ordinary code task and send the original request through the normal send path. */
export function startMakeCodeSession(sessionId: string, runId: string): Promise<string | null> {
  const owner = getDataOwnerGeneration();
  const key = `${owner}:${sessionId}:${runId}`;
  const pending = codeSessionStarts.get(key);
  if (pending) return pending;
  if (getStickySessionDeviceId(sessionId)) return Promise.resolve(null);
  const currentCard = () =>
    makerChatStore
      .getSnapshot(sessionId)
      .messages.find(
        (row) =>
          row.systemCardType === 'cindy-make' &&
          (row.systemCardData?.report as MakeDoctorReport | undefined)?.runId === runId,
      );
  const message = currentCard();
  const data = message?.systemCardData;
  const report = data?.report as MakeDoctorReport | undefined;
  const source = report?.source;
  const request = typeof data?.request === 'string' ? data.request : '';
  if (
    !message ||
    !request.trim() ||
    report?.status !== 'completed' ||
    source?.status !== 'ready' ||
    !source.path ||
    data?.decision !== 'personal'
  )
    return Promise.resolve(null);
  // Opening an existing task must never replay its first message, including after reload.
  if (typeof data.codeSessionId === 'string') return Promise.resolve(data.codeSessionId);
  const isCurrent = () =>
    isDataOwnerGenerationCurrent(owner) && currentCard()?.clientId === message.clientId;
  const update = (patch: Record<string, unknown>) => {
    if (isCurrent()) makerChatStore.updateSystemCardData(sessionId, message.clientId, patch);
  };
  const start = async (): Promise<string | null> => {
    let createdId: string | null = null;
    try {
      const origin = await sessionService.get(sessionId);
      if (!isCurrent() || origin.remoteHostId || origin.deviceLinkDeviceId) return null;
      const profile = origin.runtimeEffective;
      const agentKind =
        profile?.agentKind === 'claude-code' ? 'cc' : (profile?.agentKind ?? origin.agentKind);
      const session = await sessionService.create({
        workingDir: source.path,
        workspaceKind: 'project',
        agentKind,
        model: profile?.model ?? origin.model,
        effort: profile ? (profile.effort ?? '') : origin.effort,
        providerId: profile ? profile.providerId : origin.providerId,
        fastMode: profile?.fastMode ?? origin.fastMode,
        permissionMode: origin.permissionMode,
        planModeEnabled: origin.planModeEnabled ?? false,
      });
      if (!isCurrent()) return null;
      createdId = session.id;
      sessionsStore.prependCreated(session);
      update({ codeSessionId: session.id, codeSessionError: false });
      makerChatStore.setSessionRuntime(session.id, {
        agentKind: session.agentKind === 'cc' ? 'claude-code' : session.agentKind,
        fastMode: session.fastMode,
        planModeEnabled: session.planModeEnabled ?? false,
        remoteHostId: null,
      });
      makerChatStore.mirrorSessionFields(session.id, { providerId: session.providerId ?? null });
      const accepted = await makerChatStore.sendMessage(
        session.id,
        request,
        session.model,
        session.effort,
        session.permissionMode,
        source.path,
      );
      if (!accepted && isCurrent()) {
        saveDraft(session.id, { text: plainTextToTiptapDoc(request), attachments: [] });
        update({ codeSessionError: true });
      }
      return isCurrent() ? session.id : null;
    } catch {
      if (createdId && isCurrent()) {
        saveDraft(createdId, { text: plainTextToTiptapDoc(request), attachments: [] });
      }
      update({ codeSessionError: true });
      return isCurrent() ? createdId : null;
    }
  };
  const result = start().finally(() => {
    codeSessionStarts.delete(key);
  });
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

/** After the three preparation steps, the personal choice creates the code task. */
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
    !report ||
    report.status !== 'completed' ||
    !['found', 'notFound'].includes(report.upstream?.status ?? '') ||
    message.systemCardData?.decision
  )
    return null;
  makerChatStore.updateSystemCardData(sessionId, message.clientId, { decision });
  if (decision !== 'personal') return null;
  if (report.source?.status === 'ready' && report.source.path) {
    return startMakeCodeSession(sessionId, runId);
  }
  // Historical cards from the search-first workflow may not have a checkout yet.
  return prepareMakeSourceInStream(sessionId, runId);
}

/** Starts the Main-owned source checkout while keeping the existing message card. */
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
  const request =
    typeof message?.systemCardData?.request === 'string' ? message.systemCardData.request : '';
  if (
    !message ||
    !request.trim() ||
    typeof window === 'undefined' ||
    getStickySessionDeviceId(sessionId)
  )
    return null;
  const currentReport = message.systemCardData?.report as MakeDoctorReport | undefined;
  const pendingSource = currentReport?.source ?? { status: 'pending' as const, path: '' };
  const retainUpstream = (report: MakeDoctorReport): MakeDoctorReport => {
    const existing = makerChatStore
      .getSnapshot(sessionId)
      .messages.find((row) => row.clientId === message.clientId);
    const existingReport = existing?.systemCardData?.report as MakeDoctorReport | undefined;
    return {
      ...report,
      // Source reports describe only the checkout. Retain the actual results
      // from the earlier environment step instead of inventing new passes.
      checks: currentReport?.checks ?? report.checks,
      platform: report.platform || currentReport?.platform || '',
      arch: report.arch || currentReport?.arch || '',
      ...(report.upstream || existingReport?.upstream
        ? { upstream: report.upstream ?? existingReport?.upstream }
        : {}),
      ...(report.source || existingReport?.source
        ? { source: report.source ?? existingReport?.source }
        : {}),
    };
  };
  makerChatStore.updateSystemCardData(sessionId, message.clientId, {
    report: {
      ...(currentReport ?? {
        runId,
        platform: '',
        arch: '',
        checks: [],
        status: 'running' as const,
      }),
      mode: 'prepare',
      status: 'running',
      source: pendingSource,
    },
    request,
    decision: 'personal',
  });
  const owner = getDataOwnerGeneration();
  const isCurrent = () =>
    isDataOwnerGenerationCurrent(owner) &&
    (
      makerChatStore
        .getSnapshot(sessionId)
        .messages.find((row) => row.clientId === message.clientId)?.systemCardData?.report as
        MakeDoctorReport | undefined
    )?.runId === runId;
  let unsubscribe = () => {};
  unsubscribe = window.electronAPI.maker.onDesktopCommandTriggered((event) => {
    if (!isCurrent() || event.command !== 'cindy-make') return;
    const report = event.doctorReport as MakeDoctorReport | undefined;
    if (!report || report.runId !== runId) return;
    makerChatStore.updateSystemCardData(sessionId, message.clientId, {
      // The follow-up Main command receives only the request and run id. Keep the
      // upstream lookup from the original card while its source checkout progresses.
      report: retainUpstream(report),
      request,
      decision: 'personal',
    });
    if (
      ['completed', 'failed', 'cancelled'].includes(report.status) &&
      report.source?.status !== 'preparing'
    ) {
      unsubscribe();
    }
  });
  return window.electronAPI.maker
    .executeDesktopCommand('cindy-make', {
      doctorRunId: runId,
      makeAction: 'prepare-source',
      makeRequest: request,
      ...(currentReport?.forceManagedTools ? { forceManagedTools: true } : {}),
    })
    .then((result) => {
      const report = result?.doctorReport as MakeDoctorReport | undefined;
      if (isCurrent() && report?.runId === runId) {
        makerChatStore.updateSystemCardData(sessionId, message.clientId, {
          report: retainUpstream(report),
          request,
          decision: 'personal',
        });
        if (report.status === 'completed' && report.source?.status === 'ready') {
          return startMakeCodeSession(sessionId, runId);
        }
      }
      return null;
    })
    .catch(() => null)
    .finally(() => unsubscribe());
}
