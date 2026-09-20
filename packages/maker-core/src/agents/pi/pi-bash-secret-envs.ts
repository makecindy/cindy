/**
 * bash spawn 边界要剥离的**静态**环境键(单一来源)。
 *
 * 两处消费,必须共用同一数组:
 * - cindy-bridge 生成代码的 `withoutPiSecrets`(前台 bash / powershell 的 spawn 边界),
 *   经 JSON 插值写进 `<agentHome>/extensions/cindy-bridge.ts`;
 * - host 侧构造「后台命令」子进程 env(`buildPiBackgroundCommandEnv`)。
 * 两条路径删的键若不一致,后台命令就能读到前台 bash 读不到的凭证 / 控制面变量。
 *
 * 动态名单(`CINDY_PI_SECRET_ENV_NAMES` 里的 BYOM key、MCP header 等)由 host
 * 每次会话生成,bridge 运行时再合并进来。
 *
 * 注意:数组里后四个字面量与生成代码内的 `PI_PACKAGE_MANAGEMENT_ENV` /
 * `PI_BASH_PACKAGE_HOME_ENV` / `MANAGED_RG_PATH_ENV` / `SUBAGENT_RUN_DIR_ENV`
 * 必须保持同值。
 */
export const PI_BASH_STATIC_SECRET_ENV_NAMES = [
  'CINDY_PI_SECRET_ENV_NAMES',
  'CINDY_PI_PERMISSION_FILE',
  'CINDY_PI_TURN_TOOL_POLICY',
  'CINDY_PI_PACKAGE_MANAGEMENT',
  // 后台命令通道的 bearer:一次获批的 bash / 后台命令子进程拿到它就能伪造控制请求,
  // 以本会话身份 spawn 任意进程。与子代理路由快照同一类控制面。
  'CINDY_PI_BACKGROUND_COMMANDS',
  'CINDY_PI_BASH_PACKAGE_HOME',
  'CINDY_PI_MANAGED_RG_PATH',
  'CINDY_PI_SUBAGENT_RUN_DIR',
  'PI_CODING_AGENT_DIR',
] as const;
