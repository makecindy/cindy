import { eq } from "drizzle-orm";
import { projectAutomationConsents } from "@cindy/runtime-db/schema";
import type { DbClient } from "@cindy/runtime-db";
import type { Logger } from "@cindy/maker-core";
import type { IpcHandlerRegistry } from "./ipcHandlerRegistry.js";
import type { createRowMapper } from "./rowMapper.js";
import type {
  ProjectAutomationEvent,
  ProjectAutomationLoader,
  ProjectScheduleConfig,
  ReconcileResult,
} from "./projectAutomationLoader.js";
import {
  requireObject,
  requireString,
  throwIpcError,
} from "@cindy/remote-agent/ipcValidate";
import { MAKER_INVOKE, MAKER_PUSH } from "@cindy/maker-shared/maker-channels";

export function createProjectAutomationIpc(host: {
  ipcMain: IpcHandlerRegistry & { removeHandler(channel: string): void };
  getDbClient(): DbClient;
  projectAutomationConsentToCamel: ReturnType<
    typeof createRowMapper
  >["projectAutomationConsentToCamel"];
  log: Logger;
  broadcast(channel: string, payload: unknown): void;
}) {
  const {
    ipcMain,
    getDbClient,
    projectAutomationConsentToCamel,
    log,
    broadcast,
  } = host;
  const PROJECT_AUTOMATION_INVOKE_CHANNELS: readonly string[] = [
    MAKER_INVOKE.PROJECT_AUTOMATION_RECONCILE,
    MAKER_INVOKE.PROJECT_AUTOMATION_LIST_CONSENTS,
    MAKER_INVOKE.PROJECT_AUTOMATION_REVOKE_CONSENT,
    MAKER_INVOKE.PROJECT_AUTOMATION_UPSERT_SCHEDULE,
    MAKER_INVOKE.PROJECT_AUTOMATION_REMOVE_SCHEDULE,
  ];

  let unsubscribeAutomationEvent: (() => void) | null = null;

  function rewrapProjectAutomationError(err: unknown): never {
    if (
      err instanceof Error &&
      typeof (err as { code?: unknown }).code === "string"
    ) {
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (/not found/i.test(msg)) throwIpcError("NOT_FOUND", msg);
    if (/invalid|workingDir|required|json|parse/i.test(msg)) {
      throwIpcError("INVALID_PARAMS", msg);
    }
    throwIpcError("INTERNAL", msg);
  }

  function registerProjectAutomationIpc(loader: ProjectAutomationLoader): void {
    log.info("registering maker:project-automation:* IPC handlers");

    for (const ch of PROJECT_AUTOMATION_INVOKE_CHANNELS)
      ipcMain.removeHandler(ch);
    if (unsubscribeAutomationEvent) {
      unsubscribeAutomationEvent();
      unsubscribeAutomationEvent = null;
    }

    unsubscribeAutomationEvent = loader.onEvent(
      (event: ProjectAutomationEvent) => {
        broadcast(MAKER_PUSH.PROJECT_AUTOMATION_EVENT, event);
      },
    );

    ipcMain.handle(
      MAKER_INVOKE.PROJECT_AUTOMATION_RECONCILE,
      async (_e, payload: unknown): Promise<ReconcileResult> => {
        const body = requireObject(payload, "payload");
        const workingDir = requireString(body.workingDir, "workingDir");
        try {
          return await loader.reconcile(workingDir);
        } catch (err) {
          rewrapProjectAutomationError(err);
        }
      },
    );

    ipcMain.handle(MAKER_INVOKE.PROJECT_AUTOMATION_LIST_CONSENTS, async () => {
      try {
        const rows = await getDbClient()
          .drizzle.select()
          .from(projectAutomationConsents);
        return rows.map(projectAutomationConsentToCamel);
      } catch (err) {
        rewrapProjectAutomationError(err);
      }
    });

    ipcMain.handle(
      MAKER_INVOKE.PROJECT_AUTOMATION_REVOKE_CONSENT,
      async (_e, payload: unknown): Promise<{ deleted: number }> => {
        const body = requireObject(payload, "payload");
        const workingDir = requireString(body.workingDir, "workingDir");
        try {
          await getDbClient()
            .drizzle.delete(projectAutomationConsents)
            .where(eq(projectAutomationConsents.workingDir, workingDir));
          const deleted = await loader.deleteProjectSchedules(workingDir);
          return { deleted };
        } catch (err) {
          rewrapProjectAutomationError(err);
        }
      },
    );

    ipcMain.handle(
      MAKER_INVOKE.PROJECT_AUTOMATION_UPSERT_SCHEDULE,
      async (_e, payload: unknown): Promise<ReconcileResult> => {
        const body = requireObject(payload, "payload");
        const workingDir = requireString(body.workingDir, "workingDir");
        const config = requireObject(
          body.config,
          "config",
        ) as unknown as ProjectScheduleConfig;
        try {
          return await loader.upsertSchedule(workingDir, config);
        } catch (err) {
          rewrapProjectAutomationError(err);
        }
      },
    );

    ipcMain.handle(
      MAKER_INVOKE.PROJECT_AUTOMATION_REMOVE_SCHEDULE,
      async (_e, payload: unknown): Promise<ReconcileResult> => {
        const body = requireObject(payload, "payload");
        const workingDir = requireString(body.workingDir, "workingDir");
        const id = requireString(body.id, "id");
        try {
          return await loader.removeSchedule(workingDir, id);
        } catch (err) {
          rewrapProjectAutomationError(err);
        }
      },
    );

    log.info("maker:project-automation:* IPC handlers registered");
  }

  return {
    registerProjectAutomationIpc,
    dispose() {
      unsubscribeAutomationEvent?.();
      unsubscribeAutomationEvent = null;
      for (const channel of PROJECT_AUTOMATION_INVOKE_CHANNELS)
        ipcMain.removeHandler(channel);
    },
  };
}
