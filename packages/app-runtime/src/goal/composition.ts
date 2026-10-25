import { randomUUID } from "node:crypto";
import type { Maker, AgentKind } from "@cindy/maker-core";
import { GoalStorage, type GoalDrizzleDb } from "./storage.js";
import type { GoalController } from "./controller.js";
import type {
  GoalControllerDeps,
  GoalStatusUpdate,
  SessionLike,
} from "./types.js";
import type { createGoalSettingsStore } from "./settings.js";
import type {
  createSessionSnapshot,
  SessionRowSnapshot,
} from "@cindy/runtime-db/sessionSnapshot";
import type { createAccountUsageLimit } from "../accountUsageLimit.js";
import type { createClaudeAccountUsage } from "../claudeAccountUsage.js";
import type { createPersistedConversations } from "../persistedConversations.js";
import { readTurnUsageResetAt } from "@cindy/remote-agent/groups/usageLimit";
type Usage = ReturnType<typeof createAccountUsageLimit>;
export interface GoalCompositionHost
  extends
    Pick<
      ReturnType<typeof createGoalSettingsStore>,
      "readGoalSettings" | "writeGoalSettings"
    >,
    Pick<
      Usage,
      | "subscriptionFamilyOf"
      | "sessionUsesOtherMachineAccount"
      | "readAccountUsageLimit"
    > {
  createController(deps: GoalControllerDeps): GoalController;
  ensureSession(id: string): Promise<SessionLike | undefined>;
  acquirePendingAgentSwitchForDirectSend: NonNullable<
    GoalControllerDeps["acquirePendingAgentSwitch"]
  >;
  isSessionInTurn: GoalControllerDeps["isSessionInTurn"];
  ensureGoalInputReady: NonNullable<GoalControllerDeps["ensureInputReady"]>;
  isGoalInputBlocked: NonNullable<GoalControllerDeps["isInputBlocked"]>;
  stopActiveGoalTurnForClear: GoalControllerDeps["stopActiveGoalTurn"];
  isSessionSharedTaskActive: NonNullable<GoalControllerDeps["isSessionShared"]>;
  createMessage: ReturnType<
    typeof createPersistedConversations
  >["messages"]["createMessage"];
  getSessionRowSnapshot: ReturnType<
    typeof createSessionSnapshot
  >["getSessionRowSnapshot"];
  resolveSessionRuntimeRoute(
    id: string,
    kind: AgentKind,
    row: SessionRowSnapshot | null,
  ): { providerId: string | null; modelId: string | null | undefined };
  readClaudeAccountUsageSnapshot: ReturnType<
    typeof createClaudeAccountUsage
  >["readClaudeAccountUsageSnapshot"];
}
export function createGoalControllerComposition(
  deps: {
    maker: Pick<Maker, "getSession">;
    getDb: () => GoalDrizzleDb;
    broadcastStatus: (update: GoalStatusUpdate) => void;
    beforeDispatchUserTurn?: GoalControllerDeps["beforeDispatchUserTurn"];
    onUndispatchedUserTurn?: GoalControllerDeps["onUndispatchedUserTurn"];
    logger: GoalControllerDeps["logger"];
  },
  host: GoalCompositionHost,
) {
  const {
    acquirePendingAgentSwitchForDirectSend,
    isSessionInTurn,
    ensureGoalInputReady,
    isGoalInputBlocked,
    stopActiveGoalTurnForClear,
    readGoalSettings,
    writeGoalSettings,
    createMessage,
    getSessionRowSnapshot,
    resolveSessionRuntimeRoute,
    subscriptionFamilyOf,
    sessionUsesOtherMachineAccount,
    readAccountUsageLimit,
    readClaudeAccountUsageSnapshot,
    isSessionSharedTaskActive,
  } = host;
  const logger = deps.logger;
  const storage = new GoalStorage(deps.getDb);
  const controller = host.createController({
    storage,
    getSession: (id): SessionLike | undefined => deps.maker.getSession(id),
    // 确保会话活着:已活直接返回;未活按存档 SessionMeta resume(spawn agent),
    // 仿 scheduler 心跳。修"开了对话没发消息 → goal 发不出第一轮"的根因。
    ensureSession: (id): Promise<SessionLike | undefined> =>
      host.ensureSession(id),
    acquirePendingAgentSwitch: acquirePendingAgentSwitchForDirectSend,
    isSessionInTurn,
    ensureInputReady: ensureGoalInputReady,
    isInputBlocked: isGoalInputBlocked,
    stopActiveGoalTurn: stopActiveGoalTurnForClear,
    beforeDispatchUserTurn: deps.beforeDispatchUserTurn,
    onUndispatchedUserTurn: deps.onUndispatchedUserTurn,
    emitStatus: deps.broadcastStatus,
    // 护栏默认从 goal-settings-store 读(系统默认 + 用户 override,规则 20);新建 goal
    // 时直接采用最新默认值。
    getDefaults: () => readGoalSettings(),
    // 预留给未来 settings UI;当前 /goal 流程不写全局默认 override。
    persistGoalSettingsOverride: (limits) => writeGoalSettings(limits),
    logger,
    // 首轮落一条干净的目标文案(对话起点);发给模型的仍是完整 directive(在
    // controller.fireTurn 里)。不打 agentMeta.origin —— guard f 区分 goal/user turn
    // 靠事件的 turnOrigin,持久化消息无需重复标记(且 AgentMeta.origin 当前不含 'goal')。
    persistUserMessage: async (sessionId, content, opts) => {
      await createMessage(sessionId, {
        clientId: randomUUID(),
        role: "user",
        content,
        // /goal 目标设定/更新 → 标记该消息,renderer 在气泡上方渲「目标 / 目标已更新」徽标。
        ...(opts?.goalObjective
          ? { agentMeta: { goalObjective: opts.goalObjective } }
          : {}),
      });
    },
    // 达成时落一条持久记录(空 content + agentMeta.goalCompletion),renderer 渲成
    // "目标已达成 · N 轮 · 耗时 X"分隔条。与 persistUserMessage 对称:起点落目标、
    // 终点落达成。agentMeta 是持久 JSON,不进 prompt(规则 10 安全)。
    persistGoalCompletion: async (sessionId, summary) => {
      await createMessage(sessionId, {
        clientId: randomUUID(),
        role: "assistant",
        content: "",
        agentMeta: { goalCompletion: summary },
      });
    },
    // 主动配额检测:按会话所用订阅账号读用量快照(ChatGPT 订阅无论跑在 Codex、Claude Code
    // bridge 还是 Pi 上都读同一份额度),判 limited + 取 resetAt(unix ms)。
    getAccountLimit: async (agentKind, sessionId, turnError) => {
      const row = await getSessionRowSnapshot(sessionId);
      const { providerId, modelId } = resolveSessionRuntimeRoute(
        sessionId,
        agentKind,
        row,
      );
      if (subscriptionFamilyOf(agentKind, providerId)) {
        const otherMachineAccount = sessionUsesOtherMachineAccount(row);
        // 报错原文写明的重置时刻只对订阅账号可信(非订阅来源的是分钟级请求限流)。
        if (turnError !== undefined) {
          // SSH 远程会话 / 远程 Agent 的报错用那台机器的本地时间:不带时区的钟点不按本机时区理解。
          const fromError = readTurnUsageResetAt(turnError, Date.now(), {
            localTimeZoneTrusted: !otherMachineAccount,
          });
          if (fromError !== null)
            return { limited: true, resetAtMs: fromError };
        }
        // SSH 远端主机 / 远程 Agent 所在电脑用自己的登录,本机订阅快照属于另一个账号
        // (与普通任务同一边界)。
        if (otherMachineAccount) return null;
      }
      // 远程 Agent 用 Agent 所在电脑自己的登录与来源:本机的订阅 / 网关快照都不是它的账号。
      // 那台的独立账号本机目录认不出(上面判不出订阅家族)时也到这里,同样不读。
      // SSH 沿用原有的网关预算回落。
      if (row?.agentDeviceId && !row.remoteHostId) return null;
      const subscription = await readAccountUsageLimit(
        agentKind,
        providerId,
        modelId,
      ).catch(() => null);
      if (subscription !== undefined) return subscription;
      // 非订阅的 Claude Code 会话(Cindy 网关):读 LiteLLM 预算周期。
      if (agentKind === "claude-code") {
        const snap = readClaudeAccountUsageSnapshot();
        if (!snap) return null;
        const parsed = snap.budgetResetAt
          ? Date.parse(snap.budgetResetAt)
          : Number.NaN;
        return {
          limited: snap.maxBudget > 0 && snap.spend >= snap.maxBudget,
          resetAtMs: Number.isFinite(parsed) ? parsed : null,
        };
      }
      return null;
    },
    // usageLimited 到点自动续跑时,落一条"用量已恢复,继续目标"提示(渲染成 system card)。
    isSessionShared: (sessionId) => isSessionSharedTaskActive(sessionId),
    persistGoalNotice: async (sessionId, kind) => {
      await createMessage(sessionId, {
        clientId: randomUUID(),
        role: "assistant",
        content: "",
        agentMeta: { goalNotice: kind },
      });
    },
  });

  return controller;
}
