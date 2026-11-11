import type { Dispatch, RefObject, SetStateAction } from "react";
import type { MobileAuthOwnerGeneration } from "@/auth/authOwnerGeneration";
import type { MobileMakerTransport } from "@/device-link/mobileMakerTransport";
import { formatRemoteError } from "@/device-link/remoteStatus";
import type { MobileSessionRuntimeOptions } from "./agentCapabilities";
import type { DurableOutboxRecord } from "./durableOutbox";
import type { MobileLocalAttachmentUploadCandidate } from "./mobileLocalAttachmentUpload";
import {
  getCurrentMobileOutboxRecords,
  mobileDurableOutbox,
} from "./mobileDurableOutbox";
import { outboxCreationRetryIdentity } from "./cancelledCreationDraft";
import { buildOutboxItem, createOutboxClientId } from "./sessionOutbox";
import {
  createNewSessionId,
  holdNewSessionCreationDraft,
} from "./newSessionCreation";
import {
  compensatePrecreatedWorktree,
  type NewSessionDraft,
} from "./newSession";
import {
  holdPrecreatedWorktreeRegistration,
  parseDiscardPrecreatedAck,
  forgetPendingPrecreatedWorktree,
  registerPendingPrecreatedWorktree,
} from "./precreatedWorktreeRecovery";
import { persistNewSessionCreationDraft } from "./persistNewSessionCreationDraft";
import {
  buildWorktreeCreateRequest,
  parseWorktreeCreateResult,
  formatWorktreeCreateFailure,
} from "./newSessionWorktree";
import type { WorktreeCreateIntentSnapshot } from "./useNewSessionWorktreeSync";
import type { RemoteSerializedAttachment, RemoteSession } from "./types";

/** Production services are replaceable at the persistence/transport boundary in unit tests. */
export const newSessionCreationPreparationServices = {
  getCurrentMobileOutboxRecords,
  mobileDurableOutbox,
  outboxCreationRetryIdentity,
  buildOutboxItem,
  createNewSessionId,
  createOutboxClientId,
  holdNewSessionCreationDraft,
  holdPrecreatedWorktreeRegistration,
  persistNewSessionCreationDraft,
  compensatePrecreatedWorktree,
  parseDiscardPrecreatedAck,
  forgetPendingPrecreatedWorktree,
  registerPendingPrecreatedWorktree,
  buildWorktreeCreateRequest,
  parseWorktreeCreateResult,
  formatRemoteError,
  formatWorktreeCreateFailure,
};
export type NewSessionCreationPreparationServices =
  typeof newSessionCreationPreparationServices;

export interface NewSessionCreationPreparationInput {
  effectiveDraft: NewSessionDraft;
  outboxRecoveryRef: RefObject<DurableOutboxRecord | null>;
  selectedDeviceId: string;
  selectedDeviceName: string;
  authOwnerAtCreate: MobileAuthOwnerGeneration;
  worktreeAccountId: string;
  creatingWorktree: boolean;
  worktreeIntent: WorktreeCreateIntentSnapshot;
  isCurrentOwner: () => boolean;
  ensureDeviceAlive: () => boolean;
  isWorktreeCreateIntentCurrent: (
    intent: WorktreeCreateIntentSnapshot,
  ) => boolean;
  runtimeOptions: Pick<MobileSessionRuntimeOptions, "permissionOptions">;
  prePlanPermissionModeRef: RefObject<string | null>;
  planModeCapability: boolean;
  planModeDraftOn: boolean;
  sendAttachments: RemoteSerializedAttachment[];
  attachmentPreviews: Record<string, string>;
  getUploadedSource: (
    id: string,
  ) => MobileLocalAttachmentUploadCandidate | undefined;
  releaseUploadedSources: (ids: string[]) => void;
  maker: {
    getSession: (sessionId: string) => Promise<RemoteSession | null>;
    worktree: Pick<
      MobileMakerTransport["worktree"],
      "suggestName" | "create" | "discardPrecreated"
    >;
  };
  t: (key: string) => string;
  setError: (error: string) => void;
  setDraft: Dispatch<SetStateAction<NewSessionDraft>>;
  resolveWorktreeCreateErrorKey: () => string;
  onHoldDurableCreation: (release: () => void) => void;
  onHoldPrecreatedRegistration: (release: () => void) => void;
}

/**
 * Save the current form and its attachment bytes before any remote worktree effect.
 * The caller retains both existing leases until handoff or its finally block.
 */
export async function prepareNewSessionCreation(
  input: NewSessionCreationPreparationInput,
  services: NewSessionCreationPreparationServices = newSessionCreationPreparationServices,
) {
  let {
    effectiveDraft,
    outboxRecoveryRef,
    selectedDeviceId,
    selectedDeviceName,
    authOwnerAtCreate,
    worktreeAccountId,
    creatingWorktree,
    worktreeIntent,
    isCurrentOwner,
    ensureDeviceAlive,
    isWorktreeCreateIntentCurrent,
    runtimeOptions,
    prePlanPermissionModeRef,
    planModeCapability,
    planModeDraftOn,
    sendAttachments,
    attachmentPreviews,
    getUploadedSource,
    releaseUploadedSources,
    maker,
    t,
    setError,
    setDraft,
    resolveWorktreeCreateErrorKey,
  } = input;
  const {
    getCurrentMobileOutboxRecords,
    mobileDurableOutbox,
    outboxCreationRetryIdentity,
    buildOutboxItem,
    createNewSessionId,
    createOutboxClientId,
    holdNewSessionCreationDraft,
    holdPrecreatedWorktreeRegistration,
    persistNewSessionCreationDraft,
    compensatePrecreatedWorktree,
    parseDiscardPrecreatedAck,
    forgetPendingPrecreatedWorktree,
    registerPendingPrecreatedWorktree,
    buildWorktreeCreateRequest,
    parseWorktreeCreateResult,
    formatRemoteError,
    formatWorktreeCreateFailure,
  } = services;
  let releasePrecreatedRegistration: (() => void) | null = null;
  const previousRecovery = outboxRecoveryRef.current;
  const recovering = previousRecovery
    ? getCurrentMobileOutboxRecords().find(
        (r) =>
          r.deviceId === previousRecovery.deviceId &&
          r.item.clientId === previousRecovery.item.clientId &&
          r.item.sessionId === previousRecovery.item.sessionId,
      )
    : null;
  if (previousRecovery && !recovering) throw new Error("OUTBOX_STALE_WRITE");
  if (recovering && recovering.deviceId !== selectedDeviceId) {
    throw new Error(t("session.outbox.recoveryTarget"));
  }
  if (
    recovering?.creation?.cancelled &&
    previousRecovery?.creation &&
    effectiveDraft.workingDir === previousRecovery.creation.draft.workingDir &&
    effectiveDraft.workingDir !== recovering.creation.draft.workingDir
  ) {
    // Eligibility and branch preference belong to the old directory. Let the
    // form probe the restored target before accepting another submission.
    outboxRecoveryRef.current = recovering;
    setDraft((current) => ({
      ...current,
      workingDir: recovering.creation!.draft.workingDir,
    }));
    return;
  }
  const recoveryIdentity = recovering
    ? outboxCreationRetryIdentity(recovering, createNewSessionId)
    : null;
  const sessionId = recoveryIdentity?.sessionId ?? createNewSessionId();
  if (recovering) {
    // Editing creation parameters is allowed only after the original task is proven absent.
    let found = false;
    try {
      found = !!(await maker.getSession(recovering.item.sessionId));
    } catch (error) {
      if (!formatRemoteError(error).includes("NOT_FOUND")) throw error;
    }
    if (!isCurrentOwner()) return;
    if (found) {
      const latest = getCurrentMobileOutboxRecords().find(
        (r) =>
          r.item.clientId === recovering.item.clientId &&
          r.item.sessionId === recovering.item.sessionId,
      );
      if (latest && !latest.prepared)
        await mobileDurableOutbox.update(latest, {
          suspended: false,
          state: "queued",
        });
      throw new Error(t("session.outbox.taskAlreadyCreated"));
    }
  }
  const agentKindSnapshot = effectiveDraft.agentKind;
  const deviceIdSnapshot = selectedDeviceId;
  const legacyPlanRestore =
    effectiveDraft.permissionMode === "plan"
      ? (() => {
          const fallback =
            runtimeOptions.permissionOptions.find(
              (option) => option.id !== "plan",
            )?.id ?? "ask";
          const remembered = prePlanPermissionModeRef.current;
          return remembered && remembered !== "plan" ? remembered : fallback;
        })()
      : null;
  if (!isCurrentOwner()) return;
  input.onHoldDurableCreation(holdNewSessionCreationDraft(sessionId));
  const firstMessageClientId =
    recovering?.item.clientId ?? createOutboxClientId();
  const useDurableCreation = legacyPlanRestore === null;
  if (recovering && !useDurableCreation)
    throw new Error(t("session.outbox.legacyPlanRecovery"));
  if (useDurableCreation) {
    const firstRecord: DurableOutboxRecord = {
      version: 1,
      accountId: authOwnerAtCreate.accountKey,
      deviceId: deviceIdSnapshot,
      ...(recoveryIdentity
        ? { storageSessionId: recoveryIdentity.storageSessionId }
        : {}),
      createdAt: recovering?.createdAt ?? Date.now(),
      state: recovering ? "failed" : "queued",
      suspended: !!recovering || creatingWorktree,
      uploads: [],
      clearBoundaryMs: null,
      creation: {
        draft: effectiveDraft,
        deviceName: selectedDeviceName,
        // Replacing a restored draft does not hand it to the background pipeline.
        // Keep its recovery intent durable until the creation pipeline takes over.
        ...(recovering ? { editReady: true } : {}),
        ...(creatingWorktree
          ? { originalWorkingDir: effectiveDraft.workingDir }
          : {}),
        planModeArm: planModeCapability && planModeDraftOn,
        restorePermissionMode: legacyPlanRestore,
      },
      item: buildOutboxItem({
        clientId: firstMessageClientId,
        sessionId,
        text: effectiveDraft.firstMessage,
        quotesEncoded: false,
        agentReferences: [],
        pastedTextRanges: [],
        slashCommandRanges: [],
        permissionModeAtSend: effectiveDraft.permissionMode,
        readyAttachments: sendAttachments,
        readyPreviews: sendAttachments.map(
          (a) => attachmentPreviews[a.id] ?? null,
        ),
        claimedUploads: [],
      }),
    };
    const saved = await persistNewSessionCreationDraft({
      record: firstRecord,
      recovering,
      getUploadedSource,
      isCurrent: () => isCurrentOwner() && ensureDeviceAlive(),
    });
    if (!saved) return;
    outboxRecoveryRef.current = saved;
    if (!isCurrentOwner() || !ensureDeviceAlive()) return;
    releaseUploadedSources(sendAttachments.map((a) => a.id));
  }
  let precreatedWorktree:
    | {
        path: string;
        recoveryKey: string;
        originalWorkingDir: string;
        createdAt?: number;
      }
    | undefined;
  // ㉙ 设备切换中止助手(独立 review P1-2/P1-3):检测到设备已切换 → 已产生远端
  // 副作用(precreated)走 compensatePrecreatedWorktree——**先 discardPrecreated
  // 获严格 ACK 才 forget**(forget 删唯一账本,未 discard 就删 = 永久孤儿),
  // ACK 失败/未知保留 ledger 交 recovery;返回 true 供调用方 return。
  const abortIfDeviceSwitched = async (): Promise<boolean> => {
    if (ensureDeviceAlive()) return false;
    if (precreatedWorktree) {
      const pwt = precreatedWorktree;
      await compensatePrecreatedWorktree({
        sessionId,
        recoveryKey: pwt.recoveryKey,
        createdAt: pwt.createdAt ?? Date.now(),
        phase: "precreated",
        discard: () =>
          maker.worktree.discardPrecreated({
            sessionId,
            recoveryKey: pwt.recoveryKey,
          }),
        parseAck: parseDiscardPrecreatedAck,
        forget: () =>
          forgetPendingPrecreatedWorktree(worktreeAccountId, {
            sessionId,
            recoveryKey: pwt.recoveryKey,
            createdAt: pwt.createdAt ?? Date.now(),
          }),
        release: releasePrecreatedRegistration,
      });
    }
    return true;
  };
  // —— worktree 两步流第一步(对齐桌面远程流程 NewMakerDraftRoute:远程没有改已建
  // 会话 workingDir 的通道,顺序反过来 —— 先同步等工作端建好 worktree 拿路径,再以
  // 该路径 + 同一预生成 sessionId 走乐观管线)。worktree:create 对同 sessionId 重跑
  // 不幂等,不能放进管线的重试面 —— 失败(业务 {ok:false} / invoke 抛错)一律留在
  // 表单展示错误,不建会话(草稿原地保留,与桌面远程失败语义一致)。
  if (
    worktreeIntent.applicable &&
    worktreeIntent.enabled &&
    worktreeIntent.eligibility.status === "eligible"
  ) {
    try {
      // suggest-name 失败不阻断:走 auto- 兜底名(对齐桌面 :1316)。
      if (!isCurrentOwner()) return;
      let suggested: string | null = null;
      try {
        suggested = await maker.worktree
          .suggestName(worktreeIntent.eligibility.baseRepo)
          .then((result) => result.name);
      } catch {
        suggested = null;
      }
      if (!isCurrentOwner()) return;
      if (!ensureDeviceAlive()) return;
      if (!isWorktreeCreateIntentCurrent(worktreeIntent)) {
        setError(t(resolveWorktreeCreateErrorKey()));
        return;
      }
      const recoveryKey = createNewSessionId();
      const createdAt = Date.now();
      releasePrecreatedRegistration =
        holdPrecreatedWorktreeRegistration(sessionId);
      input.onHoldPrecreatedRegistration(releasePrecreatedRegistration);
      // reservation 必须先于远端副作用持久化。首次写盘失败时绝不调用
      // worktree:create；volatile 镜像只负责阻止本进程继续制造第二个孤儿，
      // 不能冒充跨进程保证。
      const reservationRecorded = await registerPendingPrecreatedWorktree(
        worktreeAccountId,
        {
          sessionId,
          deviceId: selectedDeviceId,
          recoveryKey,
          createdAt,
          phase: "reserved",
        },
      );
      if (!isCurrentOwner()) return;
      // ㉙ 写盘 reservation 后切设备 → 清掉这份 obligation(reserved 无远端
      // 目录,不产生孤儿,但会阻塞同设备下次创建的 recovery 直到被回收)。
      if (!ensureDeviceAlive()) {
        await forgetPendingPrecreatedWorktree(worktreeAccountId, {
          sessionId,
          recoveryKey,
          createdAt,
        }).catch(() => undefined);
        return;
      }
      if (!reservationRecorded) {
        setError(t("session.new.worktreeRecoveryStateFailed"));
        return;
      }
      if (!isCurrentOwner()) return;
      if (!isWorktreeCreateIntentCurrent(worktreeIntent)) {
        await forgetPendingPrecreatedWorktree(worktreeAccountId, {
          sessionId,
          recoveryKey,
          createdAt,
        });
        setError(t(resolveWorktreeCreateErrorKey()));
        return;
      }
      const createRequest = buildWorktreeCreateRequest({
        sessionId,
        eligibility: worktreeIntent.eligibility,
        sourceBranch: worktreeIntent.sourceBranch,
        suggestedName: suggested,
        recoveryKey,
      });
      const resp = parseWorktreeCreateResult(
        await maker.worktree.create(createRequest),
        createRequest,
      );
      if (!isCurrentOwner()) return;
      if (!resp) {
        setError(t("session.new.worktreeCleanupPending"));
        return;
      }
      if (!resp.ok) {
        await forgetPendingPrecreatedWorktree(worktreeAccountId, {
          sessionId,
          recoveryKey,
          createdAt,
        });
        if (!isCurrentOwner()) return;
        setError(formatWorktreeCreateFailure(resp.error));
        return;
      }
      precreatedWorktree = {
        path: resp.meta.path,
        recoveryKey,
        originalWorkingDir: effectiveDraft.workingDir,
        createdAt,
      };
      // ㉙ 远端目录已产生 → 切设备必须走 ledger 补偿(forget + 释放内存持有,
      // 远端目录留给下次 recovery 对账回收)。
      if (await abortIfDeviceSwitched()) return;
      // 回包后尽力把 path 补到账本；即使这次更新失败，首次已确认落盘的
      // recoveryKey reservation 仍足够让重启后的进程从被控端解析真实路径。
      await registerPendingPrecreatedWorktree(worktreeAccountId, {
        sessionId,
        deviceId: selectedDeviceId,
        path: precreatedWorktree.path,
        recoveryKey,
        createdAt,
        phase: "precreated",
      });
      if (!isCurrentOwner()) return;
      if (await abortIfDeviceSwitched()) return;
      effectiveDraft = { ...effectiveDraft, workingDir: resp.meta.path };
    } catch {
      if (!isCurrentOwner()) return;
      // invoke 抛错时无法判断工作端是否已经完成创建；保留 reservation，
      // 交给当前进程重连或下次冷启动按 recoveryKey 精确对账。
      setError(t("session.new.worktreeCleanupPending"));
      return;
    }
  }
  if (useDurableCreation && precreatedWorktree) {
    const current = outboxRecoveryRef.current;
    if (!current?.creation || current.item.sessionId !== sessionId)
      throw new Error("OUTBOX_STALE_WRITE");
    const updated = await mobileDurableOutbox.update(current, {
      creation: { ...current.creation, draft: effectiveDraft },
      suspended: !!current.creation.editReady,
    });
    outboxRecoveryRef.current = updated;
    if (!isCurrentOwner() || !ensureDeviceAlive()) return;
  }
  return {
    effectiveDraft,
    sessionId,
    agentKindSnapshot,
    deviceIdSnapshot,
    firstMessageClientId,
    legacyPlanRestore,
    useDurableCreation,
    precreatedWorktree,
    abortIfDeviceSwitched,
  };
}
