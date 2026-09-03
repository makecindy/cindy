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
  /** Xcode project queries may resolve a cold SPM graph before compilation starts. */
  inspectionTimeoutMs?: number;
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
const PACKAGE_RESOLVED_REQUIRED_DIAGNOSTIC =
  /\ba resolved file is required when automatic dependency resolution is disabled and should be placed at .*?\bPackage\.resolved\b/i;
const RESOLVED_FILE_PIN = "-onlyUsePackageVersionsFromResolvedFile";
const PRIMARY_APPLICATION_PRODUCT_TYPE = "com.apple.product-type.application";
const XCRESULT_LEGACY_OBJECT_REQUIRED = /--legacy flag is required/i;
const EXACT_SIMULATOR_UDID = /^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/;

function normalizeExactSimulatorUdid(simulatorUdid: string): string {
  const exactSimulatorUdid = simulatorUdid.trim().toUpperCase();
  if (!EXACT_SIMULATOR_UDID.test(exactSimulatorUdid)) {
    throw new IOSSimulatorInstanceError(
      "INVALID_ARGUMENT",
      "simulatorUdid must be an exact simulator UUID",
    );
  }
  return exactSimulatorUdid;
}

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
  if (
    output
      .split(/\r?\n/)
      .some(
        (line) =>
          PACKAGE_RESOLVED_ON_LINE.test(line) &&
          PACKAGE_RESOLVED_UNUSABLE_ON_LINE.test(line),
      )
  ) {
    return true;
  }
  // Xcode 26.5 uses this wording for every xcodebuild action, including
  // `-list` and `-showBuildSettings`. Normalize whitespace so a wrapped
  // diagnostic remains one logical record without broadening the fallback to
  // unrelated failures that merely mention Package.resolved.
  return PACKAGE_RESOLVED_REQUIRED_DIAGNOSTIC.test(output.replace(/\s+/g, " "));
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
 * Pick the build settings of the primary installable application target.
 * App Clips and Watch apps also use `.app` wrappers, so PRODUCT_TYPE is the
 * authoritative discriminator when Xcode provides it. The wrapper-only path
 * is retained for older/synthetic output that omits PRODUCT_TYPE entirely.
 */
function primaryApplicationBuildSettings(
  parsed: unknown,
): Record<string, unknown> | null {
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const entries = parsed.flatMap((entry) => {
    const settings = entryBuildSettings(entry);
    return settings ? [settings] : [];
  });
  const typedEntries = entries.filter(
    (settings) => typeof settings.PRODUCT_TYPE === "string",
  );
  if (typedEntries.length > 0) {
    const primaryApplications = typedEntries.filter(
      (settings) => settings.PRODUCT_TYPE === PRIMARY_APPLICATION_PRODUCT_TYPE,
    );
    return primaryApplications.length === 1 ? primaryApplications[0]! : null;
  }
  const legacyAppTargets = entries.filter((settings) => {
    const wrapper = settings.WRAPPER_NAME;
    return typeof wrapper === "string" && wrapper.endsWith(".app");
  });
  // No unique primary target could be identified. Do NOT guess: the first app
  // may be a helper whose ARCHS differs from the installable product. The
  // actual build/artifact validation remains authoritative.
  return legacyAppTargets.length === 1 ? legacyAppTargets[0]! : null;
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
function effectiveArchitectures(
  showBuildSettingsJson: string,
): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(showBuildSettingsJson);
  } catch {
    return null;
  }
  const settings = primaryApplicationBuildSettings(parsed);
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
  resultBundlePath?: string | null,
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
  readonly #inspectionTimeoutMs: number;
  readonly #childEnvironment: NodeJS.ProcessEnv;

  constructor(options: IOSSimulatorProjectBuilderOptions = {}) {
    this.#runner =
      options.commandRunner ?? createNodeIOSSimulatorCommandRunner();
    this.#buildTimeoutMs = options.buildTimeoutMs ?? 30 * 60_000;
    this.#inspectionTimeoutMs = options.inspectionTimeoutMs ?? 5 * 60_000;
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
    simulatorUdid: string;
    containerPath?: string;
    scheme?: string;
    signal?: AbortSignal;
    /** Target simulator architecture; when set, the build is pre-flighted so an unmatchable artifact fails before compiling. */
    expectedArch?: "arm64" | "x86_64";
    /** Shared SPM checkout root; reuses cloned packages across sessions instead of re-cloning per build. */
    clonedSourcePackagesDirPath?: string;
  }): Promise<IOSSimulatorProjectBuildResult> {
    await throwIfBuildCancelled(input.signal);
    const exactSimulatorUdid = normalizeExactSimulatorUdid(input.simulatorUdid);
    const project = await this.inspect(input.worktreeRoot, input.containerPath);
    await throwIfBuildCancelled(input.signal);
    if (project.kind === "cindy-mobile") {
      const result = await this.#runner.run(
        "pnpm",
        [
          "mobile:sim:rebuild",
          "--",
          "--force-build",
          "--build-only",
          "--udid",
          exactSimulatorUdid,
        ],
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
    const clonedSourcePackagesArgs = input.clonedSourcePackagesDirPath
      ? ["-clonedSourcePackagesDirPath", input.clonedSourcePackagesDirPath]
      : [];
    let useResolvedFilePin = true;
    const runXcodeWithResolvedFilePolicy = async (
      args: readonly string[],
      options: Parameters<IOSSimulatorCommandRunner["run"]>[2],
      cancellationResultBundlePath?: string | null,
    ): Promise<{
      result: IOSSimulatorCommandResult;
      attempts: IOSSimulatorCommandResult[];
    }> => {
      const attempts: IOSSimulatorCommandResult[] = [];
      const run = (pinned: boolean) =>
        this.#runner.run(
          "xcodebuild",
          pinned ? [...args, RESOLVED_FILE_PIN] : args,
          options,
        );
      let result = await run(useResolvedFilePin);
      attempts.push(result);
      await throwIfBuildCancelled(input.signal, cancellationResultBundlePath);
      if (
        useResolvedFilePin &&
        result.exitCode !== 0 &&
        isMissingPackageResolvedDiagnostic(result)
      ) {
        useResolvedFilePin = false;
        result = await run(false);
        attempts.push(result);
        await throwIfBuildCancelled(input.signal, cancellationResultBundlePath);
      }
      return { result, attempts };
    };
    const listRun = await runXcodeWithResolvedFilePolicy(
      [
        "-list",
        "-json",
        containerFlag,
        project.containerPath!,
        ...clonedSourcePackagesArgs,
      ],
      {
        cwd: project.projectRoot,
        timeoutMs: this.#inspectionTimeoutMs,
        maxBufferBytes: 1024 * 1024,
        signal: input.signal,
        env: this.#childEnvironment,
      },
    );
    const list = listRun.result;
    if (list.exitCode !== 0 || list.outputTruncated) {
      throw new IOSSimulatorProjectBuildError(
        "APP_BUILD_FAILED",
        "Xcode could not inspect the project.",
        commandLogTail(listRun.attempts),
        null,
        listRun.attempts.some((attempt) => Boolean(attempt.outputTruncated)),
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
      `platform=iOS Simulator,id=${exactSimulatorUdid}`,
      "-derivedDataPath",
      input.derivedDataPath,
      ...clonedSourcePackagesArgs,
    ];
    if (input.expectedArch) {
      const archSettingsRun = await runXcodeWithResolvedFilePolicy(
        [...commonArgs, "-showBuildSettings", "-json"],
        {
          cwd: project.projectRoot,
          timeoutMs: this.#inspectionTimeoutMs,
          maxBufferBytes: 4 * 1024 * 1024,
          signal: input.signal,
          env: this.#childEnvironment,
        },
      );
      const archSettings = archSettingsRun.result;
      const effective =
        archSettings.exitCode === 0 && !archSettings.outputTruncated
          ? effectiveArchitectures(archSettings.stdout)
          : null;
      if (effective && !effective.includes(input.expectedArch)) {
        throw new IOSSimulatorProjectBuildError(
          "APP_ARCH_MISMATCH",
          `The app target would produce architectures [${effective.join(", ")}], but the target simulator needs ${input.expectedArch}. Check the app target's ARCHS and EXCLUDED_ARCHS.`,
          commandLogTail(archSettingsRun.attempts),
          null,
          archSettingsRun.attempts.some((attempt) =>
            Boolean(attempt.outputTruncated),
          ),
        );
      }
    }
    const nextResultBundlePath = () =>
      path.join(input.derivedDataPath, `CindyBuild-${randomUUID()}.xcresult`);
    let resultBundlePath = nextResultBundlePath();
    const buildAttempts: IOSSimulatorCommandResult[] = [];
    const buildArgs = (bundlePath: string, pinned: boolean) => [
      ...commonArgs,
      ...(pinned ? [RESOLVED_FILE_PIN] : []),
      "-resultBundlePath",
      bundlePath,
      "build",
    ];
    let build = await this.#runner.run(
      "xcodebuild",
      buildArgs(resultBundlePath, useResolvedFilePin),
      {
        cwd: project.projectRoot,
        timeoutMs: this.#buildTimeoutMs,
        maxBufferBytes: 1024 * 1024,
        signal: input.signal,
        env: this.#childEnvironment,
      },
    );
    buildAttempts.push(build);
    await throwIfBuildCancelled(input.signal, resultBundlePath);
    if (
      useResolvedFilePin &&
      build.exitCode !== 0 &&
      isMissingPackageResolvedDiagnostic(build)
    ) {
      // Only retry when Xcode says the resolved file is missing or unusable.
      // A generic compile/link failure that happens to mention Package.resolved
      // must not pay for a second full build. Always allocate a new bundle path:
      // Xcode rejects an existing -resultBundlePath, so a best-effort cleanup
      // failure must not make the fallback deterministically fail again.
      useResolvedFilePin = false;
      const failedResultBundlePath = resultBundlePath;
      resultBundlePath = nextResultBundlePath();
      await rm(failedResultBundlePath, { recursive: true, force: true }).catch(
        () => undefined,
      );
      await throwIfBuildCancelled(input.signal, resultBundlePath);
      build = await this.#runner.run(
        "xcodebuild",
        buildArgs(resultBundlePath, false),
        {
          cwd: project.projectRoot,
          timeoutMs: this.#buildTimeoutMs,
          maxBufferBytes: 1024 * 1024,
          signal: input.signal,
          env: this.#childEnvironment,
        },
      );
      buildAttempts.push(build);
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
        commandLogTail(buildAttempts),
        availableResultBundlePath,
        buildAttempts.some((attempt) => Boolean(attempt.outputTruncated)),
        true,
      );
    }
    const settingsRun = await runXcodeWithResolvedFilePolicy(
      [...commonArgs, "-showBuildSettings", "-json"],
      {
        cwd: project.projectRoot,
        timeoutMs: this.#inspectionTimeoutMs,
        maxBufferBytes: 4 * 1024 * 1024,
        signal: input.signal,
        env: this.#childEnvironment,
      },
      resultBundlePath,
    );
    const settings = settingsRun.result;
    if (settings.exitCode !== 0 || settings.outputTruncated) {
      throw new IOSSimulatorProjectBuildError(
        "APP_ARTIFACT_INVALID",
        "Xcode build settings are unavailable.",
        commandLogTail([build, ...settingsRun.attempts]),
        availableResultBundlePath,
        Boolean(
          build.outputTruncated ||
          settingsRun.attempts.some((attempt) =>
            Boolean(attempt.outputTruncated),
          ),
        ),
      );
    }
    let appPaths: string[] = [];
    try {
      const primarySettings = primaryApplicationBuildSettings(
        JSON.parse(settings.stdout),
      );
      const directory = primarySettings?.TARGET_BUILD_DIR;
      const wrapper = primarySettings?.WRAPPER_NAME;
      appPaths =
        typeof directory === "string" &&
        typeof wrapper === "string" &&
        wrapper.endsWith(".app")
          ? [path.join(directory, wrapper)]
          : [];
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
    const exactSimulatorUdid = normalizeExactSimulatorUdid(simulatorUdid);
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
    const options = {
      timeoutMs: 60_000,
      maxBufferBytes,
      env: this.#childEnvironment,
      signal,
    };
    let result = await this.#runner.run(
      "xcrun",
      ["xcresulttool", "get", "--path", resultBundlePath, "--format", "json"],
      options,
    );
    if (signal?.aborted) {
      throw new IOSSimulatorInstanceError(
        "MUTATION_CANCELLED",
        "The Xcode result bundle read was cancelled because the simulator host is shutting down.",
        true,
      );
    }
    if (
      result.exitCode !== 0 &&
      XCRESULT_LEGACY_OBJECT_REQUIRED.test(`${result.stdout}\n${result.stderr}`)
    ) {
      // Xcode 26.5 rejects the historical default-object spelling unless the
      // deprecated object reader is made explicit. Retry only that exact
      // compatibility diagnostic so older Xcode releases keep their existing
      // command path and unrelated xcresult failures are not doubled.
      result = await this.#runner.run(
        "xcrun",
        [
          "xcresulttool",
          "get",
          "object",
          "--legacy",
          "--path",
          resultBundlePath,
          "--format",
          "json",
        ],
        options,
      );
      if (signal?.aborted) {
        throw new IOSSimulatorInstanceError(
          "MUTATION_CANCELLED",
          "The Xcode result bundle read was cancelled because the simulator host is shutting down.",
          true,
        );
      }
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
