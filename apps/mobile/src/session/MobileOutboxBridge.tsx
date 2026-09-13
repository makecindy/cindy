import { useEffect, useRef, useSyncExternalStore } from "react";
import { Alert, AppState } from "react-native";
import { useAuth } from "@/auth/AuthContext";
import {
  getMobileAuthOwner,
  isMobileAuthOwnerCurrent,
  subscribeMobileAuthOwner,
} from "@/auth/authOwnerGeneration";
import { useDeviceLink } from "@/device-link/DeviceLinkContext";
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
} from "./durableOutboxFiles";
import {
  uploadMobileAttachmentFromFile,
  discardMobileUploadedAttachment,
} from "./mobileAttachmentUpload";
import { buildQueuedTextMessage } from "./inputProjection";
import { outboxItemAttachments } from "./sessionOutbox";
import { sessionFromCreateResult } from "./newSession";
import { getNewSessionCreationTask } from "./newSessionCreation";
import {
  MobileSessionReferenceError,
  prepareMobileQueuedSessionReferences,
} from "./sessionReferences";
import { remoteSessionStore } from "./remoteSessionStore";
import { isDurableOutboxSettled, type DurableOutboxRecord } from "./durableOutbox";
import type { InputProjection } from "./types";

/** Runs only while the OS gives the app execution time; foreground/reconnect resume the same ledger. */
export function MobileOutboxBridge() {
  const auth = useAuth();
  const link = useDeviceLink();
  const latest = useRef({ auth, link });
  latest.current = { auth, link };
  const owner = useSyncExternalStore(subscribeMobileAuthOwner, getMobileAuthOwner, getMobileAuthOwner);
  const accountId = auth.isAuthenticated && auth.user?.id?.trim() === owner.accountId ? owner.accountKey : "";
  const runnerRef = useRef<ReturnType<
    typeof createDurableOutboxDelivery
  > | null>(null);
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
    const invoke: RemoteInvoke = async (deviceId, channel, args) => {
      guard();
      const result = await latest.current.link.invoke(deviceId, channel, args, {
        preSend: guard,
      });
      guard();
      return result as never;
    };
    const invokeOwned =
      (record: DurableOutboxRecord): RemoteInvoke =>
      async (deviceId, channel, args) => {
        const guardRecord = () => {
          guard();
          if (!mobileDurableOutbox.getSnapshot().includes(record))
            throw new Error("OUTBOX_STALE_WRITE");
        };
        guardRecord();
        const result = await latest.current.link.invoke(
          deviceId,
          channel,
          args,
          { preSend: guardRecord },
        );
        guardRecord();
        return result as never;
      };
    const maker = (r: DurableOutboxRecord) =>
      createMobileMakerTransport({
        deviceId: r.deviceId,
        invoke: invokeOwned(r),
      });
    const epochs = new Map<string, { authority: number; remote: number }>();
    const leases = new Map<
      string,
      ReturnType<typeof remoteSessionStore.acquireSessionMessageWork>
    >();
    const leaseKey = (r: DurableOutboxRecord) =>
      JSON.stringify([r.deviceId, r.item.sessionId]);
    const refreshLeases = () => {
      if (!isCurrent()) return;
      const keys = new Set<string>();
      for (const record of mobileDurableOutbox.getSnapshot()) {
        if (isDurableOutboxSettled(record)) continue;
        if (
          record.creation &&
          !remoteSessionStore
            .getSessions()
            .some((s) => s.id === record.item.sessionId)
        ) {
          remoteSessionStore.upsertDeviceSession(
            record.deviceId,
            record.creation.deviceName,
            sessionFromCreateResult(
              { sessionId: record.item.sessionId },
              {
                ...record.creation.draft,
                attachments: outboxItemAttachments(record.item),
              },
            ),
          );
        }
        const key = leaseKey(record);
        keys.add(key);
        if (!leases.has(key))
          leases.set(
            key,
            remoteSessionStore.acquireSessionMessageWork(
              record.item.sessionId,
              true,
            ),
          );
      }
      for (const [key, lease] of leases)
        if (!keys.has(key)) {
          lease.release();
          leases.delete(key);
        }
    };
    const delivery = createDurableOutboxDelivery({
      store: mobileDurableOutbox,
      isCurrent,
      canRun: (r) =>
        AppState.currentState !== "background" &&
        AppState.currentState !== "inactive" &&
        (isDurableOutboxSettled(r) ||
          (!r.suspended &&
            !isDurableOutboxCreationHeld(r.item.sessionId) &&
            latest.current.link.status === "online" &&
            latest.current.link.getPresenceAvailability(r.deviceId) !== false &&
            getNewSessionCreationTask(r.item.sessionId) === null)),
      projection: async (r) => {
        epochs.set(leaseKey(r), {
          authority: remoteSessionStore.captureInputProjectionAuthorityEpoch(
            r.item.sessionId,
          ),
          remote: remoteSessionStore.captureInputProjectionRemoteEpoch(
            r.item.sessionId,
          ),
        });
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
      applyProjection: (r, projection) => {
        guard();
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
        const session = await maker(r).getSession(r.item.sessionId);
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
          { token },
        );
        if (!isCurrent() || !mobileDurableOutbox.getSnapshot().includes(r)) {
          // Use the captured credential for this old owner's object, never a new account's token.
          discardMobileUploadedAttachment(attachment, {
            getToken: async () => token,
          });
          throw new Error("OUTBOX_OWNER_CHANGED");
        }
        return upload.annotated
          ? { ...attachment, annotated: true }
          : attachment;
      },
      enqueue: (r) =>
        invokeOwned(r)<InputProjection>(r.deviceId, "maker:input:enqueue", [
          r.item.sessionId,
          r.prepared,
          {
            sendAtMs: r.sendAtMs,
            ...(r.clearBoundaryMs !== undefined
              ? { expectedClearBoundaryMs: r.clearBoundaryMs }
              : {}),
          },
        ]),
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
      cleanup: (record, cancelled) => cleanupOutboxResources(record, owner, () => latest.current.auth.getAccessToken(), cancelled),
      discardUploads: (record, attachments) => discardOutboxUploads(record, owner, () => latest.current.auth.getAccessToken(), attachments),
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
      refreshLeases();
      void delivery.run().catch(() => undefined);
    };
    void mobileDurableOutbox
      .activate(accountId)
      .then(run)
      .catch(() => {
        if (isCurrent()) Alert.alert(i18n.t("session.outbox.restoreFailed"));
      });
    const off = mobileDurableOutbox.subscribe(run);
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
      clearInterval(timer);
      appState.remove();
      for (const lease of leases.values()) lease.release();
    };
  }, [accountId, owner]);
  useEffect(() => {
    runnerRef.current?.wake();
    void runnerRef.current?.run().catch(() => undefined);
  }, [link.status, link.connectionEpoch]);
  return null;
}
