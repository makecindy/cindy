import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { MobileMakerTransport } from "@/device-link/mobileMakerTransport";
import { withTransientRemoteRetry } from "@/device-link/remoteRetry";
import {
  remoteSessionStore,
  useRemoteNewMakerWorktreePreference,
} from "./remoteSessionStore";
import {
  applyWorktreePreferenceOnHost,
  classifyWorktreePreferenceSeed,
  isWorktreeChannelNotAllowedError,
  shouldBlockNewSessionCreateForWorktree,
  worktreeEligibilityCaptionKey,
  type NewSessionWorktreeEligibility,
} from "./newSessionWorktree";
import type { NewSessionDraft } from "./newSession";

export interface WorktreePreferenceWriteTransaction {
  seq: number;
  deviceId: string;
  enabled: boolean;
  revisionAtStart: number;
  status: "writing" | "reconciling" | "committed";
}

export interface PendingWorktreePreferenceAuthority {
  enabled: boolean;
  revisionAtStart: number;
}

export interface WorktreeCreateIntentSnapshot {
  applicable: boolean;
  enabled: boolean;
  target: { deviceId: string; workingDir: string };
  eligibility: NewSessionWorktreeEligibility;
  sourceBranch: string;
  branchPreferenceKey: string;
  branchPreferenceSyncKey: string;
}

export interface NewSessionWorktreeSyncInput {
  selectedDeviceId: string;
  connectionEpoch: number;
  presenceVersion: number;
  deviceLinkStatus: string;
  deviceLinkStatusRef: RefObject<string>;
  creating: boolean;
  creatingRef: RefObject<boolean>;
  draft: Pick<NewSessionDraft, "workspaceKind" | "workingDir" | "agentKind">;
  maker: Pick<
    MobileMakerTransport,
    "getNewMakerDefaults" | "applyNewMakerWorktreePref"
  >;
  openLink: (deviceId: string) => Promise<unknown>;
  worktreeEligibility: NewSessionWorktreeEligibility;
  worktreeHostSupportsRecoveryKeyDiscard: boolean | null | undefined;
  worktreeBranchPreferenceSaving: boolean;
  worktreeBranchPreferenceReady: boolean;
  worktreeBranchPreferenceReadyKeyRef: RefObject<string | null>;
  worktreeBranchPreferenceError: boolean;
  worktreeBranchPreferenceKey: string;
  worktreeBranchPreferenceSyncKey: string;
  worktreeBranchPreferenceSyncKeyRef: RefObject<string>;
  worktreeBranchPreferenceWriteTargetRef: RefObject<string | null>;
  worktreeBranchPreferenceTransactionRef: RefObject<{
    key: string;
    status: "writing" | "unknown" | "committed";
  } | null>;
  worktreeBranchTargetRef: RefObject<{ deviceId: string; workingDir: string }>;
  worktreeEligibilityRef: RefObject<NewSessionWorktreeEligibility>;
  worktreeSourceBranchRef: RefObject<string>;
}

/** Keep the draft's explicit choice independent of host preference writes and echoes. */
export function useNewSessionWorktreeSync({
  selectedDeviceId,
  connectionEpoch,
  presenceVersion,
  deviceLinkStatus,
  deviceLinkStatusRef,
  creating,
  creatingRef,
  draft,
  maker,
  openLink,
  worktreeEligibility,
  worktreeHostSupportsRecoveryKeyDiscard,
  worktreeBranchPreferenceSaving,
  worktreeBranchPreferenceReady,
  worktreeBranchPreferenceReadyKeyRef,
  worktreeBranchPreferenceError,
  worktreeBranchPreferenceKey,
  worktreeBranchPreferenceSyncKey,
  worktreeBranchPreferenceSyncKeyRef,
  worktreeBranchPreferenceWriteTargetRef,
  worktreeBranchPreferenceTransactionRef,
  worktreeBranchTargetRef,
  worktreeEligibilityRef,
  worktreeSourceBranchRef,
}: NewSessionWorktreeSyncInput) {
  const worktreePreference =
    useRemoteNewMakerWorktreePreference(selectedDeviceId);

  // Defaults are advisory. A choice made in this draft wins over later host pushes.
  const worktreeChoicesRef = useRef(new Map<string, boolean>());

  const [, setWorktreeChoiceVersion] = useState(0);

  const worktreeEnabled =
    (selectedDeviceId
      ? worktreeChoicesRef.current.get(selectedDeviceId)
      : undefined) ?? worktreePreference.enabled;

  const worktreeEnabledRef = useRef(worktreeEnabled);

  worktreeEnabledRef.current = worktreeEnabled;

  const worktreeSeedSeqRef = useRef(0);

  const [worktreeSeedRetryNonce, setWorktreeSeedRetryNonce] = useState(0);

  const worktreePreferenceSyncKeyRef = useRef("");

  const worktreePreferenceWriteSeqRef = useRef(0);

  // Serialize writes of the next default independently of the current draft.
  const worktreePreferenceWriteTargetRef = useRef<string | null>(null);

  const [
    worktreePreferenceSavingDeviceId,
    setWorktreePreferenceSavingDeviceId,
  ] = useState<string | null>(null);

  const worktreePreferenceTransactionRef =
    useRef<WorktreePreferenceWriteTransaction | null>(null);

  const worktreePreferenceRenderedRef = useRef({
    deviceId: selectedDeviceId,
    enabled: worktreeEnabled,
    revision: worktreePreference.revision,
  });

  const worktreePreferenceAuthorityUnknownByDeviceRef = useRef(
    new Map<string, PendingWorktreePreferenceAuthority>(),
  );

  const [, setWorktreePreferenceAuthorityVersion] = useState(0);

  const worktreePreferenceSaving =
    selectedDeviceId != null &&
    (worktreePreferenceSavingDeviceId === selectedDeviceId ||
      worktreePreferenceWriteTargetRef.current === selectedDeviceId);

  const worktreePreferenceAwaitingEcho =
    worktreePreferenceTransactionRef.current?.status === "reconciling";

  const worktreePreferenceSyncKey = selectedDeviceId
    ? `${selectedDeviceId}\u0000${connectionEpoch}\u0000${presenceVersion}`
    : "";

  worktreePreferenceSyncKeyRef.current = worktreePreferenceSyncKey;

  const worktreePreferenceAuthorityUnknown =
    selectedDeviceId != null &&
    worktreePreferenceAuthorityUnknownByDeviceRef.current.has(selectedDeviceId);

  const worktreeApplicable =
    draft.workspaceKind === "project" && draft.workingDir.trim().length > 0;

  const worktreeToggleDisabled =
    creating ||
    worktreePreferenceSaving ||
    (worktreeEligibility.status !== "eligible" && !worktreeEnabled);

  // caption 会多占一行、把上方选择器顶起，只在它解释「已勾选但创建被拦」时显示：
  // 探测中不显示；未勾选时创建不受资格影响，恢复中 / 探测失败也不显示。
  const worktreeCaptionKey =
    worktreeEnabled && worktreeEligibility.status !== "probing"
      ? worktreeEligibilityCaptionKey(worktreeEligibility)
      : null;

  const worktreeCreateBlocked =
    shouldBlockNewSessionCreateForWorktree({
      applicable: worktreeApplicable,
      enabled: worktreeEnabled,
      eligibility: worktreeEligibility,
      // Saving a default does not change the explicit parameters of this request.
      preferenceSaving: false,
    }) ||
    (worktreeEnabled &&
      (worktreeBranchPreferenceSaving ||
        (worktreeEligibility.status === "eligible" &&
          !worktreeBranchPreferenceReady) ||
        (worktreeBranchPreferenceTransactionRef.current?.key ===
          worktreeBranchPreferenceKey &&
          worktreeBranchPreferenceTransactionRef.current.status ===
            "unknown")));

  const worktreeControlCaptionKey =
    worktreeCaptionKey ??
    (worktreePreferenceAuthorityUnknown
      ? "session.new.worktreeSettingsSyncFailed"
      : null) ??
    (worktreeBranchPreferenceError
      ? "session.new.worktreeBranchSyncFailed"
      : null);

  const resolveWorktreeCreateErrorKey = useCallback(
    () =>
      worktreeEligibilityCaptionKey(worktreeEligibilityRef.current) ??
      (worktreeBranchPreferenceError
        ? "session.new.worktreeBranchSyncFailed"
        : "session.new.worktreeBranchSaving"),
    [worktreeBranchPreferenceError],
  );

  useLayoutEffect(() => {
    worktreePreferenceRenderedRef.current = {
      deviceId: selectedDeviceId,
      enabled: worktreePreference.enabled,
      revision: worktreePreference.revision,
    };
    const transaction = worktreePreferenceTransactionRef.current;
    if (
      !transaction ||
      (transaction.status !== "reconciling" &&
        transaction.status !== "committed") ||
      transaction.deviceId !== selectedDeviceId ||
      worktreePreference.enabled !== transaction.enabled ||
      worktreePreference.revision <= transaction.revisionAtStart
    )
      return;
    worktreePreferenceTransactionRef.current = null;
    if (worktreePreferenceWriteTargetRef.current === transaction.deviceId) {
      worktreePreferenceWriteTargetRef.current = null;
    }
    setWorktreePreferenceSavingDeviceId(null);
  }, [
    selectedDeviceId,
    worktreePreference.enabled,
    worktreePreference.revision,
    worktreePreferenceAwaitingEcho,
  ]);

  useEffect(() => {
    if (!selectedDeviceId) return;
    const transaction = worktreePreferenceTransactionRef.current;
    if (
      transaction?.deviceId === selectedDeviceId &&
      transaction.status === "reconciling" &&
      worktreePreference.revision > transaction.revisionAtStart &&
      worktreePreference.enabled !== transaction.enabled
    ) {
      // The host echoed a different authoritative value. Do not silently use
      // it for this Create attempt: release the active spinner, retain the
      // user's requested value as an unknown obligation, and allow a retry.
      worktreePreferenceAuthorityUnknownByDeviceRef.current.set(
        selectedDeviceId,
        {
          enabled: transaction.enabled,
          revisionAtStart: transaction.revisionAtStart,
        },
      );
      worktreePreferenceTransactionRef.current = null;
      if (worktreePreferenceWriteTargetRef.current === selectedDeviceId) {
        worktreePreferenceWriteTargetRef.current = null;
      }
      setWorktreePreferenceSavingDeviceId(null);
      setWorktreePreferenceAuthorityVersion((value) => value + 1);
    }
    const pending =
      worktreePreferenceAuthorityUnknownByDeviceRef.current.get(
        selectedDeviceId,
      );
    if (
      !pending ||
      worktreePreference.revision <= pending.revisionAtStart ||
      worktreePreference.enabled !== pending.enabled
    )
      return;
    worktreePreferenceAuthorityUnknownByDeviceRef.current.delete(
      selectedDeviceId,
    );
    setWorktreePreferenceAuthorityVersion((value) => value + 1);
  }, [
    selectedDeviceId,
    worktreePreference.enabled,
    worktreePreference.revision,
    worktreePreferenceAwaitingEcho,
  ]);

  const captureWorktreeCreateIntent =
    useCallback((): WorktreeCreateIntentSnapshot => {
      const target = { ...worktreeBranchTargetRef.current };
      const eligibility = worktreeEligibilityRef.current;
      const branchPreferenceKey =
        target.deviceId && eligibility.status === "eligible"
          ? `${target.deviceId}\u0000${eligibility.baseRepo}`
          : "";
      return {
        applicable:
          target.deviceId.length > 0 && target.workingDir.trim().length > 0,
        enabled: worktreeEnabledRef.current,
        target,
        eligibility,
        sourceBranch: worktreeSourceBranchRef.current,
        branchPreferenceKey,
        branchPreferenceSyncKey: worktreeBranchPreferenceSyncKeyRef.current,
      };
    }, []);

  const isWorktreeCreateIntentCurrent = useCallback(
    (intent: WorktreeCreateIntentSnapshot): boolean => {
      if (!intent.applicable) return true;
      const currentTarget = worktreeBranchTargetRef.current;
      if (
        deviceLinkStatusRef.current !== "online" ||
        currentTarget.deviceId !== intent.target.deviceId ||
        currentTarget.workingDir.trim() !== intent.target.workingDir.trim()
      )
        return false;
      // ineligible 目标不创建 worktree,无需等偏好同步/就绪——提前返回,
      // 避免偏好 GET 在途时被下方偏好守卫拦截;与 enabled 无关(2026-08-07 裁决)。
      // 但快照不能替代实时状态:await 期间同目标可能被重探回 probing/eligible/
      // detect-failed,旧 ineligible 快照必须复核 live ref 仍为 ineligible 才放行,
      // 否则回到 fail closed(探测未定不等于确认不合格)。
      if (!intent.enabled) return true;
      if (intent.eligibility.status === "ineligible") {
        return worktreeEligibilityRef.current.status === "ineligible";
      }
      // The click captures the displayed choice. Background defaults and persistence
      // ACKs cannot invalidate an already submitted request.
      // ineligible 已在前面提前返回,此处只可能是 eligible(2026-08-07 裁决)。
      if (intent.eligibility.status !== "eligible") return false;
      // 与 ineligible 快照同理:eligible 快照也必须复核 live 资格仍是同一 repo 的
      // eligible,await 期间被重探成别的状态或换了 repo 都不能继续建 worktree。
      const currentEligibility = worktreeEligibilityRef.current;
      if (
        currentEligibility.status !== "eligible" ||
        currentEligibility.baseRepo !== intent.eligibility.baseRepo
      )
        return false;
      const branchTransaction = worktreeBranchPreferenceTransactionRef.current;
      // A missing branch snapshot may only be a pending read, not host consent
      // to use the detected branch. Checkbox defaults remain independent.
      return (
        worktreeBranchPreferenceReadyKeyRef.current ===
          intent.branchPreferenceSyncKey &&
        worktreeBranchPreferenceSyncKeyRef.current ===
          intent.branchPreferenceSyncKey &&
        worktreeBranchPreferenceWriteTargetRef.current !==
          intent.branchPreferenceKey &&
        !(
          branchTransaction?.key === intent.branchPreferenceKey &&
          (branchTransaction.status === "writing" ||
            branchTransaction.status === "unknown")
        )
      );
    },
    [],
  );

  // —— worktree 勾选播种:选中设备后读工作端 get-new-maker-defaults 的 worktreeEnabled
  // (vendor 无关,agentKind 只是通道入参,经 ref 读当前值,不因切 agent 重播)。
  // 设备切换 / 链路重连重新播种;老被控端 / 缺字段 / 拉取失败只保留当前镜像。
  // 全新设备在 store 中没有镜像时本来就是默认未勾选,无需失败路径代替宿主写值。
  const worktreeSeedAgentKindRef = useRef(draft.agentKind);

  worktreeSeedAgentKindRef.current = draft.agentKind;

  // Read the host capability through a ref: probing a different directory must
  // not cancel a device-wide defaults request. Old hosts need no missing-field retry.
  const worktreeHostSupportsRecoveryKeyDiscardRef = useRef(
    worktreeHostSupportsRecoveryKeyDiscard,
  );

  worktreeHostSupportsRecoveryKeyDiscardRef.current =
    worktreeHostSupportsRecoveryKeyDiscard;

  useEffect(() => {
    const seq = ++worktreeSeedSeqRef.current;
    const syncKey = worktreePreferenceSyncKey;
    if (!selectedDeviceId || !syncKey || deviceLinkStatus !== "online")
      return undefined;
    const preferenceRevisionAtStart =
      remoteSessionStore.getNewMakerWorktreePreference(
        selectedDeviceId,
      ).revision;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRetry = () => {
      if (retryTimer) return;
      retryTimer = setTimeout(() => {
        if (!cancelled) setWorktreeSeedRetryNonce((value) => value + 1);
      }, 1_500);
    };
    // 与上面 detect effect 同款:先建链再拉,包瞬态重试——app 后台恢复时 relay 常在
    // 重连窗口,裸调会抛 NOT_CONNECTED 并把工作端持久化的勾选偏好静默播种成未勾。
    void withTransientRemoteRetry(
      async () => {
        await openLink(selectedDeviceId);
        return maker.getNewMakerDefaults(worktreeSeedAgentKindRef.current);
      },
      { maxAttempts: 2 },
    )
      .then((defaults) => {
        if (
          cancelled ||
          seq !== worktreeSeedSeqRef.current ||
          worktreePreferenceSyncKeyRef.current !== syncKey
        )
          return;
        // 请求发出后若已收到更晚的 push / 用户点击，旧 pull 不再有覆盖权。
        if (
          remoteSessionStore.getNewMakerWorktreePreference(selectedDeviceId)
            .revision !== preferenceRevisionAtStart
        )
          return;
        const classification = classifyWorktreePreferenceSeed(defaults);
        if (classification.status === "ready") {
          // Update only the host mirror. Explicit draft choices remain separate.
          remoteSessionStore.setNewMakerWorktreePreference(
            selectedDeviceId,
            classification.enabled,
          );
          return;
        }
        if (
          classification.status === "missing" &&
          worktreeHostSupportsRecoveryKeyDiscardRef.current === false
        ) {
          // Old hosts cannot persist this preference and also lack the recovery
          // capability marker. A new host can transiently return `{}` before its
          // renderer cache arrives; keep the last mirror and retry in that case.
          return;
        }
        scheduleRetry();
      })
      .catch((error: unknown) => {
        if (
          cancelled ||
          seq !== worktreeSeedSeqRef.current ||
          worktreePreferenceSyncKeyRef.current !== syncKey
        )
          return;
        if (isWorktreeChannelNotAllowedError(error)) {
          return;
        }
        // A failed defaults read leaves the displayed value usable for creation.
        scheduleRetry();
      });
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [
    connectionEpoch,
    deviceLinkStatus,
    presenceVersion,
    selectedDeviceId,
    worktreePreferenceSyncKey,
    worktreeSeedRetryNonce,
    maker,
    openLink,
  ]);

  // Saving the next default is independent of using this draft's explicit choice.
  // An accepted write may never echo back; release the control after 10 seconds.
  useEffect(() => {
    if (!worktreePreferenceSavingDeviceId || !worktreePreferenceAwaitingEcho)
      return;
    const transaction = worktreePreferenceTransactionRef.current;
    const timer = setTimeout(() => {
      if (
        !transaction ||
        worktreePreferenceTransactionRef.current !== transaction
      )
        return;
      worktreePreferenceAuthorityUnknownByDeviceRef.current.set(
        transaction.deviceId,
        {
          enabled: transaction.enabled,
          revisionAtStart: transaction.revisionAtStart,
        },
      );
      worktreePreferenceTransactionRef.current = null;
      worktreePreferenceWriteTargetRef.current = null;
      setWorktreePreferenceSavingDeviceId(null);
      setWorktreePreferenceAuthorityVersion((value) => value + 1);
    }, 10_000);
    return () => clearTimeout(timer);
  }, [worktreePreferenceSavingDeviceId, worktreePreferenceAwaitingEcho]);

  // 用户显式点击开关:先写工作端,工作端接受后才更新手机内存镜像。
  // 资格不满足导致的禁用不会走到这里 —— 环境因素不抹掉用户偏好;
  // 写入失败也不在手机上制造一份假的持久状态。
  const toggleWorktree = useCallback(() => {
    if (
      creatingRef.current ||
      !selectedDeviceId ||
      worktreePreferenceSaving ||
      worktreePreferenceWriteTargetRef.current === selectedDeviceId
    )
      return;
    const targetDeviceId = selectedDeviceId;
    const next = !worktreeEnabledRef.current;
    worktreeChoicesRef.current.set(targetDeviceId, next);
    worktreeEnabledRef.current = next;
    setWorktreeChoiceVersion((value) => value + 1);
    // 播种在途回包不得覆盖用户显式选择(seq 作废旧回包)。
    worktreeSeedSeqRef.current += 1;
    const preferenceRevisionAtStart =
      remoteSessionStore.getNewMakerWorktreePreference(targetDeviceId).revision;
    const writeSeq = worktreePreferenceWriteSeqRef.current + 1;
    worktreePreferenceWriteSeqRef.current = writeSeq;
    if (
      worktreePreferenceAuthorityUnknownByDeviceRef.current.delete(
        targetDeviceId,
      )
    ) {
      setWorktreePreferenceAuthorityVersion((value) => value + 1);
    }
    const transaction: WorktreePreferenceWriteTransaction = {
      seq: writeSeq,
      deviceId: targetDeviceId,
      enabled: next,
      revisionAtStart: preferenceRevisionAtStart,
      status: "writing",
    };
    // Switching devices may replace a write that is still awaiting ACK/echo.
    // Preserve its uncertainty in the existing per-device reconciliation map.
    const previousTransaction = worktreePreferenceTransactionRef.current;
    if (
      previousTransaction &&
      previousTransaction.deviceId !== targetDeviceId
    ) {
      worktreePreferenceAuthorityUnknownByDeviceRef.current.set(
        previousTransaction.deviceId,
        {
          enabled: previousTransaction.enabled,
          revisionAtStart: previousTransaction.revisionAtStart,
        },
      );
      setWorktreePreferenceAuthorityVersion((value) => value + 1);
    }
    worktreePreferenceTransactionRef.current = transaction;
    // Serialize preference writes; Create/Goal use the synchronous draft choice above.
    worktreePreferenceWriteTargetRef.current = targetDeviceId;
    setWorktreePreferenceSavingDeviceId(targetDeviceId);
    const releaseWrite = () => {
      if (worktreePreferenceWriteSeqRef.current !== writeSeq) return;
      if (worktreePreferenceTransactionRef.current?.seq === writeSeq) {
        worktreePreferenceTransactionRef.current = null;
      }
      if (worktreePreferenceWriteTargetRef.current === targetDeviceId) {
        worktreePreferenceWriteTargetRef.current = null;
      }
      setWorktreePreferenceSavingDeviceId(null);
    };
    const markAuthorityUnknown = () => {
      if (worktreePreferenceWriteSeqRef.current !== writeSeq) return;
      worktreePreferenceAuthorityUnknownByDeviceRef.current.set(
        targetDeviceId,
        {
          enabled: next,
          revisionAtStart: preferenceRevisionAtStart,
        },
      );
      setWorktreePreferenceAuthorityVersion((value) => value + 1);
      releaseWrite();
      setWorktreeSeedRetryNonce((value) => value + 1);
    };
    const armCommittedRender = () => {
      if (worktreePreferenceWriteSeqRef.current !== writeSeq) return;
      transaction.status = "committed";
      const rendered = worktreePreferenceRenderedRef.current;
      if (
        rendered.deviceId === targetDeviceId &&
        rendered.enabled === next &&
        rendered.revision > preferenceRevisionAtStart
      )
        releaseWrite();
    };
    void (async () => {
      try {
        const outcome = await applyWorktreePreferenceOnHost({
          enabled: next,
          apply: maker.applyNewMakerWorktreePref,
          // unsupported 可能是“有偏好写穿、缺安全 worktree 能力”，也可能是最老端
          // 连偏好 channel 都没有：先写 host；只有后者且用户明确点 OFF 时才清手机
          // 保留的旧 ON 镜像。断连/超时不降级，仍保留 ON + fail closed。
          allowUnsupportedDisableFallback:
            !next && worktreeEligibility.status === "unsupported",
          mirror: (enabled) => {
            if (worktreePreferenceWriteSeqRef.current !== writeSeq) return;
            const current =
              remoteSessionStore.getNewMakerWorktreePreference(targetDeviceId);
            if (current.revision === preferenceRevisionAtStart) {
              remoteSessionStore.setNewMakerWorktreePreference(
                targetDeviceId,
                enabled,
              );
            }
            const accepted =
              remoteSessionStore.getNewMakerWorktreePreference(targetDeviceId);
            if (
              accepted.revision > preferenceRevisionAtStart &&
              accepted.enabled === enabled
            ) {
              armCommittedRender();
            } else {
              markAuthorityUnknown();
            }
          },
        });
        if (worktreePreferenceWriteSeqRef.current !== writeSeq) return;
        if (outcome === "accepted") {
          // Main acknowledged the broadcast; track persistence separately from creation.
          transaction.status = "reconciling";
          setWorktreeSeedRetryNonce((value) => value + 1);
        }
      } catch (error) {
        if (worktreePreferenceWriteSeqRef.current !== writeSeq) return;
        if (isWorktreeChannelNotAllowedError(error)) {
          // Explicit old-channel rejection proves this ON request did not
          // commit. Keep the rendered value and let the user continue.
          releaseWrite();
          return;
        }
        // Lost ACK / disconnect may have committed remotely. Reconcile the default
        // via push/GET, while the explicit draft choice remains usable.
        markAuthorityUnknown();
      }
    })();
  }, [
    maker,
    selectedDeviceId,
    worktreeEnabled,
    worktreePreferenceSaving,
    worktreeEligibility.status,
  ]);
  const prepareWorktreeCreateIntent = useCallback(
    (
      onError: (key: string) => void,
    ): WorktreeCreateIntentSnapshot | undefined => {
      const intent = captureWorktreeCreateIntent();
      if (!isWorktreeCreateIntentCurrent(intent)) {
        onError(resolveWorktreeCreateErrorKey());
        return undefined;
      }
      return intent;
    },
    [
      captureWorktreeCreateIntent,
      isWorktreeCreateIntentCurrent,
      resolveWorktreeCreateErrorKey,
    ],
  );

  return {
    worktreeEnabled,
    worktreeApplicable,
    worktreeToggleDisabled,
    worktreeCreateBlocked,
    worktreeCaptionKey,
    worktreeControlCaptionKey,
    resolveWorktreeCreateErrorKey,
    captureWorktreeCreateIntent,
    isWorktreeCreateIntentCurrent,
    toggleWorktree,
    worktreePreferenceSaving,
    worktreePreferenceAuthorityUnknown,
    prepareWorktreeCreateIntent,
  };
}
