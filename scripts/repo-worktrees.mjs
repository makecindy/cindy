#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HELP = `pnpm repo:worktrees — 只读巡检本仓库全部 git worktree,按风险分类输出报告。

用法:
  pnpm repo:worktrees [--json] [--base <ref>]

参数:
  --json         输出结构化 JSON(供 agent / 脚本消费)
  --base <ref>   合入判定基线,默认 origin/main
  --help         显示本说明

分类(按风险从高到低排序):
  status unavailable          Git 无法读取工作区状态,不能判断是否干净
  detached dirty danger        detached HEAD 且有未提交改动,最危险
  HEAD merged, worktree dirty  分支已合入基线(含以 squash 合入基线的 PR),但工作区有未提交
                               改动(dirty-tail,人工判断弃留)
  dirty WIP                    在途工作,有未提交改动
  local unpushed feature       本地未推送的功能分支(无 upstream,或领先 upstream 有未 push 提交)
  active PR                    关联 open PR,勿动
  clean branch / PR <state>    干净分支 / PR 已关闭或合并
  detached clean               detached HEAD 且干净,用途与任务归属尚未核对
  clean HEAD in base           HEAD 已在基线且工作区干净,也可能是刚建好的任务
  main clean                   main 基线现场

说明:本脚本纯只读、不删除任何东西;PR 状态来自 gh CLI(未登录时该列为 "-")。
squash 合入后分支提交不在基线历史里,base 列显示 pr-merged:表示 HEAD 被一个合入提交已在
本地基线里的 PR 覆盖(HEAD 等于或早于该 PR 的最终提交;基线未 fetch 到该合入时不显示)。
PR 先按分支名与最终提交匹配,
都没匹配上的分支再按 HEAD 提交批量搜索一次。
报告不查询 Cindy 活跃任务,不判定任何工作区可删除。清理前仍须核对任务归属、
PR 终态、未推送修改与保留标记,并走现有 cleanup planner。

`;

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', options.allowFailure ? 'ignore' : 'pipe'],
  }).trimEnd();
}

function tryGit(args, options = {}) {
  try {
    return git(args, { ...options, allowFailure: true });
  } catch {
    return null;
  }
}

function tryExec(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      cwd: options.cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trimEnd();
  } catch {
    return null;
  }
}

function commandOk(command, args, options = {}) {
  try {
    execFileSync(command, args, {
      cwd: options.cwd,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function parseWorktrees(text) {
  return text
    .split(/\n\n+/)
    .filter(Boolean)
    .map((block) => {
      const item = {};
      for (const line of block.split('\n')) {
        const index = line.indexOf(' ');
        const key = index === -1 ? line : line.slice(0, index);
        const value = index === -1 ? true : line.slice(index + 1);
        if (key === 'worktree') item.path = value;
        if (key === 'HEAD') item.head = value;
        if (key === 'branch') item.branchRef = value;
        if (key === 'detached') item.detached = true;
      }
      return item;
    });
}

function fetchPrRows(root, state) {
  const gh = tryExec(
    'gh',
    [
      'pr',
      'list',
      '--state',
      state,
      '--limit',
      '200',
      '--json',
      PR_FIELDS,
    ],
    { cwd: root },
  );
  if (!gh) return [];
  try {
    return JSON.parse(gh);
  } catch {
    return [];
  }
}

const PR_FIELDS = 'headRefName,headRefOid,mergeCommit,number,state,isDraft,title,url,isCrossRepository';

// 同一个键对应多条 PR 时:OPEN 优先,其次 number 取大。不依赖 gh 返回顺序的 Map
// 覆盖语义——open PR 被旧 closed PR 顶掉会让在途 worktree 被误标成可清理。
function preferPr(map, key, row) {
  const prev = map.get(key);
  const openDelta = Number(row.state === 'OPEN') - Number(prev?.state === 'OPEN');
  if (!prev || openDelta > 0 || (openDelta === 0 && row.number > prev.number)) map.set(key, row);
}

export function buildPrIndex(rows) {
  const byBranch = new Map();
  const byHead = new Map();
  for (const row of rows) {
    // 最终提交是全局唯一的,fork PR 也可以按它匹配本地 HEAD。
    if (row.headRefOid) preferPr(byHead, row.headRefOid, row);
    // fork PR 的 headRefName 是对方仓库里的分支名,与本地 origin 分支不对应,
    // 按名字入表会把本地同名分支错误关联到无关 PR。同名分支复用(删旧建新)也会
    // 出现多条 PR。
    if (!row.isCrossRepository) preferPr(byBranch, row.headRefName, row);
  }
  return { byBranch, byHead };
}

/**
 * 给 worktree 选关联 PR:同名分支的 OPEN PR(在途工作)优先;其次是最终提交等于本地 HEAD
 * 的 PR(squash 合入后唯一可靠的对应关系,也能跳过同名分支复用留下的旧 PR);最后才回退到
 * 同名分支最新的 PR。
 */
export function selectPr({ branch, head, index }) {
  const named = branch && branch !== 'DETACHED' ? index.byBranch.get(branch) ?? null : null;
  if (named?.state === 'OPEN') return named;
  return (head && index.byHead.get(head)) || named;
}

function loadPrIndex(root) {
  // open 单独拉一遍:--state all 的 limit 作用在全历史上,PR 总数超过 limit 时老而仍 open
  // 的 PR 会被挤出;open 专查保证在途 PR 不丢。
  return [...fetchPrRows(root, 'open'), ...fetchPrRows(root, 'all')];
}

// --state all 只覆盖最近 200 条 PR(主仓约两天的量)。更早 squash 合入的分支按 HEAD 提交
// 搜索补查:每 20 个 worktree 合成一次 GraphQL 请求,只查前面没匹配上的,失败就保持未知。
function searchPrsByHead(root, heads) {
  if (!heads.length) return [];
  const slug = tryExec('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { cwd: root });
  if (!slug || !/^[\w.-]+\/[\w.-]+$/.test(slug)) return [];
  const fields = 'number state isDraft title url isCrossRepository headRefName headRefOid mergeCommit { oid }';
  const found = [];
  for (let start = 0; start < heads.length; start += 20) {
    const chunk = heads.slice(start, start + 20);
    const query = `query {${chunk
      .map((sha, i) => ` q${i}: search(query: "repo:${slug} is:pr ${sha}", type: ISSUE, first: 5) { nodes { ... on PullRequest { ${fields} } } }`)
      .join('')} }`;
    const output = tryExec('gh', ['api', 'graphql', '-f', `query=${query}`], { cwd: root });
    if (!output) continue;
    try {
      const data = JSON.parse(output).data ?? {};
      chunk.forEach((sha, i) => {
        // 搜索也会命中正文里提到这个提交的 PR,只收最终提交正好是它的那条。
        for (const node of data[`q${i}`]?.nodes ?? []) if (node?.headRefOid === sha) found.push(node);
      });
    } catch {
      // 只读报告:补查失败时这些 worktree 仍按原有信息分类。
    }
  }
  return found;
}

/**
 * HEAD 是否被一个已进入所选基线的 PR 覆盖:PR 的合入提交是基线的祖先,且 HEAD 等于该 PR 的
 * 最终提交或是它的祖先。只看目标分支名不够——PR 刚在 GitHub 合入而本地基线还没 fetch、或
 * --base 指向落后的本地分支时,内容并不在这份报告的基线里。isAncestor(a, b) 回答 a 是否为
 * b 的祖先;提交不在本地时为 false,按未覆盖处理。
 */
export function mergedPrCoversHead({ head, base, pr, isAncestor }) {
  const mergeCommit = pr?.mergeCommit?.oid;
  if (pr?.state !== 'MERGED' || !pr.headRefOid || !mergeCommit || !isAncestor(mergeCommit, base)) return false;
  return pr.headRefOid === head || isAncestor(head, pr.headRefOid);
}

function countStatus(path) {
  const output = tryGit(['-C', path, 'status', '--porcelain=v1']);
  return parseWorktreeStatus(output);
}

export function parseWorktreeStatus(output) {
  if (output === null) return { dirty: null, untracked: null, tracked: null };
  const lines = output.split('\n').filter(Boolean);
  return {
    dirty: lines.length,
    untracked: lines.filter((line) => line.startsWith('??')).length,
    tracked: lines.filter((line) => !line.startsWith('??')).length,
  };
}

function aheadBehind(path, base) {
  const output = tryGit(['-C', path, 'rev-list', '--left-right', '--count', `${base}...HEAD`]);
  if (!output) return { behind: null, ahead: null };
  const [behind, ahead] = output.split(/\s+/).map((value) => Number.parseInt(value, 10));
  return {
    behind: Number.isFinite(behind) ? behind : null,
    ahead: Number.isFinite(ahead) ? ahead : null,
  };
}

export function classifyWorktree(row) {
  if (row.dirty === null) return 'status unavailable';
  if (row.detached && row.dirty > 0) return 'detached dirty danger';
  // squash 合入后分支提交不在基线历史里,只能由覆盖 HEAD 的已合入 PR 证明内容已进基线。
  if (row.dirty > 0 && (row.inBase || row.mergedByPr)) return 'HEAD merged, worktree dirty';
  if (row.dirty > 0) return 'dirty WIP';
  // detached + 干净 = 临时检出(review-pr --detach 等),没有分支可推送/删除,
  // 不据此判断临时检出或个人构建是否仍有使用者。
  if (row.detached) return 'detached clean';
  // 已有开放 PR 的在途分支仍优先展示为 active PR，upstream 读取失败不能掩盖它。
  if (row.branch !== 'main' && row.pr?.state === 'OPEN') return 'active PR';
  if (!row.inBase && row.upstream !== 'none' && row.aheadOfUpstream === null) return 'status unavailable';
  // main 本地领先 upstream(有未 push 的 commit)时不是干净基线,同样按未推送
  // 的活处理,不能藏进最低风险的 main clean。
  if (row.branch === 'main') {
    return (row.aheadOfUpstream ?? 0) > 0 ? 'local unpushed feature' : 'main clean';
  }
  // 新任务的初始 HEAD 同样在基线里,祖先关系不能证明 owning session 已结束。
  if (row.inBase) return 'clean HEAD in base';
  // 已合入的 PR 只有覆盖当前 HEAD 才算数:合入后本地又有新提交,或同名分支复用留下的
  // 旧 PR,都不能把这里的工作说成已合并,继续按 upstream 判断是否未推送。
  if (row.pr && (row.pr.state !== 'MERGED' || row.mergedByPr)) return `PR ${row.pr.state.toLowerCase()}`;
  if (row.upstream === 'none') return 'local unpushed feature';
  // 有 upstream 但本地领先(未 push 的提交)同样是未推送的活,不能归入 clean branch。
  if ((row.aheadOfUpstream ?? 0) > 0) return 'local unpushed feature';
  return 'clean branch';
}

function formatPr(pr) {
  if (!pr) return '-';
  const draft = pr.isDraft ? ' draft' : '';
  return `#${pr.number} ${pr.state}${draft}`;
}

function pad(value, width) {
  const string = String(value);
  return string.length >= width ? string : string + ' '.repeat(width - string.length);
}

function printTable(rows) {
  const columns = [
    ['class', 28],
    ['dirty', 7],
    ['branch', 40],
    ['base', 12],
    ['ahead/behind', 13],
    ['pr', 14],
    ['path', 0],
  ];
  console.log(columns.map(([name, width]) => (width ? pad(name, width) : name)).join('  '));
  console.log(columns.map(([, width]) => (width ? '-'.repeat(width) : '----')).join('  '));
  for (const row of rows) {
    const values = {
      class: row.classification,
      dirty: `${row.dirty ?? '?'}/${row.untracked ?? '?'}`,
      branch: row.branch,
      base: row.inBase ? 'in-main' : row.mergedByPr ? 'pr-merged' : 'not-main',
      'ahead/behind': `${row.ahead ?? '?'}/${row.behind ?? '?'}`,
      pr: formatPr(row.pr),
      path: row.path,
    };
    console.log(columns.map(([name, width]) => (width ? pad(values[name], width) : values[name])).join('  '));
  }
}

export function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }
  const root = git(['rev-parse', '--show-toplevel']);
  const base = process.argv.includes('--base') ? process.argv[process.argv.indexOf('--base') + 1] : 'origin/main';
  const asJson = process.argv.includes('--json');

  // base 解析不了时 merge-base / rev-list 会对所有 worktree 静默失败,整份报告的
  // in-main / ahead/behind 全部失真却无任何提示——必须在这里硬失败。
  // 覆盖两种常见情形:--base 漏传值(undefined / 吞掉下一个 flag)、基线 ref 本地
  // 不存在(origin/main 未 fetch / 拼错)。
  if (!base || base.startsWith('-')) {
    console.error('error: --base 缺少值(用法: pnpm repo:worktrees --base <ref>)');
    process.exit(1);
  }
  if (!commandOk('git', ['rev-parse', '--verify', '--quiet', `${base}^{commit}`], { cwd: root })) {
    console.error(
      `error: 基线 "${base}" 无法解析为 commit。origin/* 基线请先 git fetch origin;自定义 --base 请检查拼写。`,
    );
    process.exit(1);
  }

  const prRows = loadPrIndex(root);
  const worktrees = parseWorktrees(git(['worktree', 'list', '--porcelain']));
  const rawRows = worktrees.map((worktree) => {
    const branch = tryGit(['-C', worktree.path, 'symbolic-ref', '--short', '-q', 'HEAD']) ?? 'DETACHED';
    const upstream =
      tryGit(['-C', worktree.path, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']) ?? 'none';
    // 领先自己 upstream 的 commit 数:有 upstream 但本地还有未 push 的提交时,
    // 该分支不能被当成低风险 clean branch(删了会丢未推送的活)。
    const aheadOfUpstreamRaw =
      upstream === 'none' ? null : tryGit(['-C', worktree.path, 'rev-list', '--count', '@{u}..HEAD']);
    const aheadOfUpstream = aheadOfUpstreamRaw === null ? null : Number.parseInt(aheadOfUpstreamRaw, 10) || 0;
    const status = countStatus(worktree.path);
    const inBase = commandOk('git', ['-C', worktree.path, 'merge-base', '--is-ancestor', 'HEAD', base]);
    const counts = aheadBehind(worktree.path, base);
    const subject = tryGit(['-C', worktree.path, 'log', '-1', '--format=%s']) ?? '';
    const row = {
      path: worktree.path,
      branch,
      head: (worktree.head ?? '').slice(0, 12),
      detached: branch === 'DETACHED',
      upstream,
      aheadOfUpstream,
      inBase,
      ahead: counts.ahead,
      behind: counts.behind,
      dirty: status.dirty,
      tracked: status.tracked,
      untracked: status.untracked,
      subject,
      fullHead: worktree.head ?? '',
    };
    return row;
  });

  let index = buildPrIndex(prRows);
  const unmatched = rawRows
    .filter((row) => !row.inBase && !row.detached && row.branch !== 'main' && row.fullHead)
    .filter((row) => {
      const pr = selectPr({ branch: row.branch, head: row.fullHead, index });
      return !pr || (pr.state !== 'OPEN' && pr.headRefOid !== row.fullHead);
    })
    .map((row) => row.fullHead);
  const searched = searchPrsByHead(root, [...new Set(unmatched)]);
  if (searched.length) index = buildPrIndex([...prRows, ...searched]);

  const rows = rawRows.map(({ fullHead, ...row }) => {
    const pr = selectPr({ branch: row.branch, head: fullHead, index }) ?? null;
    const mergedByPr = !row.inBase && mergedPrCoversHead({
      head: fullHead,
      base,
      pr,
      isAncestor: (ancestor, descendant) =>
        commandOk('git', ['-C', row.path, 'merge-base', '--is-ancestor', ancestor, descendant]),
    });
    const full = { ...row, pr, mergedByPr };
    return { ...full, classification: classifyWorktree(full) };
  });

  rows.sort((a, b) => {
    const rank = {
      'status unavailable': -1,
      'detached dirty danger': 0,
      'HEAD merged, worktree dirty': 1,
      'dirty WIP': 2,
      'local unpushed feature': 3,
      'active PR': 4,
      'clean branch': 5,
      'detached clean': 6,
      'clean HEAD in base': 7,
      'main clean': 8,
    };
    return (rank[a.classification] ?? 5) - (rank[b.classification] ?? 5) || a.path.localeCompare(b.path);
  });

  if (asJson) {
    console.log(JSON.stringify({ base, cleanupVerified: false, rows }, null, 2));
  } else {
    console.log(`Base: ${base}`);
    console.log('dirty is total/untracked');
    console.log('Task ownership is not checked; no classification authorizes removal.');
    printTable(rows);
  }
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
