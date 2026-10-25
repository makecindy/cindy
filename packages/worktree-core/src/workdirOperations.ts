import path from "node:path";
import type { MainProcessWorkdirProbeClient } from "./workdirProbe.js";
import type { WorkdirProbeRequest } from "./workdirProbeProtocol.js";
export function createWorkdirOperations(
  workdirProbeHostClient: MainProcessWorkdirProbeClient,
) {
  /** Bounded filesystem identity probe for local cwd recovery; never expose paths to a controller. */
  async function directoryOperation(
    dir: string,
    kind: WorkdirProbeRequest["kind"],
  ) {
    const result = await workdirProbeHostClient.probe(
      dir,
      path.resolve(dir),
      5_000,
      kind,
    );
    if (!result.ok)
      throw Object.assign(new Error("Working directory probe failed"), {
        code: result.code,
      });
    return result;
  }

  async function statWorkingDirectory(
    dir: string,
  ): Promise<{ isDirectory(): boolean; dev?: number }> {
    const result = await directoryOperation(dir, "probe");
    return { isDirectory: () => result.isDirectory, dev: result.device };
  }

  async function mkdirWorkingDirectory(dir: string): Promise<void> {
    await directoryOperation(dir, "mkdir");
  }

  async function realpathWorkingDirectory(dir: string): Promise<string> {
    const result = await directoryOperation(dir, "realpath");
    if (typeof result.path !== "string")
      throw new Error("Invalid resolved directory");
    return result.path;
  }

  async function findSimilarWorkingDirectory(
    dir: string,
  ): Promise<string | null> {
    return (await directoryOperation(dir, "similar")).path ?? null;
  }

  return {
    statWorkingDirectory,
    mkdirWorkingDirectory,
    realpathWorkingDirectory,
    findSimilarWorkingDirectory,
  };
}
