import { throwIpcError } from "@cindy/remote-agent/ipcValidate";
import {
  isAutomaticInputOriginKind,
  type AgentInputQueuedMessage,
  type AgentInputClearBoundaryOpts,
} from "@cindy/maker-shared/agent-input-queue";
import { stampMobileClientOrigin } from "@cindy/im-runtime/mobileClientPromptNote";
import {
  stampTrustedDesktopQueuedOrigin,
  stampTrustedDeviceLinkQueuedOrigin,
} from "./makerSendTransaction.js";
import {
  stampTurnUiLanguage,
  readClaimedUiLanguage,
} from "./uiLanguageErrorNote.js";
import { createMakerInputValidation } from "./makerInputValidation.js";
import type { createMakerInputBoundary } from "./makerInputBoundary.js";
import type { createAttachmentNormalizer } from "./normalizeAttachments.js";
import type { createAgentInputReferenceHydrator } from "./agentInputReferences.js";
import type { createQueuedAttachmentLifecycle } from "./queuedAttachmentLifecycle.js";
import type { MakerInputControlsHost } from "./makerInputControls.js";
import type { AgentInputCoordinator } from "./agent-input-coordinator.js";
import type { AsyncLocalStorage } from "node:async_hooks";
import { bindTaskActionInput, taskActionInputGuard } from './taskActionAuthorization.js';

/** Authenticated owner edits renew the body grant; guest edits retain it. */
export function createQueuedEditProvenance<Owner>(host: {
  isSharedTaskInvoke(): boolean;
  captureOwner(): Owner;
  isOwnerCurrent(owner: Owner): boolean;
  inputCoordinator: Pick<AgentInputCoordinator, 'getGeneration' | 'isGenerationCurrent'>;
}) {
  return (sessionId: string, updated: AgentInputQueuedMessage, remote: boolean,
    editor: { isMobile: boolean; sourceDevice?: AgentInputQueuedMessage['sourceDevice'] },
  ): AgentInputQueuedMessage => {
    // Attribution cannot turn a guest or tool edit into owner consent.
    if (!host.isSharedTaskInvoke() && taskActionInputGuard(sessionId, updated)) {
      const owner = host.captureOwner();
      const generation = host.inputCoordinator.getGeneration(sessionId);
      bindTaskActionInput(sessionId, updated, async () => {
        if (!host.isOwnerCurrent(owner)
          || !host.inputCoordinator.isGenerationCurrent(sessionId, generation))
          throw new Error('TASK_ACTION_AUTHORIZATION_EXPIRED');
      });
    }
    return stampTrustedDeviceLinkQueuedOrigin(
      stampTrustedDesktopQueuedOrigin(stampMobileClientOrigin(updated, editor.isMobile), remote, true),
      remote,
      editor.sourceDevice,
    );
  };
}

export interface MakerInputSubmissionHost<Event, Context>
  extends
    Pick<
      MakerInputControlsHost<Event, Context>,
      | "ipcMain"
      | "isDeviceLinkInvoke"
      | "assertTrustedAppRendererEvent"
      | "awaitAgentInputQueueSnapshotPersistence"
      | "readQueuedEditorProvenance"
      | "stampQueuedEditProvenance"
    >,
    Pick<
      ReturnType<typeof createMakerInputBoundary>,
      | "assertRemoteInputClearNotInFlight"
      | "readRemoteInputClearBoundaryPrecondition"
      | "observeLocalInputClearBoundary"
      | "getInputSessionRow"
      | "assertExpectedRemoteInputClearBoundary"
      | "remoteInputClientIdWasPersisted"
      | "assertRemoteInputControlBoundary"
    >,
    Pick<
      ReturnType<typeof createQueuedAttachmentLifecycle>,
      | "registerQueuedAttachmentOwnership"
      | "queuedAttachmentOwnership"
      | "discardSpecificQueuedAttachmentOwnership"
      | "discardQueuedAttachmentOwnership"
      | "markQueuedAttachmentDurableAfterSnapshot"
    >,
    Pick<
      ReturnType<typeof createAttachmentNormalizer>,
      "materializeQueuedOssAttachmentsDeferred" | "collectQueuedAttachmentRefs"
    >,
    ReturnType<typeof createAgentInputReferenceHydrator> {
  inputCoordinator: Pick<
    AgentInputCoordinator<Context>,
    | "getGeneration"
    | "isGenerationCurrent"
    | "observeClearBoundary"
    | "ensureQueueRestored"
    | "getProjection"
    | "hasKnownClientId"
    | "enqueue"
    | "steer"
    | "hasPendingQueueItem"
    | "updateContentWithResult"
  >;
  assertReviewExternalInputAllowed(id: string): Promise<void>;
  getCurrentDbClientSnapshot(): object | null;
  withSessionPermissionChange<T>(
    id: string,
    work: () => Promise<T>,
  ): Promise<T>;
  prepareSharedTaskInput(
    id: string,
    item: AgentInputQueuedMessage,
  ): Promise<AgentInputQueuedMessage>;
  beginRemoteSendTrace?(
    id: string,
    clientId: string,
  ): {
    stage(name: string): void;
    finish(name: string): void;
    accepted(): void;
  };
  getMakerIfReady():
    | {
        getSession(id: string): { isTurnRunning(): boolean } | null | undefined;
      }
    | null
    | undefined;
  isMobileControllerInvoke(): boolean;
  readDeviceLinkInvokeSourceDevice(): AgentInputQueuedMessage["sourceDevice"];
  getResolvedMainLocale(): Parameters<
    typeof stampTurnUiLanguage
  >[1]["fallback"];
  prepareDeviceLinkAutoTitle(
    id: string,
    queued: AgentInputQueuedMessage,
  ): Promise<() => void>;
  hasInputDeliveryCancellation(id: string, clientId: string): boolean;
  trustedDesktopSteerText: AsyncLocalStorage<string>;
}
/** Original Desktop submission transactions, including attachment ownership and clear races. */
export function registerMakerInputSubmission<Event, Context>(
  host: MakerInputSubmissionHost<Event, Context>,
) {
  const {
    inputCoordinator,
    ipcMain,
    assertReviewExternalInputAllowed,
    isDeviceLinkInvoke,
    assertTrustedAppRendererEvent,
    getCurrentDbClientSnapshot,
    withSessionPermissionChange,
    prepareSharedTaskInput,
    beginRemoteSendTrace,
    awaitAgentInputQueueSnapshotPersistence,
    materializeQueuedOssAttachmentsDeferred,
    hydrateQueuedAgentReferences,
    getMakerIfReady,
    isMobileControllerInvoke,
    readDeviceLinkInvokeSourceDevice,
    getResolvedMainLocale,
    prepareDeviceLinkAutoTitle,
    hasInputDeliveryCancellation,
    trustedDesktopSteerText,
    collectQueuedAttachmentRefs,
    readQueuedEditorProvenance,
    stampQueuedEditProvenance,
    assertRemoteInputClearNotInFlight,
    readRemoteInputClearBoundaryPrecondition,
    observeLocalInputClearBoundary,
    getInputSessionRow,
    assertExpectedRemoteInputClearBoundary,
    remoteInputClientIdWasPersisted,
    assertRemoteInputControlBoundary,
    registerQueuedAttachmentOwnership,
    queuedAttachmentOwnership,
    discardSpecificQueuedAttachmentOwnership,
    discardQueuedAttachmentOwnership,
    markQueuedAttachmentDurableAfterSnapshot,
  } = host;
  const { requireSessionId, requireClientId, requireQueuedMessage } =
    createMakerInputValidation(isDeviceLinkInvoke);
  ipcMain.handle(
    "maker:input:enqueue",
    async (event, sessionId: unknown, item: unknown, opts?: unknown) => {
      const sid = requireSessionId(sessionId);
      await assertReviewExternalInputAllowed(sid);
      const deviceLinkInvoke = isDeviceLinkInvoke();
      if (!deviceLinkInvoke) assertTrustedAppRendererEvent(event);
      const inputOwner = getCurrentDbClientSnapshot();
      await withSessionPermissionChange(sid, async () => undefined);
      if (!inputOwner || inputOwner !== getCurrentDbClientSnapshot())
        throwIpcError("PRECONDITION_FAILED", "Account changed before input");
      const parsed = await prepareSharedTaskInput(
        sid,
        requireQueuedMessage(item),
      );
      // debug 日志：远程发送在被控端各阶段的耗时，不影响任何判定。
      const sendTrace = deviceLinkInvoke
        ? beginRemoteSendTrace?.(sid, parsed.clientId)
        : undefined;
      if (parsed.durableDelivery)
        await awaitAgentInputQueueSnapshotPersistence(sid);
      assertRemoteInputClearNotInFlight(sid, deviceLinkInvoke);
      const clearBoundaryPrecondition =
        readRemoteInputClearBoundaryPrecondition(opts);
      if (!deviceLinkInvoke) await observeLocalInputClearBoundary(sid);
      const inputGeneration = inputCoordinator.getGeneration(sid);
      const isCurrentInputGeneration = () =>
        inputCoordinator.isGenerationCurrent(sid, inputGeneration);
      const assertCurrentInputGeneration = () => {
        if (isCurrentInputGeneration()) return;
        throwIpcError(
          "PRECONDITION_FAILED",
          "REMOTE_OPTIMISTIC_INPUT_SUPERSEDED: input preparation was superseded",
        );
      };
      // 已删除的远控任务必须在恢复队列、附件下载、引用水合和自动起名预检之前终止。
      // 入队前仍会再读一次，覆盖准备期间发生的删除竞态。
      let inputSessionRow = deviceLinkInvoke
        ? await getInputSessionRow(sid)
        : undefined;
      if (deviceLinkInvoke) {
        inputCoordinator.observeClearBoundary(sid, inputSessionRow?.clearedAt);
        assertRemoteInputClearNotInFlight(sid, true);
        assertExpectedRemoteInputClearBoundary(
          sid,
          clearBoundaryPrecondition,
          inputSessionRow,
        );
      }
      assertCurrentInputGeneration();
      sendTrace?.stage("gate");
      // 恢复先于入队:普通新输入保持 FIFO；「继续任务」由 coordinator 在完整旧队列
      // 恢复后再明确插到队首，避免恢复竞态把它重新压到后面。
      const restoreQueue = inputCoordinator.ensureQueueRestored(sid);
      if (deviceLinkInvoke) {
        await restoreQueue.catch(() => {
          throwIpcError(
            "INTERNAL",
            "REMOTE_OPTIMISTIC_SESSION_STATE_UNAVAILABLE: input queue state unavailable",
          );
        });
        assertRemoteInputClearNotInFlight(sid, true);
        if (await remoteInputClientIdWasPersisted(sid, parsed.clientId)) {
          inputSessionRow = await getInputSessionRow(sid);
          inputCoordinator.observeClearBoundary(sid, inputSessionRow.clearedAt);
          assertExpectedRemoteInputClearBoundary(
            sid,
            clearBoundaryPrecondition,
            inputSessionRow,
          );
          sendTrace?.finish("already-persisted");
          return inputCoordinator.getProjection(sid);
        }
      } else {
        await restoreQueue.catch(() => undefined);
      }
      assertCurrentInputGeneration();
      sendTrace?.stage("restore");
      // A concurrent weak-link resend may already own this clientId in the
      // coordinator. Return the current projection before materialising a new
      // copy of its attachments.
      if (inputCoordinator.hasKnownClientId(sid, parsed.clientId)) {
        if (parsed.durableDelivery)
          await awaitAgentInputQueueSnapshotPersistence(sid);
        sendTrace?.finish("known");
        return inputCoordinator.getProjection(sid);
      }
      const materialized = await materializeQueuedOssAttachmentsDeferred(
        sid,
        parsed,
      );
      const attachmentOwnerId = registerQueuedAttachmentOwnership(
        sid,
        parsed.clientId,
        materialized.cleanupLocalMaterialization,
        {
          cleanupAfterDurable: materialized.cleanupAfterAcceptance,
          parts: materialized.materializedParts,
        },
      );
      let acceptedByCoordinator = false;
      try {
        const queuedWithAttachments =
          materialized.item as AgentInputQueuedMessage;
        assertCurrentInputGeneration();
        // 手机来源在**入队这一刻**盖章:drain 派发时已脱离本 invoke 的 async context。
        // 无条件覆盖 —— item 来自 wire,客户端自填的 fromMobileClient 一律不生效。
        const queued = stampTurnUiLanguage(
          stampTrustedDeviceLinkQueuedOrigin(
            stampTrustedDesktopQueuedOrigin(
              stampMobileClientOrigin(
                await hydrateQueuedAgentReferences(queuedWithAttachments, {
                  isSessionTurnRunning: (targetSessionId) =>
                    getMakerIfReady()
                      ?.getSession(targetSessionId)
                      ?.isTurnRunning() ?? false,
                }),
                isMobileControllerInvoke(),
              ),
              deviceLinkInvoke,
            ),
            deviceLinkInvoke,
            readDeviceLinkInvokeSourceDevice(),
          ),
          {
            remote: deviceLinkInvoke,
            claimed: readClaimedUiLanguage(item),
            fallback: getResolvedMainLocale(),
          },
        );
        assertCurrentInputGeneration();
        sendTrace?.stage("prepare");
        const commitAutoTitle = await prepareDeviceLinkAutoTitle(sid, queued);
        assertCurrentInputGeneration();
        if (deviceLinkInvoke) {
          assertRemoteInputClearNotInFlight(sid, true);
          inputSessionRow = await getInputSessionRow(sid);
          inputCoordinator.observeClearBoundary(sid, inputSessionRow.clearedAt);
          assertExpectedRemoteInputClearBoundary(
            sid,
            clearBoundaryPrecondition,
            inputSessionRow,
          );
        }
        assertCurrentInputGeneration();
        assertRemoteInputClearNotInFlight(sid, deviceLinkInvoke);
        sendTrace?.stage("recheck");

        if (parsed.durableDelivery) {
          await awaitAgentInputQueueSnapshotPersistence(sid);
          const persisted = await remoteInputClientIdWasPersisted(
            sid,
            parsed.clientId,
          );
          assertCurrentInputGeneration();
          assertRemoteInputClearNotInFlight(sid, deviceLinkInvoke);
          if (persisted || hasInputDeliveryCancellation(sid, parsed.clientId)) {
            await materialized.cleanupBeforeAcceptance?.();
            if (attachmentOwnerId)
              await discardSpecificQueuedAttachmentOwnership(
                sid,
                parsed.clientId,
                attachmentOwnerId,
              );
            await awaitAgentInputQueueSnapshotPersistence(sid);
            sendTrace?.finish(persisted ? "already-persisted" : "cancelled");
            return inputCoordinator.getProjection(sid);
          }
          sendTrace?.stage("dedupe");
        }

        // 「继续任务」durable ack 延后到 vendor dispatch 成功（onDispatchedUserTurn）：
        // 排队可取消时旧中断提示必须能恢复；accepted 但仍可能 cancelled-before-dispatch
        // 时也不能提前 ack。续跑项本身由 coordinator 插到队首（普通输入仍 FIFO）。
        let duplicate = false;
        const projection = inputCoordinator.enqueue(sid, queued, {
          ...(opts && typeof opts === "object"
            ? (opts as { sendAtMs?: number })
            : undefined),
          // 本机与远控用户显式输入可放行崩溃恢复暂停，避免「继续任务」再次排进暂停队列。
          // 远端 Orca 派活也经此 IPC。来源盖章会剥掉 wire 的 origin，因此从规范化远控载荷
          // 读取自动投递意图，只用于收紧恢复暂停，不授予来源身份或权限；本机仍按显式输入处理。
          resumeRestorePausedQueue: !(
            deviceLinkInvoke && isAutomaticInputOriginKind(parsed.origin?.kind)
          ),
          onDuplicate: () => {
            duplicate = true;
          },
        });
        if (duplicate) {
          if (attachmentOwnerId) {
            await materialized.cleanupBeforeAcceptance?.();
            await discardSpecificQueuedAttachmentOwnership(
              sid,
              parsed.clientId,
              attachmentOwnerId,
            );
          }
          if (parsed.durableDelivery)
            await awaitAgentInputQueueSnapshotPersistence(sid);
          sendTrace?.finish("duplicate");
          return projection;
        }
        acceptedByCoordinator = true;
        sendTrace?.stage("coordinator");
        sendTrace?.accepted();
        if (attachmentOwnerId) {
          queuedAttachmentOwnership.activateCurrentOwner(
            sid,
            parsed.clientId,
            attachmentOwnerId,
          );
        }
        markQueuedAttachmentDurableAfterSnapshot(
          sid,
          parsed.clientId,
          attachmentOwnerId,
        );
        commitAutoTitle();
        if (parsed.durableDelivery)
          await awaitAgentInputQueueSnapshotPersistence(sid);
        sendTrace?.stage("snapshot");
        sendTrace?.finish("accepted");
        return projection;
      } catch (err) {
        if (!acceptedByCoordinator) {
          await materialized.cleanupBeforeAcceptance?.();
          if (attachmentOwnerId) {
            await discardSpecificQueuedAttachmentOwnership(
              sid,
              parsed.clientId,
              attachmentOwnerId,
            );
          }
        } else
          markQueuedAttachmentDurableAfterSnapshot(
            sid,
            parsed.clientId,
            attachmentOwnerId,
          );
        throw err;
      }
    },
  );

  ipcMain.handle(
    "maker:input:steer",
    async (event, sessionId: unknown, item: unknown, opts?: unknown) => {
      const sid = requireSessionId(sessionId);
      await assertReviewExternalInputAllowed(sid);
      const deviceLinkInvoke = isDeviceLinkInvoke();
      if (!deviceLinkInvoke) assertTrustedAppRendererEvent(event);
      const steerOpts =
        opts && typeof opts === "object"
          ? (opts as {
              removeFromQueue?: boolean;
              touchUserSend?: boolean;
            } & AgentInputClearBoundaryOpts)
          : undefined;
      const parsed = await prepareSharedTaskInput(
        sid,
        requireQueuedMessage(item, {
          // A device-link projection intentionally omits the trusted snapshot;
          // Only the explicit remove-from-queue steer path may reattach it from
          // the main-owned row; all other IPC paths remain fail-closed here.
          allowMissingTrustedContexts:
            deviceLinkInvoke && steerOpts?.removeFromQueue === true,
        }),
      );
      assertRemoteInputClearNotInFlight(sid, deviceLinkInvoke);
      const clearBoundaryPrecondition =
        readRemoteInputClearBoundaryPrecondition(opts);
      if (!deviceLinkInvoke) await observeLocalInputClearBoundary(sid);
      const inputGeneration = inputCoordinator.getGeneration(sid);
      const isCurrentInputGeneration = () =>
        inputCoordinator.isGenerationCurrent(sid, inputGeneration);
      const assertCurrentInputGeneration = () => {
        if (isCurrentInputGeneration()) return;
        throwIpcError(
          "PRECONDITION_FAILED",
          "REMOTE_OPTIMISTIC_INPUT_SUPERSEDED: input preparation was superseded",
        );
      };
      // 与 enqueue 对称：先挡掉已经终态的远控任务，避免为必然失败的 steer
      // 恢复队列、下载附件或水合引用；真正 steer 前仍复核一次覆盖中途删除。
      let inputSessionRow = deviceLinkInvoke
        ? await getInputSessionRow(sid)
        : undefined;
      if (deviceLinkInvoke) {
        inputCoordinator.observeClearBoundary(sid, inputSessionRow?.clearedAt);
        assertRemoteInputClearNotInFlight(sid, true);
        assertExpectedRemoteInputClearBoundary(
          sid,
          clearBoundaryPrecondition,
          inputSessionRow,
        );
      }
      assertCurrentInputGeneration();
      const restoreQueue = inputCoordinator.ensureQueueRestored(sid);
      if (deviceLinkInvoke) {
        await restoreQueue.catch(() => {
          throwIpcError(
            "INTERNAL",
            "REMOTE_OPTIMISTIC_SESSION_STATE_UNAVAILABLE: input queue state unavailable",
          );
        });
      } else {
        await restoreQueue.catch(() => undefined);
      }
      assertCurrentInputGeneration();
      const isKnownSteerDuplicate = (): boolean => {
        const projection = inputCoordinator.getProjection(sid);
        const steeringStoredQueueItem =
          steerOpts?.removeFromQueue === true &&
          projection.pendingQueue.some(
            (queued) => queued.clientId === parsed.clientId,
          );
        return (
          projection.steeringQueueClientIds.includes(parsed.clientId) ||
          (!steeringStoredQueueItem &&
            inputCoordinator.hasKnownClientId(sid, parsed.clientId))
        );
      };
      if (isKnownSteerDuplicate()) {
        // Only a still-present main-owned queue row may pass through the
        // remove-from-queue path. An in-flight promotion or any other known
        // clientId is a resend and must stop before attachment materialisation.
        return true;
      }
      if (
        deviceLinkInvoke &&
        (await remoteInputClientIdWasPersisted(sid, parsed.clientId))
      ) {
        // In-memory markers and the accepted-clientId window do not survive a
        // host restart, so the durable user row is the final idempotency boundary
        // for every remote steer variant, including a stale queue projection.
        inputSessionRow = await getInputSessionRow(sid);
        inputCoordinator.observeClearBoundary(sid, inputSessionRow.clearedAt);
        assertCurrentInputGeneration();
        assertRemoteInputClearNotInFlight(sid, true);
        assertExpectedRemoteInputClearBoundary(
          sid,
          clearBoundaryPrecondition,
          inputSessionRow,
        );
        return true;
      }
      // The durable lookup above is an await boundary. Recheck coordinator
      // ownership before materialising so a concurrent first delivery cannot
      // make this retry create an unnecessary second local copy.
      if (isKnownSteerDuplicate()) return true;
      const steeringStoredQueueItem =
        steerOpts?.removeFromQueue === true &&
        inputCoordinator.hasPendingQueueItem(sid, parsed.clientId);
      // INPUT_STEER with removeFromQueue lets the coordinator replace the
      // projected row with its main-owned item.  Do not materialise the
      // controller's copy first: it would register a second attachment owner
      // for a row whose local files already exist on the host.
      const materialized = steeringStoredQueueItem
        ? {
            item: parsed,
            cleanupAfterAcceptance: undefined,
            cleanupBeforeAcceptance: undefined,
            cleanupLocalMaterialization: undefined,
            materializedParts: undefined,
          }
        : await materializeQueuedOssAttachmentsDeferred(sid, parsed);
      const attachmentOwnerId = steeringStoredQueueItem
        ? null
        : registerQueuedAttachmentOwnership(
            sid,
            parsed.clientId,
            materialized.cleanupLocalMaterialization,
            {
              cleanupAfterDurable: materialized.cleanupAfterAcceptance,
              parts: materialized.materializedParts,
            },
          );
      let acceptedByCoordinator = false;
      let previousAttachmentOwnerId: string | null = null;
      const coordinatorRetainsClientId = (clientId: string): boolean => {
        const projection = inputCoordinator.getProjection(sid);
        return (
          projection.pendingQueue.some((item) => item.clientId === clientId) ||
          projection.steeringQueueClientIds.includes(clientId) ||
          (projection.recovery?.kind === "queue-head" &&
            projection.recovery.clientId === clientId) ||
          (projection.recovery?.kind === "active-turn" &&
            projection.recovery.item.clientId === clientId)
        );
      };
      try {
        const queuedWithAttachments =
          materialized.item as AgentInputQueuedMessage;
        assertCurrentInputGeneration();
        // 与 enqueue 同:steer 投递也在本 invoke 的 async context 之外发生。
        const queued = stampTurnUiLanguage(
          stampTrustedDeviceLinkQueuedOrigin(
            stampTrustedDesktopQueuedOrigin(
              stampMobileClientOrigin(
                await hydrateQueuedAgentReferences(queuedWithAttachments, {
                  isSessionTurnRunning: (targetSessionId) =>
                    getMakerIfReady()
                      ?.getSession(targetSessionId)
                      ?.isTurnRunning() ?? false,
                }),
                isMobileControllerInvoke(),
              ),
              deviceLinkInvoke,
            ),
            deviceLinkInvoke,
            readDeviceLinkInvokeSourceDevice(),
          ),
          {
            remote: deviceLinkInvoke,
            claimed: readClaimedUiLanguage(item),
            fallback: getResolvedMainLocale(),
          },
        );
        assertCurrentInputGeneration();
        // 插话也补起名:远控用户完全可能趁这一轮还在跑就写下第一句话,只认入队的话
        // 标题会一直停在首条纯附件消息的合成占位上(PR #510 review P1)。是否真的该
        // 改名由 runSessionAutoTitle 权威判定。
        const commitAutoTitle = await prepareDeviceLinkAutoTitle(sid, queued);
        assertCurrentInputGeneration();
        if (deviceLinkInvoke) {
          assertRemoteInputClearNotInFlight(sid, true);
          inputSessionRow = await getInputSessionRow(sid);
          inputCoordinator.observeClearBoundary(sid, inputSessionRow.clearedAt);
          assertExpectedRemoteInputClearBoundary(
            sid,
            clearBoundaryPrecondition,
            inputSessionRow,
          );
        }
        assertCurrentInputGeneration();
        assertRemoteInputClearNotInFlight(sid, deviceLinkInvoke);
        // Attachment hydration, auto-title preparation and the final session
        // lookup all yield. Close the last race before activating ownership:
        // coordinator.steer sets its marker synchronously, so after this check
        // only one request can become the current owner for this clientId.
        if (isKnownSteerDuplicate()) {
          await materialized.cleanupBeforeAcceptance?.();
          if (attachmentOwnerId) {
            await discardSpecificQueuedAttachmentOwnership(
              sid,
              parsed.clientId,
              attachmentOwnerId,
            );
          }
          return true;
        }
        // steer 与 enqueue 不同:它会因同会话已有在飞 steer / Stop 边界 / 输入锁而
        // 返回 false。必须等它落定、受理了才改名 —— 被拒的文本改掉默认名 / 合成占位 /
        // fork 占位就是凭空改名(review P1)。
        if (attachmentOwnerId) {
          previousAttachmentOwnerId =
            queuedAttachmentOwnership.activateCurrentOwner(
              sid,
              parsed.clientId,
              attachmentOwnerId,
            );
        }
        const runSteer = () => inputCoordinator.steer(sid, queued, steerOpts);
        const accepted = await (deviceLinkInvoke
          ? runSteer()
          : trustedDesktopSteerText.run(queued.text, runSteer));
        acceptedByCoordinator = accepted;
        assertCurrentInputGeneration();
        if (accepted) {
          markQueuedAttachmentDurableAfterSnapshot(
            sid,
            parsed.clientId,
            attachmentOwnerId,
          );
          commitAutoTitle();
        } else {
          const retained = coordinatorRetainsClientId(queued.clientId);
          if (retained) {
            markQueuedAttachmentDurableAfterSnapshot(
              sid,
              parsed.clientId,
              attachmentOwnerId,
            );
          } else {
            if (attachmentOwnerId) {
              queuedAttachmentOwnership.restoreCurrentOwner(
                sid,
                parsed.clientId,
                previousAttachmentOwnerId,
              );
            }
            await materialized.cleanupBeforeAcceptance?.();
            if (attachmentOwnerId) {
              await discardSpecificQueuedAttachmentOwnership(
                sid,
                parsed.clientId,
                attachmentOwnerId,
              );
            }
          }
        }
        return accepted;
      } catch (err) {
        if (
          acceptedByCoordinator ||
          coordinatorRetainsClientId(parsed.clientId)
        ) {
          markQueuedAttachmentDurableAfterSnapshot(
            sid,
            parsed.clientId,
            attachmentOwnerId,
          );
        } else {
          if (attachmentOwnerId) {
            queuedAttachmentOwnership.restoreCurrentOwner(
              sid,
              parsed.clientId,
              previousAttachmentOwnerId,
            );
          }
          await materialized.cleanupBeforeAcceptance?.();
          if (attachmentOwnerId) {
            await discardSpecificQueuedAttachmentOwnership(
              sid,
              parsed.clientId,
              attachmentOwnerId,
            );
          }
        }
        throw err;
      }
    },
  );

  ipcMain.handle(
    "maker:input:update-content",
    async (
      event,
      sessionId: unknown,
      clientId: unknown,
      item: unknown,
      opts?: unknown,
    ) => {
      const sid = requireSessionId(sessionId);
      const cid = requireClientId(clientId);
      const remote = isDeviceLinkInvoke();
      if (!remote) assertTrustedAppRendererEvent(event);
      const clearBoundaryPrecondition =
        readRemoteInputClearBoundaryPrecondition(opts);
      await assertRemoteInputControlBoundary(sid, remote, opts);
      const inputGeneration = inputCoordinator.getGeneration(sid);
      const isCurrentInputGeneration = () =>
        inputCoordinator.isGenerationCurrent(sid, inputGeneration);
      const assertCurrentInputGeneration = () => {
        if (isCurrentInputGeneration()) return;
        throwIpcError(
          "PRECONDITION_FAILED",
          "REMOTE_OPTIMISTIC_INPUT_SUPERSEDED: input preparation was superseded",
        );
      };
      // 与 enqueue/steer 对称:附件物化和引用水合都会跨 await。clear 期间启动的
      // 编辑必须只返回新投影,不能把旧 clientId 的内容写进清空后的队列。
      if (remote) {
        const row = await getInputSessionRow(sid);
        inputCoordinator.observeClearBoundary(sid, row.clearedAt);
        assertRemoteInputClearNotInFlight(sid, true);
        assertExpectedRemoteInputClearBoundary(
          sid,
          clearBoundaryPrecondition,
          row,
        );
      }
      if (!isCurrentInputGeneration())
        return inputCoordinator.getProjection(sid);
      const parsed = requireQueuedMessage(item);
      if (parsed.clientId !== cid) {
        throwIpcError("INVALID_PARAMS", "queued.clientId must match clientId");
      }
      // Do not download/materialise an edit for a row that has already left the
      // pending queue.  The row can disappear while the async preparation is in
      // flight as well; updateContentWithResult below handles that second race.
      if (!inputCoordinator.hasPendingQueueItem(sid, cid)) {
        return inputCoordinator.getProjection(sid);
      }
      const materialized = await materializeQueuedOssAttachmentsDeferred(
        sid,
        parsed,
      );
      const attachmentOwnerId = registerQueuedAttachmentOwnership(
        sid,
        cid,
        materialized.cleanupLocalMaterialization,
        {
          cleanupAfterDurable: materialized.cleanupAfterAcceptance,
          parts: materialized.materializedParts,
        },
      );
      let acceptedByCoordinator = false;
      try {
        const queuedWithAttachments =
          materialized.item as AgentInputQueuedMessage;
        assertCurrentInputGeneration();
        const queued = stampTurnUiLanguage(
          await hydrateQueuedAgentReferences(queuedWithAttachments, {
            isSessionTurnRunning: (targetSessionId) =>
              getMakerIfReady()?.getSession(targetSessionId)?.isTurnRunning() ??
              false,
          }),
          {
            remote,
            claimed: readClaimedUiLanguage(item),
            fallback: getResolvedMainLocale(),
          },
        );
        assertCurrentInputGeneration();
        // 旧 device-link update-content 调用没有 side-channel sessionRefs；显式
        // 传空数组，避免 updateQueuedMessageContent 从完整文本重新解析控制端坐标。
        const update =
          remote && parsed.sessionRefs === undefined
            ? { ...queued, sessionRefs: [] }
            : queued;
        if (remote) {
          const row = await getInputSessionRow(sid);
          inputCoordinator.observeClearBoundary(sid, row.clearedAt);
          assertRemoteInputClearNotInFlight(sid, true);
          assertExpectedRemoteInputClearBoundary(
            sid,
            clearBoundaryPrecondition,
            row,
          );
        }
        assertCurrentInputGeneration();
        const editor = readQueuedEditorProvenance();
        const result = inputCoordinator.updateContentWithResult(
          sid,
          cid,
          update,
          (updated) => stampQueuedEditProvenance(sid, updated, remote, editor),
        );
        acceptedByCoordinator = result.updated;
        if (result.updated) {
          // The replacement supersedes older local materialisations owned by
          // this clientId, except media it still carries: an edit that keeps an
          // attachment creates no new copy, so the existing owner must survive
          // or the queued item would point at a deleted blob. Release only the
          // owners whose media the edit dropped.
          const replacementRefs = collectQueuedAttachmentRefs(update);
          const survivingOwnerId =
            queuedAttachmentOwnership.retainReferencedOwners(
              sid,
              cid,
              attachmentOwnerId,
              (ref) => replacementRefs.has(ref),
            );
          if (survivingOwnerId) {
            queuedAttachmentOwnership.activateCurrentOwner(
              sid,
              cid,
              survivingOwnerId,
            );
          } else {
            // The replacement carries none of the owned media; nothing stays current.
            queuedAttachmentOwnership.restoreCurrentOwner(sid, cid, null);
          }
          discardQueuedAttachmentOwnership(sid, cid, {
            keepCurrentOwner: true,
          });
          markQueuedAttachmentDurableAfterSnapshot(sid, cid, survivingOwnerId);
        } else {
          await materialized.cleanupBeforeAcceptance?.();
          if (attachmentOwnerId) {
            await discardSpecificQueuedAttachmentOwnership(
              sid,
              cid,
              attachmentOwnerId,
            );
          }
        }
        return result.projection;
      } catch (err) {
        if (!acceptedByCoordinator)
          await materialized.cleanupBeforeAcceptance?.();
        else
          markQueuedAttachmentDurableAfterSnapshot(sid, cid, attachmentOwnerId);
        if (attachmentOwnerId && !acceptedByCoordinator) {
          await discardSpecificQueuedAttachmentOwnership(
            sid,
            cid,
            attachmentOwnerId,
          );
        }
        throw err;
      }
    },
  );
}
