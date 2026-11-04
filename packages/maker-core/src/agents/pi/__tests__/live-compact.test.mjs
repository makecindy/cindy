import { describe, expect, it, vi } from 'vitest';

// 扩展源码 import 的 pi 包不在本仓依赖里:测试只覆盖纯函数,喂一个最小替身。
vi.mock('@earendil-works/pi-coding-agent', () => ({
  estimateTokens: (message) => Math.ceil(JSON.stringify(message ?? '').length / 4),
  generateSummaryWithUsage: vi.fn(),
}));

const { selectNewestChunk, balanceIndexes, buildCard, redactSecrets, attachBackupHint, isToolFailure, rotateShadow } = await import(
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
    // 5KB 的 toolResult 让每一段都够大,于是唯一挡刀的就是配对平衡。
    const big = (tag) => `${tag} `.repeat(1200);
    const entries = [
      entry('system', 'sys'),
      entry('user', 'read the file'),
      entry('assistant', 'call', { calls: ['c1'] }),
      entry('toolResult', big('result-one'), { results: ['c1'] }),
      entry('user', 'now summarise'),
      entry('assistant', 'call', { calls: ['c2'] }),
      entry('toolResult', big('result-two'), { results: ['c2'] }),
    ];

    const chunk = selectNewestChunk(entries);
    expect(chunk).not.toBeNull();

    const inSpan = new Set(
      entries.slice(chunk.start, chunk.end + 1).flatMap((e) => [...e.calls, ...e.results]),
    );
    const callInSpan = entries.slice(chunk.start, chunk.end + 1).some((e) => e.calls.length > 0);
    const resultInSpan = entries.slice(chunk.start, chunk.end + 1).some((e) => e.results.length > 0);
    // 切走 call 就必须同时切走它的 result,反之亦然。
    expect(callInSpan).toBe(resultInSpan);
    if (callInSpan) expect(inSpan.has('c1') || inSpan.has('c2')).toBe(true);
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

  it('reports dropped hard lines instead of silently losing them', () => {
    // 预算不够时硬行必须被计数(ok 才会变 false,切割才被拒)。
    const text = Array.from({ length: 400 }, (_, i) => `必须保留 requirement item ${i} keep this obligation`).join(String.fromCharCode(10));
    const card = buildCard(text, '', 2000);
    expect(card.omittedHard).toBeGreaterThan(0);
    expect(card.keptChars).toBeLessThanOrEqual(2000);
    expect(card.ok).toBe(false);
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

  it('rotates the backup directory without touching the file the card points at', async () => {
    const { mkdtempSync, writeFileSync, readdirSync, utimesSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
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
});