import path from "node:path";

/**
 * 解析「该怎么调用 pnpm」。
 *
 * `npm_execpath` 只保证是一个路径，不保证是脚本：corepack／npm 安装的 pnpm 指向 JS 入口
 * （`pnpm.cjs`），而原生二进制发行版（`get.pnpm.io` 的 standalone 安装，以及 pnpm 自管
 * `packageManager` 版本时下载的 `@pnpm/<platform>` 包）指向可执行文件本身。把后者交给
 * `node` 会让它按 JS 解析 Mach-O／PE，抛 `SyntaxError: Invalid or unexpected token`——
 * pnpm 根本没启动，调用方看到的却是命令的失败输出，极易误判成业务错误。
 */
const JS_ENTRY_EXTENSIONS = new Set([".js", ".cjs", ".mjs"]);
// Windows 上只有这两类扩展能被 spawn 直接拉起；.cmd／.bat 这类命令包装
// 通过 cmd.exe 解析 PATH/PATHEXT，避免 shell:true 拼接参数数组。
const WINDOWS_DIRECT_EXEC_EXTENSIONS = new Set([".exe", ".com"]);
const WINDOWS_CMD_ARG_ENV_PREFIX = "CINDY_PNPM_CMD_ARG_";

/**
 * @param {string[]} args 传给 pnpm 的参数
 * @param {{ npmExecPath?: string, npm_execpath?: string, execPath?: string, platform?: NodeJS.Platform | string, comSpec?: string }} options
 * 允许注入 npmExecPath／execPath／platform 覆写，便于测试；生产路径默认从 Node runtime 取 platform。
 * @returns {{ command: string, args: string[], shell: boolean, windowsVerbatimArguments?: boolean, env?: Record<string, string> }}
 */
export function resolvePnpmInvocation(args, options = {}) {
  const hasNpmExecPathOption =
    Object.prototype.hasOwnProperty.call(options, "npmExecPath") ||
    Object.prototype.hasOwnProperty.call(options, "npm_execpath");
  const npmExecPath = hasNpmExecPathOption
    ? (options.npmExecPath ?? options.npm_execpath)
    : process.env.npm_execpath;
  const execPath = options.execPath ?? process.execPath;
  const platform = options.platform ?? process.platform;
  const isWindows = platform === "win32";
  if (npmExecPath) {
    const extension = path.extname(npmExecPath).toLowerCase();
    if (JS_ENTRY_EXTENSIONS.has(extension))
      return { command: execPath, args: [npmExecPath, ...args], shell: false };
    if (!isWindows || WINDOWS_DIRECT_EXEC_EXTENSIONS.has(extension))
      return { command: npmExecPath, args, shell: false };
    return resolveWindowsPnpmThroughCmd(npmExecPath, args, options.comSpec);
  }
  if (isWindows) return resolveWindowsPnpmThroughCmd("pnpm", args, options.comSpec);
  return { command: "pnpm", args, shell: isWindows };
}

function resolveWindowsPnpmThroughCmd(pnpmCommand, args, comSpec = process.env.ComSpec) {
  const env = {};
  const commandLine = [pnpmCommand, ...args]
    .map((arg, index) => {
      const name = `${WINDOWS_CMD_ARG_ENV_PREFIX}${index}`;
      env[name] = escapeWindowsCmdEnvArg(arg);
      return quoteWindowsCmdExpansion(name);
    })
    .join(" ");
  return {
    command: comSpec || "cmd.exe",
    args: ["/d", "/s", "/v:off", "/c", `"${commandLine}"`],
    env,
    shell: false,
    windowsVerbatimArguments: true,
  };
}

function quoteWindowsCmdExpansion(name) {
  return `"%${name}%"`;
}

function escapeWindowsCmdEnvArg(arg) {
  return String(arg).replace(/"/g, '""');
}

/**
 * 判断 `npm_execpath` 是否可用：它可能残留自另一个环境，或指向已删除的文件
 * （Windows 的 restart 管线新开 cmd.exe 时就见过）。不可用时返回 undefined，
 * 交给 {@link resolvePnpmInvocation} 退回 PATH 解析。
 *
 * @param {string | undefined} npmExecPath
 * @param {(target: string) => boolean} exists
 * @returns {string | undefined}
 */
export function usablePnpmExecPath(npmExecPath, exists) {
  if (!npmExecPath) return undefined;
  if (!/pnpm/i.test(path.basename(npmExecPath))) return undefined;
  return exists(npmExecPath) ? npmExecPath : undefined;
}
