import { createProjectDirectoryValidation } from "@cindy/app-runtime/projectDirectoryValidation";
import { eq } from "drizzle-orm";
import { sessions, botSessionLinks } from "@cindy/runtime-db/schema";
import { isIpcError } from "@cindy/remote-agent/shared/ipc-errors";
import type { ControlResult } from "@cindy/mcps";
import type { DbClient } from "@cindy/runtime-db";
import type { DataOwnerPushStamp } from "@cindy/maker-shared/dataOwnerPush";
import { throwIpcError } from "@cindy/remote-agent/ipcValidate";
import type { Logger } from "@cindy/maker-core";
import type { createRecentWorkdirs } from "./recentWorkdirs.js";
export interface ProjectRegistrationHost {
  logger: Logger;
  getActiveDataOwnerPushStamp(): DataOwnerPushStamp;
  isAppSessionBoundaryPending(): boolean;
  tryGetDbClient(): DbClient | null;
  dialogueWorkspaceRoots(): string[];
  normalizeRecentWorkdirPath: ReturnType<
    typeof createRecentWorkdirs
  >["normalizeRecentWorkdirPath"];
  upsertRecentWorkdir: ReturnType<
    typeof createRecentWorkdirs
  >["upsertRecentWorkdir"];
  restoreLocalProjectVisibility(
    directory: string,
    owner: DataOwnerPushStamp,
  ): Promise<boolean>;
  broadcastRegistered(directory: string, owner: DataOwnerPushStamp): void;
}

export interface LocalProjectContext {
  client: DbClient;
  owner: DataOwnerPushStamp;
  assertCurrent: () => void;
}
export function createProjectRegistration(host: ProjectRegistrationHost) {
  const {
    logger: log,
    getActiveDataOwnerPushStamp,
    isAppSessionBoundaryPending,
    tryGetDbClient,
    dialogueWorkspaceRoots,
    normalizeRecentWorkdirPath,
    upsertRecentWorkdir,
    restoreLocalProjectVisibility,
  } = host;

  const fail = (errorCode: string, message: string) => ({
    ok: false as const,
    errorCode,
    message,
  });

  /** All project operations use one captured account and validate the calling local task. */
  async function withLocalProjectContext<T extends object>(
    callerSessionId: string,
    run: (context: LocalProjectContext) => Promise<ControlResult<T, string>>,
  ): Promise<ControlResult<T, string>> {
    const client = tryGetDbClient();
    if (!client || isAppSessionBoundaryPending())
      return fail("HOST_NOT_READY", "Cindy project storage is not ready.");
    const owner = getActiveDataOwnerPushStamp();
    const isCurrent = () => {
      const current = getActiveDataOwnerPushStamp();
      return (
        !isAppSessionBoundaryPending() &&
        tryGetDbClient() === client &&
        current.dataOwnerId === owner.dataOwnerId &&
        current.ownerGeneration === owner.ownerGeneration
      );
    };
    const assertCurrent = () => {
      if (!isCurrent())
        throwIpcError(
          "PRECONDITION_FAILED",
          "The active Cindy account changed.",
        );
    };
    try {
      const [caller] = await client.drizzle
        .select({ id: sessions.id, remoteHostId: sessions.remoteHostId })
        .from(sessions)
        .where(eq(sessions.id, callerSessionId))
        .limit(1);
      if (!isCurrent())
        return fail("PRECONDITION_FAILED", "The active Cindy account changed.");
      if (!caller)
        return fail(
          "NO_SESSION_CONTEXT",
          "The calling task is not available in this account.",
        );
      if (caller.remoteHostId)
        return fail(
          "UNSUPPORTED_CAPABILITY",
          "Project registration only supports local Cindy tasks.",
        );
      // Account-generation checkpoint. Bot callers may manage projects; the
      // helper surface names the five project tools and keeps the rest of
      // control/history closed. This read must stay so an account switch during
      // the lookup still fails closed.
      await client.drizzle
        .select({ botId: botSessionLinks.botId })
        .from(botSessionLinks)
        .where(eq(botSessionLinks.sessionId, callerSessionId))
        .limit(1);
      assertCurrent();
      const result = await run({ client, owner, assertCurrent });
      assertCurrent();
      return result;
    } catch (error) {
      if (isIpcError(error)) return fail(error.code, error.message);
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT")
        return fail(
          "NOT_FOUND",
          "Directory does not exist. Create it with your file tools first.",
        );
      if (code === "ENOTDIR")
        return fail("NOT_A_DIRECTORY", "working_dir is not a directory.");
      log.warn("project operation failed", { error: String(error) });
      return fail("INTERNAL", "Could not complete the project operation.");
    }
  }

  const {
    validateLocalProjectDirectory,
    validateExistingLocalProjectDirectory,
  } = createProjectDirectoryValidation({
    dialogueWorkspaceRoots,
    normalizeRecentWorkdirPath,
  });

  /** Register only: filesystem creation and task execution remain separate agent actions. */
  async function createProject({
    callerSessionId,
    workingDir,
  }: {
    callerSessionId: string;
    workingDir: string;
  }) {
    const directory = validateLocalProjectDirectory(workingDir);
    if (!directory.ok) return directory;
    return withLocalProjectContext(callerSessionId, (context) =>
      registerProjectDirectory(directory.workingDir, context),
    );
  }

  /** Trusted host callers supply their already-authorized, owner-bound context. */
  async function registerProjectDirectory(
    workingDir: string,
    { client, owner, assertCurrent }: LocalProjectContext,
  ) {
    assertCurrent();
    const directory = validateLocalProjectDirectory(workingDir);
    if (!directory.ok) return directory;
    const physicalDirectory = await validateExistingLocalProjectDirectory(
      directory.workingDir,
    );
    if (!physicalDirectory.ok) return physicalDirectory;
    assertCurrent();
    if (
      !(await upsertRecentWorkdir(
        directory.workingDir,
        Date.now(),
        process.platform,
        client,
      ))
    ) {
      return fail("INTERNAL", "Could not register the project directory.");
    }
    assertCurrent();
    await restoreLocalProjectVisibility(directory.workingDir, owner);
    assertCurrent();
    host.broadcastRegistered(directory.workingDir, owner);
    return directory;
  }
  return {
    withLocalProjectContext,
    validateLocalProjectDirectory,
    validateExistingLocalProjectDirectory,
    createProject,
    registerProjectDirectory,
  };
}
