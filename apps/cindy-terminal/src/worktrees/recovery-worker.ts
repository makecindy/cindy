import { parentPort, workerData } from "node:worker_threads";
import {
  executeRecoveryArchiveTask,
  type RecoveryArchiveTask,
} from "@cindy/worktree-core/recoveryArchiveTask";

void executeRecoveryArchiveTask(workerData as RecoveryArchiveTask).then(
  (result) => parentPort!.postMessage({ ok: true, result }),
  (error: unknown) =>
    parentPort!.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }),
);
