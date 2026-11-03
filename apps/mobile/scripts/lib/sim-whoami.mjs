import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import {
  resolvePnpmInvocation,
  usablePnpmExecPath,
} from "../../../../scripts/shared/pnpm-invocation.mjs";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mobileClientBundleEnv } from "../../../../scripts/shared/client-endpoint-build-env.mjs";
import { withLocalMobileRegionConfig } from "./mobile-dev-region.mjs";
import { inspectMetroListeners, probeMetroOwnership } from "../sim-metro.mjs";

const mobileDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SIMULATOR_UDID_PATTERN = /^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/;

/** Parse one optional exact Simulator target without changing sim:start arguments. */
export function extractSimWhoamiUdidArgs(args) {
  let simulatorUdid = null;
  const passthrough = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    let value = null;
    if (arg === "--udid") {
      value = args[++index];
    } else if (arg.startsWith("--udid=")) {
      value = arg.slice("--udid=".length);
    } else {
      passthrough.push(arg);
      continue;
    }

    if (simulatorUdid !== null) throw new Error("Simulator UDID 只能传一次");
    const normalized = String(value ?? "")
      .trim()
      .toUpperCase();
    if (!SIMULATOR_UDID_PATTERN.test(normalized)) {
      throw new Error(`Simulator UDID 无效: ${value ?? "(缺失)"}`);
    }
    simulatorUdid = normalized;
  }

  return { simulatorUdid, passthrough };
}

/** Select only the exact booted device when Host supplies a Simulator target. */
export function bootedSimulatorLinesForTarget(lines, simulatorUdid) {
  const booted = lines.filter((line) => /\(Booted\)/.test(line));
  if (!simulatorUdid) return booted;
  const exactUdid = simulatorUdid.toUpperCase();
  return booted.filter((line) => line.toUpperCase().includes(`(${exactUdid})`));
}

/** Cindy's own simulator (the official Baguette plugin) keeps a private CoreSimulator device set. */
export const CINDY_SIMULATOR_ROOT = join(homedir(), "Library/Application Support/BaguetteCindy");

/** Same rule as the plugin: a missing settings file is its default (allowed), an unreadable one is paused. */
export function cindySimulatorEnabled({ root = CINDY_SIMULATOR_ROOT, readFile = readFileSync } = {}) {
  try {
    return JSON.parse(readFile(join(root, "runtime-settings.json"), "utf8")).enabled === true;
  } catch (error) {
    return error?.code === "ENOENT";
  }
}

/** Cindy's simulator is the default path whenever it is installed and allowed to run. */
export function cindySimulatorAvailable({
  root = CINDY_SIMULATOR_ROOT,
  exists = existsSync,
  readFile = readFileSync,
} = {}) {
  return exists(join(root, "devices")) && cindySimulatorEnabled({ root, readFile });
}

/**
 * Device sets to search, in order. CINDY_MOBILE_SIMULATOR=auto (default) prefers Cindy's
 * simulator when it is available, then the system (Xcode) set;
 * `cindy` / `system` pin one, and an absolute path pins that CoreSimulator device set.
 */
export function resolveSimulatorDeviceSets({
  choice = process.env.CINDY_MOBILE_SIMULATOR || "auto",
  root = CINDY_SIMULATOR_ROOT,
  exists = existsSync,
  readFile = readFileSync,
} = {}) {
  const cindy = { name: "cindy", path: join(root, "devices") };
  const system = { name: "system", path: null };
  if (choice === "auto")
    return cindySimulatorAvailable({ root, exists, readFile }) ? [cindy, system] : [system];
  if (choice === "system") return [system];
  if (choice === "cindy") {
    if (!exists(cindy.path))
      throw new Error("没有找到 Cindy 模拟器的设备目录；请先在 Cindy 安装并使用 Baguette 模拟器插件");
    if (!cindySimulatorEnabled({ root, readFile }))
      throw new Error("Cindy 模拟器在插件设置中关闭了运行；请先在 Cindy 打开");
    return [cindy];
  }
  if (!isAbsolute(choice))
    throw new Error("CINDY_MOBILE_SIMULATOR 只能是 auto、cindy、system 或设备目录的绝对路径");
  // The same directory by path is still Cindy's simulator: it must get the same notices.
  if (resolve(choice) === resolve(cindy.path)) return [cindy];
  return [{ name: choice, path: choice }];
}

/** simctl arguments scoped to one device set (`null` path = the system set). */
export function simctlArgs(deviceSet, args) {
  return deviceSet?.path ? ["simctl", "--set", deviceSet.path, ...args] : ["simctl", ...args];
}

/**
 * Use the set holding the exact UDID, otherwise the first readable set, even with nothing booted:
 * an idle Cindy simulator must not silently hand the task to whatever the system set is running.
 * A set that cannot be listed is not an empty set: without an exact UDID, selecting another
 * backend because of a transient failure would defeat the Cindy-first rule, so it fails closed.
 * With an exact UDID the owner may be another set, so an unreadable one is skipped.
 */
export function selectBootedSimulator(deviceSets, listBooted, simulatorUdid) {
  for (const deviceSet of deviceSets) {
    let lines;
    try {
      lines = listBooted(deviceSet).split("\n");
    } catch (error) {
      if (deviceSets.length === 1 || !simulatorUdid)
        throw new Error(`无法读取 ${deviceSet.name} 模拟器的设备列表（${error.message}）；不改用其他模拟器，请排查 CoreSimulator 后重试，或用 --udid 指定设备。`);
      continue;
    }
    const booted = bootedSimulatorLinesForTarget(lines, null);
    const targetBooted = bootedSimulatorLinesForTarget(lines, simulatorUdid);
    if (!simulatorUdid || targetBooted.length) return { deviceSet, booted, targetBooted };
  }
  return { deviceSet: deviceSets[0], booted: [], targetBooted: [] };
}

/** Explain a selection that leaves the default Cindy path; null when there is nothing to say. */
export function simulatorBackendNotice({
  deviceSet,
  booted,
  simulatorUdid,
  listDevices,
  cindyAvailable = cindySimulatorAvailable(),
}) {
  if (!cindyAvailable) return null;
  if (deviceSet.name === "system")
    return {
      code: "system-while-cindy-available",
      message: "正在使用系统模拟器，但 Cindy 模拟器可用。只有用户明确要求时才这样做，并在交付说明里写明。",
    };
  if (deviceSet.name !== "cindy" || simulatorUdid || booted.length > 0) return null;
  let reusable = [];
  try {
    reusable = listDevices(deviceSet).split("\n").filter((line) => /\(Shutdown\)/.test(line)).map((line) => line.trim());
  } catch {
    // The list only saves a lookup; the guidance below still holds without it.
  }
  return {
    code: "cindy-idle",
    message: "Cindy 模拟器可用，但没有已开机设备：用 baguette-simulator 插件启动或新建一台。只有用户明确要求或插件不可用时，才传 --udid 或设 CINDY_MOBILE_SIMULATOR=system 使用系统模拟器。",
    reusable,
  };
}

/** Without one exact target nothing was probed, so this must not read as "the app is missing". */
export function inspectTargetNativeIdentity({ targetBooted, probeFailed, inspect }) {
  const reason = probeFailed ? "probe-timeout" : targetBooted.length !== 1 ? "target-not-unique" : null;
  if (!reason) return inspect();
  return { healthy: false, code: "native-unknown", reason, installedFingerprint: null, expectedFingerprint: null };
}

/** Find the set that knows this UDID in any state (build-only runs need no booted device). */
export function findSimulatorDeviceSet(deviceSets, listDevices, simulatorUdid) {
  for (const deviceSet of deviceSets) {
    try {
      if (listDevices(deviceSet).toUpperCase().includes(`(${simulatorUdid.toUpperCase()})`)) return deviceSet;
    } catch {
      // An unreadable candidate cannot own the device; keep looking.
    }
  }
  return null;
}

/** Probe app installation on the exact Host-owned Simulator without fallback. */
export function getSimulatorAppContainer(run, simulatorUdid, bundleId, deviceSet = null) {
  return run("xcrun", simctlArgs(deviceSet, [
    "get_app_container",
    simulatorUdid ?? "booted",
    bundleId,
    "app",
  ]));
}

/** Parse the optional Metro port shared by sim:start and sim:whoami. */
export function extractSimMetroPortArgs(args, defaultPort = 8081) {
  let port = defaultPort;
  let seen = false;
  const passthrough = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    let value = null;
    if (arg === "--port" || arg === "-p") {
      value = args[++index];
    } else if (arg.startsWith("--port=")) {
      value = arg.slice("--port=".length);
    } else {
      passthrough.push(arg);
      continue;
    }

    if (seen) throw new Error("Metro 端口只能传一次");
    seen = true;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      throw new Error(`Metro 端口无效: ${value ?? "(缺失)"}`);
    }
    port = parsed;
  }

  return { port, explicit: seen, passthrough };
}

/** Parse the explicit simulator handoff permission used only by the personal Skill. */
export function extractSimTakeoverArgs(args) {
  let takeover = false;
  const passthrough = [];

  for (const arg of args) {
    if (arg === "--takeover") {
      if (takeover) throw new Error("--takeover 只能传一次");
      takeover = true;
    } else {
      passthrough.push(arg);
    }
  }

  return { takeover, passthrough };
}

/** Decide whether a listener has enough Cindy-specific identity for an explicit handoff. */
export function classifySimMetroListener({ cwd, source, targetWorktree, platform = process.platform }) {
  if (!cwd) return { confirmed: false, worktree: null };

  const normalizedCwd = normalize(cwd)
    .replaceAll("\\", "/")
    .replace(/\/+$/, "");
  const normalizedTarget = normalize(targetWorktree)
    .replaceAll("\\", "/")
    .replace(/\/+$/, "");
  const suffix = "/apps/mobile";
  if (!normalizedCwd.endsWith(suffix) || !source) {
    return { confirmed: false, worktree: null };
  }

  const worktree = normalizedCwd.slice(0, -suffix.length);
  const isTarget = platform === 'win32'
    ? worktree.toLowerCase() === normalizedTarget.toLowerCase()
    : worktree === normalizedTarget;
  return {
    confirmed: true,
    worktree,
    isTarget,
  };
}

/**
 * @typedef {object} SimMetroIdentity
 * @property {{ confirmed: boolean, isTarget?: boolean } | null} [listener]
 * @property {string | null} [currentSource]
 * @property {string | null} [runningSource]
 * @property {string} [currentRegion]
 * @property {string | null} [runningRegion]
 * @property {string} [currentEnvFingerprint]
 * @property {string | null} [runningEnvFingerprint]
 * @property {boolean} [envChanged]
 */
/**
 * Shared freshness verdict. Missing evidence must never count as a match.
 * @param {SimMetroIdentity} [input]
 */
export function validateSimMetroIdentity({
  listener, currentSource, runningSource, currentRegion, runningRegion,
  currentEnvFingerprint, runningEnvFingerprint, envChanged = false,
} = {}) {
  let code = 'target-fresh';
  if (!listener?.confirmed) code = 'occupied-unknown';
  else if (!listener.isTarget) code = 'occupied-foreign';
  else if (!currentSource || runningSource !== currentSource) code = 'target-stale';
  else if (currentRegion !== undefined && runningRegion !== currentRegion) code = 'target-region-stale';
  else if (envChanged || (currentEnvFingerprint !== undefined && runningEnvFingerprint !== currentEnvFingerprint)) code = 'target-env-stale';
  return { healthy: code === 'target-fresh', code };
}

/**
 * Assemble the whoami Metro receipt and its start-hint decision. The CLI and
 * unit tests use this same entry; only read-only process I/O is injectable.
 */
export function inspectSimMetroIdentity({
  ports, expectedPort, worktreeRoot, expectedSource, region, envFingerprint,
}, {
  inspectListeners = inspectMetroListeners,
  probeOwnership = probeMetroOwnership,
  timedCheck = (_stage, run) => run(),
} = {}) {
  const probeErrors = [];
  const metros = [];
  let anyMetro = false;
  let currentSourceOnExpectedPort = false;
  const listeners = timedCheck("metro-listeners", () => inspectListeners(ports));
  if (!listeners.healthy) probeErrors.push({ stage: "metro-listeners", code: listeners.code });
  for (const port of ports) {
    if (!listeners.pids[port]) continue;
    const ownership = timedCheck(`metro-${port}`, () => probeOwnership(port, {
      listenerPid: () => listeners.pids[port],
      onProbeError: (error) => probeErrors.push({ port, ...error }),
    }));
    if (!ownership) continue;
    const listener = classifySimMetroListener({
      cwd: ownership.cwd, source: ownership.source, targetWorktree: worktreeRoot,
    });
    const identity = validateSimMetroIdentity({
      listener, currentSource: expectedSource, runningSource: ownership.source,
      currentRegion: region, runningRegion: ownership.region,
      currentEnvFingerprint: envFingerprint, runningEnvFingerprint: ownership.envFingerprint,
    });
    anyMetro ||= listener.confirmed;
    metros.push({ port, ...ownership, pid: Number(ownership.pid), worktree: listener.worktree,
      isMetro: listener.confirmed, identity });
    if (port === expectedPort) currentSourceOnExpectedPort = identity.healthy;
  }
  return {
    healthy: currentSourceOnExpectedPort && probeErrors.length === 0,
    anyMetro, currentSourceOnExpectedPort, metros, probeErrors,
    canSuggestStart: !anyMetro && probeErrors.length === 0,
  };
}

/**
 * Decide whether sim:start should reuse, restart, or refuse the occupant on 8081.
 *
 * `--takeover` may stop a confirmed Cindy Metro (cwd ends with /apps/mobile and
 * the process has an injected source token). It does not require the occupying
 * worktree's live git fingerprint to still match the running Metro. A missing
 * worktree is an orphan Metro and is also eligible. Unknown occupants stay
 * fail-closed even with `--takeover`.
 * @param {SimMetroIdentity & { port?: number, cwd?: string | null, takeover?: boolean, listenerWorktreeExists?: boolean }} [input]
 */
export function resolveSimMetroHandoff({
  port = 8081,
  cwd = null,
  takeover = false,
  envChanged = false,
  currentSource,
  runningSource,
  currentRegion,
  runningRegion,
  currentEnvFingerprint,
  runningEnvFingerprint,
  listener,
  listenerWorktreeExists = false,
} = {}) {
  const occupant = cwd || "(未知进程)";
  const identity = validateSimMetroIdentity({ listener, currentSource, runningSource,
    currentRegion, runningRegion, currentEnvFingerprint, runningEnvFingerprint, envChanged });

  if (!listener?.confirmed) {
    return {
      action: "refuse",
      code: "occupied-unknown",
      lines: [
        `✗ 端口 ${port} 被其他进程占用:${occupant}`,
        "  不是可确认的 Cindy Metro(需要 .../apps/mobile 工作目录 + 注入的源码指纹)。",
        "  未知进程即使传 `--takeover` 也不会停。",
      ],
    };
  }

  if (listener.isTarget) {
    if (identity.code !== "target-stale") {
      const regionChanged = identity.code === "target-region-stale";
      const environmentChanged = identity.code === "target-env-stale";
      if ((envChanged || regionChanged || environmentChanged) && !takeover) {
        return {
          action: 'refuse',
          code: regionChanged ? 'target-region-stale' : 'target-env-stale',
          lines: [
            `✗ apps/mobile/.env 或 --mock 模拟数据开关变了,但 ${port} 上的 Metro 是用旧 env 启动的(env 在 bundle 时注入)。`,
            "  需要刷新 env 时传 `--takeover` 重起,新 env 才会生效。",
          ],
        };
      }
      if ((envChanged || regionChanged || environmentChanged) && takeover) {
        return { action: 'restart', code: regionChanged ? 'target-region' : 'target-env', lines: [] };
      }
      return {
        action: "reuse",
        code: "target-fresh",
        lines: [
          `✓ Metro 已在 ${port} 运行(本 worktree,源码指纹 ${currentSource})。改 JS 直接 Fast Refresh,无需重开。`,
        ],
      };
    }
    if (!takeover) {
      return {
        action: "refuse",
        code: "target-stale",
        lines: [
          `✗ ${port} 上是本 worktree 的 Metro,但源码指纹已过期(运行中=${runningSource || "(无)"} ≠ 当前=${currentSource})。`,
          "  这通常表示 Metro 启动后又 amend/rebase/reset/改过文件。需要接管时传 `--takeover` 重起。",
        ],
      };
    }
    return { action: "restart", code: "target-stale", lines: [] };
  }

  if (!listenerWorktreeExists) {
    if (!takeover) {
      return {
        action: "refuse",
        code: "occupied-orphan",
        lines: [
          `✗ 端口 ${port} 被已删除 worktree 的孤儿 Metro 占用:${occupant}`,
          "  该目录已不存在,进程还占着端口。确认可以清掉时传 `--takeover`。",
        ],
      };
    }
    return { action: "restart", code: "occupied-orphan", lines: [] };
  }

  if (!takeover) {
    return {
      action: "refuse",
      code: "occupied-foreign",
      lines: [
        `✗ 端口 ${port} 被其他 Cindy worktree 的 Metro 占用:${occupant}`,
        "  当前版本需要这块端口。确认可以切换时传 `--takeover`。",
      ],
    };
  }
  return { action: "restart", code: "occupied-foreign", lines: [] };
}

/** Parse the machine-readable output switch for mobile:sim:whoami. */
export function extractSimJsonArgs(args) {
  let json = false;
  const passthrough = [];

  for (const arg of args) {
    if (arg === "--json") {
      if (json) throw new Error("--json 只能传一次");
      json = true;
    } else {
      passthrough.push(arg);
    }
  }

  return { json, passthrough };
}

/**
 * 用实际 Expo config 解析本地 Simulator development client 的 bundle id。
 * 测试可注入 execFile,避免真的启动 Expo CLI。
 */
export function resolveMobileSimulatorBundleId(region, options = {}) {
  const run =
    options.execFile ??
    ((command, args, opts) => {
      if (command !== "pnpm") return execFileSync(command, args, opts);
      const invocation = resolvePnpmInvocation(
        ["exec", "expo", "config", "--type", "public", "--json"],
        {
          npmExecPath: usablePnpmExecPath(process.env.npm_execpath, existsSync),
        },
      );
      return execFileSync(invocation.command, invocation.args, {
        ...opts,
        env: { ...opts.env, ...(invocation.env ?? {}) },
      });
    });
  const buildEnv = withLocalMobileRegionConfig(
    mobileClientBundleEnv({ authRegion: region }),
  );
  let raw;
  try {
    raw = run(
      "pnpm",
      ["exec", "expo", "config", "--type", "public", "--json"],
      {
        cwd: options.mobileDir ?? mobileDir,
        env: { ...(options.env ?? process.env), ...buildEnv },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
        killSignal: "SIGKILL",
      },
    );
  } catch (error) {
    if (error?.code === "ETIMEDOUT") {
      throw Object.assign(new Error(`Expo config 解析 ${region} Simulator bundle id 超时（30s）；检查当前 worktree 依赖和 Expo 配置后重试。`), { code: "EXPO_CONFIG_TIMEOUT" });
    }
    const detail = String(error?.stderr ?? error?.message ?? error).trim();
    throw new Error(
      `无法解析 ${region} Simulator bundle id${detail ? `: ${detail}` : ""}`,
      { cause: error },
    );
  }

  let config;
  try {
    config = JSON.parse(String(raw));
  } catch (error) {
    throw new Error(`Expo config 未返回合法 JSON(region=${region})`, {
      cause: error,
    });
  }
  const bundleId = config?.ios?.bundleIdentifier;
  if (typeof bundleId !== "string" || !bundleId.trim()) {
    throw new Error(`Expo config 缺少 ios.bundleIdentifier(region=${region})`);
  }
  return bundleId.trim();
}
