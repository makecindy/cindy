import {
  GoalController,
  type GoalRuntime,
} from "@cindy/app-runtime/goal/controller";
import {
  createGoalControllerComposition,
  type GoalCompositionHost,
} from "@cindy/app-runtime/goal/composition";
import { createGoalSettingsStore } from "@cindy/app-runtime/goal/settings";
import { createGoalIpc } from "@cindy/app-runtime/goal/ipc";
import { createAccountUsageLimit } from "@cindy/app-runtime/accountUsageLimit";
import type { Session, Logger } from "@cindy/maker-core";
import type { NodeDatabase } from "../database.js";
import type { TerminalConversations } from "./conversations.js";
import type { TerminalModelConfig } from "../models/config.js";
import type { TerminalUsage } from "./usage.js";
import type { AgentInputCoordinator } from "@cindy/app-runtime/agent-input-coordinator";
import type { TerminalEventBindings } from "./events.js";

/** Original Goal controller and IPC, with the same owner database and input queue. */
export function createTerminalGoals(host: {
  database: NodeDatabase;
  conversations: TerminalConversations;
  models: TerminalModelConfig;
  usage: TerminalUsage;
  dataRoot: string;
  logger: Logger;
  runtime: GoalRuntime;
  coordinator: AgentInputCoordinator;
  session(id: string): Session | undefined;
  ensureSession(id: string): Promise<Session | undefined>;
  acquireRoute: GoalCompositionHost["acquirePendingAgentSwitchForDirectSend"];
  isSessionInTurn: GoalCompositionHost["isSessionInTurn"];
  resolveSessionRuntimeRoute: GoalCompositionHost["resolveSessionRuntimeRoute"];
  isSessionSharedTaskActive: GoalCompositionHost["isSessionSharedTaskActive"];
  hasPendingInteraction(id: string): boolean;
  canDispatch(): boolean;
  assertCurrent(): void;
  snapshots: NonNullable<TerminalEventBindings["gitSnapshots"]>;
  emit(channel: string, payload: unknown): void;
}) {
  const settings = createGoalSettingsStore({
    userDataDirectory: () => host.dataRoot,
    logger: host.logger,
  });
  const limits = createAccountUsageLimit({
    ...host.usage,
    getActiveCatalog: () => host.models.catalogRuntime.getActiveCatalog(),
    readSubscriptionAccountUsage: (id) =>
      host.usage.accounts.readXaiSubscriptionUsage(id),
  });
  const blocked = (id: string) =>
    !host.canDispatch() ||
    host.coordinator.shouldQueueNewTurn(id) ||
    host.hasPendingInteraction(id);
  let closed = false;
  const controller = createGoalControllerComposition(
    {
      maker: { getSession: host.session },
      getDb: () => {
        host.assertCurrent();
        return host.database.getDbClient().drizzle;
      },
      broadcastStatus: (update) =>
        host.emit("maker:goal:status-changed", update),
      logger: host.logger,
      beforeDispatchUserTurn: (id) => host.snapshots.onTurnStart(id),
      onUndispatchedUserTurn: (id) => host.snapshots.onTurnAbort(id),
    },
    {
      ...settings,
      ...limits,
      ...host.conversations.messages,
      ...host.conversations.snapshot,
      ...host.usage,
      createController: (deps) => new GoalController(deps, host.runtime),
      ensureSession: host.ensureSession,
      acquirePendingAgentSwitchForDirectSend: host.acquireRoute,
      isSessionInTurn: host.isSessionInTurn,
      ensureGoalInputReady: async (id) => {
        await host.coordinator.ensureQueueRestored(id);
        return !closed && host.coordinator.isQueueRestored(id) && !blocked(id);
      },
      isGoalInputBlocked: blocked,
      stopActiveGoalTurnForClear: (id) => {
        host.coordinator.stop(id, { keepQueue: true, pauseQueue: false });
      },
      resolveSessionRuntimeRoute: host.resolveSessionRuntimeRoute,
      isSessionSharedTaskActive: host.isSessionSharedTaskActive,
    },
  );
  const handlers = new Map<
    string,
    (event: unknown, ...args: any[]) => unknown
  >();
  createGoalIpc({
    getGoalController: () => (closed ? null : controller),
    createLogger: () => host.logger,
    ipc: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
    },
    broadcastLocal() {},
    tapWindowBroadcast: host.emit,
  }).registerGoalHandlers();
  return {
    controller,
    limits,
    channels: [...handlers.keys()],
    handles: (channel: string) => handlers.has(channel),
    invoke(channel: string, args: unknown[]) {
      host.assertCurrent();
      const handler = handlers.get(channel);
      if (!handler) throw new Error("UNKNOWN_GOAL_CHANNEL");
      return handler(undefined, ...args);
    },
    async restore() {
      if (!closed && host.canDispatch()) await controller.resumeActiveGoals();
    },
    async idle(id: string) {
      if (!closed && host.canDispatch())
        await controller.maybeContinueActiveGoal(id);
    },
    async close() {
      closed = true;
      await controller.dispose();
    },
  };
}
