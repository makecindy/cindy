import { throwIpcError } from "@cindy/remote-agent/ipcValidate";
import type {
  AgentInputCreateOpts,
  AgentInputQueuedMessage,
} from "@cindy/maker-shared/agent-input-queue";
import type { createAgentInputQueueStore } from "@cindy/runtime-db/agentInputQueueSnapshots";
import type {
  createMakerInputBoundary,
  MakerInputBoundaryHost,
} from "./makerInputBoundary.js";
import type { AgentInputCoordinator } from "./agent-input-coordinator.js";
import { createMakerInputValidation } from "./makerInputValidation.js";
type QueueStore = ReturnType<typeof createAgentInputQueueStore>;
export interface MakerInputControlsHost<Event, Context>
  extends
    Pick<
      ReturnType<typeof createMakerInputBoundary>,
      | "getInputSessionRow"
      | "retryPendingInputClearBoundary"
      | "assertRemoteInputClearNotInFlight"
      | "assertRemoteInputControlBoundary"
      | "observeLocalInputClearBoundary"
    >,
    Pick<MakerInputBoundaryHost, "getSessionRowSnapshot">,
    Pick<
      QueueStore,
      "readInputDeliveryReceipts" | "saveCancelledInputDelivery"
    > {
  ipcMain: {
    handle(
      channel: string,
      handler: (event: Event, ...args: any[]) => unknown,
    ): void;
  };
  inputCoordinator: Pick<
    AgentInputCoordinator<Context>,
    | "observeClearBoundary"
    | "ensureQueueRestored"
    | "getProjection"
    | "compact"
    | "resume"
    | "retryLastError"
    | "clearError"
    | "hasKnownClientId"
    | "remove"
    | "hasPendingQueuedWork"
    | "updateText"
    | "move"
    | "setExpanded"
    | "setInteractionLock"
    | "setEditLock"
  >;
  isDeviceLinkInvoke(): boolean;
  assertTrustedAppRendererEvent(event: Event): void;
  readInputDeliveryClientIds(options: unknown): string[] | undefined;
  awaitAgentInputQueueSnapshotPersistence(id: string): Promise<void>;
  getAgentIslandService():
    { notifyQueueEmptied(id: string): void } | null | undefined;
  readQueuedEditorProvenance(): {
    sourceDevice: AgentInputQueuedMessage["sourceDevice"];
    isMobile: boolean;
  };
  stampQueuedEditProvenance(
    id: string,
    item: AgentInputQueuedMessage,
    remote: boolean,
    editor: ReturnType<
      MakerInputControlsHost<Event, Context>["readQueuedEditorProvenance"]
    >,
  ): AgentInputQueuedMessage;
}
/** Original GUI input controls, registered on either host's authenticated transport. */
export function registerMakerInputControls<Event, Context>(
  host: MakerInputControlsHost<Event, Context>,
) {
  const {
    ipcMain,
    isDeviceLinkInvoke,
    assertTrustedAppRendererEvent,
    getSessionRowSnapshot,
    readInputDeliveryClientIds,
    awaitAgentInputQueueSnapshotPersistence,
    readInputDeliveryReceipts,
    saveCancelledInputDelivery,
    getAgentIslandService,
    readQueuedEditorProvenance,
    stampQueuedEditProvenance,
    getInputSessionRow,
    retryPendingInputClearBoundary,
    assertRemoteInputClearNotInFlight,
    assertRemoteInputControlBoundary,
    observeLocalInputClearBoundary,
    inputCoordinator,
  } = host;
  const {
    requireSessionId,
    requireClientId,
    requireSessionRefs,
    requireTrustedReferenceContexts,
    requireQueuedMessage,
  } = createMakerInputValidation(isDeviceLinkInvoke);
  ipcMain.handle(
    "maker:input:get-projection",
    async (_e, sessionId: unknown, options?: unknown) => {
      const sid = requireSessionId(sessionId);
      const remote = isDeviceLinkInvoke();
      if (!remote) assertTrustedAppRendererEvent(_e);
      let deliveryClientIds: string[] | undefined;
      try {
        deliveryClientIds = readInputDeliveryClientIds(options);
      } catch {
        throwIpcError("INVALID_PARAMS", "Invalid deliveryClientIds");
      }
      assertRemoteInputClearNotInFlight(sid, remote);
      // The queue snapshot is process-local, but the clear boundary is durable.
      // Hydrate it for both renderer and device-link callers before restoring the
      // snapshot; otherwise a restarted controlled Desktop can resurrect items
      // that were cleared before the process restart. Remote callers keep the
      // strict session lookup, while the local renderer keeps the historical
      // fail-soft projection semantics when the DB is still booting.
      const sessionRow = remote
        ? await getInputSessionRow(sid)
        : await getSessionRowSnapshot(sid);
      const durableSessionRow = await retryPendingInputClearBoundary(
        sid,
        remote,
        sessionRow,
      );
      inputCoordinator.observeClearBoundary(sid, durableSessionRow?.clearedAt);
      // 崩溃恢复(issue #761):renderer 打开会话首次取 projection 前,先把持久化的
      // 排队输入读回内存态,返回值即含恢复后的队列,不依赖 push 补发。
      // 失败时仍返回当前内存态 projection(宁可漏恢复也不阻塞会话打开)。
      if (deliveryClientIds) await inputCoordinator.ensureQueueRestored(sid);
      else
        await inputCoordinator.ensureQueueRestored(sid).catch(() => undefined);
      assertRemoteInputClearNotInFlight(sid, remote);
      if (deliveryClientIds) await awaitAgentInputQueueSnapshotPersistence(sid);
      const deliveryReceipts = deliveryClientIds
        ? await readInputDeliveryReceipts(sid, deliveryClientIds)
        : undefined;
      assertRemoteInputClearNotInFlight(sid, remote);
      return {
        ...inputCoordinator.getProjection(sid),
        inputDeliveryVersion: 1,
        ...(deliveryReceipts ? { deliveryReceipts } : {}),
      };
    },
  );

  ipcMain.handle(
    "maker:input:compact",
    async (_e, sessionId: unknown, createOpts: unknown, opts?: unknown) => {
      const sid = requireSessionId(sessionId);
      const remote = isDeviceLinkInvoke();
      await assertRemoteInputControlBoundary(sid, remote, opts);
      if (!remote) await observeLocalInputClearBoundary(sid);
      await inputCoordinator.ensureQueueRestored(sid).catch(() => undefined);
      await assertRemoteInputControlBoundary(sid, remote, opts);
      if (!createOpts || typeof createOpts !== "object") {
        throwIpcError("INVALID_PARAMS", "createOpts required");
      }
      const typedCreateOpts = createOpts as AgentInputCreateOpts;
      if (typedCreateOpts.agentKind !== "claude-code") {
        throwIpcError(
          "INVALID_PARAMS",
          "compact only supports claude-code sessions",
        );
      }
      return inputCoordinator.compact(
        sid,
        typedCreateOpts,
        opts && typeof opts === "object"
          ? (opts as { userName?: string })
          : undefined,
      );
    },
  );

  ipcMain.handle(
    "maker:input:resume",
    async (_e, sessionId: unknown, opts?: unknown) => {
      const sid = requireSessionId(sessionId);
      await assertRemoteInputControlBoundary(sid, isDeviceLinkInvoke(), opts);
      return inputCoordinator.resume(sid);
    },
  );

  ipcMain.handle(
    "maker:input:retry-last-error",
    async (_e, sessionId: unknown, opts?: unknown) => {
      const sid = requireSessionId(sessionId);
      await assertRemoteInputControlBoundary(sid, isDeviceLinkInvoke(), opts);
      return inputCoordinator.retryLastError(sid);
    },
  );

  ipcMain.handle(
    "maker:input:clear-error",
    async (_e, sessionId: unknown, opts?: unknown) => {
      const sid = requireSessionId(sessionId);
      await assertRemoteInputControlBoundary(sid, isDeviceLinkInvoke(), opts);
      return inputCoordinator.clearError(sid);
    },
  );

  ipcMain.handle(
    "maker:input:remove",
    async (_e, sessionId: unknown, clientId: unknown, opts?: unknown) => {
      const sid = requireSessionId(sessionId);
      await assertRemoteInputControlBoundary(sid, isDeviceLinkInvoke(), opts);
      const cid = requireClientId(clientId);
      const durable =
        !!opts &&
        typeof opts === "object" &&
        (opts as { durableDelivery?: unknown }).durableDelivery === true;
      const before = inputCoordinator.getProjection(sid);
      if (
        durable &&
        (before.steeringQueueClientIds.includes(cid) ||
          (!before.pendingQueue.some((item) => item.clientId === cid) &&
            inputCoordinator.hasKnownClientId(sid, cid)))
      ) {
        // Once drain or steer owns the item, removal cannot cancel its in-flight persistence.
        // Never insert a tombstone in front of that user row.
        return { ...before, inputDeliveryCancelled: false };
      }
      // Register the intent and remove synchronously before drain can take a pending item.
      const cancellation = durable
        ? saveCancelledInputDelivery(sid, cid)
        : undefined;
      const result = inputCoordinator.remove(sid, cid);
      const inputDeliveryCancelled = await cancellation;
      await awaitAgentInputQueueSnapshotPersistence(sid);
      if (!inputCoordinator.hasPendingQueuedWork(sid)) {
        getAgentIslandService()?.notifyQueueEmptied(sid);
      }
      return durable
        ? { ...result, inputDeliveryCancelled: inputDeliveryCancelled === true }
        : result;
    },
  );

  ipcMain.handle(
    "maker:input:update-text",
    async (
      event,
      sessionId: unknown,
      clientId: unknown,
      newText: unknown,
      sessionRefs?: unknown,
      trustedContexts?: unknown,
      opts?: unknown,
    ) => {
      if (typeof newText !== "string")
        throwIpcError("INVALID_PARAMS", "newText required");
      const refs = requireSessionRefs(sessionRefs);
      const remote = isDeviceLinkInvoke();
      const sid = requireSessionId(sessionId);
      const cid = requireClientId(clientId);
      if (!remote) assertTrustedAppRendererEvent(event);
      await assertRemoteInputControlBoundary(sid, remote, opts);
      const contexts = remote
        ? requireTrustedReferenceContexts(refs, trustedContexts)
        : undefined;
      if (remote && (refs?.length ?? 0) > 0 && !contexts) {
        throwIpcError(
          "SESSION_REFERENCE_UNAVAILABLE",
          "remote session references were not resolved by the controller",
        );
      }
      const editor = readQueuedEditorProvenance();
      return inputCoordinator.updateText(
        sid,
        cid,
        newText,
        refs,
        contexts,
        remote,
        (updated) => stampQueuedEditProvenance(sid, updated, remote, editor),
      );
    },
  );

  ipcMain.handle(
    "maker:input:move",
    async (
      _e,
      sessionId: unknown,
      clientId: unknown,
      targetIndex: unknown,
      opts?: unknown,
    ) => {
      if (typeof targetIndex !== "number" || !Number.isFinite(targetIndex)) {
        throwIpcError("INVALID_PARAMS", "targetIndex required");
      }
      const sid = requireSessionId(sessionId);
      await assertRemoteInputControlBoundary(sid, isDeviceLinkInvoke(), opts);
      return inputCoordinator.move(sid, requireClientId(clientId), targetIndex);
    },
  );

  ipcMain.handle(
    "maker:input:set-expanded",
    async (_e, sessionId: unknown, expanded: unknown, opts?: unknown) => {
      const sid = requireSessionId(sessionId);
      await assertRemoteInputControlBoundary(sid, isDeviceLinkInvoke(), opts);
      return inputCoordinator.setExpanded(sid, expanded === true);
    },
  );

  ipcMain.handle(
    "maker:input:set-interaction-lock",
    async (
      _e,
      sessionId: unknown,
      lockId: unknown,
      locked: unknown,
      opts?: unknown,
    ) => {
      const sid = requireSessionId(sessionId);
      await assertRemoteInputControlBoundary(sid, isDeviceLinkInvoke(), opts);
      return inputCoordinator.setInteractionLock(
        sid,
        requireClientId(lockId),
        locked === true,
      );
    },
  );

  ipcMain.handle(
    "maker:input:set-edit-lock",
    async (
      _e,
      sessionId: unknown,
      clientId: unknown,
      locked: unknown,
      opts?: unknown,
    ) => {
      const sid = requireSessionId(sessionId);
      await assertRemoteInputControlBoundary(sid, isDeviceLinkInvoke(), opts);
      return inputCoordinator.setEditLock(
        sid,
        requireClientId(clientId),
        locked === true,
      );
    },
  );
}
