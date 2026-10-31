import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  cadenceThrottle,
  runGate,
  decide,
  fingerprint,
  fingerprintPayload,
  isHumanOnlyReviewPending,
  normalizeConflicting,
  parseTarget,
  passAdvisories,
  stateFilePath,
  suggestCadence,
  snapshotFailurePlan,
} from '../../apps/desktop/resources/system-skills/pr/scripts/pr-heartbeat-gate.mjs';
import { classifyMergeQueue, mergeQueueFingerprint } from '../../apps/desktop/resources/system-skills/pr/scripts/lib/merge-queue.mjs';

const gatePath = fileURLToPath(new URL('../../apps/desktop/resources/system-skills/pr/scripts/pr-heartbeat-gate.mjs', import.meta.url));

const PR_URL = 'https://github.com/acme/widgets/pull/42';
/** 测试专用标记:fixture.run 默认关闭 gate 内节流,带上它则保持开启。 */
const WITH_THROTTLE = '__with-cadence-throttle__';
const REPO = 'acme/widgets';
const NUMBER = 42;

/**
 * 假 pr-snapshot:输出由 fixture 文件决定,退出码由环境变量决定。
 * 真快照要打网络 + gh,门禁行为必须能脱网测。
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
      'const out = process.env.FAKE_SNAPSHOT_OUT;',
      'const code = Number(process.env.FAKE_SNAPSHOT_EXIT || 0);',
      "if (process.env.FAKE_SNAPSHOT_STDOUT_RAW) process.stdout.write(process.env.FAKE_SNAPSHOT_STDOUT_RAW);",
      "else if (out && fs.existsSync(out)) process.stdout.write(fs.readFileSync(out, 'utf8'));",
      "if (process.env.FAKE_SNAPSHOT_STDERR) process.stderr.write(process.env.FAKE_SNAPSHOT_STDERR);",
      'process.exit(code);',
    ].join('\n'),
    'utf8',
  );

  /**
   * 默认关掉最小放行间隔判据(`--min-pass-spacing-minutes 0`)和 gate 内节流:端到端用例靠
   * 毫秒级连续调用和改状态文件里的时间锚点模拟「一轮又一轮心跳」。两项判据各有专门用例
   * (传 extraArgs 覆盖默认,或带 WITH_THROTTLE 打开节流)。
   */
  const gateArgs = (extraArgs) => {
    const spacingOverridden = extraArgs.includes('--min-pass-spacing-minutes');
    const throttleOn = extraArgs.includes(WITH_THROTTLE);
    return [
      PR_URL,
      '--state-dir',
      stateDir,
      '--snapshot',
      fakeSnapshot,
      ...(spacingOverridden ? [] : ['--min-pass-spacing-minutes', '0']),
      ...(throttleOn ? [] : ['--no-cadence-throttle']),
      ...extraArgs.filter((arg) => arg !== WITH_THROTTLE),
    ];
  };

  return {
    root,
    stateDir,
    outFile,
    fakeSnapshot,
    stateFile: () => stateFilePath(stateDir, REPO, NUMBER),
    /** 设定下一轮假快照返回的内容。 */
    setSnapshot(snap) {
      fs.writeFileSync(outFile, `${JSON.stringify(snap, null, 2)}\n`, 'utf8');
    },
    readState() {
      return JSON.parse(fs.readFileSync(stateFilePath(stateDir, REPO, NUMBER), 'utf8'));
    },
    writeState(patch) {
      const file = stateFilePath(stateDir, REPO, NUMBER);
      const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`, 'utf8');
    },
    /**
     * 跑一轮 gate,返回退出码与输出。进程内跑同一个 CLI 入口(runGate):注入的快照执行器按 FAKE_SNAPSHOT_* 返回结果,
     * 与原先起一个假 pr-snapshot 子进程等价,但不用每轮各起两个 node 进程。
     */
    async run(extraArgs = [], env = {}) {
      const mergedEnv = { ...process.env, FAKE_SNAPSHOT_OUT: outFile, ...env };
      let stdout = '';
      let stderr = '';
      const code = await runGate(gateArgs(extraArgs), {
        env: mergedEnv,
        runSnapshot: async () => ({
          code: Number(mergedEnv.FAKE_SNAPSHOT_EXIT || 0),
          stdout: mergedEnv.FAKE_SNAPSHOT_STDOUT_RAW
            ?? (fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : ''),
          stderr: mergedEnv.FAKE_SNAPSHOT_STDERR ?? '',
        }),
        out: (text) => { stdout += text; },
        err: (text) => { stderr += text; },
      });
      return { code, stdout, stderr };
    },
    /** 真实子进程调用指定路径的脚本:只给软链入口用例用,验证 CLI 入口判据本身。 */
    runVia(scriptPath, extraArgs = [], env = {}) {
      return new Promise((resolve) => {
        execFile(
          process.execPath,
          [scriptPath, ...gateArgs(extraArgs)],
          {
            encoding: 'utf8',
            env: { ...process.env, FAKE_SNAPSHOT_OUT: outFile, ...env },
          },
          (err, stdout, stderr) => {
            resolve({
              code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
              stdout: stdout ?? '',
              stderr: stderr ?? '',
            });
          },
        );
      });
    },
  };
}

/** 一个「已 READY、没什么可做」的基线快照。 */
function baseSnapshot(overrides = {}) {
  return {
    fetchedAt: '2026-07-29T00:00:00.000Z',
    repo: REPO,
    number: NUMBER,
    url: PR_URL,
    title: 'test pr',
    state: 'OPEN',
    closed: false,
    merged: false,
    isDraft: false,
    updatedAt: '2026-07-28T10:00:00Z',
    reviewDecision: 'APPROVED',
    mergeStateStatus: 'CLEAN',
    mergeable: true,
    mergeableState: 'clean',
    baseCommitOid: 'base111',
    latestCommitOid: 'aaa111',
    verdict: 'READY',
    blockers: [],
    gate: { verdict: 'READY', strictExitCode: 0, truncated: false },
    checksSummary: {
      total: 2,
      totalCount: 2,
      pending: 0,
      failed: 0,
      actionRequired: 0,
      unavailable: false,
      truncated: false,
      pendingRuns: [],
      failingRuns: [],
      actionRequiredRuns: [],
    },
    reviewThreads: {
      totalCount: 1,
      fetchedCount: 1,
      unresolvedCount: 0,
      activeUnresolvedCount: 0,
      outdatedUnresolvedCount: 0,
      rawUnresolvedCount: 0,
      truncated: false,
      nodes: [
        {
          id: 'T1',
          isResolved: true,
          isOutdated: false,
          comments: [{ id: 'C1', updatedAt: '2026-07-28T09:00:00Z' }],
        },
      ],
    },
    reviews: [{ id: 'R1', state: 'APPROVED', submittedAt: '2026-07-28T09:30:00Z' }],
    comments: [{ id: 'IC1', updatedAt: '2026-07-28T09:45:00Z' }],
    ...overrides,
  };
}

// ── 纯函数 ────────────────────────────────────────────────────────────────

test('parseTarget 接受完整 URL', () => {
  assert.deepEqual(parseTarget(PR_URL), { repo: REPO, number: 42 });
});

test('parseTarget 对裸 PR 号要求 --repo(不从 cwd 猜仓库)', () => {
  assert.deepEqual(parseTarget('42', REPO), { repo: REPO, number: 42 });
  assert.throws(() => parseTarget('42'), /--repo/);
  assert.throws(() => parseTarget('not-a-pr'), /cannot parse/);
});

test('指纹忽略 fetchedAt —— 否则每轮都判「有变化」,门禁等于没装', () => {
  const a = baseSnapshot();
  const b = baseSnapshot({ fetchedAt: '2026-07-29T00:10:00.000Z' });
  assert.equal(fingerprint(a), fingerprint(b));
});

test('base HEAD 只在 CI 红时进指纹,main 日常推进不误唤醒健康或等待中的 PR', () => {
  const withBase = (baseCommitOid, overrides = {}) => baseSnapshot({ baseCommitOid, ...overrides });

  assert.equal(fingerprint(withBase('base-a')), fingerprint(withBase('base-b')), 'READY 不观察 base');
  assert.equal(
    fingerprint(withBase('base-a', { verdict: 'WAITING_CI', blockers: ['pending_checks'] })),
    fingerprint(withBase('base-b', { verdict: 'WAITING_CI', blockers: ['pending_checks'] })),
    'pending CI 不观察 base',
  );
  assert.equal(
    fingerprint(withBase('base-a', { verdict: 'NEEDS_WORK', blockers: ['merge_conflict'] })),
    fingerprint(withBase('base-b', { verdict: 'NEEDS_WORK', blockers: ['merge_conflict'] })),
    '非 CI blocker 不观察 base',
  );

  const redA = withBase('base-a', { verdict: 'NEEDS_WORK', blockers: ['ci_failing'] });
  const redB = withBase('base-b', { verdict: 'NEEDS_WORK', blockers: ['ci_failing'] });
  assert.notEqual(fingerprint(redA), fingerprint(redB), '红 CI 时 base 前进必须算变化');
  assert.equal(fingerprintPayload(baseSnapshot()).ciFailingBaseCommitOid, undefined);
  assert.equal(fingerprintPayload(redA).ciFailingBaseCommitOid, 'base-a');
});

test('指纹忽略合并态重算抖动 —— mergeable/mergeStateStatus/verdict/合并态 blockers 一起翻转也不变', () => {
  // GitHub 异步重算合并态的真实形状(2026-07-30 实测):稳定态 vs 重算窗口,
  // PR 内容零变化,但合并态字段、verdict 与合并态 blockers 成组翻转
  const stable = baseSnapshot({
    verdict: 'BLOCKED_HUMAN',
    blockers: ['branch_protection_blocked', 'approval_required'],
    mergeable: true,
    mergeStateStatus: 'BLOCKED',
    mergeableState: 'blocked',
  });
  const recomputing = baseSnapshot({
    verdict: 'WAITING_CI',
    blockers: ['mergeability_pending', 'approval_required'],
    mergeable: null,
    mergeStateStatus: 'UNKNOWN',
    mergeableState: 'unknown',
  });
  assert.equal(fingerprint(stable), fingerprint(recomputing), '重算窗口不得改指纹');

  // 已知冲突的 PR 进入重算窗口:carry-forward 保持 conflicting=true,同样稳定
  const conflicted = baseSnapshot({
    verdict: 'NEEDS_WORK',
    blockers: ['merge_conflict'],
    mergeable: 'CONFLICTING',
    mergeStateStatus: 'DIRTY',
  });
  const conflictedRecomputing = baseSnapshot({
    verdict: 'WAITING_CI',
    blockers: ['mergeability_pending'],
    mergeable: null,
    mergeStateStatus: 'UNKNOWN',
  });
  assert.equal(
    fingerprint(conflicted, true),
    fingerprint(conflictedRecomputing, true),
    '冲突 PR 的重算窗口同样不得抖',
  );

  // 真实冲突的出现/解除仍是要唤起的变化
  assert.notEqual(fingerprint(stable), fingerprint(conflicted), '出现真实冲突必须算变化');
  // 非合并态 blocker 照常进指纹
  assert.notEqual(
    fingerprint(stable),
    fingerprint(baseSnapshot({ verdict: 'NEEDS_WORK', blockers: ['ci_failing', 'approval_required'] })),
  );
});

test('normalizeConflicting:两套字段域都认,未知窗口 carry-forward', () => {
  assert.equal(normalizeConflicting({ mergeable: 'CONFLICTING' }), true);
  assert.equal(normalizeConflicting({ mergeable: false }), true);
  assert.equal(normalizeConflicting({ mergeStateStatus: 'DIRTY' }), true);
  assert.equal(normalizeConflicting({ mergeable: 'MERGEABLE' }), false);
  assert.equal(normalizeConflicting({ mergeable: true }), false);
  assert.equal(normalizeConflicting({ mergeStateStatus: 'BLOCKED', mergeable: null }), false);
  // 未知窗口:沿用上次已知值;没有历史值当 false(宁可漏一轮也不抖)
  assert.equal(normalizeConflicting({ mergeable: null, mergeStateStatus: 'UNKNOWN' }, true), true);
  assert.equal(normalizeConflicting({ mergeable: null, mergeStateStatus: 'UNKNOWN' }, false), false);
  assert.equal(normalizeConflicting({ mergeable: null, mergeStateStatus: 'UNKNOWN' }), false);
});

test('指纹忽略 check run 的 detailsUrl / startedAt 抖动', () => {
  const pendingRun = (extra) => ({
    name: 'unit',
    status: 'IN_PROGRESS',
    conclusion: null,
    ...extra,
  });
  const withRuns = (extra) =>
    baseSnapshot({
      verdict: 'WAITING_CI',
      blockers: ['pending_checks'],
      checksSummary: {
        ...baseSnapshot().checksSummary,
        pending: 1,
        pendingRuns: [pendingRun(extra)],
      },
    });
  assert.equal(
    fingerprint(withRuns({ detailsUrl: 'https://x/1', startedAt: '2026-07-28T10:00:00Z' })),
    fingerprint(withRuns({ detailsUrl: 'https://x/2', startedAt: '2026-07-28T10:05:00Z' })),
  );
});

test('CI 状态变化进指纹(PR.updatedAt 不会因 check 变化而更新)', () => {
  const before = baseSnapshot({
    verdict: 'WAITING_CI',
    checksSummary: {
      ...baseSnapshot().checksSummary,
      pending: 1,
      pendingRuns: [{ name: 'unit', status: 'IN_PROGRESS', conclusion: null }],
    },
  });
  const after = baseSnapshot({
    verdict: 'NEEDS_WORK',
    checksSummary: {
      ...baseSnapshot().checksSummary,
      failed: 1,
      failingRuns: [{ name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE' }],
    },
  });
  assert.equal(before.updatedAt, after.updatedAt);
  assert.notEqual(fingerprint(before), fingerprint(after));
});

test('review thread 新回复与 resolve 进指纹', () => {
  const base = baseSnapshot();
  const replied = baseSnapshot({
    reviewThreads: {
      ...base.reviewThreads,
      nodes: [
        {
          id: 'T1',
          isResolved: true,
          isOutdated: false,
          comments: [
            { id: 'C1', updatedAt: '2026-07-28T09:00:00Z' },
            { id: 'C2', updatedAt: '2026-07-28T11:00:00Z' },
          ],
        },
      ],
    },
  });
  const unresolved = baseSnapshot({
    reviewThreads: {
      ...base.reviewThreads,
      activeUnresolvedCount: 1,
      unresolvedCount: 1,
      nodes: [{ ...base.reviewThreads.nodes[0], isResolved: false }],
    },
  });
  assert.notEqual(fingerprint(base), fingerprint(replied));
  assert.notEqual(fingerprint(base), fingerprint(unresolved));
});

test('decide:merged / closed 即使指纹未变也放行(收口需要 agent)', () => {
  const snap = baseSnapshot({ merged: true, verdict: 'MERGED_CLEANUP_READY' });
  const previous = { fingerprint: fingerprint(snap) };
  const d = decide({ snap, previous, now: Date.now() });
  assert.equal(d.exitCode, 0);
  assert.equal(d.reason, 'terminal');
});

test('decide:快照被截断时放行(不得在数据不全时判定已闭环)', () => {
  const snap = baseSnapshot({ gate: { verdict: 'READY', truncated: true } });
  const previous = { fingerprint: fingerprint(snap) };
  assert.equal(decide({ snap, previous, now: Date.now() }).reason, 'truncated');
});

test('decide:NEEDS_WORK 指纹未变仍放行(上轮活没干完不能停手)', () => {
  const snap = baseSnapshot({ verdict: 'NEEDS_WORK', blockers: ['ci_failing'] });
  const previous = { fingerprint: fingerprint(snap) };
  const d = decide({ snap, previous, now: Date.now() });
  assert.equal(d.exitCode, 0);
  assert.equal(d.reason, 'work-pending');
});

test('decide:actionable review/冲突在 work-pending 中明确要求自主推进', () => {
  const snap = baseSnapshot({
    verdict: 'NEEDS_WORK',
    blockers: ['unresolved_review_threads', 'merge_conflict'],
  });
  const previous = { fingerprint: fingerprint(snap) };
  const d = decide({ snap, previous, now: Date.now() });
  assert.equal(d.reason, 'work-pending');
  assert.match(d.detail, /agent-owned blocker=merge_conflict,unresolved_review_threads/);
  assert.match(d.detail, /pushed forward autonomously.*do not just reply "waiting for the user" and --ack/);
  assert.match(d.detail, /shrinking back to the original goal.*needs no user confirmation/);
});

test('decide:defer 压住 NEEDS_WORK,但真变化穿透 defer', () => {
  const snap = baseSnapshot({ verdict: 'NEEDS_WORK', blockers: ['ci_failing'] });
  const now = Date.now();
  const deferred = { fingerprint: fingerprint(snap), nextAllowAt: now + 3_600_000 };

  const held = decide({ snap, previous: deferred, now });
  assert.equal(held.exitCode, 2);
  assert.equal(held.reason, 'deferred');
  assert.equal(held.keepNextAllowAt, true);

  // 同一个 defer 状态下,PR 侧出现新 commit → 立刻放行
  const changed = decide({ snap: baseSnapshot({ latestCommitOid: 'bbb222' }), previous: deferred, now });
  assert.equal(changed.exitCode, 0);
  assert.equal(changed.reason, 'changed');

  // defer 到点 → 恢复放行
  const expired = decide({ snap, previous: { ...deferred, nextAllowAt: now - 1 }, now });
  assert.equal(expired.exitCode, 0);
  assert.equal(expired.reason, 'work-pending');
});

test('decide:BLOCKED_HUMAN 指纹未变则跳过(靠 defer 控制提醒节奏,不每轮唤起)', () => {
  const snap = baseSnapshot({ verdict: 'BLOCKED_HUMAN', blockers: ['approval_required'] });
  const previous = { fingerprint: fingerprint(snap) };
  const d = decide({ snap, previous, now: Date.now() });
  assert.equal(d.exitCode, 2);
  assert.equal(d.reason, 'idle');
});

test('decide:NEEDS_WORK 仅剩明确人工批准 thread 时跳过,普通技术 thread 仍放行', () => {
  const approvalThread = {
    id: 'T-approval',
    isResolved: false,
    isOutdated: false,
    comments: [{ body: 'This change needs explicit approval from a designated maintainer.' }],
  };
  const humanOnly = baseSnapshot({
    verdict: 'NEEDS_WORK',
    blockers: ['unresolved_review_threads', 'branch_protection_blocked'],
    reviewThreads: {
      ...baseSnapshot().reviewThreads,
      unresolvedCount: 1,
      activeUnresolvedCount: 1,
      nodes: [approvalThread],
    },
  });
  assert.equal(isHumanOnlyReviewPending(humanOnly), true);
  const confirmed = { fingerprint: fingerprint(humanOnly) };
  const held = decide({ snap: humanOnly, previous: confirmed, now: Date.now() });
  assert.equal(held.exitCode, 2);
  assert.equal(held.reason, 'blocked-human');
  assert.match(held.detail, /not waking the agent again.*Approve/);

  const externalChange = decide({
    snap: { ...humanOnly, updatedAt: 'new-external-check-state' },
    previous: { ...confirmed, currentFingerprint: confirmed.fingerprint, humanOnlyPending: true },
    now: Date.now(),
  });
  assert.equal(externalChange.exitCode, 2);
  assert.equal(externalChange.reason, 'blocked-human');
  assert.equal(externalChange.nextConfirmed, externalChange.fingerprint);

  const technical = {
    ...humanOnly,
    reviewThreads: {
      ...humanOnly.reviewThreads,
      nodes: [{ ...approvalThread, comments: [{ body: '请修复这个请求路径的错误处理。' }] }],
    },
  };
  assert.equal(isHumanOnlyReviewPending(technical), false);
  assert.equal(decide({ snap: technical, previous: { fingerprint: fingerprint(technical) }, now: Date.now() }).reason, 'work-pending');
});

// ── 保底巡检(指纹看不到的东西定期让 AI 看一眼)──────────────────────────

test('decide:太久没真正放行过 → 保底巡检放行,且不产生 pending', () => {
  const snap = baseSnapshot(); // READY,平时会 idle
  const fp = fingerprint(snap);
  const now = Date.now();
  const maxSilenceMs = 24 * 3_600_000;

  // 刚放行过 → 照常 idle
  const fresh = decide({
    snap,
    previous: { fingerprint: fp, lastPassAt: now - 3_600_000 },
    now,
    maxSilenceMs,
  });
  assert.equal(fresh.reason, 'idle');

  // 超过闸门 → 放行
  const stale = decide({
    snap,
    previous: { fingerprint: fp, lastPassAt: now - 25 * 3_600_000 },
    now,
    maxSilenceMs,
  });
  assert.equal(stale.exitCode, 0);
  assert.equal(stale.reason, 'silence-guard');
  assert.equal(stale.nextPending, null, '保底轮不是未处理的变化,不该产生 pending');
  assert.equal(stale.nextConfirmed, fp, '也不该动已确认指纹');
});

test('decide:defer 优先于保底巡检(尊重 agent 显式的别烦我)', () => {
  const snap = baseSnapshot();
  const fp = fingerprint(snap);
  const now = Date.now();
  const d = decide({
    snap,
    previous: { fingerprint: fp, lastPassAt: now - 25 * 3_600_000, nextAllowAt: now + 3_600_000 },
    now,
    maxSilenceMs: 24 * 3_600_000,
  });
  assert.equal(d.reason, 'deferred');
});

test('decide:保底巡检的锚点在 lastPassAt 缺失时回落,且无任何锚点时不误触发', () => {
  const snap = baseSnapshot();
  const fp = fingerprint(snap);
  const now = Date.now();
  const maxSilenceMs = 24 * 3_600_000;

  const viaChanged = decide({
    snap,
    previous: { fingerprint: fp, lastChangedAt: now - 60 * 3_600_000 },
    now,
    maxSilenceMs,
  });
  assert.equal(viaChanged.reason, 'silence-guard');

  // 完全没有时间锚点(异常状态)时不该凭 0 判成"静默了 56 年"
  const noAnchor = decide({ snap, previous: { fingerprint: fp }, now, maxSilenceMs });
  assert.equal(noAnchor.reason, 'idle');
});

// ── 草稿(draft) ──────────────────────────────────────────────────────────

/** 草稿态快照:pr-snapshot 对 isDraft 的判定就是 NOT_READY + blockers:['draft']。 */
function draftSnapshot(overrides = {}) {
  return baseSnapshot({
    isDraft: true,
    verdict: 'NOT_READY',
    blockers: ['draft'],
    mergeStateStatus: 'DRAFT',
    ...overrides,
  });
}

test('decide:转为草稿单独给出 draft-entered,并产生 pending(不会被吞掉)', () => {
  const snap = draftSnapshot();
  const now = Date.now();
  const d = decide({
    snap,
    // 上一轮是非草稿且已确认
    previous: { fingerprint: 'old-fp', wasDraft: false, lastCheckedAt: now - 600_000 },
    now,
  });
  assert.equal(d.exitCode, 0);
  assert.equal(d.reason, 'draft-entered');
  assert.equal(d.nextPending, d.fingerprint, '草稿转换是人工阻塞事件,必须享受重试保护');
});

test('decide:撤回草稿给出 draft-exited', () => {
  const snap = baseSnapshot();
  const now = Date.now();
  const d = decide({
    snap,
    previous: { fingerprint: 'old-fp', wasDraft: true, lastCheckedAt: now - 600_000 },
    now,
  });
  assert.equal(d.exitCode, 0);
  assert.equal(d.reason, 'draft-exited');
});

test('decide:旧状态没有 wasDraft 时不猜,按普通 changed 处理', () => {
  const now = Date.now();
  const d = decide({
    snap: draftSnapshot(),
    previous: { fingerprint: 'old-fp', lastCheckedAt: now - 600_000 },
    now,
  });
  assert.equal(d.reason, 'changed');
});

test('decide:草稿状态已确认且未到闸门 → 不重复提醒', () => {
  const snap = draftSnapshot();
  const fp = fingerprint(snap);
  const now = Date.now();
  const d = decide({
    snap,
    previous: { fingerprint: fp, wasDraft: true, lastDraftReminderAt: now - 3_600_000 },
    now,
  });
  assert.equal(d.exitCode, 2);
  assert.equal(d.reason, 'idle');
});

test('decide:草稿超过闸门 → draft-reminder,且不产生 pending', () => {
  const snap = draftSnapshot();
  const fp = fingerprint(snap);
  const now = Date.now();
  const d = decide({
    snap,
    previous: { fingerprint: fp, wasDraft: true, lastDraftReminderAt: now - 25 * 3_600_000 },
    now,
  });
  assert.equal(d.exitCode, 0);
  assert.equal(d.reason, 'draft-reminder');
  assert.equal(d.nextPending, null, '复提醒不是未处理的变化,漏一次下个窗口还会来');
  assert.equal(d.nextConfirmed, fp, '也不该动已确认指纹');
});

test('decide:draft-reminder 优先于保底巡检(草稿是更具体的原因)', () => {
  const snap = draftSnapshot();
  const fp = fingerprint(snap);
  const now = Date.now();
  const d = decide({
    snap,
    previous: {
      fingerprint: fp,
      wasDraft: true,
      lastDraftReminderAt: now - 25 * 3_600_000,
      lastPassAt: now - 30 * 3_600_000,
    },
    now,
    maxSilenceMs: 24 * 3_600_000,
  });
  assert.equal(d.reason, 'draft-reminder');
});

test('decide:defer 优先于 draft-reminder(刚挂 🔴 通知完的 4 小时内不重复打扰)', () => {
  const snap = draftSnapshot();
  const fp = fingerprint(snap);
  const now = Date.now();
  const d = decide({
    snap,
    previous: {
      fingerprint: fp,
      wasDraft: true,
      lastDraftReminderAt: now - 25 * 3_600_000,
      nextAllowAt: now + 3_600_000,
    },
    now,
  });
  assert.equal(d.reason, 'deferred');
});

test('decide:draftReminderMs=0 关闭复提醒(只在转草稿那一次提醒)', () => {
  const snap = draftSnapshot();
  const fp = fingerprint(snap);
  const now = Date.now();
  const d = decide({
    snap,
    previous: {
      fingerprint: fp,
      wasDraft: true,
      lastDraftReminderAt: now - 100 * 3_600_000,
      // 保底巡检也别来插队,单独验关闭语义
      lastPassAt: now,
    },
    now,
    draftReminderMs: 0,
  });
  assert.equal(d.reason, 'idle');
});

test('decide:非草稿 PR 不受 draft 闸门影响', () => {
  const snap = baseSnapshot();
  const fp = fingerprint(snap);
  const now = Date.now();
  const d = decide({
    snap,
    previous: {
      fingerprint: fp,
      wasDraft: false,
      lastDraftReminderAt: now - 100 * 3_600_000,
      lastPassAt: now,
    },
    now,
  });
  assert.equal(d.reason, 'idle');
});

test('decide:草稿闸门的锚点在缺失时回落,且无任何锚点时不误触发', () => {
  const snap = draftSnapshot();
  const fp = fingerprint(snap);
  const now = Date.now();

  // 旧版 gate 写的状态没有 lastDraftReminderAt —— 已卡很久的草稿应当立刻收到提醒,
  // 而不是从"现在"重新等一天
  const migrated = decide({
    snap,
    previous: { fingerprint: fp, wasDraft: true, lastCheckedAt: now - 50 * 3_600_000 },
    now,
    // 关掉保底巡检,确保命中的确实是 draft 分支
    maxSilenceMs: 10_000 * 3_600_000,
  });
  assert.equal(migrated.reason, 'draft-reminder');

  const noAnchor = decide({
    snap,
    previous: { fingerprint: fp, wasDraft: true },
    now,
    maxSilenceMs: 10_000 * 3_600_000,
  });
  assert.equal(noAnchor.reason, 'idle', '没有任何时间锚点时不该凭 0 判成静默了几十年');
});

test('保底巡检轮不刷新 lastChangedAt,所以 cadence 不会被它拉回高频', async (t) => {
  const fx = createFixture(t);
  fx.setSnapshot(baseSnapshot());
  await fx.run();
  await fx.run(['--ack']);

  // 把状态改成「4 天前变化过、3 天前放行过」
  const st = fx.readState();
  st.lastChangedAt = Date.now() - 4 * 86_400_000;
  st.lastPassAt = Date.now() - 3 * 86_400_000;
  st.lastCheckedAt = st.lastPassAt;
  fs.writeFileSync(fx.stateFile(), `${JSON.stringify(st, null, 2)}\n`, 'utf8');

  const guard = await fx.run(); // 不传参数：顺便验证默认闸门生效
  assert.equal(guard.code, 0, guard.stderr);
  assert.match(guard.stdout, /reason=silence-guard/);
  assert.equal(
    fx.readState().lastChangedAt,
    st.lastChangedAt,
    '保底轮不是真实变化,不能重置 quiet 锚点',
  );

  // 因此 cadence 建议仍停在最低档
  const sug = await fx.run(['--suggest', '--json']);
  assert.equal(JSON.parse(sug.stdout).cadence.label, '1d');
});

test('保底巡检的默认闸门是 24 小时', async (t) => {
  const fx = createFixture(t);
  fx.setSnapshot(baseSnapshot());
  await fx.run();
  await fx.run(['--ack']);

  // 把「上次放行 / 上次变化 / 上次检查」统一挪到 N 小时前，再跑一轮默认参数
  const silentFor = (hours) => {
    const st = fx.readState();
    const at = Date.now() - hours * 3_600_000;
    st.lastPassAt = at;
    st.lastChangedAt = at;
    st.lastCheckedAt = at;
    fs.writeFileSync(fx.stateFile(), `${JSON.stringify(st, null, 2)}\n`, 'utf8');
  };

  silentFor(23);
  assert.equal((await fx.run()).code, 2, '23 小时还没到闸门');

  silentFor(25);
  const fired = await fx.run();
  assert.equal(fired.code, 0, fired.stderr);
  assert.match(fired.stdout, /reason=silence-guard/);
});

test('--max-silence-hours 可调', async (t) => {
  const fx = createFixture(t);
  fx.setSnapshot(baseSnapshot());
  await fx.run();
  await fx.run(['--ack']);
  const st = fx.readState();
  st.lastPassAt = Date.now() - 3 * 3_600_000;
  st.lastChangedAt = st.lastPassAt;
  fs.writeFileSync(fx.stateFile(), `${JSON.stringify(st, null, 2)}\n`, 'utf8');

  const notYet = await fx.run(['--max-silence-hours', '48']);
  assert.equal(notYet.code, 2, '3 小时 < 48 小时闸门');

  const fired = await fx.run(['--max-silence-hours', '2']);
  assert.equal(fired.code, 0);
  assert.match(fired.stdout, /reason=silence-guard/);
});

// ── cadence 建议(gate 是唯一决策源)────────────────────────────────────────

const NOW = 1_800_000_000_000;
const ago = (ms) => NOW - ms;

test('suggestCadence:安静越久档位越低', () => {
  const at = (quietMs) =>
    suggestCadence({ verdict: 'READY', lastChangedAt: ago(quietMs) }, NOW).label;
  assert.equal(at(60_000), '10m');
  assert.equal(at(29 * 60_000), '10m');
  assert.equal(at(31 * 60_000), '1h');
  assert.equal(at(3 * 3_600_000), '4h');
  assert.equal(at(10 * 3_600_000), '8h');
  assert.equal(at(5 * 86_400_000), '1d');
});

test('suggestCadence:该保持敏感的状态一律回到最高频', () => {
  const fast = (state) => suggestCadence(state, NOW);
  const longQuiet = { lastChangedAt: ago(30 * 86_400_000) };

  assert.equal(fast(null).label, '10m', '无状态');
  assert.equal(fast({ ...longQuiet, verdict: 'NEEDS_WORK' }).reason, 'work-pending');
  assert.equal(fast({ ...longQuiet, verdict: 'READY', merged: true }).reason, 'terminal');
  assert.equal(fast({ ...longQuiet, verdict: 'READY', closed: true }).reason, 'terminal');
  assert.equal(
    fast({ ...longQuiet, verdict: 'READY', pendingFingerprint: 'abc' }).reason,
    'unacked',
    '有未确认变化时不能降档,否则重试节奏被拖慢',
  );
  assert.equal(
    fast({ ...longQuiet, verdict: 'READY', nextAllowAt: NOW + 3_600_000 }).reason,
    'deferred',
    'defer 期间压制交给 defer,cadence 仍要对真变化敏感',
  );
  // 上面每一条都必须真的是最高频，而不只是 reason 对
  for (const s of [
    { ...longQuiet, verdict: 'NEEDS_WORK' },
    { ...longQuiet, verdict: 'READY', merged: true },
    { ...longQuiet, verdict: 'READY', pendingFingerprint: 'abc' },
    { ...longQuiet, verdict: 'READY', nextAllowAt: NOW + 3_600_000 },
  ]) {
    assert.equal(fast(s).label, '10m');
    assert.equal(fast(s).intervalMs, 600_000);
  }
});

test('suggestCadence:仅剩人工批准时不把 NEEDS_WORK 误标成 work-pending', () => {
  const cadence = suggestCadence({
    verdict: 'NEEDS_WORK',
    humanOnlyPending: true,
    lastChangedAt: ago(31 * 60_000),
  }, NOW);
  assert.equal(cadence.reason, 'human-only');
  assert.equal(cadence.label, '1h');
});

test('suggestCadence:锚点缺失时回落 lastCheckedAt,再不行按现在算(不误降档)', () => {
  assert.equal(suggestCadence({ verdict: 'READY', lastCheckedAt: ago(3 * 3_600_000) }, NOW).label, '4h');
  assert.equal(suggestCadence({ verdict: 'READY' }, NOW).label, '10m');
});

test('suggestCadence:输出可直接喂给 schedule_update', () => {
  const s = suggestCadence({ verdict: 'READY', lastChangedAt: ago(3 * 3_600_000) }, NOW);
  assert.equal(s.intervalMs, 4 * 3_600_000);
  assert.equal(s.cronExpr, '0 */4 * * *');
  assert.ok(s.detail.includes('since the last change'));
});

// ── 端到端(真的 spawn 脚本,验证退出码协议)──────────────────────────────

/**
 * 经软链调用时 main 必须照跑 —— 这是所有其它端到端断言的前提。
 *
 * Cindy 把内置技能经软链(`.active` 等)投影给各 Agent,agent 会话里看到的 skill 目录就是它,照它拼出
 * 的命令带着软链前缀。入口判据若只比未归一的 `argv[1]` 与已被 Node 解析的 `import.meta.url`,
 * 两者不等 ⇒ main 静默跳过 ⇒ 脚本 exit 0 什么都不做。而 exit 0 在 preRunHook 协议里正是
 * 「放行」,坏成「每轮无条件唤起 agent、一个判定都不做」,而且**看起来完全正常**:退出码对、
 * 无报错,只有状态文件一直不动(2026-08-01 实测,`--ack` 也一并静默失效)。
 * 所以断言不能只看退出码,必须钉住「状态真的写了」。
 */
test('经软链调用时 main 照跑(退出码 0 不等于真跑过)', { skip: process.platform === 'win32' ? 'POSIX-only: symlink' : false }, async (t) => {
  const fx = createFixture(t);
  fx.setSnapshot(baseSnapshot());

  const linked = path.join(fx.root, 'gate-via-symlink.mjs');
  fs.symlinkSync(gatePath, linked);

  const viaLink = await fx.runVia(linked);
  assert.equal(viaLink.code, 0, viaLink.stderr);
  assert.match(viaLink.stdout, /PASS .*reason=first-round/, '软链调用必须真的做出判定');
  assert.ok(
    fx.readState().pendingFingerprint,
    '状态文件必须真的写了 —— 只断言退出码 0 的话,静默跳过 main 也会通过',
  );

  // --ack 同样要经软链生效,否则同一变化会被反复重试、心跳节奏坏掉
  const acked = await fx.runVia(linked, ['--ack']);
  assert.equal(acked.code, 0, acked.stderr);
  assert.match(acked.stdout, /reason=acked/);
  assert.equal(fx.readState().pendingFingerprint, undefined, '软链调用的 --ack 必须真的提升指纹');
});

test('首轮放行 → --ack 确认 → 无变化才跳过', async (t) => {
  const fx = createFixture(t);
  fx.setSnapshot(baseSnapshot());

  const first = await fx.run();
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /PASS .*reason=first-round/);
  // 放行只写 pending,不推进 confirmed —— 这是「放行后失败仍可重试」的关键
  const afterFirst = fx.readState();
  assert.ok(afterFirst.pendingFingerprint);
  assert.equal(afterFirst.fingerprint, undefined);
  assert.equal(afterFirst.verdict, 'READY');

  const acked = await fx.run(['--ack']);
  assert.equal(acked.code, 0, acked.stderr);
  assert.match(acked.stdout, /reason=acked/);
  const afterAck = fx.readState();
  assert.equal(afterAck.fingerprint, afterFirst.pendingFingerprint);
  assert.equal(afterAck.pendingFingerprint, undefined);

  const second = await fx.run();
  assert.equal(second.code, 2, second.stderr);
  assert.match(second.stdout, /SKIP .*reason=idle/);
});

test('放行后没 ack(宿主建会话失败 / agent 崩了)→ 下一轮重试,绝不吞掉该变化', async (t) => {
  const fx = createFixture(t);
  fx.setSnapshot(baseSnapshot());
  await fx.run();
  await fx.run(['--ack']);

  // 来了一条新评论(verdict 仍是 READY —— 这种状态没有 work-pending 兜底,
  // 单段式指纹下一旦漏掉就是永久漏掉)
  fx.setSnapshot(
    baseSnapshot({
      updatedAt: '2026-07-28T12:00:00Z',
      comments: [
        { id: 'IC1', updatedAt: '2026-07-28T09:45:00Z' },
        { id: 'IC2', updatedAt: '2026-07-28T12:00:00Z' },
      ],
    }),
  );
  const r1 = await fx.run();
  assert.equal(r1.code, 0, r1.stderr);
  assert.match(r1.stdout, /PASS .*reason=changed/);

  // agent 没能处理完(没 ack):同一快照下一轮必须再放行
  const r2 = await fx.run();
  assert.equal(r2.code, 0, '未确认处理完的变化必须能重试');
  assert.match(r2.stdout, /reason=retry-unacked/);

  // 处理完并确认后才安静
  await fx.run(['--ack']);
  const r3 = await fx.run();
  assert.equal(r3.code, 2, r3.stderr);
});

test('快速重试用尽后转退避重试:既不每轮无限唤起,也绝不永久放弃', async (t) => {
  const fx = createFixture(t);
  fx.setSnapshot(baseSnapshot());
  await fx.run();
  await fx.run(['--ack']);

  fx.setSnapshot(baseSnapshot({ updatedAt: '2026-07-28T12:00:00Z' }));
  const a1 = await fx.run();
  assert.match(a1.stdout, /reason=changed.*attempt=1\/3/);
  const a2 = await fx.run();
  assert.match(a2.stdout, /reason=retry-unacked.*attempt=2\/3/);
  const a3 = await fx.run();
  assert.match(a3.stdout, /reason=retry-unacked.*attempt=3\/3/);

  // 快速重试用尽 → 这一轮仍放行,但设下退避闸门
  const a4 = await fx.run();
  assert.equal(a4.code, 0, a4.stderr);
  assert.match(a4.stdout, /reason=retry-backoff-attempt/);
  const st = fx.readState();
  assert.ok(st.retryBackoffUntil > Date.now() + 1_500_000, '应设 30 分钟量级的退避');
  assert.ok(st.pendingFingerprint, '绝不能把未确认的变化当成已确认');
  assert.equal(st.fingerprint !== st.pendingFingerprint, true);

  // 退避期内跳过,但状态保留(事件没丢)
  const a5 = await fx.run();
  assert.equal(a5.code, 2, a5.stderr);
  assert.match(a5.stdout, /reason=retry-backoff/);
  assert.ok(fx.readState().pendingFingerprint, '退避期间仍记着这个未处理的变化');

  // 退避到点 → 再放行一次(永不放弃)
  fx.writeState({ retryBackoffUntil: Date.now() - 1 });
  const a6 = await fx.run();
  assert.equal(a6.code, 0, a6.stderr);
  assert.match(a6.stdout, /reason=retry-backoff-attempt/);

  // 一旦确认处理完,退避闸门与 pending 一起清掉
  await fx.run(['--ack']);
  const acked = fx.readState();
  assert.equal(acked.pendingFingerprint, undefined);
  assert.equal(acked.retryBackoffUntil, undefined);
  const a7 = await fx.run();
  assert.equal(a7.code, 2, a7.stderr);
  assert.match(a7.stdout, /reason=idle/);
});

test('慢 agent 的 ack 不会误确认它没见过的新指纹(pending 不被覆盖)', async (t) => {
  const fx = createFixture(t);
  const snap0 = baseSnapshot();
  fx.setSnapshot(snap0);
  await fx.run();
  await fx.run(['--ack']); // confirmed = fp0

  // 轮次 A:来了新评论 fp1,gate 放行,agent A 开始跑(很慢,还没 ack)
  const snap1 = baseSnapshot({
    updatedAt: '2026-07-28T12:00:00Z',
    comments: [{ id: 'IC2', updatedAt: '2026-07-28T12:00:00Z' }],
  });
  fx.setSnapshot(snap1);
  const roundA = await fx.run();
  assert.equal(roundA.code, 0, roundA.stderr);
  assert.equal(fx.readState().pendingFingerprint, fingerprint(snap1));

  // 轮次 B:agent A 还在跑,PR 又变了(fp2)。gate 照常判定,但不得覆盖 pending
  const snap2 = baseSnapshot({
    updatedAt: '2026-07-28T13:00:00Z',
    comments: [
      { id: 'IC2', updatedAt: '2026-07-28T12:00:00Z' },
      { id: 'IC3', updatedAt: '2026-07-28T13:00:00Z' },
    ],
  });
  fx.setSnapshot(snap2);
  const roundB = await fx.run();
  assert.equal(roundB.code, 0, roundB.stderr);
  assert.equal(
    fx.readState().pendingFingerprint,
    fingerprint(snap1),
    'pending 必须保留最早的未确认指纹',
  );

  // agent A 终于跑完并 ack:只应确认它处理的 fp1,不能把没人处理过的 fp2 也吃掉
  await fx.run(['--ack']);
  const acked = fx.readState();
  assert.equal(acked.fingerprint, fingerprint(snap1));
  assert.notEqual(acked.fingerprint, fingerprint(snap2));

  // fp2 仍未处理 → 下一轮必须放行
  const roundC = await fx.run();
  assert.equal(roundC.code, 0, 'fp2 的新评论绝不能被吞掉');
  assert.match(roundC.stdout, /PASS/);

  // 处理完 fp2 并确认后才安静
  await fx.run(['--ack']);
  const roundD = await fx.run();
  assert.equal(roundD.code, 2, roundD.stderr);
  assert.match(roundD.stdout, /reason=idle/);
});

test('PR 持续有新变化时每轮都放行,不会被重试计数误判成退避', async (t) => {
  const fx = createFixture(t);
  fx.setSnapshot(baseSnapshot());
  await fx.run();
  await fx.run(['--ack']);

  // 连续 5 轮每轮都有新变化,且一次都没 ack:必须每轮放行(活跃 PR 不该被退避)
  for (let i = 1; i <= 5; i++) {
    fx.setSnapshot(baseSnapshot({ updatedAt: `2026-07-28T1${i}:00:00Z`, latestCommitOid: `c${i}` }));
    const r = await fx.run();
    assert.equal(r.code, 0, `第 ${i} 轮应放行: ${r.stdout} ${r.stderr}`);
    assert.match(r.stdout, /attempt=1\/3/);
  }
});

test('--max-pass-attempts 1 时首轮后即进入退避重试', async (t) => {
  const fx = createFixture(t);
  fx.setSnapshot(baseSnapshot());
  const first = await fx.run(['--max-pass-attempts', '1']);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /reason=first-round/);
  const second = await fx.run(['--max-pass-attempts', '1']);
  assert.equal(second.code, 0, '未 ack 时仍要重试一次并设退避');
  assert.match(second.stdout, /reason=retry-backoff-attempt/);
  const third = await fx.run(['--max-pass-attempts', '1']);
  assert.equal(third.code, 2, third.stderr);
  assert.match(third.stdout, /reason=retry-backoff/);
});

test('--retry-backoff-minutes 可调,且新变化会清掉退避闸门', async (t) => {
  const fx = createFixture(t);
  fx.setSnapshot(baseSnapshot());
  await fx.run();
  await fx.run(['--ack']);

  fx.setSnapshot(baseSnapshot({ updatedAt: '2026-07-28T12:00:00Z' }));
  for (let i = 0; i < 4; i++) await fx.run(['--retry-backoff-minutes', '30']);
  const backoff = fx.readState().retryBackoffUntil;
  assert.ok(backoff > Date.now() + 1_500_000 && backoff < Date.now() + 1_900_000, '应约 30 分钟');

  // 期间 PR 又变了 → 视作新变化,重新开始快速重试,退避闸门清掉
  fx.setSnapshot(baseSnapshot({ updatedAt: '2026-07-28T13:00:00Z', latestCommitOid: 'ddd444' }));
  const fresh = await fx.run(['--retry-backoff-minutes', '30']);
  assert.equal(fresh.code, 0, fresh.stderr);
  assert.match(fresh.stdout, /reason=changed.*attempt=1\/3/);
  assert.equal(fx.readState().retryBackoffUntil, undefined);
});

test('fetchedAt 变化不触发唤起(端到端)', async (t) => {
  const fx = createFixture(t);
  fx.setSnapshot(baseSnapshot());
  await fx.run();
  await fx.run(['--ack']);

  fx.setSnapshot(baseSnapshot({ fetchedAt: '2026-07-29T06:00:00.000Z' }));
  const again = await fx.run();
  assert.equal(again.code, 2, again.stderr);
});

test('快照失败先容忍瞬时抖动,连续到阈值才 fail-closed —— 绝不静默跳过', async (t) => {
  const fx = createFixture(t);
  fx.setSnapshot(baseSnapshot());
  await fx.run(); // 建立基线
  await fx.run(['--ack']);

  const failEnv = { FAKE_SNAPSHOT_EXIT: '2', FAKE_SNAPSHOT_STDERR: '[pr-snapshot] gh auth expired\n' };

  const r1 = await fx.run([], failEnv);
  assert.equal(r1.code, 2, 'snapshot 的 exit 2 = 查询失败,首轮容忍为跳过');
  assert.equal(fx.readState().consecutiveSnapshotFailures, 1);
  assert.equal(fx.readState().lastResult.decision, 'skip');
  assert.match(fx.readState().lastResult.detail, /failures=1\/3/);

  const r2 = await fx.run([], failEnv);
  assert.equal(r2.code, 2);
  assert.equal(fx.readState().consecutiveSnapshotFailures, 2);

  const r3 = await fx.run([], failEnv);
  assert.equal(r3.code, 1, '连续第 3 轮失败必须 fail-closed 让用户看见');
  assert.equal(fx.readState().lastResult.decision, 'block');
  assert.match(r3.stderr, /3 consecutive rounds/);
  assert.match(r3.stderr, /gh auth expired/);

  const waiting = await fx.run();
  assert.equal(waiting.code, 2);
  assert.equal(fx.readState().lastResult.reason, 'snapshot-failure-backoff');
  fx.writeState({ snapshotFailureBackoffUntil: 0 });
  // 恢复后失败计数归零
  const ok = await fx.run();
  assert.equal(ok.code, 2, ok.stderr); // 内容没变 → idle
  assert.equal(fx.readState().consecutiveSnapshotFailures, 0);
  assert.equal(fx.readState().snapshotFailureBackoffUntil, undefined);
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
  assert.equal(snapshotFailurePlan(run, { snapshotFailureReports: different.reports }, now + 800_000).block, false);
});

test('rate-limit backoff performs no snapshot and healthy recovery emits a host marker', async (t) => {
  const fx = createFixture(t);
  fx.setSnapshot(baseSnapshot());
  const fail = await fx.run([], { FAKE_SNAPSHOT_EXIT: '1', FAKE_SNAPSHOT_STDERR: '[gh-rate-limit] retryAt=0\nquery line 1\nquery line 2\nquery line 3' });
  assert.equal(fail.code, 1);
  assert.match(fail.stderr, /rate limit/);
  // Invalid JSON would increment failures if the snapshot were actually executed.
  const backoff = await fx.run([], { FAKE_SNAPSHOT_STDOUT_RAW: 'invalid' });
  assert.doesNotMatch(backoff.stdout, /CINDY_PRECHECK_OK/);
  assert.equal(fx.readState().consecutiveSnapshotFailures, 1);
  fx.writeState({ snapshotFailureBackoffUntil: 0 });
  const recovered = await fx.run();
  assert.match(recovered.stdout, /CINDY_PRECHECK_OK/);
  assert.equal(fx.readState().consecutiveSnapshotFailures, 0);
  fx.setSnapshot({ ...baseSnapshot(), checksSummary: { unavailable: true } });
  assert.doesNotMatch((await fx.run()).stdout, /CINDY_PRECHECK_OK/);
});

test('truncated snapshots retain failure reports until a complete check recovers', async (t) => {
  const fx = createFixture(t);
  fx.setSnapshot(baseSnapshot());
  await fx.run([], { FAKE_SNAPSHOT_EXIT: '1', FAKE_SNAPSHOT_STDERR: 'rate limit exceeded' });
  const reports = fx.readState().snapshotFailureReports;
  fx.writeState({ snapshotFailureBackoffUntil: 0 });
  for (const state of ['OPEN', 'CLOSED']) {
    fx.setSnapshot(baseSnapshot({ state, closed: state === 'CLOSED', gate: { truncated: true } }));
    const incomplete = await fx.run();
    assert.doesNotMatch(incomplete.stdout, /CINDY_PRECHECK_OK/);
    assert.equal(fx.readState().consecutiveSnapshotFailures, 1);
    assert.deepEqual(fx.readState().snapshotFailureReports, reports);
  }
  fx.setSnapshot(baseSnapshot());
  assert.match((await fx.run()).stdout, /CINDY_PRECHECK_OK/);
  assert.equal(fx.readState().consecutiveSnapshotFailures, 0);
  assert.equal(fx.readState().snapshotFailureReports, undefined);
});

test('--max-snapshot-failures 1 时首轮失败即 fail-closed', async (t) => {
  const fx = createFixture(t);
  fx.setSnapshot(baseSnapshot());
  await fx.run();
  const r = await fx.run(['--max-snapshot-failures', '1'], { FAKE_SNAPSHOT_EXIT: '2' });
  assert.equal(r.code, 1);
});

test('快照 stdout 不是合法 JSON 时按失败处理,不当作无变化', async (t) => {
  const fx = createFixture(t);
  fx.setSnapshot(baseSnapshot());
  await fx.run();
  const r = await fx.run(['--max-snapshot-failures', '1'], {
    FAKE_SNAPSHOT_STDOUT_RAW: 'not json at all',
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not valid JSON|consecutive rounds/);
});

test('snapshot 脚本不存在 → fail-closed(确定性配置错误)', async (t) => {
  const fx = createFixture(t);
  fx.setSnapshot(baseSnapshot());
  const r = await fx.run(['--snapshot', path.join(fx.root, 'nope.mjs')]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /snapshot script not found/);
});

test('merged 端到端放行,即使上一轮已见过同一指纹', async (t) => {
  const fx = createFixture(t);
  const merged = baseSnapshot({ merged: true, verdict: 'MERGED_CLEANUP_READY' });
  fx.setSnapshot(merged);
  await fx.run();
  const again = await fx.run();
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /PASS .*reason=terminal/);
});

test('--defer 隐含 ack,写入 nextAllowAt 并保留既有状态;跳过轮次不会消费它', async (t) => {
  const fx = createFixture(t);
  fx.setSnapshot(baseSnapshot({ verdict: 'NEEDS_WORK', blockers: ['ci_failing'] }));
  const first = await fx.run(); // first-round 放行,只写 pending
  assert.equal(first.code, 0, first.stderr);
  const pendingFp = fx.readState().pendingFingerprint;
  assert.ok(pendingFp);

  const defer = await fx.run(['--defer', '240']);
  assert.equal(defer.code, 0, defer.stderr);
  const afterDefer = fx.readState();
  assert.ok(afterDefer.nextAllowAt > Date.now() + 3_000_000);
  assert.equal(afterDefer.verdict, 'NEEDS_WORK', 'defer 不应清掉已有状态');
  assert.equal(afterDefer.fingerprint, pendingFp, 'defer 应隐含 ack 提升 confirmed');
  assert.equal(afterDefer.pendingFingerprint, undefined);

  // NEEDS_WORK 本来会放行,defer 期间应被压住,且连续两轮都压住
  const held1 = await fx.run();
  assert.equal(held1.code, 2, held1.stderr);
  assert.match(held1.stdout, /SKIP .*reason=deferred/);
  const held2 = await fx.run();
  assert.equal(held2.code, 2, held2.stderr);
  assert.ok(fx.readState().nextAllowAt > Date.now(), 'defer 必须跨轮保留,不能只生效一轮');
});

test('放行后 defer 被消费掉,不会永久压住后续轮次', async (t) => {
  const fx = createFixture(t);
  fx.setSnapshot(baseSnapshot({ verdict: 'NEEDS_WORK', blockers: ['ci_failing'] }));
  await fx.run();
  await fx.run(['--defer', '240']);

  // 新 commit 穿透 defer 放行
  fx.setSnapshot(baseSnapshot({ verdict: 'NEEDS_WORK', blockers: ['ci_failing'], latestCommitOid: 'ccc333' }));
  const passed = await fx.run();
  assert.equal(passed.code, 0, passed.stderr);
  assert.match(passed.stdout, /reason=changed/);
  assert.equal(fx.readState().nextAllowAt, undefined, '放行即消费 defer');

  // 确认处理完后同一内容再来一轮:NEEDS_WORK 仍放行(还有活要干)
  await fx.run(['--ack']);
  const next = await fx.run();
  assert.equal(next.code, 0, next.stderr);
  assert.match(next.stdout, /reason=work-pending/);
});

test('状态文件损坏时退化为首轮放行,不炸也不静默跳过', async (t) => {
  const fx = createFixture(t);
  fx.setSnapshot(baseSnapshot());
  await fx.run();
  fs.writeFileSync(fx.stateFile(), '{ broken', 'utf8');
  const r = await fx.run();
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /reason=first-round/);
});

test('lastChangedAt 只在真实变化时刷新 —— 否则 quiet 永远归零、永远降不下来', async (t) => {
  const fx = createFixture(t);
  fx.setSnapshot(baseSnapshot());
  await fx.run(); // first-round 算变化
  const t1 = fx.readState().lastChangedAt;
  assert.ok(t1, 'first-round 应落 lastChangedAt');
  await fx.run(['--ack']);

  // idle 轮:不能刷新
  const idle = await fx.run();
  assert.equal(idle.code, 2, idle.stderr);
  assert.equal(fx.readState().lastChangedAt, t1, 'idle 轮不算变化');

  // 真变化:必须刷新
  fx.setSnapshot(baseSnapshot({ updatedAt: '2026-07-28T12:00:00Z' }));
  await fx.run();
  assert.ok(fx.readState().lastChangedAt > t1, 'changed 轮必须刷新锚点');
});

test('work-pending 与未确认重试轮都不刷新 lastChangedAt', async (t) => {
  const fx = createFixture(t);
  const snap = baseSnapshot({ verdict: 'NEEDS_WORK', blockers: ['ci_failing'] });
  fx.setSnapshot(snap);
  await fx.run(); // first-round
  const t1 = fx.readState().lastChangedAt;

  // 未 ack → retry-unacked 放行,不算新变化
  const retry = await fx.run();
  assert.match(retry.stdout, /reason=retry-unacked/);
  assert.equal(fx.readState().lastChangedAt, t1);

  // ack 后同一快照 → work-pending 放行,同样不算新变化
  await fx.run(['--ack']);
  const wp = await fx.run();
  assert.match(wp.stdout, /reason=work-pending/);
  assert.equal(fx.readState().lastChangedAt, t1, 'work-pending 反复放行不该重置 quiet');
});

test('旧状态迁移:没有 lastChangedAt 时锚点继承 lastCheckedAt,不被 idle 轮重置', async (t) => {
  const fx = createFixture(t);
  fx.setSnapshot(baseSnapshot());
  await fx.run();
  await fx.run(['--ack']);

  // 模拟旧版 gate 写的状态：只有 lastCheckedAt（3 天前），没有 lastChangedAt
  const threeDaysAgo = Date.now() - 3 * 86_400_000;
  const st = fx.readState();
  delete st.lastChangedAt;
  st.lastCheckedAt = threeDaysAgo;
  fs.writeFileSync(fx.stateFile(), `${JSON.stringify(st, null, 2)}\n`, 'utf8');

  // 走一个 idle 轮：绝不能把锚点重置成"现在"，否则安静 3 天的心跳会重新从 10m 起跳
  const idle = await fx.run();
  assert.equal(idle.code, 2, idle.stderr);
  assert.equal(
    fx.readState().lastChangedAt,
    threeDaysAgo,
    'idle 轮应继承 lastCheckedAt 作为锚点，而不是重置为 now',
  );

  // 因此建议应当已经降到最低档
  const sug = await fx.run(['--suggest', '--json']);
  assert.equal(JSON.parse(sug.stdout).cadence.label, '1d');
});

test('只读查询与写命令混用或互相混用 → fail-closed，不静默跳过写入', async (t) => {
  const fx = createFixture(t);
  fx.setSnapshot(baseSnapshot());
  await fx.run();
  const pendingBefore = fx.readState().pendingFingerprint;
  assert.ok(pendingBefore);

  for (const extra of [
    ['--suggest', '--ack'],
    ['--suggest', '--defer', '60'],
    ['--last-result', '--ack'],
    ['--last-result', '--defer', '60'],
    ['--suggest', '--last-result'],
  ]) {
    const r = await fx.run(extra);
    assert.equal(r.code, 1, `应拒绝: ${extra.join(' ')}`);
    assert.match(r.stderr, /cannot be combined|separate read-only/);
  }
  // 拒绝后状态未被动过（ack 没有偷偷生效，也没有偷偷跳过）
  assert.equal(fx.readState().pendingFingerprint, pendingBefore);
});

test('--suggest 只读状态、不改状态、不需要 snapshot 脚本', async (t) => {
  const fx = createFixture(t);
  fx.setSnapshot(baseSnapshot());
  await fx.run();
  await fx.run(['--ack']);

  const before = fs.readFileSync(fx.stateFile(), 'utf8');
  const r = await fx.run(['--suggest', '--json', '--snapshot', path.join(fx.root, 'nope.mjs')]);
  assert.equal(r.code, 0, r.stderr);
  const payload = JSON.parse(r.stdout);
  assert.ok(payload.cadence.intervalMs > 0);
  assert.ok(payload.cadence.cronExpr);
  assert.match(payload.reason, /^suggest-/);
  assert.equal(fs.readFileSync(fx.stateFile(), 'utf8'), before, '--suggest 不得改状态文件');
});

test('--last-result 只读返回最近普通 gate 的实际结果，不重跑 snapshot', async (t) => {
  const fx = createFixture(t);
  fx.setSnapshot(baseSnapshot({ verdict: 'NEEDS_WORK', blockers: ['ci_failing'] }));
  const gate = JSON.parse((await fx.run(['--json'])).stdout);
  const before = fs.readFileSync(fx.stateFile(), 'utf8');

  const r = await fx.run([
    '--last-result',
    '--json',
    '--snapshot',
    path.join(fx.root, 'does-not-exist.mjs'),
  ]);
  assert.equal(r.code, 0, r.stderr);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.reason, 'last-result');
  assert.equal(payload.lastResult.decision, 'run');
  assert.equal(payload.lastResult.reason, gate.reason);
  assert.equal(payload.lastResult.detail, gate.detail);
  assert.equal(payload.lastResult.verdict, 'NEEDS_WORK');
  assert.deepEqual(payload.lastResult.blockers, ['ci_failing']);
  assert.equal(fs.readFileSync(fx.stateFile(), 'utf8'), before, '--last-result 不得改状态文件');
});

test('--last-result 兼容旧状态文件已有的 lastDecision 字段', async (t) => {
  const fx = createFixture(t);
  fx.writeState({ lastDecision: 'pass', lastDecisionReason: 'legacy-pass', lastCheckedAt: 123 });
  const r = await fx.run(['--last-result', '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).lastResult, {
    decision: 'run',
    reason: 'legacy-pass',
    checkedAt: 123,
  });
});

test('--ack 输出带 cadence 建议,且用 ack 之后的状态算(不会恒报 unacked)', async (t) => {
  const fx = createFixture(t);
  fx.setSnapshot(baseSnapshot());
  await fx.run(); // 放行后有 pending

  const acked = await fx.run(['--ack', '--json']);
  assert.equal(acked.code, 0, acked.stderr);
  const payload = JSON.parse(acked.stdout);
  assert.ok(payload.cadence, 'ack 输出应附带 cadence 建议');
  assert.notEqual(
    payload.cadence.reason,
    'unacked',
    'ack 已清掉 pending，建议必须基于写入后的状态',
  );
  assert.match(acked.stdout, /cadence=/);
});

test('--json 输出可解析且带决策原因', async (t) => {
  const fx = createFixture(t);
  fx.setSnapshot(baseSnapshot());
  const r = await fx.run(['--json']);
  assert.equal(r.code, 0);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.reason, 'first-round');
  assert.equal(payload.repo, REPO);
  assert.equal(payload.number, NUMBER);
});

test('草稿全时序端到端:转草稿 → 确认 → 未到点静默 → 每天复提醒 → 撤回', async (t) => {
  const fx = createFixture(t);

  // 基线:非草稿,建立并确认
  fx.setSnapshot(baseSnapshot());
  await fx.run();
  await fx.run(['--ack']);
  assert.equal((await fx.run()).code, 2, '无变化应跳过');

  // 转草稿 → 放行,reason=draft-entered
  fx.setSnapshot(draftSnapshot());
  const entered = await fx.run(['--json']);
  assert.equal(entered.code, 0);
  assert.equal(JSON.parse(entered.stdout).reason, 'draft-entered');
  assert.equal(fx.readState().wasDraft, true);
  assert.ok(fx.readState().lastDraftEnteredAt > 0, '应记下进入草稿的时刻');

  // AI 处理完并确认 → 同一草稿状态不再重复唤起
  await fx.run(['--ack']);
  assert.equal((await fx.run()).code, 2, '草稿没变化不该重复提醒');
  assert.ok(fx.readState().lastDraftEnteredAt > 0, 'lastDraftEnteredAt 不能在后续轮次丢失');

  // 把闸门锚点拨回 25 小时前 → 复提醒
  fx.writeState({ lastDraftReminderAt: Date.now() - 25 * 3_600_000 });
  const first = await fx.run(['--json']);
  assert.equal(first.code, 0);
  assert.equal(JSON.parse(first.stdout).reason, 'draft-reminder');
  // 复提醒后锚点重置 → 立刻再跑一轮应恢复静默(不会连续轰炸)
  assert.equal((await fx.run()).code, 2, '复提醒后应重新静默到下个窗口');

  // 再过一天 → 再提醒一次
  fx.writeState({ lastDraftReminderAt: Date.now() - 25 * 3_600_000 });
  assert.equal(JSON.parse((await fx.run(['--json'])).stdout).reason, 'draft-reminder');

  // 撤回草稿 → draft-exited,且草稿锚点被清掉
  fx.setSnapshot(baseSnapshot());
  const exited = await fx.run(['--json']);
  assert.equal(exited.code, 0);
  assert.equal(JSON.parse(exited.stdout).reason, 'draft-exited');
  const after = fx.readState();
  assert.equal(after.wasDraft, false);
  assert.equal(after.lastDraftReminderAt, undefined, '撤回后不该留着草稿闸门');
  assert.equal(after.lastDraftEnteredAt, undefined);
});

test('核心不变式:草稿期间不相关的放行不会重置草稿闸门', async (t) => {
  const fx = createFixture(t);
  fx.setSnapshot(baseSnapshot());
  await fx.run();
  await fx.run(['--ack']);

  // 进入草稿并确认
  fx.setSnapshot(draftSnapshot());
  await fx.run();
  await fx.run(['--ack']);

  // 闸门拨到 20 小时前(还差 4 小时到点)
  const anchor = Date.now() - 20 * 3_600_000;
  fx.writeState({ lastDraftReminderAt: anchor });

  // 期间来了一次与草稿无关的变化(CI 跑挂了),照常放行并确认 —— 这会推进 lastPassAt
  fx.setSnapshot(
    draftSnapshot({
      updatedAt: '2026-07-29T12:00:00Z',
      checksSummary: {
        ...draftSnapshot().checksSummary,
        failed: 1,
        failingRuns: [{ name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE' }],
      },
    }),
  );
  assert.equal((await fx.run()).code, 0, '不相关的真实变化照常放行');
  await fx.run(['--ack']);

  const state = fx.readState();
  assert.equal(
    state.lastDraftReminderAt,
    anchor,
    '草稿闸门必须仍停在原锚点 —— 否则等人回复的钟会被 PR 侧杂音无限推后',
  );
  assert.ok(state.lastPassAt > anchor, 'lastPassAt 确实被那次放行推进了(对照)');

  // 到点后照常提醒(证明钟没被推后)
  fx.writeState({ lastDraftReminderAt: Date.now() - 25 * 3_600_000 });
  assert.equal(JSON.parse((await fx.run(['--json'])).stdout).reason, 'draft-reminder');
});

test('draft-reminder 轮不刷新 lastChangedAt(否则复提醒会把 cadence 自己拉回高频)', async (t) => {
  const fx = createFixture(t);
  fx.setSnapshot(draftSnapshot());
  await fx.run();
  await fx.run(['--ack']);

  const quietSince = Date.now() - 4 * 86_400_000;
  fx.writeState({
    lastChangedAt: quietSince,
    lastDraftReminderAt: Date.now() - 25 * 3_600_000,
  });
  assert.equal(JSON.parse((await fx.run(['--json'])).stdout).reason, 'draft-reminder');
  assert.equal(fx.readState().lastChangedAt, quietSince, '复提醒不是真实变化,不该刷新锚点');
});

test('草稿期间 cadence 有下限 —— 否则 1d 轮询兑现不了 24h 复提醒', () => {
  const now = Date.now();
  // 安静 4 天:非草稿该降到 1d
  const quiet = { lastChangedAt: now - 4 * 86_400_000, fingerprint: 'fp' };
  assert.equal(suggestCadence({ ...quiet, wasDraft: false }, now).label, '1d');

  // 同样安静时长,但还停在草稿 → 默认 24h 闸门下钉在 8h
  const drafted = suggestCadence({ ...quiet, wasDraft: true }, now);
  assert.equal(drafted.reason, 'draft-floor');
  assert.equal(drafted.label, '8h');
  assert.equal(drafted.intervalMs, 8 * 3_600_000);

  // 比下限更细的档位不受影响(粒度已经够细)
  const recent = suggestCadence(
    { fingerprint: 'fp', wasDraft: true, lastChangedAt: now - 20 * 60_000 },
    now,
  );
  assert.equal(recent.reason, 'quiet');
  assert.equal(recent.label, '10m');
});

test('下限由闸门推导,不是写死的 8h —— 短闸门必须配更细的轮询', () => {
  const now = Date.now();
  const quiet = { lastChangedAt: now - 4 * 86_400_000, fingerprint: 'fp', wasDraft: true };

  // 每个闸门都要满足「轮询间隔 ≤ 闸门的一半」,否则最坏延迟会超过闸门的 1.5 倍
  for (const hours of [24, 12, 8, 4, 2, 1]) {
    const gate = hours * 3_600_000;
    const c = suggestCadence(quiet, now, gate);
    assert.ok(
      c.intervalMs <= gate / 2,
      `闸门 ${hours}h 时轮询间隔应 ≤ ${hours / 2}h,实际 ${c.label}`,
    );
  }

  // 具体档位:2h 闸门 → 1h(不再是 8h)
  assert.equal(suggestCadence(quiet, now, 2 * 3_600_000).label, '1h');
  // 1h 闸门 → 10m
  assert.equal(suggestCadence(quiet, now, 3_600_000).label, '10m');
  // 闸门短于最细档的两倍时只能给最细档(阶梯粒度的下限,不是缺陷)
  assert.equal(suggestCadence(quiet, now, 5 * 60_000).label, '10m');

  // 闸门关闭 → 没有要兑现的承诺,不设下限,阶梯自由降到 1d
  const off = suggestCadence(quiet, now, 0);
  assert.equal(off.reason, 'quiet');
  assert.equal(off.label, '1d');
});

test('--draft-reminder-hours 会传进 cadence 建议(不只影响放行判定)', async (t) => {
  const fx = createFixture(t);
  fx.setSnapshot(draftSnapshot());
  await fx.run();
  fx.writeState({ lastChangedAt: Date.now() - 4 * 86_400_000 });

  const acked = await fx.run(['--ack', '--draft-reminder-hours', '2', '--json']);
  assert.equal(JSON.parse(acked.stdout).cadence.label, '1h', '2h 闸门要配 1h 轮询');

  const suggested = await fx.run(['--suggest', '--draft-reminder-hours', '2', '--json']);
  assert.equal(JSON.parse(suggested.stdout).cadence.label, '1h');
});

test('闸门跨命令共享:普通轮落进 state,--ack / --suggest 不带参数也用同一个', async (t) => {
  const fx = createFixture(t);
  fx.setSnapshot(draftSnapshot());

  // 普通 gate 轮(参数写在 preRunHook.command 里)是权威来源
  await fx.run(['--draft-reminder-hours', '2']);
  assert.equal(fx.readState().draftReminderMs, 2 * 3_600_000, '生效闸门要落进 state');
  await fx.run(['--ack']); // 清掉首轮 pending,否则 cadence 恒命中 unacked 档

  fx.writeState({ lastChangedAt: Date.now() - 4 * 86_400_000 });

  // 这两条命令按 skill 里的写法只带 PR URL —— 必须继承 2h 而不是回落默认 24h,
  // 否则会建议 8h,把短闸门顶掉(相位问题复发)
  assert.equal(
    JSON.parse((await fx.run(['--suggest', '--json'])).stdout).cadence.label,
    '1h',
    '--suggest 不带参数应从 state 继承闸门',
  );
  assert.equal(
    JSON.parse((await fx.run(['--ack', '--json'])).stdout).cadence.label,
    '1h',
    '--ack 不带参数应从 state 继承闸门',
  );

  // 显式传参仍然优先
  assert.equal(
    JSON.parse((await fx.run(['--suggest', '--draft-reminder-hours', '24', '--json'])).stdout)
      .cadence.label,
    '8h',
  );

  // 普通轮改回默认后,state 里的闸门跟着回到 24h(权威来源是普通轮,不是历史残留)
  await fx.run();
  assert.equal(fx.readState().draftReminderMs, 24 * 3_600_000);
  assert.equal(JSON.parse((await fx.run(['--suggest', '--json'])).stdout).cadence.label, '8h');
});

test('快照失败轮也落盘闸门 —— 闸门取自命令行,与快照成不成功无关', async (t) => {
  const fx = createFixture(t);
  fx.setSnapshot(draftSnapshot());
  await fx.run();
  await fx.run(['--ack']);
  assert.equal(fx.readState().draftReminderMs, 24 * 3_600_000);

  // 把闸门改短,但这一轮快照失败(gh 掉线之类)
  const failed = await fx.run(['--draft-reminder-hours', '2'], { FAKE_SNAPSHOT_EXIT: '2' });
  assert.equal(failed.code, 2, '瞬时失败应跳过而非 fail-closed');
  assert.equal(
    fx.readState().draftReminderMs,
    2 * 3_600_000,
    '新闸门必须已落盘,否则 --ack / --suggest 会继续按旧的 24h 建议档位',
  );

  fx.writeState({ lastChangedAt: Date.now() - 4 * 86_400_000 });
  assert.equal(JSON.parse((await fx.run(['--suggest', '--json'])).stdout).cadence.label, '1h');
});

test('闸门 0 能跨命令共享,不被当成「没配」', async (t) => {
  const fx = createFixture(t);
  fx.setSnapshot(draftSnapshot());
  await fx.run(['--draft-reminder-hours', '0']);
  assert.equal(fx.readState().draftReminderMs, 0);
  await fx.run(['--ack']);

  fx.writeState({ lastChangedAt: Date.now() - 4 * 86_400_000 });
  // 关闭复提醒 → 没有要兑现的闸门 → 不设下限,阶梯自由降到 1d
  const c = JSON.parse((await fx.run(['--suggest', '--json'])).stdout).cadence;
  assert.equal(c.reason, 'quiet');
  assert.equal(c.label, '1d');
});

test('草稿 8h 下限让每日提醒不会退化成近两天(端到端复现相位问题)', async (t) => {
  const fx = createFixture(t);
  fx.setSnapshot(draftSnapshot());
  await fx.run();
  await fx.run(['--ack']);

  // 长期安静的草稿:档位被钉在 8h,于是 24h 闸门最多晚 8 小时兑现,
  // 而不是等到下一个完整的 1d 周期(≈47h)。
  fx.writeState({ lastChangedAt: Date.now() - 5 * 86_400_000 });
  const cadence = suggestCadence(fx.readState());
  assert.ok(
    cadence.intervalMs <= 8 * 3_600_000,
    `轮询间隔必须比 24h 闸门细,实际 ${cadence.intervalMs}`,
  );

  // 闸门到点那一轮照常提醒
  fx.writeState({ lastDraftReminderAt: Date.now() - 25 * 3_600_000 });
  assert.equal(JSON.parse((await fx.run(['--json'])).stdout).reason, 'draft-reminder');
});

test('draft-entered 是真实变化,cadence 回弹到 10m', async (t) => {
  const fx = createFixture(t);
  fx.setSnapshot(baseSnapshot());
  await fx.run();
  await fx.run(['--ack']);
  fx.writeState({ lastChangedAt: Date.now() - 4 * 86_400_000 });

  fx.setSnapshot(draftSnapshot());
  await fx.run();
  const acked = await fx.run(['--ack', '--json']);
  const cadence = JSON.parse(acked.stdout).cadence;
  assert.equal(cadence.label, '10m', '刚被设成草稿要立刻回到高频');
});

test('--draft-reminder-hours 可调,0 表示关闭', async (t) => {
  const fx = createFixture(t);
  fx.setSnapshot(draftSnapshot());
  await fx.run();
  await fx.run(['--ack']);
  fx.writeState({ lastDraftReminderAt: Date.now() - 3 * 3_600_000 });

  // 默认 24h 下还不到点
  assert.equal((await fx.run()).code, 2);
  // 调成 2h 就到点了
  assert.equal(
    JSON.parse((await fx.run(['--draft-reminder-hours', '2', '--json'])).stdout).reason,
    'draft-reminder',
  );

  // 关闭后即使拖很久也不提醒(把保底巡检一并推远,单独验关闭语义)
  fx.writeState({ lastDraftReminderAt: Date.now() - 100 * 3_600_000, lastPassAt: Date.now() });
  assert.equal((await fx.run(['--draft-reminder-hours', '0'])).code, 2);
});

test('--draft-reminder-hours 负数是确定性配置错误,fail-closed', async (t) => {
  const fx = createFixture(t);
  fx.setSnapshot(draftSnapshot());
  const r = await fx.run(['--draft-reminder-hours', '-1']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--draft-reminder-hours/);
});

// ── work-pending 退避(端到端) ────────────────────────────────────────────────

test('gate 集成:无变化的 NEEDS_WORK 连续唤起 2 轮后转入退避,真实变化穿透恢复', async (t) => {
  const fx = createFixture(t);
  const stuck = () =>
    baseSnapshot({
      verdict: 'NEEDS_WORK',
      blockers: ['ci_failing'],
      checksSummary: {
        ...baseSnapshot().checksSummary,
        failed: 1,
        failingRuns: [{ name: 'code-review', status: 'COMPLETED', conclusion: 'FAILURE' }],
      },
    });

  fx.setSnapshot(stuck());
  let r = await fx.run(['--json']);
  assert.equal(JSON.parse(r.stdout).reason, 'first-round');
  await fx.run(['--ack']);

  // 确认后同一状态:快速唤起额度 2 轮
  r = await fx.run(['--json']);
  let out = JSON.parse(r.stdout);
  assert.equal(out.reason, 'work-pending');
  assert.match(out.detail, /attempt=1\/2/);
  r = await fx.run(['--json']);
  assert.equal(JSON.parse(r.stdout).reason, 'work-pending');

  // 额度用尽:退避跳过,零 token
  r = await fx.run(['--json']);
  assert.equal(JSON.parse(r.stdout).reason, 'work-pending-backoff');
  assert.equal(r.code, 2, '退避轮必须跳过');

  // 闸门到点:退避唤起一次,并重新立好下一个闸门
  fx.writeState({ workPendingBackoffUntil: Date.now() - 1 });
  r = await fx.run(['--json']);
  assert.equal(JSON.parse(r.stdout).reason, 'work-pending-backoff-attempt');
  assert.equal(r.code, 0);
  r = await fx.run(['--json']);
  assert.equal(JSON.parse(r.stdout).reason, 'work-pending-backoff', '退避唤起后闸门重新立起');

  // 真实变化(新评论)立即穿透,计数随状态变化归零
  fx.setSnapshot({
    ...stuck(),
    comments: [
      { id: 'IC1', updatedAt: '2026-07-28T09:45:00Z' },
      { id: 'IC9', updatedAt: '2026-07-28T13:00:00Z' },
    ],
  });
  r = await fx.run(['--json']);
  assert.equal(JSON.parse(r.stdout).reason, 'changed', '真实变化必须穿透退避');
  await fx.run(['--ack']);
  r = await fx.run(['--json']);
  out = JSON.parse(r.stdout);
  assert.equal(out.reason, 'work-pending', '新状态重新获得快速唤起额度');
  assert.match(out.detail, /attempt=1\/2/);
});

test('gate 集成:红 CI 时 base HEAD 前进会穿透 work-pending 退避与显式 defer', async (t) => {
  const fx = createFixture(t);
  const red = (baseCommitOid) =>
    baseSnapshot({
      baseCommitOid,
      verdict: 'NEEDS_WORK',
      blockers: ['ci_failing'],
      checksSummary: {
        ...baseSnapshot().checksSummary,
        failed: 1,
        failingRuns: [{ name: 'client-ci', status: 'COMPLETED', conclusion: 'FAILURE' }],
      },
    });

  fx.setSnapshot(red('base-a'));
  await fx.run();
  await fx.run(['--ack']);
  await fx.run();
  await fx.run();
  assert.equal(JSON.parse((await fx.run(['--json'])).stdout).reason, 'work-pending-backoff');

  fx.setSnapshot(red('base-b'));
  let out = JSON.parse((await fx.run(['--json'])).stdout);
  assert.equal(out.reason, 'changed', 'main 修好后必须立刻叫醒 agent');
  assert.match(out.detail, /changedFields=\[ciFailingBaseCommitOid\]/);
  await fx.run(['--defer', '240']);

  fx.setSnapshot(red('base-c'));
  out = JSON.parse((await fx.run(['--json'])).stdout);
  assert.equal(out.reason, 'changed', '新的 base 变化也必须穿透 agent 显式 defer');
  assert.match(out.detail, /changedFields=\[ciFailingBaseCommitOid\]/);
});

// ── 空放行不消耗额度(宿主顺延 / spawn 失败) ─────────────────────────────────

test('decide:距上次放行不足最小间隔时照常放行,但不累加未确认重试计数', () => {
  const snap = baseSnapshot({ verdict: 'NEEDS_WORK', blockers: ['unresolved_review_threads'] });
  const fp = fingerprint(snap);
  const now = Date.now();
  const previous = {
    // confirmed 与 current 不同 → 走 passPending
    fingerprint: 'old',
    pendingFingerprint: fp,
    pendingPassCount: 1,
    currentFingerprint: fp,
  };

  // 90 秒前刚放行过(宿主顺延后立刻重敲门):放行,计数不动
  const empty = decide({ snap, previous: { ...previous, lastPassAt: now - 90_000 }, now });
  assert.equal(empty.exitCode, 0, '空放行必须仍然放行 —— agent 确实还没跑');
  assert.equal(empty.nextPendingCount, 1, '空放行不该消耗额度');
  assert.match(empty.detail, /not counted/, 'detail 要点明为什么计数没动');

  // 11 分钟前放行过(正常心跳节奏):计数照常前进
  const real = decide({ snap, previous: { ...previous, lastPassAt: now - 11 * 60_000 }, now });
  assert.equal(real.exitCode, 0);
  assert.equal(real.nextPendingCount, 2, '真实一轮之后必须计数');

  // 显式关闭判据 → 回到旧行为
  const disabled = decide({
    snap,
    previous: { ...previous, lastPassAt: now - 90_000 },
    now,
    minPassSpacingMs: 0,
  });
  assert.equal(disabled.nextPendingCount, 2);
});

test('decide:work-pending 的连续唤起额度同样不被空放行消耗', () => {
  const snap = baseSnapshot({ verdict: 'NEEDS_WORK', blockers: ['ci_failing'] });
  const fp = fingerprint(snap);
  const now = Date.now();
  // current === confirmed(已 ack 过)→ 走 work-pending 分支
  const previous = {
    fingerprint: fp,
    currentFingerprint: fp,
    workPendingFingerprint: fp,
    workPendingPassCount: 1,
  };

  const empty = decide({ snap, previous: { ...previous, lastPassAt: now - 90_000 }, now });
  assert.equal(empty.reason, 'work-pending');
  assert.equal(empty.nextWorkPendingCount, 1, '空放行不推进 work-pending 计数');
  assert.equal(empty.nextWorkPendingBackoffUntil, undefined, '不该被空放行提前立起退避闸门');

  const real = decide({ snap, previous: { ...previous, lastPassAt: now - 11 * 60_000 }, now });
  assert.equal(real.nextWorkPendingCount, 2);
  assert.ok(real.nextWorkPendingBackoffUntil > now, '真实第 2 轮才立退避闸门');
});

test('gate 集成:宿主连续顺延(放行了但 agent 没跑)不会把 PR 压进退避', async (t) => {
  const fx = createFixture(t);
  fx.setSnapshot(baseSnapshot({ verdict: 'NEEDS_WORK', blockers: ['unresolved_review_threads'] }));

  // 第一轮:建档放行(默认间隔判据生效,不传 --min-pass-spacing-minutes 0)
  let r = await fx.run(['--json', '--min-pass-spacing-minutes', '5']);
  assert.equal(JSON.parse(r.stdout).reason, 'first-round');
  assert.equal(r.code, 0);

  // 复刻 2026-08-01 的实测:宿主 user-active 顺延,每 90 秒重敲一次门,agent 一次没起来。
  // 旧行为在第 4 次就 armed 4 小时退避;现在应当每次都放行且额度不动。
  for (let i = 0; i < 5; i++) {
    r = await fx.run(['--json', '--min-pass-spacing-minutes', '5']);
    const out = JSON.parse(r.stdout);
    assert.equal(r.code, 0, `第 ${i + 1} 次空放行必须仍放行`);
    assert.match(out.detail, /not counted/);
    assert.equal(fx.readState().pendingPassCount, 1, '空放行不消耗额度');
    assert.equal(fx.readState().retryBackoffUntil, undefined, '不该 armed 退避');
  }

  // 把上次放行时间拨回 11 分钟前 = 真的过了一轮心跳,计数才前进
  fx.writeState({ lastPassAt: Date.now() - 11 * 60_000 });
  r = await fx.run(['--json', '--min-pass-spacing-minutes', '5']);
  assert.match(JSON.parse(r.stdout).detail, /attempt=2\/3/);
});

test('lastPassAt 在跳过轮次也要存活(保底巡检与空放行判据都靠它)', async (t) => {
  const fx = createFixture(t);
  fx.setSnapshot(baseSnapshot());
  await fx.run();
  await fx.run(['--ack']);
  const passedAt = fx.readState().lastPassAt;
  assert.ok(passedAt > 0);

  // 无变化的 READY → idle 跳过;整对象替换不能把 lastPassAt 丢掉
  const r = await fx.run(['--json']);
  assert.equal(JSON.parse(r.stdout).reason, 'idle');
  assert.equal(fx.readState().lastPassAt, passedAt, '跳过轮必须原样带下去');
});

// ── 机判提示(回合止损 / 临门一脚 / 无底洞) ─────────────────────────────────

test('passAdvisories:回合数每轮报数,过检查点/硬止损线时给行动指令', () => {
  const snap = baseSnapshot({ verdict: 'NEEDS_WORK', blockers: ['unresolved_review_threads'] });
  assert.deepEqual(passAdvisories(snap, 3), ['round=3']);
  const checkpoint = passAdvisories(snap, 5);
  assert.equal(checkpoint.length, 1);
  assert.match(checkpoint[0], /round=5 ⚠️ past the convergence checkpoint/);
  const hard = passAdvisories(snap, 25);
  assert.match(hard[0], /round=25 ⚠️ convergence mode/);
  assert.match(hard[0], /not a stop condition.*stop patching comment by comment.*land one verifiable fix/);
  assert.doesNotMatch(hard[0], /必须同时挂 🔴/, '技术收敛不应被误解成停止并等待人工');
});

test('passAdvisories:只剩人类 blocker 且 thread 将尽时提示临门一脚,有硬活时不提示', () => {
  const nearMerge = baseSnapshot({
    verdict: 'NEEDS_WORK',
    blockers: ['unresolved_review_threads', 'branch_protection_blocked'],
    reviewThreads: { ...baseSnapshot().reviewThreads, unresolvedCount: 2 },
  });
  const notes = passAdvisories(nearMerge, 3);
  assert.equal(notes.length, 2);
  assert.match(notes[1], /almost there.*branch_protection_blocked.*do not widen the fix just to find work/);
  assert.match(notes[1], /wait \*\*silently\*\*.*do not notify/, '等 approve/合并不通知用户');
  assert.doesNotMatch(notes[1], /ask the user to approve/);

  // CI 还红着:agent 手上有硬活,不提示
  const ciRed = passAdvisories(
    { ...nearMerge, blockers: [...nearMerge.blockers, 'ci_failing'] },
    3,
  );
  assert.equal(ciRed.length, 1, 'ci_failing 在场时不该提示临门一脚');

  // thread 还有一堆:活没将尽,不提示
  const manyThreads = passAdvisories(
    {
      ...nearMerge,
      reviewThreads: { ...nearMerge.reviewThreads, unresolvedCount: 9 },
    },
    3,
  );
  assert.equal(manyThreads.length, 1);
});

test('passAdvisories:单文件 thread 累计超阈值时点名无底洞', () => {
  const mkThread = (i, p) => ({
    id: `T${i}`,
    path: p,
    isResolved: i % 2 === 0,
    isOutdated: false,
    comments: [{ id: `C${i}`, updatedAt: '2026-07-28T09:00:00Z' }],
  });
  const hot = baseSnapshot({
    verdict: 'NEEDS_WORK',
    blockers: ['unresolved_review_threads'],
    reviewThreads: {
      ...baseSnapshot().reviewThreads,
      unresolvedCount: 4,
      nodes: [
        ...Array.from({ length: 8 }, (_, i) => mkThread(i, 'src/pricing/quote.ts')),
        mkThread(99, 'src/other.ts'),
      ],
    },
  });
  const notes = passAdvisories(hot, 2);
  assert.equal(notes.length, 2);
  assert.match(notes[1], /hotspot: src\/pricing\/quote\.ts has accumulated 8 review threads/);

  // 7 条不到阈值:不提示
  const warm = passAdvisories(
    {
      ...hot,
      reviewThreads: {
        ...hot.reviewThreads,
        nodes: Array.from({ length: 7 }, (_, i) => mkThread(i, 'src/a.ts')),
      },
    },
    2,
  );
  assert.equal(warm.length, 1);
});

test('passAdvisories:diff 相比建档基线显著膨胀时提示范围膨胀,小幅增长不提示', () => {
  const snap = baseSnapshot({
    verdict: 'NEEDS_WORK',
    blockers: ['unresolved_review_threads'],
    additions: 2400,
  });
  const notes = passAdvisories(snap, 3, { initialAdditions: 1100 });
  assert.equal(notes.length, 2);
  assert.match(notes[1], /scope growth: the diff grew from \+1100 to \+2400 lines/);
  assert.match(notes[1], /autonomous technical convergence, not splitting the PR, needs no user confirmation/);
  assert.match(notes[1], /must not be parked behind --ack waiting for "scope confirmation"/);
  assert.match(notes[1], /decide to keep or add complex machinery.*ask the user first/);

  // 增量不足 300 行:正常补测试的幅度,不提示
  const small = passAdvisories({ ...snap, additions: 1350 }, 3, { initialAdditions: 1100 });
  assert.equal(small.length, 1);
  // 倍率不足 1.5x:大 PR 的正常演进,不提示
  const bigBase = passAdvisories({ ...snap, additions: 2400 }, 3, { initialAdditions: 2000 });
  assert.equal(bigBase.length, 1);
  // 无基线(旧状态文件/快照缺字段):不提示
  const noBase = passAdvisories(snap, 3, {});
  assert.equal(noBase.length, 1);
});

test('decide:退避周期连续无进展达到阈值时,detail 要求通知用户', () => {
  const snap = baseSnapshot({ verdict: 'NEEDS_WORK', blockers: ['ci_failing'] });
  const fp = fingerprint(snap);
  const now = Date.now();
  // work-pending 卡死:2 轮快速额度 + 已 4 个退避周期,闸门到点
  const wpStuck = decide({
    snap,
    previous: {
      fingerprint: fp,
      currentFingerprint: fp,
      workPendingFingerprint: fp,
      workPendingPassCount: 5,
      workPendingBackoffUntil: now - 1,
      lastPassAt: now - 11 * 60_000,
    },
    now,
  });
  assert.equal(wpStuck.reason, 'work-pending-backoff-attempt');
  assert.match(wpStuck.detail, /stuck for 4 backoff cycles.*notify the user/);

  // 未到阈值(第 1 个退避周期):不通报
  const wpEarly = decide({
    snap,
    previous: {
      fingerprint: fp,
      currentFingerprint: fp,
      workPendingFingerprint: fp,
      workPendingPassCount: 2,
      workPendingBackoffUntil: now - 1,
      lastPassAt: now - 11 * 60_000,
    },
    now,
  });
  assert.equal(wpEarly.reason, 'work-pending-backoff-attempt');
  assert.doesNotMatch(wpEarly.detail, /notify the user/);

  // 未确认变化的退避重试同理:3 轮快速 + 3 个周期起通报
  const retryStuck = decide({
    snap: baseSnapshot({ verdict: 'READY' }),
    previous: {
      fingerprint: 'old',
      pendingFingerprint: fingerprint(baseSnapshot({ verdict: 'READY' })),
      pendingPassCount: 5,
      currentFingerprint: fingerprint(baseSnapshot({ verdict: 'READY' })),
      retryBackoffUntil: now - 1,
      lastPassAt: now - 11 * 60_000,
    },
    now,
  });
  assert.equal(retryStuck.reason, 'retry-backoff-attempt');
  assert.match(retryStuck.detail, /unacknowledged for 3 backoff cycles.*notify the user/);
});

test('gate 集成:范围膨胀基线在首轮锚定并跨轮存活,膨胀后放行 detail 点名', async (t) => {
  const fx = createFixture(t);
  fx.setSnapshot(
    baseSnapshot({ verdict: 'NEEDS_WORK', blockers: ['unresolved_review_threads'], additions: 900 }),
  );
  await fx.run(['--json']);
  assert.equal(fx.readState().initialAdditions, 900, '首轮锚定基线');
  await fx.run(['--ack']);

  // 无变化轮(work-pending)也不该丢基线
  await fx.run(['--json']);
  assert.equal(fx.readState().initialAdditions, 900, '基线跨轮存活');

  // 新一轮 push 后 diff 膨胀到 2.6 倍
  fx.setSnapshot(
    baseSnapshot({
      verdict: 'NEEDS_WORK',
      blockers: ['unresolved_review_threads'],
      additions: 2400,
      latestCommitOid: 'bbb222',
      updatedAt: '2026-07-28T12:00:00Z',
    }),
  );
  const r = await fx.run(['--json']);
  const out = JSON.parse(r.stdout);
  assert.equal(out.reason, 'changed');
  assert.match(out.detail, /scope growth: the diff grew from \+900 to \+2400 lines/);
  assert.equal(fx.readState().initialAdditions, 900, '膨胀不改基线');
});

test('gate 集成:范围膨胀形状在 changed 与 work-pending 轮持续要求自主收缩,仍保留退避止损', async (t) => {
  const fx = createFixture(t);
  const blockers = ['unresolved_review_threads', 'merge_conflict'];

  fx.setSnapshot(baseSnapshot({ verdict: 'NEEDS_WORK', blockers, additions: 473 }));
  await fx.run(['--json']);
  await fx.run(['--ack']);

  fx.setSnapshot(
    baseSnapshot({
      verdict: 'NEEDS_WORK',
      blockers,
      additions: 18_838,
      latestCommitOid: 'bbb222',
      updatedAt: '2026-08-05T00:38:58Z',
    }),
  );
  let r = await fx.run(['--json']);
  let out = JSON.parse(r.stdout);
  assert.equal(out.reason, 'changed');
  assert.match(out.detail, /needs no user confirmation, and must not be parked behind --ack waiting for "scope confirmation"/);
  await fx.run(['--ack']);

  for (const attempt of [1, 2]) {
    r = await fx.run(['--json']);
    out = JSON.parse(r.stdout);
    assert.equal(out.reason, 'work-pending');
    assert.match(out.detail, new RegExp(`attempt=${attempt}/2`));
    assert.match(out.detail, /agent-owned blocker=merge_conflict,unresolved_review_threads/);
    assert.match(out.detail, /shrinking back to the original goal.*needs no user confirmation/);
  }

  r = await fx.run(['--json']);
  out = JSON.parse(r.stdout);
  assert.equal(out.reason, 'work-pending-backoff');
  assert.equal(r.code, 2);
  assert.match(out.detail, /Backoff limits cost; it does not mean "no work"/);
});

test('gate 集成:中途建档的老 PR 从 reviews 播种回合数,首轮就把硬止损喊出来', async (t) => {
  const fx = createFixture(t);
  // 12 个不同 commit 的 review = 至少 12 轮(一夜 25 轮的 PR 中途挂 gate 时,
  // 不能从第 1 轮起数、让止损线永远够不到)
  fx.setSnapshot(
    baseSnapshot({
      verdict: 'NEEDS_WORK',
      blockers: ['unresolved_review_threads'],
      reviews: Array.from({ length: 12 }, (_, i) => ({
        id: `R${i}`,
        state: 'COMMENTED',
        author: 'greptile-apps',
        commitOid: `oid${i}`,
        submittedAt: '2026-07-28T09:30:00Z',
      })),
    }),
  );
  const r = await fx.run(['--json']);
  const out = JSON.parse(r.stdout);
  assert.equal(out.reason, 'first-round');
  assert.match(out.detail, /round=12 ⚠️ convergence mode/);
  assert.equal(fx.readState().roundCount, 12);

  const result = JSON.parse((await fx.run(['--last-result', '--json'])).stdout).lastResult;
  assert.equal(result.decision, 'run');
  assert.equal(result.reason, 'first-round');
  assert.match(result.detail, /round=12 ⚠️ convergence mode/);
  assert.match(result.detail, /land one verifiable fix/);
});

test('gate 集成:终态(merged)轮不掺机判提示', async (t) => {
  const fx = createFixture(t);
  fx.setSnapshot(baseSnapshot({ merged: true, verdict: 'MERGED_CLEANUP_READY' }));
  const r = await fx.run(['--json']);
  const out = JSON.parse(r.stdout);
  assert.equal(out.exitCode, 0);
  assert.doesNotMatch(out.detail, /round=/, '收口轮该只有收口指令');
});

// ── 合并态抖动(端到端) ──────────────────────────────────────────────────────

test('gate 集成:合并态重算的抖动轮与恢复轮都跳过,真实变化仍放行并指出变化字段', async (t) => {
  const fx = createFixture(t);
  const stable = () =>
    baseSnapshot({
      verdict: 'BLOCKED_HUMAN',
      blockers: ['branch_protection_blocked', 'approval_required'],
      mergeable: true,
      mergeStateStatus: 'BLOCKED',
      mergeableState: 'blocked',
    });

  fx.setSnapshot(stable());
  await fx.run(); // first-round 建基线
  await fx.run(['--ack']);

  // GitHub 重算窗口:合并态字段成组抖成 UNKNOWN(实测形状)→ 必须跳过
  fx.setSnapshot(
    baseSnapshot({
      verdict: 'WAITING_CI',
      blockers: ['mergeability_pending', 'approval_required'],
      mergeable: null,
      mergeStateStatus: 'UNKNOWN',
      mergeableState: 'unknown',
    }),
  );
  let r = await fx.run(['--json']);
  assert.equal(JSON.parse(r.stdout).reason, 'idle', '抖动轮不得唤起');
  assert.equal(r.code, 2);

  // 恢复轮同样跳过(修复前这里是成对唤起的第二次)
  fx.setSnapshot(stable());
  r = await fx.run(['--json']);
  assert.equal(JSON.parse(r.stdout).reason, 'idle', '恢复轮不得唤起');

  // 真实变化(新评论)仍放行,且 detail 指出变化字段
  fx.setSnapshot({
    ...stable(),
    comments: [
      { id: 'IC1', updatedAt: '2026-07-28T09:45:00Z' },
      { id: 'IC2', updatedAt: '2026-07-28T12:00:00Z' },
    ],
  });
  r = await fx.run(['--json']);
  const out = JSON.parse(r.stdout);
  assert.equal(out.reason, 'changed');
  assert.match(out.detail, /changedFields=\[comments\]/, '诊断应精确指出变化字段');
});

// ── 回合状态(per-head):roundCount / reviewersSeen / deferredHeadOid ──────────

test('回合状态:首轮建档,同 head 累积 reviewer,换 head 进新回合并清等待额度', async (t) => {
  const fx = createFixture(t);

  // 首轮:建 head 档,roundCount=1,记下已见 reviewer
  fx.setSnapshot(
    baseSnapshot({
      latestCommitOid: 'head1',
      reviews: [{ id: 'R1', author: 'greptile-apps', state: 'COMMENTED', submittedAt: '2026-07-28T09:30:00Z' }],
    }),
  );
  await fx.run();
  let st = fx.readState();
  assert.equal(st.headOid, 'head1');
  assert.equal(st.roundCount, 1);
  assert.deepEqual(st.reviewersSeen, ['greptile-apps']);
  assert.equal(st.deferredHeadOid, undefined, '没 defer 过就不该有等待标记');

  // --defer 登记「head1 已用掉一次等待额度」
  await fx.run(['--defer', '15']);
  st = fx.readState();
  assert.equal(st.deferredHeadOid, 'head1');

  // 同 head 的穿透放行(指纹变化,如 CI 翻转 / 新 review):等待标记必须存活,
  // worker 靠它知道"这轮已经等过了",不再二次 defer
  fx.setSnapshot(
    baseSnapshot({
      latestCommitOid: 'head1',
      updatedAt: '2026-07-28T11:00:00Z',
      reviews: [
        { id: 'R1', author: 'greptile-apps', state: 'COMMENTED', submittedAt: '2026-07-28T09:30:00Z' },
        { id: 'R2', author: 'copilot-pull-request-reviewer', state: 'COMMENTED', submittedAt: '2026-07-28T10:55:00Z' },
      ],
    }),
  );
  let r = await fx.run(['--json']);
  assert.equal(JSON.parse(r.stdout).reason, 'changed', '前置条件:这一轮确实是穿透放行');
  st = fx.readState();
  assert.equal(st.deferredHeadOid, 'head1', '穿透放行不得清掉等待标记');
  assert.equal(st.roundCount, 1, '同 head 不算新回合');
  assert.deepEqual(st.reviewersSeen, ['copilot-pull-request-reviewer', 'greptile-apps'], 'reviewer 全集应累积');

  // 换 head(新 push)= 新回合:roundCount+1,等待额度重置
  await fx.run(['--ack']);
  fx.setSnapshot(
    baseSnapshot({
      latestCommitOid: 'head2',
      updatedAt: '2026-07-28T12:00:00Z',
      // reviews 窗口哪怕被挤到只剩新条目,reviewersSeen 也不回退 —— 这是它存在的意义
      reviews: [{ id: 'R3', author: 'copilot-pull-request-reviewer', state: 'COMMENTED', submittedAt: '2026-07-28T11:58:00Z' }],
    }),
  );
  await fx.run();
  st = fx.readState();
  assert.equal(st.headOid, 'head2');
  assert.equal(st.roundCount, 2);
  assert.equal(st.deferredHeadOid, undefined, '新回合的等待额度必须重置');
  assert.deepEqual(st.reviewersSeen, ['copilot-pull-request-reviewer', 'greptile-apps'], '窗口截断不缩小已见集合');
});

test('回合状态:中途建档用可见 review 窗口播种 roundCount,不从 1 起数', async (t) => {
  const fx = createFixture(t);

  // 一个已经历多轮的 PR 中途挂 gate:reviews 覆盖 3 个不同的历史 commit
  fx.setSnapshot(
    baseSnapshot({
      latestCommitOid: 'head3',
      reviews: [
        { id: 'R1', author: 'greptile-apps', state: 'COMMENTED', submittedAt: '2026-07-28T08:00:00Z', commitOid: 'head1' },
        { id: 'R2', author: 'greptile-apps', state: 'COMMENTED', submittedAt: '2026-07-28T09:00:00Z', commitOid: 'head2' },
        { id: 'R3', author: 'dashhuang', state: 'COMMENTED', submittedAt: '2026-07-28T09:10:00Z', commitOid: 'head2' },
        { id: 'R4', author: 'greptile-apps', state: 'COMMENTED', submittedAt: '2026-07-28T10:00:00Z', commitOid: 'head3' },
      ],
    }),
  );
  await fx.run();
  let st = fx.readState();
  assert.equal(st.roundCount, 3, '播种值 = 可见窗口里不同的 review 目标 commit 数');

  // 播种后继续按 head 变化单调累加
  await fx.run(['--ack']);
  fx.setSnapshot(baseSnapshot({ latestCommitOid: 'head4', updatedAt: '2026-07-28T13:00:00Z' }));
  await fx.run();
  st = fx.readState();
  assert.equal(st.roundCount, 4);
});

test('cadenceThrottle:安静越久查得越稀,最细档与无历史时从不节流', () => {
  const now = Date.parse('2026-10-12T12:00:00Z');
  const hour = 3_600_000;
  assert.equal(cadenceThrottle(null, now), null, '无状态必须照常查');
  assert.equal(cadenceThrottle({ verdict: 'READY' }, now), null, '没有成功检查过就没有计时起点');

  // 安静 3 小时 → 4h 档:上次检查 1 小时前,跳过;上次检查约 4 小时前,照常查
  const quiet = { verdict: 'READY', lastChangedAt: now - 3 * hour };
  const held = cadenceThrottle({ ...quiet, lastCheckedAt: now - hour }, now);
  assert.equal(held?.cadence.label, '4h');
  assert.ok(held.nextCheckAt > now);
  assert.equal(cadenceThrottle({ ...quiet, lastCheckedAt: now - 4 * hour + 60_000 }, now), null, '容差内按到点处理');

  // 这些状态钉在 10m 档:有未确认变化 / 还有活 / defer / 刚变化,都不节流
  for (const state of [
    { ...quiet, lastCheckedAt: now - 60_000, pendingFingerprint: 'x' },
    { ...quiet, lastCheckedAt: now - 60_000, verdict: 'NEEDS_WORK' },
    { ...quiet, lastCheckedAt: now - 60_000, nextAllowAt: now + hour },
    { verdict: 'READY', lastChangedAt: now - 60_000, lastCheckedAt: now - 60_000 },
  ]) {
    assert.equal(cadenceThrottle(state, now), null, JSON.stringify(state));
  }
});

test('gate 集成:节流轮不调快照、记 cadence-throttle;到点后照常查', async (t) => {
  const fx = createFixture(t);
  fx.setSnapshot(baseSnapshot());
  assert.equal((await fx.run([WITH_THROTTLE])).code, 0, '首轮放行');
  assert.equal((await fx.run(['--ack'])).code, 0);

  const hour = 3_600_000;
  const now = Date.now();
  fx.writeState({ lastChangedAt: now - 3 * hour, lastCheckedAt: now - hour });
  // 快照若被调用就会失败;节流轮必须根本不碰它
  const held = await fx.run([WITH_THROTTLE, '--json'], { FAKE_SNAPSHOT_EXIT: '1' });
  assert.equal(held.code, 2, held.stderr);
  assert.equal(JSON.parse(held.stdout).reason, 'cadence-throttle');
  assert.equal(fx.readState().lastResult.reason, 'cadence-throttle');
  assert.equal(fx.readState().lastCheckedAt, now - hour, '节流轮不是一次检查,不得推进 lastCheckedAt');
  assert.equal(fx.readState().consecutiveSnapshotFailures ?? 0, 0);

  fx.writeState({ lastCheckedAt: now - 5 * hour });
  const due = await fx.run([WITH_THROTTLE, '--json']);
  assert.equal(JSON.parse(due.stdout).reason, 'idle', '到点后照常查快照');
  assert.ok(fx.readState().lastCheckedAt >= now);

  fx.writeState({ lastCheckedAt: now - hour });
  const off = await fx.run(['--json']);
  assert.equal(JSON.parse(off.stdout).reason, 'idle', '--no-cadence-throttle 每次都查');
});

// ---------- 合并队列：快照分类与 gate 指纹 ----------

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

test('no queue is quiet; manual/unknown removal still wakes investigation, not automatic reenqueuing', () => {
  assert.equal(mergeQueueFingerprint(classifyMergeQueue(queue({ event: null }))), null);
  for (const reason of ['manually_removed', 'unknown']) {
    const q = classifyMergeQueue(queue({ event: { ...removal, reason }, checks: {} }));
    assert.deepEqual(q.blockers, ['merge_queue_removed']);
  }
});

test('gate catches queue-only changes and ignores position and timestamps', () => {
  const healthy = { state: 'OPEN', latestCommitOid: 'head', verdict: 'READY', blockers: [] };
  const q = classifyMergeQueue(queue());
  const broken = { ...healthy, verdict: 'NEEDS_WORK', blockers: q.blockers, mergeQueue: q };
  assert.notEqual(fingerprint(healthy), fingerprint(broken));
  assert.equal(decide({ snap: broken, previous: { fingerprint: fingerprint(healthy) }, now: Date.now() }).exitCode, 0);
  const enqueued = classifyMergeQueue(queue({ entry: { id: 'q', position: 2, state: 'AWAITING_CHECKS' }, checks: { pending: 1 } }));
  const a = { ...healthy, mergeQueue: enqueued };
  const b = { ...a, mergeQueue: { ...enqueued, position: 1, estimatedTimeToMerge: 100, fetchedAt: 'later' } };
  assert.equal(fingerprint(a), fingerprint(b));
  assert.notEqual(fingerprint(healthy), fingerprint(a));
});

test('queued PR keeps ten-minute polling without waking an agent for unchanged checks', () => {
  const now = Date.now();
  const snap = { verdict: 'WAITING_CI', blockers: ['merge_queue_pending'] };
  const state = { ...snap, fingerprint: fingerprint(snap), lastChangedAt: now - 4 * 86400000, lastPassAt: now };
  assert.equal(decide({ snap, previous: state, now }).exitCode, 2);
  assert.equal(suggestCadence(state, now).intervalMs, 600000);
});

test('repos without queue evidence retain their existing fingerprint and cadence', () => {
  const now = Date.now();
  for (const verdict of ['READY', 'WAITING_CI', 'BLOCKED_HUMAN']) {
    const snap = { verdict, blockers: verdict === 'BLOCKED_HUMAN' ? ['approval_required'] : [] };
    const state = { ...snap, fingerprint: fingerprint(snap), lastChangedAt: now - 86400000, lastPassAt: now };
    const withQueue = { ...snap, mergeQueue: classifyMergeQueue({}) };
    assert.equal(fingerprint(snap), fingerprint(withQueue));
    assert.equal(decide({ snap: withQueue, previous: state, now }).exitCode, 2);
    assert.deepEqual(suggestCadence(state, now), suggestCadence({ ...state, mergeQueue: withQueue.mergeQueue }, now));
  }
});
