import type { AgentEvent, AgentKind, Logger } from "@cindy/maker-core";
import { isUnavailableFilesystemError } from "./workingDirectoryRecovery.js";
export function createWorkingDirectoryDiagnostics(host: {
  findSimilarWorkingDirectory(dir: string): Promise<string | null>;
  log: Pick<Logger, "warn">;
  broadcastToAllWindows(channel: string, payload: unknown): void;
}) {
  const { findSimilarWorkingDirectory, log, broadcastToAllWindows } = host;
  const MAKER_PUSH = { EVENT: "maker:event" };
  async function findSimilarDirOnDisk(
    workingDir: string,
  ): Promise<string | null> {
    return findSimilarWorkingDirectory(workingDir).catch((error) => {
      if (isUnavailableFilesystemError(error)) throw error;
      return null;
    });
  }

  function emitWorkDirMissingError(
    sessionId: string,
    workingDir: string,
    agentSource: AgentKind,
    reason: "not-exist" | "not-dir",
    similarPath?: string | null,
  ): void {
    const base =
      reason === "not-dir"
        ? `工作目录已不是文件夹, 无法继续: ${workingDir}`
        : `工作目录已不存在, 无法继续: ${workingDir}`;
    // JSON.stringify 把路径用引号包起来,末尾空格 / 不可见字符在引号里肉眼可见。
    const hint = similarPath
      ? ` — 注意: 磁盘上有同名但不完全一致的目录 ${JSON.stringify(similarPath)} (可能末尾带空格或大小写不同),建议在 Finder 重命名后重新选择目录。`
      : "";
    const message = base + hint;
    log.warn("send aborted: workdir missing", {
      sessionId,
      workingDir,
      reason,
      similarPath: similarPath ?? undefined,
    });
    broadcastToAllWindows(MAKER_PUSH.EVENT, {
      sessionId,
      event: {
        type: "error",
        data: { message },
        source: agentSource,
      } satisfies AgentEvent,
    });
  }

  return { findSimilarDirOnDisk, emitWorkDirMissingError };
}
