import { lstat } from "node:fs/promises";
import path from "node:path";
import { throwIpcError } from "@cindy/remote-agent/ipcValidate";
import {
  isCindyMakeManagedWorktreePath,
  makeSourceCheckoutPath,
} from "./cindyMakeSourcePaths.js";
export function createCindyMakeWorkspace(t: (key: string) => string) {
  async function assertCindyMakeWorkspace(
    userData: string,
    workingDir: string,
  ): Promise<void> {
    if (!isCindyMakeManagedWorktreePath(userData, workingDir)) return;
    try {
      const [directory, worktreeGit, sourceGit] = await Promise.all([
        lstat(workingDir),
        lstat(path.join(workingDir, ".git")),
        lstat(path.join(makeSourceCheckoutPath(userData), ".git")),
      ]);
      if (
        directory.isDirectory() &&
        !directory.isSymbolicLink() &&
        worktreeGit.isFile() &&
        sourceGit.isDirectory()
      )
        return;
    } catch {}
    throwIpcError(
      "PRECONDITION_FAILED",
      t("cindyMake.code.workspaceUnavailable"),
    );
  }

  return { assertCindyMakeWorkspace };
}
