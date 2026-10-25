import { createGitSnapshotHost } from "@cindy/app-runtime/gitSnapshotHost";
import { createCodexFileRewindExecutor } from '@cindy/app-runtime/codexFileRewindExecutor';
import { createCodexFileRestoreExecutor } from '@cindy/app-runtime/codexFileRestoreExecutor';
import { createGitSnapshotService } from "@cindy/app-runtime/gitSnapshotService";
import { createSnapshotGitIsolation } from "@cindy/app-runtime/isolatedGitExec";
import { createSnapshotFileFilter } from "@cindy/app-runtime/snapshotFileFilter";
import { createSavepointRefs } from "@cindy/app-runtime/savepointRefs";
import { createProjectGitBootstrap } from "@cindy/app-runtime/projectGitBootstrap";
import { createGitSafetySettingsStore } from "@cindy/app-runtime/gitSafetySettingsStore";
import { createDirectoryProbe } from "@cindy/worktree-core/detectCwd";
import { createCwdProbeScheduler } from "@cindy/worktree-core/cwdProbeScheduler";
import { MainProcessWorkdirProbeClient } from "@cindy/worktree-core/workdirProbe";
import { createGitExecutor } from "@cindy/worktree-core/gitExec";
import { createExecFileDiagnostics } from "@cindy/worktree-core/execFileDiagnostics";
import { GitExecError } from "@cindy/worktree-core/gitTypes";
import { gitPathOutput } from "@cindy/worktree-core/gitPathOutput";
import { managedWorktreeBaseRepo } from "@cindy/maker-shared/worktree-paths";
import { withCrossProcessLock } from "@cindy/remote-agent/crossProcessLock";
import { killProcessTree } from "@cindy/maker-scheduler/proc-util";
import type { Logger } from "@cindy/maker-core";
import type { NodeDatabase } from "../database.js";

/** The same savepoint kernel and turn coordinator as Desktop, with Node OS ports. */
export function createTerminalGitSnapshots(options: {
  dataRoot: string;
  database: NodeDatabase;
  logger: Logger;
  assertCurrent(): void;
  maker: Parameters<
    ReturnType<typeof createGitSnapshotHost>["createGitSnapshotCoordinator"]
  >[0];
  isAgentOneShotRouteDisabled: Parameters<
    typeof createGitSnapshotHost
  >[0]["isAgentOneShotRouteDisabled"];
}) {
  const log = options.logger;
  const git = createGitExecutor({
    withCrossProcessLock,
    killProcessTree,
    log,
    ...createExecFileDiagnostics(log),
  });
  const probe = new MainProcessWorkdirProbeClient({ log });
  const directory = createDirectoryProbe({
    ...git,
    GitExecError,
    gitPathOutput,
    createCwdProbeScheduler,
    getManagedWorktreeBasePath: managedWorktreeBaseRepo,
    realpathWorkingDirectory: async (directory) => {
      options.assertCurrent();
      const result = await probe.probe(directory, directory, 5_000, "realpath");
      if (!result.ok)
        throw Object.assign(new Error("Working directory probe failed"), {
          code: result.code,
        });
      if (!result.path) throw new Error("INVALID_RESOLVED_DIRECTORY");
      return result.path;
    },
  });
  const createLogger = () => log;
  const isolation = createSnapshotGitIsolation(git);
  const refs = createSavepointRefs({ ...git, createLogger });
  const files = createSnapshotFileFilter(isolation);
  const service = createGitSnapshotService({
    ...git,
    ...isolation,
    ...refs,
    ...files,
    createLogger,
  });
  const bootstrap = createProjectGitBootstrap({
    ...git,
    ...directory,
    ...service,
    createLogger,
  });
  const settings = createGitSafetySettingsStore({
    userDataDirectory: () => options.dataRoot,
    logger: log,
  });
  const host = createGitSnapshotHost({
    ...service,
    ...bootstrap,
    ...directory,
    ...settings,
    createLogger,
    userDataDirectory: () => options.dataRoot,
    getDbClient: () => {
      options.assertCurrent();
      return options.database.getDbClient();
    },
    isAgentOneShotRouteDisabled: options.isAgentOneShotRouteDisabled,
  });
  const coordinator = host.createGitSnapshotCoordinator(options.maker);
  const pending = new Set<Promise<unknown>>();
  let closing = false;
  function tracked<T>(work: () => Promise<T>): Promise<T> {
    if (closing) return Promise.reject(new Error("GIT_SNAPSHOT_HOST_CLOSED"));
    options.assertCurrent();
    const result = Promise.resolve().then(work);
    pending.add(result);
    void result.then(
      () => pending.delete(result),
      () => pending.delete(result),
    );
    return result;
  }
  return {
    ...settings,
    ...service,
    ...createCodexFileRewindExecutor({...git, ...service, GitExecError}),
    ...createCodexFileRestoreExecutor({...git, ...service, ...files, GitExecError, createLogger}),
    gitExec: git.gitExec,
    detectCwd: directory.detectCwd,
    ensureProjectGitInitialized: (
      ...args: Parameters<typeof bootstrap.ensureProjectGitInitialized>
    ) => tracked(() => bootstrap.ensureProjectGitInitialized(...args)),
    coordinator: {
      onTurnStart: (id: string) => tracked(() => coordinator.onTurnStart(id)),
      onTurnEnd: (id: string) => tracked(() => coordinator.onTurnEnd(id)),
      hasPendingTurnStart: (id: string) => coordinator.hasPendingTurnStart(id),
      onTurnAbort: (id: string) => coordinator.onTurnAbort(id),
      onSessionClosed: (id: string) => coordinator.onSessionClosed(id),
    },
    async close() {
      closing = true;
      await Promise.allSettled([...pending]);
      probe.dispose();
    },
  };
}
