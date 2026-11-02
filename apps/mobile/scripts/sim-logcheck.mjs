// 检查当前 worktree 的 Metro 日志:最近一次打包之后有没有错误和新警告。
//
// 用法(仓库根):
//   pnpm mobile:sim:logcheck               # 检查 8081
//   pnpm mobile:sim:logcheck -- --port 8082
//
// 退出码:0 通过(可能列出新警告);1 有 ERROR;2 无法判定(日志缺失、Metro 不属于本
// worktree、还没有打包记录)。规则见 docs/simulator-debugging.md 的 Logs。
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  analyzeMetroLog,
  logcheckExitCode,
  metroLogPath,
} from "./lib/sim-logcheck.mjs";
import {
  classifySimMetroListener,
  extractSimMetroPortArgs,
} from "./lib/sim-whoami.mjs";
import { probeMetroOwnership } from "./sim-metro.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const mobileDir = resolve(scriptsDir, "..");
const worktreeRoot = resolve(mobileDir, "../..");
const { port } = extractSimMetroPortArgs(process.argv.slice(2), 8081);

function inconclusive(message) {
  console.error(`✗ 无法判定:${message}`);
  process.exit(2);
}

const logPath = metroLogPath(mobileDir, port);
if (!existsSync(logPath)) {
  inconclusive(
    `没有 ${logPath}。请用 pnpm mobile:sim:start 启动 Metro 后再检查。`,
  );
}
const ownership = probeMetroOwnership(port);
const listener = classifySimMetroListener({
  cwd: ownership?.cwd ?? null,
  source: ownership?.source ?? null,
  targetWorktree: worktreeRoot,
});
if (!listener.isTarget) {
  inconclusive(
    `端口 ${port} 上没有本 worktree 的 Metro,这份日志可能已经过期。`,
  );
}

const known = JSON.parse(
  readFileSync(resolve(scriptsDir, "sim-logcheck-known-warnings.json"), "utf8"),
);
const result = analyzeMetroLog(readFileSync(logPath, "utf8"), known);
const print = ({ line, message, count }) =>
  console.log(
    `  L${line}${count > 1 ? ` ×${count}` : ""}  ${message.slice(0, 300)}`,
  );

console.log(`日志:${logPath}`);
console.log(
  result.bundled
    ? `检查范围:第 ${result.bundleLine} 行的打包之后`
    : "检查范围:整份日志(还没有打包记录)",
);
if (result.errors.length > 0) {
  console.log(
    `\n✗ ERROR ${result.errors.length} 种:修复,或在汇报中说明为什么与本次改动无关`,
  );
  result.errors.forEach(print);
}
if (result.newWarnings.length > 0) {
  console.log(
    `\n⚠ 新 WARN ${result.newWarnings.length} 种:不算失败,但必须写进汇报`,
  );
  result.newWarnings.forEach(print);
}
console.log(
  `\n已知 WARN ${result.knownWarningCount} 条(sim-logcheck-known-warnings.json)`,
);

const exitCode = logcheckExitCode(result);
if (exitCode === 2) inconclusive("还没有打包记录,先启动或重新加载 App。");
console.log(exitCode === 0 ? "✓ logcheck 通过" : "✗ logcheck 失败");
process.exit(exitCode);
