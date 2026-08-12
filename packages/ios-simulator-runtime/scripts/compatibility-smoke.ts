import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  collectIOSSimulatorCompatibilityReport,
  compareIOSSimulatorVersions,
  createIOSSimulatorRuntime,
  evaluateIOSSimulatorCompatibilityCase,
  parseIOSSimulatorCompatibilitySelectors,
  selectIOSSimulatorCompatibilityRuntimes,
  selectIOSSimulatorNativeArchitectures,
  type IOSSimulatorCompatibilityCaseEvaluation,
  type IOSSimulatorNativeArchitecture,
} from "../src/index.js";

interface ChildResult {
  ok: boolean;
  skipped?: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  output: string;
  result: Record<string, unknown> | null;
}

interface NativeCase {
  architecture: IOSSimulatorNativeArchitecture;
  required: boolean;
  build: ChildResult;
  probe: ChildResult;
  hid: ChildResult;
  systemEdgeGestureRecognized: boolean | null;
  evaluation: IOSSimulatorCompatibilityCaseEvaluation;
}

interface RuntimeCase {
  runtime: {
    identifier: string;
    name: string;
    version: string | null;
    buildVersion: string | null;
  };
  wda: {
    smoke: ChildResult;
    recovery: ChildResult | null;
  };
  native: NativeCase[];
}

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const compatibility = await collectIOSSimulatorCompatibilityReport();
if (!compatibility.ready) {
  throw new Error(
    compatibility.error ??
      compatibility.issue ??
      "iOS Simulator environment unavailable",
  );
}

const environment = await createIOSSimulatorRuntime().inspect();
const runtimes = selectIOSSimulatorCompatibilityRuntimes(
  environment.runtimes,
  parseIOSSimulatorCompatibilitySelectors(
    process.env.CINDY_IOS_SIMULATOR_RUNTIMES,
    "CINDY_IOS_SIMULATOR_RUNTIMES",
  ),
);
if (runtimes.length === 0) {
  throw new Error("No available iOS runtime for compatibility smoke");
}

const runRecovery = process.env.CINDY_IOS_SIMULATOR_COMPAT_RECOVERY !== "0";
const runNative = process.env.CINDY_IOS_SIMULATOR_COMPAT_NATIVE !== "0";
const runNativeHid = process.env.CINDY_IOS_SIMULATOR_COMPAT_NATIVE_HID !== "0";
const requireNative =
  process.env.CINDY_IOS_SIMULATOR_COMPAT_NATIVE_REQUIRED === "1";
const architectures = runNative
  ? selectIOSSimulatorNativeArchitectures(
      process.arch,
      parseIOSSimulatorCompatibilitySelectors(
        process.env.CINDY_IOS_SIMULATOR_NATIVE_ARCHS,
        "CINDY_IOS_SIMULATOR_NATIVE_ARCHS",
      ),
    )
  : [];
const hostArchitecture = selectIOSSimulatorNativeArchitectures(
  process.arch,
  null,
)[0];
const latestRuntime =
  runtimes
    .slice()
    .sort((left, right) =>
      compareIOSSimulatorVersions(left.version, right.version),
    )
    .at(-1)?.identifier ?? null;

const builds = new Map<IOSSimulatorNativeArchitecture, ChildResult>();
for (const architecture of architectures) {
  builds.set(
    architecture,
    await runScript("scripts/build-native-sidecar.mjs", {
      CINDY_IOS_SIDECAR_ARCH: architecture,
    }),
  );
}

const cases: RuntimeCase[] = [];
for (const runtime of runtimes) {
  const runtimeSelector = runtime.version ?? runtime.identifier;
  const smoke = await runScript("scripts/real-smoke.ts", {
    CINDY_IOS_SIMULATOR_RUNTIME: runtimeSelector,
  });
  const recovery = runRecovery
    ? await runScript("scripts/real-recovery-smoke.ts", {
        CINDY_IOS_SIMULATOR_RUNTIME: runtimeSelector,
      })
    : null;
  const native: NativeCase[] = [];
  for (const architecture of architectures) {
    const build =
      builds.get(architecture) ??
      skippedResult("native sidecar build was not scheduled");
    const childEnvironment = {
      CINDY_IOS_SIMULATOR_RUNTIME: runtimeSelector,
      CINDY_IOS_SIDECAR_ARCH: architecture,
    };
    const probe = build.ok
      ? await runScript(
          "scripts/native-compatibility-probe.ts",
          childEnvironment,
        )
      : skippedResult("native sidecar build failed");
    const hid =
      build.ok && runNativeHid
        ? await runScript("scripts/native-hid-smoke.ts", childEnvironment)
        : skippedResult(
            runNativeHid
              ? "native sidecar build failed"
              : "native HID functional smoke is disabled",
          );
    const required =
      requireNative &&
      runtime.identifier === latestRuntime &&
      architecture === hostArchitecture;
    const evaluation = evaluateIOSSimulatorCompatibilityCase({
      wdaSmoke: smoke,
      wdaRecovery: recovery,
      nativeBuild: build,
      nativeProbe: probe,
      nativeHid: hid,
      requireNative: required,
    });
    native.push({
      architecture,
      required,
      build,
      probe,
      hid,
      systemEdgeGestureRecognized: readSystemEdgeResult(hid.result),
      evaluation,
    });
  }
  cases.push({
    runtime: {
      identifier: runtime.identifier,
      name: runtime.name,
      version: runtime.version,
      buildVersion: runtime.buildVersion,
    },
    wda: { smoke, recovery },
    native,
  });
}

const failedWda = cases.some(
  (entry) =>
    !entry.wda.smoke.ok ||
    (entry.wda.recovery !== null && !entry.wda.recovery.ok),
);
const failedNative = cases.some((entry) =>
  entry.native.some((nativeCase) => nativeCase.evaluation.status === "failed"),
);
const degradedCases = cases.flatMap((entry) =>
  entry.native.filter(
    (nativeCase) => nativeCase.evaluation.status === "degraded",
  ),
).length;
const ok = !failedWda && !failedNative;
process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: 2,
      ok,
      generatedAt: new Date().toISOString(),
      xcode: compatibility.xcode,
      host: compatibility.host,
      wda: compatibility.wda,
      policy: {
        packagedDefault: compatibility.nativePolicy.packagedDefault,
        nativeExecuted: runNative,
        hidFunctionalExecuted: runNative && runNativeHid,
        latestHostNativeRequired: requireNative,
        systemEdgeGestureRequired: false,
      },
      summary: {
        runtimes: cases.length,
        nativeCases: cases.reduce(
          (total, entry) => total + entry.native.length,
          0,
        ),
        degradedCases,
        fallbackReady: cases.every(
          (entry) =>
            entry.wda.smoke.ok &&
            (entry.wda.recovery === null || entry.wda.recovery.ok),
        ),
      },
      runtimes: cases,
    },
    null,
    2,
  )}\n`,
);
if (!ok) process.exitCode = 1;

function skippedResult(reason: string): ChildResult {
  return {
    ok: false,
    skipped: true,
    exitCode: null,
    signal: null,
    durationMs: 0,
    output: reason,
    result: null,
  };
}

function readSystemEdgeResult(
  result: Record<string, unknown> | null,
): boolean | null {
  const edge = result?.edge;
  if (!edge || typeof edge !== "object" || Array.isArray(edge)) return null;
  const recognized = (edge as Record<string, unknown>).systemGestureRecognized;
  return typeof recognized === "boolean" ? recognized : null;
}

function runScript(
  script: string,
  environment: Record<string, string>,
): Promise<ChildResult> {
  const tsxCli = path.resolve(
    packageRoot,
    "..",
    "..",
    "node_modules",
    "tsx",
    "dist",
    "cli.mjs",
  );
  const startedAt = Date.now();
  const child = spawn(process.execPath, [tsxCli, script], {
    cwd: packageRoot,
    env: { ...process.env, ...environment },
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ChildResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const timer = setTimeout(() => killTree(child), 20 * 60_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      finish({
        ok: false,
        exitCode: null,
        signal: null,
        durationMs: Date.now() - startedAt,
        output: sanitizeOutput(
          error instanceof Error ? error.message : String(error),
        ),
        result: null,
      });
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      const output = sanitizeOutput(Buffer.concat(chunks).toString("utf8"));
      finish({
        ok: exitCode === 0,
        exitCode,
        signal,
        durationMs: Date.now() - startedAt,
        output,
        result: parseLastJsonLine(output),
      });
    });
  });
}

function sanitizeOutput(value: string): string {
  return value
    .slice(-16 * 1024)
    .replace(
      /(?:\/Users|\/private\/var|\/var\/folders|\/tmp)\/[^\s"']+/g,
      "<path>",
    )
    .replace(/https?:\/\/127\.0\.0\.1:\d+/g, "http://127.0.0.1:<port>");
}

function parseLastJsonLine(output: string): Record<string, unknown> | null {
  for (const line of output.trimEnd().split("\n").reverse()) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Smoke scripts may print compiler/Xcode diagnostics before their JSON result.
    }
  }
  return null;
}

function killTree(child: ReturnType<typeof spawn>): void {
  if (!child.pid) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGTERM");
      return;
    } catch {
      // The process group may already have exited.
    }
  }
  child.kill("SIGTERM");
}
