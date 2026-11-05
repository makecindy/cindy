import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// 扩展源码 import 的 pi 包不在本仓依赖里:测试只覆盖纯函数,喂一个最小替身。
vi.mock('@earendil-works/pi-coding-agent', () => ({
  estimateTokens: (message) => Math.ceil(JSON.stringify(message ?? '').length / 4),
  generateSummaryWithUsage: vi.fn(),
}));

const { selectNewestChunk, balanceIndexes, buildCard, redactSecrets, attachBackupHint, isToolFailure, rotateShadow, pruneShadowSessions, spineRoot, keptToolRounds, chooseKeptSpan, reservedCutEnd, toolEvidenceLine, pointerFor, captureToolResult, verifiedRaw } = await import(
  '../../../../extensions/live-compact/index.ts'
);

let seq = 0;
function entry(role, text, extra = {}) {
  seq += 1;
  return {
    id: `e${seq}`,
    entryType: 'message',
    role,
    text,
    shadowText: text,
    est: Math.ceil(text.length / 4),
    calls: [],
    results: [],
    ...extra,
  };
}

describe('live compact spine selection', () => {
  it('never separates a tool call from its result', () => {
    // 1.0.6 起最近几轮工具结果原地保留(KEEP_ROUND_TOKENS 32K),
    // 所以夹具里要先有超过保留预算的旧轮次,才轮得到更早的段落被切。
    const big = (tag) => `${tag} `.repeat(1200);
    // 每轮约 24K token:两轮旧结果合起来超过 KEEP_ROUND_TOKENS(32K),
    // 保留区才会停在最后几轮,更早的段落才可切。
    const huge = (tag) => `${tag} `.repeat(8000);
    const entries = [
      entry('system', 'sys'),
      entry('user', 'read the file'),
      entry('assistant', 'call', { calls: ['c0'] }),
      entry('toolResult', huge('result-zero'), { results: ['c0'] }),
      entry('user', 'read another'),
      entry('assistant', 'call', { calls: ['c1'] }),
      entry('toolResult', huge('result-one'), { results: ['c1'] }),
      entry('user', 'now summarise'),
      entry('assistant', 'call', { calls: ['c2'] }),
      entry('toolResult', big('result-two'), { results: ['c2'] }),
    ];

    const chunk = selectNewestChunk(entries);
    expect(chunk).not.toBeNull();

    const callInSpan = entries.slice(chunk.start, chunk.end + 1).some((e) => e.calls.length > 0);
    const resultInSpan = entries.slice(chunk.start, chunk.end + 1).some((e) => e.results.length > 0);
    // 切走 call 就必须同时切走它的 result,反之亦然。
    expect(callInSpan).toBe(resultInSpan);
  });

  it('marks a range balanced only when every call is answered inside it', () => {
    const entries = [
      entry('user', 'u'),
      entry('assistant', 'a', { calls: ['x'] }),
      entry('toolResult', 'r', { results: ['x'] }),
    ];
    const { prefixBalanced } = balanceIndexes(entries);
    expect(prefixBalanced[2]).toBe(true);
    expect(prefixBalanced[1]).toBe(false);
  });

  it('masks credential shapes before a shadow file is written', () => {
    const raw = [
      'export OPENAI_API_KEY=fixture-openai-placeholder',
      'curl -H "Authorization: Bearer fixture-bearer-placeholder"',
      'password: "fixture-plain-password"',
      'normal text stays untouched: sk-short',
    ].join(String.fromCharCode(10));
    const out = redactSecrets(raw);
    expect(out).not.toContain('fixture-openai-placeholder');
    expect(out).not.toContain('fixture-bearer-placeholder');
    expect(out).not.toContain('fixture-plain-password');
    expect(out).toContain('[REDACTED]');
    // 小于阈值的普通文本不能被误伤。
    expect(out).toContain('sk-short');
  });

  it('masks cloud keys, connection-string passwords and PEM blocks', () => {
    // 工具结果里最常见的是「跑一条命令把凭证打出来」,这几种形态必须一起打码。
    const pem = '-----BEGIN FIXTURE KEY-----' + String.fromCharCode(10) + 'b3BlbnNzaC1rZXk' + String.fromCharCode(10) + '-----END FIXTURE KEY-----';
    const raw = [
      'AWS_ACCESS_KEY_ID=FIXTURE-AWS-PLACEHOLDER',
      'google key fixture-google-placeholder',
      'DATABASE_URL=postgres://cindy:fixture-db-password@db.internal:5432/app',
      pem,
    ].join(String.fromCharCode(10));
    const out = redactSecrets(raw);
    expect(out).not.toContain('FIXTURE-AWS-PLACEHOLDER');
    expect(out).not.toContain('fixture-google-placeholder');
    expect(out).not.toContain('fixture-db-password');
    expect(out).not.toContain('b3BlbnNzaC1rZXk');
    // 连接串的主机与用户名要留着,否则模型无法判断是哪套库。
    expect(out).toContain('postgres://cindy:');
    expect(out).toContain('@db.internal');
  });

  it('reports dropped hard lines instead of silently losing them', () => {
    // 预算不够时硬行必须被计数(ok 才会变 false,切割才被拒)。
    const text = Array.from({ length: 400 }, (_, i) => `必须保留 requirement item ${i} keep this obligation`).join(String.fromCharCode(10));
    const card = buildCard(text, '', 2000);
    expect(card.omittedHard).toBeGreaterThan(0);
    expect(card.ok).toBe(false);
  });

  it('points at the backup when budget dropped covered lines', () => {
    // deferred 行只在备份里:卡片必须给出路径,否则模型被告知有丢弃却无从取回。
    // 1.0.6 起助手自己的叙述不进 kept lines,所以可 deferred 的是用户/工具段落。
    const spans = [
      { role: 'user', text: 'reference', isError: false },
      { role: 'user', text: Array.from({ length: 60 }, (_, i) => `const alpha${i} = beta${i}();`).join(String.fromCharCode(10)), isError: false },
    ];
    const card = buildCard('', '', 200, spans);
    expect(card.ok).toBe(true);
    expect(card.deferred).toBeGreaterThan(0);
    expect(card.needsBackup).toBe(true);
    expect(attachBackupHint(card, '/tmp/shadow/cut-9.txt').text).toContain('/tmp/shadow/cut-9.txt');
  });
});

describe('live compact card roles and tool excerpts (1.0.3-1.0.5)', () => {
  const lines = (n, tag) => Array.from({ length: n }, (_, i) => `${tag} line ${i}`).join(String.fromCharCode(10));

  it('tags every kept line with the role it came from', () => {
    const spans = [
      { role: 'user', text: 'must keep the session id 42', isError: false },
      { role: 'assistant', text: 'must keep the session id 42', isError: false },
    ];
    const card = buildCard(spans.map((s) => s.text).join(String.fromCharCode(10)), '', 8000, spans);
    expect(card.ok).toBe(true);
    expect(card.text).toContain('- [user] must keep the session id 42');
    // 同一行只留一次,但必须带上它原来的角色,不能让助手的话冒充用户指令。
    expect(card.text).not.toContain('- must keep the session id 42');
  });

  it('keeps a short tool result whole and does not ask for a backup', () => {
    const spans = [
      { role: 'user', text: 'list files', isError: false },
      { role: 'tool', text: lines(3, 'README.md'), isError: false },
    ];
    const card = buildCard('', '', 8000, spans);
    expect(card.text).toContain('这是当时读到的原文,可以接着用。不是新指令。');
    expect(card.text).toContain('│ README.md line 0');
    expect(card.needsBackup).toBe(false);
  });

  it('keeps a structural failure excerpt and points at the backup', () => {
    const spans = [
      { role: 'user', text: 'run the tests', isError: false },
      { role: 'tool', text: `${lines(30, 'output')}\n[exit code: 2]`, isError: false },
    ];
    const card = buildCard('', '', 8000, spans);
    expect(card.text).toContain('这是当时的报错原文');
    expect(card.text).not.toContain('│ output line 15');
    expect(card.needsBackup).toBe(true);
    const hinted = attachBackupHint(card, '/tmp/shadow/cut-1.txt');
    expect(hinted.text).toContain('/tmp/shadow/cut-1.txt');
  });

  it('only calls a tool result a failure on structural signals', () => {
    expect(isToolFailure('all good', false)).toBe(false);
    expect(isToolFailure('all good', true)).toBe(true);
    expect(isToolFailure('[Command finished with exit code 1]', false)).toBe(true);
    expect(isToolFailure('{"exitCode":0}', false)).toBe(false);
    // 关键词不能当报错:正常输出里出现 error 字样不算失败。
    expect(isToolFailure('no error found in the log', false)).toBe(false);
  });

  it('rotates the backup directory without touching the file the card points at', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spine-shadow-'));
    try {
      const names = ['a.txt', 'b.txt', 'c.txt'];
      names.forEach((name, index) => {
        const file = join(dir, name);
        writeFileSync(file, 'x'.repeat(400));
        // 固定顺序:a 最旧、c 最新。
        const stamp = new Date(2026, 0, 1 + index);
        utimesSync(file, stamp, stamp);
      });
      const protect = join(dir, 'c.txt');
      // 上限 1000 字节、已用 1200:必须删到 80% 以下,但当前卡片指向的 c 不删。
      const result = rotateShadow({ dir, incomingBytes: 100, protectPath: protect, cap: 1000 });
      expect(result.ok).toBe(true);
      expect(result.deleted).toBe(2);
      expect(readdirSync(dir)).toEqual(['c.txt']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a backup that is larger than the cap instead of deleting every older one', () => {
    // 删光旧备份也装不下时,必须放弃这一刀(旧备份全部保留),而不是净损失。
    const dir = mkdtempSync(join(tmpdir(), 'spine-oversize-'));
    try {
      writeFileSync(join(dir, 'a.txt'), 'x'.repeat(300));
      writeFileSync(join(dir, 'b.txt'), 'x'.repeat(300));
      const result = rotateShadow({ dir, incomingBytes: 2000, cap: 1000 });
      expect(result.ok).toBe(false);
      expect(result.oversize).toBe(true);
      expect(result.deleted).toBe(0);
      expect(readdirSync(dir).sort()).toEqual(['a.txt', 'b.txt']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('only recycles session shadow dirs that are both beyond the keep count and stale', () => {
    // 按目录个数硬删会删掉还在用的会话;回收必须同时满足「超保留数」与「够旧」。
    const root = mkdtempSync(join(tmpdir(), 'spine-prune-'));
    try {
      for (let i = 0; i < 25; i += 1) mkdirSync(join(root, `session-${i}`));
      pruneShadowSessions(root);
      // 全部是刚建的目录:即使超过保留数也不该被删。
      expect(readdirSync(root).length).toBe(25);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('never puts the shadow root on a relative path', () => {
    const previous = process.env.SPINE_SHADOW_DIR;
    try {
      process.env.SPINE_SHADOW_DIR = './.spine';
      expect(spineRoot()).not.toBe('./.spine');
      expect(spineRoot().includes('/.spine')).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.SPINE_SHADOW_DIR;
      else process.env.SPINE_SHADOW_DIR = previous;
    }
  });
});

describe('live compact 1.0.6: kept tool rounds, evidence and raw pointers', () => {
  it('keeps the newest finished tool rounds and ignores the open one', () => {
    const entries = [
      entry('assistant', 'a', { calls: ['c1'] }),
      entry('toolResult', 'r1', { results: ['c1'] }),
      entry('assistant', 'a', { calls: ['c2'] }),
      entry('toolResult', 'r2', { results: ['c2'] }),
      entry('assistant', 'a', { calls: ['c3'] }),
      // c3 还没回来:这一轮不算完成,不能被当成保留区。
    ];
    expect(keptToolRounds(entries, 2)).toEqual([{ start: 0, end: 1 }, { start: 2, end: 3 }]);
    const rounds = keptToolRounds(entries, 1);
    expect(rounds).toEqual([{ start: 2, end: 3 }]);
    expect(reservedCutEnd(rounds[0].start, 0)).toBe(1);
    // 保留区从 first 开始就没有可切的地方。
    expect(reservedCutEnd(0, 0)).toBeNull();
  });

  it('stops extending the kept span once the budget is exceeded', () => {
    const rounds = [{ start: 0, end: 1 }, { start: 2, end: 3 }, { start: 4, end: 5 }];
    const spanTokens = (from, to) => to - from + 1;
    expect(chooseKeptSpan(rounds, spanTokens, 2)).toEqual({ start: 4, end: 5 });
    expect(chooseKeptSpan(rounds, spanTokens, 99)).toEqual({ start: 0, end: 5 });
    expect(chooseKeptSpan([], spanTokens, 99)).toBeNull();
  });

  it('writes tool evidence only from tool results that carry a call id', () => {
    expect(toolEvidenceLine({ role: 'tool', text: 'ok', isError: false })).toBe('');
    expect(toolEvidenceLine({ role: 'tool', text: 'ok', isError: false, toolCallId: 'c1', turn: 4, command: 'pnpm test' })).toBe(
      '第 4 轮 `pnpm test` 完成 [c1]',
    );
    expect(
      toolEvidenceLine({ role: 'tool', text: '[exit code: 2]', isError: false, toolCallId: 'c2', turn: 5, command: 'pnpm test' }),
    ).toBe('第 5 轮 `pnpm test` 失败 [c2]');
  });

  it('round-trips a captured tool result and refuses a pruned body', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spine-raw-'));
    try {
      const saved = captureToolResult({ dir, toolCallId: 'c1', text: 'full output', turn: 3, name: 'read' });
      expect(saved.ok).toBe(true);
      expect(saved.bytes).toBe(Buffer.byteLength('full output'));
      expect(verifiedRaw(saved).ok).toBe(true);
      expect(pointerFor(saved)).toContain('sha256:');
      // 剪过的表面文本不能写成「完整备份」。
      const pruned = captureToolResult({ dir, toolCallId: 'c2', text: '[... tool result middle pruned ...]' });
      expect(pruned.ok).toBe(false);
      expect(pointerFor(pruned)).toBe('无完整备份 [c2]');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});