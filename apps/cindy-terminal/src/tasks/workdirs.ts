import path from "node:path";
import type { Logger } from "@cindy/maker-core";
import { createWorkingDirectoryRecovery } from "@cindy/app-runtime/workingDirectoryRecovery";
import { createDialogueRecoveryWorkspace } from "@cindy/app-runtime/dialogueRecoveryWorkspace";
import { createWorkingDirectoryPreflight } from "@cindy/app-runtime/workingDirectoryPreflight";
import { createWorkingDirectoryDiagnostics } from "@cindy/app-runtime/workingDirectoryDiagnostics";
import { createCindyMakeWorkspace } from "@cindy/app-runtime/cindyMakeWorkspace";
import { isCindyMakeManagedWorktreePath } from "@cindy/app-runtime/cindyMakeSourcePaths";
import { MainProcessWorkdirProbeClient } from "@cindy/worktree-core/workdirProbe";
import { createWorkdirOperations } from "@cindy/worktree-core/workdirOperations";
import { managedWorktreeBaseRepo } from "@cindy/maker-shared/worktree-paths";

type Preflight = Parameters<typeof createWorkingDirectoryPreflight>[0];
/** Original bounded probes, recovery state and send preflight, owned by this profile. */
export function createTerminalWorkdirs(host: {
  profileDir: string;
  logger: Logger;
  dialogueWorkspaceRoots(): string[];
  assertCurrent(): void;
  readBoundWorkingDir: Preflight["readBoundWorkingDir"];
  getManagedWorktreeReadinessForSession: Preflight["getManagedWorktreeReadinessForSession"];
  listActiveSessions: Preflight["listActiveSessions"];
  emit(channel: string, payload: unknown): void;
  t(key: string): string;
}) {
  const probe = new MainProcessWorkdirProbeClient({ log: host.logger });
  const operations = createWorkdirOperations(probe);
  const fallback = createDialogueRecoveryWorkspace({
    ownerScopedUserDataPath: (...parts) => path.join(host.profileDir, ...parts),
    dialogueWorkspaceRoots: host.dialogueWorkspaceRoots,
  });
  const recovery = createWorkingDirectoryRecovery(
    {
      stat: operations.statWorkingDirectory,
      mkdir: operations.mkdirWorkingDirectory,
      realpath: operations.realpathWorkingDirectory,
      requiredRoot: fallback.requiredDialogueRecoveryRoot,
      findFallback: fallback.findDialogueRecoveryWorkspace,
    },
    fallback.allocateDialogueRecoveryWorkspace,
    host.logger,
  );
  const diagnostics = createWorkingDirectoryDiagnostics({
    ...operations,
    log: host.logger,
    broadcastToAllWindows: host.emit,
  });
  const preflight = createWorkingDirectoryPreflight({
    ...operations,
    ...diagnostics,
    ...createCindyMakeWorkspace(host.t),
    workingDirectoryRecovery: recovery,
    readBoundWorkingDir: host.readBoundWorkingDir,
    getUserDataPath: () => host.profileDir,
    isCindyMakeWorktreePath: isCindyMakeManagedWorktreePath,
    getManagedWorktreeBasePath: managedWorktreeBaseRepo,
    getManagedWorktreeReadinessForSession:
      host.getManagedWorktreeReadinessForSession,
    listActiveSessions: host.listActiveSessions,
    workdirLog: host.logger,
    log: host.logger,
  });
  return {
    ...operations,
    recovery,
    async check(...args: Parameters<typeof preflight>) {
      host.assertCurrent();
      const result = await preflight(...args);
      host.assertCurrent();
      return result;
    },
    close() {
      recovery.clear();
      probe.dispose();
    },
  };
}
