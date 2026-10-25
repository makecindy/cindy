import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { schedules } from "@cindy/runtime-db/schema";
import type { DbClient } from "@cindy/runtime-db";
import type { DbLogger } from "@cindy/runtime-db/logging";
import { dbToMakerAgentKind } from "@cindy/maker-shared/agent-kind-conversion";
import { readDeviceProviderViews } from "@cindy/remote-agent";
import { readTurnUsageResetAt } from "@cindy/remote-agent/groups/usageLimit";
import { claudeAccountUsageLimit } from "@cindy/remote-agent/shared/accountUsageLimit";
import { UsageLimitAutoResume } from "./usageLimitAutoResume.js";
import {
  createUsageLimitRecoveryStore,
  type SavedUsageLimitWait,
} from "./usageLimitRecoveryStore.js";
import type { AgentInputCoordinator } from "./agent-input-coordinator.js";
import type { createSessionSnapshot } from "@cindy/runtime-db/sessionSnapshot";
import type { createAccountUsageLimit } from "./accountUsageLimit.js";
import type { InterruptedTurnErrorSignals } from "./interruptedTurnAutoResume.js";
import type { ClaudeSubscriptionUsageSnapshot } from "@cindy/remote-agent/shared/claudeSubscriptionUsage";
import type { CodexAccountUsagePayload } from "./usageBroadcaster.js";
export interface UsageLimitWaitHost {
  coordinator(): AgentInputCoordinator | null;
  getSessionRowSnapshot: ReturnType<
    typeof createSessionSnapshot
  >["getSessionRowSnapshot"];
  getDbClient(): DbClient;
  log: DbLogger;
  activeOwnerScopeKey(): string;
  ownerScopedUserDataPath(...parts: string[]): string;
  isPassive(): boolean;
  isSessionSharedTaskActive(id: string): boolean;
  goalOwnsUsageLimitProbe(id: string): Promise<boolean>;
  resolveSessionRuntimeRoute(
    id: string,
    kind: string,
    saved: { providerId?: string | null; model?: string | null } | null,
  ): { providerId: string | null; modelId: string | null };
  limits: ReturnType<typeof createAccountUsageLimit>;
  remoteBackgroundInvoke(
    deviceId: string,
    channel: string,
    args: unknown[],
    options?: { preSend?: () => void },
  ): ReturnType<Parameters<typeof readDeviceProviderViews>[0]>;
  readClaudeSubscriptionUsageSnapshotForDeviceLink(
    id?: string,
    opts?: { fresh?: boolean },
  ): Promise<ClaudeSubscriptionUsageSnapshot | null>;
  readCodexAccountUsageSnapshotWithWebRefresh(
    id?: string,
    opts?: { fresh?: boolean },
  ): Promise<CodexAccountUsagePayload | null>;
  beforeContinue?(id: string, token: number): boolean;
}
export function createUsageLimitWaitHost(host: UsageLimitWaitHost) {
  const {
    getSessionRowSnapshot,
    getDbClient,
    log,
    activeOwnerScopeKey,
    ownerScopedUserDataPath,
    isSessionSharedTaskActive,
    goalOwnsUsageLimitProbe,
    resolveSessionRuntimeRoute,
    remoteBackgroundInvoke,
    readClaudeSubscriptionUsageSnapshotForDeviceLink,
    readCodexAccountUsageSnapshotWithWebRefresh,
  } = host;
  const {
    subscriptionFamilyOf,
    sessionUsesOtherMachineAccount,
    readRemoteAccountUsageLimit,
    readAccountUsageLimit,
    codexAccountUsageLimit,
  } = host.limits;
  async function isUsageLimitAutoResumeEligible(
    sessionId: string,
  ): Promise<boolean> {
    return isAutomaticContinueEligible(sessionId, { allowOrcaWorker: false });
  }

  /**
   * 供应商组自动换电脑是否接管这次失败：与额度恢复后自动继续同一套排除，只是协同 Worker 也可以换——
   * 换到组里另一台马上续上这一轮、结果照常回报 Lead，与普通任务一致；「等几小时后自动继续」仍交给 Lead。
   */
  async function isProviderGroupFailoverEligible(
    sessionId: string,
  ): Promise<boolean> {
    return isAutomaticContinueEligible(sessionId, { allowOrcaWorker: true });
  }

  async function isAutomaticContinueEligible(
    sessionId: string,
    options: { allowOrcaWorker: boolean },
  ): Promise<boolean> {
    if (host.coordinator()?.isExecutionPaused(sessionId)) return false;
    const row = await getSessionRowSnapshot(sessionId);
    // Orca worker 的失败已桥给 Lead 重新安排;伙伴有自己的候选链与群聊编排,都不在这里续跑。
    if (
      !row ||
      (row.orcaRole === "worker" && !options.allowOrcaWorker) ||
      row.source === "bot"
    )
      return false;
    // 共享中的任务撞上限额不自动等待(Dash 2026-10-08):访客可能已影响本任务,等待期间撤权后
    // 到点续跑不安全,交给房主手动处理。报错时与到点时都复核。
    if (isSessionSharedTaskActive(sessionId)) return false;
    return !(await goalOwnsUsageLimitProbe?.(sessionId).catch(() => false));
  }

  async function resolveSessionUsageResetAt(
    sessionId: string,
    signals: InterruptedTurnErrorSignals,
  ): Promise<number | null> {
    // A pending model/location switch has not updated the saved route yet. The group's
    // verified result is authoritative, including an unknown reset; never read the old account.
    if (signals.providerGroupUsageLimit)
      return signals.providerGroupUsageLimit.resetAtMs;
    const row = await getSessionRowSnapshot(sessionId);
    const agentKind = row?.agentKind ? dbToMakerAgentKind(row.agentKind) : null;
    if (!row || !agentKind) return null;
    const { providerId, modelId } = resolveSessionRuntimeRoute(
      sessionId,
      agentKind,
      row,
    );
    let family = subscriptionFamilyOf(agentKind, providerId);
    if (!family && row.agentDeviceId && !row.remoteHostId && providerId) {
      const views = await readDeviceProviderViews(
        remoteBackgroundInvoke,
        row.agentDeviceId,
      );
      family =
        views.find((view) => view.id === providerId)?.auth.native ?? null;
    }
    if (!family) return null;
    // SSH 远程会话 / 远程 Agent 的报错用那台机器的本地时间:不带时区的钟点不按本机时区理解。
    const otherMachineAccount = sessionUsesOtherMachineAccount(row);
    const fromError = readTurnUsageResetAt(signals, Date.now(), {
      localTimeZoneTrusted: !otherMachineAccount,
    });
    if (fromError !== null && signals.usageResetAt !== undefined)
      return fromError;
    // Ask the actual account for its dated windows before relying on a text-only clock.
    // SSH has no account-usage RPC; never substitute a local account there.
    try {
      const scope = activeOwnerScopeKey();
      const limit = row.remoteHostId
        ? null
        : row.agentDeviceId && providerId
          ? await readRemoteAccountUsageLimit(
              {
                deviceId: row.agentDeviceId,
                providerId,
                family,
                agentKind,
                modelId,
              },
              (deviceId, channel, args) =>
                remoteBackgroundInvoke(deviceId, channel, args, {
                  preSend: () => {
                    if (scope !== activeOwnerScopeKey())
                      throw new Error("Account changed");
                  },
                }),
            )
          : family === "claude"
            ? claudeAccountUsageLimit(
                await readClaudeSubscriptionUsageSnapshotForDeviceLink(
                  providerId ?? undefined,
                  { fresh: true },
                ),
                modelId,
              )
            : family === "codex"
              ? codexAccountUsageLimit(
                  await readCodexAccountUsageSnapshotWithWebRefresh(
                    providerId ?? undefined,
                    { fresh: true },
                  ),
                  { agentKind, modelId },
                )
              : await readAccountUsageLimit(agentKind, providerId, modelId);
      if (scope !== activeOwnerScopeKey()) return null;
      if (limit?.limited && limit.resetAtMs !== null) return limit.resetAtMs;
    } catch (error) {
      log.info(
        "usage reset lookup unavailable; retaining provider error hint",
        { sessionId, error: String(error) },
      );
    }
    return fromError;
  }

  // 普通任务撞上账号限额:照常报错，保存等待并在额度重置后自动继续。
  // coordinator 是可变绑定,必须懒读。
  const usageLimitRecoveryStore = createUsageLimitRecoveryStore({
    filePath: () => ownerScopedUserDataPath("usage-limit-waits.json"),
    scopeKey: activeOwnerScopeKey,
    log,
  });
  const savedUsageLimitWaits = new Map<
    string,
    { token: number; record: SavedUsageLimitWait }
  >();
  let usageLimitRecoverySuspended = false;

  function usageLimitSavedRoute(
    row: Awaited<ReturnType<typeof getSessionRowSnapshot>>,
  ): string {
    return JSON.stringify([
      row?.agentKind,
      row?.providerId,
      row?.model,
      row?.agentDeviceId,
      row?.remoteHostId,
    ]);
  }

  async function isSavedUsageLimitWaitValid(
    record: SavedUsageLimitWait,
  ): Promise<boolean> {
    const row = await getSessionRowSnapshot(record.sessionId);
    if (
      !row ||
      row.status !== "active" ||
      (row.clearedAt ?? 0) >= record.savedAt ||
      (row.userSendAt ?? 0) > record.savedAt ||
      usageLimitSavedRoute(row) !== record.route
    )
      return false;
    const origin = record.item.origin;
    if (origin?.kind === "scheduler") {
      const [schedule] = await getDbClient()
        .drizzle.select({ status: schedules.status })
        .from(schedules)
        .where(eq(schedules.id, origin.scheduleId))
        .limit(1);
      if (!schedule || schedule.status !== "active") return false;
    }
    return true;
  }

  function forgetSavedUsageLimitWait(sessionId: string): void {
    if (usageLimitRecoverySuspended) return;
    const pending = savedUsageLimitWaits.get(sessionId);
    if (!pending) return;
    savedUsageLimitWaits.delete(sessionId);
    void usageLimitRecoveryStore
      .take(sessionId, pending.record.id)
      .catch((error) =>
        log.warn("could not cancel saved usage-limit wait", {
          sessionId,
          error: String(error),
        }),
      );
  }

  /** Called before scheduler/Maker teardown; shutdown is not a user's cancellation. */
  function suspendUsageLimitWaits(): void {
    usageLimitRecoverySuspended = true;
    usageLimitAutoResume.suspend();
    for (const [sessionId, pending] of savedUsageLimitWaits)
      host.coordinator()?.unloadUsageLimitRecovery(sessionId, pending.token);
    savedUsageLimitWaits.clear();
  }

  async function flushUsageLimitWaits(): Promise<void> {
    await usageLimitRecoveryStore.flush();
  }

  async function reconcileScheduledUsageLimitWaits(
    scheduleId: string,
  ): Promise<void> {
    const scope = activeOwnerScopeKey();
    for (const [sessionId, pending] of savedUsageLimitWaits) {
      if (
        pending.record.item.origin?.kind !== "scheduler" ||
        pending.record.item.origin.scheduleId !== scheduleId
      )
        continue;
      const valid = await isSavedUsageLimitWaitValid(pending.record);
      if (usageLimitRecoverySuspended || scope !== activeOwnerScopeKey())
        return;
      if (!valid && savedUsageLimitWaits.get(sessionId) === pending) {
        host.coordinator()?.cancelUsageLimitWait(sessionId, pending.token);
      }
    }
  }

  /** Reuse the saved wait owner; a fresh-session schedule must not bypass it after restart. */
  async function findSchedulerUsageLimitWait(
    scheduleId: string,
  ): Promise<string | null> {
    const scope = activeOwnerScopeKey();
    for (const [sessionId, pending] of savedUsageLimitWaits) {
      if (
        pending.record.item.origin?.kind !== "scheduler" ||
        pending.record.item.origin.scheduleId !== scheduleId
      )
        continue;
      const valid = await isSavedUsageLimitWaitValid(pending.record);
      if (usageLimitRecoverySuspended || scope !== activeOwnerScopeKey())
        return null;
      if (
        valid &&
        savedUsageLimitWaits.get(sessionId) === pending &&
        host.coordinator()?.leaseUsageLimitRecovery(sessionId, pending.token)
      )
        return sessionId;
    }
    return null;
  }

  async function restoreSavedUsageLimitWait(sessionId: string): Promise<void> {
    const coordinator = host.coordinator();
    if (
      !coordinator ||
      usageLimitRecoverySuspended ||
      savedUsageLimitWaits.has(sessionId) ||
      host.isPassive()
    )
      return;
    const record = usageLimitRecoveryStore
      .readAll()
      .find((wait) => wait.sessionId === sessionId);
    if (!record) return;
    const scope = activeOwnerScopeKey();
    const generation = coordinator.getGeneration(sessionId);
    const valid =
      (await isSavedUsageLimitWaitValid(record)) &&
      (await isUsageLimitAutoResumeEligible(sessionId));
    if (scope !== activeOwnerScopeKey() || usageLimitRecoverySuspended) return;
    if (!valid) {
      await usageLimitRecoveryStore.take(sessionId, record.id);
      return;
    }
    const pending = { token: 0, record };
    savedUsageLimitWaits.set(sessionId, pending);
    const token = coordinator.restoreUsageLimitRecovery(
      sessionId,
      record,
      generation,
    );
    if (token === null) {
      forgetSavedUsageLimitWait(sessionId);
      return;
    }
    pending.token = token;
    if (
      !usageLimitAutoResume.restore(
        sessionId,
        token,
        record.resumeAt,
        record.attempts,
        record.groupQuota === true,
      )
    ) {
      coordinator.cancelUsageLimitWait(sessionId, token);
    }
  }

  /** Run after account/DB readiness, before scheduler ticks. Passive instances only display state. */
  async function restoreUsageLimitWaits(): Promise<void> {
    if (!host.coordinator() || host.isPassive()) return;
    usageLimitRecoverySuspended = false;
    const scope = activeOwnerScopeKey();
    for (const record of usageLimitRecoveryStore.readAll()) {
      if (scope !== activeOwnerScopeKey() || usageLimitRecoverySuspended)
        return;
      await host.coordinator()?.ensureQueueRestored(record.sessionId);
      await restoreSavedUsageLimitWait(record.sessionId);
    }
  }

  const usageLimitAutoResume = new UsageLimitAutoResume({
    now: () => Date.now(),
    random: () => Math.random(),
    setTimer: (fn, delayMs) => {
      const timer = setTimeout(fn, delayMs);
      timer.unref?.();
      return timer;
    },
    clearTimer: (handle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
    isEligible: isUsageLimitAutoResumeEligible,
    resolveResetAt: resolveSessionUsageResetAt,
    arm: (sessionId, token, resumeAt) =>
      host.coordinator()?.armUsageLimitWait(sessionId, token, resumeAt) ??
      false,
    isCurrent: (sessionId, token) =>
      !usageLimitRecoverySuspended &&
      (host.coordinator()?.isUsageLimitWaitCurrent(sessionId, token) ?? false),
    saveWait: async (sessionId, token, resumeAt, attempts, groupQuota) => {
      const scope = activeOwnerScopeKey();
      const snapshot = host
        .coordinator()
        ?.snapshotUsageLimitRecovery(sessionId, token);
      if (!snapshot || usageLimitRecoverySuspended) return false;
      const row = await getSessionRowSnapshot(sessionId);
      if (
        !row ||
        scope !== activeOwnerScopeKey() ||
        usageLimitRecoverySuspended ||
        !host.coordinator()?.isUsageLimitWaitCurrent(sessionId, token)
      )
        return false;
      const prior = savedUsageLimitWaits.get(sessionId);
      const record: SavedUsageLimitWait = {
        ...snapshot,
        sessionId,
        resumeAt,
        attempts,
        groupQuota,
        id: prior?.token === token ? prior.record.id : randomUUID(),
        savedAt: prior?.token === token ? prior.record.savedAt : Date.now(),
        route: usageLimitSavedRoute(row),
      };
      savedUsageLimitWaits.set(sessionId, { token, record });
      if (
        !(await usageLimitRecoveryStore.save(
          record,
          () =>
            scope === activeOwnerScopeKey() &&
            !usageLimitRecoverySuspended &&
            host.coordinator()?.isUsageLimitWaitCurrent(sessionId, token) ===
              true,
        ))
      )
        return false;
      if (scope !== activeOwnerScopeKey() || usageLimitRecoverySuspended)
        return false;
      if (!host.coordinator()?.isUsageLimitWaitCurrent(sessionId, token)) {
        await usageLimitRecoveryStore.take(sessionId, record.id);
        return false;
      }
      return true;
    },
    cancel: (sessionId, token) => {
      host.coordinator()?.cancelUsageLimitWait(sessionId, token);
    },
    continueSession: async (sessionId, token, info) => {
      const scope = activeOwnerScopeKey();
      const saved = savedUsageLimitWaits.get(sessionId);
      if (
        saved?.token !== token ||
        !(await isSavedUsageLimitWaitValid(saved.record)) ||
        scope !== activeOwnerScopeKey() ||
        usageLimitRecoverySuspended
      )
        return "superseded";
      if (host.beforeContinue?.(sessionId, token) === false)
        return "capacity-wait";
      if (!(await usageLimitRecoveryStore.take(sessionId, saved.record.id)))
        return "superseded";
      if (scope !== activeOwnerScopeKey() || usageLimitRecoverySuspended)
        return "superseded";
      savedUsageLimitWaits.delete(sessionId);
      return (
        host
          .coordinator()
          ?.continueAfterUsageLimitReset(sessionId, token, info) ?? "superseded"
      );
    },
    log: (message, fields) => log.info(message, fields),
  });

  function onProjection(projection: { sessionId: string }) {
    const savedWait = savedUsageLimitWaits.get(projection.sessionId);
    if (
      savedWait &&
      savedWait.token > 0 &&
      !host
        .coordinator()!
        .leaseUsageLimitRecovery(projection.sessionId, savedWait.token)
    ) {
      forgetSavedUsageLimitWait(projection.sessionId);
    }
  }
async function hasRestoredCodexQuota(sessionId: string, expectedProvider: string): Promise<boolean> {
  const row = await getSessionRowSnapshot(sessionId);
  if (!row || sessionUsesOtherMachineAccount(row)) return false;
  const kind = row.agentKind ? dbToMakerAgentKind(row.agentKind) : null;
  if (!kind) return false;
  const route = resolveSessionRuntimeRoute(sessionId, kind, row);
  const providerId = route.providerId ?? (kind === 'codex' ? 'openai' : null);
  if (providerId !== expectedProvider) return false;
  const limit = await readAccountUsageLimit(kind, route.providerId, route.modelId);
  return limit != null && !limit.limited;
}
  return {
    hasRestoredCodexQuota,
    usageLimitAutoResume,
    isAutomaticContinueEligible,
    isUsageLimitAutoResumeEligible,
    isProviderGroupFailoverEligible,
    resolveSessionUsageResetAt,
    suspendUsageLimitWaits,
    flushUsageLimitWaits,
    reconcileScheduledUsageLimitWaits,
    findSchedulerUsageLimitWait,
    restoreSavedUsageLimitWait,
    restoreUsageLimitWaits,
    onProjection,
  };
}
