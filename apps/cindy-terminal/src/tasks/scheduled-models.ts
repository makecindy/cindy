import { createScheduledPreferenceStore } from "@cindy/app-runtime/scheduledPreferenceStore";
import type { createSessionRuntimeControl } from "@cindy/app-runtime/sessionRuntimeControl";
import { parseScheduledModelBaseline } from "@cindy/app-runtime/scheduledModelBaseline";
import {
  makerToDbAgentKind,
  normalizeDbAgentKind,
} from "@cindy/maker-shared/agent-kind-conversion";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { sessions } from "@cindy/runtime-db/schema";
import {
  performSessionAgentSwitch,
  isUserPendingAgentSwitchIntent,
} from "@cindy/im-runtime/sessionAgentSwitch";
import {
  createScheduledModelScope,
  applyScheduledModelSelection,
  resolveScheduledModelSelection,
  type ScheduledModelSelection,
} from "@cindy/app-runtime/scheduledModelSelection";
import {
  readDeviceProviderViews,
  type DeviceAgentServiceDeps,
} from "@cindy/remote-agent";
import type { TerminalTaskHost } from "./host.js";
import type { NodeDatabase } from "../database.js";

/** Uses the same persisted selection scope and route transaction as Desktop. */
export function createTerminalScheduledModels(host: {
  tasks: TerminalTaskHost;
  database: NodeDatabase;
  guard(): void;
  control: ReturnType<typeof createSessionRuntimeControl>;
  remoteInvoke?: DeviceAgentServiceDeps["remoteInvoke"];
}) {
  const { tasks, database, guard } = host;
  const resolve = async (
    selection: ScheduledModelSelection,
    location?: { agentDeviceId: string },
  ) => {
    guard();
    const providers = location
      ? await readDeviceProviderViews(
          host.remoteInvoke!,
          location.agentDeviceId,
        )
      : await tasks.models.views();
    guard();
    return resolveScheduledModelSelection(selection, providers);
  };
  const apply = async (id: string, selection: ScheduledModelSelection) =>
    applyScheduledModelSelection(selection, {
      getTarget: async () => {
        const row = await tasks.storage.get(id);
        guard();
        return row
          ? {
              ...row,
              status: row.deleted
                ? "deleted"
                : row.archived
                  ? "archived"
                  : "active",
            }
          : null;
      },
      isBusy: () => tasks.isTurnRunning(id),
      resolveSelection: async (choice) => {
        const row = await tasks.storage.get(id);
        guard();
        return resolve(
          choice,
          row?.agentDeviceId ? { agentDeviceId: row.agentDeviceId } : undefined,
        );
      },
      switchHarness: (choice) =>
        performSessionAgentSwitch(tasks.routes.deps, {
          sessionId: id,
          targetAgentKind: choice.agentKind,
          ...choice,
          applyNow: true,
          configStaged: true,
          assertSelectionCurrent: guard,
        }),
      applyModel: async (choice) => {
        const row = await tasks.storage.get(id);
        guard();
        if (!row) throw new Error("TASK_NOT_FOUND");
        if (
          row.agentKind === choice.agentKind &&
          row.model === choice.model &&
          (row.providerId ?? null) === choice.providerId &&
          (row.effort ?? null) === choice.effort &&
          (row.fastMode ?? false) === choice.fastMode
        )
          return;
        const result = await tasks.routes.deps.selectSameAgentModel!(
          id,
          {
            targetAgentKind: choice.agentKind,
            model: choice.model,
            providerId: choice.providerId,
            effort: choice.effort ?? undefined,
            fastMode: choice.fastMode,
            sameAgentSelection: true,
            configStaged: true,
          },
          true,
          guard,
        );
        if (result.deferred || result.superseded)
          throw new Error("SCHEDULED_MODEL_SELECTION_NOT_READY");
      },
    });
  const broadcastSessionRuntimeProjection = async (id: string) => {
    guard();
    const conversations = await tasks.conversations;
    const [row] = await database
      .getDbClient()
      .drizzle.select()
      .from(sessions)
      .where(eq(sessions.id, id))
      .limit(1);
    guard();
    if (row)
      conversations.notifications.broadcastSessionPatched(id, {
        ...conversations.rowMapper.projectSessionRuntimeFields({
          ...row,
          agentKind: normalizeDbAgentKind(row.agentKind),
        }),
      });
  };
  const preferences = createScheduledPreferenceStore({
    getDbClient: () => {
      guard();
      return database.getDbClient();
    },
    broadcastSessionRuntimeProjection,
    getDesktopProviderService: () => ({
      listProviders: () => tasks.models.views(),
    }),
    getActiveCatalog: () => tasks.models.activeCatalog(),
    resolveSessionRuntimeAxes: host.control.resolveSessionRuntimeAxes,
  });
  const scope = createScheduledModelScope({
    read: async (id) => {
      guard();
      const [row] = await database
        .getDbClient()
        .drizzle.select({ baseline: sessions.scheduledModelBaseline })
        .from(sessions)
        .where(eq(sessions.id, id))
        .limit(1);
      const task = await tasks.storage.get(id);
      guard();
      return row && task && !task.archived && !task.deleted
        ? {
            baseline: row.baseline,
            profile: {
              agentKind: task.agentKind,
              model: task.model,
              providerId: task.providerId ?? null,
              effort: task.effort ?? null,
              fastMode: task.fastMode ?? false,
            },
          }
        : null;
    },
    write: async (id, value) => {
      guard();
      const db = database.getDbClient().drizzle;
      const [previous] = value
        ? []
        : await db
            .select({ baseline: sessions.scheduledModelBaseline })
            .from(sessions)
            .where(eq(sessions.id, id))
            .limit(1);
      const saved = parseScheduledModelBaseline(previous?.baseline);
      guard();
      await db
        .update(sessions)
        .set({
          scheduledModelBaseline: value ? JSON.stringify(value) : null,
          ...(saved
            ? {
                agentKind: makerToDbAgentKind(saved.agentKind),
                model: saved.model,
                providerId: saved.providerId,
                effort: saved.effort ?? undefined,
                fastMode: saved.fastMode,
              }
            : {}),
        })
        .where(eq(sessions.id, id));
      guard();
      const conversations = await tasks.conversations;
      const [row] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, id))
        .limit(1);
      if (row)
        conversations.notifications.broadcastSessionPatched(id, {
          ...conversations.rowMapper.projectSessionRuntimeFields({
            ...row,
            agentKind: normalizeDbAgentKind(row.agentKind),
          }),
        });
    },
    isBusy: (id) =>
      tasks.isTurnRunning(id) ||
      isUserPendingAgentSwitchIntent(tasks.routes.pending.get(id)),
    apply: async (id, choice) => {
      await apply(id, choice);
    },
    createId: randomUUID,
    ownerEpoch: () => {
      guard();
      const owner = database.getCurrentDbClientSnapshot()!;
      return owner.userId + ":" + owner.clientEpoch;
    },
  });
  return {
    ...preferences,
    resolve,
    restore: scope.restore,
    async prepare(id: string, override: boolean) {
      if (override) await scope.begin(id);
      else await scope.restore(id);
    },
    async acquire(
      id: string,
      signal?: AbortSignal,
      choice?: ScheduledModelSelection,
      override?: boolean,
    ) {
      const release = await tasks.routes.acquireForSend(id, undefined, true);
      try {
        guard();
        signal?.throwIfAborted();
        if (choice || override) await scope.begin(id);
        else await scope.restore(id);
        const selection = choice ? await apply(id, choice) : undefined;
        guard();
        signal?.throwIfAborted();
        return selection ? { release, selection } : release;
      } catch (error) {
        release();
        throw error;
      }
    },
    async applyPi(id: string, model: string, providerId: string | null) {
      const row = await tasks.storage.get(id);
      guard();
      if (!row) throw new Error("TASK_NOT_FOUND");
      await apply(id, {
        agentKind: "pi",
        model,
        providerId,
        effort: row.effort ?? null,
        fastMode: row.fastMode ?? false,
      });
      return { status: "applied" as const };
    },
  };
}
