#!/usr/bin/env node
// PR Git 历史卫生门禁：逐提交检查 base..head 中出现过的路径/blob 组合，
// 而不是只看最终工作树。这样临时产物即使随后被删除，或只由 merge commit 引入，
// 也不能绕过检查。
//
// 判定基准（baseline）是 base 分支当前 HEAD（base ref）的整棵树，遍历起点也是 base
// ref 本身（base..head），而非 merge-base：base 当前树里已有的文件绝不会被误判成
// 「本 PR 新引入」；PR 通过 merge 同步 main 时带进来的 main 文件，由 merge parent
// 交集判定排除（见 parseLogRawZ），同样不误报。注意：PR 自己的普通 commit 若重新
// 引入 base 历史里「出现又删除」的路径/blob，仍会被判为新引入——这是有意为之，
// 临时产物要拦、新大对象要 review，只有「从已有 parent 原样继承」才算复用。
//
// 两类规则分开判定，避免误杀：
//   - 临时产物（tmp/、github-result-*.json、review 快照、CI 日志导出）：只要该
//     path 是 PR 新引入的（baseline 里没有这个 path）就拒绝，不可白名单。
//   - 新对象（>50 MiB blob、.exe/.zip/.7z/.tar.gz 二进制）：只有该 blob 对象不在
//     baseline（即 PR 真正新引入了对象）才拒绝，可精确登记白名单。因此把 base 里
//     已有的二进制 rename 到新路径不会误报（没有新对象入库）。
//
// 只读 git 元数据，不访问网络、不读任何私有配置或凭证。性能上合并子进程调用：
// 一次 rev-list 取全部 commit 与 parent、diff-tree 直接产出 blob SHA、一次
// cat-file --batch-check 批量取大小，避免逐提交 / 逐 blob 的 O(N) 子进程开销。
//
// 本地用法：
//   pnpm check:git-hygiene
//   node scripts/check-git-hygiene.mjs --base <ref> --head <ref>
// pull_request CI 会从 GITHUB_EVENT_PATH 自动读取 base.sha 与 head.sha。

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const MAX_BLOB_SIZE = 50 * 1024 * 1024;
export const ALLOWLIST_PATH = '.github/git-hygiene-allowlist.json';
// 检查器自身错误（环境/代码问题）用退出码 2，与「检测到违规」的退出码 1 区分，
// 让 CI 日志与未来的降级逻辑能分辨「内容违规」和「门禁坏了」。
export const CHECKER_ERROR_EXIT_CODE = 2;

const DEFAULT_BASE_CANDIDATES = ['upstream/main', 'origin/main', 'main'];
const ARCHIVE_OR_EXECUTABLE = /\.(?:exe|zip|7z|tar\.gz)$/i;
const REVIEW_SNAPSHOT =
  /^(?:review-(?:(?:live-)?pr\d*(?:-(?:comments|files|reviews|threads))?|requested|reviews|threads)|reviewer-(?:get_pull_request|list_pull_request_(?:review_comments|review_threads|reviews))|pr[-_]?\d+[-_](?:commits|files|review-comments|reviews|threads))\.json$/i;
const CI_LOG_EXPORT =
  /(?:^|\/)(?:ci|windows[-_]?\d*)[-_].*(?:logs?|artifacts?)\.(?:zip|7z|tar\.gz)$/i;

const git = (args, options = {}) =>
  execFileSync('git', args, { encoding: 'utf8', ...options }).trim();

function normalizePath(value) {
  return String(value ?? '').replaceAll('\\', '/').replace(/^\.\//, '');
}

export function formatBytes(bytes) {
  const value = Number(bytes);
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 ** 2).toFixed(1)} MiB`;
}

/**
 * 临时产物类路径规则：命中即拒绝且不可白名单，只对 PR 新引入的 path 生效。
 */
export function classifyPath(filePath) {
  const path = normalizePath(filePath);
  const basename = path.split('/').at(-1) ?? path;

  // 任意路径段的段名为 tmp 即命中：tmp、tmp/...、foo/tmp、foo/tmp/... 都视为本地临时
  // 产物目录。用段判断而非子串，避免误伤 footmp/、my-tmp/ 这类路径。
  if (path.split('/').includes('tmp')) {
    return {
      rule: 'temporary path',
      detail: 'Paths under tmp/ are local artifacts.',
      allowlistable: false,
    };
  }
  if (/^github-result-.*\.json$/i.test(basename)) {
    return {
      rule: 'GitHub result export',
      detail: 'github-result-*.json is a local API export.',
      allowlistable: false,
    };
  }
  if (REVIEW_SNAPSHOT.test(basename)) {
    return {
      rule: 'review snapshot',
      detail: 'Local review snapshots must not enter Git history.',
      allowlistable: false,
    };
  }
  if (CI_LOG_EXPORT.test(path)) {
    return {
      rule: 'CI log export',
      detail: 'Downloaded CI logs and artifacts must not enter Git history.',
      allowlistable: false,
    };
  }
  return null;
}

/**
 * 二进制/压缩包类规则：只有 PR 真正新引入了该 blob 对象才拒绝，可精确白名单。
 */
export function classifyBinary(filePath) {
  const path = normalizePath(filePath);
  if (ARCHIVE_OR_EXECUTABLE.test(path)) {
    return {
      rule: 'unregistered binary/archive',
      detail: 'New executables and archives require an exact allowlist entry.',
      allowlistable: true,
    };
  }
  return null;
}

export function validateAllowlist(raw) {
  if (!raw || raw.version !== 1 || !Array.isArray(raw.entries)) {
    throw new Error(`${ALLOWLIST_PATH} must contain { "version": 1, "entries": [] }.`);
  }

  const seen = new Set();
  return raw.entries.map((entry, index) => {
    const path = normalizePath(entry?.path);
    const blob = String(entry?.blob ?? '').toLowerCase();
    const reason = String(entry?.reason ?? '').trim();
    if (!path || !/^[0-9a-f]{40,64}$/.test(blob) || !reason) {
      throw new Error(
        `${ALLOWLIST_PATH} entry ${index + 1} needs a path, full blob SHA, and non-empty reason.`
      );
    }
    const key = `${path}\0${blob}`;
    if (seen.has(key)) {
      throw new Error(`${ALLOWLIST_PATH} contains duplicate entry for ${path} (${blob}).`);
    }
    seen.add(key);
    return { path, blob, reason };
  });
}

export function evaluateCandidate(candidate, allowlist) {
  const reasons = [];
  if (candidate.isNewPath) {
    const pathReason = classifyPath(candidate.path);
    if (pathReason) reasons.push(pathReason);
  }
  if (candidate.isNewBlob) {
    const binaryReason = classifyBinary(candidate.path);
    if (binaryReason) reasons.push(binaryReason);
    if (candidate.size > MAX_BLOB_SIZE) {
      reasons.push({
        rule: 'large blob',
        detail: `Blob exceeds the ${formatBytes(MAX_BLOB_SIZE)} limit.`,
        allowlistable: true,
      });
    }
  }
  if (reasons.length === 0) return null;

  const allowed = allowlist.find(
    (entry) =>
      entry.path === normalizePath(candidate.path) && entry.blob === candidate.blob.toLowerCase()
  );
  return allowed && reasons.every((reason) => reason.allowlistable)
    ? null
    : { ...candidate, reasons };
}

/**
 * 解析 `git log -m --raw -z --format=__C__%H %P` 的输出。`-m` 让 merge commit 对每个
 * parent 各展开一段 diff（每段前重复 `__C__<sha> <parents>` 头），只用一次子进程取得
 * base..head 整段历史，避免 O(commits × parents) 次的进程 spawn 开销。
 *
 * 字段布局（`\0` 分隔）：header `__C__<sha> <p1> <p2>...`（parent 可为空，root commit
 * 无 parent），其后是 `:oldmode newmode oldsha newsha status` 元数据与 path 交替出现
 * （紧跟 header 的首条元数据带 `\n` 前缀）。rename/copy 时 path 段为 from\0to。跳过
 * 删除与 tree 记录；gitlink/submodule（mode 160000）保留 path 以便命中 tmp/ 等路径
 * 规则，只跳过 blob 对象判定（gitlink 的 newsha 是 submodule 的 commit SHA）。
 *
 * merge commit 判定的关键是「真实 parent 数」而非 `-m` 输出的段数——Git 会省略相对
 * 某 parent 完全为空的 diff 段，数段会误把 merge 当普通 commit。这里从 header 的 %P
 * 取 parentCount；对 merge 只保留「在每个 parent 段都出现相同 (path, blob, isGitlink)
 * 键」的变更——即 merge 结果里任何 parent 都没有的对象（merge 自造内容），既覆盖
 * 已有路径上被 merge 解析成新 blob 的情形，也排除从任一 parent 原样继承的内容。
 * observed 段数 < parentCount 时，缺失 parent 视为空集合，交集自然为空（merge 未引入
 * 任何新对象）。非 merge（含 root）commit 保留其全部变更。
 */
function parseLogRawZ(stdout) {
  const fields = (Buffer.isBuffer(stdout) ? stdout.toString('utf8') : String(stdout)).split('\0');
  // sha -> { parentCount, changes: Map<key, change>, segKeys: Set<string>[] }
  const commits = new Map();
  let currentSha = null;
  let currentSeg = null;
  let index = 0;
  while (index < fields.length) {
    const field = fields[index++];
    if (!field) continue;
    if (field.startsWith('__C__')) {
      const tokens = field.slice(5).trim().split(/\s+/).filter(Boolean);
      const sha = tokens[0];
      const parentCount = tokens.length - 1;
      if (!commits.has(sha)) {
        commits.set(sha, { parentCount, changes: new Map(), segKeys: [] });
      }
      currentSha = sha;
      currentSeg = new Set();
      commits.get(sha).segKeys.push(currentSeg);
      continue;
    }
    const meta = field.startsWith('\n') ? field.slice(1) : field;
    if (!meta.startsWith(':')) continue;
    const parts = meta.slice(1).split(' ');
    if (parts.length < 5) continue;
    const newmode = parts[1];
    const oldsha = parts[2];
    const newsha = parts[3];
    const status = parts[4][0];
    const isGitlink = newmode === '160000';
    // 先按 status 无条件消费该 raw record 的 path（R/C 为 from\0to，其余一个），
    // 再决定过滤。若在消费前就 continue，path 字段会残留在 stream 里，下一轮被误读，
    // 甚至被「__C__...」开头的文件名伪造 header、让 parser 失步。
    let path;
    if (status === 'R' || status === 'C') {
      index++; // 跳过 from path
      path = fields[index++]; // to path
    } else {
      path = fields[index++];
    }
    if (!currentSha || !path || !currentSeg) continue;
    if (status === 'D') continue;
    if (newmode === '040000') continue; // tree 记录，不是文件候选
    // mode/type-only 变化（非 R/C 且 oldsha === newsha，如 chmod +x）没有引入新的
    // path/blob，不计入候选，也不计入 segKeys——否则会破坏 merge「每个 parent 段都
    // 出现相同 key」等价于「每个 parent 都没有该 path/blob」的判定。R/C 即使
    // oldsha === newsha 仍是真正的新 (path, blob) 组合，必须保留。
    if (status !== 'R' && status !== 'C' && oldsha === newsha) continue;
    const key = `${path}\0${newsha}\0${isGitlink ? '1' : '0'}`;
    currentSeg.add(key);
    const entry = commits.get(currentSha);
    if (!entry.changes.has(key)) {
      entry.changes.set(key, { commit: currentSha, path, blob: newsha, isGitlink });
    }
  }

  const result = [];
  for (const { parentCount, changes, segKeys } of commits.values()) {
    if (parentCount < 2) {
      // 普通 / root commit：保留全部变更。
      result.push(...changes.values());
      continue;
    }
    // merge：只保留「每个 parent 段都出现相同 key」的对象。若 -m 省略了空段
    // （segKeys.length < parentCount），缺失 parent 视为空集合，交集为空 → 不引入新对象。
    if (segKeys.length < parentCount) continue;
    const intersection = segKeys
      .slice(1)
      .reduce((acc, s) => new Set([...acc].filter((key) => s.has(key))), new Set(segKeys[0]));
    for (const key of intersection) result.push(changes.get(key));
  }
  return result;
}

export function parseTreeSets(stdout) {
  const blobs = new Set();
  const paths = new Set();
  const records = (Buffer.isBuffer(stdout) ? stdout.toString('utf8') : String(stdout)).split('\0');
  for (const record of records) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    const metadata = record.slice(0, tab).split(' ');
    const type = metadata[1];
    // blob 与 gitlink（type=commit）都是占据 path 的条目，都要记入 paths，保证 baseline
    // 已存在的 gitlink 不会被误判成「PR 新引入路径」；只有 blob 的 SHA 记入 blobs。
    if (type !== 'blob' && type !== 'commit') continue;
    const path = normalizePath(record.slice(tab + 1));
    paths.add(path);
    if (type === 'blob') blobs.add(metadata[2]);
  }
  return { blobs, paths };
}

function revParse(ref) {
  try {
    return git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function readArg(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

export function resolveRange({ argv = process.argv, env = process.env } = {}) {
  let base = readArg(argv, '--base');
  let head = readArg(argv, '--head') ?? 'HEAD';
  if (!base && env.GITHUB_EVENT_PATH) {
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
    if (!event.pull_request) {
      throw new Error(
        'Event payload has no pull_request; run this check only for pull requests or pass --base.'
      );
    }
    base = event.pull_request.base?.sha;
    head = readArg(argv, '--head') ?? event.pull_request.head?.sha ?? 'HEAD';
  }
  if (!base) base = DEFAULT_BASE_CANDIDATES.find((candidate) => revParse(candidate));
  if (!base) throw new Error('No base ref found; pass --base <ref>.');

  const baseSha = revParse(base);
  const headSha = revParse(head);
  if (!baseSha) throw new Error(`Cannot resolve base ref: ${base} (fetch it first if missing).`);
  if (!headSha) throw new Error(`Cannot resolve head ref: ${head}.`);

  // 遍历范围用 base ref 本身（baseSha..head），而不是 merge-base..head。后者会把 PR
  // 通过 merge 同步 main 时带进来的 main 历史提交也纳入扫描，从而把 base 分支上已经
  // 出现（或历史里出现又删除）的产物误报成本 PR 引入。baseSha..head 恰好是「PR 自身
  // 引入的提交」。
  //
  // 假设：PR 通过 merge 同步的 main 提交都已在当前 base ref 可达（正常的 PR-first 流程
  // 下成立）。若 base ref lag 或发生过历史重写，merged main 的普通提交可能不在
  // base..head 的排除范围里、被误报为新引入；这种异常工作流下需先同步 base。
  return { base: baseSha, head: headSha, baseRef: base };
}

function blobSizes(blobs, cwd) {
  const sizes = new Map();
  const unique = [...new Set(blobs)];
  if (unique.length === 0) return sizes;
  const output = execFileSync('git', ['cat-file', '--batch-check'], {
    cwd,
    input: `${unique.join('\n')}\n`,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const [sha, type, size] = line.trim().split(/\s+/);
    if (type === 'blob') sizes.set(sha, Number(size));
  }
  return sizes;
}

/**
 * 扫描 base 到 head 之间每个 commit 相对每个 parent 的完整 diff。merge commit 会逐
 * parent 展开，但只把「所有 parent 都没有」的路径算作新引入（见 parseLogRawZ），
 * 这样既不漏掉 merge 时短暂带入、随后删除的产物（它们相对每个 parent 都是新增），
 * 也不会把 merge 从某个 parent 带入的既有文件误报成本 PR 新引入。
 *
 * baseline 与遍历起点都是 base ref（baseSha）本身：baseSha..head 恰好是「PR 自身引入
 * 的提交」，不含 PR 通过 merge 同步 main 时带进来的 main 历史提交。base 当前树已有的
 * 文件、以及通过 merge 从 parent 原样继承的文件，都不会被误判成本 PR 新引入；但 PR
 * 自己的 commit 重新引入 base 历史里出现又删除的路径/blob，仍会被判为新引入（有意为之）。
 */
export function scanHistory(baseSha, head, { cwd = process.cwd() } = {}) {
  const { blobs: baselineBlobs, paths: baselinePaths } = parseTreeSets(
    execFileSync('git', ['ls-tree', '-r', '-z', baseSha], {
      cwd,
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
    })
  );

  // 单次子进程取得 base..head 整段历史、每个 merge commit 逐 parent 展开的 raw diff。
  const output = execFileSync(
    'git',
    ['log', '-m', '--raw', '-z', '--no-abbrev', '--format=__C__%H %P', `${baseSha}..${head}`],
    { cwd, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }
  );

  const seen = new Set();
  const candidates = [];
  for (const change of parseLogRawZ(output)) {
    const path = normalizePath(change.path);
    const key = `${path}\0${change.blob}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      commit: change.commit,
      path,
      blob: change.blob,
      isNewPath: !baselinePaths.has(path),
      // gitlink/submodule 的 newsha 是 commit SHA 而非 blob，只参与路径规则（tmp/ 等），
      // 不参与 blob 对象判定，也不参与大小统计。
      isNewBlob: change.isGitlink ? false : !baselineBlobs.has(change.blob),
      isGitlink: change.isGitlink,
    });
  }

  const sizes = blobSizes(
    candidates.filter((candidate) => !candidate.isGitlink).map((candidate) => candidate.blob),
    cwd
  );
  for (const candidate of candidates) {
    candidate.size = candidate.isGitlink ? 0 : sizes.get(candidate.blob) ?? 0;
  }
  return candidates;
}

/**
 * 最终树临时路径检查。merge 交集会把「从某个 parent 继承的临时文件」排除出历史候选，
 * 但如果这类文件最终仍留在 HEAD 树里（PR 没删除它），它就会通过 PR 重新把禁止的临时
 * 产物带回 main——历史扫描抓不到这种情况。这里对最终树做一次「base 没有、head 有」的
 * 临时路径检查：命中不可白名单的临时路径（tmp/、github-result-*.json、review 快照、
 * CI 日志导出）即失败。只针对临时路径，大对象/二进制仍由历史扫描的 isNewBlob 规则判定。
 */
export function collectFinalTreeTemporaryPaths(baseSha, head, { cwd = process.cwd() } = {}) {
  const { paths: baselinePaths } = parseTreeSets(
    execFileSync('git', ['ls-tree', '-r', '-z', baseSha], {
      cwd,
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
    })
  );
  const { paths: headPaths } = parseTreeSets(
    execFileSync('git', ['ls-tree', '-r', '-z', head], {
      cwd,
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
    })
  );
  const violations = [];
  for (const path of headPaths) {
    if (baselinePaths.has(path)) continue;
    const pathReason = classifyPath(path);
    if (pathReason) {
      violations.push({ commit: head, path, reasons: [pathReason], finalTree: true });
    }
  }
  return violations;
}

function loadAllowlist() {
  return validateAllowlist(JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8')));
}

function shortSha(sha) {
  return sha.slice(0, 8);
}

function main() {
  const { base, head, baseRef } = resolveRange();
  const allowlist = loadAllowlist();
  const candidates = scanHistory(base, head);
  const historyFailures = candidates
    .map((candidate) => evaluateCandidate(candidate, allowlist))
    .filter(Boolean);
  // 历史扫描之外，最终树检查兜底「merge 继承后仍留在最终树」的禁止临时产物。跳过历史
  // 扫描已覆盖的 path（那些已由 historyFailures 判定），避免「新增 tmp 且仍留在 HEAD」
  // 被重复报两次。
  const scannedPaths = new Set(candidates.map((candidate) => candidate.path));
  const finalTreeViolations = collectFinalTreeTemporaryPaths(base, head).filter(
    (violation) => !scannedPaths.has(violation.path)
  );
  const failures = [...historyFailures, ...finalTreeViolations];

  if (failures.length > 0) {
    console.error(
      `Git history hygiene check failed: ${failures.length} disallowed path/blob introduction(s).\n`
    );
    for (const failure of failures) {
      console.error(
        `- commit: ${failure.finalTree ? `${shortSha(failure.commit)} (final tree)` : failure.commit}`
      );
      console.error(`  path:   ${failure.path}`);
      if (!failure.finalTree) {
        console.error(`  blob:   ${failure.blob}`);
        console.error(`  size:   ${failure.size} bytes (${formatBytes(failure.size)})`);
      }
      for (const reason of failure.reasons) {
        console.error(`  rule:   ${reason.rule} — ${reason.detail}`);
      }
    }
    // 按失败类型分支给修复建议：历史引入的临时产物才需要 rewrite/squash（删除提交清不掉
    // 历史 blob）；仅最终树残留的临时路径，合并前删除即可，不要误导贡献者去改写历史。
    const hasHistoryViolation = historyFailures.length > 0;
    if (hasHistoryViolation) {
      console.error('\nDeleting the file in a later commit does not remove its blob from reachable history.');
      console.error('Before merge, rewrite or squash the pull request branch so the object is no longer reachable.');
      console.error(
        `A legitimate large blob, executable, or archive needs an exact path + blob SHA + reason in ${ALLOWLIST_PATH}.`
      );
    }
    if (finalTreeViolations.length > 0) {
      console.error(
        '\nA temporary path remains in the final tree. Delete it before merge; no history rewrite is needed for these.'
      );
    }
    process.exit(1);
  }

  console.log(
    `Git history hygiene check passed: ${candidates.length} path/blob introduction(s) scanned ` +
      `in ${shortSha(base)}..${shortSha(head)} (base ${baseRef}).`
  );
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  try {
    main();
  } catch (error) {
    // 明确区分「检测到违规」（main 里 exit 1）与「检查器自身错误」：后者不是违规判定，
    // 而是环境/代码问题，用退出码 2 以便 CI 区分。避免把工具故障误当成内容违规、无从下手。
    console.error(`Git history hygiene check could not run (checker error, not a violation): ${error?.message ?? error}`);
    process.exit(CHECKER_ERROR_EXIT_CODE);
  }
}
