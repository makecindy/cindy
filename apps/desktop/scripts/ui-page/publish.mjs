#!/usr/bin/env node
// `pnpm ui:check:publish [<run dir>] [--remote <name>] [--branch <name>] [--dry-run]`
// Publishes a run's screenshots for a PR description, the way this repo's PRs carry images:
// an orphan-history `pr-assets/…` branch on the chosen GitHub remote, linked
// by commit SHA. The worktree, index and current branch are not touched. Prints the PR text.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { root as repositoryRoot } from './build.mjs';

function parse(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--remote' || arg === '--branch') options[arg.slice(2)] = argv[++i];
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    else options.run = path.resolve(arg);
  }
  return options;
}

/** owner/repo of a GitHub remote URL, or null. */
function githubRepo(url) {
  return /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url)?.[1] ?? null;
}

async function latestRun(root) {
  const base = path.join(root, 'artifacts/ui-check');
  const runs = await Promise.all(
    (await readdir(base, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(async (entry) => {
        const dir = path.join(base, entry.name);
        return { dir, time: (await stat(dir)).mtimeMs };
      }),
  );
  const run = runs
    .filter((item) => existsSync(path.join(item.dir, 'pr.md')))
    .sort((a, b) => b.time - a.time)[0];
  if (!run) throw new Error('No ui:check run with pr.md; run pnpm ui:check first');
  return run.dir;
}

export async function publishScreenshots(argv, {
  root = repositoryRoot,
  git = (args, input) => execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim(),
  log = console.log,
} = {}) {
  const options = parse(argv);
  const run = options.run ?? (await latestRun(root));
  const summary = JSON.parse(await readFile(path.join(run, 'summary.json'), 'utf8'));
  const images = summary.overviews ?? (summary.overview ? [summary.overview] : []);
  if (!images.length) throw new Error(`${run} has no overview images`);

  // Use the normal development remote, including the PR's own repository. Never silently
  // select another repository. Links use the URL git actually pushes to.
  const remotes = git(['remote']).split('\n').filter(Boolean);
  const pushRepo = (name) => githubRepo(git(['remote', 'get-url', '--push', name]));
  const remote = options.remote ?? (remotes.includes('origin') ? 'origin' : undefined);
  const repo = remote && pushRepo(remote);
  if (!repo)
    throw new Error('需要 GitHub origin 远端，或用 --remote 明确指定有写权限的 GitHub 远端');

  const current = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = options.branch ?? `pr-assets/${current === 'HEAD' ? 'detached' : current}`;
  if (!branch.startsWith('pr-assets/') || branch === 'pr-assets/')
    throw new Error('截图只能发布到 pr-assets/ 下的专用分支');
  git(['check-ref-format', `refs/heads/${branch}`]);
  const folder = path.basename(run);

  // One commit per run under its own folder; earlier runs stay reachable through the parent.
  const entries = [];
  for (const file of images) {
    const blob = git(['hash-object', '-w', file]);
    entries.push(`100644 blob ${blob}\t${path.basename(file)}`);
  }
  const runTree = git(['mktree'], `${entries.join('\n')}\n`);
  const tree = git(['mktree'], `040000 tree ${runTree}\t${folder}\n`);
  let parent = '';
  try {
    parent = git(['ls-remote', remote, `refs/heads/${branch}`]).split('\t')[0];
    if (parent) git(['fetch', '--quiet', remote, `refs/heads/${branch}`]);
  } catch {
    parent = '';
  }
  const author = git(['var', 'GIT_AUTHOR_IDENT']).replace(/>.*$/, '>');
  const message = `ui:check screenshots ${folder}\n\nNot for merging; referenced by PR descriptions.\n\nSigned-off-by: ${author}`;
  const commit = git(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message]);
  if (!options.dryRun) git(['push', '--quiet', remote, `${commit}:refs/heads/${branch}`]);

  const url = (file) =>
    `https://raw.githubusercontent.com/${repo}/${commit}/${folder}/${path.basename(file)}`;
  const text = (await readFile(path.join(run, 'pr.md'), 'utf8')).replace(
    /\n<!-- 截图：[^\n]*-->\n?$/,
    `\n${images.map((file, i) => `![单页验证截图 ${i + 1}/${images.length}](${url(file)})`).join('\n')}\n`,
  );
  const out = path.join(run, 'pr.published.md');
  await writeFile(out, text);
  log(
    `UI_PUBLISH${options.dryRun ? ' (dry run, not pushed)' : ''} ${repo}@${branch} ${commit.slice(0, 12)} · ${images.length} images\npr: ${out}\n`,
  );
  log(text);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  publishScreenshots(process.argv.slice(2)).catch((error) => {
    console.error(`单页验证截图未能发布：${error.message.split('\n')[0]}`);
    process.exitCode = 1;
  });
}
