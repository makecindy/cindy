// Integration: exercise the actual commit, PR check and release publisher. Repo section
// “Crediting feedback” requires confirmed attribution to survive squash, to go live only
// with a release, and to notify once. Existing DCO tests only cover sign-off trailers.
// Minimal failures: same credit in two tags, nickname without email, or a lost POST receipt.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkPr, collect, commit, git } from '../feedback-credits.mjs';
import { publish, publisher } from '../publish-feedback-credits.mjs';

test('confirmed credit follows the implementation into its first published release', async t => {
  const before = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), 'cindy-credit-'));
  process.chdir(dir);
  t.after(() => { process.chdir(before); rmSync(dir, { recursive: true, force: true }); });
  git('init', '-q', '-b', 'main');
  git('config', 'core.hooksPath', join(dir, 'no-hooks'));
  git('config', 'user.name', 'Implementer');
  git('config', 'user.email', 'implementer@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('commit', '-q', '-s', '--allow-empty', '-m', 'base');
  git('tag', 'v1.0.0');
  git('switch', '-qc', 'fix');
  mkdirSync('.github/feedback-credits', { recursive: true });
  const record = { change: 'Restore messages', contributors: ['Reader', 'Helper <helper@example.invalid>'] };
  writeFileSync('.github/feedback-credits/42.json', JSON.stringify(record));
  git('add', '.github');
  commit('fix: restore messages');
  git('branch', 'credited');
  git('commit', '--amend', '-sqm', 'strip the trailer');
  assert.throws(() => checkPr('main', 'HEAD', 42), /Missing confirmed co-author/);
  git('switch', '-q', 'credited');
  checkPr('main', 'HEAD', 42);
  assert.throws(() => checkPr('main', 'HEAD', 43), /PR #43/);
  assert.equal(git('log', '-1', '--format=%(trailers:key=Co-authored-by,valueonly)'), record.contributors[1]);
  assert.match(git('log', '-1', '--format=%B'), /Signed-off-by: Implementer/);
  git('switch', '-q', 'main');
  git('merge', '--squash', 'credited');
  // Match this repository's squash setting (PR title and implementation commit messages).
  git('commit', '-sq', '-m', 'fix: restore messages (#42)', '-m', git('log', '-1', '--format=%B', 'credited'));
  git('tag', 'v1.1.0-beta');
  git('tag', 'v1.1.0');
  const released = ['v1.0.0', 'v1.1.0-beta', 'v1.1.0'].map((tag_name, i) =>
    ({ tag_name, published_at: '2026-11-0' + (i + 1) }));
  assert.deepEqual(collect([released[0], { ...released[1], draft: true }]), []);
  const rows = collect(released.reverse());
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].names, ['Reader', 'Helper']);
  assert.equal(rows[0].version, 'v1.1.0-beta');
  assert.doesNotMatch(JSON.stringify(rows), /example.invalid/);
  const remote = join(dir, 'public.git');
  git('init', '-q', '--bare', remote);
  git('remote', 'add', 'origin', remote);
  await publish(rows, publisher(), {});
  const published = git('ls-remote', '--heads', 'origin');
  assert.match(published, /^[0-9a-f]+\s+refs\/heads\/community-credits$/);
  assert.match(git('--git-dir', remote, 'show', 'community-credits:README.md'), /Restore messages/);
  assert.match(git('--git-dir', remote, 'show', 'community-credits:credits.json'), /v1.1.0-beta/);
  assert.doesNotMatch(git('--git-dir', remote, 'show', 'community-credits:credits.json'), /example.invalid/);
  await publish(rows, publisher(), {});
  assert.equal(git('ls-remote', '--heads', 'origin'), published);
  git('rm', '.github/feedback-credits/42.json');
  git('commit', '-sqm', 'withdraw public credit');
  assert.deepEqual(collect(released), []);
});

test('wall is public before notification and replay does not duplicate accepted or uncertain sends', async () => {
  const sources = ['https://github.com/makecindy/cindy/issues/11', 'https://x.com/example/status/22',
    'https://discord.com/channels/1/2/33'];
  const rows = sources.map((replyTo, i) => ({ pr: i + 1, names: ['Reader'], change: 'Fix',
    version: 'v1.1.0', replyTo }));
  let files;
  const state = { receipts: {}, save: data => { files = structuredClone(data); } };
  const env = { GH_TOKEN: 'test', FEEDBACK_X_USER_TOKEN: 'test', FEEDBACK_DISCORD_TOKEN: 'test' };
  const calls = [];
  const send = (url, req) => {
    calls.push([url, JSON.parse(req.body)]);
    assert.equal(JSON.parse(files['credits.json']).length, 3);
    if (url.includes('api.x.com')) throw new Error('lost response');
    return Response.json({ id: '12345' });
  };
  await assert.rejects(publish(rows, state, env, send), /lost response/);
  assert.equal(calls.length, 3);
  assert.equal(calls[1][1].reply.in_reply_to_tweet_id, '22');
  assert.equal(calls[2][1].message_reference.message_id, '33');
  assert.match(files['README.md'], /pull\/1/);
  assert.doesNotMatch(files['credits.json'], /replyTo/);
  await assert.rejects(publish(rows, state, env, send), /inspect original thread/);
  assert.equal(calls.length, 3);
});

test('a known rejection or missing credential leaves the released credit available for delivery', async () => {
  const rows = [{ pr: 7, names: ['River'], change: 'Fix', version: 'v1.2.0', replyTo: 'https://x.com/river/status/123' }];
  const state = { receipts: {}, save: () => {} };
  await assert.rejects(publish(rows, state, {}), /missing credentials for x/);
  const env = { FEEDBACK_X_USER_TOKEN: 'test' };
  await assert.rejects(publish(rows, state, env, () => new Response(null, { status: 429 })), /HTTP 429/);
  await publish(rows, state, env, () => Response.json({ data: { id: '87654' } }));
  assert.deepEqual(state.receipts, { 7: { status: 'sent', id: '87654' } });
});
