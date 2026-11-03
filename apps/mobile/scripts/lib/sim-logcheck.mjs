// mobile:sim:logcheck 的纯逻辑:定位 Metro 日志,并判定最近一次打包之后的 ERROR / WARN。
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TEE_PRELOAD = join(
  dirname(fileURLToPath(import.meta.url)),
  "metro-log-tee.cjs",
);
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const ENTRY_BUNDLED = /\b(?:iOS|Android) Bundled\b.*\bindex\.js\b/;
const BUNDLE_FAILED = /\b(?:iOS|Android) Bundling failed\b/;
const LOG_ENTRY = /^\s*(ERROR|WARN)\s+(.*)$/;

/**
 * Metro 原始输出可能带凭证(请求或错误对象),不能落进仓库工作区,即使被 gitignore。
 * 放在系统临时目录,按 worktree 分开,同一端口的多个 worktree 互不覆盖。
 */
export function metroLogPath(mobileDir, port) {
  const worktreeKey = createHash("sha256")
    .update(resolve(mobileDir))
    .digest("hex")
    .slice(0, 16);
  return join(tmpdir(), "cindy-metro-logs", worktreeKey, `metro-${port}.log`);
}

/** 每次启动 Metro 时清空旧日志。失败时删掉旧日志并返回 null,不阻止 Metro 启动。 */
export function prepareMetroLog(mobileDir, port, { source, region, launch }) {
  const path = metroLogPath(mobileDir, port);
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(
      path,
      `# sim-start port=${port} region=${region} source=${source} launch=${launch}\n`,
      { mode: 0o600 },
    );
    return path;
  } catch {
    // 留下上一次的旧日志会被 logcheck 当成这次的结果,拿不到新日志就删掉旧的。
    try {
      rmSync(path, { force: true });
    } catch {
      // 同样删不掉时,logcheck 会因 Metro 归属或打包记录对不上而无法判定。
    }
    return null;
  }
}

/**
 * 日志是否属于当前 Metro:日志头的 launch 必须等于 Metro 归属记录里的 metroLogLaunch。
 * 建日志失败时归属记录写 null,旧日志即使删不掉也对不上。
 */
export function isLogFromLaunch(text, ownerLaunch) {
  if (!ownerLaunch) return false;
  const header = text.split(/\r?\n/, 1)[0];
  return / launch=(\S+)$/.exec(header)?.[1] === ownerLaunch;
}

export function metroLogEnv(path, existingNodeOptions = "") {
  const preload = `--require ${JSON.stringify(TEE_PRELOAD)}`;
  return {
    CINDY_METRO_LOG_PATH: path,
    NODE_OPTIONS: [existingNodeOptions.trim(), preload]
      .filter(Boolean)
      .join(" "),
  };
}

function groupEntries(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const key = entry.message
      .replace(/[0-9a-f]{8,}/gi, "#")
      .replace(/\d+/g, "N");
    const group = groups.get(key);
    if (group) group.count += 1;
    else groups.set(key, { ...entry, count: 1 });
  }
  return [...groups.values()];
}

/**
 * 只判定最近一次入口打包之后的内容:再往前的错误属于已被替换的代码。
 * 懒加载模块的打包不算新起点,否则同一次运行前半段的错误会被漏掉。
 */
export function analyzeMetroLog(text, knownWarnings = []) {
  const lines = text.replace(ANSI, "").split(/\r\n|\n|\r/);
  const lastBundle = lines.findLastIndex((line) => ENTRY_BUNDLED.test(line));
  const errors = [];
  const warnings = [];
  for (let index = lastBundle + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const entry = { line: index + 1, message: line.trim() };
    if (BUNDLE_FAILED.test(line)) {
      errors.push(entry);
      continue;
    }
    const match = LOG_ENTRY.exec(line);
    if (!match) continue;
    entry.message = match[2].trim();
    (match[1] === "ERROR" ? errors : warnings).push(entry);
  }
  const isKnown = ({ message }) =>
    knownWarnings.some(({ pattern }) => new RegExp(pattern).test(message));
  return {
    bundled: lastBundle >= 0,
    bundleLine: lastBundle + 1,
    errors: groupEntries(errors),
    newWarnings: groupEntries(warnings.filter((entry) => !isKnown(entry))),
    knownWarningCount: warnings.filter(isKnown).length,
  };
}

/** 0 = 通过,1 = 有错误,2 = 无法判定。有错误时优先报错误。 */
export function logcheckExitCode(result) {
  if (result.errors.length > 0) return 1;
  return result.bundled ? 0 : 2;
}
