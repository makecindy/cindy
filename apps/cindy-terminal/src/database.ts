import { RUNTIME_DIRECTORY, terminalNodeExecutable } from './version.js';
import {waitForRetainedDbClient} from '@cindy/runtime-db/client/pendingOperations';
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRuntimeTranslator } from "@cindy/maker-shared/runtime-i18n";
import { mainLocaleResources } from "../../desktop/src/shared/mainLocaleResources.js";
import path from "node:path";
import os from "node:os";
import { fork } from "node:child_process";
import { createDbClientFactory, type DbClient } from "@cindy/runtime-db";
import {
  createDatabaseRuntime,
  type DatabaseRuntimeHost,
} from "@cindy/runtime-db/runtime";
import { createSqliteFactory } from "@cindy/runtime-db/betterSqliteFactory";
import { createDatabaseBackup } from "@cindy/runtime-db/backup";
import { createDatabaseMigrations } from "@cindy/runtime-db/migrate";
import { createSqliteVecLoader } from "@cindy/runtime-db/sqliteVecLoader";
import { createSchemaDriftDetector } from "@cindy/runtime-db/schemaDriftDetector";
import { createSchemaDriftRepair } from "@cindy/runtime-db/schemaDriftRepair";
import { createOrcaIndexCleanup } from "@cindy/runtime-db/orcaStaleIndexCleanup";
import { createOrcaLeadReconcile } from "@cindy/runtime-db/orcaStrandedLeadReconcile";
import { createCodexHistoryPromptInit } from "@cindy/runtime-db/codexHistoryPromptInit";
import { createDatabaseMaintenance } from "@cindy/runtime-db/dbSlimmingMaintenance";
import { createDatabaseMaintenanceWorker } from "@cindy/runtime-db/dbSlimmingWorkerClient";
import { createDatabaseStartupMaintenance } from "@cindy/runtime-db/dbSlimmingStartup";
import { createSessionStorage } from "@cindy/runtime-db/sessionStorage";
import {createDialogueWorkspaceSettings} from '@cindy/app-runtime/dialogueWorkspaceSettings';
import { createCurrentDbClient } from "@cindy/runtime-db/client/current";
import { createAgentInputQueueStore } from "@cindy/runtime-db/agentInputQueueSnapshots";
import type { DbLogger } from "@cindy/runtime-db/logging";
import { privateDirectory } from "./platform.js";

export interface NodeDatabaseOptions {
  userDataDirectory: string;
  ownerId: string;
  appDataRoot?: string;
  runtimeDirectory: string;
  logger: DbLogger;
  translate: DatabaseRuntimeHost["t"];
  broadcast: DatabaseRuntimeHost["broadcast"];
  reportFailure: DatabaseRuntimeHost["presentFailure"];
  dialogueWorkspaceRoots: DatabaseRuntimeHost["dialogueWorkspaceRoots"];
}

/** Platform wiring only: the Desktop startup, schema, recovery and transactions run unchanged. */
export async function openNodeDatabase(options: NodeDatabaseOptions) {
  await privateDirectory(options.userDataDirectory);
  const { logger } = options;
  const sqlite = createSqliteFactory({ logger, maskPath: () => "<private>" });
  const backup = createDatabaseBackup({ ...sqlite, logger });
  const migrations = createDatabaseMigrations({
    logger,
    backup,
    isPackaged: () => true,
    drizzleDirectory: () => path.join(options.runtimeDirectory, "drizzle"),
  });
  const extension =
    process.platform === "win32"
      ? "dll"
      : process.platform === "linux"
        ? "so"
        : "dylib";
  const vector = createSqliteVecLoader(
    () =>
      path.join(options.runtimeDirectory, "sqlite-vec", `vec0.${extension}`),
    logger,
  );
  const maintenance = createDatabaseMaintenance(sqlite);
  const maintenanceWorker = createDatabaseMaintenanceWorker({
    resolveSqliteVecExtPath: vector.resolveSqliteVecExtPath,
    fork() {
      const env: NodeJS.ProcessEnv = {};
      for (const key of [
        "PATH",
        "SystemRoot",
        "WINDIR",
        "TEMP",
        "TMP",
        "TMPDIR",
        "LANG",
        "LC_ALL",
      ]) {
        if (process.env[key] !== undefined) env[key] = process.env[key];
      }
      const child = fork(
        path.join(options.runtimeDirectory, "database-maintenance-process.mjs"),
        [],
        {
          cwd: os.tmpdir(),
          env,
          execPath: terminalNodeExecutable(),
          execArgv: [],
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          serialization: "advanced",
        },
      );
      return {
        postMessage: (message) => {
          child.send(message);
        },
        on(event, listener) {
          if (event === "exit")
            child.on("exit", (code) =>
              (listener as (code: number) => void)(code ?? -1),
            );
          else child.on(event, listener);
        },
        kill: () => child.kill(),
      };
    },
  });
  const runtime = createDatabaseRuntime({
    logger,
    sqlite,
    backup,
    migrations,
    vector,
    ...createSchemaDriftDetector(migrations.getDrizzleDir, logger),
    ...createSchemaDriftRepair(logger),
    ...createOrcaIndexCleanup(logger),
    ...createOrcaLeadReconcile(logger),
    ...createCodexHistoryPromptInit(logger),
    ...createDatabaseStartupMaintenance({
      ...maintenance,
      ...maintenanceWorker,
    }),
    userDataDirectory: () => options.userDataDirectory,
    isPackaged: () => true,
    isPersonalRuntime: () => false,
    dialogueWorkspaceRoots: options.dialogueWorkspaceRoots,
    t: options.translate,
    broadcast: options.broadcast,
    presentFailure: options.reportFailure,
    // A released server follows the existing packaged policy, which never requests a dev reset.
    confirmDatabaseReset: () => {
      throw new Error("DEVELOPMENT_DATABASE_RESET_UNAVAILABLE");
    },
    didResetDatabase: () => {
      throw new Error("DEVELOPMENT_DATABASE_RESET_UNAVAILABLE");
    },
    exit: () => {
      throw new Error("DEVELOPMENT_DATABASE_RESET_UNAVAILABLE");
    },
  });
  let client: DbClient | undefined;
  const current = createCurrentDbClient();
  try {
    const ready = await runtime.ensureReady(options.ownerId);
    if (!ready.ready)
      throw Object.assign(new Error(ready.error.message), {
        code: ready.error.code,
      });
    const dbPath = runtime.getCurrentDbPath()!;
    client = await createDbClientFactory({ createLogger: () => logger })({
      userId: options.ownerId,
      dbPath,
      appDataRoot: options.appDataRoot,
      drizzleDir: migrations.getDrizzleDir(),
      sqliteVecExtPath: vector.resolveSqliteVecExtPath(),
      betterSqliteModulePath: sqlite.resolveBetterSqliteModuleEntry(),
      nativeBinding: sqlite.resolveBetterSqliteNativeBinding(),
      workerScriptPath: path.join(
        options.runtimeDirectory,
        "database-worker.mjs",
      ),
    });
    await client.queryOne("SELECT 1");
    runtime.closeDb({ preserveSchemaMigrationLease: true });
    const db = client;
    current.setCurrentDbClient(db, options.ownerId);
    const inputQueue = createAgentInputQueueStore({ ...current, logger });
    return {
      db,
      dbPath,
      inputQueue,
      ...current,
      ...createSessionStorage(current.getDbClient),
      async close() {
        try {
          await inputQueue.flush();
        } finally {
          current.clearCurrentDbClient(db);
          try {
            await waitForRetainedDbClient(db);
            await db.dispose();
          } finally {
            runtime.closeDb();
          }
        }
      },
    };
  } catch (error) {
    current.clearCurrentDbClient(client);
    try {
      await client?.dispose();
    } finally {
      runtime.closeDb();
    }
    throw error;
  }
}

export type NodeDatabase = Awaited<ReturnType<typeof openNodeDatabase>>;

/** Standalone embedded task hosts use the same database startup as the server. */
export function openStandaloneNodeDatabase(
  profileDir: string,
  logger: DbLogger,
  language: Parameters<typeof createRuntimeTranslator>[1] = () => "en",
) {
  const translation = createRuntimeTranslator(mainLocaleResources, language);
  return openNodeDatabase({
    userDataDirectory: profileDir,
    ownerId: createHash("sha256").update(profileDir).digest("hex"),
    runtimeDirectory: RUNTIME_DIRECTORY,
    appDataRoot: path.join(profileDir, "runtime"),
    logger,
    translate: translation.t,
    dialogueWorkspaceRoots: createDialogueWorkspaceSettings({activeOwnerScopeKey:()=>profileDir,
      ownerScopedUserDataPath:(...parts)=>path.join(profileDir,...parts),createLogger:()=>logger}).dialogueWorkspaceRoots,
    broadcast() {},
    reportFailure(failure) {
      throw new Error(failure.detail);
    },
  });
}
