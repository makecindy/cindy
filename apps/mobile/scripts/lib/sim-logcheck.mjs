// mobile:sim:logcheck 的纯逻辑:定位 Metro 日志,并判定最近一次打包之后的 ERROR / WARN。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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
const LOG_DIR_PREFIX = "cindy-metro-log-";

/**
 * 每次启动 Metro 新建一个私有临时目录存日志(mkdtemp:路径不可预测、只有本人可访问),
 * 不复用固定路径,也就不会碰到别人预先放好的目录或链接,也读不到上一次的旧日志。
 * Metro 原始输出可能带凭证,所以不放进仓库工作区。失败返回 null,不阻止 Metro 启动。
 */
export function prepareMetroLog(port, { source, region }) {
  let dir = null;
  try {
    dir = mkdtempSync(join(tmpdir(), LOG_DIR_PREFIX));
    const path = join(dir, `metro-${port}.log`);
    writeFileSync(
      path,
      `# sim-start port=${port} region=${region} source=${source}\n`,
      {
        flag: "wx",
        mode: 0o600,
      },
    );
    return path;
  } catch {
    removeMetroLog(dir && join(dir, "metro.log"));
    return null;
  }
}

/** Metro 退出后删掉这次的日志目录:原始输出可能带凭证,而 logcheck 本就不认已停止的 Metro。 */
export function removeMetroLog(path) {
  if (!path) return;
  const dir = dirname(path);
  // 只删 prepareMetroLog 建的目录,路径来自别处时不动。
  if (dirname(dir) !== tmpdir() || !basename(dir).startsWith(LOG_DIR_PREFIX))
    return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // 删不掉时留在系统临时目录,不在仓库里。
  }
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
