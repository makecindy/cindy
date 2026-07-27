/** Desktop dev 支持的区域身份。 */
export const DESKTOP_DEV_REGIONS = Object.freeze(["cn", "global", "dev"]);

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
