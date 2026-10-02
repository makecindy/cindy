import { stat } from 'node:fs/promises';
import { getDbClient } from '../localDb/client/current.js';
import { getSessionRowSnapshotStrict } from '../localDb/ipc/sessions.js';
import { awaitAgentInputQueueSnapshotPersistence, readInputDeliveryReceipts } from '../localDb/agentInputQueueSnapshots.js';
import { checkRemoteWorkingDir } from '../device-link/remote-workdir-guard.js';
import { emitSessionCreated } from '../localDb/ipc/sessionCreatedBroadcast.js';
import type { SessionControlRequest } from '@cindy/maker-shared/session-controller';
import { isSessionResourceLocalTo } from '@cindy/maker-shared/session-controller';
import { createSessionController, sessionOperation, SessionAdmissionError } from './controller.js';
import { localSessionHost } from './localHost.js';
import { requireSessionCaller } from './callerContext.js';
import { createSessionRecord } from './opening.js';
import { createSessionRequestLedger } from './idempotency.js';
import { tryGetSessionService } from './sessionService.js';
import { requireSessionOperation } from './operationContext.js';
import { sessionRecords } from './records.js';
import { sessionHistory } from './history.js';
import { resolveSessionInputFiles } from './resources.js';

/** Same typed commands for local Main and device-link. All execution goes through
 * existing Session business services; this module owns only transport receipts. */
export async function executeSessionCommand(request: SessionControlRequest, callerKey: string): Promise<unknown> {
  if (request.deviceId !== localSessionHost.deviceId()) throw new SessionAdmissionError('INVALID_ARGS', '请求必须由目标设备执行。');
  const controller = createSessionController(localSessionHost, {
    command: sessionOperation({
      operation: () => request.command.operation,
      targets: () => request.target ? [request.target.sessionId] : [],
      execute: async () => {
        const runtimeService = () => {
          const service = tryGetSessionService();
          if (!service) throw new SessionAdmissionError('HOST_NOT_READY', '任务运行服务尚未就绪。');
          return service;
        };
        const scope = requireSessionOperation();
        const db = getDbClient();
        const ledger = createSessionRequestLedger(db, scope.assertCurrent);
        const id = request.target?.sessionId ?? '';
        const c = request.command;
        switch (c.operation) {
          case 'inspectInteractions': return runtimeService().inspectInteractions({ sessionId: id });
          case 'listBackgroundTasks': return runtimeService().listBackgroundTasks({ sessionId: id });
          case 'resolveInteraction': return runtimeService().resolveInteraction({ sessionId: id, ...c.args });
          case 'deleteMessage': return runtimeService().deleteMessage({ sessionId: id, ...c.args });
          case 'ensureRuntime': return runtimeService().ensureRuntime({ sessionId: id });
          case 'updateMetadata': return sessionRecords.rename([{ sessionId: id, title: c.args.title }], false);
          case 'setRecordStatus': return sessionRecords.setRecordStatus(id, c.args.status);
          case 'pauseQueue': return runtimeService().pauseQueue({ sessionId: id, ...c.args });
          case 'resumeQueue': return runtimeService().resumeQueue({ sessionId: id, ...c.args });
          case 'retryInput': return runtimeService().retryInput({ sessionId: id, ...c.args });
          case 'clearInputError': return runtimeService().clearInputError({ sessionId: id, ...c.args });
          case 'moveInput': return runtimeService().moveInput({ sessionId: id, ...c.args });
          case 'updateInputPresentation': return runtimeService().updateInputPresentation({ sessionId: id, ...c.args });
          case 'setInputLock': return c.args.kind === 'edit' ? runtimeService().setEditLock({ sessionId: id, ...c.args })
            : runtimeService().setInteractionLock({ sessionId: id, lockId: c.args.inputId, ...c.args });
          case 'clearInputs': return runtimeService().clearInputs({ sessionId: id, ...c.args });
          case 'changePermission': return c.args.setting.kind === 'plan'
            ? runtimeService().changePlanMode({ sessionId: id, enabled: c.args.setting.enabled })
            : runtimeService().changePermission({ sessionId: id, mode: c.args.setting.mode });
          case 'inspectHistory': return c.args.mode.kind === 'tree' ? runtimeService().inspectHistory({ sessionId: id })
            : sessionHistory.previewRewind(id, c.args.mode.inputId);
          case 'rewind': return c.args.mode.kind === 'tree'
            ? runtimeService().navigateHistory({ sessionId: id, entryId: c.args.mode.entryId, options: c.args.mode.options })
            : sessionHistory.rewind(id, c.args.mode.inputId, c.args.mode.options);
          case 'fork': {
            const row = await sessionHistory.fork(id, c.args.messageClientId);
            emitSessionCreated(row.id);
            return row;
          }
          case 'listRecords': {
            const limit = c.args.limit ?? 50;
            const visible: Awaited<ReturnType<typeof sessionRecords.list>>['items'] = [];
            let cursor = c.args.cursor ?? null;
            while (visible.length <= limit) {
              const page = await sessionRecords.list({ workdir: null, fromMs: null, toMs: null, agentKind: null,
                includeDeleted: false, order: 'desc', limit: 100, cursor });
              const filtered = await Promise.all(page.items.map(async item => await scope.allows('inspect', [item.id]) ? item : null));
              visible.push(...filtered.filter(item => item !== null));
              if (!page.hasMore || !page.nextCursor) break;
              cursor = page.nextCursor;
            }
            const items = visible.slice(0, limit);
            const last = items.at(-1);
            // The cursor must not reveal the ID of an inaccessible row.
            return { items, hasMore: visible.length > limit,
              nextCursor: visible.length > limit && last ? { createdAt: last.createdAt, id: last.id } : null };
          }
          case 'compact': return runtimeService().compact({ sessionId: id, instructions: c.args.instructions });
          case 'listActive': return runtimeService().listActiveSessions();
          case 'inspect': return runtimeService().inspectSession(id);
          case 'diagnose': return runtimeService().diagnoseSession(id);
          case 'capabilities': return runtimeService().sessionCapabilities(id);
          case 'inspectQueue': return runtimeService().listSessionQueue(id);
          case 'inspectRuntime': return runtimeService().getSessionRuntime({ targetSessionId: id });
          case 'selectRuntime': return runtimeService().setSessionRuntime({ targetSessionId: id, expectedGeneration: c.args.expectedGeneration,
            patch: { ...c.args.patch, effort: c.args.patch.effort ?? undefined } });
          case 'requestStop': return runtimeService().stopSessionTurn({ targetSessionId: id, expectedExecution: c.args.expectedExecution });
          case 'abortTurn': return runtimeService().abortSession({ sessionId: id, expectedExecution: c.args.expectedExecution });
          case 'closeRuntime': return runtimeService().closeSession({ sessionId: id, expectedExecution: c.args.expectedExecution });
          case 'stopBackgroundTask': return runtimeService().stopBackgroundTask({ sessionId: id, taskId: c.args.taskId });
          case 'steer': return runtimeService().steerSession({ targetSessionId: id, callerSessionId: callerKey, message: c.args.message });
          case 'editOwnedInput': return runtimeService().updateSessionQueuedMessage({ targetSessionId: id, callerSessionId: callerKey, queuedMessageId: c.args.inputId, message: c.args.message });
          case 'withdrawOwnedInput': return runtimeService().cancelSessionQueuedMessage({ targetSessionId: id, callerSessionId: callerKey, queuedMessageId: c.args.inputId });
          case 'createRecord': {
            const resource = c.args.directory;
            if (!isSessionResourceLocalTo(resource, { deviceId: request.deviceId, remoteHostId: null })) {
              throw new SessionAdmissionError('RESOURCE_UNREACHABLE', '目录不属于目标设备的本地命名空间。');
            }
            let acceptedResource = resource;
            const validateDirectory = async () => {
              const check = await checkRemoteWorkingDir(resource.locator);
              if (!check.allowed) throw new SessionAdmissionError('RESOURCE_UNREACHABLE', '目标目录当前不可用。');
              const version = await stat(resource.locator);
              const observedVersion = `${version.dev}:${version.ino}`;
              if (acceptedResource.version && acceptedResource.version !== observedVersion) {
                throw new SessionAdmissionError('CONFLICT', '目标目录版本已变化。');
              }
              acceptedResource = { ...resource, version: observedVersion };
              await scope.authorize();
            };
            return ledger.run({ callerKey, businessKey: c.args.businessKey, operation: 'createRecord', intent: c.args },
              async ({ sessionId }) => {
                await validateDirectory();
                const opened = await createSessionRecord({ id: sessionId, validateResources: validateDirectory, body: {
                  title: c.args.title, workingDir: resource.locator, workspaceKind: 'project',
                  ...(c.args.model ? { model: c.args.model } : {}), providerId: c.args.providerId,
                  ...(c.args.agentKind ? { agentKind: c.args.agentKind === 'claude-code' ? 'cc' : c.args.agentKind } : {}),
                } });
                emitSessionCreated(opened.row.id);
                const row = opened.row;
                return { target: { deviceId: request.deviceId, sessionId: row.id }, phase: 'accepted', resource: acceptedResource,
                  acceptedConfig: { agentKind: row.agentKind, model: row.model, providerId: row.providerId,
                    effort: row.effort, fastMode: row.fastMode, permissionMode: row.permissionMode, workingDir: row.workingDir, remoteHostId: row.remoteHostId } };
              }, async ({ sessionId }) => await getSessionRowSnapshotStrict(sessionId)
                ? { target: { deviceId: request.deviceId, sessionId }, phase: 'accepted', resource } : undefined);
          }
          case 'send': case 'enqueue': return ledger.run<unknown>({ callerKey, businessKey: c.args.businessKey, operation: 'send', targetSessionId: id, intent: c.args },
            async ({ inputId }) => {
              await scope.authorize();
              let files: Awaited<ReturnType<typeof resolveSessionInputFiles>> | undefined;
              const validateResources = async () => {
                if (!c.args.files?.length) return;
                const row = await getSessionRowSnapshotStrict(id);
                if (!row) throw new SessionAdmissionError('NOT_FOUND', '任务不存在。');
                files = await resolveSessionInputFiles(files?.map(file => file.sessionResource!) ?? c.args.files,
                  { deviceId: request.deviceId, remoteHostId: row.remoteHostId ?? null });
                await scope.authorize();
              };
              await validateResources();
              const result = await runtimeService().sendToSession({ targetSessionId: id, message: c.args.message, clientId: inputId!,
                origin: { kind: 'session', senderSessionId: callerKey, displayText: c.args.message }, forceQueue: true,
                files, validateResources,
                autoReviewUserText: { kind: 'delegated-continuation' } });
              if (result.ok) await awaitAgentInputQueueSnapshotPersistence(id);
              return { result, inputId, phase: result.ok ? 'queued' : 'rejected', resources: files?.map(file => file.sessionResource) };
            }, async ({ inputId }) => {
              const [receipt] = await readInputDeliveryReceipts(id, [inputId!]);
              return receipt && receipt.state !== 'unknown' ? { inputId, phase: receipt.state } : undefined;
            });
        }
      },
    }),
  });
  return controller.invoke(controller.issueCaller(requireSessionCaller()), 'command');
}
