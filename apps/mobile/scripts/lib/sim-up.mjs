// mobile:sim:up 的流程与判定:选设备、开机、Metro、原生包、启动、身份核对。
// 所有进程与文件操作由 deps 注入,CLI 入口见 ../sim-up.mjs;实际工作仍由 start / rebuild / whoami 完成。

export const SIM_UP_PORTS = Object.freeze([8081, 8082, 8083, 8084, 8085, 8086]);
const DEFAULT_PORT = SIM_UP_PORTS[0];
const BUNDLE_WAITS_MS = Object.freeze([30_000, 60_000, 120_000]);
// 刚开机的十几秒里系统服务会打开其他 App,偶尔把刚启动的 App 挤到后台,所以开机后至少等这么久再确认前台。
const BOOT_SETTLE_MS = 20_000;
const FOREGROUND_CHECKS = 3;

// 这些原因表示原生身份没查成,不等于需要重装;文档要求先处理探测故障。
const NATIVE_PROBE_REASONS = new Set([
  "probe-timeout",
  "target-not-unique",
  "native-fingerprint-timeout",
  "native-fingerprint-unavailable",
]);

export class SimUpFailure extends Error {
  constructor(code, step, message, next, detail = {}) {
    super(message);
    this.code = code;
    this.step = step;
    this.next = next;
    this.detail = detail;
  }
}

/** Parse the options only `up` owns; region, --mock, --udid and --port use the shared parsers. */
export function extractSimUpArgs(args) {
  let deviceName = null;
  let takeover = false;
  const passthrough = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--takeover") takeover = true;
    else if (arg === "--device") deviceName = args[++index] ?? "";
    else if (arg.startsWith("--device="))
      deviceName = arg.slice("--device=".length);
    else passthrough.push(arg);
  }
  if (deviceName !== null && !deviceName.trim())
    throw new Error("--device 需要设备名称");
  return { deviceName: deviceName?.trim() ?? null, takeover, passthrough };
}

/** RCT_jsLocation 缺失时 App 回退到 8081。 */
export function metroPortOfJsLocation(jsLocation) {
  const port = Number(/:(\d+)$/.exec(jsLocation ?? "")?.[1]);
  return Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT;
}

function isOwnMetro(metro) {
  return metro.identity.code.startsWith("target-");
}

/**
 * 选一台设备,不打断其他任务,也不猜:连着本 worktree Metro 的已开机设备直接用;否则只有一台
 * 候选(装了 App 且没有 Metro 在服务的已开机设备,或装了 App 的关机设备)时才用,多台就交给
 * 用户指定。整台设备的使用时间反映不了 Cindy 是否在用,不作为依据。不新建设备。
 */
export function selectSimUpDevice(
  devices,
  { bundleId, metros, deviceName, hasApp, readJsLocation, isPortListening },
) {
  const iPhones = devices.filter(
    (device) =>
      device.isAvailable !== false &&
      /iPhone/.test(device.deviceTypeIdentifier ?? ""),
  );
  const named = deviceName
    ? iPhones.filter((device) => device.name === deviceName)
    : iPhones;
  const metroByPort = new Map(metros.map((metro) => [metro.port, metro]));
  const free = [];
  for (const device of named.filter(
    (candidate) => candidate.state === "Booted",
  )) {
    if (!hasApp(device, bundleId)) {
      if (deviceName) free.push(device);
      continue;
    }
    const port = metroPortOfJsLocation(readJsLocation(device, bundleId));
    const metro = metroByPort.get(port);
    if (metro && isOwnMetro(metro)) return { device, choices: [] };
    // 扫描范围之外的端口也可能有别的任务在用:没扫到不等于空闲,要探测设备实际指向的端口。
    if (!metro && !isPortListening(port)) free.push(device);
  }
  const shutdown = named.filter((device) => device.state === "Shutdown");
  if (deviceName)
    return { device: free[0] ?? shutdown[0] ?? null, choices: [] };
  const choices = [
    ...free,
    ...shutdown.filter((device) => hasApp(device, bundleId)),
  ];
  return choices.length === 1
    ? { device: choices[0], choices: [] }
    : { device: null, choices };
}

/** Decide which Metro this worktree uses. Another live worktree's Metro is never stopped implicitly. */
export function planSimUpMetro({
  metros,
  busyPorts,
  explicitPort,
  takeover,
  worktreeExists,
}) {
  const allowed = explicitPort ? [explicitPort] : SIM_UP_PORTS;
  const metroOn = (port) => metros.find((metro) => metro.port === port);
  const own = allowed
    .map(metroOn)
    .filter((metro) => metro && isOwnMetro(metro));
  const fresh = own.find((metro) => metro.identity.healthy);
  if (fresh) return { action: "reuse", port: fresh.port, metro: fresh };
  if (own.length > 0) {
    const { port } = own[0];
    return port === DEFAULT_PORT
      ? { action: "start", port, takeover: true }
      : { action: "restart-own", port, metro: own[0] };
  }
  for (const port of allowed) {
    if (!busyPorts.includes(port))
      return { action: "start", port, takeover: false };
    const metro = metroOn(port);
    if (port !== DEFAULT_PORT || !metro?.isMetro) continue;
    if (takeover || !worktreeExists(metro.worktree))
      return { action: "start", port, takeover: true };
  }
  return null;
}

function classifyRebuildFailure(output) {
  return /IOS_BUILD_TOOLS_UNAVAILABLE/.test(output)
    ? "IOS_BUILD_TOOLS_UNAVAILABLE"
    : "REBUILD_FAILED";
}

function commonArgs({ region, mock }) {
  return [`--region=${region}`, ...(mock ? ["--mock"] : [])];
}

function resolveDevice(options, deps, metros) {
  const { deviceSets, simulatorUdid, deviceName, bundleId } = options;
  if (simulatorUdid) {
    for (const deviceSet of deviceSets) {
      const device = deps
        .listDevices(deviceSet)
        .find((candidate) => candidate.udid === simulatorUdid);
      if (device) return { device, deviceSet };
    }
    throw new SimUpFailure(
      "UNKNOWN_DEVICE",
      "select-device",
      `没有找到设备 ${simulatorUdid}`,
      "检查 --udid,或去掉它让命令自动选择。",
    );
  }
  const deviceSet = deviceSets[0];
  const devices = deps.listDevices(deviceSet);
  const { device, choices } = selectSimUpDevice(devices, {
    bundleId,
    metros,
    deviceName,
    hasApp: deps.hasApp,
    readJsLocation: (candidate) =>
      deps.readJsLocation(deviceSet, candidate.udid, bundleId),
    isPortListening: deps.isPortListening,
  });
  if (device) return { device, deviceSet };
  if (choices.length > 1) {
    throw new SimUpFailure(
      "DEVICE_CHOICE_NEEDED",
      "select-device",
      `有 ${choices.length} 台装了 App 的空闲设备,不确定该用哪台:${choices.map((candidate) => candidate.name).join("、")}。`,
      '用户指定后运行 pnpm mobile:sim:up -- --device "<名称>";常用机型可在仓库外设置 CINDY_MOBILE_SIM_DEVICE。',
      {
        choices: choices.map(({ name, udid, state }) => ({
          name,
          udid,
          state,
        })),
      },
    );
  }
  const reusable = devices
    .filter(
      (candidate) =>
        candidate.state === "Shutdown" &&
        /iPhone/.test(candidate.deviceTypeIdentifier ?? ""),
    )
    .map((candidate) => candidate.name);
  const create =
    deviceSet.name === "cindy"
      ? "用 cindy-simulator 插件的 device 工具新建一台 iPhone,"
      : "用 xcrun simctl create 新建一台 iPhone,";
  throw new SimUpFailure(
    "NO_REUSABLE_DEVICE",
    "select-device",
    `${deviceSet.name} 模拟器里${deviceName ? `没有名为「${deviceName}」的可用设备` : "没有装过 App 的空闲 iPhone"}。`,
    `${create}再运行 pnpm mobile:sim:up -- --udid <UDID>;已有设备可用 --device <名称> 指定:${reusable.join("、") || "无"}`,
  );
}

async function ensureMetro(options, deps, metroState) {
  const { worktreeRoot, explicitPort, takeover } = options;
  const plan = planSimUpMetro({
    metros: metroState.metros,
    busyPorts: metroState.busyPorts,
    explicitPort,
    takeover,
    worktreeExists: deps.worktreeExists,
  });
  if (!plan) {
    throw new SimUpFailure(
      "METRO_PORTS_BUSY",
      "metro",
      `${explicitPort ?? SIM_UP_PORTS.join("、")} 都被占用,且不属于当前 worktree(${worktreeRoot})。`,
      "等其他任务结束后重跑;确认可以中断 8081 上的任务时加 --takeover。",
    );
  }
  if (plan.action === "reuse") {
    deps.log(`Metro:复用 ${plan.port}`);
    return plan.port;
  }
  if (plan.action === "restart-own" && !(await deps.stopMetro(plan.metro))) {
    throw new SimUpFailure(
      "METRO_START_FAILED",
      "metro",
      `无法停止本 worktree 在 ${plan.port} 上的旧 Metro。`,
      `确认进程 ${plan.metro.pid} 的状态后重跑。`,
    );
  }
  deps.log(`Metro:在 ${plan.port} 启动`);
  try {
    await deps.startMetro({
      port: plan.port,
      takeover: plan.takeover === true,
    });
  } catch (error) {
    throw new SimUpFailure(
      "METRO_START_FAILED",
      "metro",
      error.message,
      "按上面的输出处理后重跑。",
    );
  }
  return plan.port;
}

async function ensureNative(options, deps, target) {
  const { udid, port } = target;
  const before = deps.whoami({ udid, port });
  if (before.native?.healthy) return { action: "reused" };
  if (!before.native || NATIVE_PROBE_REASONS.has(before.native.reason)) {
    throw new SimUpFailure(
      "NATIVE_PROBE_FAILED",
      "native",
      before.error ??
        `原生身份检查未完成(${before.native?.reason ?? before.code ?? "unknown"})。`,
      `先处理这个检查故障后重跑,不要因此 --clean 或换设备。`,
      { whoami: before },
    );
  }
  deps.log(
    `原生包:${before.native.code},运行 rebuild(优先用缓存,否则完整编译,可能要 20–30 分钟)`,
  );
  const rebuilt = await deps.rebuild({ udid });
  // 并行端口下 rebuild 会装好包再报 launch blocked,所以以装后的实际身份为准。
  const after = deps.whoami({ udid, port });
  if (after.native?.healthy) return { action: "rebuilt" };
  throw new SimUpFailure(
    classifyRebuildFailure(rebuilt.output),
    "native",
    `rebuild 后原生身份仍不匹配(退出码 ${rebuilt.status},${after.native?.code ?? "unknown"})。`,
    `查看 ${rebuilt.logPath},按 docs/dev-rules/environment-setup.md 修复后重跑;不要手动安装别的 .app。`,
  );
}

async function launchAndConfirmBundle(
  deps,
  { deviceSet, udid, bundleId, port, logPath },
) {
  const offset = deps.logSize(logPath);
  let bundle = { status: "timeout" };
  try {
    deps.setJsLocation(deviceSet, udid, bundleId, port);
    // 没有日志(更新前启动的 Metro,或 sim-start 建不出日志)就无从确认,只启动一次。
    if (!logPath) {
      deps.launch(deviceSet, udid, bundleId);
      return false;
    }
    // 刚开机时 launch 也会返回成功,但 App 可能留在后台不加载 JS,所以没等到就重新启动。
    for (const timeoutMs of BUNDLE_WAITS_MS) {
      deps.launch(deviceSet, udid, bundleId);
      bundle = await deps.waitForBundle(logPath, offset, timeoutMs);
      if (bundle.status !== "timeout") break;
      deps.log(`${timeoutMs / 1000}s 内没有看到 App 加载 JS`);
    }
  } catch (error) {
    throw new SimUpFailure(
      "LAUNCH_FAILED",
      "launch",
      error.message,
      "检查设备状态后重跑。",
    );
  }
  if (bundle.status === "bundled") return true;
  throw new SimUpFailure(
    bundle.status === "failed" ? "BUNDLE_FAILED" : "BUNDLE_NOT_SEEN",
    "launch",
    bundle.line ?? "Metro 日志里没有看到这次启动的 iOS Bundled。",
    `查看 ${logPath}。`,
  );
}

// 2026-11-03 实测:开机后 calaccessd 打开日历,Cindy 已加载 JS 却停在后台,画面是桌面。
async function confirmForeground(
  deps,
  { deviceSet, udid, bundleId, launchedAt, bootedAt },
) {
  for (let check = 1; check <= FOREGROUND_CHECKS; check += 1) {
    const settle =
      bootedAt === null ? 0 : bootedAt + BOOT_SETTLE_MS - deps.now();
    await deps.sleep(Math.max(3_000, settle));
    const visibility = deps.appVisibility(
      deviceSet,
      udid,
      bundleId,
      launchedAt,
    );
    if (visibility === "visible") return true;
    if (visibility === "unknown") return null;
    if (check === FOREGROUND_CHECKS) break;
    deps.log("App 不在前台,切回前台");
    deps.activate(deviceSet, udid, bundleId);
  }
  throw new SimUpFailure(
    "APP_NOT_FOREGROUND",
    "launch",
    "App 已加载但一直不在前台。",
    "重跑一次;仍然这样就截图看设备上挡在前面的是什么。",
  );
}

/** Bring the current worktree's app up on one device, idempotently. Throws SimUpFailure. */
export async function runSimUp(options, deps) {
  const { region, mock, bundleId, worktreeRoot } = options;
  const metroState = deps.metroState();
  if (!metroState.healthy) {
    throw new SimUpFailure(
      "METRO_PROBE_FAILED",
      "metro",
      `无法确认端口归属(${metroState.probeErrors.map((error) => error.code).join("、")})。`,
      "排查后重跑;检查失败不等于没有 Metro,不要手工 kill 或换端口。",
    );
  }
  const { device, deviceSet } = resolveDevice(options, deps, metroState.metros);
  deps.log(
    `设备:${device.name} (${device.udid}),${deviceSet.name} 模拟器,${device.state}`,
  );
  let bootedAt = null;
  if (device.state !== "Booted") {
    try {
      await deps.boot(deviceSet, device.udid);
    } catch (error) {
      throw new SimUpFailure(
        "BOOT_FAILED",
        "boot",
        error.message,
        `检查设备 ${device.udid} 后重跑。`,
      );
    }
    bootedAt = deps.now();
  }
  const port = await ensureMetro(options, deps, metroState);
  const logPath = deps.metroLogPath(port);
  const native = await ensureNative(options, deps, { udid: device.udid, port });
  const launchedAt = deps.now();
  const bundleVerified = await launchAndConfirmBundle(deps, {
    deviceSet,
    udid: device.udid,
    bundleId,
    port,
    logPath,
  });
  const foreground = await confirmForeground(deps, {
    deviceSet,
    udid: device.udid,
    bundleId,
    launchedAt,
    bootedAt,
  });
  const identity = deps.whoami({ udid: device.udid, port });
  if (!identity.healthy) {
    throw new SimUpFailure(
      "IDENTITY_FAILED",
      "verify",
      "启动后身份核对未通过。",
      `运行 pnpm mobile:sim:whoami -- ${commonArgs({ region, mock }).join(" ")} --udid ${device.udid} --port ${port} 查看。`,
      { whoami: identity },
    );
  }
  const logcheck = `pnpm mobile:sim:logcheck${port === DEFAULT_PORT ? "" : ` -- --port ${port}`}`;
  return {
    ok: true,
    code: "READY",
    step: "done",
    worktree: worktreeRoot,
    source: identity.source,
    simulator: deviceSet.name,
    device: device.name,
    udid: device.udid,
    bundleId,
    region,
    mock,
    port,
    metroLog: logPath,
    native: native.action,
    bundleVerified,
    foreground,
    pageVerified: false,
    next:
      deviceSet.name === "cindy"
        ? `在 Cindy 侧边栏或插件 viewer 查看设备 ${device.udid},截图目检后才算页面已验证;操作完运行 ${logcheck}。`
        : `pnpm mobile:sim:open -- --udid ${device.udid},截图目检后才算页面已验证;操作完运行 ${logcheck}。`,
  };
}
