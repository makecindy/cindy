import { readChatReplyQuote } from '@cindy/maker-shared/chat-reply-quote';
import { useChatOutboxDelivery } from '@/chat/useChatOutboxDelivery';
import { useEffect, useRef, useSyncExternalStore } from "react";
import { Alert, AppState } from "react-native";
import { useAuth } from "@/auth/AuthContext";
import {
  getMobileAuthOwner,
  isMobileAuthOwnerCurrent,
  subscribeMobileAuthOwner,
} from "@/auth/authOwnerGeneration";
import { useDeviceLink } from "@/device-link/DeviceLinkContext";
import { parseSharedTaskPeer } from "@cindy/device-link";
import {
  createMobileMakerTransport,
  type RemoteInvoke,
} from "@/device-link/mobileMakerTransport";
import {
  formatRemoteError,
  isAutoRecoveringRemoteError,
} from "@/device-link/remoteStatus";
import { i18n } from "@/i18n";
import {
  createDurableOutboxDelivery,
  type DeliveryProjection,
} from "./durableOutboxDelivery";
import {
  mobileDurableOutbox,
  isDurableOutboxCreationHeld,
  discardOutboxUploads,
  cleanupOutboxResources,
} from "./mobileDurableOutbox";
import {
  durableOutboxUploadUri,
  initializeComposerAttachmentStage,
  initializeOutboxFiles,
} from "./durableOutboxFiles";
import {
  uploadMobileAttachmentFromFile,
  discardMobileUploadedAttachment,
} from "./mobileAttachmentUpload";
import { buildQueuedTextMessage, EMPTY_INPUT_PROJECTION } from "./inputProjection";
import { mobileDebugLog } from "@/debug/mobileDebugLog";
import { outboxItemAttachments } from "./sessionOutbox";
import { dismissRecoveredPrecreatedSession, getNewSessionCreationTask, restoreNewSessionDurableEdit } from "./newSessionCreation";
import {
  MobileSessionReferenceError,
  prepareMobileQueuedSessionReferences,
} from "./sessionReferences";
import { remoteSessionStore } from "./remoteSessionStore";
import { cacheOutboxHistory } from "./outboxHistoryCache";
import { validateOutboxResourceBinding } from './outboxResourceBinding';
import { findRemoteHistoryView } from "./remoteHistoryViews";
import type { DurableOutboxRecord } from "./durableOutbox";
import {
  createOutboxMessageLeases,
  createOutboxSessionAccess,
  outboxNeedsReconciliation,
  outboxSessionKey,
} from "./mobileOutboxSessionAdapter";

/** Runs only while the OS gives the app execution time; foreground/reconnect resume the same ledger. */
export function MobileOutboxBridge() {
  const auth = useAuth();
  const link = useDeviceLink();
  const latest = useRef({ auth, link });
  latest.current = { auth, link };
  const owner = useSyncExternalStore(
    subscribeMobileAuthOwner,
    getMobileAuthOwner,
    getMobileAuthOwner,
  );
  const accountId =
    auth.isAuthenticated && auth.user?.id?.trim() === owner.accountId
      ? owner.accountKey
      : "";
  const runnerRef = useRef<ReturnType<
    typeof createDurableOutboxDelivery
  > | null>(null);
  useChatOutboxDelivery(accountId);
  useEffect(() => {
    try {
      initializeComposerAttachmentStage();
    } catch {
      // A later retain retries before writing; stage cleanup must not block existing outbox delivery.
    }
    let active = true;
    const isCurrent = () =>
      active &&
      !!accountId &&
      owner.accountKey === accountId &&
      isMobileAuthOwnerCurrent(owner);
    const guard = () => {
      if (!isCurrent()) throw new Error("OUTBOX_OWNER_CHANGED");
    };
    const needsReconciliation = (record: DurableOutboxRecord) =>
      outboxNeedsReconciliation(record,
        findRemoteHistoryView(record.deviceId, record.item.sessionId)?.isActive() === true);
    const { hidden, invokeOwned, readSessionOnce, canRun, sessionPolicy } = createOutboxSessionAccess({
      getSessions: () => remoteSessionStore.getSessions(),
      getRecords: () => mobileDurableOutbox.getSnapshot(),
      isCurrent,
      guard,
      invoke: (deviceId, channel, args, options) => latest.current.link.invoke(deviceId, channel, args, options),
      readSession: (record) => maker(record).getSession(record.item.sessionId),
      isForeground: () => AppState.currentState !== "background" && AppState.currentState !== "inactive",
      canConnect: (deviceId) => latest.current.link.status === "online"
        && latest.current.link.getPresenceAvailability(deviceId) !== false,
      isCreationHeld: isDurableOutboxCreationHeld,
      hasCreationTask: (sessionId) => getNewSessionCreationTask(sessionId) !== null,
      needsReconciliation,
    });
    const invoke: RemoteInvoke = async (deviceId, channel, args) => {
      guard();
      const result = await latest.current.link.invoke(deviceId, channel, args, {
        preSend: guard,
      });
      guard();
      return result as never;
    };
    const maker = (r: DurableOutboxRecord) =>
      createMobileMakerTransport({
        deviceId: r.deviceId,
        invoke: invokeOwned(r),
      });
    // Learned from this host's own projection / enqueue replies. A first send in
    // a task whose boundary is known needs no projection round trip.
    const durableHosts = new Set<string>();
    const knownClearBoundaries = new Map<string, number | null>();
    // What a host answered belongs to the connection it answered on: a host that
    // restarted or was replaced by an older build must be asked again.
    let learnedEpoch = latest.current.link.connectionEpoch;
    const forgetStaleLearning = () => {
      const epoch = latest.current.link.connectionEpoch;
      if (epoch === learnedEpoch) return;
      learnedEpoch = epoch;
      durableHosts.clear();
      knownClearBoundaries.clear();
    };
    const learnProjection = (r: DurableOutboxRecord, projection: unknown) => {
      forgetStaleLearning();
      if (!projection || typeof projection !== 'object') return;
      const value = projection as { inputDeliveryVersion?: unknown; clearBoundaryMs?: unknown };
      if (value.inputDeliveryVersion === 1) durableHosts.add(r.deviceId);
      if (value.clearBoundaryMs === null
        || (typeof value.clearBoundaryMs === 'number' && Number.isFinite(value.clearBoundaryMs))) {
        knownClearBoundaries.set(leaseKey(r), value.clearBoundaryMs);
      }
    };
    const epochs = new Map<string, { authority: number; remote: number }>();
    const leaseKey = outboxSessionKey;
    const captureProjectionEpoch = (r: DurableOutboxRecord) => {
      epochs.set(leaseKey(r), {
        authority: remoteSessionStore.captureInputProjectionAuthorityEpoch(
          r.item.sessionId,
        ),
        remote: remoteSessionStore.captureInputProjectionRemoteEpoch(
          r.item.sessionId,
        ),
      });
    };
    const messageLeases = createOutboxMessageLeases({
      isCurrent,
      getRecords: () => mobileDurableOutbox.getSnapshot(),
      hidden,
      needsReconciliation,
      restoreEditable: restoreNewSessionDurableEdit,
      dismissCancelled: dismissRecoveredPrecreatedSession,
      store: remoteSessionStore,
    });
    const delivery = createDurableOutboxDelivery({
      store: mobileDurableOutbox,
      isCurrent,
      canRun,
      sessionPolicy,
      projection: async (r) => {
        captureProjectionEpoch(r);
        return invoke<DeliveryProjection>(
          r.deviceId,
          "maker:input:get-projection",
          [
            r.item.sessionId,
            {
              deliveryClientIds: [r.item.clientId],
            },
          ],
        );
      },
      knownProjection: (r) => {
        forgetStaleLearning();
        const clearBoundaryMs = knownClearBoundaries.get(leaseKey(r));
        if (!durableHosts.has(r.deviceId) || clearBoundaryMs === undefined) return undefined;
        // The enqueue reply is applied with the epoch captured here, exactly as
        // it would be after a fetched projection.
        captureProjectionEpoch(r);
        return {
          ...EMPTY_INPUT_PROJECTION,
          sessionId: r.item.sessionId,
          inputDeliveryVersion: 1,
          clearBoundaryMs,
        };
      },
      staleClearBoundary: (error) =>
        formatRemoteError(error).includes("REMOTE_OPTIMISTIC_INPUT_CLEARED"),
      trace: (event, fields) => mobileDebugLog("debug", "device-link", event, fields),
      session: (r) => maker(r).getSession(r.item.sessionId),
      applyProjection: (r, projection) => {
        guard();
        // Every fetched projection and enqueue reply passes through here.
        learnProjection(r, projection);
        const epoch = epochs.get(leaseKey(r));
        if (epoch)
          remoteSessionStore.setInputProjectionIfCurrent(
            r.item.sessionId,
            projection,
            epoch.authority,
            epoch.remote,
          );
      },
      prepare: async (r) => {
        const session = await readSessionOnce(r);
        guard();
        if (!session?.workingDir)
          throw new Error(i18n.t("session.screen.missingWorkingDir"));
        const item = r.item;
        const rebuilt = buildQueuedTextMessage(
          { ...session, permissionMode: item.permissionModeAtSend },
          item.text,
          new Date(r.createdAt),
          item.clientId,
          {
            attachments: outboxItemAttachments(item),
            planMode: item.planModeAtSend,
            quotesEncoded: item.quotesEncoded,
            agentReferences: item.agentReferences,
            pastedTextRanges: item.pastedTextRanges,
            slashCommandRanges: item.slashCommandRanges,
            replyQuote: readChatReplyQuote(item.replyQuote) ?? undefined,
          },
        );
        return prepareMobileQueuedSessionReferences(
          {
            ...rebuilt,
            ...(r.template
              ? {
                  ...r.template,
                  files: rebuilt.files,
                  persistedContent: rebuilt.persistedContent,
                  chatMessage: rebuilt.chatMessage,
                }
              : {}),
            ...(item.sessionRefs?.length
              ? { sessionRefs: item.sessionRefs }
              : {}),
          },
          invokeOwned(r),
          remoteSessionStore.getSessionDeviceId,
          r.deviceId,
        );
      },
      upload: async (r, upload) => {
        const token = await latest.current.auth.getAccessToken();
        guard();
        if (!mobileDurableOutbox.getSnapshot().includes(r))
          throw new Error("OUTBOX_STALE_WRITE");
        const attachment = await uploadMobileAttachmentFromFile(
          upload,
          durableOutboxUploadUri(r, upload),
          {
            token,
            deviceId: r.deviceId,
            sharedTaskId: parseSharedTaskPeer(r.deviceId)?.sharedTaskId,
            isActive: () => isCurrent() && mobileDurableOutbox.getSnapshot().includes(r),
          },
        );
        if (!isCurrent() || !mobileDurableOutbox.getSnapshot().includes(r)) {
          // Use the captured credential for this old owner's object, never a new account's token.
          discardMobileUploadedAttachment(attachment, {
            getToken: async () => token,
          });
          throw new Error("OUTBOX_OWNER_CHANGED");
        }
        return upload.annotated
          ? {
              ...attachment,
              annotated: true,
              ...(upload.annotationRegions?.length
                ? { annotationRegions: upload.annotationRegions }
                : {}),
            }
          : attachment;
      },
      beforeEnqueue: async (r) => {
        if (r.resourceRef) {
          await latest.current.link.openLink(r.deviceId);
          guard();
          await validateOutboxResourceBinding(invokeOwned(r), r.deviceId, r.item.sessionId, r.resourceRef, i18n.language);
          guard();
        }
      },
      enqueue: (r) => maker(r).input.enqueue(
          r.item.sessionId,
          r.prepared!,
          {
            sendAtMs: r.sendAtMs,
            ...(r.clearBoundaryMs !== undefined
              ? { expectedClearBoundaryMs: r.clearBoundaryMs }
              : {}),
          },
        ),
      cancel: async (r) => {
        const result = await invokeOwned(r)<{
          inputDeliveryCancelled?: boolean;
        }>(r.deviceId, "maker:input:remove", [
          r.item.sessionId,
          r.item.clientId,
          { durableDelivery: true },
        ]);
        return result.inputDeliveryCancelled === true;
      },
      history: async (r) => {
        const authority = remoteSessionStore.captureSessionMessageAuthority(
          r.item.sessionId,
        );
        const messages = await maker(r).aroundMessagesByClientId(
          r.item.sessionId,
          r.item.clientId,
          { radius: 1 },
        );
        guard();
        const found = messages.some(
          (m) => m.clientId === r.item.clientId && m.role === "user",
        );
        if (found)
          remoteSessionStore.mergeMessages(r.item.sessionId, messages, {
            authority,
          });
        return found;
      },
      cacheHistory: (r) => cacheOutboxHistory(r.deviceId, r.item.sessionId, r.item.clientId,
        () => isCurrent() && mobileDurableOutbox.getSnapshot().includes(r)),
      cleanup: (record, cancelled) =>
        cleanupOutboxResources(
          record,
          owner,
          () => latest.current.auth.getAccessToken(),
          cancelled,
        ),
      discardUploads: (record, attachments) =>
        discardOutboxUploads(
          record,
          owner,
          () => latest.current.auth.getAccessToken(),
          attachments,
        ),
      mediaFailed: (error) =>
        formatRemoteError(error).includes("DEVICE_LINK_MEDIA_TRANSFER_FAILED"),
      retryable: (error) =>
        isAutoRecoveringRemoteError(error) ||
        (error instanceof MobileSessionReferenceError &&
          error.code === "SESSION_REFERENCE_OFFLINE"),
      describe: formatRemoteError,
      confirmationMessage: i18n.t("session.outbox.confirmationRequired"),
      clearedMessage: i18n.t("session.outbox.taskCleared"),
    });
    runnerRef.current = delivery;
    const run = () => {
      messageLeases.refresh();
      // Scavenging failure blocks new copies, not already-owned messages' delivery.
      void initializeOutboxFiles()
        .catch(() => undefined)
        .then(() => delivery.run())
        .catch(() => undefined);
    };
    void mobileDurableOutbox
      .activate(accountId)
      .then(run)
      .catch(() => {
        if (isCurrent()) Alert.alert(i18n.t("session.outbox.restoreFailed"));
      });
    const off = mobileDurableOutbox.subscribe(run);
    const offSessions = remoteSessionStore.subscribe(run);
    const timer = setInterval(run, 2_000);
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        delivery.wake();
        run();
      }
    });
    return () => {
      active = false;
      delivery.stop();
      if (runnerRef.current === delivery) runnerRef.current = null;
      off();
      offSessions();
      clearInterval(timer);
      appState.remove();
      messageLeases.dispose();
    };
  }, [accountId, owner]);
  useEffect(() => {
    runnerRef.current?.wake();
    void runnerRef.current?.run().catch(() => undefined);
  }, [link.status, link.connectionEpoch]);
  return null;
}
