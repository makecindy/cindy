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
  HEAD merged, worktree dirty  分支已合入基线,但工作区有未提交改动(dirty-tail,人工判断弃留)
  dirty WIP                    在途工作,有未提交改动
  local unpushed feature       本地未推送的功能分支(无 upstream,或领先 upstream 有未 push 提交)
  active PR                    关联 open PR,勿动
  clean branch / PR <state>    干净分支 / PR 已关闭或合并
  detached clean               detached HEAD 且干净,用途与任务归属尚未核对
  clean HEAD in base           HEAD 已在基线且工作区干净,也可能是刚建好的任务
  main clean                   main 基线现场

说明:本脚本纯只读、不删除任何东西;PR 状态来自 gh CLI(未登录时该列为 "-")。
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
      'headRefName,number,state,isDraft,title,url,isCrossRepository',
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

function loadPrMap(root) {
  const map = new Map();
  const consider = (row) => {
    // fork PR 的 headRefName 是对方仓库里的分支名,与本地 origin 分支不对应,
    // 入表会把本地同名分支错误关联到无关 PR。
    if (row.isCrossRepository) return;
    const prev = map.get(row.headRefName);
    if (!prev) {
      map.set(row.headRefName, row);
      return;
    }
    // 同名分支复用(删旧建新)会出现多条 PR:OPEN 优先,其次 number 取大,
    // 不依赖 gh 返回顺序的 Map 覆盖语义——open PR 被旧 closed PR 顶掉会让
    // 在途 worktree 被误标成可清理。
    const openDelta = Number(row.state === 'OPEN') - Number(prev.state === 'OPEN');
    if (openDelta > 0 || (openDelta === 0 && row.number > prev.number)) {
      map.set(row.headRefName, row);
    }
  };
  // open 单独拉一遍先入表:--state all 的 limit 作用在全历史上,PR 总数超过
  // limit 时老而仍 open 的 PR 会被挤出;open 专查保证在途 PR 不丢。
  for (const row of fetchPrRows(root, 'open')) consider(row);
  for (const row of fetchPrRows(root, 'all')) consider(row);
  return map;
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
  if (row.dirty > 0 && row.inBase) return 'HEAD merged, worktree dirty';
  if (row.dirty > 0) return 'dirty WIP';
  // detached + 干净 = 临时检出(review-pr --detach 等),没有分支可推送/删除,
  // 不据此判断临时检出或个人构建是否仍有使用者。
  if (row.detached) return 'detached clean';
  // main 本地领先 upstream(有未 push 的 commit)时不是干净基线,同样按未推送
  // 的活处理,不能藏进最低风险的 main clean。
  if (row.branch === 'main') {
    return (row.aheadOfUpstream ?? 0) > 0 ? 'local unpushed feature' : 'main clean';
  }
  if (row.pr?.state === 'OPEN') return 'active PR';
  // 新任务的初始 HEAD 同样在基线里,祖先关系不能证明 owning session 已结束。
  if (row.inBase) return 'clean HEAD in base';
  if (row.pr) return `PR ${row.pr.state.toLowerCase()}`;
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
      base: row.inBase ? 'in-main' : 'not-main',
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

  const prMap = loadPrMap(root);
  const worktrees = parseWorktrees(git(['worktree', 'list', '--porcelain']));
  const rows = worktrees.map((worktree) => {
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
      pr: prMap.get(branch) ?? null,
    };
    return { ...row, classification: classifyWorktree(row) };
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
