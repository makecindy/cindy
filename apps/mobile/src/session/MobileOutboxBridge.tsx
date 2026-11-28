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
import { useDeviceLink, type DeviceLinkInvokeOptions } from "@/device-link/DeviceLinkContext";
import { parseSharedTaskPeer } from "@cindy/device-link";
import { createMobileMakerTransport } from "@/device-link/mobileMakerTransport";
import {
  describeOutboxEnqueueRefusal,
  formatRemoteError,
  isAutoRecoveringRemoteError,
} from "@/device-link/remoteStatus";
import { i18n } from "@/i18n";
import {
  bindOutboxProjection,
  createDurableOutboxDelivery,
  type DeliveryProjection,
} from "./durableOutboxDelivery";
import {
  mobileDurableOutbox,
  getCurrentMobileOutboxRecords,
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
import {
  buildRemoteCreateSessionOptions,
  normalizeCreateSessionResult,
  resolveNewSessionSkillDraft,
} from "./newSession";
import { agentAuthGateHint, confirmNewSessionAgentAuth } from "./agentAuthGate";
import { buildAgentCapabilitiesCacheKey, getCachedAgentCapabilities } from "./agentCapabilitiesCache";
import { revalidateNewSessionDraftAfterAuth } from "./newSessionRuntimeReconciliation";
import { buildQueuedMessageForEngine, EMPTY_INPUT_PROJECTION } from "./inputProjection";
import { mobileDebugLog } from "@/debug/mobileDebugLog";
import { outboxItemAttachments } from "./sessionOutbox";
import {
  dismissRecoveredPrecreatedSession,
  getNewSessionCreationTask,
  restoreNewSessionDurableEdit,
  subscribeNewSessionCreationTasks,
} from "./newSessionCreation";
import {
  canDeliverNewSessionInBackground,
  endNewSessionBackgroundDelivery,
} from "./newSessionBackgroundDelivery";
import {
  MobileSessionReferenceError,
  prepareMobileQueuedSessionReferences,
} from "./sessionReferences";
import { remoteSessionStore } from "./remoteSessionStore";
import { unarchiveSessionAfterSend, type SessionPatchInvoke } from "./unarchiveAfterSend";
import { cacheOutboxHistory, hasObservedOutboxHistory } from "./outboxHistoryCache";
import { readLegacyOutboxHistory } from "./outboxHistoryConfirmation";
import { validateOutboxResourceBinding } from './outboxResourceBinding';
import { findRemoteHistoryView } from "./remoteHistoryViews";
import { endOutboxBackgroundSend, hasOutboxBackgroundSend, syncOutboxLeftInBackground } from './outboxBackgroundSend';
import type { DurableOutboxRecord } from "./durableOutbox";
import type { RemoteSession } from "./types";
import {
  canConnectOutboxPeer,
  clearOutboxSessionHandoffs,
  createOutboxMessageLeases,
  createOutboxSessionAccess,
  outboxNeedsReconciliation,
  outboxSessionKey,
  peekOutboxSessionClearBoundary,
  takeOutboxSessionHandoff,
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
    // Learned from this host's own projection / enqueue replies. A first send in
    // a task whose boundary is known needs no projection round trip.
    const durableHosts = new Map<string, number>();
    const knownClearBoundaries = new Map<string, { epoch: number; value: number | null }>();
    // What a host answered belongs to the connection it answered on: a host that
    // restarted or was replaced by an older build must be asked again.
    const connectionEpochFor = (deviceId: string) =>
      latest.current.link.getConnectionEpoch?.(deviceId)
      ?? latest.current.link.getConnectionState?.(deviceId).connectionEpoch
      ?? latest.current.link.connectionEpoch;
    const learnProjection = (r: DurableOutboxRecord, projection: unknown, epoch: number) => {
      if (!projection || typeof projection !== 'object') return;
      const value = projection as { inputDeliveryVersion?: unknown; clearBoundaryMs?: unknown };
      if (value.inputDeliveryVersion === 1) durableHosts.set(r.deviceId, epoch);
      if (value.clearBoundaryMs === null
        || (typeof value.clearBoundaryMs === 'number' && Number.isFinite(value.clearBoundaryMs))) {
        knownClearBoundaries.set(outboxSessionKey(r), { epoch, value: value.clearBoundaryMs });
      }
    };
    const { hidden, invokeOwned, readSessionOnce, canRun, sessionPolicy } = createOutboxSessionAccess({
      getSessions: () => remoteSessionStore.getSessions(),
      getRecords: () => mobileDurableOutbox.getSnapshot(),
      isCurrent,
      guard,
      invoke: (deviceId, channel, args, options) => latest.current.link.invoke(deviceId, channel, args, options),
      readSession: (record) => maker(record).getSession(record.item.sessionId),
      takeSeededSession: (record) => {
        const epoch = connectionEpochFor(record.deviceId);
        const session = takeOutboxSessionHandoff({
          accountKey: owner.accountKey,
          deviceId: record.deviceId,
          sessionId: record.item.sessionId,
          clientId: record.item.clientId,
          connectionEpoch: epoch,
        });
        if (
          session
          && session.clearedAt == null
          && knownClearBoundaries.get(outboxSessionKey(record))?.epoch !== epoch
        ) {
          knownClearBoundaries.set(outboxSessionKey(record), { epoch, value: null });
        }
        return session;
      },
      isForeground: () => AppState.currentState !== "background" && AppState.currentState !== "inactive",
      canContinueInBackground: (record) => canDeliverNewSessionInBackground(record) || hasOutboxBackgroundSend(record),
      canConnect: (deviceId) => canConnectOutboxPeer(latest.current.link, deviceId),
      isCreationHeld: isDurableOutboxCreationHeld,
      hasCreationTask: (sessionId) => getNewSessionCreationTask(sessionId) !== null,
      needsReconciliation,
    });
    const ownerInvoke: SessionPatchInvoke = async (deviceId, channel, args, options) => {
      guard();
      const result = await latest.current.link.invoke(deviceId, channel, args, {
        preSend: () => {
          guard();
          options?.preSend?.();
        },
      });
      guard();
      return result as never;
    };
    const maker = (r: DurableOutboxRecord, options?: DeviceLinkInvokeOptions) =>
      createMobileMakerTransport({
        deviceId: r.deviceId,
        invoke: invokeOwned(r, options),
      });
    const messageLeases = createOutboxMessageLeases({
      isCurrent,
      getRecords: () => mobileDurableOutbox.getSnapshot(),
      hidden,
      isCreationHeld: isDurableOutboxCreationHeld,
      needsReconciliation,
      restoreEditable: restoreNewSessionDurableEdit,
      dismissCancelled: dismissRecoveredPrecreatedSession,
      store: remoteSessionStore,
    });
    const delivery = createDurableOutboxDelivery({
      store: mobileDurableOutbox,
      isCurrent,
      canRun,
      createMissingDialogue: async (record) => {
        if (hidden(record)) return false;
        const draft = record.creation!.draft;
        const host = maker(record);
        const auth = await confirmNewSessionAgentAuth(record.deviceId, draft.agentKind, () => host.listProviders());
        if (auth.unauthenticated) throw new Error(agentAuthGateHint(draft.agentKind));
        const route = auth.fresh && revalidateNewSessionDraftAfterAuth(draft, auth.fresh,
          () => getCachedAgentCapabilities(buildAgentCapabilitiesCacheKey(record.deviceId, draft.agentKind))?.hasFastMode === true,
          (key, values) => i18n.t(key, values));
        if (!canRun(record) || hidden(record)) return false;
        const result = normalizeCreateSessionResult(await host.createSession({
          ...buildRemoteCreateSessionOptions({ ...draft, ...route }),
          id: record.item.sessionId,
        }));
        if (result?.sessionId !== record.item.sessionId) throw new Error(i18n.t('session.new.sessionIdNotAdopted'));
        const row = remoteSessionStore.getSessions()
          .find((session) => session.id === record.item.sessionId && session.deviceLinkDeviceId === record.deviceId);
        remoteSessionStore.applySessionPatch(record.deviceId, record.item.sessionId, {
          pendingLocalCreation: false,
          ...(row && row.source === undefined ? { source: null } : {}),
          ...(result.workDir ? { workingDir: result.workDir } : {}),
        });
        return true;
      },
      onHostSessionReady: (record, session) => {
        if ('workingDir' in session) {
          const full = session as RemoteSession;
          remoteSessionStore.upsertDeviceSession(record.deviceId, record.creation?.deviceName ?? '', {
            ...full,
            ...(full.source === undefined ? { source: null } : {}),
            pendingLocalCreation: false,
          });
        } else {
          const row = remoteSessionStore.getSessions()
            .find((item) => item.id === record.item.sessionId && item.deviceLinkDeviceId === record.deviceId);
          remoteSessionStore.applySessionPatch(record.deviceId, record.item.sessionId, {
            pendingLocalCreation: false,
            ...(row && row.source === undefined ? { source: null } : {}),
          });
        }
      },
      sessionPolicy,
      connectionEpoch: connectionEpochFor,
      projection: async (r, fresh) => {
        return invokeOwned(r, fresh ? { noResultCache: true } : undefined)<DeliveryProjection>(
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
        const epoch = connectionEpochFor(r.deviceId);
        if (durableHosts.get(r.deviceId) !== epoch) return undefined;
        let boundary = knownClearBoundaries.get(outboxSessionKey(r));
        if (boundary?.epoch !== epoch) {
          const handedOffBoundary = peekOutboxSessionClearBoundary({
            accountKey: owner.accountKey,
            deviceId: r.deviceId,
            sessionId: r.item.sessionId,
            clientId: r.item.clientId,
            connectionEpoch: epoch,
          });
          if (handedOffBoundary === undefined) return undefined;
          boundary = { epoch, value: handedOffBoundary };
          knownClearBoundaries.set(outboxSessionKey(r), boundary);
        }
        return {
          ...EMPTY_INPUT_PROJECTION,
          sessionId: r.item.sessionId,
          inputDeliveryVersion: 1,
          clearBoundaryMs: boundary.value,
        };
      },
      staleClearBoundary: (error) =>
        formatRemoteError(error).includes("REMOTE_OPTIMISTIC_INPUT_CLEARED"),
      trace: (event, fields) => mobileDebugLog("debug", "device-link", event, {
        ...fields, appState: AppState.currentState,
      }),
      session: (r) => maker(r).getSession(r.item.sessionId),
      bindProjection: (r) => {
        const apply = bindOutboxProjection(
          remoteSessionStore, r.item.sessionId, () => connectionEpochFor(r.deviceId),
        );
        return (projection) => {
          guard();
          const epoch = apply(projection);
          if (epoch !== undefined) learnProjection(r, projection, epoch);
        };
      },
      readSessionForPreparation: readSessionOnce,
      prepare: async (r, prefetchedSession) => {
        const session = prefetchedSession ?? await readSessionOnce(r);
        guard();
        if (!session?.workingDir)
          throw new Error(i18n.t("session.screen.missingWorkingDir"));
        const item = r.item;
        const firstMessage = r.creation?.draft.selectedSkill
          ? (await resolveNewSessionSkillDraft({ ...r.creation.draft, firstMessage: item.text }, r.deviceId, maker(r))).firstMessage
          : item.text;
        guard();
        const rebuilt = await buildQueuedMessageForEngine(maker(r),
          { ...session, permissionMode: item.permissionModeAtSend },
          firstMessage,
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
        guard();
        return prepareMobileQueuedSessionReferences(
          {
            ...rebuilt,
            ...(r.template
              ? {
                  ...r.template,
                  ...(rebuilt.text !== item.text.trim() ? {
                    text: rebuilt.text, agentReferences: rebuilt.agentReferences,
                  } : {}),
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
      onHandedOff: endNewSessionBackgroundDelivery,
      validateResource: async (r, ref) => {
        await latest.current.link.openLink(r.deviceId);
        guard();
        await validateOutboxResourceBinding(invokeOwned(r), r.deviceId, r.item.sessionId, ref, i18n.language);
        guard();
      },
      // A later projection can confirm delivery even if the enqueue reply was lost.
      accepted: async (record) => { endOutboxBackgroundSend(record); },
      enqueue: async (r, preSend) => {
        const projection = await maker(r, preSend ? { preSend } : undefined).input.enqueue(
          r.item.sessionId,
          r.prepared!,
          {
            sendAtMs: r.sendAtMs,
            ...(r.clearBoundaryMs !== undefined
              ? { expectedClearBoundaryMs: r.clearBoundaryMs }
              : {}),
          },
        );
        endOutboxBackgroundSend(r);
        // 电脑已接收这条消息(离线时是重连后才送达):在已归档任务里发消息即取消归档。
        // 绑账号归属而不绑这条待发记录:消息对账后记录会被清走,取消归档不能随之失效。
        void unarchiveSessionAfterSend(
          r.item.sessionId,
          r.deviceId,
          ownerInvoke,
          () => createMobileMakerTransport({ deviceId: r.deviceId, invoke: ownerInvoke }).getSession(r.item.sessionId),
        );
        return projection;
      },
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
      history: async (r, fresh) => {
        const authority = remoteSessionStore.captureSessionMessageAuthority(
          r.item.sessionId,
        );
        const messages = await maker(r, fresh ? { noResultCache: true } : undefined).aroundMessagesByClientId(
          r.item.sessionId,
          r.item.clientId,
          { radius: 1 },
        );
        guard();
        const found = messages.some(
          (m) => m.sessionId === r.item.sessionId && m.clientId === r.item.clientId && m.role === "user",
        );
        if (found)
          remoteSessionStore.mergeMessages(r.item.sessionId, messages, {
            authority,
          });
        return found;
      },
      observedHistory: (r) => hasObservedOutboxHistory(r.deviceId, r.item.sessionId, r.item.clientId),
      legacyHistory: async (r) => {
        const sessionId = r.item.sessionId;
        const authority = remoteSessionStore.captureSessionMessageAuthority(sessionId);
        const epoch = connectionEpochFor(r.deviceId);
        const row = await readLegacyOutboxHistory(r, invokeOwned(r, {
          legacyHistoryConfirmation: true,
          noResultCache: true,
          preSend: () => {
            if (connectionEpochFor(r.deviceId) !== epoch) throw new Error("OUTBOX_STALE_HISTORY");
          },
        }));
        if (!row) return false;
        remoteSessionStore.mergeMessages(sessionId, [row], { authority });
        return true;
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
      isEnqueueRefusal: (error) => describeOutboxEnqueueRefusal(error) !== undefined,
      confirmationMessage: i18n.t("session.outbox.confirmationRequired"),
      clearedMessage: i18n.t("session.outbox.taskCleared"),
    });
    runnerRef.current = delivery;
    let scheduled = false;
    const run = () => {
      if (scheduled || !isCurrent()) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        if (!isCurrent()) return;
        messageLeases.refresh();
        // User cancellation can settle a record outside the delivery runner.
        for (const record of mobileDurableOutbox.getSnapshot()) {
          if (record.cleanupOutcome === "cancelled") {
            endNewSessionBackgroundDelivery(record);
            endOutboxBackgroundSend(record);
          }
        }
        void delivery.run().catch(() => undefined);
      });
    };
    void mobileDurableOutbox
      .activate(accountId)
      .then(() => {
        if (!isCurrent()) return;
        // New file copies await this same sweep in retainOutboxFile.
        void initializeOutboxFiles().catch(() => undefined);
        run();
      })
      .catch(() => {
        if (isCurrent()) Alert.alert(i18n.t("session.outbox.restoreFailed"));
      });
    const off = subscribeNewSessionCreationTasks(run, "delivery");
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
      clearOutboxSessionHandoffs();
      clearInterval(timer);
      appState.remove();
      messageLeases.dispose();
    };
  }, [accountId, owner]);
  // Remember texts still on the way when the user leaves, including one saved
  // just after Home from the editor's hidden snapshot.
  useEffect(() => {
    const sync = () => syncOutboxLeftInBackground(getCurrentMobileOutboxRecords(), AppState.currentState === "background");
    sync();
    const off = mobileDurableOutbox.subscribe(sync);
    const appState = AppState.addEventListener("change", sync);
    return () => {
      off();
      appState.remove();
    };
  }, [accountId, owner]);
  useEffect(() => {
    runnerRef.current?.wake();
    void runnerRef.current?.run().catch(() => undefined);
  }, [link.status, link.connectionEpoch, link.getConnectionState]);
  return null;
}
