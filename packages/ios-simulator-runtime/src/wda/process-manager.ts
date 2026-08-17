import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { createNodeIOSSimulatorCommandRunner } from "../command-runner.js";
import {
  IOSSimulatorDriverRouter,
  type IOSSimulatorDriverCapabilityReport,
} from "../driver-router.js";
import type {
  IOSSimulatorAutomationDriver,
  IOSSimulatorDriverHealth,
  IOSSimulatorNativeSidecarDriver,
} from "../driver.js";
import type { IOSSimulatorCapabilityProvider } from "../native-sidecar/provider.js";
import type { IOSSimulatorNativeSidecarStartOptions } from "../native-sidecar/process-manager.js";
import type { IOSSimulatorCommandRunner } from "../types.js";
import { createWdaBuildPlan, type WdaCommandPlan } from "./build-plan.js";
import { WdaClient } from "./client.js";
import { WdaError } from "./errors.js";
import {
  abortWdaSourcePreparationForExit,
  createWdaBuildCacheKey,
  prepareWdaSource,
  type WdaSourceManifest,
} from "./source-provider.js";

const darwinPath = path.posix;

const MAX_LOG_BYTES = 256 * 1024;
const WDA_INTERRUPT_GRACE_MS = 5_000;
const WDA_TERMINATE_GRACE_MS = 1_000;
const WDA_KILL_GRACE_MS = 500;
const WDA_EXIT_POLL_MS = 25;
const MAX_HOST_PROCESS_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const MAX_CANDIDATE_PROCESS_BYTES = 64 * 1024;
const HOST_PROCESS_COMMAND_TIMEOUT_MS = 2_000;
const MAX_WDA_PROCESS_CANDIDATES = 128;
const WDA_DIAGNOSTIC_CLEANUP_BUDGET_MS = 1_000;

export interface WdaManagedProcess {
  readonly pid: number;
  readonly exited: Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>;
  isAlive(): boolean;
  kill(signal: NodeJS.Signals): void;
  onOutput(listener: (chunk: string) => void): () => void;
}

export interface WdaProcessLauncher {
  launch(plan: WdaCommandPlan): WdaManagedProcess;
}

export interface WdaProcessManagerClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface WdaProcessManagerOptions {
  archivePath: string;
  cacheRoot: string;
  commandRunner?: IOSSimulatorCommandRunner;
  processLauncher?: WdaProcessLauncher;
  allocatePort?: () => Promise<number>;
  createDriver?: (
    controlPort: number,
    mjpegPort: number,
  ) => IOSSimulatorAutomationDriver;
  clock?: WdaProcessManagerClock;
  sourceManifest?: WdaSourceManifest;
  startTimeoutMs?: number;
  orphanProcessCleaner?: WdaOrphanProcessCleaner;
  /** Host-owned boundary; WDA never receives artifact paths or process launchers. */
  nativeCapabilityProvider?: IOSSimulatorCapabilityProvider;
}

export interface WdaOrphanProcessCleanupInput {
  cacheRoot: string;
  instanceId: string;
  simulatorUdid: string;
  ownerFingerprint: string;
  signal?: AbortSignal;
  coreSimulatorRoot?: string;
  xcodebuildExecutablePaths?: readonly string[];
  /** Candidate argv paths inspected for conflict only; never grants kill authority. */
  inspectedXcodebuildExecutablePaths?: readonly string[];
  /** Start/reconcile rejects foreign same-device WDA; normal stop only removes Cindy-owned work. */
  rejectForeign?: boolean;
}

export type WdaOrphanProcessCleaner = (
  input: WdaOrphanProcessCleanupInput,
) => Promise<void>;

export interface WdaStartOptions {
  instanceId: string;
  simulatorUdid: string;
  runtimeIdentifier: string;
  /** Exact runtime build used by packaged native capability admission. */
  runtimeBuildVersion?: string | null;
  xcodeBuild: string;
  architecture: "arm64" | "x86_64";
  /** Required when the optional native sidecar is enabled. */
  generation?: number;
}

export interface WdaRunningInstance {
  instanceId: string;
  simulatorUdid: string;
  pid: number;
  controlPort: number;
  mjpegPort: number;
  sourceRevision: string;
  buildCacheKey: string;
  driver: IOSSimulatorAutomationDriver;
  /** Present for production instances; optional keeps injected test managers compatible. */
  driverRouter?: IOSSimulatorDriverRouter;
  driverSessionId: string;
  health: IOSSimulatorDriverHealth;
  startedAt: string;
}

interface InternalRunningInstance extends WdaRunningInstance {
  process: WdaManagedProcess;
  unsubscribeOutput: () => void;
  log: BoundedLog;
  nativeSidecar?: IOSSimulatorNativeSidecarDriver;
  nativeGeneration?: number;
  nativeRuntime?: IOSSimulatorNativeSidecarStartOptions["runtime"];
}

interface PendingWdaOperation {
  controller: AbortController;
  simulatorUdid: string;
  committed: boolean;
  process?: WdaManagedProcess;
  termination?: Promise<void>;
  promise?: Promise<WdaRunningInstance>;
}

interface RetiringWdaProcess {
  process: WdaManagedProcess;
  simulatorUdid: string;
  finalizing?: Promise<void>;
}

class BoundedLog {
  #value = "";

  append(chunk: string): void {
    this.#value += chunk;
    if (Buffer.byteLength(this.#value) > MAX_LOG_BYTES) {
      this.#value = this.#value.slice(-MAX_LOG_BYTES);
    }
  }

  tail(maxCharacters = 8_000): string {
    return this.#value.slice(-Math.max(0, maxCharacters));
  }
}

function defaultClock(): WdaProcessManagerClock {
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

interface DarwinProcessSnapshotRow {
  pid: number;
  processGroupId: number;
  command: string;
}

export interface WdaRunnerProcessCandidate {
  pid: number;
  processGroupId: number;
  executablePath: string;
}

export interface WdaDiagnosticProcessCandidate {
  pid: number;
  processGroupId: number;
  executablePath: string;
}

export interface WdaDetachedDiagnosticCleanupInput {
  cacheRoot: string;
  simulatorUdid: string;
  signal?: AbortSignal;
  xcodebuildExecutablePaths?: readonly string[];
}

function normalizeSimulatorUdid(value: string): string | null {
  const normalized = value.trim().toUpperCase();
  return /^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/.test(normalized)
    ? normalized
    : null;
}

/** Stable, non-secret owner marker embedded in the exact xcodebuild argv. */
export function createWdaOwnerFingerprint(
  cacheRoot: string,
  instanceId: string,
  simulatorUdid: string,
): string {
  const normalizedUdid = normalizeSimulatorUdid(simulatorUdid);
  const normalizedInstanceId = instanceId.trim();
  if (!normalizedUdid || !normalizedInstanceId) {
    throw new WdaError(
      "INVALID_CONFIGURATION",
      "WDA orphan ownership requires an exact instance id and simulator UUID",
    );
  }
  return createHash("sha256")
    .update(path.resolve(cacheRoot))
    .update("\0")
    .update(normalizedInstanceId)
    .update("\0")
    .update(normalizedUdid)
    .digest("hex");
}

function parseDarwinProcessSnapshot(
  snapshot: string,
): DarwinProcessSnapshotRow[] {
  const rows: DarwinProcessSnapshotRow[] = [];
  for (const line of snapshot.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const processGroupId = Number(match[2]);
    if (!Number.isInteger(pid) || !Number.isInteger(processGroupId)) continue;
    rows.push({ pid, processGroupId, command: match[3] });
  }
  return rows;
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function currentProcessGroup(
  rows: readonly DarwinProcessSnapshotRow[],
): number | null {
  return rows.find((row) => row.pid === process.pid)?.processGroupId ?? null;
}

function classifyCindyWdaControllers(
  snapshot: string,
  input: WdaOrphanProcessCleanupInput,
): { ownedGroups: number[]; conflictingGroups: number[] } {
  const normalizedUdid = normalizeSimulatorUdid(input.simulatorUdid);
  if (!normalizedUdid || !/^[0-9a-f]{64}$/.test(input.ownerFingerprint)) {
    return { ownedGroups: [], conflictingGroups: [] };
  }
  const executablePaths = [
    ...(input.xcodebuildExecutablePaths ?? ["/usr/bin/xcodebuild"]),
  ]
    .map((value) => darwinPath.resolve(value))
    .filter((value, index, values) => values.indexOf(value) === index);
  if (executablePaths.length === 0) {
    return { ownedGroups: [], conflictingGroups: [] };
  }
  const conflictExecutablePaths = [
    ...(input.inspectedXcodebuildExecutablePaths ?? executablePaths),
  ]
    .map((value) => darwinPath.resolve(value))
    .filter((value, index, values) => values.indexOf(value) === index);
  const root = darwinPath.resolve(input.cacheRoot);
  const executablePattern = executablePaths
    .map(escapeRegularExpression)
    .join("|");
  const projectPattern = `${escapeRegularExpression(darwinPath.join(root, "source"))}\\/[0-9a-f]{40}\\/WebDriverAgent\\.xcodeproj`;
  const derivedPattern = `${escapeRegularExpression(darwinPath.join(root, "derived"))}\\/[0-9a-f]{64}`;
  const basePattern =
    `(?:${executablePattern}) -quiet -project ${projectPattern}` +
    ` -scheme WebDriverAgentRunner` +
    ` -destination platform=iOS Simulator,id=${normalizedUdid},arch=(?:arm64|x86_64)` +
    ` -derivedDataPath ${derivedPattern}` +
    ` (?:build-for-testing|test-without-building)` +
    ` CODE_SIGNING_ALLOWED=NO COMPILER_INDEX_STORE_ENABLE=NO`;
  const legacyPattern = new RegExp(`^${basePattern}$`);
  const ownedPattern = new RegExp(
    `^${basePattern}` +
      ` CINDY_WDA_OWNER_FINGERPRINT=${input.ownerFingerprint}` +
      ` UPGRADE_TIMESTAMP=${input.ownerFingerprint}$`,
  );
  const schemePattern = /(?:^|\s)-scheme WebDriverAgentRunner(?=\s|$)/;
  const destinationPattern = new RegExp(
    `(?:^|\\s)-destination (?:platform=iOS Simulator,)?` +
      `[^\\s]*id=${normalizedUdid}(?=,|\\s|$)`,
  );
  const rows = parseDarwinProcessSnapshot(snapshot);
  const ownProcessGroup = currentProcessGroup(rows);
  const ownedGroups = new Set<number>();
  const conflictingGroups = new Set<number>();
  for (const row of rows) {
    const command = row.command.trim();
    const owned = ownedPattern.test(command) || legacyPattern.test(command);
    // A different profile/tool may use another project and DerivedData root.
    // It is never kill-authorized, but a same-device WDA controller must block
    // replacement startup until its Runner can be observed or it exits.
    const related =
      owned ||
      (conflictExecutablePaths.some((executable) =>
        command.startsWith(`${executable} `),
      ) &&
        schemePattern.test(command) &&
        destinationPattern.test(command));
    if (!related) continue;
    if (
      row.pid !== row.processGroupId ||
      row.processGroupId <= 1 ||
      row.processGroupId === ownProcessGroup
    ) {
      conflictingGroups.add(row.processGroupId);
      continue;
    }
    if (owned) {
      ownedGroups.add(row.processGroupId);
    } else {
      conflictingGroups.add(row.processGroupId);
    }
  }
  return {
    ownedGroups: [...ownedGroups],
    conflictingGroups: [...conflictingGroups],
  };
}

/**
 * Select only Cindy-owned WDA xcodebuild group leaders for one persisted
 * instance. A fingerprint mismatch is never treated as a legacy process.
 */
export function findCindyWdaOrphanProcessGroups(
  snapshot: string,
  input: WdaOrphanProcessCleanupInput,
): number[] {
  return classifyCindyWdaControllers(snapshot, input).ownedGroups;
}

/** Same-device WDA controllers whose exact Cindy ownership is not proven. */
export function hasConflictingWdaController(
  snapshot: string,
  input: WdaOrphanProcessCleanupInput,
): boolean {
  return (
    classifyCindyWdaControllers(snapshot, input).conflictingGroups.length > 0
  );
}

/** Select exact Simulator runner executables before reading candidate-only env. */
export function findCindyWdaRunnerCandidates(
  snapshot: string,
  input: WdaOrphanProcessCleanupInput,
): WdaRunnerProcessCandidate[] {
  const normalizedUdid = normalizeSimulatorUdid(input.simulatorUdid);
  if (!normalizedUdid) return [];
  const coreSimulatorRoot = darwinPath.resolve(
    input.coreSimulatorRoot ??
      darwinPath.join(os.homedir(), "Library", "Developer", "CoreSimulator"),
  );
  const runnerPattern = new RegExp(
    `^${escapeRegularExpression(
      darwinPath.join(
        coreSimulatorRoot,
        "Devices",
        normalizedUdid,
        "data",
        "Containers",
        "Bundle",
        "Application",
      ),
    )}\\/[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}` +
      `\\/WebDriverAgentRunner-Runner\\.app\\/WebDriverAgentRunner-Runner$`,
  );
  return parseDarwinProcessSnapshot(snapshot)
    .filter((row) => runnerPattern.test(row.command.trim()))
    .map((row) => ({
      pid: row.pid,
      processGroupId: row.processGroupId,
      executablePath: row.command.trim(),
    }));
}

function diagnosticExecutablePaths(
  xcodebuildExecutablePaths: readonly string[],
): Set<string> {
  const paths = new Set<string>(["/usr/bin/xcrun"]);
  for (const executable of xcodebuildExecutablePaths) {
    const resolved = darwinPath.resolve(executable);
    if (darwinPath.basename(resolved) !== "xcodebuild") continue;
    const simctl = darwinPath.join(darwinPath.dirname(resolved), "simctl");
    if (simctl !== "/usr/bin/simctl") paths.add(simctl);
  }
  return paths;
}

/** Select only exact xcrun/simctl executables before reading candidate argv. */
export function findCindyWdaDiagnosticCandidates(
  snapshot: string,
  input: WdaDetachedDiagnosticCleanupInput,
): WdaDiagnosticProcessCandidate[] {
  const executablePaths = diagnosticExecutablePaths(
    input.xcodebuildExecutablePaths ?? [],
  );
  return parseDarwinProcessSnapshot(snapshot)
    // The snapshot always comes from Darwin. Keep its absolute executable path
    // byte-for-byte stable instead of reinterpreting it with the test host's
    // path flavor (for example, Windows would rewrite /usr/bin/xcrun).
    .filter((row) => executablePaths.has(row.command.trim()))
    .map((row) => ({
      pid: row.pid,
      processGroupId: row.processGroupId,
      executablePath: row.command.trim(),
    }));
}

/**
 * Prove that one exact candidate is a same-device diagnostic writing only
 * beneath this profile's WDA DerivedData root.
 */
export function matchesCindyWdaDiagnosticCommand(
  snapshot: string,
  candidate: WdaDiagnosticProcessCandidate,
  input: WdaDetachedDiagnosticCleanupInput,
): boolean {
  const normalizedUdid = normalizeSimulatorUdid(input.simulatorUdid);
  if (!normalizedUdid) return false;
  const rows = parseDarwinProcessSnapshot(snapshot);
  if (rows.length !== 1) return false;
  const row = rows[0];
  const commandPrefix = `${candidate.executablePath} `;
  if (
    row.pid !== candidate.pid ||
    row.processGroupId !== candidate.processGroupId ||
    !row.command.startsWith(commandPrefix)
  ) {
    return false;
  }

  const argv = row.command.slice(commandPrefix.length);
  const subcommand =
    candidate.executablePath === "/usr/bin/xcrun"
      ? "simctl diagnose"
      : "diagnose";
  if (argv !== subcommand && !argv.startsWith(`${subcommand} `)) return false;

  const udidPattern = new RegExp(
    `(?:^|\\s)--udid=${escapeRegularExpression(normalizedUdid)}(?=\\s|$)`,
    "gi",
  );
  if ([...argv.matchAll(udidPattern)].length !== 1) return false;

  const derivedRoot = darwinPath.join(
    darwinPath.resolve(input.cacheRoot),
    "derived",
  );
  const outputPattern = new RegExp(
    `(?:^|\\s)--output(?:=|\\s+)${escapeRegularExpression(derivedRoot)}` +
      `\\/[0-9a-f]{64}(?=\\/|\\s|$)`,
    "g",
  );
  return [...argv.matchAll(outputPattern)].length === 1;
}

/** Verify the candidate PID still owns the exact Runner and owner env marker. */
export function matchesCindyWdaRunnerEnvironment(
  snapshot: string,
  candidate: WdaRunnerProcessCandidate,
  ownerFingerprint: string,
): boolean {
  const rows = parseDarwinProcessSnapshot(snapshot);
  if (rows.length !== 1) return false;
  const row = rows[0];
  if (
    row.pid !== candidate.pid ||
    row.processGroupId !== candidate.processGroupId ||
    !row.command.startsWith(`${candidate.executablePath} `)
  ) {
    return false;
  }
  const matches = environmentValues(row.command, "UPGRADE_TIMESTAMP");
  return matches.length === 1 && matches[0] === ownerFingerprint;
}

function environmentValues(command: string, key: string): string[] {
  const pattern = new RegExp(
    `(?:^|\\s)${escapeRegularExpression(key)}=([^\\s]*)(?=\\s|$)`,
    "g",
  );
  return [...command.matchAll(pattern)].map((match) => match[1] ?? "");
}

/** Narrow migration path for Cindy WDA runners launched before owner markers. */
export function matchesLegacyCindyWdaRunnerEnvironment(
  snapshot: string,
  candidate: WdaRunnerProcessCandidate,
  input: WdaOrphanProcessCleanupInput,
): boolean {
  const rows = parseDarwinProcessSnapshot(snapshot);
  if (rows.length !== 1) return false;
  const row = rows[0];
  const ownerMarkers = environmentValues(row.command, "UPGRADE_TIMESTAMP");
  const simulatorUdids = environmentValues(row.command, "SIMULATOR_UDID");
  const schemeNames = environmentValues(row.command, "XCODE_SCHEME_NAME");
  if (
    row.pid !== candidate.pid ||
    row.processGroupId !== candidate.processGroupId ||
    !row.command.startsWith(`${candidate.executablePath} `) ||
    ownerMarkers.length !== 1 ||
    ownerMarkers[0] !== "" ||
    simulatorUdids.length !== 1 ||
    simulatorUdids[0]?.toUpperCase() !==
      input.simulatorUdid.trim().toUpperCase() ||
    schemeNames.length !== 1 ||
    schemeNames[0] !== "WebDriverAgentRunner"
  ) {
    return false;
  }
  const derivedRoot = escapeRegularExpression(
    darwinPath.join(darwinPath.resolve(input.cacheRoot), "derived"),
  );
  const legacyDerivedPath = new RegExp(
    `(?:^|\\s)DYLD_LIBRARY_PATH=${derivedRoot}\\/[0-9a-f]{64}` +
      `\\/Build\\/Products\\/Debug-iphonesimulator[^\\s]*(?=\\s|$)`,
    "g",
  );
  return [...row.command.matchAll(legacyDerivedPath)].length === 1;
}

function startCancelledError(): WdaError {
  return new WdaError(
    "START_CANCELLED",
    "WebDriverAgent startup was cancelled",
  );
}

function throwIfCleanupAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw startCancelledError();
}

function readBoundedHostCommand(
  args: readonly string[],
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ output: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    throwIfCleanupAborted(signal);
    const child = spawn("/bin/ps", [...args], {
      env: { LANG: "C", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    let outputBytes = 0;
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => {
      child.kill("SIGKILL");
      finish(() => reject(startCancelledError()));
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() =>
        reject(
          new WdaError(
            "TERMINATION_FAILED",
            "The host process inventory timed out during WDA recovery",
          ),
        ),
      );
    }, HOST_PROCESS_COMMAND_TIMEOUT_MS);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      outputBytes += chunk.byteLength;
      if (outputBytes > maxBytes) {
        child.kill("SIGKILL");
        finish(() =>
          reject(
            new WdaError(
              "TERMINATION_FAILED",
              "The host process inventory exceeded the WDA recovery limit",
            ),
          ),
        );
        return;
      }
      output += chunk.toString("utf8");
    });
    child.once("error", () =>
      finish(() =>
        reject(
          new WdaError(
            "TERMINATION_FAILED",
            "The host process inventory for WDA recovery is unavailable",
          ),
        ),
      ),
    );
    child.once("close", (code) =>
      finish(() => resolve({ output, exitCode: code })),
    );
  });
}

async function readDarwinProcessSnapshot(
  signal?: AbortSignal,
): Promise<string> {
  const result = await readBoundedHostCommand(
    ["-axo", "pid=,pgid=,comm="],
    MAX_HOST_PROCESS_SNAPSHOT_BYTES,
    signal,
  );
  if (result.exitCode !== 0) {
    throw new WdaError(
      "TERMINATION_FAILED",
      "The host process inventory for WDA recovery failed",
    );
  }
  return result.output;
}

async function readDarwinCandidateCommand(
  pid: number,
  includeEnvironment: boolean,
  signal?: AbortSignal,
): Promise<string | null> {
  const result = await readBoundedHostCommand(
    [
      ...(includeEnvironment ? ["eww"] : []),
      "-ww",
      "-p",
      String(pid),
      "-o",
      "pid=,pgid=,command=",
    ],
    MAX_CANDIDATE_PROCESS_BYTES,
    signal,
  );
  if (result.exitCode === 0) return result.output;
  if (result.exitCode === 1) return null;
  throw new WdaError(
    "TERMINATION_FAILED",
    "A candidate WebDriverAgent process could not be inspected",
  );
}

interface WdaProcessInventorySnapshot {
  processSnapshot: string;
  controllerSnapshot: string;
  inspectedXcodebuildExecutablePaths: string[];
}

function isAllowlistedXcodebuildCandidate(
  executablePath: string,
  selectedPaths: ReadonlySet<string>,
): boolean {
  const resolved = darwinPath.resolve(executablePath);
  if (selectedPaths.has(resolved) || resolved === "/usr/bin/xcodebuild") {
    return true;
  }
  return (
    /^\/Applications\/[^/]+\.app\/Contents\/Developer\/usr\/bin\/xcodebuild$/.test(
      resolved,
    ) || resolved === "/Library/Developer/CommandLineTools/usr/bin/xcodebuild"
  );
}

async function readWdaProcessInventory(
  input: WdaOrphanProcessCleanupInput,
): Promise<WdaProcessInventorySnapshot> {
  // The global pass reads executable paths only. Full argv/environment is
  // requested by PID only after an exact xcodebuild/Runner path match, so
  // unrelated process credentials never enter the Cindy process.
  const processSnapshot = await readDarwinProcessSnapshot(input.signal);
  const executablePaths = new Set(
    (input.xcodebuildExecutablePaths ?? []).map((value) =>
      darwinPath.resolve(value),
    ),
  );
  const rows = parseDarwinProcessSnapshot(processSnapshot);
  const controllerRows: string[] = [];
  const ownRow = rows.find((row) => row.pid === process.pid);
  if (ownRow) {
    controllerRows.push(
      `${ownRow.pid} ${ownRow.processGroupId} ${ownRow.command}`,
    );
  }
  const candidates = rows.filter((row) =>
    isAllowlistedXcodebuildCandidate(row.command.trim(), executablePaths),
  );
  if (candidates.length > MAX_WDA_PROCESS_CANDIDATES) {
    throw new WdaError(
      "TERMINATION_FAILED",
      "Too many xcodebuild processes were present for safe WDA recovery",
    );
  }
  const commands = await Promise.all(
    candidates.map((row) =>
      readDarwinCandidateCommand(row.pid, false, input.signal),
    ),
  );
  for (const command of commands) {
    if (command !== null) controllerRows.push(command.trim());
  }
  return {
    processSnapshot,
    controllerSnapshot: controllerRows.join("\n"),
    inspectedXcodebuildExecutablePaths: [
      ...new Set(
        candidates.map((row) => darwinPath.resolve(row.command.trim())),
      ),
    ],
  };
}

async function readSelectedXcodebuildPaths(
  signal?: AbortSignal,
): Promise<string[]> {
  const configured = process.env.DEVELOPER_DIR?.trim();
  if (configured && darwinPath.isAbsolute(configured)) {
    return [
      "/usr/bin/xcodebuild",
      darwinPath.join(configured, "usr", "bin", "xcodebuild"),
    ];
  }
  const result = await new Promise<{ output: string; exitCode: number | null }>(
    (resolve, reject) => {
      throwIfCleanupAborted(signal);
      const child = spawn("/usr/bin/xcode-select", ["--print-path"], {
        env: { LANG: "C", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
      });
      let output = "";
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = () => {
        child.kill("SIGKILL");
        finish(() => reject(startCancelledError()));
      };
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        finish(() =>
          reject(
            new WdaError(
              "TERMINATION_FAILED",
              "The selected Xcode path timed out during WDA recovery",
            ),
          ),
        );
      }, HOST_PROCESS_COMMAND_TIMEOUT_MS);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      child.stdout?.on("data", (chunk: Buffer) => {
        if (settled) return;
        if (
          Buffer.byteLength(output) + chunk.byteLength >
          MAX_CANDIDATE_PROCESS_BYTES
        ) {
          child.kill("SIGKILL");
          finish(() =>
            reject(
              new WdaError(
                "TERMINATION_FAILED",
                "The selected Xcode path exceeded the WDA recovery limit",
              ),
            ),
          );
          return;
        }
        output += chunk.toString("utf8");
      });
      child.once("error", () =>
        finish(() =>
          reject(
            new WdaError(
              "TERMINATION_FAILED",
              "The selected Xcode path is unavailable during WDA recovery",
            ),
          ),
        ),
      );
      child.once("close", (exitCode) =>
        finish(() => resolve({ output, exitCode })),
      );
    },
  );
  const developerDirectory = result.output.trim();
  if (result.exitCode !== 0 || !darwinPath.isAbsolute(developerDirectory)) {
    throw new WdaError(
      "TERMINATION_FAILED",
      "The selected Xcode path could not be verified during WDA recovery",
    );
  }
  return [
    "/usr/bin/xcodebuild",
    darwinPath.join(developerDirectory, "usr", "bin", "xcodebuild"),
  ];
}

function isDetachedProcessGroupAlive(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === "EPERM";
  }
}

async function waitForDetachedProcessGroupExit(
  processGroupId: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const deadline = Date.now() + WDA_KILL_GRACE_MS;
  while (isDetachedProcessGroupAlive(processGroupId)) {
    throwIfCleanupAborted(signal);
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(WDA_EXIT_POLL_MS, remaining)),
    );
  }
  return true;
}

async function classifyRunnerCandidates(
  snapshot: string,
  input: WdaOrphanProcessCleanupInput,
): Promise<{ ownedGroups: number[]; conflict: boolean }> {
  const candidates = findCindyWdaRunnerCandidates(snapshot, input);
  if (candidates.length > MAX_WDA_PROCESS_CANDIDATES) {
    throw new WdaError(
      "TERMINATION_FAILED",
      "Too many WebDriverAgent runners were present for safe recovery",
    );
  }
  const ownProcessGroup = currentProcessGroup(
    parseDarwinProcessSnapshot(snapshot),
  );
  const ownedGroups = new Set<number>();
  let conflict = false;
  const environments = await Promise.all(
    candidates.map((candidate) =>
      readDarwinCandidateCommand(candidate.pid, true, input.signal),
    ),
  );
  for (const [index, candidate] of candidates.entries()) {
    const environment = environments[index];
    if (environment == null) continue;
    const owned =
      matchesCindyWdaRunnerEnvironment(
        environment,
        candidate,
        input.ownerFingerprint,
      ) ||
      matchesLegacyCindyWdaRunnerEnvironment(environment, candidate, input);
    if (!owned) {
      conflict = true;
      continue;
    }
    if (
      candidate.pid !== candidate.processGroupId ||
      candidate.processGroupId <= 1 ||
      candidate.processGroupId === ownProcessGroup
    ) {
      conflict = true;
      continue;
    }
    ownedGroups.add(candidate.processGroupId);
  }
  return { ownedGroups: [...ownedGroups], conflict };
}

async function inspectWdaProcessOwnership(
  input: WdaOrphanProcessCleanupInput,
): Promise<{ ownedGroups: number[]; conflict: boolean }> {
  const snapshot = await readWdaProcessInventory(input);
  const controllers = classifyCindyWdaControllers(snapshot.controllerSnapshot, {
    ...input,
    inspectedXcodebuildExecutablePaths:
      snapshot.inspectedXcodebuildExecutablePaths,
  });
  const runners = await classifyRunnerCandidates(
    snapshot.processSnapshot,
    input,
  );
  return {
    ownedGroups: [
      ...new Set([...controllers.ownedGroups, ...runners.ownedGroups]),
    ],
    conflict: controllers.conflictingGroups.length > 0 || runners.conflict,
  };
}

async function revalidateWdaProcessGroupImmediately(
  processGroupId: number,
  input: WdaOrphanProcessCleanupInput,
): Promise<boolean> {
  const controller = await readDarwinCandidateCommand(
    processGroupId,
    false,
    input.signal,
  );
  if (
    controller !== null &&
    findCindyWdaOrphanProcessGroups(controller, input).includes(processGroupId)
  ) {
    return true;
  }

  const snapshot = await readDarwinProcessSnapshot(input.signal);
  const candidate = findCindyWdaRunnerCandidates(snapshot, input).find(
    (value) =>
      value.pid === processGroupId && value.processGroupId === processGroupId,
  );
  if (!candidate) return false;
  const environment = await readDarwinCandidateCommand(
    candidate.pid,
    true,
    input.signal,
  );
  return (
    environment !== null &&
    (matchesCindyWdaRunnerEnvironment(
      environment,
      candidate,
      input.ownerFingerprint,
    ) ||
      matchesLegacyCindyWdaRunnerEnvironment(environment, candidate, input))
  );
}

async function terminateRevalidatedWdaProcessGroups(
  initiallyOwnedGroups: readonly number[],
  input: WdaOrphanProcessCleanupInput,
): Promise<void> {
  if (initiallyOwnedGroups.length === 0) return;
  // Re-read each exact leader immediately before its own signal. One slow
  // unrelated candidate cannot create a PID/PGID reuse window for another.
  const groups = (
    await Promise.all(
      [...new Set(initiallyOwnedGroups)].map(async (processGroupId) => {
        if (
          !(await revalidateWdaProcessGroupImmediately(processGroupId, input))
        ) {
          return null;
        }
        throwIfCleanupAborted(input.signal);
        try {
          process.kill(-processGroupId, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException | null)?.code !== "ESRCH") {
            throw new WdaError(
              "TERMINATION_FAILED",
              "A recovered WebDriverAgent process group could not be terminated",
            );
          }
        }
        return processGroupId;
      }),
    )
  ).filter((value): value is number => value !== null);
  const exited = await Promise.all(
    groups.map((processGroupId) =>
      waitForDetachedProcessGroupExit(processGroupId, input.signal),
    ),
  );
  if (exited.some((value) => !value)) {
    throw new WdaError(
      "TERMINATION_FAILED",
      "A recovered WebDriverAgent process group is still running",
    );
  }
}

/** Recover detached WDA groups after an ungraceful Desktop termination. */
export const cleanupOrphanedWdaProcessGroups: WdaOrphanProcessCleaner = async (
  input,
) => {
  if (process.platform !== "darwin") return;
  throwIfCleanupAborted(input.signal);
  const xcodebuildExecutablePaths =
    input.xcodebuildExecutablePaths ??
    (await readSelectedXcodebuildPaths(input.signal));
  const normalizedInput = { ...input, xcodebuildExecutablePaths };
  const initial = await inspectWdaProcessOwnership(normalizedInput);
  await terminateRevalidatedWdaProcessGroups(
    initial.ownedGroups,
    normalizedInput,
  );

  const final = await inspectWdaProcessOwnership(normalizedInput);
  if (
    final.ownedGroups.length > 0 ||
    (input.rejectForeign !== false && final.conflict)
  ) {
    throw new WdaError(
      "TERMINATION_FAILED",
      "Another or unrecovered WebDriverAgent runtime still owns this simulator",
    );
  }
  await cleanupDetachedDiagnostics({
    cacheRoot: input.cacheRoot,
    simulatorUdid: input.simulatorUdid,
    signal: input.signal,
    xcodebuildExecutablePaths,
  });
};

/**
 * XCTest may detach its `simctl diagnose` helper when Simulator.app exits.
 * Limit cleanup to helpers carrying both this manager's cache root and UDID so
 * user-owned diagnostics for other simulators are never touched.
 */
async function cleanupDetachedDiagnostics(
  input: WdaDetachedDiagnosticCleanupInput,
): Promise<void> {
  if (process.platform !== "darwin") return;
  const budgetController = new AbortController();
  const onParentAbort = () => budgetController.abort();
  input.signal?.addEventListener("abort", onParentAbort, { once: true });
  if (input.signal?.aborted) onParentAbort();
  const budgetTimer = setTimeout(
    () => budgetController.abort(),
    WDA_DIAGNOSTIC_CLEANUP_BUDGET_MS,
  );
  budgetTimer.unref();
  const signal = budgetController.signal;
  try {
    throwIfCleanupAborted(signal);
    const xcodebuildExecutablePaths =
      input.xcodebuildExecutablePaths ??
      (await readSelectedXcodebuildPaths(signal));
    const normalizedInput = { ...input, xcodebuildExecutablePaths };
    const snapshot = await readDarwinProcessSnapshot(signal);
    const candidates = findCindyWdaDiagnosticCandidates(
      snapshot,
      normalizedInput,
    );
    if (candidates.length > MAX_WDA_PROCESS_CANDIDATES) return;

    const commands = await Promise.all(
      candidates.map((candidate) =>
        readDarwinCandidateCommand(candidate.pid, false, signal),
      ),
    );
    const owned = candidates.filter((candidate, index) => {
      const command = commands[index];
      return (
        command !== null &&
        matchesCindyWdaDiagnosticCommand(command, candidate, normalizedInput)
      );
    });

    await Promise.all(
      owned.map(async (candidate) => {
        throwIfCleanupAborted(signal);
        // Re-read immediately before signalling. A vanished or PID-reused
        // candidate receives no signal.
        const current = await readDarwinCandidateCommand(
          candidate.pid,
          false,
          signal,
        );
        if (
          current === null ||
          !matchesCindyWdaDiagnosticCommand(current, candidate, normalizedInput)
        ) {
          return;
        }
        try {
          process.kill(candidate.pid, "SIGTERM");
        } catch {
          // It exited between the exact revalidation and signal.
        }
      }),
    );
  } catch {
    // Diagnostics are best-effort after WDA ownership itself has converged,
    // but an explicit startup cancellation must still unwind immediately.
    if (input.signal?.aborted) throw startCancelledError();
  } finally {
    clearTimeout(budgetTimer);
    input.signal?.removeEventListener("abort", onParentAbort);
  }
}

/** Spawn long-running Xcode processes without a shell and with the plan's allowlisted env. */
export function createNodeWdaProcessLauncher(): WdaProcessLauncher {
  return {
    launch(plan) {
      const child = spawn(plan.command, plan.args, {
        cwd: plan.cwd,
        env: plan.env,
        shell: false,
        // xcodebuild launches XCTestRunner and simctl diagnostics descendants.
        // Keep one process group so stop/timeout cannot leave an orphaned
        // diagnostic process behind after the WDA parent exits.
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (!child.pid)
        throw new WdaError("LAUNCH_FAILED", "WDA process did not start");
      const pid = child.pid;
      const listeners = new Set<(chunk: string) => void>();
      const publish = (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        for (const listener of listeners) listener(text);
      };
      child.stdout?.on("data", publish);
      child.stderr?.on("data", publish);
      let leaderExited = false;
      const exited = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve) => {
        child.once("exit", (code, signal) => {
          leaderExited = true;
          resolve({ code, signal });
        });
        child.once("error", () => {
          leaderExited = true;
          resolve({ code: null, signal: null });
        });
      });
      return {
        pid,
        exited,
        isAlive() {
          if (process.platform === "win32") return !leaderExited;
          try {
            process.kill(-pid, 0);
            return true;
          } catch (error) {
            return (error as NodeJS.ErrnoException | null)?.code === "EPERM";
          }
        },
        kill(signal) {
          if (process.platform !== "win32") {
            try {
              process.kill(-pid, signal);
              return;
            } catch {
              // The group may have already exited; fall back to the direct
              // child handle so callers still get deterministic cleanup.
            }
          }
          child.kill(signal);
        },
        onOutput(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
    },
  };
}

/** Reserve an ephemeral loopback port. Callers still handle the small bind race at launch. */
export function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(
          new WdaError("LAUNCH_FAILED", "Unable to allocate a loopback port"),
        );
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

/** Build, launch, probe, stop, and diagnose one WDA process per instance. */
export class WdaProcessManager {
  readonly #options: WdaProcessManagerOptions;
  readonly #runner: IOSSimulatorCommandRunner;
  readonly #launcher: WdaProcessLauncher;
  readonly #clock: WdaProcessManagerClock;
  readonly #running = new Map<string, InternalRunningInstance>();
  readonly #starting = new Map<string, PendingWdaOperation>();
  readonly #stopping = new Map<string, Promise<void>>();
  readonly #retiring = new Map<string, RetiringWdaProcess>();
  readonly #liveProcesses = new Set<WdaManagedProcess>();

  constructor(options: WdaProcessManagerOptions) {
    this.#options = options;
    this.#runner =
      options.commandRunner ?? createNodeIOSSimulatorCommandRunner();
    this.#launcher = options.processLauncher ?? createNodeWdaProcessLauncher();
    this.#clock = options.clock ?? defaultClock();
  }

  get(instanceId: string): WdaRunningInstance | null {
    const running = this.#running.get(instanceId);
    if (!running) return null;
    const {
      process: _process,
      unsubscribeOutput: _unsubscribe,
      log: _log,
      nativeSidecar: _nativeSidecar,
      nativeGeneration: _nativeGeneration,
      nativeRuntime: _nativeRuntime,
      ...safe
    } = running;
    return safe;
  }

  /**
   * Revalidate the cached WDA session. A still-running xcodebuild process is
   * not sufficient evidence that the driver remains reachable after its
   * CoreSimulator device exits.
   */
  async probe(instanceId: string): Promise<WdaRunningInstance | null> {
    const stopping = this.#stopping.get(instanceId);
    if (stopping) {
      await stopping;
      return null;
    }
    const running = this.#running.get(instanceId);
    if (!running) return null;
    try {
      const health = await running.driver.probe();
      if (!health.ready) throw new Error("WebDriverAgent is not ready");
      if (this.#running.get(instanceId) !== running)
        return this.get(instanceId);
      running.health = health;
      return this.get(instanceId);
    } catch {
      if (this.#running.get(instanceId) === running)
        await this.stop(instanceId);
      return null;
    }
  }

  diagnostics(instanceId: string): {
    running: boolean;
    logTail: string;
    capabilityReport: IOSSimulatorDriverCapabilityReport | null;
    nativeSidecar: ReturnType<IOSSimulatorCapabilityProvider["diagnostics"]>;
  } {
    const running = this.#running.get(instanceId);
    return {
      running: Boolean(running),
      logTail: running?.log.tail() ?? "",
      capabilityReport: running?.driverRouter?.capabilityReport() ?? null,
      nativeSidecar:
        this.#options.nativeCapabilityProvider?.diagnostics(instanceId) ?? null,
    };
  }

  /** Best-effort synchronous child teardown for updater force-quit. */
  abortOperationsForExit(): void {
    abortWdaSourcePreparationForExit();
    for (const pending of this.#starting.values()) {
      pending.controller.abort();
    }
    for (const process of this.#liveProcesses) {
      try {
        process.kill("SIGKILL");
      } catch {
        // The process group may already have exited.
      }
    }
    this.#options.nativeCapabilityProvider?.abortOperationsForExit?.();
  }

  async cleanupOrphaned(
    instanceId: string,
    simulatorUdid: string,
  ): Promise<void> {
    const stopping = this.#stopping.get(instanceId);
    if (stopping) await stopping;
    const starting = this.#starting.get(instanceId);
    if (starting) await starting.promise?.catch(() => undefined);
    const running = this.#running.get(instanceId);
    if (running) {
      if (
        running.simulatorUdid.toUpperCase() !==
        simulatorUdid.trim().toUpperCase()
      ) {
        throw new WdaError(
          "INVALID_CONFIGURATION",
          "The running WebDriverAgent instance is bound to another simulator",
        );
      }
      return;
    }
    await this.#cleanupOrphaned(instanceId, simulatorUdid);
  }

  #cleanupOrphaned(
    instanceId: string,
    simulatorUdid: string,
    signal?: AbortSignal,
    rejectForeign = true,
  ): Promise<void> {
    const ownerFingerprint = createWdaOwnerFingerprint(
      this.#options.cacheRoot,
      instanceId,
      simulatorUdid,
    );
    return (
      this.#options.orphanProcessCleaner ?? cleanupOrphanedWdaProcessGroups
    )({
      cacheRoot: this.#options.cacheRoot,
      instanceId,
      simulatorUdid,
      ownerFingerprint,
      signal,
      rejectForeign,
    });
  }

  start(options: WdaStartOptions): Promise<WdaRunningInstance> {
    const stopping = this.#stopping.get(options.instanceId);
    if (stopping) return stopping.then(() => this.start(options));
    const retiring = this.#retiring.get(options.instanceId);
    if (retiring) return this.#resumeAfterRetiringProcess(options, retiring);
    const running = this.get(options.instanceId);
    if (running) return Promise.resolve(running);
    const pending = this.#starting.get(options.instanceId);
    if (pending) return pending.promise!;
    const starting: PendingWdaOperation = {
      controller: new AbortController(),
      simulatorUdid: options.simulatorUdid,
      committed: false,
    };
    const operation = this.#start(options, starting).finally(() => {
      if (this.#starting.get(options.instanceId) === starting) {
        this.#starting.delete(options.instanceId);
      }
    });
    starting.promise = operation;
    this.#starting.set(options.instanceId, starting);
    return operation;
  }

  /**
   * Re-arms only the optional native acceleration process. WDA, its session,
   * simulator ownership, and the booted device remain untouched.
   */
  async recoverNativeSidecar(
    instanceId: string,
    options: { rearm?: boolean } = {},
  ): Promise<WdaRunningInstance | null> {
    const stopping = this.#stopping.get(instanceId);
    if (stopping) {
      await stopping;
      return this.get(instanceId);
    }
    const running = this.#running.get(instanceId);
    const nativeManager = this.#options.nativeCapabilityProvider;
    if (!running || !nativeManager || running.nativeGeneration === undefined) {
      return this.get(instanceId);
    }
    let nativeSidecar: IOSSimulatorNativeSidecarDriver | undefined;
    let nativeUnavailableReason: string | null = null;
    try {
      nativeSidecar = (
        await nativeManager.recover(
          {
            instanceId,
            simulatorUdid: running.simulatorUdid,
            generation: running.nativeGeneration,
            runtime: running.nativeRuntime,
          },
          options,
        )
      ).adapter;
    } catch (error) {
      nativeUnavailableReason =
        error instanceof Error
          ? error.message
          : "Native sidecar recovery failed.";
    }
    running.nativeSidecar = nativeSidecar;
    running.driverRouter = this.#createDriverRouter({
      instanceId,
      driver: running.driver,
      nativeSidecar,
      nativeUnavailableReason,
    });
    return this.get(instanceId);
  }

  async #start(
    options: WdaStartOptions,
    operation: PendingWdaOperation,
  ): Promise<WdaRunningInstance> {
    const signal = operation.controller.signal;
    const ownerFingerprint = createWdaOwnerFingerprint(
      this.#options.cacheRoot,
      options.instanceId,
      options.simulatorUdid,
    );
    await this.#awaitStartOperation(
      this.#cleanupOrphaned(options.instanceId, options.simulatorUdid, signal),
      signal,
    );
    this.#throwIfStartCancelled(signal);
    const prepared = await this.#awaitStartOperation(
      prepareWdaSource({
        archivePath: this.#options.archivePath,
        cacheRoot: path.join(this.#options.cacheRoot, "source"),
        manifest: this.#options.sourceManifest,
        commandRunner: this.#runner,
      }),
      signal,
    );
    this.#throwIfStartCancelled(signal);
    const buildCacheKey = createWdaBuildCacheKey({
      sourceRevision: prepared.revision,
      xcodeBuild: options.xcodeBuild,
      runtimeIdentifier: options.runtimeIdentifier,
      architecture: options.architecture,
    });
    const derivedDataPath = path.join(
      this.#options.cacheRoot,
      "derived",
      buildCacheKey,
    );
    await mkdir(derivedDataPath, { recursive: true });
    this.#throwIfStartCancelled(signal);
    const allocate = this.#options.allocatePort ?? allocateLoopbackPort;
    const controlPort = await allocate();
    this.#throwIfStartCancelled(signal);
    let mjpegPort = await allocate();
    this.#throwIfStartCancelled(signal);
    while (mjpegPort === controlPort) {
      mjpegPort = await allocate();
      this.#throwIfStartCancelled(signal);
    }
    const plan = createWdaBuildPlan({
      checkoutPath: prepared.checkoutPath,
      derivedDataPath,
      simulatorUdid: options.simulatorUdid,
      ownerFingerprint,
      architecture: options.architecture,
      controlPort,
      mjpegPort,
    });
    const build = await this.#runner.run(plan.build.command, plan.build.args, {
      cwd: plan.build.cwd,
      env: plan.build.env,
      timeoutMs: 10 * 60_000,
      maxBufferBytes: MAX_LOG_BYTES,
      signal,
    });
    this.#throwIfStartCancelled(signal);
    if (build.exitCode !== 0) {
      throw new WdaError(
        "BUILD_FAILED",
        "WebDriverAgent could not be built for this simulator",
      );
    }

    // The build may run for minutes. Recheck immediately before launching the
    // Runner so a foreign same-device WDA that appeared meanwhile blocks this
    // replacement instead of creating two competing sessions.
    await this.#awaitStartOperation(
      this.#cleanupOrphaned(options.instanceId, options.simulatorUdid, signal),
      signal,
    );
    this.#throwIfStartCancelled(signal);
    const process = this.#launcher.launch(plan.launch);
    operation.process = process;
    this.#liveProcesses.add(process);
    const log = new BoundedLog();
    log.append(build.stdout);
    log.append(build.stderr);
    const unsubscribeOutput = process.onOutput((chunk) => log.append(chunk));
    const driver =
      this.#options.createDriver?.(controlPort, mjpegPort) ??
      new WdaClient({
        controlUrl: `http://127.0.0.1:${controlPort}`,
        mjpegUrl: `http://127.0.0.1:${mjpegPort}`,
      });
    try {
      this.#throwIfStartCancelled(signal);
      const deadline =
        this.#clock.now() + (this.#options.startTimeoutMs ?? 90_000);
      let health: IOSSimulatorDriverHealth | null = null;
      let processExited = false;
      void process.exited.then(() => {
        processExited = true;
      });
      while (this.#clock.now() < deadline) {
        this.#throwIfStartCancelled(signal);
        if (processExited) break;
        try {
          const probed = await this.#awaitStartOperation(
            driver.probe(),
            signal,
          );
          if (probed.ready) {
            health = probed;
            break;
          }
        } catch (error) {
          this.#throwIfStartCancelled(signal);
          // WDA commonly refuses connections while XCTest is still launching.
        }
        await this.#sleepWhileStarting(500, signal);
      }
      this.#throwIfStartCancelled(signal);
      if (!health) {
        throw new WdaError(
          "START_TIMEOUT",
          "WebDriverAgent did not become ready in time",
        );
      }

      const session = await this.#awaitStartOperation(
        driver.createSession(),
        signal,
      );
      const driverSessionId = session.id;
      await this.#awaitStartOperation(
        driver.configureStream(driverSessionId, {
          framesPerSecond: 5,
          jpegQuality: 25,
          scalingPercent: 50,
        }),
        signal,
      );
      this.#throwIfStartCancelled(signal);

      let nativeSidecar: IOSSimulatorNativeSidecarDriver | undefined;
      let nativeUnavailableReason: string | null = null;
      const nativeManager = this.#options.nativeCapabilityProvider;
      if (nativeManager) {
        if (options.generation === undefined) {
          nativeUnavailableReason =
            "Native sidecar requires the simulator generation from the ownership actor.";
        } else {
          try {
            nativeSidecar = (
              await this.#awaitStartOperation(
                nativeManager.start({
                  instanceId: options.instanceId,
                  simulatorUdid: options.simulatorUdid,
                  generation: options.generation,
                  runtime: {
                    runtimeIdentifier: options.runtimeIdentifier,
                    runtimeBuildVersion: options.runtimeBuildVersion ?? null,
                    xcodeBuild: options.xcodeBuild,
                    architecture: options.architecture,
                  },
                }),
                signal,
              )
            ).adapter;
          } catch (error) {
            this.#throwIfStartCancelled(signal);
            nativeUnavailableReason =
              error instanceof Error
                ? error.message
                : "Native sidecar capability probe failed.";
          }
        }
      }
      this.#throwIfStartCancelled(signal);
      const driverRouter = this.#createDriverRouter({
        instanceId: options.instanceId,
        driver,
        nativeSidecar,
        nativeUnavailableReason,
      });
      const running: InternalRunningInstance = {
        instanceId: options.instanceId,
        simulatorUdid: options.simulatorUdid,
        pid: process.pid,
        controlPort,
        mjpegPort,
        sourceRevision: prepared.revision,
        buildCacheKey,
        driver,
        driverRouter,
        driverSessionId,
        health,
        startedAt: new Date(this.#clock.now()).toISOString(),
        process,
        unsubscribeOutput,
        log,
        nativeSidecar,
        nativeGeneration: options.generation,
        nativeRuntime: {
          runtimeIdentifier: options.runtimeIdentifier,
          runtimeBuildVersion: options.runtimeBuildVersion ?? null,
          xcodeBuild: options.xcodeBuild,
          architecture: options.architecture,
        },
      };
      operation.committed = true;
      this.#running.set(options.instanceId, running);
      void process.exited.then(() => {
        if (this.#running.get(options.instanceId)?.pid === process.pid) {
          void this.stop(options.instanceId).catch(() => undefined);
        }
      });
      return this.get(options.instanceId)!;
    } catch (error) {
      unsubscribeOutput();
      await this.#options.nativeCapabilityProvider
        ?.stop(options.instanceId)
        .catch(() => undefined);
      await this.#terminatePendingProcess(options.instanceId, operation);
      await this.#cleanupOrphaned(
        options.instanceId,
        options.simulatorUdid,
        undefined,
        false,
      );
      if (error instanceof WdaError) throw error;
      throw new WdaError(
        "LAUNCH_FAILED",
        `WebDriverAgent session setup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (!operation.committed && !this.#isProcessGroupAlive(process)) {
        this.#liveProcesses.delete(process);
      }
    }
  }

  #createDriverRouter(input: {
    instanceId: string;
    driver: IOSSimulatorAutomationDriver;
    nativeSidecar?: IOSSimulatorNativeSidecarDriver;
    nativeUnavailableReason: string | null;
  }): IOSSimulatorDriverRouter {
    return new IOSSimulatorDriverRouter({
      semantic: input.driver,
      discreteInput: input.driver,
      jpegStream: input.driver,
      nativeSidecar: input.nativeSidecar,
      nativeUnavailableReason: input.nativeUnavailableReason,
      isNativeSidecarAvailable: () =>
        input.nativeSidecar !== undefined &&
        this.#options.nativeCapabilityProvider?.get(input.instanceId)
          ?.adapter === input.nativeSidecar,
      nativeAdmission: () =>
        this.#options.nativeCapabilityProvider?.admission(input.instanceId) ??
        null,
    });
  }

  #startCancelledError(): WdaError {
    return new WdaError(
      "START_CANCELLED",
      "WebDriverAgent startup was cancelled",
    );
  }

  #throwIfStartCancelled(signal: AbortSignal): void {
    if (signal.aborted) throw this.#startCancelledError();
  }

  #awaitStartOperation<T>(
    operation: Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    if (signal.aborted) return Promise.reject(this.#startCancelledError());
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = () => finish(() => reject(this.#startCancelledError()));
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      operation.then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      );
    });
  }

  #sleepWhileStarting(ms: number, signal: AbortSignal): Promise<void> {
    return this.#awaitStartOperation(this.#clock.sleep(ms), signal);
  }

  #terminatePendingProcess(
    instanceId: string,
    operation: PendingWdaOperation,
  ): Promise<void> {
    if (!operation.process) return Promise.resolve();
    operation.termination ??= this.#terminateProcessGroup(
      instanceId,
      operation.simulatorUdid,
      operation.process,
    );
    return operation.termination;
  }

  #isProcessGroupAlive(process: WdaManagedProcess): boolean {
    try {
      return process.isAlive();
    } catch {
      // A failed liveness probe cannot prove that the process group is gone.
      return true;
    }
  }

  async #waitForProcessGroupExit(
    process: WdaManagedProcess,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = this.#clock.now() + timeoutMs;
    while (this.#isProcessGroupAlive(process)) {
      const remaining = deadline - this.#clock.now();
      if (remaining <= 0) return false;
      await this.#clock.sleep(Math.min(WDA_EXIT_POLL_MS, remaining));
    }
    return true;
  }

  #rememberRetiringProcess(
    instanceId: string,
    simulatorUdid: string,
    process: WdaManagedProcess,
  ): void {
    const retiring = { process, simulatorUdid };
    this.#retiring.set(instanceId, retiring);
    void process.exited
      .then(() => this.#finalizeRetiringProcess(instanceId, retiring))
      .catch(() => undefined);
  }

  async #finalizeRetiringProcess(
    instanceId: string,
    retiring: RetiringWdaProcess,
  ): Promise<void> {
    if (
      this.#retiring.get(instanceId) !== retiring ||
      this.#isProcessGroupAlive(retiring.process)
    ) {
      return;
    }
    retiring.finalizing ??= cleanupDetachedDiagnostics({
      cacheRoot: this.#options.cacheRoot,
      simulatorUdid: retiring.simulatorUdid,
    });
    await retiring.finalizing;
    if (
      this.#retiring.get(instanceId) === retiring &&
      !this.#isProcessGroupAlive(retiring.process)
    ) {
      this.#retiring.delete(instanceId);
      this.#liveProcesses.delete(retiring.process);
    }
  }

  async #terminateProcessGroup(
    instanceId: string,
    simulatorUdid: string,
    process: WdaManagedProcess,
  ): Promise<void> {
    const stages: ReadonlyArray<{
      signal: NodeJS.Signals;
      graceMs: number;
    }> = [
      { signal: "SIGINT", graceMs: WDA_INTERRUPT_GRACE_MS },
      { signal: "SIGTERM", graceMs: WDA_TERMINATE_GRACE_MS },
      { signal: "SIGKILL", graceMs: WDA_KILL_GRACE_MS },
    ];
    for (const stage of stages) {
      if (!this.#isProcessGroupAlive(process)) break;
      try {
        process.kill(stage.signal);
      } catch {
        // Exit observation remains authoritative; continue the bounded wait.
      }
      if (await this.#waitForProcessGroupExit(process, stage.graceMs)) break;
    }
    if (this.#isProcessGroupAlive(process)) {
      this.#rememberRetiringProcess(instanceId, simulatorUdid, process);
      throw new WdaError(
        "TERMINATION_FAILED",
        "WebDriverAgent process group did not terminate after SIGKILL",
      );
    }
    const retiring = this.#retiring.get(instanceId);
    if (retiring?.process === process) {
      await this.#finalizeRetiringProcess(instanceId, retiring);
    } else {
      await cleanupDetachedDiagnostics({
        cacheRoot: this.#options.cacheRoot,
        simulatorUdid,
      });
    }
    this.#liveProcesses.delete(process);
  }

  async #resumeAfterRetiringProcess(
    options: WdaStartOptions,
    retiring: RetiringWdaProcess,
  ): Promise<WdaRunningInstance> {
    if (this.#isProcessGroupAlive(retiring.process)) {
      throw new WdaError(
        "TERMINATION_FAILED",
        "A previous WebDriverAgent process group is still terminating",
      );
    }
    await this.#finalizeRetiringProcess(options.instanceId, retiring);
    if (this.#retiring.get(options.instanceId) === retiring) {
      throw new WdaError(
        "TERMINATION_FAILED",
        "A previous WebDriverAgent process group cleanup is still pending",
      );
    }
    return this.start(options);
  }

  async stop(instanceId: string): Promise<void> {
    const existing = this.#stopping.get(instanceId);
    if (existing) return existing;
    const operation = this.#stop(instanceId).finally(() => {
      if (this.#stopping.get(instanceId) === operation) {
        this.#stopping.delete(instanceId);
      }
    });
    this.#stopping.set(instanceId, operation);
    return operation;
  }

  async #stop(instanceId: string): Promise<void> {
    const pending = this.#starting.get(instanceId);
    let cleanupUdid = pending?.simulatorUdid;
    if (pending && !pending.committed) {
      pending.controller.abort();
      const nativeStop = this.#options.nativeCapabilityProvider
        ?.stop(instanceId)
        .catch(() => undefined);
      const termination = this.#terminatePendingProcess(instanceId, pending);
      await pending.promise?.catch(() => undefined);
      await nativeStop;
      await termination;
    }
    const retiring = this.#retiring.get(instanceId);
    if (retiring) {
      cleanupUdid = retiring.simulatorUdid;
      await this.#terminateProcessGroup(
        instanceId,
        retiring.simulatorUdid,
        retiring.process,
      );
    }
    const running = this.#running.get(instanceId);
    if (!running) {
      if (cleanupUdid) {
        await this.#cleanupOrphaned(instanceId, cleanupUdid, undefined, false);
      }
      return;
    }
    cleanupUdid = running.simulatorUdid;
    this.#running.delete(instanceId);
    running.unsubscribeOutput();
    await this.#options.nativeCapabilityProvider
      ?.stop(instanceId)
      .catch(() => undefined);
    try {
      await running.driver.deleteSession(running.driverSessionId);
    } catch {
      // The XCTest process may already be gone; process shutdown remains authoritative.
    }
    await this.#terminateProcessGroup(
      instanceId,
      running.simulatorUdid,
      running.process,
    );
    await this.#cleanupOrphaned(instanceId, cleanupUdid, undefined, false);
  }
}
