import { randomUUID } from "node:crypto";
import {
  TASK_TAG_PRESETS,
  type TaskTagRequest,
  type TaskTagResult,
} from "@cindy/maker-shared";
import type { DbClient } from "@cindy/runtime-db";
import type { Logger } from "@cindy/maker-core";
import type { OwnerBroadcastTap, BroadcastLocal } from "./ownerBroadcast.js";
import type { createSessionNotifications } from "./sessionNotifications.js";
export interface TaskTagsHost<Event> extends Pick<
  OwnerBroadcastTap,
  | "tapWindowBroadcast"
  | "captureDataOwnerBroadcastScope"
  | "isDataOwnerBroadcastScopeCurrent"
> {
  getDbClient(): DbClient;
  logger: Pick<Logger, "warn">;
  broadcastLocal: BroadcastLocal;
  broadcastSessionPatched: ReturnType<
    typeof createSessionNotifications
  >["broadcastSessionPatched"];
  ipcMain: {
    handle(
      channel: string,
      callback: (event: Event, ...args: any[]) => unknown,
    ): void;
  };
  assertTrustedAppRendererEvent(event: Event): void;
}

export function createTaskTags<Event>(host: TaskTagsHost<Event>) {
  const {
    getDbClient,
    logger: log,
    ipcMain,
    assertTrustedAppRendererEvent,
    tapWindowBroadcast,
    captureDataOwnerBroadcastScope,
    isDataOwnerBroadcastScopeCurrent,
    broadcastSessionPatched,
  } = host;

  const TASK_TAG_CHANNEL = "local-db:task-tags:execute";
  /**
   * All surfaces share validation, transactions and owner-scoped task patches.
   */
  async function executeTaskTags(
    request: TaskTagRequest,
    callerSessionId?: string,
  ): Promise<TaskTagResult> {
    const scope = captureDataOwnerBroadcastScope();
    const assertCurrent = () => {
      if (!isDataOwnerBroadcastScopeCurrent(scope))
        throw new Error("[NOT_FOUND] Owner changed");
    };
    assertCurrent();
    // Only known presets may claim a stable localized identity. Ordinary labels
    // retain generated IDs, including labels with the same visible name.
    const preset =
      request.action === "create" && request.presetId !== undefined
        ? TASK_TAG_PRESETS.find((tag) => tag.id === request.presetId)
        : undefined;
    if (
      request.action === "create" &&
      request.presetId !== undefined &&
      (!preset ||
        request.name !== preset.name ||
        request.color !== preset.color)
    ) {
      throw new Error("[INVALID_PARAMS] Invalid task tag preset");
    }
    const client = getDbClient();
    const result = await client.tx("taskTags.execute", {
      ...request,
      newId: preset?.id ?? randomUUID(),
      callerSessionId,
    });
    assertCurrent();
    if (
      ["create", "update", "delete", "attach", "detach"].includes(
        request.action,
      )
    ) {
      for (const row of result.sessions)
        broadcastSessionPatched(row.sessionId, { tags: row.tags }, scope);
    }
    if (
      ["create", "update", "delete", "reorder", "attach", "detach"].includes(
        request.action,
      )
    ) {
      const payload = { tags: result.tags };
      // A closed renderer must not turn an already committed write into a failed request.
      try {
        tapWindowBroadcast(
          "local-db:task-tags:changed",
          payload,
          scope.ownerStamp,
        );
      } catch {
        log.warn("task tag device-link broadcast failed");
      }
      try {
        host.broadcastLocal(
          "local-db:task-tags:changed",
          payload,
          scope.ownerStamp,
        );
      } catch {
        log.warn("task tag renderer broadcast failed");
      }
    }
    return result;
  }
  function registerTaskTagsIpc(): void {
    ipcMain.handle(TASK_TAG_CHANNEL, async (event, request: TaskTagRequest) => {
      assertTrustedAppRendererEvent(event);
      return executeTaskTags(request);
    });
  }
  return {
    TASK_TAG_CHANNEL,
    executeTaskTags,
    registerTaskTagsIpc,
  };
}
