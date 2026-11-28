// Runs on the trusted main checkout. Release trees supply data only.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { collect, git, replyDestination, wall } from './feedback-credits.mjs';

const branch = 'refs/heads/community-credits';
const bot = 'github-actions[bot]';
const email = '41898282+github-actions[bot]@users.noreply.github.com';

function inputGit(args, input) {
  return execFileSync('git', args, { input, encoding: 'utf8' }).trim();
}

export function publisher() {
  let head;
  if (git('ls-remote', '--heads', 'origin', branch)) {
    git('fetch', '--no-tags', '--depth=1', 'origin', branch);
    head = git('rev-parse', 'FETCH_HEAD');
  }
  const receipts = head ? JSON.parse(git('show', head + ':deliveries.json')) : {};
  function save(files) {
    const entries = Object.entries(files).map(([path, data]) => {
      const blob = inputGit(['hash-object', '-w', '--stdin'], data);
      return '100644 blob ' + blob + '\t' + path;
    });
    const tree = inputGit(['mktree'], entries.join('\n') + '\n');
    if (head && tree === git('rev-parse', head + '^{tree}')) return;
    const next = git('-c', 'user.name=' + bot, '-c', 'user.email=' + email, 'commit-tree', tree,
      ...(head ? ['-p', head] : []), '-m', 'docs: update released feedback credits\n\nSigned-off-by: ' + bot + ' <' + email + '>');
    git('push', 'origin', next + ':' + branch);
    head = next;
  }
  return { receipts, save };
}

function requestFor(row, env) {
  const target = replyDestination(row.replyTo);
  const release = 'https://github.com/makecindy/cindy/releases/tag/' + row.version;
  const text = 'Thanks for your feedback! The change in Cindy PR #' + row.pr + ' shipped in ' + row.version + '. ' + release;
  if (target.service === 'github') return {
    url: 'https://api.github.com/repos/makecindy/cindy/issues/' + target.issue + '/comments',
    token: env.GH_TOKEN, scheme: 'Bearer', body: { body: text },
  };
  if (target.service === 'discord') return {
    url: 'https://discord.com/api/v10/channels/' + target.channel + '/messages',
    token: env.FEEDBACK_DISCORD_TOKEN, scheme: 'Bot',
    body: { content: text, allowed_mentions: { parse: [], replied_user: false },
      message_reference: { guild_id: target.guild, channel_id: target.channel, message_id: target.message, fail_if_not_exists: true } },
  };
  return {
    url: 'https://api.x.com/2/tweets', token: env.FEEDBACK_X_USER_TOKEN, scheme: 'Bearer',
    body: { text, reply: { in_reply_to_tweet_id: target.post } },
  };
}

export async function publish(rows, { receipts, save }, env, send = fetch) {
  const files = {
    'README.md': wall(rows),
    'credits.json': JSON.stringify(rows.map(({ replyTo, ...publicRow }) => publicRow), null, 2) + '\n',
  };
  const persist = () => save({ ...files, 'deliveries.json': JSON.stringify(receipts, null, 2) + '\n' });
  persist();
  const problems = [];
  for (const row of rows.filter(row => row.replyTo)) {
    const key = String(row.pr);
    if (receipts[key]?.status === 'sent') continue;
    if (receipts[key]?.status === 'sending') {
      problems.push('#' + key + ': inspect original thread before retrying an interrupted send');
      continue;
    }
    const req = requestFor(row, env);
    if (!req.token) {
      problems.push('#' + key + ': missing credentials for ' + replyDestination(row.replyTo).service);
      continue;
    }
    // Claim durably before POST. A timeout or crash after acceptance must not send twice.
    receipts[key] = { status: 'sending' };
    persist();
    try {
      const res = await send(req.url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
        headers: { authorization: req.scheme + ' ' + req.token, 'content-type': 'application/json' },
        body: JSON.stringify(req.body) });
      if (!res.ok) {
        if ([400, 401, 403, 404, 429].includes(res.status)) delete receipts[key];
        throw new Error('HTTP ' + res.status);
      }
      const data = await res.json();
      const id = data?.data?.id ?? data?.id;
      if (!id) throw new Error('missing delivery receipt');
      receipts[key] = { status: 'sent', id: String(id) };
    } catch (error) {
      problems.push('#' + key + ': ' + error.message);
    }
    persist();
  }
  if (problems.length) throw new Error(problems.join('\n'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const summaries = execFileSync('gh', ['api', '--paginate', 'repos/makecindy/cindy/releases?per_page=100',
    '--jq', '.[] | {tag_name, published_at, draft} | @json'], { encoding: 'utf8' }).trim();
  const releases = summaries ? summaries.split('\n').map(s => JSON.parse(s)) : [];
  await publish(collect(releases), publisher(), process.env);
}
