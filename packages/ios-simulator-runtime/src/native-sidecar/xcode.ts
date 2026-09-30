import { createNodeIOSSimulatorCommandRunner } from "../command-runner.js";
import type { IOSSimulatorCommandRunner } from "../types.js";
import { normalizeIOSSimulatorDeveloperDirectory } from "./xcode-layout.mjs";
export {
  normalizeIOSSimulatorDeveloperDirectory,
  iosSimulatorKitFrameworkDirectories,
  resolveIOSSimulatorKitBinary,
} from "./xcode-layout.mjs";

/** Never search other installations or change the machine-wide selection. */
export async function resolveIOSSimulatorDeveloperDirectory(
  options: {
    developerDirectory?: string | null;
    environment?: NodeJS.ProcessEnv;
    commandRunner?: IOSSimulatorCommandRunner;
  } = {},
): Promise<string> {
  const configured =
    options.developerDirectory ??
    (options.environment ?? process.env).DEVELOPER_DIR;
  if (configured?.trim())
    return normalizeIOSSimulatorDeveloperDirectory(configured);
  const selected = await (
    options.commandRunner ?? createNodeIOSSimulatorCommandRunner()
  ).run("/usr/bin/xcode-select", ["-p"], {
    timeoutMs: 5_000,
    maxBufferBytes: 16_384,
  });
  if (selected.exitCode !== 0 || selected.outputTruncated) {
    throw new Error("The selected Xcode Developer directory is unavailable");
  }
  return normalizeIOSSimulatorDeveloperDirectory(selected.stdout);
}
