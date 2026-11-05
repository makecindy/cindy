// 检查当前 worktree 的 Metro 日志:最近一次打包之后有没有错误和新警告。
//
// 用法(仓库根):
//   pnpm mobile:sim:logcheck               # 检查 8081
//   pnpm mobile:sim:logcheck -- --port 8082
//
// 退出码:0 通过(可能列出新警告);1 有 ERROR;2 无法判定(日志缺失、Metro 不属于本
// worktree、还没有打包记录)。规则见 docs/simulator-debugging.md 的 Logs。
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeMetroLog, logcheckExitCode } from "./lib/sim-logcheck.mjs";
import {
  classifySimMetroListener,
  extractSimMetroPortArgs,
} from "./lib/sim-whoami.mjs";
import { probeMetroOwnership, readMetroOwner } from "./sim-metro.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const mobileDir = resolve(scriptsDir, "..");
const worktreeRoot = resolve(mobileDir, "../..");
const { port } = extractSimMetroPortArgs(process.argv.slice(2), 8081);

function inconclusive(message) {
  console.error(`✗ 无法判定:${message}`);
  process.exit(2);
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

// 日志路径只从这次 Metro 的归属记录取,不猜固定路径,读不到旧日志或别人的文件。
const owner = readMetroOwner(port);
const logPath =
  owner && resolve(owner.worktreeRoot ?? "") === worktreeRoot
    ? owner.metroLogPath
    : null;
const NO_LOG =
  "这次启动的 Metro 没有可用的日志(没能建出日志,或日志已丢失)。请用 pnpm mobile:sim:start 重新启动 Metro 后再检查。";
if (!logPath) inconclusive(NO_LOG);
// 不先 existsSync:检查之后 Metro 可能退出并删掉日志,读失败本身就是无法判定。
let logText;
try {
  logText = readFileSync(logPath, "utf8");
} catch {
  inconclusive(NO_LOG);
}

const known = JSON.parse(
  readFileSync(resolve(scriptsDir, "sim-logcheck-known-warnings.json"), "utf8"),
);
const result = analyzeMetroLog(logText, known);
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
