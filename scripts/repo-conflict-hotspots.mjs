#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HELP = `pnpm repo:conflict-hotspots — 统计未合并 PR 与基线的合并冲突集中在哪些文件、文件里的哪些位置。

用法:
  pnpm repo:conflict-hotspots [--since-days <n>] [--limit <n>] [--top <n>] [--spots <n>]
                              [--base <ref>] [--remote <name>] [--json <file>]

参数:
  --since-days <n>  只看最近 n 天更新过的冲突 PR,默认 14(久未更新的 PR 冲突多半是放弃,不代表当前的痛点)
  --limit <n>       最多模拟合并多少个 PR,默认 200(按最近更新排序)
  --top <n>         文件榜单长度,默认 20
  --spots <n>       对榜单前 n 个文件再定位冲突落在文件内的哪些位置,默认 8
  --base <ref>      合并基线,默认 origin/main(先自行 fetch)
  --remote <name>   PR 所在的远端,默认 origin;列 PR 与取 head 都针对这个远端对应的仓库
  --json <file>     另存结构化结果
  --help            显示本说明

做法:用 gh 列出该远端仓库里状态为冲突的 PR,把各自的 head 取到本次运行独有的临时引用
refs/conflict-hotspots/<本次运行>/*,用 git merge-tree 在内存里与基线模拟合并,读出冲突文件
与冲突标记的位置。

说明:不改工作区、不改任何分支、不向远端写入;临时引用在结束时只删本次运行自己的(多个终端或
worktree 可以同时跑),取回的对象留在本地对象库,由 git gc 回收。需要 gh 已登录、git ≥ 2.38。
同一位置被多数 PR 命中时会标成
「共享追加点」——那是所有人都改同一行或都往同一处插入,见
docs/dev-rules/engineering-conventions.md 的「不制造共享追加点」。`;

/** 每次运行一个独有前缀:并行运行互不覆盖,结束时也只清理自己的引用。 */
const REF_PREFIX = `refs/conflict-hotspots/${process.pid}-${randomBytes(4).toString('hex')}/`;
const FETCH_BATCH = 40;
/** 一个位置被该文件至少这么多个冲突 PR 命中,且占比过半,才标成共享追加点。 */
const SHARED_SPOT_MIN_PRS = 4;

export function parseArgs(argv) {
  const options = { sinceDays: 14, limit: 200, top: 20, spots: 8, base: 'origin/main', remote: 'origin', json: null, help: false };
  const numeric = { '--since-days': 'sinceDays', '--limit': 'limit', '--top': 'top', '--spots': 'spots' };
  const text = { '--base': 'base', '--remote': 'remote', '--json': 'json' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (numeric[arg] || text[arg]) {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} 需要一个值`);
      i += 1;
      if (numeric[arg]) {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${arg} 需要非负整数,收到 ${value}`);
        options[numeric[arg]] = parsed;
      } else {
        options[text[arg]] = value;
      }
    } else {
      throw new Error(`未知参数 ${arg};--help 查看用法`);
    }
  }
  return options;
}

/**
 * 把远端地址(https、ssh://、scp 式 git@host:owner/repo)转成 `gh --repo` 接受的写法:
 * github.com 为 OWNER/REPO,其它主机为 HOST/OWNER/REPO;认不出来返回 null。
 */
export function repoFromRemoteUrl(url) {
  const trimmed = String(url).trim();
  const parsed =
    /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/*$/i.exec(trimmed) ??
    /^(?:[^@/\s]+@)?([^/:\s]+):(?!\/)(.+?)(?:\.git)?\/*$/.exec(trimmed);
  if (!parsed) return null;
  const [, host, path] = parsed;
  if (!/^[^/]+\/[^/]+$/.test(path)) return null;
  return host.toLowerCase() === 'github.com' ? path : `${host}/${path}`;
}

/** 12 个语言的同名文案文件是同一处改动的 12 份副本,合并成一行统计。 */
export function displayPath(file) {
  return file.replace(/\/locales\/[^/]+\//, '/locales/*/');
}

const CODE_LANDMARK = /^(?:export )?(?:default )?(?:abstract )?(?:async )?(?:function|class|const|let|interface|type|enum) |^ {2}(?:const|let|function|async function) \w+|^ {2}[\w.]+\.(?:handle|on)\(/;
const DOC_LANDMARK = /^#{1,4} /;
const DATA_LANDMARK = /^ {0,2}"[^"]+": *[[{]/;

function landmarkOf(line, file) {
  if (/\.(?:md|mdx)$/.test(file)) return DOC_LANDMARK.test(line) ? line.trim() : null;
  if (/\.(?:json|ya?ml)$/.test(file)) return DATA_LANDMARK.test(line) ? line.trim() : null;
  if (/^import /.test(line)) return '(import 区)';
  return CODE_LANDMARK.test(line) ? line.trim() : null;
}

/**
 * 读带冲突标记的合并结果,把每处冲突归到它前面最近的「路标」:import 区、顶层或大函数内的
 * 声明、Markdown 标题、JSON 顶层键。返回每处冲突所属的路标(同一路标可出现多次)。
 */
export function conflictSpots(mergedText, file) {
  const spots = [];
  const clip = (text) => (text.length > 96 ? `${text.slice(0, 95)}…` : text);
  let landmark = '(文件开头)';
  let inConflict = false;
  let atConflictStart = false;
  for (const line of mergedText.split('\n')) {
    if (line.startsWith('<<<<<<< ')) {
      inConflict = true;
      atConflictStart = true;
      spots.push(landmark);
    } else if (line.startsWith('>>>>>>> ')) {
      inConflict = false;
    } else if (inConflict) {
      // 冲突的第一行本身就是路标(例如被两边同时改写的常量声明)时,以它为准。
      const own = atConflictStart ? landmarkOf(line, file) : null;
      if (own) spots[spots.length - 1] = clip(own);
      atConflictStart = false;
    } else {
      const next = landmarkOf(line, file);
      if (next) landmark = clip(next);
    }
  }
  return spots;
}

/** conflicts: Map<pr, string[] files>;spotsByFile: Map<file, Map<spot, Set<pr>>> */
export function summarize(conflicts, spotsByFile, { top, spots }) {
  const prsByFile = new Map();
  for (const [pr, files] of conflicts) {
    for (const file of new Set(files.map(displayPath))) {
      if (!prsByFile.has(file)) prsByFile.set(file, new Set());
      prsByFile.get(file).add(pr);
    }
  }
  const total = conflicts.size;
  const ranked = [...prsByFile]
    .map(([file, prs]) => ({ file, prs: prs.size, share: total ? prs.size / total : 0 }))
    .sort((a, b) => b.prs - a.prs || a.file.localeCompare(b.file));
  const files = ranked.slice(0, top);
  const located = files.slice(0, spots).map(({ file, prs }) => {
    const bySpot = spotsByFile.get(file) ?? new Map();
    const rankedSpots = [...bySpot]
      .map(([spot, hit]) => ({ spot, prs: hit.size }))
      .sort((a, b) => b.prs - a.prs || a.spot.localeCompare(b.spot));
    const lead = rankedSpots[0];
    return {
      file,
      prs,
      distinctSpots: rankedSpots.length,
      spots: rankedSpots.slice(0, 4),
      sharedAppendPoint: Boolean(lead && lead.prs >= SHARED_SPOT_MIN_PRS && lead.prs * 2 > prs),
    };
  });
  return { conflictingPrs: total, files, located };
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

function mergeTree(base, ref) {
  try {
    run('git', ['merge-tree', '--write-tree', '--name-only', '--no-messages', base, ref]);
    return null; // 干净合并
  } catch (error) {
    if (error.status !== 1 || typeof error.stdout !== 'string') throw error;
    const [tree, ...files] = error.stdout.split('\n').filter(Boolean);
    return { tree, files };
  }
}

function deleteTempRefs() {
  const refs = run('git', ['for-each-ref', '--format=%(refname)', REF_PREFIX]).split('\n').filter(Boolean);
  if (refs.length) run('git', ['update-ref', '--stdin'], { input: refs.map((ref) => `delete ${ref}\n`).join(''), stdio: ['pipe', 'pipe', 'pipe'] });
}

function formatReport(summary, meta) {
  const percent = (share) => `${(share * 100).toFixed(1)}%`;
  const lines = [
    `仓库 ${meta.repo}:未合并 PR ${meta.open} 个,其中冲突 ${meta.conflicting} 个;最近 ${meta.sinceDays} 天更新过的冲突 PR ${meta.recent} 个,模拟合并 ${meta.analysed} 个,${summary.conflictingPrs} 个复现出冲突。`,
    `基线 ${meta.base}(${meta.baseSha.slice(0, 10)})。`,
    '',
    '冲突最集中的文件(命中的 PR 数 / 占冲突 PR 的比例):',
    ...summary.files.map(({ file, prs, share }) => `${String(prs).padStart(5)}  ${percent(share).padStart(6)}  ${file}`),
    '',
    '文件内的冲突位置(命中的 PR 数):',
  ];
  for (const entry of summary.located) {
    lines.push(`  ${entry.file} — ${entry.prs} 个 PR,${entry.distinctSpots} 处位置${entry.sharedAppendPoint ? '  ← 共享追加点' : ''}`);
    for (const { spot, prs } of entry.spots) lines.push(`${String(prs).padStart(7)}  ${spot}`);
  }
  if (meta.failed.length) lines.push('', `未能分析的 PR(取不到 head 或合并出错):${meta.failed.join(', ')}`);
  return lines.join('\n');
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }
  const baseSha = run('git', ['rev-parse', '--verify', `${options.base}^{commit}`]).trim();
  // 列 PR 与取 head 必须针对同一个仓库:从所选远端推出仓库,显式交给 gh,不依赖 gh 的默认仓库。
  const remoteUrl = run('git', ['remote', 'get-url', options.remote]).trim();
  const repo = repoFromRemoteUrl(remoteUrl);
  if (!repo) throw new Error(`认不出远端 ${options.remote} 对应的 GitHub 仓库(${remoteUrl});请用 --remote 指向 GitHub 上的远端`);
  const open = JSON.parse(run('gh', ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '2000', '--json', 'number,mergeable,updatedAt']));
  const conflicting = open.filter((pr) => pr.mergeable === 'CONFLICTING');
  const cutoff = new Date(Date.now() - options.sinceDays * 86_400_000).toISOString();
  const recent = conflicting.filter((pr) => pr.updatedAt >= cutoff).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const selected = recent.slice(0, options.limit).map((pr) => pr.number);

  const conflicts = new Map();
  const spotsByFile = new Map();
  const failed = [];
  const merged = new Map(); // pr -> { tree, files }
  try {
    for (let i = 0; i < selected.length; i += FETCH_BATCH) {
      const batch = selected.slice(i, i + FETCH_BATCH);
      try {
        run('git', ['fetch', '--quiet', '--no-tags', options.remote, ...batch.map((n) => `+refs/pull/${n}/head:${REF_PREFIX}${n}`)]);
      } catch {
        // 批量失败(例如其中一个 head 已被删除)时逐个取,取不到的记入 failed。
        for (const n of batch) {
          try {
            run('git', ['fetch', '--quiet', '--no-tags', options.remote, `+refs/pull/${n}/head:${REF_PREFIX}${n}`]);
          } catch {
            failed.push(n);
          }
        }
      }
      process.stderr.write(`\r已取回 ${Math.min(i + FETCH_BATCH, selected.length)}/${selected.length} 个 PR head`);
    }
    process.stderr.write('\n');
    for (const pr of selected) {
      if (failed.includes(pr)) continue;
      try {
        const result = mergeTree(baseSha, `${REF_PREFIX}${pr}`);
        if (result?.files.length) {
          conflicts.set(pr, result.files);
          merged.set(pr, result);
        }
      } catch {
        failed.push(pr);
      }
    }
    const summaryForRanking = summarize(conflicts, spotsByFile, options);
    const wanted = new Set(summaryForRanking.files.slice(0, options.spots).map((entry) => entry.file));
    for (const [pr, { tree, files }] of merged) {
      for (const file of files) {
        const shown = displayPath(file);
        if (!wanted.has(shown)) continue;
        let text;
        try {
          text = run('git', ['show', `${tree}:${file}`]);
        } catch {
          continue; // 删除/改名类冲突没有带标记的合并结果
        }
        if (!spotsByFile.has(shown)) spotsByFile.set(shown, new Map());
        const bySpot = spotsByFile.get(shown);
        for (const spot of new Set(conflictSpots(text, file))) {
          if (!bySpot.has(spot)) bySpot.set(spot, new Set());
          bySpot.get(spot).add(pr);
        }
      }
    }
  } finally {
    deleteTempRefs();
  }

  const summary = summarize(conflicts, spotsByFile, options);
  const meta = {
    open: open.length, conflicting: conflicting.length, recent: recent.length, analysed: selected.length - failed.length,
    sinceDays: options.sinceDays, repo, base: options.base, baseSha, failed,
  };
  console.log(formatReport(summary, meta));
  if (options.json) writeFileSync(options.json, `${JSON.stringify({ ...meta, ...summary }, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
