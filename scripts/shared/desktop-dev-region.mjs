import os from "node:os";
import path from "node:path";

/**
 * 内置 worktree 目录段名（含迁移前形态）。命中时视为「worktree 会话内的 dev 启动」。
 * 与 apps/desktop/src/main/worktree 的托管目录命名保持一致；判据刻意只认路径段，
 * 不校验 baseRepo 是否真的注册过——防止把 worktree 名写进目录的任何拷贝都算数，
 * 也避免脚本侧依赖 app 数据库。
 */
const WORKTREE_DIR_NAMES = new Set([".cindy-worktrees", ".xdt-worktrees"]);

/** 与 apps/desktop/src/main/devCliFlags.ts 的 ISOLATION_NAME_RE 同款：合法名字才能进
 * 命名沙箱（目录名跨平台安全 + 并入 deviceId 后不超服务端 64 字符白名单）。 */
const ISOLATION_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** Desktop dev 支持的区域身份。 */
export const DESKTOP_DEV_REGIONS = Object.freeze(["cn", "global", "dev"]);

/**
 * 与 packages/maker-shared/src/brandIdentity.ts 的 userDataDirNameByRegion 镜像。
 * .mjs 启动器不能直接 import TS；同步关系由 brand-identity-sync.test.mjs 锁住。
 */
export const DESKTOP_USER_DATA_DIR_NAME_BY_REGION = Object.freeze({
  cn: "Cindy",
  global: "CindyGlobal",
  dev: "CindyDev",
});

/** 共享 Desktop profile 的区域目录名；省略区域时遵循产品规则默认 Global。 */
export function desktopUserDataDirNameForRegion(region = "global") {
  if (!DESKTOP_DEV_REGIONS.includes(region)) {
    throw new Error(`invalid desktop dev region: ${region}; expected cn, global or dev`);
  }
  return DESKTOP_USER_DATA_DIR_NAME_BY_REGION[region];
}

/** 计算与 Electron app.getPath('userData') 对齐的区域 profile 路径。 */
export function desktopUserDataDirForRegion(
  region = "global",
  platform = process.platform,
  env = process.env,
  homeDir = os.homedir(),
) {
  const dirName = desktopUserDataDirNameForRegion(region);
  const pathImpl = platform === "win32" ? path.win32 : path.posix;
  switch (platform) {
    case "darwin":
      return pathImpl.join(homeDir, "Library", "Application Support", dirName);
    case "win32":
      return pathImpl.join(
        env.APPDATA || pathImpl.join(homeDir, "AppData", "Roaming"),
        dirName,
      );
    case "linux":
      return pathImpl.join(
        env.XDG_CONFIG_HOME || pathImpl.join(homeDir, ".config"),
        dirName,
      );
    default:
      throw new Error(`unsupported platform: ${platform}`);
  }
}

/**
 * 解析 desktop dev 区域。命令行显式值优先，保留 CINDY_AUTH_REGION 作为
 * CI / 老脚本兼容入口；无配置时默认 Global。
 */
export function resolveDesktopDevRegion(argv, env = process.env) {
  let cliRegion;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    let value;
    if (arg === "--region") {
      value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--region requires a value: cn, global or dev");
      }
      index += 1;
    } else if (arg.startsWith("--region=")) {
      value = arg.slice("--region=".length);
      if (!value) throw new Error("--region requires a value: cn, global or dev");
    } else {
      continue;
    }

    if (cliRegion !== undefined) {
      throw new Error("--region may only be specified once");
    }
    cliRegion = value;
  }

  const region = (cliRegion ?? env.CINDY_AUTH_REGION?.trim()) || "global";
  if (!DESKTOP_DEV_REGIONS.includes(region)) {
    throw new Error(
      `invalid desktop dev region: ${region}; expected cn, global or dev`,
    );
  }
  return region;
}

/** 从传给 Electron Forge 的 argv 中移除已由 dev wrapper 消费的区域参数。 */
export function stripDesktopDevRegionArgs(argv) {
  const result = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--region") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--region=")) continue;
    result.push(arg);
  }
  return result;
}

/**
 * 计算 desktop dev 启动配置。remote dev 默认读取同区域仓内清单；
 * --endpoints-cdn / XDT_ENDPOINTS_CDN=1 时不注入默认文件，让主进程走区域化 CDN。
 */
export function resolveDesktopDevStartupConfig({
  argv,
  env = process.env,
  mode = "remote",
}) {
  const region = resolveDesktopDevRegion(argv, env);
  const endpointsCdn =
    argv.includes("--endpoints-cdn") || env.XDT_ENDPOINTS_CDN === "1";
  const configuredManifestFile = env.XDT_ENDPOINT_MANIFEST_FILE?.trim();
  const endpointManifestFile =
    configuredManifestFile ||
    (mode === "remote" && !endpointsCdn
      ? `config/${{ cn: "endpoint.json", global: "endpoint.global.json", dev: "endpoint.dev.json" }[region]}`
      : undefined);
  return { region, endpointsCdn, endpointManifestFile };
}

/** 把纯解析结果写入即将启动 desktop dev 的环境。 */
export function applyDesktopDevStartupConfig(options) {
  const config = resolveDesktopDevStartupConfig(options);
  const env = options.env ?? process.env;
  env.CINDY_AUTH_REGION = config.region;
  env.VITE_CINDY_AUTH_REGION = config.region;
  if (config.endpointsCdn) env.XDT_ENDPOINTS_CDN = "1";
  if (config.endpointManifestFile) {
    env.XDT_ENDPOINT_MANIFEST_FILE = config.endpointManifestFile;
  }
  return config;
}

/**
 * 从启动 cwd 提取托管 worktree 名；不在 worktree 目录下时返回 null。
 * cwd 可以是 worktree 根或其任意子目录（如 apps/desktop），沿路径段找
 * `.cindy-worktrees` / `.xdt-worktrees`，取紧随其后的目录名。
 * 纯路径段判定（同时识别 `/` 与 `\`），不 resolve 到磁盘：worktree 名只取决于
 * 路径形态，且相对路径在测试与真实 cwd 之间不应有差异。
 */
export function worktreeNameFromPath(cwd) {
  const segments = cwd.split(/[\\/]+/).filter(Boolean);
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (WORKTREE_DIR_NAMES.has(segments[index])) {
      return segments[index + 1];
    }
  }
  return null;
}

/**
 * 判定「worktree 会话内的裸 dev 启动」是否需要自动注入隔离意图。
 *
 * 背景（issue #2635）：内置 worktree 里跑 `pnpm dev:remote`（不经 restart 包装）时
 * 若不带 `--isolated`，dev 会用区域默认 profile（global→CindyGlobal）+ 物理机
 * machineId 作为 deviceId——与同区域 release 撞设备身份：dev 登录按 (userId,
 * deviceId) 覆盖 release 的服务端 refresh token，release 下次续期即 401 被登出
 * （日志形态：device-link 4409 乒乓 → INVALID_REFRESH_TOKEN → clearing auth）。
 *
 * 语义：
 * - cwd 命中托管 worktree 且调用方未声明任何显式模式时返回 `{ worktreeName }`；
 *   worktree 名不合法时返回 `{ worktreeName: null }`（仍隔离，回退默认沙箱，与
 *   devCliFlags 的 invalidIsolationName 语义一致——回落到不隔离会混进正式版数据）；
 * - 显式 `--isolated[=<名>]` / `--passive`（argv，人类裸跑 `pnpm dev:remote -- --passive`
 *   的合法用法，Electron 侧 resolveDevCliFlags 认识并收敛为被动模式）已设置时返回
 *   null（显式意图优先，不覆盖用户选择）；
 * - `XDT_RESTART_MANAGED=1`（restart 链路：参数契约显式，默认=共库+正常调度、--isolated
 *   =隔离、--passive / --preserve-running=共享，由 restart 自己负责，不套自动隔离）
 *   已设置时返回 null——这是**唯一**可靠的 env 豁免标记（one-hop，dev-remote-env /
 *   dev-local-env 判定后从 Electron env 删除，不会被子进程继承）；
 * - 其余 env 变量**一律不豁免**（review-pr P1×3, PR #2640）：`XDT_ISOLATED` /
 *   `XDT_USER_DATA_DIR` / `XDT_SCHEDULER_PASSIVE` 都是宿主 Desktop（可能以 --isolated /
 *   --passive 模式运行）留在 process.env 的变量，会沿 Electron → agent 子进程继承
 *   （buildCodexEnv / PI spawn env 复制 process.env）——agent 在 worktree 跑裸
 *   dev:remote 时若凭它们豁免，会复用宿主 userData（单实例锁冲突立即退出 / passive
 *   并发开沙箱）或重新共享 profile/deviceId 互踢。restart 链路的 --isolated /
 *   --passive / --preserve-running 已由 XDT_RESTART_MANAGED 识别，无需也不应依赖这些
 *   可长期继承的变量；
 * - `--preserve-running` **不在** argv 豁免清单：裸 dev 路径上 Electron 侧不认这个参数
 *   （只有 restart 会翻译成 XDT_SCHEDULER_PASSIVE=1），豁免它会共享 userData 却
 *   正常调度 + 正常单实例锁（review-pr P1, PR #2640）；restart 链路经 env 标记识别；
 * - baseRepo 直跑（cwd 不在 worktree 下）返回 null，保持既有共库语义不变。
 */
export function resolveWorktreeIsolationFromCwd({
  cwd = process.cwd(),
  argv = [],
  env = process.env,
} = {}) {
  if (
    argv.some(
      (arg) =>
        arg === "--isolated" ||
        arg.startsWith("--isolated=") ||
        arg === "--passive",
    )
  ) {
    return null;
  }
  // restart 链路（restart-desktop-remote.mjs → desktop-dev-runner → dev:desktop:remote）
  // 的启动参数契约是显式的，由 XDT_RESTART_MANAGED（one-hop 标记）识别——无参=共库+
  // 正常调度、--isolated=隔离、--passive / --preserve-running=共享。该标记判定后即从
  // Electron env 删除，不会被子进程继承，是可靠的 restart 识别信号。其它 env 变量
  // （XDT_ISOLATED / XDT_USER_DATA_DIR / XDT_SCHEDULER_PASSIVE）都可能是宿主 Desktop
  // 留在 process.env 的、会被 agent 继承的变量，一律不视为本次显式配置。
  if (env.XDT_RESTART_MANAGED === "1") return null;

  const name = worktreeNameFromPath(cwd);
  if (name === null) return null;
  return { worktreeName: ISOLATION_NAME_RE.test(name) ? name : null };
}
