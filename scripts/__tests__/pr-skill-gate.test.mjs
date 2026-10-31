import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  runGate,
  decide,
  evaluateWatch,
  eventReport,
  freshWatch,
  isHumanOnlyReviewPending,
  normalizeConflicting,
  parseTarget,
  passAdvisories,
  probeAllowsSkip,
  stateFilePath,
  snapshotFailurePlan,
} from '../../apps/desktop/resources/system-skills/pr/scripts/pr-heartbeat-gate.mjs';
import { classifyMergeQueue } from '../../apps/desktop/resources/system-skills/pr/scripts/lib/merge-queue.mjs';

const gatePath = fileURLToPath(new URL('../../apps/desktop/resources/system-skills/pr/scripts/pr-heartbeat-gate.mjs', import.meta.url));

const PR_URL = 'https://github.com/acme/widgets/pull/42';
const REPO = 'acme/widgets';
const NUMBER = 42;
const T0 = Date.parse('2026-10-20T10:00:00Z');
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();

/**
 * 假 pr-snapshot:输出由 fixture 文件决定,退出码由环境变量决定。真快照要打网络 + gh,
 * 门禁行为必须能脱网测。探测默认失败(每轮都完整读取),探测用例自己给出探测结果。
 */
function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-heartbeat-gate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const stateDir = path.join(root, 'state');
  const outFile = path.join(root, 'snapshot.json');
  const fakeSnapshot = path.join(root, 'fake-pr-snapshot.mjs');
  fs.writeFileSync(
    fakeSnapshot,
    [
      "import fs from 'node:fs';",
      "if (process.argv.includes('--probe')) process.exit(1);",
      'const out = process.env.FAKE_SNAPSHOT_OUT;',
      "if (out && fs.existsSync(out)) process.stdout.write(fs.readFileSync(out, 'utf8'));",
    ].join('\n'),
    'utf8',
  );
  let clock = T0;
  let probe = null;
  let snapshotRuns = 0;

  // 端到端用例按分钟推进时钟;默认关掉最小放行间隔判据,它有专门用例。
  const gateArgs = (extraArgs) => [
    PR_URL, '--state-dir', stateDir, '--snapshot', fakeSnapshot,
    ...(extraArgs.includes('--min-pass-spacing-minutes') ? [] : ['--min-pass-spacing-minutes', '0']),
    ...extraArgs,
  ];

  return {
    root,
    stateFile: () => stateFilePath(stateDir, REPO, NUMBER),
    setSnapshot(snap) {
      fs.writeFileSync(outFile, `${JSON.stringify(snap, null, 2)}\n`, 'utf8');
    },
    setProbe(value) {
      probe = value;
    },
    advance(minutes) {
      clock += minutes * MIN;
    },
    now: () => clock,
    snapshotRuns: () => snapshotRuns,
    readState() {
      return JSON.parse(fs.readFileSync(stateFilePath(stateDir, REPO, NUMBER), 'utf8'));
    },
    writeState(patch) {
      const file = stateFilePath(stateDir, REPO, NUMBER);
      const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`, 'utf8');
    },
    /** 进程内跑同一个 CLI 入口(runGate),注入时钟、快照与探测。 */
    async run(extraArgs = [], env = {}) {
      let stdout = '';
      let stderr = '';
      const code = await runGate(gateArgs(extraArgs), {
        env: { ...process.env, ...env },
        now: () => clock,
        runSnapshot: async () => {
          snapshotRuns += 1;
          return {
            code: Number(env.FAKE_SNAPSHOT_EXIT || 0),
            stdout: env.FAKE_SNAPSHOT_STDOUT_RAW ?? (fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : ''),
            stderr: env.FAKE_SNAPSHOT_STDERR ?? '',
          };
        },
        runProbe: async () => (probe ? { code: 0, stdout: JSON.stringify(probe), stderr: '' } : { code: 1, stdout: '', stderr: '' }),
        out: (text) => { stdout += text; },
        err: (text) => { stderr += text; },
      });
      return { code, stdout, stderr, json: () => JSON.parse(stdout) };
    },
    /** 真实子进程调用指定路径的脚本:只给软链入口用例用,验证 CLI 入口判据本身。 */
    runVia(scriptPath, extraArgs = []) {
      return new Promise((resolve) => {
        execFile(process.execPath, [scriptPath, ...gateArgs(extraArgs)], {
          encoding: 'utf8',
          env: { ...process.env, FAKE_SNAPSHOT_OUT: outFile },
        }, (err, stdout, stderr) => {
          resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: stdout ?? '', stderr: stderr ?? '' });
        });
      });
    },
  };
}

const check = (name, outcome = 'passed', extra = {}) => ({ name, outcome, detailsUrl: `https://ci/${name}`, ...extra });

/** 一个「必需检查已通过、没什么可做」的快照。我们自己的账号是 me。 */
function snap(overrides = {}) {
  return {
    repo: REPO,
    number: NUMBER,
    url: PR_URL,
    viewer: 'me',
    state: 'OPEN',
    closed: false,
    merged: false,
    isDraft: false,
    updatedAt: '2026-10-20T09:00:00Z',
    reviewDecision: 'APPROVED',
    mergeStateStatus: 'CLEAN',
    mergeable: true,
    baseRefName: 'main',
    latestCommitOid: 'aaa1111',
    verdict: 'READY',
    blockers: [],
    gate: { verdict: 'READY', truncated: false },
    checks: [check('build', 'passed', { required: true }), check('lint')],
    checksSummary: { total: 2, pending: 0, failed: 0, unavailable: false, truncated: false },
    reviewThreads: { totalCount: 0, unresolvedCount: 0, activeUnresolvedCount: 0, truncated: false, nodes: [] },
    reviews: [],
    comments: [],
    ...overrides,
  };
}

const comment = (id, author, at, body = 'please fix', extra = {}) => ({ id, author, body, createdAt: at, updatedAt: at, url: `https://gh/${id}`, ...extra });

/** 已确认处理完的基线:看过这个快照上的一切。 */
function seenWatch(s, now = T0) {
  const base = { ...freshWatch(s, now), remarksThrough: iso(now) };
  return evaluateWatch(base, s, now).next;
}

const kinds = (result) => result.events.map((e) => e.kind);

// ── 目标解析 ────────────────────────────────────────────────────────────────

test('parseTarget 接受完整 URL,裸 PR 号要求 --repo(不从 cwd 猜仓库)', () => {
  assert.deepEqual(parseTarget(PR_URL), { repo: REPO, number: 42 });
  assert.deepEqual(parseTarget('42', REPO), { repo: REPO, number: 42 });
  assert.throws(() => parseTarget('42'), /--repo/);
  assert.throws(() => parseTarget('not-a-pr'), /cannot parse/);
});

test('normalizeConflicting:两套字段域都认,未知窗口 carry-forward', () => {
  assert.equal(normalizeConflicting({ mergeable: 'CONFLICTING' }), true);
  assert.equal(normalizeConflicting({ mergeable: false }), true);
  assert.equal(normalizeConflicting({ mergeStateStatus: 'DIRTY' }), true);
  assert.equal(normalizeConflicting({ mergeable: 'MERGEABLE' }), false);
  assert.equal(normalizeConflicting({ mergeStateStatus: 'BLOCKED', mergeable: null }), false);
  assert.equal(normalizeConflicting({ mergeable: null, mergeStateStatus: 'UNKNOWN' }, true), true);
  assert.equal(normalizeConflicting({ mergeable: null, mergeStateStatus: 'UNKNOWN' }), false);
});

// ── 事件:检查 ──────────────────────────────────────────────────────────────

test('检查失败按名字每个 head 只报一次;换 head 后再失败会再报', () => {
  const red = snap({ checks: [check('build', 'failed', { required: true }), check('lint')] });
  const first = evaluateWatch(seenWatch(snap()), red, T0);
  assert.deepEqual(kinds(first), ['checks-failed']);
  assert.deepEqual(first.events[0].failed.map((c) => c.name), ['build']);
  // 同一个失败在同一个 head 上:不再唤起(本机实测一个红灯被反复唤起 91 次)
  assert.deepEqual(kinds(evaluateWatch(first.next, red, T0 + 30 * MIN)), []);
  // 推送(检查都在跑):不唤起
  const pushed = snap({ latestCommitOid: 'bbb2222', checks: [check('build', 'pending', { required: true }), check('lint', 'pending')] });
  const running = evaluateWatch(first.next, pushed, T0 + 40 * MIN);
  assert.deepEqual(kinds(running), []);
  // 新 head 上又失败:再报
  const redAgain = evaluateWatch(running.next, { ...pushed, checks: [check('build', 'failed', { required: true }), check('lint')] }, T0 + 50 * MIN);
  assert.deepEqual(kinds(redAgain), ['checks-failed']);
});

test('必需检查全部通过报一次;还在跑的其它检查结束时再报一次,之后的增减不再唤起', () => {
  const pushed = (checks) => snap({ latestCommitOid: 'bbb2222', checks });
  let r = evaluateWatch(seenWatch(snap()), pushed([check('build', 'passed', { required: true }), check('codeql', 'pending')]), T0);
  assert.deepEqual(r.events, [{ kind: 'checks-passed', count: 1, required: true }]);
  r = evaluateWatch(r.next, pushed([check('build', 'passed', { required: true }), check('codeql', 'pending')]), T0 + 10 * MIN);
  assert.deepEqual(kinds(r), [], '必需检查通过后不重复');
  r = evaluateWatch(r.next, pushed([check('build', 'passed', { required: true }), check('codeql')]), T0 + 20 * MIN);
  assert.deepEqual(r.events, [{ kind: 'checks-passed', count: 2, required: false }], '欠的那一次');
  r = evaluateWatch(r.next, pushed([check('build', 'passed', { required: true }), check('codeql'), check('late', 'pending')]), T0 + 30 * MIN);
  assert.deepEqual(kinds(r), [], '后来冒出的非必需检查不唤起');
});

test('读不到检查时保留原状态,不把「没读到」当成「全部通过」或「没有检查」', () => {
  const red = evaluateWatch(seenWatch(snap()), snap({ checks: [check('build', 'failed', { required: true })] }), T0);
  const unavailable = snap({ checks: [], checksSummary: { unavailable: true } });
  const r = evaluateWatch(red.next, unavailable, T0 + 60 * MIN);
  assert.deepEqual(kinds(r), []);
  assert.deepEqual(r.next.failedChecks, ['build']);
});

test('新 head 15 分钟没有任何检查上报时说一次;从没跑过检查的 PR 不说', () => {
  const pushed = snap({ latestCommitOid: 'bbb2222', checks: [] });
  let r = evaluateWatch(seenWatch(snap()), pushed, T0);
  assert.deepEqual(kinds(r), []);
  r = evaluateWatch(r.next, pushed, T0 + 16 * MIN);
  assert.deepEqual(r.events, [{ kind: 'no-checks', minutes: 16 }]);
  assert.deepEqual(kinds(evaluateWatch(r.next, pushed, T0 + 40 * MIN)), [], '只说一次');

  const never = snap({ checks: [] });
  const quiet = evaluateWatch(seenWatch(never), { ...never, latestCommitOid: 'bbb2222' }, T0);
  assert.deepEqual(kinds(evaluateWatch(quiet.next, { ...never, latestCommitOid: 'bbb2222' }, T0 + 60 * MIN)), []);
});

// ── 事件:留言 ──────────────────────────────────────────────────────────────

test('只有别人的新留言唤起:自己的回复、看过的、内容为空的 COMMENTED review 都不算', () => {
  const base = snap({ comments: [comment('C1', 'alice', '2026-10-20T09:00:00Z')] });
  const watch = seenWatch(base);
  const later = '2026-10-20T10:05:00Z';
  const next = snap({
    comments: [comment('C1', 'alice', '2026-10-20T09:00:00Z'), comment('C2', 'ME', later, 'done')],
    reviews: [
      { id: 'R1', author: 'bot', state: 'COMMENTED', body: '', submittedAt: later },
      { id: 'R2', author: 'bob', state: 'APPROVED', body: '', submittedAt: later, url: 'https://gh/R2' },
    ],
    reviewThreads: { totalCount: 1, nodes: [{ id: 'T1', path: 'src/a.ts', comments: [comment('TC1', 'bot', later, 'null check missing')] }] },
  });
  const r = evaluateWatch(watch, next, T0 + 10 * MIN);
  assert.deepEqual(kinds(r), ['remarks']);
  assert.deepEqual(r.events[0].remarks.map((x) => x.id).sort(), ['R2', 'TC1']);
  const report = eventReport(r.events, next);
  assert.match(report, /2 new comments:/);
  assert.match(report, /bob: approved https:\/\/gh\/R2/);
  assert.match(report, /bot on src\/a\.ts: "null check missing" https:\/\/gh\/TC1/);
  // 看过之后不再唤起;同一秒的新留言按 id 区分
  assert.deepEqual(kinds(evaluateWatch(r.next, next, T0 + 20 * MIN)), []);
  const sameSecond = { ...next, comments: [...next.comments, comment('C3', 'carol', later, 'one more')] };
  assert.deepEqual(evaluateWatch(r.next, sameSecond, T0 + 20 * MIN).events[0].remarks.map((x) => x.id), ['C3']);
});

test('机器人改写自己的状态评论不唤起,人改评论仍算新留言;摘要去掉看不见的元数据', () => {
  const posted = '2026-10-20T09:00:00Z';
  const edited = '2026-10-20T10:05:00Z';
  const vercel = (updatedAt) => comment('V1', 'vercel', posted, '[vc]: #P3wob:eyJpc01vbm9yZXBvIjp0cnVl\nDeployment ready', { updatedAt, authorIsBot: true });
  const watch = seenWatch(snap({ comments: [vercel(posted), comment('H1', 'alice', posted)] }));
  // 一次部署后两条都被改过:只有人的那条算
  const r = evaluateWatch(watch, snap({ comments: [vercel(edited), comment('H1', 'alice', posted, 'please fix', { updatedAt: edited })] }), T0 + 10 * MIN);
  assert.deepEqual(r.events[0].remarks.map((x) => x.id), ['H1']);
  // 机器人的新评论仍然算,摘要里不带它藏的元数据
  const fresh = vercel(edited);
  fresh.id = 'V2';
  fresh.createdAt = edited;
  const report = eventReport(evaluateWatch(watch, snap({ comments: [fresh] }), T0 + 10 * MIN).events, snap());
  assert.match(report, /vercel: "Deployment ready"/);
});

test('连续 10 次只有评论的唤起后要求停止跟进;推送或检查消息清零', () => {
  let watch = seenWatch(snap());
  let r;
  for (let i = 1; i <= 10; i += 1) {
    const at = T0 + i * MIN;
    r = evaluateWatch(watch, snap({ comments: [comment(`C${i}`, 'bot', iso(at))] }), at);
    watch = r.next;
  }
  assert.equal(r.next.wakes, 10);
  assert.equal(r.exhausted, true);
  assert.match(eventReport(r.events, snap(), true), /Stop following: delete this schedule/);
  const pushed = evaluateWatch(watch, snap({ latestCommitOid: 'bbb2222', checks: [check('build', 'pending', { required: true })], comments: [comment('C11', 'bot', iso(T0 + 11 * MIN))] }), T0 + 11 * MIN);
  assert.equal(pushed.exhausted, false);
  assert.equal(pushed.next.wakes, 1);
});

// ── 事件:冲突、草稿、合并队列 ──────────────────────────────────────────────

test('只在开始冲突时唤起;合并态重算(UNKNOWN)既不报新冲突也不清除旧冲突', () => {
  const dirty = snap({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });
  const unknown = snap({ mergeable: null, mergeStateStatus: 'UNKNOWN' });
  assert.deepEqual(kinds(evaluateWatch(seenWatch(snap()), unknown, T0)), []);
  const conflict = evaluateWatch(seenWatch(snap()), dirty, T0);
  assert.deepEqual(kinds(conflict), ['conflicting']);
  const recomputing = evaluateWatch(conflict.next, unknown, T0 + MIN);
  assert.equal(recomputing.next.conflicting, true);
  assert.deepEqual(kinds(evaluateWatch(recomputing.next, dirty, T0 + 2 * MIN)), []);
});

test('草稿转换与合并队列出问题各唤起一次', () => {
  const draft = evaluateWatch(seenWatch(snap()), snap({ isDraft: true }), T0);
  assert.deepEqual(kinds(draft), ['draft-entered']);
  assert.deepEqual(kinds(evaluateWatch(draft.next, snap({ isDraft: false }), T0)), ['draft-exited']);

  const removed = { __typename: 'RemovedFromMergeQueueEvent', id: 'rm', reason: 'failed_checks' };
  const evicted = classifyMergeQueue({ event: removed, containsHead: true, checks: { failed: 1 } });
  const queued = classifyMergeQueue({ entry: { id: 'q', state: 'AWAITING_CHECKS' }, event: null, checks: { pending: 1 } });
  assert.deepEqual(kinds(evaluateWatch(seenWatch(snap()), snap({ mergeQueue: queued }), T0)), [], '排队等待不唤起');
  const r = evaluateWatch(seenWatch(snap()), snap({ mergeQueue: evicted }), T0);
  assert.deepEqual(kinds(r), ['merge-queue']);
  assert.match(eventReport(r.events, snap()), /merge_queue_ci_failing.*reason: failed_checks/);
  assert.deepEqual(kinds(evaluateWatch(r.next, snap({ mergeQueue: evicted }), T0 + MIN)), []);
});

test('唤起说明列出检查名、提交、链接;长留言截断、超过 10 条只列前 10 条', () => {
  const red = snap({ latestCommitOid: 'abcdef1234', checks: [check('build', 'failed', { required: true, conclusion: 'TIMED_OUT' })] });
  const r = evaluateWatch(seenWatch(snap()), red, T0);
  assert.equal(eventReport(r.events, red), '- Checks failed on abcdef1:\n  - build (timed_out) https://ci/build');
  const many = Array.from({ length: 12 }, (_, i) => comment(`C${i}`, 'bot', iso(T0 + i * 1000), `${'x'.repeat(250)} <!-- hidden -->`));
  const lines = eventReport([{ kind: 'remarks', remarks: many }], snap()).split('\n');
  assert.equal(lines.length, 12);
  assert.equal(lines.at(-1), '  - and 2 more');
  assert.ok(lines[1].length < 260 && lines[1].includes('...'));
});

// ── 决策 ────────────────────────────────────────────────────────────────────

test('decide:推送、检查在跑、自己的评论直接并入基线,不唤起 agent', () => {
  const s0 = snap();
  const previous = { watch: seenWatch(s0), lastPassAt: T0 };
  const pushed = snap({
    latestCommitOid: 'bbb2222',
    checks: [check('build', 'pending', { required: true })],
    comments: [comment('C9', 'me', iso(T0 + 5 * MIN), 'fixed in bbb2222')],
  });
  const d = decide({ snap: pushed, previous, now: T0 + 10 * MIN });
  assert.equal(d.exitCode, 2);
  assert.equal(d.reason, 'idle');
  assert.equal(d.nextWatch.headSha, 'bbb2222', '基线前进');
  assert.equal(d.nextPendingWatch, null);
});

test('decide:有新事件放行并附上清单;未确认时同一批事件重试,快速重试用尽后退避', () => {
  const red = snap({ checks: [check('build', 'failed', { required: true })] });
  let previous = { watch: seenWatch(snap()) };
  const at = (m) => T0 + m * MIN;
  const d1 = decide({ snap: red, previous, now: at(0), maxPassAttempts: 2, retryBackoffMs: 30 * MIN });
  assert.equal(d1.exitCode, 0);
  assert.equal(d1.reason, 'changed');
  assert.match(d1.detail, /events=\[checks-failed\]; verdict=READY; attempt=1\/2/);
  assert.match(d1.report, /Checks failed on aaa1111/);
  assert.equal(d1.nextWatch, previous.watch, '放行不推进已确认基线');
  previous = { ...previous, pendingWatch: d1.nextPendingWatch, pendingKey: d1.nextPendingKey, pendingPassCount: d1.nextPendingCount, lastPassAt: at(0) };
  const d2 = decide({ snap: red, previous, now: at(10), maxPassAttempts: 2, retryBackoffMs: 30 * MIN });
  assert.equal(d2.reason, 'retry-unacked');
  previous = { ...previous, pendingPassCount: d2.nextPendingCount, lastPassAt: at(10) };
  const d3 = decide({ snap: red, previous, now: at(20), maxPassAttempts: 2, retryBackoffMs: 30 * MIN });
  assert.equal(d3.reason, 'retry-backoff-attempt');
  previous = { ...previous, pendingPassCount: d3.nextPendingCount, retryBackoffUntil: d3.nextRetryBackoffUntil, lastPassAt: at(20) };
  const d4 = decide({ snap: red, previous, now: at(30), maxPassAttempts: 2, retryBackoffMs: 30 * MIN });
  assert.equal(d4.exitCode, 2);
  assert.equal(d4.reason, 'retry-backoff');
  // 没确认的放行期间问题被修掉(新 head 在跑):事件消失,pending 一并清掉
  const fixed = decide({ snap: snap({ latestCommitOid: 'bbb2222', checks: [check('build', 'pending', { required: true })] }), previous, now: at(31) });
  assert.equal(fixed.reason, 'idle');
  assert.equal(fixed.nextPendingWatch, null);
});

test('decide:空放行(宿主顺延、agent 没跑)照常放行但不消耗重试额度', () => {
  const red = snap({ checks: [check('build', 'failed', { required: true })] });
  const watch = seenWatch(snap());
  const d1 = decide({ snap: red, previous: { watch }, now: T0 });
  const previous = { watch, pendingWatch: d1.nextPendingWatch, pendingKey: d1.nextPendingKey, pendingPassCount: 1 };
  const empty = decide({ snap: red, previous: { ...previous, lastPassAt: T0 - 90_000 }, now: T0 });
  assert.equal(empty.exitCode, 0);
  assert.equal(empty.nextPendingCount, 1);
  assert.match(empty.detail, /not counted/);
  assert.equal(decide({ snap: red, previous: { ...previous, lastPassAt: T0 - 11 * MIN }, now: T0 }).nextPendingCount, 2);
});

test('decide:merged / closed 每轮放行;截断的快照放行且不推进基线', () => {
  const watch = seenWatch(snap());
  const merged = decide({ snap: snap({ merged: true }), previous: { watch }, now: T0 });
  assert.equal(merged.reason, 'terminal');
  const again = decide({ snap: snap({ merged: true }), previous: { watch, pendingWatch: merged.nextPendingWatch, pendingKey: 'terminal', pendingPassCount: 9 }, now: T0 });
  assert.equal(again.exitCode, 0, '收口不受重试上限约束');
  const truncated = decide({ snap: snap({ gate: { truncated: true } }), previous: { watch }, now: T0 });
  assert.equal(truncated.reason, 'truncated');
  assert.equal(truncated.nextPendingWatch, watch);
});

test('decide:只剩人工批准时吸收外部变化;保底巡检;defer 未到点跳过、到点唤起一次', () => {
  const approvalThread = { id: 'T-approval', isResolved: false, isOutdated: false, comments: [comment('A1', 'lead', '2026-10-20T09:00:00Z', 'This needs explicit approval from a designated maintainer.')] };
  const humanOnly = snap({
    verdict: 'NEEDS_WORK',
    blockers: ['unresolved_review_threads', 'branch_protection_blocked'],
    reviewThreads: { totalCount: 1, unresolvedCount: 1, activeUnresolvedCount: 1, truncated: false, nodes: [approvalThread] },
  });
  assert.equal(isHumanOnlyReviewPending(humanOnly), true);
  const watch = seenWatch(humanOnly);
  const nudged = { ...humanOnly, comments: [comment('C1', 'lead', iso(T0 + MIN), 'still waiting')] };
  const held = decide({ snap: nudged, previous: { watch, humanOnlyPending: true, lastPassAt: T0 }, now: T0 + 2 * MIN });
  assert.equal(held.reason, 'blocked-human');
  assert.ok(Date.parse(held.nextWatch.remarksThrough) > Date.parse(watch.remarksThrough), '吸收后不再重报');
  assert.equal(decide({ snap: nudged, previous: { watch, lastPassAt: T0 }, now: T0 + 2 * MIN }).reason, 'changed', '第一次仍然唤起');

  const quiet = { watch: seenWatch(snap()), lastPassAt: T0 };
  const day = 24 * 60 * MIN;
  assert.equal(decide({ snap: snap(), previous: quiet, now: T0 + day - MIN }).reason, 'idle');
  const guard = decide({ snap: snap(), previous: quiet, now: T0 + day });
  assert.equal(guard.reason, 'silence-guard');
  assert.equal(guard.nextPendingWatch, null);
  assert.equal(decide({ snap: snap(), previous: { ...quiet, nextAllowAt: T0 + 2 * day }, now: T0 + day }).reason, 'deferred');
  const expired = decide({ snap: snap(), previous: { ...quiet, nextAllowAt: T0 + 15 * MIN }, now: T0 + 20 * MIN });
  assert.equal(expired.reason, 'defer-expired', '到点再唤起一次(等机器人 review 的那 15 分钟)');
  assert.equal(expired.keepNextAllowAt, undefined, '放行即消费');
  assert.equal(probeAllowsSkip({ watch: quiet.watch, probe: { status: 's', remarks: 'r' }, lastFullReadAt: T0 + 19 * MIN, lastPassAt: T0, nextAllowAt: T0 + 15 * MIN }, { status: 's', remarks: 'r' }, T0 + 20 * MIN), false, '探测不跳过到点的 defer');
  const red = snap({ checks: [check('build', 'failed', { required: true })] });
  assert.equal(decide({ snap: red, previous: { ...quiet, nextAllowAt: T0 + 2 * day }, now: T0 + MIN }).reason, 'changed', '新事件穿透 defer');
});

test('decide:旧版状态升级时不补报旧事;有未确认的旧放行时只再唤起一次', () => {
  const red = snap({ checks: [check('build', 'failed', { required: true })], comments: [comment('C1', 'alice', '2026-10-01T00:00:00Z')] });
  const quiet = decide({ snap: red, previous: { fingerprint: 'old', lastPassAt: T0 }, now: T0 });
  assert.equal(quiet.reason, 'idle');
  assert.deepEqual(quiet.nextWatch.failedChecks, ['build']);
  const unacked = decide({ snap: red, previous: { fingerprint: 'old', pendingFingerprint: 'older' }, now: T0 });
  assert.equal(unacked.reason, 'upgraded');
  assert.equal(unacked.exitCode, 0);
});

// ── 端到端(同一个 CLI 入口) ────────────────────────────────────────────────

test('新跟进:必需检查通过与失败各报一次,确认后安静;我们自己的推送不唤起', async (t) => {
  const fx = createFixture(t);
  fx.setSnapshot(snap({ checks: [check('build', 'pending', { required: true })] }));
  let r = await fx.run();
  assert.equal(r.code, 2, r.stdout);
  assert.match(r.stdout, /SKIP .*reason=idle/);

  fx.advance(10);
  fx.setSnapshot(snap({ checks: [check('build', 'failed', { required: true })] }));
  r = await fx.run();
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /PASS .*reason=changed \(events=\[checks-failed\]/);
  assert.match(r.stdout, /\n- Checks failed on aaa1111:\n {2}- build https:\/\/ci\/build\n/);
  assert.equal(fx.readState().lastResult.report, '- Checks failed on aaa1111:\n  - build https://ci/build');
  await fx.run(['--ack']);

  fx.advance(10);
  fx.setSnapshot(snap({ latestCommitOid: 'bbb2222', checks: [check('build', 'pending', { required: true })], comments: [comment('C1', 'me', iso(fx.now()), 'pushed a fix')] }));
  r = await fx.run();
  assert.equal(r.code, 2, '自己的推送和回复不唤起');

  fx.advance(10);
  fx.setSnapshot(snap({ latestCommitOid: 'bbb2222', checks: [check('build', 'passed', { required: true })] }));
  r = await fx.run();
  assert.match(r.stdout, /events=\[checks-passed\]/);
  assert.match(r.stdout, /All 1 required check passed on bbb2222\./);
  await fx.run(['--ack']);
  fx.advance(10);
  assert.equal((await fx.run()).code, 2);
});

test('放行后没 ack → 下一轮重试;慢 agent 的 ack 不会确认它没见过的新留言', async (t) => {
  const fx = createFixture(t);
  fx.setSnapshot(snap());
  await fx.run();
  await fx.run(['--ack']);

  fx.advance(10);
  const c1 = comment('C1', 'alice', iso(fx.now()), 'first');
  fx.setSnapshot(snap({ comments: [c1] }));
  assert.match((await fx.run()).stdout, /reason=changed/);
  fx.advance(10);
  assert.match((await fx.run()).stdout, /reason=retry-unacked/, '没确认就重试');

  // agent 还在跑时又来一条;agent 随后 ack 只确认它被告知过的那一条
  fx.advance(5);
  const c2 = comment('C2', 'bob', iso(fx.now()), 'second');
  fx.setSnapshot(snap({ comments: [c1, c2] }));
  await fx.run(['--ack']);
  fx.advance(5);
  const r = await fx.run();
  assert.equal(r.code, 0);
  assert.match(r.stdout, /1 new comment:\n {2}- bob: "second"/);
});

test('--defer 隐含 ack 并压住保底巡检;新事件照常穿透并消费掉 defer', async (t) => {
  const fx = createFixture(t);
  fx.setSnapshot(snap({ checks: [check('build', 'failed', { required: true })] }));
  await fx.run();
  await fx.run(['--defer', '240']);
  const state = fx.readState();
  assert.equal(state.pendingWatch, undefined);
  assert.deepEqual(state.watch.failedChecks, ['build']);
  fx.advance(10);
  assert.match((await fx.run()).stdout, /reason=deferred/);
  assert.ok(fx.readState().nextAllowAt > fx.now(), 'defer 跨轮保留');
  fx.setSnapshot(snap({ checks: [check('build', 'failed', { required: true })], comments: [comment('C1', 'alice', iso(fx.now()))] }));
  assert.match((await fx.run()).stdout, /PASS .*reason=changed/);
  assert.equal(fx.readState().nextAllowAt, undefined);
});

test('合并后每轮放行直到收口;状态文件损坏时按新跟进处理', async (t) => {
  const fx = createFixture(t);
  fx.setSnapshot(snap({ merged: true, verdict: 'MERGED_CLEANUP_READY' }));
  await fx.run();
  const again = await fx.run(['--json']);
  assert.equal(again.code, 0);
  assert.equal(again.json().reason, 'terminal');
  assert.doesNotMatch(again.json().detail, /round=/, '收口轮只有收口指令');

  fs.writeFileSync(fx.stateFile(), '{ broken', 'utf8');
  fx.setSnapshot(snap());
  const r = await fx.run();
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /events=\[checks-passed\]/);
});

test('低成本探测:与上次完整读取一致时不做完整快照;有理由时照常完整读取', async (t) => {
  const fx = createFixture(t);
  const probe = { status: 'OPEN false MERGEABLE aaa1111  SUCCESS:2', remarks: '0  0  0' };
  fx.setProbe(probe);
  fx.setSnapshot(snap());
  await fx.run();
  await fx.run(['--ack']);
  fx.advance(10);
  const reads = fx.snapshotRuns();
  let r = await fx.run();
  assert.equal(r.code, 2);
  assert.match(r.stdout, /reason=unchanged/);
  assert.match(r.stdout, /CINDY_PRECHECK_OK/);
  assert.equal(fx.snapshotRuns(), reads, '跳过时不调完整快照');

  fx.setProbe({ ...probe, remarks: '1 2026-10-20T10:20:00Z 0  0' });
  fx.setSnapshot(snap({ comments: [comment('C1', 'alice', iso(fx.now()))] }));
  r = await fx.run();
  assert.match(r.stdout, /reason=changed/);
  assert.equal(fx.snapshotRuns(), reads + 1);

  const previous = fx.readState();
  const now = fx.now();
  const settled = { ...previous, pendingWatch: undefined };
  assert.equal(probeAllowsSkip(settled, previous.probe, now + MIN), true);
  assert.equal(probeAllowsSkip(previous, previous.probe, now + MIN), false, '有未确认的放行');
  assert.equal(probeAllowsSkip({ ...settled, inFlight: true }, previous.probe, now + MIN), false, '检查在跑');
  assert.equal(probeAllowsSkip(settled, previous.probe, now + 31 * MIN), false, '30 分钟完整读一次');
  assert.equal(probeAllowsSkip(settled, { ...previous.probe, status: 'x' }, now + MIN), false);
  assert.equal(probeAllowsSkip(settled, null, now + MIN), false, '探测失败');
  assert.equal(probeAllowsSkip({ ...settled, lastPassAt: now - 24 * 60 * MIN }, previous.probe, now + MIN), false, '保底巡检到点');
});

test('快照失败先容忍瞬时抖动,连续到阈值才 fail-closed —— 绝不静默跳过', async (t) => {
  const fx = createFixture(t);
  fx.setSnapshot(snap());
  await fx.run();
  await fx.run(['--ack']);
  const failEnv = { FAKE_SNAPSHOT_EXIT: '2', FAKE_SNAPSHOT_STDERR: '[pr-snapshot] gh auth expired\n' };
  assert.equal((await fx.run([], failEnv)).code, 2);
  assert.match(fx.readState().lastResult.detail, /failures=1\/3/);
  assert.equal((await fx.run([], failEnv)).code, 2);
  const r3 = await fx.run([], failEnv);
  assert.equal(r3.code, 1, '连续第 3 轮失败必须 fail-closed 让用户看见');
  assert.match(r3.stderr, /3 consecutive rounds.*gh auth expired/s);
  assert.equal(fx.readState().lastResult.reason, 'snapshot-failed');
  assert.equal((await fx.run()).code, 2);
  assert.equal(fx.readState().lastResult.reason, 'snapshot-failure-backoff');
  fx.writeState({ snapshotFailureBackoffUntil: 0 });
  const ok = await fx.run();
  assert.equal(ok.code, 2, ok.stderr);
  assert.equal(fx.readState().consecutiveSnapshotFailures, 0);
});

test('rate limits respect reset, deduplicate the episode, and remind after one day', () => {
  const now = 10_000_000;
  const run = { code: 1, stderr: `[gh-rate-limit] retryAt=${now + 600_000}\nAPI rate limit already exceeded` };
  const first = snapshotFailurePlan(run, {}, now);
  assert.equal(first.block, true);
  assert.equal(first.until, now + 601_000);
  const previous = { snapshotFailureReports: first.reports, consecutiveSnapshotFailures: 1 };
  assert.equal(snapshotFailurePlan(run, previous, now + 700_000).block, false);
  assert.equal(snapshotFailurePlan(run, previous, now + 24 * 60 * 60_000).block, true);
  const different = snapshotFailurePlan({ code: 1, stderr: 'auth expired' }, previous, now + 700_000, 1);
  assert.equal(different.block, true);
});

test('无效 JSON 与缺失的快照脚本都 fail-closed;快照不全时不打健康标记', async (t) => {
  const fx = createFixture(t);
  fx.setSnapshot(snap());
  await fx.run();
  const invalid = await fx.run(['--max-snapshot-failures', '1'], { FAKE_SNAPSHOT_STDOUT_RAW: 'not json at all' });
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /not valid JSON|consecutive rounds/);
  const missing = await fx.run(['--snapshot', path.join(fx.root, 'nope.mjs')]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /snapshot script not found/);
  fx.writeState({ snapshotFailureBackoffUntil: 0 });
  fx.setSnapshot(snap({ checksSummary: { unavailable: true } }));
  assert.doesNotMatch((await fx.run()).stdout, /CINDY_PRECHECK_OK/);
});

test('只读查询:--last-result 带事件清单且不改状态;--suggest 兼容输出;混用写命令 fail-closed', async (t) => {
  const fx = createFixture(t);
  fx.setSnapshot(snap({ checks: [check('build', 'failed', { required: true })] }));
  await fx.run();
  const before = fs.readFileSync(fx.stateFile(), 'utf8');
  const last = await fx.run(['--last-result', '--json', '--snapshot', path.join(fx.root, 'nope.mjs')]);
  assert.equal(last.code, 0, last.stderr);
  assert.equal(last.json().lastResult.decision, 'run');
  assert.match(last.json().lastResult.report, /Checks failed/);
  const suggest = await fx.run(['--suggest']);
  assert.match(suggest.stdout, /no longer changes its pace/);
  for (const extra of [['--suggest', '--ack'], ['--last-result', '--defer', '60'], ['--suggest', '--last-result']]) {
    const r = await fx.run(extra);
    assert.equal(r.code, 1, `应拒绝: ${extra.join(' ')}`);
  }
  assert.equal(fs.readFileSync(fx.stateFile(), 'utf8'), before);

  const legacy = createFixture(t);
  legacy.writeState({ lastDecision: 'pass', lastDecisionReason: 'legacy-pass', lastCheckedAt: 123 });
  assert.deepEqual((await legacy.run(['--last-result', '--json'])).json().lastResult, { decision: 'run', reason: 'legacy-pass', checkedAt: 123 });
});

test('旧调度 hook 上已退役的选项被接受并忽略,不让跟进 fail-closed', async (t) => {
  const fx = createFixture(t);
  fx.setSnapshot(snap());
  const r = await fx.run(['--draft-reminder-hours', '0', '--max-work-pending-passes', '3', '--no-cadence-throttle']);
  assert.ok([0, 2].includes(r.code), r.stderr);
});

test('经软链调用时 main 照跑(退出码 0 不等于真跑过)', { skip: process.platform === 'win32' ? 'POSIX-only: symlink' : false }, async (t) => {
  const fx = createFixture(t);
  fx.setSnapshot(snap({ checks: [check('build', 'failed', { required: true })] }));
  const linked = path.join(fx.root, 'gate-via-symlink.mjs');
  fs.symlinkSync(gatePath, linked);
  const viaLink = await fx.runVia(linked);
  assert.equal(viaLink.code, 0, viaLink.stderr);
  assert.match(viaLink.stdout, /PASS .*events=\[checks-failed\]/, '软链调用必须真的做出判定');
  assert.ok(fx.readState().pendingWatch, '状态文件必须真的写了');
  const acked = await fx.runVia(linked, ['--ack']);
  assert.match(acked.stdout, /reason=acked/);
  assert.equal(fx.readState().pendingWatch, undefined, '软链调用的 --ack 必须真的提升基线');
});

// ── 机判提示(回合止损 / 临门一脚 / 无底洞 / 范围膨胀) ─────────────────────

test('passAdvisories:回合数每轮报数,过检查点/硬止损线时给行动指令', () => {
  const s = snap({ verdict: 'NEEDS_WORK', blockers: ['unresolved_review_threads'] });
  assert.deepEqual(passAdvisories(s, 3), ['round=3']);
  assert.match(passAdvisories(s, 5)[0], /round=5 ⚠️ past the convergence checkpoint/);
  const hard = passAdvisories(s, 25);
  assert.match(hard[0], /not a stop condition.*stop patching comment by comment.*land one verifiable fix/);
});

test('passAdvisories:只剩人类 blocker 且 thread 将尽时提示临门一脚,有硬活时不提示', () => {
  const nearMerge = snap({
    verdict: 'NEEDS_WORK',
    blockers: ['unresolved_review_threads', 'branch_protection_blocked'],
    reviewThreads: { ...snap().reviewThreads, unresolvedCount: 2 },
  });
  const notes = passAdvisories(nearMerge, 3);
  assert.equal(notes.length, 2);
  assert.match(notes[1], /almost there.*wait \*\*silently\*\*.*do not notify/);
  assert.equal(passAdvisories({ ...nearMerge, blockers: [...nearMerge.blockers, 'ci_failing'] }, 3).length, 1);
});

test('passAdvisories:单文件 thread 累计超阈值时点名无底洞;diff 显著膨胀时提示范围膨胀', () => {
  const mkThread = (i, p) => ({ id: `T${i}`, path: p, isResolved: i % 2 === 0, isOutdated: false, comments: [] });
  const hot = snap({
    verdict: 'NEEDS_WORK',
    blockers: ['unresolved_review_threads'],
    reviewThreads: { ...snap().reviewThreads, unresolvedCount: 4, nodes: Array.from({ length: 8 }, (_, i) => mkThread(i, 'src/quote.ts')) },
  });
  assert.match(passAdvisories(hot, 2)[1], /hotspot: src\/quote\.ts has accumulated 8 review threads/);
  const grown = snap({ verdict: 'NEEDS_WORK', blockers: ['unresolved_review_threads'], additions: 2400 });
  assert.match(passAdvisories(grown, 3, { initialAdditions: 1100 })[1], /scope growth: the diff grew from \+1100 to \+2400 lines/);
  assert.equal(passAdvisories({ ...grown, additions: 1350 }, 3, { initialAdditions: 1100 }).length, 1);
  assert.equal(passAdvisories({ ...grown, additions: 2400 }, 3, { initialAdditions: 2000 }).length, 1);
});

test('回合状态:首次建档用可见 review 窗口播种,换 head 进新回合、清等待额度;提示随放行带出', async (t) => {
  const fx = createFixture(t);
  const reviews = ['h1', 'h2', 'h3'].map((oid, i) => ({ id: `R${i}`, author: 'greptile', state: 'COMMENTED', body: '', submittedAt: '2026-10-19T08:00:00Z', commitOid: oid }));
  fx.setSnapshot(snap({ latestCommitOid: 'h3', reviews, additions: 900 }));
  await fx.run();
  let st = fx.readState();
  assert.equal(st.roundCount, 3);
  assert.equal(st.initialAdditions, 900);
  assert.deepEqual(st.reviewersSeen, ['greptile']);
  await fx.run(['--defer', '15']);
  assert.equal(fx.readState().deferredHeadOid, 'h3');

  fx.advance(10);
  fx.setSnapshot(snap({ latestCommitOid: 'h4', reviews, additions: 2400, checks: [check('build', 'failed', { required: true })] }));
  const r = await fx.run(['--json']);
  assert.match(r.json().detail, /round=4.*scope growth: the diff grew from \+900 to \+2400 lines/);
  st = fx.readState();
  assert.equal(st.roundCount, 4);
  assert.equal(st.deferredHeadOid, undefined, '新回合的等待额度必须重置');
  assert.equal(st.initialAdditions, 900, '膨胀不改基线');
});

// ── 合并队列分类 ────────────────────────────────────────────────────────────

const removal = { __typename: 'RemovedFromMergeQueueEvent', id: 'removed-54', createdAt: '2026-10-09T01:56:40Z', reason: 'failed_checks' };
const failed = { failed: 1, pending: 0, failingRuns: [{ name: 'arm64-build', status: 'COMPLETED', conclusion: 'FAILURE' }] };
const queue = (overrides = {}) => ({ entry: null, event: removal, containsHead: true, checks: failed, ...overrides });

test('PR head green does not hide a failed merge-group eviction', () => {
  const q = classifyMergeQueue(queue());
  assert.equal(q.status, 'REMOVED');
  assert.ok(q.blockers.includes('merge_queue_removed'));
  assert.ok(q.blockers.includes('merge_queue_ci_failing'));
});

test('new head and later requeue supersede the old failure', () => {
  assert.deepEqual(classifyMergeQueue(queue({ containsHead: false })).blockers, []);
  const q = classifyMergeQueue(queue({ entry: { id: 'next', state: 'AWAITING_CHECKS' }, checks: { pending: 1 } }));
  assert.equal(q.status, 'ENQUEUED');
  assert.deepEqual(q.blockers, ['merge_queue_pending']);
});

test('missing evidence cannot be READY; terminal PR ignores old queue failure', () => {
  assert.deepEqual(classifyMergeQueue(queue({ containsHead: null })).blockers, ['merge_queue_unavailable']);
  assert.deepEqual(classifyMergeQueue(queue({ terminal: true })).blockers, []);
  assert.deepEqual(classifyMergeQueue(queue({ entry: { id: 'q' }, checks: { truncated: true } })).blockers, ['merge_queue_unavailable']);
});

test('manual/unknown removal still wakes investigation, not automatic reenqueuing', () => {
  for (const reason of ['manually_removed', 'unknown']) {
    const q = classifyMergeQueue(queue({ event: { ...removal, reason }, checks: {} }));
    assert.deepEqual(q.blockers, ['merge_queue_removed']);
  }
});
