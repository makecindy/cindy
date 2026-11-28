// Public credit records are released with the change that they describe.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const folder = '.github/feedback-credits';
const repo = 'makecindy/cindy';
const ghBase = 'https://github.com/' + repo;
const versionTag = /^v\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;

export function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trimEnd();
}

function line(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max &&
    value === value.trim() && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value);
}

export function replyDestination(url) {
  let match = /^https:\/\/github\.com\/makecindy\/cindy\/issues\/([1-9]\d*)$/.exec(url);
  if (match) return { service: 'github', issue: match[1] };
  match = /^https:\/\/x\.com\/[A-Za-z0-9_]{1,15}\/status\/(\d{1,20})$/.exec(url);
  if (match) return { service: 'x', post: match[1] };
  match = /^https:\/\/discord\.com\/channels\/(\d{1,20})\/(\d{1,20})\/(\d{1,20})$/.exec(url);
  if (match) return { service: 'discord', guild: match[1], channel: match[2], message: match[3] };
  throw new Error('replyTo must be a public Cindy issue, X post or Discord message permalink');
}

function readRecord(ref, file) {
  const prText = file.slice(folder.length + 1).match(/^([1-9]\d{0,9})\.json$/)?.[1];
  if (!prText) throw new Error('Expected ' + folder + '/<implementation PR number>.json');
  const data = JSON.parse(git('show', ref + ':' + file));
  if (!data || Object.keys(data).some(k => !['change', 'contributors', 'replyTo'].includes(k)) ||
      !line(data.change, 240) || !Array.isArray(data.contributors) || !data.contributors.length) {
    throw new Error('Expected change, contributors and optional replyTo in ' + file);
  }
  const authors = [];
  const names = data.contributors.map(person => {
    if (!line(person, 200)) throw new Error('Invalid public credit in ' + file);
    const match = /^([^<>]+) <([^\s<>@]+@[^\s<>@]+)>$/.exec(person);
    const name = match ? match[1] : person;
    if (!line(name, 100) || /[<>]/.test(name) || /\S@\S/.test(name)) throw new Error('Invalid display name in ' + file);
    if (match) authors.push(person);
    return name;
  });
  if (data.replyTo !== undefined) {
    if (!line(data.replyTo, 180)) throw new Error('Invalid replyTo in ' + file);
    replyDestination(data.replyTo);
  }
  return { pr: Number(prText), change: data.change, names, authors, replyTo: data.replyTo };
}

function paths(output) {
  return output.split('\0').filter(Boolean);
}

function changed(...range) {
  return paths(git('diff', '--no-renames', '--name-only', '--diff-filter=AM', '-z', ...range, '--', folder));
}

export function commit(message) {
  if (!message) throw new Error('Usage: node scripts/feedback-credits.mjs commit "commit message"');
  const files = changed('--cached');
  if (!files.length) throw new Error('Stage the credit record alongside the change first');
  const authors = new Set(files.flatMap(file => readRecord('', file).authors));
  const trailers = [...authors].flatMap(author => ['--trailer', 'Co-authored-by: ' + author]);
  execFileSync('git', ['commit', '-s', '-m', message, ...trailers], { stdio: 'inherit' });
}

export function checkPr(base, head, pr) {
  const mergeBase = git('merge-base', base, head);
  const messages = git('log', '--format=%(trailers:key=Co-authored-by,valueonly)', mergeBase + '..' + head).split('\n');
  for (const file of changed(mergeBase, head)) {
    const record = readRecord(head, file);
    const added = git('diff', '--no-renames', '--name-only', '--diff-filter=A', mergeBase, head, '--', file);
    if (added && record.pr !== Number(pr)) throw new Error('New credit filename must match implementation PR #' + pr);
    const previous = added ? [] : readRecord(mergeBase, file).authors;
    if (record.authors.some(author => !previous.includes(author) && !messages.includes(author))) {
      throw new Error('Missing confirmed co-author trailer. Use the feedback credit commit command.');
    }
  }
}

export function collect(releases) {
  // The reviewed main snapshot also allows a later name correction or withdrawal.
  const active = new Set(paths(git('ls-tree', '-rz', '--name-only', 'HEAD', '--', folder)));
  const rows = new Map();
  if (!active.size) return [];
  for (const release of releases.filter(r => !r.draft && r.published_at && versionTag.test(r.tag_name))
    .sort((a, b) => a.published_at.localeCompare(b.published_at) || a.tag_name.localeCompare(b.tag_name))) {
    const ref = 'refs/tags/' + release.tag_name;
    for (const file of paths(git('ls-tree', '-rz', '--name-only', ref, '--', folder))) {
      if (!active.has(file) || rows.has(file)) continue;
      const { authors, ...credit } = readRecord('HEAD', file);
      rows.set(file, { ...credit, version: release.tag_name, publishedAt: release.published_at });
    }
    if (rows.size === active.size) break;
  }
  return [...rows.values()].reverse();
}

// Escape all user text as literals in the generated GitHub Markdown.
function literal(value) {
  return value.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])
    .replace(/([\\`*_{}\[\]()#+.!|~])/g, '\\$1');
}

export function wall(rows) {
  const lines = ['# 社区贡献墙 · Community credits', ''];
  if (!rows.length) lines.push('等待首条已发布的反馈贡献 · No released feedback credits yet.');
  let version;
  for (const row of rows) {
    if (version !== row.version) {
      version = row.version;
      lines.push('', '## [' + version + '](' + ghBase + '/releases/tag/' + version + ')', '');
    }
    lines.push('- ' + literal(row.change) + ' — ' + row.names.map(literal).join(' · ') +
      ' ([#' + row.pr + '](' + ghBase + '/pull/' + row.pr + '))');
  }
  return lines.join('\n') + '\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'commit' && args.length === 1) commit(args[0]);
  else if (mode === 'check' && args.length === 3) checkPr(...args);
  else throw new Error('Expected commit <message> or check <base> <head> <pr>');
}
