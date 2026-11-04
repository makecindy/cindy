import { describe, expect, it, vi } from 'vitest';

// 扩展源码 import 的 pi 包不在本仓依赖里:测试只覆盖纯函数,喂一个最小替身。
vi.mock('@earendil-works/pi-coding-agent', () => ({
  estimateTokens: (message) => Math.ceil(JSON.stringify(message ?? '').length / 4),
  generateSummaryWithUsage: vi.fn(),
}));

const { selectNewestChunk, balanceIndexes, buildCard, redactSecrets } = await import(
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
    // 预算不够时硬行必须被计数(verdict 才会变 UNCONFIRMED,切割才被拒)。
    const text = Array.from({ length: 400 }, (_, i) => `必须保留 requirement item ${i} keep this obligation`).join(String.fromCharCode(10));
    const card = buildCard(text, '', 2000);
    expect(card.omittedHard).toBeGreaterThan(0);
    expect(card.keptChars).toBeLessThanOrEqual(2000);
    expect(card.verdict).toBe('TRUNK UNCONFIRMED');
  });
});