import { randomUUID } from "node:crypto";
import { readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";

import { createNodeIOSSimulatorCommandRunner } from "./command-runner.js";
import { IOSSimulatorInstanceError } from "./instance-errors.js";
import { createWdaChildEnvironment } from "./wda/build-plan.js";
import type {
  IOSSimulatorCommandResult,
  IOSSimulatorCommandRunner,
} from "./types.js";

export type IOSSimulatorProjectKind =
  "cindy-mobile" | "xcode-workspace" | "xcode-project";

export interface IOSSimulatorProjectDescriptor {
  kind: IOSSimulatorProjectKind;
  worktreeRoot: string;
  projectRoot: string;
  containerPath: string | null;
}

export interface IOSSimulatorProjectBuildResult extends IOSSimulatorProjectDescriptor {
  scheme: string;
  appPath: string;
  resultBundlePath?: string | null;
  buildLogTail?: string;
  outputTruncated?: boolean;
}

/** Build failure that retains bounded diagnostics without exposing raw process state. */
export class IOSSimulatorProjectBuildError extends IOSSimulatorInstanceError {
  constructor(
    code: "APP_BUILD_FAILED" | "APP_ARTIFACT_INVALID" | "APP_ARCH_MISMATCH",
    message: string,
    readonly buildLogTail: string,
    readonly resultBundlePath: string | null,
    readonly outputTruncated = false,
    retryable = false,
  ) {
    super(code, message, retryable);
    this.name = "IOSSimulatorProjectBuildError";
  }
}

export interface IOSSimulatorProjectBuilderOptions {
  commandRunner?: IOSSimulatorCommandRunner;
  buildTimeoutMs?: number;
  /** Test/integration seam; only the shared child-process allowlist is retained. */
  environment?: NodeJS.ProcessEnv;
}

export interface IOSSimulatorMobileMetroStatus {
  healthy: boolean;
  expectedPort: number;
  expectedSource: string;
  currentSourceOnExpectedPort: boolean;
  anyMetro: boolean;
  targetSimulatorUdid: string;
  targetBooted: boolean;
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await realpath(candidate);
    return true;
  } catch {
    return false;
  }
}

async function containersIn(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        (entry.name.endsWith(".xcworkspace") ||
          entry.name.endsWith(".xcodeproj")) &&
        entry.name !== "Pods.xcodeproj" &&
        entry.name !== "project.xcworkspace",
    )
    .map((entry) => path.join(directory, entry.name));
}

function tail(value: string, maxBytes = 32 * 1024): string {
  if (maxBytes <= 0) return "";
  const bytes = Buffer.from(value, "utf8");
  return bytes.byteLength <= maxBytes
    ? value
    : bytes.subarray(-maxBytes).toString("utf8");
}

const PACKAGE_RESOLVED_ON_LINE = /\bPackage\.resolved\b/i;
const PACKAGE_RESOLVED_UNUSABLE_ON_LINE =
  /\b(missing|does not exist|couldn't be opened|could not be opened|unable to read|no such file|unable to load the resolved file)\b/i;

/**
 * Retry the resolved-file pin only when one diagnostic line names
 * Package.resolved and says that file is missing or unusable. Two
 * independent whole-log matches would retry a compile/link failure that
 * mentions the lockfile on one line and a missing header on another.
 */
function isMissingPackageResolvedDiagnostic(
  result: IOSSimulatorCommandResult,
): boolean {
  const output = `${result.stdout}\n${result.stderr}`;
  return output.split(/\r?\n/).some(
    (line) =>
      PACKAGE_RESOLVED_ON_LINE.test(line) &&
      PACKAGE_RESOLVED_UNUSABLE_ON_LINE.test(line),
  );
}

function commandLogTail(
  results: readonly IOSSimulatorCommandResult[],
  maxBytes = 32 * 1024,
): string {
  const outputTruncated = results.some((result) => result.outputTruncated);
  const output = results
    .flatMap((result) => [result.stdout, result.stderr])
    .filter(Boolean)
    .join("\n");
  if (!outputTruncated) return tail(output, maxBytes);
  const marker =
    "[Earlier command output was omitted after the capture limit was reached.]\n";
  return `${marker}${tail(output, maxBytes - Buffer.byteLength(marker))}`;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function isXcodeContainer(candidate: string): boolean {
  const extension = path.extname(candidate);
  return extension === ".xcworkspace" || extension === ".xcodeproj";
}

function summarize(values: readonly string[], limit = 8): string {
  const bounded = values
    .slice(0, limit)
    .map((value) => JSON.stringify(value.slice(0, 256)));
  const remaining = values.length - bounded.length;
  return `${bounded.join(", ")}${remaining > 0 ? `, and ${remaining} more` : ""}`;
}

function entryBuildSettings(entry: unknown): Record<string, unknown> | null {
  if (typeof entry !== "object" || entry === null) return null;
  const buildSettings = (entry as { buildSettings?: unknown }).buildSettings;
  return typeof buildSettings === "object" && buildSettings !== null
    ? (buildSettings as Record<string, unknown>)
    : null;
}

/**
 * Pick the build settings of the target that produces the installable `.app`.
 * `-showBuildSettings -json` emits one entry per target; a scheme with app +
 * extension/helper targets would otherwise pre-flight against the wrong
 * target's ARCHS. Returns null when no `.app` target is identifiable.
 */
function appTargetBuildSettings(parsed: unknown): Record<string, unknown> | null {
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  for (const entry of parsed) {
    const settings = entryBuildSettings(entry);
    if (settings) {
      const wrapper = settings.WRAPPER_NAME;
      if (typeof wrapper === "string" && wrapper.endsWith(".app")) return settings;
    }
  }
  // No `.app` target could be identified (missing/unevaluated WRAPPER_NAME).
  // Do NOT fall back to the first entry — it may be a framework/extension/test
  // bundle whose ARCHS differs from the app. Skip the preflight instead.
  return null;
}

/**
 * Derive the effective arch set from the installable `.app` target's own
 * `ARCHS − EXCLUDED_ARCHS`. Dependency targets (frameworks, extensions, Pods)
 * are deliberately not modeled: `-showBuildSettings` exposes no reliable
 * dependency graph, and a dependency that excludes an arch fails the build
 * itself with a linker error — a heuristic here would only add false positives
 * (test bundles, independent frameworks). Returns `null` when the output cannot
 * be trusted.
 */
function effectiveArchitectures(showBuildSettingsJson: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(showBuildSettingsJson);
  } catch {
    return null;
  }
  const settings = appTargetBuildSettings(parsed);
  if (!settings) return null;
  const archs = String(settings.ARCHS ?? "")
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean);
  const excluded = String(settings.EXCLUDED_ARCHS ?? "")
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (archs.length === 0) return null;
  return archs.filter((arch) => !excluded.includes(arch));
}

async function throwIfBuildCancelled(
  signal?: AbortSignal,
  resultBundlePath?: string,
): Promise<void> {
  if (!signal?.aborted) return;
  if (resultBundlePath) {
    await rm(resultBundlePath, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
  throw new IOSSimulatorInstanceError(
    "MUTATION_CANCELLED",
    "The app build was cancelled because its simulator session ended.",
    true,
  );
}

function throwIfLaunchValidationCancelled(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new IOSSimulatorInstanceError(
    "MUTATION_CANCELLED",
    "App launch validation was cancelled because its simulator session ended.",
    true,
  );
}

/** Detects Cindy Mobile or one unambiguous generic Xcode container and builds without a shell. */
export class IOSSimulatorProjectBuilder {
  readonly #runner: IOSSimulatorCommandRunner;
  readonly #buildTimeoutMs: number;
  readonly #childEnvironment: NodeJS.ProcessEnv;

  constructor(options: IOSSimulatorProjectBuilderOptions = {}) {
    this.#runner =
      options.commandRunner ?? createNodeIOSSimulatorCommandRunner();
    this.#buildTimeoutMs = options.buildTimeoutMs ?? 30 * 60_000;
    this.#childEnvironment = createWdaChildEnvironment(
      options.environment ?? process.env,
    );
  }

  async inspect(
    worktreeRoot: string,
    explicitContainerPath?: string,
  ): Promise<IOSSimulatorProjectDescriptor> {
    const root = await realpath(worktreeRoot);
    if (explicitContainerPath !== undefined) {
      const requested = explicitContainerPath.trim();
      if (!requested || !isXcodeContainer(requested)) {
        throw new IOSSimulatorInstanceError(
          "INVALID_ARGUMENT",
          "containerPath must identify an .xcworkspace or .xcodeproj inside the current worktree.",
        );
      }
      const candidate = path.isAbsolute(requested)
        ? path.normalize(requested)
        : path.resolve(root, requested);
      let containerPath: string;
      try {
        containerPath = await realpath(candidate);
      } catch {
        throw new IOSSimulatorInstanceError(
          "PROJECT_NOT_FOUND",
          "The selected Xcode container does not exist.",
        );
      }
      if (!isWithinRoot(root, containerPath)) {
        throw new IOSSimulatorInstanceError(
          "INVALID_ARGUMENT",
          "containerPath must remain inside the current worktree.",
        );
      }
      if (
        !isXcodeContainer(containerPath) ||
        !(await stat(containerPath)).isDirectory()
      ) {
        throw new IOSSimulatorInstanceError(
          "INVALID_ARGUMENT",
          "containerPath must identify an .xcworkspace or .xcodeproj directory.",
        );
      }
      return {
        kind: containerPath.endsWith(".xcworkspace")
          ? "xcode-workspace"
          : "xcode-project",
        worktreeRoot: root,
        projectRoot: path.dirname(containerPath),
        containerPath,
      };
    }

    const mobileRoot = path.join(root, "apps", "mobile");
    if (
      (await exists(path.join(mobileRoot, "app.config.js"))) &&
      (await exists(path.join(mobileRoot, "package.json")))
    ) {
      try {
        const manifest = JSON.parse(
          await readFile(path.join(mobileRoot, "package.json"), "utf8"),
        );
        if (manifest?.name === "mobile") {
          return {
            kind: "cindy-mobile",
            worktreeRoot: root,
            projectRoot: mobileRoot,
            containerPath: null,
          };
        }
      } catch {
        // A malformed manifest is not sufficient proof of the Cindy Mobile adapter.
      }
    }

    const candidates = [
      ...(await containersIn(root)),
      ...(await containersIn(path.join(root, "ios"))),
    ];
    const workspaces = candidates.filter((candidate) =>
      candidate.endsWith(".xcworkspace"),
    );
    const preferred = workspaces.length > 0 ? workspaces : candidates;
    if (preferred.length === 0) {
      throw new IOSSimulatorInstanceError(
        "PROJECT_NOT_FOUND",
        "No iOS Xcode project was found in the current worktree.",
      );
    }
    if (preferred.length !== 1) {
      const available = preferred.map((candidate) =>
        path.relative(root, candidate),
      );
      throw new IOSSimulatorInstanceError(
        "AMBIGUOUS_XCODE_PROJECT",
        `Multiple Xcode containers were found. Pass containerPath explicitly. Available containers: ${summarize(available)}.`,
      );
    }
    const containerPath = await realpath(preferred[0]!);
    return {
      kind: containerPath.endsWith(".xcworkspace")
        ? "xcode-workspace"
        : "xcode-project",
      worktreeRoot: root,
      projectRoot: path.dirname(containerPath),
      containerPath,
    };
  }

  async build(input: {
    worktreeRoot: string;
    derivedDataPath: string;
    containerPath?: string;
    scheme?: string;
    signal?: AbortSignal;
    /** Target simulator architecture; when set, the build is pre-flighted so an unmatchable artifact fails before compiling. */
    expectedArch?: "arm64" | "x86_64";
    /** Shared SPM checkout root; reuses cloned packages across sessions instead of re-cloning per build. */
    clonedSourcePackagesDirPath?: string;
  }): Promise<IOSSimulatorProjectBuildResult> {
    await throwIfBuildCancelled(input.signal);
    const project = await this.inspect(input.worktreeRoot, input.containerPath);
    await throwIfBuildCancelled(input.signal);
    if (project.kind === "cindy-mobile") {
      const result = await this.#runner.run(
        "pnpm",
        ["mobile:sim:rebuild", "--", "--force-build", "--build-only"],
        {
          cwd: project.worktreeRoot,
          timeoutMs: this.#buildTimeoutMs,
          maxBufferBytes: 1024 * 1024,
          signal: input.signal,
          env: this.#childEnvironment,
        },
      );
      await throwIfBuildCancelled(input.signal);
      if (result.exitCode !== 0) {
        throw new IOSSimulatorProjectBuildError(
          "APP_BUILD_FAILED",
          "Cindy Mobile could not be built.",
          commandLogTail([result]),
          null,
          Boolean(result.outputTruncated),
          true,
        );
      }
      const products = path.join(
        project.projectRoot,
        "ios",
        "build",
        "Build",
        "Products",
        "Debug-iphonesimulator",
      );
      const apps = (await readdir(products)).filter((name) =>
        name.endsWith(".app"),
      );
      await throwIfBuildCancelled(input.signal);
      if (apps.length !== 1) {
        throw new IOSSimulatorProjectBuildError(
          "APP_ARTIFACT_INVALID",
          "The Cindy Mobile build did not produce one unambiguous app artifact.",
          commandLogTail([result]),
          null,
          Boolean(result.outputTruncated),
        );
      }
      const appPath = await realpath(path.join(products, apps[0]!));
      await throwIfBuildCancelled(input.signal);
      return {
        ...project,
        scheme: apps[0]!.slice(0, -4),
        appPath,
        resultBundlePath: null,
        buildLogTail: commandLogTail([result]),
        outputTruncated: Boolean(result.outputTruncated),
      };
    }

    const containerFlag =
      project.kind === "xcode-workspace" ? "-workspace" : "-project";
    const list = await this.#runner.run(
      "xcodebuild",
      ["-list", "-json", containerFlag, project.containerPath!],
      {
        cwd: project.projectRoot,
        timeoutMs: 60_000,
        maxBufferBytes: 1024 * 1024,
        signal: input.signal,
        env: this.#childEnvironment,
      },
    );
    await throwIfBuildCancelled(input.signal);
    if (list.exitCode !== 0 || list.outputTruncated) {
      throw new IOSSimulatorProjectBuildError(
        "APP_BUILD_FAILED",
        "Xcode could not inspect the project.",
        commandLogTail([list]),
        null,
        Boolean(list.outputTruncated),
        true,
      );
    }
    let schemes: string[] = [];
    try {
      const parsed = JSON.parse(list.stdout) as Record<
        string,
        { schemes?: unknown }
      >;
      const section = parsed.workspace ?? parsed.project;
      schemes = Array.isArray(section?.schemes)
        ? section.schemes.filter(
            (value): value is string =>
              typeof value === "string" && value.length > 0,
          )
        : [];
    } catch {
      schemes = [];
    }
    const requestedScheme = input.scheme?.trim();
    const scheme = requestedScheme || (schemes.length === 1 ? schemes[0]! : "");
    if (!scheme || (!requestedScheme && schemes.length !== 1)) {
      throw new IOSSimulatorInstanceError(
        "AMBIGUOUS_XCODE_PROJECT",
        schemes.length === 0
          ? "No shared Xcode schemes are available for the selected container."
          : `Select one shared Xcode scheme before building. Available schemes: ${summarize(schemes)}.`,
      );
    }
    if (requestedScheme && !schemes.includes(scheme)) {
      throw new IOSSimulatorInstanceError(
        "AMBIGUOUS_XCODE_PROJECT",
        `The selected Xcode scheme is unavailable. Available schemes: ${summarize(schemes)}.`,
      );
    }
    const commonArgs = [
      containerFlag,
      project.containerPath!,
      "-scheme",
      scheme,
      "-configuration",
      "Debug",
      "-destination",
      "generic/platform=iOS Simulator",
      "-derivedDataPath",
      input.derivedDataPath,
      ...(input.clonedSourcePackagesDirPath
        ? ["-clonedSourcePackagesDirPath", input.clonedSourcePackagesDirPath]
        : []),
    ];
    if (input.expectedArch) {
      const archSettings = await this.#runner.run(
        "xcodebuild",
        [...commonArgs, "-showBuildSettings", "-json"],
        {
          cwd: project.projectRoot,
          timeoutMs: 60_000,
          maxBufferBytes: 4 * 1024 * 1024,
          signal: input.signal,
          env: this.#childEnvironment,
        },
      );
      await throwIfBuildCancelled(input.signal);
      const effective =
        archSettings.exitCode === 0 && !archSettings.outputTruncated
          ? effectiveArchitectures(archSettings.stdout)
          : null;
      if (effective && !effective.includes(input.expectedArch)) {
        throw new IOSSimulatorProjectBuildError(
          "APP_ARCH_MISMATCH",
          `The build would produce architectures [${effective.join(", ")}], but the target simulator needs ${input.expectedArch}. Check whether a dependency excludes ${input.expectedArch} (for example EXCLUDED_ARCHS or an arm64-less binary framework).`,
          commandLogTail([archSettings]),
          null,
          Boolean(archSettings.outputTruncated),
        );
      }
    }
    const resultBundlePath = path.join(
      input.derivedDataPath,
      `CindyBuild-${randomUUID()}.xcresult`,
    );
    let build = await this.#runner.run(
      "xcodebuild",
      [
        ...commonArgs,
        "-onlyUsePackageVersionsFromResolvedFile",
        "-resultBundlePath",
        resultBundlePath,
        "build",
      ],
      {
        cwd: project.projectRoot,
        timeoutMs: this.#buildTimeoutMs,
        maxBufferBytes: 1024 * 1024,
        signal: input.signal,
        env: this.#childEnvironment,
      },
    );
    await throwIfBuildCancelled(input.signal, resultBundlePath);
    if (build.exitCode !== 0 && isMissingPackageResolvedDiagnostic(build)) {
      // Only retry when Xcode says the resolved file is missing or unusable.
      // A generic compile/link failure that happens to mention Package.resolved
      // must not pay for a second full build. The failed build may have written
      // its .xcresult; -resultBundlePath requires a non-existent path, so
      // remove it before retrying.
      await rm(resultBundlePath, { recursive: true, force: true }).catch(
        () => undefined,
      );
      build = await this.#runner.run(
        "xcodebuild",
        [...commonArgs, "-resultBundlePath", resultBundlePath, "build"],
        {
          cwd: project.projectRoot,
          timeoutMs: this.#buildTimeoutMs,
          maxBufferBytes: 1024 * 1024,
          signal: input.signal,
          env: this.#childEnvironment,
        },
      );
      await throwIfBuildCancelled(input.signal, resultBundlePath);
    }
    const availableResultBundlePath = (await exists(resultBundlePath))
      ? resultBundlePath
      : null;
    await throwIfBuildCancelled(input.signal, resultBundlePath);
    if (build.exitCode !== 0) {
      throw new IOSSimulatorProjectBuildError(
        "APP_BUILD_FAILED",
        "The Xcode project could not be built.",
        commandLogTail([build]),
        availableResultBundlePath,
        Boolean(build.outputTruncated),
        true,
      );
    }
    const settings = await this.#runner.run(
      "xcodebuild",
      [...commonArgs, "-showBuildSettings", "-json"],
      {
        cwd: project.projectRoot,
        timeoutMs: 60_000,
        maxBufferBytes: 4 * 1024 * 1024,
        signal: input.signal,
        env: this.#childEnvironment,
      },
    );
    await throwIfBuildCancelled(input.signal, resultBundlePath);
    if (settings.exitCode !== 0 || settings.outputTruncated) {
      throw new IOSSimulatorProjectBuildError(
        "APP_ARTIFACT_INVALID",
        "Xcode build settings are unavailable.",
        commandLogTail([build, settings]),
        availableResultBundlePath,
        Boolean(build.outputTruncated || settings.outputTruncated),
      );
    }
    let appPaths: string[] = [];
    try {
      const parsed = JSON.parse(settings.stdout) as Array<{
        buildSettings?: Record<string, unknown>;
      }>;
      appPaths = parsed.flatMap((entry) => {
        const directory = entry.buildSettings?.TARGET_BUILD_DIR;
        const wrapper = entry.buildSettings?.WRAPPER_NAME;
        return typeof directory === "string" &&
          typeof wrapper === "string" &&
          wrapper.endsWith(".app")
          ? [path.join(directory, wrapper)]
          : [];
      });
    } catch {
      appPaths = [];
    }
    const uniqueApps = [...new Set(appPaths)];
    if (uniqueApps.length !== 1 || !(await exists(uniqueApps[0]!))) {
      throw new IOSSimulatorProjectBuildError(
        "APP_ARTIFACT_INVALID",
        "The Xcode build did not produce one unambiguous app artifact.",
        commandLogTail([build]),
        availableResultBundlePath,
        Boolean(build.outputTruncated),
      );
    }
    await throwIfBuildCancelled(input.signal, resultBundlePath);
    const appPath = await realpath(uniqueApps[0]!);
    await throwIfBuildCancelled(input.signal, resultBundlePath);
    return {
      ...project,
      scheme,
      appPath,
      resultBundlePath: availableResultBundlePath,
      buildLogTail: commandLogTail([build]),
      outputTruncated: Boolean(build.outputTruncated),
    };
  }

  /**
   * Cindy Mobile's development client is compiled to Metro 8081. Reuse the
   * repository-owned whoami contract instead of copying lsof/ps fingerprint
   * logic into the generic simulator runtime.
   */
  async validateLaunch(
    worktreeRoot: string,
    simulatorUdid: string,
    signal?: AbortSignal,
  ): Promise<IOSSimulatorMobileMetroStatus | null> {
    throwIfLaunchValidationCancelled(signal);
    const project = await this.inspect(worktreeRoot);
    throwIfLaunchValidationCancelled(signal);
    if (project.kind !== "cindy-mobile") return null;
    const exactSimulatorUdid = simulatorUdid.trim().toUpperCase();
    if (
      !/^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/.test(exactSimulatorUdid)
    ) {
      throw new IOSSimulatorInstanceError(
        "INVALID_ARGUMENT",
        "simulatorUdid must be an exact simulator UUID",
      );
    }
    const result = await this.#runner.run(
      "pnpm",
      ["mobile:sim:whoami", "--", "--json", "--udid", exactSimulatorUdid],
      {
        cwd: project.worktreeRoot,
        timeoutMs: 60_000,
        maxBufferBytes: 2 * 1024 * 1024,
        signal,
        env: this.#childEnvironment,
      },
    );
    throwIfLaunchValidationCancelled(signal);
    const lines = `${result.stdout}\n${result.stderr}`
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    let status: IOSSimulatorMobileMetroStatus | null = null;
    for (const line of lines.toReversed()) {
      try {
        const parsed = JSON.parse(
          line,
        ) as Partial<IOSSimulatorMobileMetroStatus>;
        if (
          typeof parsed.healthy === "boolean" &&
          Number.isSafeInteger(parsed.expectedPort) &&
          typeof parsed.expectedSource === "string" &&
          typeof parsed.currentSourceOnExpectedPort === "boolean" &&
          typeof parsed.anyMetro === "boolean" &&
          parsed.targetSimulatorUdid?.trim().toUpperCase() ===
            exactSimulatorUdid &&
          parsed.targetBooted === true
        ) {
          status = parsed as IOSSimulatorMobileMetroStatus;
          break;
        }
      } catch {
        // The script keeps its human-readable output; only the final JSON line is the contract.
      }
    }
    if (result.exitCode !== 0 || !status?.healthy) {
      throw new IOSSimulatorInstanceError(
        "METRO_NOT_READY",
        "Cindy Mobile is not installed on the target simulator, or Metro 8081 is not owned by this worktree or its source fingerprint is stale.",
        true,
      );
    }
    return status;
  }

  /** Read a bounded xcresult JSON payload on demand; callers chunk the in-memory result. */
  async readXcresult(
    resultBundlePath: string,
    maxBufferBytes = 2 * 1024 * 1024,
    signal?: AbortSignal,
  ): Promise<string> {
    const result = await this.#runner.run(
      "xcrun",
      ["xcresulttool", "get", "--path", resultBundlePath, "--format", "json"],
      {
        timeoutMs: 60_000,
        maxBufferBytes,
        env: this.#childEnvironment,
        signal,
      },
    );
    if (signal?.aborted) {
      throw new IOSSimulatorInstanceError(
        "MUTATION_CANCELLED",
        "The Xcode result bundle read was cancelled because the simulator host is shutting down.",
        true,
      );
    }
    if (result.exitCode !== 0) {
      throw new IOSSimulatorInstanceError(
        "APP_BUILD_FAILED",
        "The Xcode result bundle could not be read.",
        true,
      );
    }
    return tail(`${result.stdout}\n${result.stderr}`, maxBufferBytes);
  }
}
