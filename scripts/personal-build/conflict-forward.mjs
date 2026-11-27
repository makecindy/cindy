// Developer CLI. Preparing a personal build never invokes this module.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { resolvePnpmInvocation } from '../shared/pnpm-invocation.mjs';
import { replayConflict } from './conflict-resolution.mjs';

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
const oid = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const slug = (value) => typeof value === 'string' && /^[a-z0-9_-]+\/[a-z0-9_-][a-z0-9._-]*$/i.test(value);
const textDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function merge(cwd, head, base) {
  const result = spawnSync(
    'git',
    ['-c', 'merge.conflictStyle=diff3', 'merge-tree', '--write-tree', '--no-messages', '-z', head, base],
    { cwd, maxBuffer: 32 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (![0, 1].includes(result.status)) throw new Error(result.stderr.toString() || 'git merge-tree failed');
  const [tree, ...entries] = textDecoder.decode(result.stdout).split('\0');
  assert(oid(tree), 'Invalid Git merge tree');
  const files = new Map();
  for (const entry of entries.filter(Boolean)) {
    const match = /^(\d+) ([0-9a-f]{40}) ([123])\t([\s\S]+)$/.exec(entry);
    assert(match, 'Unsupported Git conflict entry');
    const [, mode, , stage, file] = match;
    if (!files.has(file)) files.set(file, []);
    files.get(file).push({ mode, stage });
  }
  assert((result.status === 1) === Boolean(files.size), 'Unsupported non-file conflict');
  return { tree, files };
}

function history(report, kind, number) {
  const built = kind === 'app' ? report.app : report.pluginRepository;
  if (!built) {
    assert(kind === 'plugins' && !report.configuration?.plugins, 'Composition is incomplete');
    return [];
  }
  const { repository, checkout, baseSha, target } = built;
  assert(slug(repository) && oid(baseSha) && oid(target) && report.author, 'Incomplete frozen build');
  const pulls = new Map();
  for (const pull of built.prs) {
    // A shared SHA cannot identify which source PR owns a resolution.
    pulls.set(pull.sha, pulls.has(pull.sha) ? null : pull);
  }
  const records = [];
  const log = git(checkout, 'log', '--first-parent', '--format=%H %P', baseSha + '..' + target);
  for (const line of log.split('\n')) {
    const [commit, prior, head, ...extra] = line.split(' ');
    const pull = pulls.get(head);
    if (!pull || extra.length || (number && pull.number !== number)) continue;
    const original = merge(checkout, prior, head);
    if (original.files.size)
      records.push({
        repository,
        number: pull.number,
        author: report.author,
        checkout,
        commit,
        prior,
        head,
        files: [...original.files.keys()],
      });
  }
  return records;
}

function livePull(row) {
  const pr = JSON.parse(
    execFileSync('gh', ['api', '--hostname', 'github.com', `repos/${row.repository}/pulls/${row.number}`], {
      encoding: 'utf8',
    }),
  );
  assert.equal(pr.number, row.number);
  assert.equal(pr.base.repo.full_name.toLowerCase(), row.repository.toLowerCase());
  assert.equal(pr.user.login.toLowerCase(), row.author.toLowerCase(), 'PR author changed');
  if (pr.state !== 'open' || pr.merged) return { state: pr.merged ? 'merged' : 'closed' };
  function branch(side) {
    assert(slug(side.repo?.full_name) && oid(side.sha), 'PR branch unavailable');
    git(row.checkout, 'check-ref-format', 'refs/heads/' + side.ref);
    return {
      url: `https://github.com/${side.repo.full_name}.git`,
      ref: 'refs/heads/' + side.ref,
      sha: side.sha,
    };
  }
  const head = branch(pr.head),
    base = branch(pr.base);
  assert(
    pr.head.ref !== pr.head.repo.default_branch && !(head.url === base.url && head.ref === base.ref),
    'Refusing a base/default branch destination',
  );
  return { state: 'open', head, base };
}

function tip(cwd, branch) {
  const line = git(cwd, 'ls-remote', '--exit-code', '--refs', branch.url, branch.ref);
  const [sha, ref] = line.split('\t');
  assert(oid(sha) && ref === branch.ref, 'Remote branch changed');
  return sha;
}

function regular(cwd, tree, file, stages) {
  assert.deepEqual(
    stages.map((s) => s.stage).sort(),
    ['1', '2', '3'],
    'Only regular content conflicts are transferable',
  );
  const entry = git(
    cwd,
    '--literal-pathspecs',
    'ls-tree',
    '--format=%(objectmode) %(objecttype) %(objectname)',
    tree,
    '--',
    file,
  );
  const [mode, type, hash] = entry.split(' ');
  assert(
    type === 'blob' && ['100644', '100755'].includes(mode) && stages.every((s) => s.mode === mode),
    'File type or mode changed',
  );
  return { mode, text: textDecoder.decode(execFileSync('git', ['cat-file', 'blob', hash], { cwd })) };
}

function candidateTree(row, current, recorded) {
  const cwd = row.checkout;
  const indexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-forward-'));
  const env = { ...process.env, GIT_INDEX_FILE: path.join(indexDir, 'index') };
  const index = (...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trimEnd();
  try {
    index('read-tree', current.tree);
    for (const [file, stages] of current.files) {
      assert(recorded.files.has(file), 'Unrelated conflict: ' + file);
      const old = regular(cwd, recorded.tree, file, recorded.files.get(file));
      const resolved = regular(cwd, row.commit, file, recorded.files.get(file));
      const live = regular(cwd, current.tree, file, stages);
      const value = replayConflict(old.text, resolved.text, live.text);
      const hash = execFileSync('git', ['hash-object', '-w', '--stdin'], {
        cwd,
        input: value,
        encoding: 'utf8',
      }).trim();
      index('update-index', '--cacheinfo', live.mode, hash, file);
    }
    return index('write-tree');
  } finally {
    fs.rmSync(indexDir, { recursive: true, force: true });
  }
}

function compareBranches(cwd, remote) {
  for (const branch of [remote.head, remote.base]) {
    assert.equal(tip(cwd, branch), branch.sha, 'Remote moved; retry with fresh metadata');
    git(cwd, 'fetch', '--no-tags', '--no-write-fetch-head', branch.url, branch.sha);
  }
  return merge(cwd, remote.head.sha, remote.base.sha);
}

// Recheck one live PR per group even when several builds contain a solution.
// Cache the conflict paths for immutable tips, including positives. A failed push stays pending.
export function checkInventory(rows, previous = {}, pull = livePull) {
  const groups = Map.groupBy(rows, (row) => row.repository + '#' + row.number);
  const cache = {},
    pending = [];
  let open = 0;
  for (const [key, group] of groups) {
    const row = group[0];
    assert(
      group.every((r) => r.author === row.author),
      'Conflicting recorded authors',
    );
    const remote = pull(row);
    if (remote.state !== 'open') continue;
    open++;
    const token = JSON.stringify([remote.head, remote.base]);
    const paths =
      previous[key]?.token === token
        ? previous[key].paths
        : [...compareBranches(row.checkout, remote).files.keys()];
    cache[key] = { token, paths };
    const matches = paths.length ? group.filter((r) => paths.every((file) => r.files.includes(file))) : [];
    if (matches.length)
      pending.push({ key, head: remote.head.sha, base: remote.base.sha, files: paths, records: matches });
  }
  return { open, pending, cache };
}

export function forward(row, worktree, checks, { pull = livePull } = {}) {
  const cwd = row.checkout,
    remote = pull(row);
  if (remote.state !== 'open') return { status: remote.state };
  const head = remote.head.sha,
    base = remote.base.sha;
  const current = compareBranches(cwd, remote);
  git(cwd, 'merge-base', '--is-ancestor', row.head, head);
  if (!current.files.size) return { status: 'clean', head, base };
  assert(
    [...current.files.keys()].every((file) => row.files.includes(file)),
    'Conflict outside the original merge',
  );
  const recorded = merge(cwd, row.head, row.prior);
  const tree = candidateTree(row, current, recorded);
  const binding = JSON.stringify([
    row.repository,
    row.number,
    row.author,
    row.commit,
    remote.head,
    remote.base,
  ]);
  const trailer = 'Personal-build-forward: ' + binding;
  let commit;
  if (!fs.existsSync(worktree)) {
    const signoff = git(cwd, 'var', 'GIT_AUTHOR_IDENT').replace(/> .+$/, '>');
    commit = git(
      cwd,
      'commit-tree',
      tree,
      '-p',
      head,
      '-p',
      base,
      '-m',
      `Resolve ${remote.base.ref.slice(11)} conflicts for #${row.number}\n\n${trailer}\nSigned-off-by: ${signoff}`,
    );
    git(cwd, 'worktree', 'add', '--detach', worktree, commit);
  } else {
    assert.equal(
      fs.realpathSync(worktree),
      fs.realpathSync(git(worktree, 'rev-parse', '--show-toplevel')),
      'Expected a worktree root',
    );
    assert.equal(git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD', 'Expected detached worktree');
    commit = git(worktree, 'rev-parse', 'HEAD');
  }
  assert(
    git(worktree, 'show', '-s', '--format=%B', 'HEAD').split('\n').includes(trailer),
    'Reviewed PR destination or recorded resolution changed',
  );
  function verify() {
    assert.equal(
      git(worktree, 'show', '-s', '--format=%H %T %P', 'HEAD'),
      [commit, tree, head, base].join(' '),
      'Stale or different candidate',
    );
    assert.equal(
      git(worktree, 'status', '--porcelain', '--untracked-files=normal'),
      '',
      'Verification requires a clean worktree',
    );
  }
  verify();
  if (!checks) return { status: 'prepared', commit, worktree, head, base, files: [...current.files.keys()] };
  for (const [command, ...args] of checks) {
    const invocation = process.platform === 'win32' && /^pnpm(?:\.cmd)?$/i.test(command)
      ? resolvePnpmInvocation(args, { npmExecPath: command.toLowerCase() === 'pnpm.cmd' ? command : undefined })
      : { command, args };
    execFileSync(invocation.command, invocation.args, {
      cwd: worktree,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, ...invocation.env },
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    verify();
  }
  assert.deepEqual(pull(row), remote, 'PR changed during validation');
  for (const branch of [remote.base, remote.head])
    assert.equal(tip(cwd, branch), branch.sha, 'Remote changed during validation');
  git(
    cwd,
    'push',
    '--no-follow-tags',
    '--recurse-submodules=no',
    remote.head.url,
    commit + ':' + remote.head.ref,
  );
  assert.equal(tip(cwd, remote.head), commit, 'Push not confirmed');
  return { status: 'pushed', commit, head, base };
}

export function conflictForwardCommand(argv) {
  const {
    values,
    positionals: [action, ...reports],
  } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      cache: { type: 'string' },
      repo: { type: 'string' },
      pr: { type: 'string' },
      worktree: { type: 'string' },
      test: { type: 'string' },
      typecheck: { type: 'string' },
    },
  });
  assert(
    reports.length && ['list', 'check', 'prepare', 'push'].includes(action),
    'Expected list REPORT..., check INVENTORY... or prepare/push REPORT --repo app|plugins --pr NUMBER --worktree PATH',
  );
  const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
  if (action === 'check') {
    assert(values.cache, 'Specify a cache file outside the repositories');
    const previous = fs.existsSync(values.cache) ? read(values.cache) : { version: 1, comparisons: {} };
    assert(
      previous?.version === 1 && previous.comparisons && typeof previous.comparisons === 'object',
      'Expected a conflict-forward cache file',
    );
    const { open, pending, cache } = checkInventory(reports.flatMap(read), previous.comparisons);
    const temp = fs.mkdtempSync(path.join(path.dirname(path.resolve(values.cache)), '.forward-cache-'));
    try {
      const file = path.join(temp, 'cache');
      fs.writeFileSync(file, JSON.stringify({ version: 1, comparisons: cache }), { mode: 0o600 });
      fs.renameSync(file, values.cache);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
    return { open, pending };
  }
  if (action === 'list') {
    const unique = new Map();
    for (const file of reports) {
      const report = read(file);
      for (const kind of ['app', 'plugins'])
        for (const row of history(report, kind)) {
          unique.set([row.repository, row.number, row.commit].join(':'), {
            report: path.resolve(file),
            kind,
            ...row,
          });
        }
    }
    return [...unique.values()];
  }
  const number = Number(values.pr);
  assert(
    reports.length === 1 &&
      ['app', 'plugins'].includes(values.repo) &&
      Number.isSafeInteger(number) &&
      number > 0 &&
      values.worktree,
    'Specify one report, repository, PR and worktree',
  );
  const rows = history(read(reports[0]), values.repo, number);
  assert.equal(rows.length, 1, 'Expected one frozen conflict for this PR');
  let checks;
  if (action === 'push') {
    assert(values.test && values.typecheck, 'Both test and typecheck commands are required');
    checks = [values.test, values.typecheck].map((value) => {
      const args = JSON.parse(value);
      assert(
        Array.isArray(args) && args.length && args.every((arg) => typeof arg === 'string') && args[0],
        'Use a JSON command argument array',
      );
      return args;
    });
    assert(fs.existsSync(values.worktree), 'Prepare and review the candidate first');
  }
  return forward(rows[0], path.resolve(values.worktree), checks);
}
