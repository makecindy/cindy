import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

function fingerprint(value) {
  return typeof value === "string" && /^[a-f0-9]{40}$/.test(value.trim())
    ? value.trim()
    : null;
}

// Use the same Expo Updates workflow as the native build. The CI/cache hash
// uses a different entrypoint and must not be compared with the embedded hash.
export function computeSimulatorNativeFingerprint(
  projectDir,
  env = process.env,
) {
  const projectRequire = createRequire(
    join(resolve(projectDir), "package.json"),
  );
  const packagePath = projectRequire.resolve("expo-updates/package.json");
  const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
  const bin = join(dirname(packagePath), pkg.bin["expo-updates"]);
  try {
    const output = execFileSync(
      process.execPath,
      [bin, "fingerprint:generate", "--platform", "ios"],
      {
        cwd: projectDir,
        env,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: 120_000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const hash = fingerprint(JSON.parse(output).hash);
    if (!hash) throw new Error("Invalid fingerprint");
    return hash;
  } catch {
    throw new Error("Expo Updates native fingerprint calculation failed");
  }
}

/**
 * @param {{ appPath?: string, projectDir?: string, env?: Record<string, string | undefined>,
 * expectedFingerprint?: string, compute?: typeof computeSimulatorNativeFingerprint,
 * read?: (path: string) => string }} options
 */
export function inspectSimulatorNativeIdentity({
  appPath,
  projectDir,
  env,
  expectedFingerprint,
  compute = computeSimulatorNativeFingerprint,
  read = (path) => readFileSync(path, "utf8"),
}) {
  const result = {
    healthy: false,
    code: "native-unknown",
    installedFingerprint: null,
    expectedFingerprint: null,
  };
  if (!appPath) return { ...result, code: "native-missing" };
  try {
    result.installedFingerprint = fingerprint(
      read(join(appPath, "EXUpdates.bundle", "fingerprint")),
    );
    result.expectedFingerprint = fingerprint(
      expectedFingerprint ?? compute(projectDir, env),
    );
    if (!result.installedFingerprint || !result.expectedFingerprint)
      return result;
    result.healthy = result.installedFingerprint === result.expectedFingerprint;
    result.code = result.healthy ? "native-matched" : "native-mismatch";
    return result;
  } catch {
    // Unknown is never compatibility evidence. Keep CLI output free of config
    // contents or child-process diagnostics that may contain local secrets.
    return result;
  }
}
