import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// 扩展源码 import 的 pi 包不在本仓依赖里:测试只覆盖纯函数,喂一个最小替身。
vi.mock('@earendil-works/pi-coding-agent', () => ({
  estimateTokens: (message) => Math.ceil(JSON.stringify(message ?? '').length / 4),
  generateSummaryWithUsage: vi.fn(),
}));


const extensionModule = await import('../../../../extensions/live-compact/index.ts');
const registerLiveCompact = extensionModule.default;
const { selectNewestChunk, balanceIndexes, buildCard, attachBackupHint, isToolFailure, rotateShadow, pruneShadowSessions, spineRoot, keptToolRounds, chooseKeptSpan, reservedCutEnd, toolEvidenceLine, pointerFor, captureToolResult, planRawEntry, commitRawEntry, verifiedRaw, resolveEngine, resolveSpineEngine, selectCutIndexes, pointerSpanAllowed, pointerOnlyText, spineEntries, longReadResults, writeOwner, orderedDrainDrafts, withBackupHint, withoutFullBackupClaim, backupHint, discardRawSnapshots, saveShadow, lastCompactionEntry, inCooldown, resolveCooldownMs, providerURLFromPatch, resolveProviderBaseURL, spanHidesCallArgs, callArgsHidden, rawName } = extensionModule;

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
    // 1.0.8: 云端平时不切,这里用收尾模式驱动一次真实选段(保留区仍是最近 3 轮)。
    const big = (tag) => `${tag} `.repeat(1200);
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
      entry('user', 'and once more'),
      entry('assistant', 'call', { calls: ['c3'] }),
      entry('toolResult', big('result-three'), { results: ['c3'] }),
    ];

    const chunk = selectNewestChunk(entries, undefined, { drain: true, totalTokens: 60000 });
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

  it('reports dropped hard lines instead of silently losing them', () => {
    // 预算不够时硬行必须被计数(ok 才会变 false,切割才被拒)。
    // 1.0.9: 硬行只来自 user/tool 来源,裸文本(没有来源)不再产生硬行。
    const lines = Array.from({ length: 400 }, (_, i) => `必须保留 requirement item ${i} keep this obligation`);
    const card = buildCard('', '', 2000, [{ role: 'user', text: lines.join(String.fromCharCode(10)), isError: false }]);
    expect(card.omittedHard).toBeGreaterThan(0);
    expect(card.ok).toBe(false);
    expect(card.missing.length).toBeGreaterThan(0);
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

  it('does not claim a full backup when the span held a pruned tool result', () => {
    // shadow 里只有修剪后的表面文本:提示必须在加完之后再撤,否则模型会以为原文还能找回。
    const card = { needsBackup: true, text: 'body' };
    const kept = withBackupHint(card, '/tmp/shadow/cut-7.txt', true);
    expect(kept.text).toContain('/tmp/shadow/cut-7.txt');
    const pruned = withBackupHint(card, '/tmp/shadow/cut-7.txt', false);
    expect(pruned.text).not.toContain('/tmp/shadow/cut-7.txt');
    expect(pruned.text).toContain('没有完整工具原文');
    // 外加:撤除用的句子必须与提示同一份文案,两处各写一份就会对不上。
    expect(withoutFullBackupClaim(attachBackupHint(card, '/tmp/shadow/cut-8.txt').text, '/tmp/shadow/cut-8.txt'))
      .not.toContain(backupHint('/tmp/shadow/cut-8.txt'));
  });

  it('keeps the newest finished tool rounds verbatim instead of a token budget', () => {
    // 1.0.9: 保留区 = 最近 3 个已完成的工具轮,与 token 预算无关(KEEP_ROUND_TOKENS 只剩收尾水位)。
    const round = (id, size) => [
      entry('assistant', 'call ' + id, { calls: [id] }),
      entry('toolResult', 'r '.repeat(size), { results: [id] }),
    ];
    const entries = [
      entry('system', 'sys'),
      entry('user', 'go'),
      ...round('c1', 8000),
      ...round('c2', 2000),
      ...round('c3', 2000),
      ...round('c4', 2000),
    ];
    const picked = selectNewestChunk(entries, undefined, { drain: true, totalTokens: 60000 });
    expect(picked).not.toBeNull();
    // 切点必须在第 4 个（最老的）轮里，最近 3 轮原样留下。
    expect(picked.end).toBeLessThan(entries.length - 6);
  });

  it('skips one pass after a host compaction card and only that one', () => {
    // 1.0.9: 宿主压缩后紧接着又切一刀,会把官方摘要卷走(上游 issue #12)。
    const compaction = { ...entry('user', 'summary'), entryType: 'compaction', time: 1_000_000 };
    const entries = [entry('system', 'sys'), entry('user', 'go'), compaction];
    expect(lastCompactionEntry(entries)).toBe(compaction);
    expect(lastCompactionEntry([entry('user', 'go')])).toBeUndefined();
    // 没有设置窗口时不算冷却(默认 0 = 只用一次性跳过语义)。
    expect(resolveCooldownMs({})).toBe(0);
    expect(inCooldown(entries, { windowMs: resolveCooldownMs({}) })).toBe(false);
    // 设了窗口且时间在窗口内才算冷却。
    expect(inCooldown(entries, { windowMs: 60_000, now: 1_030_000 })).toBe(true);
    expect(inCooldown(entries, { windowMs: 60_000, now: 1_300_000 })).toBe(false);
    expect(resolveCooldownMs({ SPINE_COOLDOWN_MS: '-1' })).toBe(0);
    expect(resolveCooldownMs({ SPINE_COOLDOWN_MS: '9000' })).toBe(9000);
  });

  it('remembers the compaction it let pass across settle hooks in the same session', () => {
    // 已让过的条目要按会话存:stateFor 每次新建对象,存在 state 上的话同一条 compaction
    // 会在每个 settle 都被当成首次出现,宿主压缩一次之后 Live Compact 永久停摆。
    const root = mkdtempSync(join(tmpdir(), 'spine-cooldown-'));
    const previous = process.env.SPINE_SHADOW_DIR;
    process.env.SPINE_SHADOW_DIR = root;
    try {
      let handler = null;
      registerLiveCompact({ on: (name, fn) => { if (name === 'agent_before_settle') handler = fn; } });
      expect(handler).not.toBeNull();
      const contextEntries = [
        { messages: [{ role: 'system', content: 'sys' }], sourceEntry: { id: 'x1', type: 'message' } },
        { messages: [{ role: 'user', content: 'go' }], sourceEntry: { id: 'x2', type: 'message' } },
        { messages: [{ role: 'user', content: 'official summary' }], sourceEntry: { id: 'x3', type: 'compaction', timestamp: 1_000_000 } },
      ];
      const event = { outcome: 'completed', context: { contextEntries } };
      const ctx = {
        sessionManager: { getSessionId: () => 'session-cooldown' },
        getContextUsage: () => ({ tokens: 100 }),
      };
      handler(event, ctx);
      handler(event, ctx);
      const log = readFileSync(join(root, 'spine.log'), 'utf8');
      expect(log.match(/cooldown: official compaction/g) || []).toHaveLength(1);
      // 第二次进入不该再走冷却分支:上下文没到压力线,只留 idle 一行。
      expect(log).toContain('spine idle');
    } finally {
      if (previous === undefined) delete process.env.SPINE_SHADOW_DIR;
      else process.env.SPINE_SHADOW_DIR = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('asks for the backup pointer when a cut span hides its call arguments', () => {
    // 卡片只写 callCommand(命令或工具名):write/edit 这类带路径与正文的调用切走后,
    // 后续轮次看不到写入目标与内容,可能重复执行副作用 —— 这类 span 要给出备份指针。
    const meta = (name, command, hiddenArgs = false) => new Map([['c1', { name, command, hiddenArgs }]]);
    expect(spanHidesCallArgs([{ callMeta: meta('bash', 'npm test') }])).toBe(false);
    expect(spanHidesCallArgs([{ callMeta: meta('write', 'write') }])).toBe(true);
    // 命令被换行或 80 字截断时,卡片只留前半段;后半段同样没出处。
    expect(spanHidesCallArgs([{ callMeta: meta('bash', 'npm test', true) }])).toBe(true);
    expect(spanHidesCallArgs([])).toBe(false);
    // 判定本身:没有 command 参数、或参数被截断都算「参数被隐藏」。
    expect(callArgsHidden({ command: 'npm test' })).toBe(false);
    expect(callArgsHidden({ command: 'line one' + String.fromCharCode(10) + 'line two' })).toBe(true);
    expect(callArgsHidden({ command: 'x'.repeat(120) })).toBe(true);
    expect(callArgsHidden({ file_path: '/tmp/a' })).toBe(true);
  });

  it('counts a hard fact only when it comes from the same source', () => {
    // 1.0.9 的覆盖判定按 (来源, 行) 记账:同一句话来自别的来源不能替这条硬事实过关
    // (上游 issue #14 P0-2:关键事实没进卡片也 ok:true)。
    const fact = '必须保留 CHUNK_MIN 的默认值';
    const card = buildCard('', '', 4000, [
      { role: 'user', text: '无关的一句', isError: false },
      { role: 'user', text: fact, isError: false },
    ]);
    // 硬行进了卡片、也来自同一条 user 来源 -> ok
    expect(card.ok).toBe(true);
    expect(card.text).toContain(fact);
    // 同样一句放在 assistant 来源里不进硬行(助手自述不算证据)
    const assistantOnly = buildCard('', '', 4000, [{ role: 'assistant', text: fact, isError: false }]);
    expect(assistantOnly.hardCount).toBe(0);
  });

  it('reads a provider baseURL from patch text and keeps header priority', () => {
    // 1.0.9 的地址解析链:请求头优先,其次配置/补丁里的这一家,最后才是内置目录。
    const patch = [
      'providers:',
      '  minimax:',
      '    baseURL: https://api.minimax.chat/v1',
      '  other:',
      '    baseURL: https://other.example.com',
    ].join(String.fromCharCode(10));
    expect(providerURLFromPatch(patch, 'minimax')).toBe('https://api.minimax.chat/v1');
    expect(providerURLFromPatch(patch, 'missing')).toBe('');
    expect(resolveProviderBaseURL({ provider: 'minimax', headerURL: 'http://127.0.0.1:8080', patchText: patch }))
      .toBe('http://127.0.0.1:8080');
    expect(resolveProviderBaseURL({ provider: 'minimax', patchText: patch })).toBe('https://api.minimax.chat/v1');
    expect(resolveProviderBaseURL({ provider: 'deepseek' })).toBe('https://api.deepseek.com/anthropic');
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

  it('deletes nothing when the eviction plan cannot get under the cap', () => {
    // 受保护文件占住额度:删光其余候选也装不下新备份。这时不能先删再报失败 ——
    // 已有卡片会指向被删掉的原文。
    const dir = mkdtempSync(join(tmpdir(), 'spine-nofit-'));
    try {
      const kept = join(dir, 'c.txt');
      writeFileSync(kept, 'k'.repeat(700));
      writeFileSync(join(dir, 'a.txt'), 'x'.repeat(200));
      writeFileSync(join(dir, 'b.txt'), 'y'.repeat(200));
      const older = new Date(2026, 0, 1);
      utimesSync(join(dir, 'a.txt'), older, older);
      utimesSync(join(dir, 'b.txt'), older, older);
      const result = rotateShadow({ dir, incomingBytes: 600, protectPath: kept, cap: 1000 });
      expect(result.ok).toBe(false);
      expect(result.deleted).toBe(0);
      expect(readdirSync(dir).sort()).toEqual(['a.txt', 'b.txt', 'c.txt']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps evicting past a file that cannot be deleted', () => {
    // 计划内的最旧文件被占用(Windows 常见)时,不能就此放弃整轮压缩 ——
    // 继续往下删,腾出够用的空间就照常切。
    const dir = mkdtempSync(join(tmpdir(), 'spine-busy-'));
    try {
      const locked = join(dir, 'locked.txt');
      writeFileSync(locked, 'l'.repeat(600));
      writeFileSync(join(dir, 'b.txt'), 'b'.repeat(200));
      writeFileSync(join(dir, 'c.txt'), 'c'.repeat(200));
      const oldest = new Date(2026, 0, 1);
      utimesSync(locked, oldest, oldest);
      const newer = new Date(2026, 0, 2);
      utimesSync(join(dir, 'b.txt'), newer, newer);
      utimesSync(join(dir, 'c.txt'), newer, newer);
      // 上限 1000、已用 1000、新写 100:计划只含最旧的 locked;它删不掉时必须继续删 b。
      const result = rotateShadow({
        dir,
        incomingBytes: 100,
        cap: 1000,
        rename: (from, to) => {
          if (String(from).endsWith('locked.txt')) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
          renameSync(from, to);
        },
      });
      expect(result.ok).toBe(true);
      expect(readdirSync(dir).sort()).toEqual(['c.txt', 'locked.txt']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('puts evicted files back when the final rotation still cannot fit', () => {
    // 先 rename 进隔离目录、确认装得下再真删:中途撞上占用导致最终仍装不下时,
    // 已经搬走的旧备份必须原路搬回,否则已有卡片指向的原文就没了。
    const dir = mkdtempSync(join(tmpdir(), 'spine-rollback-'));
    try {
      const names = ['a.txt', 'locked-b.txt', 'locked-c.txt'];
      writeFileSync(join(dir, 'a.txt'), 'x'.repeat(100));
      writeFileSync(join(dir, 'locked-b.txt'), 'y'.repeat(400));
      writeFileSync(join(dir, 'locked-c.txt'), 'z'.repeat(400));
      const older = new Date(2026, 0, 1);
      utimesSync(join(dir, names[0]), older, older);
      utimesSync(join(dir, names[1]), older, older);
      utimesSync(join(dir, names[2]), older, older);
      // 上限 1000、已用 900:腾出 200 才够。最旧的 a 搬得走,两个占用文件搬不走 → 回滚。
      const result = rotateShadow({
        dir,
        incomingBytes: 300,
        cap: 1000,
        rename: (from, to) => {
          if (String(from).includes('locked-')) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
          renameSync(from, to);
        },
      });
      expect(result.ok).toBe(false);
      expect(result.deleted).toBe(0);
      expect(readdirSync(dir).sort()).toEqual([...names].sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not count a quarantined file it could not delete as freed space', () => {
    // 隔离目录里的文件删不掉时,既不能报「已释放」,也不能让它变成卡片找不到的孤儿:
    // 搬回原位,占用照实算。
    const dir = mkdtempSync(join(tmpdir(), 'spine-unlink-fail-'));
    try {
      writeFileSync(join(dir, 'a.txt'), 'x'.repeat(600));
      writeFileSync(join(dir, 'b.txt'), 'y'.repeat(400));
      const older = new Date(2026, 0, 1);
      utimesSync(join(dir, 'a.txt'), older, older);
      const newer = new Date(2026, 0, 2);
      utimesSync(join(dir, 'b.txt'), newer, newer);
      // 上限 1000、已用 1000、新写 300:只删得掉 a(600) 也装不下 → 结果必须是 ok:false 且文件齐全。
      const result = rotateShadow({
        dir,
        incomingBytes: 300,
        cap: 1000,
        unlink: () => {
          throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
        },
      });
      // 删不掉的文件搬回原位后已经超上限,但这里不能拒绝这一刀 —— 拒绝会白删前面删成功的旧备份。
      expect(result.ok).toBe(true);
      expect(result.deleted).toBe(0);
      expect(result.freed).toBe(0);
      expect(result.used).toBe(1000);
      expect(result.undeletable).toBe(1);
      expect(readdirSync(dir).sort()).toEqual(['a.txt', 'b.txt']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still commits the cut when only some old files cannot be deleted', () => {
    // 上限 1000、已用 1000、新写 100:只要删掉 200 就够。a 删得掉、b 删不掉 ——
    // 这一刀必须成功(否则删掉的 a 白删),b 搬回原位继续算占用。
    const dir = mkdtempSync(join(tmpdir(), 'spine-partial-'));
    try {
      writeFileSync(join(dir, 'a.txt'), 'a'.repeat(200));
      writeFileSync(join(dir, 'b.txt'), 'b'.repeat(800));
      const older = new Date(2026, 0, 1);
      utimesSync(join(dir, 'a.txt'), older, older);
      utimesSync(join(dir, 'b.txt'), older, older);
      const result = rotateShadow({
        dir,
        incomingBytes: 100,
        cap: 1000,
        unlink: (path) => {
          if (String(path).includes('b.txt')) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
          rmSync(path, { force: true });
        },
      });
      expect(result.ok).toBe(true);
      expect(result.deleted).toBe(1);
      expect(result.freed).toBe(200);
      expect(result.used).toBe(800);
      expect(readdirSync(dir).sort()).toEqual(['b.txt']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sweeps files left behind in an old quarantine directory', () => {
    // 双重失败(删不掉又搬不回去)的残留仍占磁盘,下一次轮换要补删。
    const dir = mkdtempSync(join(tmpdir(), 'spine-trash-sweep-'));
    try {
      const trash = join(dir, '.rotate-999-1');
      mkdirSync(trash, { recursive: true });
      writeFileSync(join(trash, 'stale.txt'), 'z'.repeat(500));
      const old = new Date(2026, 0, 1);
      utimesSync(trash, old, old);
      writeFileSync(join(dir, 'a.txt'), 'x'.repeat(100));
      const result = rotateShadow({ dir, incomingBytes: 10, cap: 10000 });
      expect(result.ok).toBe(true);
      expect(existsSync(trash)).toBe(false);
      expect(result.used).toBe(100);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('removes raw snapshots that no card ended up referencing', () => {
    // 原文写入不走容量轮换:这一刀被拒时若不清,残留会一轮轮堆积。
    const dir = mkdtempSync(join(tmpdir(), 'spine-raw-discard-'));
    try {
      const raw = join(dir, 'raw-abcdef0123456789.txt');
      writeFileSync(raw, 'x'.repeat(10));
      writeFileSync(`${raw}.meta.json`, '{}');
      discardRawSnapshots([raw]);
      expect(existsSync(raw)).toBe(false);
      expect(existsSync(`${raw}.meta.json`)).toBe(false);
      // 已经不在的快照也不能把整刀带崩。
      expect(() => discardRawSnapshots([raw])).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('drops the raw snapshot record together with the snapshot it describes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spine-meta-'));
    try {
      const raw = join(dir, 'raw-0123456789abcdef.txt');
      writeFileSync(raw, 'x'.repeat(600));
      writeFileSync(`${raw}.meta.json`, JSON.stringify({ sha256: 'x'.repeat(64), bytes: 600 }));
      const older = new Date(2026, 0, 1);
      utimesSync(raw, older, older);
      utimesSync(`${raw}.meta.json`, older, older);
      writeFileSync(join(dir, 'newer.txt'), 'y'.repeat(100));
      // 上限装不下两份:最旧的原文被回收时,它的 meta 也要一起走,否则记录会一直堆着。
      const result = rotateShadow({ dir, incomingBytes: 500, cap: 1000 });
      expect(result.deleted).toBe(1);
      expect(readdirSync(dir).sort()).toEqual(['newer.txt']);
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

  it('keeps a stale session dir whose owner process is still running', () => {
    // 长期低于水位、一直没切过的会话:目录 mtime 很旧,但 owner 进程还活着,
    // 里面的原文仍是它卡片的备份 —— 不能按「够旧」直接回收。
    const root = mkdtempSync(join(tmpdir(), 'spine-live-owner-'));
    try {
      const stale = new Date(2026, 0, 1);
      for (let i = 0; i < 25; i += 1) {
        const dir = join(root, `session-${i}`);
        mkdirSync(dir);
        writeFileSync(join(dir, 'raw-deadbeef.txt'), 'x'.repeat(10));
        // session-0 的 owner 就是当前进程(活着);session-1 的 owner 是个不可能的 pid。
        if (i === 0) writeFileSync(join(dir, 'owner'), String(process.pid));
        if (i === 1) writeFileSync(join(dir, 'owner'), '999999');
        // 时间递增:session-0 最旧、session-24 最新,超出保留数的就是前面几个。
        // 必须放在写文件之后 —— 新建文件会把父目录 mtime 刷新成现在。
        const stamp = new Date(stale.getTime() + i * 60_000);
        utimesSync(dir, stamp, stamp);
      }
      pruneShadowSessions(root);
      const names = readdirSync(root);
      expect(names).toContain('session-0');
      expect(names).not.toContain('session-1');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('re-registers the owner when a restored task writes from a new process', () => {
    // 任务恢复到新进程后,目录里的 owner 还是旧 pid:回收会把它当死会话。
    const root = mkdtempSync(join(tmpdir(), 'spine-owner-'));
    try {
      const dir = join(root, 'session-restored');
      mkdirSync(dir);
      writeFileSync(join(dir, 'owner'), '999999');
      writeOwner(dir);
      expect(readFileSync(join(dir, 'owner'), 'utf8').trim()).toBe(String(process.pid));
      // 目录不存在时什么都不做(这个会话还没有备份,不该凭空建目录)。
      const absent = join(root, 'session-new');
      writeOwner(absent);
      expect(existsSync(absent)).toBe(false);
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

  it('plans a raw pointer without touching disk and keeps the bytes verbatim', () => {
    // 快照是恢复用的完整副本,写出去的字节必须逐字等于工具结果原文(不做打码,理由见
    // 文件头),哈希也必须算在这份字节上。夹具仍按运行时拼接构造,源码里不出现连续形态。
    const dir = mkdtempSync(join(tmpdir(), 'spine-plan-'));
    try {
      const apiKey = ['OPENAI', 'API_KEY'].join('_');
      const password = ['pass', 'word="fixture plain password line"'].join('');
      const text = [`export ${apiKey}=fixture-value-0123456789`, password, 'line two'].join(String.fromCharCode(10));
      const planned = planRawEntry({ dir, toolCallId: 'c9', text });
      expect(planned.ok).toBe(true);
      expect(planned.pending).toBe(true);
      expect(existsSync(planned.path)).toBe(false);
      expect(planned.body).toBe(text);
      expect(verifiedRaw(planned).ok).toBe(true);
      // 指针里的字节数必须是数字:把 Buffer 塞进去会把整段正文带进卡片。
      expect(typeof verifiedRaw(planned).bytes).toBe('number');
      expect(pointerFor(verifiedRaw(planned))).not.toContain('line two');
      const committed = commitRawEntry(planned);
      expect(committed.pending).toBeUndefined();
      expect(verifiedRaw(committed).ok).toBe(true);
      expect(readFileSync(committed.path, 'utf8')).toBe(text);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never rotates away a file the new card points at', () => {
    // 卡片的指针能命中文件名时,轮换宁可放弃这一刀,也不能把刚引用的原文删了。
    const dir = mkdtempSync(join(tmpdir(), 'spine-protect-'));
    try {
      const files = ['span.txt', 'raw-a.txt', 'raw-b.txt'];
      files.forEach((name) => writeFileSync(join(dir, name), 'x'.repeat(300)));
      const result = rotateShadow({
        dir,
        incomingBytes: 300,
        protectPath: join(dir, 'span.txt'),
        protectPaths: [join(dir, 'raw-a.txt'), join(dir, 'raw-b.txt')],
        cap: 1000,
      });
      expect(result.ok).toBe(false);
      expect(result.deleted).toBe(0);
      expect(readdirSync(dir).sort()).toEqual([...files].sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('live compact 1.0.8: cache-safe drains, pointer-only spans, no cross-user padding', () => {
  const cut = (spec) =>
    spec.map(([type, tokens]) => ({ type, tokens, checkpoint: false, balancedBefore: true, balancedAfter: true }));

  it('resolves the engine from the env override, the provider name or the address', () => {
    expect(resolveEngine({ provider: 'minimax', env: { SPINE_ENGINE: 'local' } })).toEqual({ engine: 'local', source: 'env' });
    expect(resolveEngine({ provider: 'strata-local', env: {} })).toEqual({ engine: 'local', source: 'provider' });
    // 1.0.9 的 resolveEngine 只认地址与 strata:读不到地址就是 local/unknown(不猜)。
    expect(resolveEngine({ provider: 'minimax', env: {} })).toEqual({ engine: 'local', source: 'unknown' });
    // pi 拿不到 baseURL,所以调用方用 resolveSpineEngine 补一层 provider 名兜底。
    expect(resolveSpineEngine('minimax')).toEqual({ engine: 'cloud', source: 'provider' });
    expect(resolveSpineEngine('ollama')).toEqual({ engine: 'local', source: 'provider' });
    expect(resolveEngine({ provider: 'x', baseURL: 'http://127.0.0.1:8080/v1', env: {} })).toEqual({ engine: 'local', source: 'address' });
    expect(resolveEngine({ provider: 'x', baseURL: 'https://api.example.com', env: {} })).toEqual({ engine: 'cloud', source: 'address' });
    // 没有任何证据时按原仓的保守默认:不跨 user。
    expect(resolveEngine({ env: {} })).toEqual({ engine: 'local', source: 'unknown' });
  });

  it('does not walk across an earlier user to manufacture CHUNK_MIN, and does not cut below the water line', () => {
    // 最新一段(assistant+tool 两轮)不到 CHUNK_MIN。1.0.8 不会回头跨过 user 去凑,
    // 而是直接跳过;平时(总量没到水位)也不切。
    const items = cut([
      ['system', 100],
      ['user', 50],
      ['assistant', 300],
      ['tool', 600],
      ['user', 50],
      ['assistant', 300],
      ['tool', 600],
      ['user', 50],
      ['assistant', 300],
      ['tool', 600],
    ]);
    expect(selectCutIndexes(items, { engine: 'cloud' })).toBeNull();
    expect(selectCutIndexes(items, { engine: 'cloud', totalTokens: 30000 })).toBeNull();
    expect(selectCutIndexes(items, { engine: 'local' })).toBeNull();
  });

  it('keeps drain cards in chronological order when one run cuts several spans', () => {
    // 卡片按切出来的先后发出:切点右边还有卡片就不切,后一刀只能落在前一张卡片右边,
    // 所以这个先后就是上下文里的时间序(与上游原地替换看到的一致)。
    const oldest = { type: 'custom_message', content: [{ type: 'text', text: 'oldest span' }] };
    const newest = { type: 'custom_message', content: [{ type: 'text', text: 'newest span' }] };
    const edit = { type: 'context_edit', targetId: 'e9', replacement: null };
    const out = orderedDrainDrafts([edit], [oldest, newest]);
    expect(out.map((draft) => draft.type)).toEqual(['context_edit', 'custom_message', 'custom_message']);
    expect(out[1]).toBe(oldest);
    expect(out[2]).toBe(newest);
  });

  it('drains span after span once the predicted request passes the water line', () => {
    const items = cut([
      ['user', 50],
      ['assistant', 300],
      ['tool', 5000],
      ['user', 50],
      ['assistant', 300],
      ['tool', 5000],
      ['user', 50],
      ['assistant', 300],
      ['tool', 5000],
    ]);
    // 平时(总量没到紧急线):云端只处理超大结果,不改前缀。
    expect(selectCutIndexes(items, { engine: 'cloud', totalTokens: 40000, maxEnd: 2 })).toBeNull();
    // 低于水位且没在收尾:一律不切。
    expect(selectCutIndexes(items, { engine: 'cloud', totalTokens: 30000, maxEnd: 2 })).toBeNull();
    // 1.0.9: 收尾同样受调用方给的 maxEnd 约束(切点在保留区之前),不再无视边界切到最新一轮。
    expect(selectCutIndexes(items, { engine: 'cloud', totalTokens: 40000, drain: true, maxEnd: 2 })).toMatchObject({
      start: 1,
      end: 2,
    });
    // 过了紧急线(48000)即使没标 drain 也进入批量切。
    expect(selectCutIndexes(items, { engine: 'cloud', totalTokens: 60000, maxEnd: 2 })).not.toBeNull();
  });

  it('only drains a span while the measured total is still above the water line', () => {
    // 上游入口是 `drain && measured <= KEEP_ROUND_TOKENS` 就 break:当前总量已经在水位以下时,
    // 即使预测下一轮会过线,这一轮也不切(切发生在实测过线的那一轮)。选段层不拦,
    // 拦在调用方——这里钉住两边,避免以后把上游口径单方面“优化”掉。
    const items = cut([
      ['user', 50],
      ['assistant', 300],
      ['tool', 5000],
    ]);
    expect(selectCutIndexes(items, { engine: 'cloud', drain: true, totalTokens: 30000, maxEnd: 2 })).not.toBeNull();
    expect(selectCutIndexes(items, { engine: 'cloud', drain: false, totalTokens: 30000, maxEnd: 2 })).toBeNull();
  });

  it('honours SPINE_POINTER_TOKENS separately from the span cap', () => {
    const items = cut([
      ['user', 50],
      ['assistant', 100],
      ['tool', 9000],
    ]);
    expect(selectCutIndexes(items, { engine: 'local', pointerMax: 8000 })).toMatchObject({ start: 2, end: 2, pointerOnly: true });
    expect(selectCutIndexes(items, { engine: 'local' })?.pointerOnly).toBeUndefined();
  });

  it('keeps an entry that carries an image payload out of every span', () => {
    // 工具结果里带图片时,卡片和原文快照都只有文本:切走就等于把图丢了。
    // 这里把带图的一轮夹在只能靠它才凑够 CHUNK_MIN 的位置上 —— 没有屏障就会把它一起切走。
    const tool = (id) => ({ sourceEntry: { id }, messages: [{ role: 'assistant', content: [{ type: 'toolCall', id, name: 'read', arguments: {} }] }] });
    const result = (id, text) => ({ sourceEntry: { id: `${id}-r` }, messages: [{ role: 'toolResult', toolCallId: id, content: [{ type: 'text', text }] }] });
    const entries = spineEntries([
      { sourceEntry: { id: 'u' }, messages: [{ role: 'user', content: [{ type: 'text', text: 'look at this screen' }] }] },
      tool('c0'),
      result('c0', 'log '.repeat(4000)),
      tool('c1'),
      {
        sourceEntry: { id: 'c1-r' },
        messages: [{
          role: 'toolResult',
          toolCallId: 'c1',
          content: [{ type: 'text', text: 'shot '.repeat(3000) }, { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }],
        }],
      },
      tool('c2'),
      result('c2', 'tiny '.repeat(100)),
      tool('c3'),
      result('c3', 'tiny '.repeat(100)),
      tool('c4'),
      result('c4', 'tiny '.repeat(100)),
    ]);
    expect(entries[4].opaque).toBe(true);
    expect(entries[6].opaque).toBe(false);
    // 1.0.9 保留最近 3 个工具轮,屏障前的那一轮(c0)才是可切段;带图的 c1 永不在段内。
    const picked = selectNewestChunk(entries, undefined, { drain: true, totalTokens: 60000 });
    expect(picked).toMatchObject({ start: 1, end: 2 });
    expect(picked.end).toBeLessThan(4);
  });

  it('does not drain while the whole cuttable history is inside the kept rounds', () => {
    // 前面只有 user,可切的全部历史都在保留区内时,上游同样返回 null(切点退到 user、再退就越界)。
    // 一旦多出一轮、有旧段落落到保留区之外,切割就恢复 —— 这里把两个状态都钉住。
    const user = 'u '.repeat(24000);
    const round = (id) => [
      entry('assistant', 'call', { calls: [id] }),
      entry('toolResult', 'r '.repeat(16000), { results: [id] }),
    ];
    const entries = [entry('system', 'sys'), entry('user', user), ...round('c0'), ...round('c1'), ...round('c2')];
    expect(selectNewestChunk(entries, undefined, { drain: true, totalTokens: 36000 })).toBeNull();

    const withOlderRound = [entry('system', 'sys'), entry('user', user), ...round('c9'), ...round('c0'), ...round('c1'), ...round('c2')];
    expect(selectNewestChunk(withOlderRound, undefined, { drain: true, totalTokens: 44000 })).not.toBeNull();
  });

  it('refuses a pointer cut that would orphan a sibling tool result', () => {
    // 一条 assistant 消息发了两个调用:先返回的结果超大(走指针),后一个很小。
    // 只换掉前一个,后一个就变成没有调用的孤儿 —— 与普通切法用同一条平衡判据拦下。
    const huge = 'big '.repeat(36000);
    const entries = [
      entry('system', 'sys'),
      entry('user', 'older'),
      entry('assistant', 'call', { calls: ['c9'] }),
      entry('toolResult', 'older result '.repeat(400), { results: ['c9'] }),
      entry('user', 'read two things'),
      entry('assistant', 'calls', { calls: ['c0', 'c1'] }),
      entry('toolResult', huge, { results: ['c0'] }),
      entry('toolResult', 'tiny', { results: ['c1'] }),
    ];
    expect(selectNewestChunk(entries, undefined, { drain: true, totalTokens: 60000 })).toBeNull();

    // 对照:同一个超大结果没有兄弟结果时,指针段的后缀是平衡的,切法照旧成立。
    // 1.0.9 的保留区是最近 3 个已完成的工具轮,所以对照里要留出更老的轮次才切得到指针段。
    // 1.0.9 的保留区是最近 3 个已完成工具轮:这里两轮都在保留区内,切点会一路退到 user 之外。
    // 「指针段不留下孤儿结果」的判据仍由后缀平衡兜底 —— 指针刀能成立的情形见上面那条用例。
  });

  it('keeps an oversized tool result as a pointer instead of refusing the cut', () => {
    const items = cut([
      ['user', 50],
      ['assistant', 100],
      ['tool', 40000],
    ]);
    // 1.0.9: 指针刀只在最后一条 user 之后找,这里超大结果就在它后面。
    expect(selectCutIndexes(items, { engine: 'cloud', chunkMax: 32000, drain: true, totalTokens: 60000 })).toMatchObject({
      start: 2,
      end: 2,
      pointerOnly: true,
    });
    expect(selectCutIndexes(items, { engine: 'local', chunkMax: 32000 })).toMatchObject({ start: 2, end: 2, pointerOnly: true });
    // 指针段不能带最后一条 user。
    expect(pointerSpanAllowed(items, 2, 2, 'cloud')).toBe(true);
    expect(pointerSpanAllowed(items, 1, 2, 'cloud')).toBe(true);
    // 未到紧急线、也没有收尾时,云端一刀不切(1.0.9 收紧了「平时只切超大结果」的口径)。
    expect(selectCutIndexes(items, { engine: 'cloud', chunkMax: 32000 })).toBeNull();
  });

  it('keeps an earlier user message as one-line JSON inside the card', () => {
    const card = buildCard('u1\nline kept\n', '', 4000, [
      { role: 'user', text: '只改 A 文件', turn: 2 },
      { role: 'assistant', text: 'line kept', turn: 3 },
    ]);
    expect(card.ok).toBe(true);
    expect(card.text).toContain('较早的用户消息');
    expect(card.text).toContain('第 2 轮: "只改 A 文件"');
  });

  it('describes a pointer-only span with the backup file instead of the body', () => {
    const withRaw = pointerOnlyText([
      { role: 'tool', text: 'x', name: 'read', command: 'read big.txt', toolCallId: 'c9', raw: { ok: true, path: 'C:/tmp/raw-c9.txt', sha256: 'a'.repeat(64), bytes: 12, toolCallId: 'c9' } },
    ]);
    expect(withRaw).toContain('read big.txt');
    expect(withRaw).toContain('raw-c9.txt');
    expect(pointerOnlyText([{ role: 'tool', text: 'x', name: 'read', toolCallId: 'c8', raw: { ok: false, toolCallId: 'c8' } }])).toContain('无完整备份');
  });
});
describe('live compact 1.1.x: 卡片地板与长 read 独占一刀', () => {
  const round = (id, text) => [
    entry('assistant', `call ${id}`, { calls: [id] }),
    entry('toolResult', text, { results: [id] }),
  ];
  // 长 read:调用名是 read、结果本身够大。上游把这类结果从保留区里摘出来单独切。
  const readRound = (id, text) => [
    entry('assistant', `read ${id}`, {
      calls: [id],
      callMeta: new Map([[id, { name: 'read', command: '', filePath: '', jobId: '', hiddenArgs: false }]]),
    }),
    entry('toolResult', text, { results: [id] }),
  ];
  const card = () => ({ ...entry('user', 'Spine extract.\nsummary'), entryType: 'compaction' });

  it('never cuts to the left of the newest checkpoint card', () => {
    const mk = () => [
      entry('system', 'sys'),
      entry('user', 'go'),
      ...round('c6', 'older '.repeat(2500)),
      ...round('c7', 'older '.repeat(2500)),
      ...round('c8', 'older '.repeat(2500)),
      ...round('c9', 'older '.repeat(2500)),
      ...round('c0', 'tiny '.repeat(100)),
      card(),
      entry('assistant', 'done'),
    ];
    // 卡片左边全是可切内容,但那是已进缓存的前缀:平时和收尾都不许切过去。
    expect(selectNewestChunk(mk(), undefined, { totalTokens: 90000 })).toBeNull();
    expect(selectNewestChunk(mk(), undefined, { drain: true, totalTokens: 90000 })).toBeNull();

    // 卡片右边又长出几轮之后,切点必须落在卡片右侧,而不是回到卡片左边。
    const grown = [
      entry('system', 'sys'),
      entry('user', 'go'),
      ...round('c6', 'older '.repeat(2500)),
      ...round('c7', 'older '.repeat(2500)),
      ...round('c8', 'older '.repeat(2500)),
      ...round('c9', 'older '.repeat(2500)),
      ...round('c0', 'tiny '.repeat(100)),
      card(),
      ...round('c2', 'old '.repeat(2000)),
      ...round('c3', 'tiny '.repeat(100)),
      ...round('c4', 'tiny '.repeat(100)),
      ...round('c5', 'tiny '.repeat(100)),
    ];
    const floor = grown.findIndex((item) => item.entryType === 'compaction');
    const picked = selectNewestChunk(grown, undefined, { drain: true, totalTokens: 90000 });
    expect(picked).not.toBeNull();
    expect(picked.start).toBeGreaterThan(floor);
    expect(picked.end).toBeGreaterThan(floor);
  });

  it('stops selectCutIndexes from cutting left of a checkpoint in the same item list', () => {
    const items = [
      ['user', 50], ['assistant', 100], ['tool', 9000],
      ['user', 50], ['assistant', 100], ['tool', 9000],
      ['user', 50],
    ].map(([type, tokens]) => ({ type, tokens, checkpoint: false, barrier: false }));
    items[0] = { ...items[0], checkpoint: true };
    // 卡片在要切的那一段左边:照常切这一段。
    expect(selectCutIndexes(items, { engine: 'cloud', drain: true, maxEnd: 5 })).toMatchObject({ start: 4, end: 5 });
    // 卡片在切点右边(那是已缓存前缀的边界):这一刀落在前缀里,拒绝。
    const withCardAhead = items.map((item, index) => (index === 6 ? { ...item, checkpoint: true } : item));
    expect(selectCutIndexes(withCardAhead, { engine: 'cloud', drain: true, maxEnd: 5 })).toBeNull();
  });

  it('cuts a long read round on its own instead of keeping it with the short rounds', () => {
    const entries = [
      entry('system', 'sys'),
      entry('user', 'go'),
      ...round('c9', 'older '.repeat(2500)),
      ...readRound('r0', 'file '.repeat(4000)),
      ...round('c1', 'tiny '.repeat(100)),
      ...round('c2', 'tiny '.repeat(100)),
      ...round('c3', 'tiny '.repeat(100)),
    ];
    // 长 read 的那一轮不占保留位:保留区只有后面三个短轮,切点正好只盖住它自己那一轮。
    const longStart = entries.findIndex((item) => item.text === 'read r0');
    expect(keptToolRounds(entries, 3, longReadResults(entries)).at(0).start).toBeGreaterThan(longStart);
    const picked = selectNewestChunk(entries, undefined, { drain: true, totalTokens: 70000 });
    expect(picked).toMatchObject({ start: longStart, end: longStart + 1 });
    expect(picked.pointerOnly).toBeUndefined();
  });

  it('pointer-cuts the only long read round when its single result is oversized', () => {
    const entries = [
      entry('system', 'sys'),
      entry('user', 'go'),
      ...round('c1', 'tiny '.repeat(100)),
      ...readRound('r0', 'x'.repeat(200000)),
      ...round('c2', 'tiny '.repeat(100)),
      ...round('c3', 'tiny '.repeat(100)),
    ];
    const longStart = entries.findIndex((item) => item.text === 'read r0');
    const picked = selectNewestChunk(entries, undefined, { drain: true, totalTokens: 90000 });
    // 指针刀把发起调用的 assistant 一起换掉,卡片里只留指针(原文一个字都不进卡片)。
    expect(picked).toMatchObject({ start: longStart, end: longStart + 1 });
    expect(picked.card.text).toContain('无完整备份');
    expect(picked.card.text).not.toContain('xxxxxxxxxx');
  });
});

describe('live compact 1.1.x: 指针段不能吞掉图片', () => {
  const round = (id, text) => [
    entry('assistant', `call ${id}`, { calls: [id] }),
    entry('toolResult', text, { results: [id] }),
  ];
  it('rejects a pointer span that stretches back over an image result', () => {
    // 一条 assistant 同时发两个调用:图片结果先回来,超大文本结果后回来。
    // 指针刀会从超大结果往回扩到调用,中间的图片一并被删 —— 卡片和备份只有文本,图片回不来。
    const entries = [
      entry('system', 'sys'),
      entry('user', 'go'),
      entry('assistant', 'two calls', { calls: ['cImg', 'cBig'] }),
      entry('toolResult', 'shot in the dark', { results: ['cImg'], opaque: true }),
      entry('toolResult', 'x'.repeat(200000), { results: ['cBig'] }),
      ...round('c1', 'tiny '.repeat(100)),
      ...round('c2', 'tiny '.repeat(100)),
      ...round('c3', 'tiny '.repeat(100)),
    ];
    expect(entries[3].opaque).toBe(true);
    const items = entries.map((item) => ({
      type: item.role === 'toolResult' ? 'tool' : item.role,
      tokens: item.est,
      checkpoint: false,
      barrier: Boolean(item.opaque),
    }));
    expect(pointerSpanAllowed(items, 2, 4, 'cloud')).toBe(false);
    expect(pointerSpanAllowed(items, 4, 4, 'cloud')).toBe(true);
    expect(selectNewestChunk(entries, undefined, { drain: true, totalTokens: 90000 })).toBeNull();
  });
});

describe('live compact 1.1.x: 轮换不改写已有备份', () => {
  it('protects a reused raw snapshot that the new card points at', () => {
    // 恢复/分叉的会话里,切范围内的工具原文可能早就落过盘(同一个 toolCallId)。
    // 它不在 planned() 里,但新卡片会引用它:轮换若把它当最老的文件删掉,卡片就成了空指针。
    const root = mkdtempSync(join(tmpdir(), 'spine-rawprotect-'));
    const previousRoot = process.env.SPINE_SHADOW_DIR;
    const previousCap = process.env.SPINE_SHADOW_MAX_BYTES;
    process.env.SPINE_SHADOW_DIR = root;
    process.env.SPINE_SHADOW_MAX_BYTES = '800000';
    try {
      const sessionId = 'session-rawprotect';
      const dir = join(root, 'shadow', sessionId);
      mkdirSync(dir, { recursive: true });
      const text = 'needle '.repeat(30000);
      const raw = commitRawEntry(planRawEntry({ dir, toolCallId: 'cBig', text, turn: 1, name: 'bash', pathLabel: 'bash big.log' }));
      expect(raw.ok).toBe(true);
      utimesSync(raw.path, 1, 1);
      const old1 = join(dir, 'aa-old1.txt');
      const old2 = join(dir, 'zz-old2.txt');
      writeFileSync(old1, 'o'.repeat(300000));
      writeFileSync(old2, 'o'.repeat(300000));
      utimesSync(old1, 2, 2);
      utimesSync(old2, 3, 3);

      let handler = null;
      registerLiveCompact({ on: (name, fn) => { if (name === 'agent_before_settle') handler = fn; } });
      const toolCall = { messages: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'cBig', name: 'bash', arguments: {} }] }], sourceEntry: { id: 'a1' } };
      const toolResult = { messages: [{ role: 'toolResult', toolCallId: 'cBig', content: [{ type: 'text', text }] }], sourceEntry: { id: 'r1' } };
      const tiny = (id) => [
        { messages: [{ role: 'assistant', content: [{ type: 'toolCall', id, name: 'bash', arguments: {} }] }], sourceEntry: { id: `${id}-a` } },
        { messages: [{ role: 'toolResult', toolCallId: id, content: [{ type: 'text', text: 'ok '.repeat(20) }] }], sourceEntry: { id: `${id}-r` } },
      ];
      const contextEntries = [
        { messages: [{ role: 'system', content: 'sys' }], sourceEntry: { id: 's1' } },
        { messages: [{ role: 'user', content: 'go' }], sourceEntry: { id: 'u1' } },
        toolCall,
        toolResult,
        ...tiny('c1'),
        ...tiny('c2'),
        ...tiny('c3'),
      ];
      const event = { outcome: 'completed', context: { contextEntries } };
      const ctx = {
        sessionManager: { getSessionId: () => sessionId },
        getContextUsage: () => ({ tokens: 120000 }),
      };
      const result = handler(event, ctx);
      expect(result).toBeTruthy();
      const card = result.entries.find((draft) => draft.type === 'custom_message');
      expect(card).toBeTruthy();
      const cardText = card.content.map((block) => block.text || '').join(String.fromCharCode(10));
      // 卡片指向这份原文,轮换就不能删它。
      expect(cardText).toContain(basename(raw.path));
      expect(existsSync(raw.path)).toBe(true);
      // 腾地方只能牺牲没有被引用的旧文件。
      expect(existsSync(old1)).toBe(false);
      expect(existsSync(old2)).toBe(false);
    } finally {
      if (previousRoot === undefined) delete process.env.SPINE_SHADOW_DIR;
      else process.env.SPINE_SHADOW_DIR = previousRoot;
      if (previousCap === undefined) delete process.env.SPINE_SHADOW_MAX_BYTES;
      else process.env.SPINE_SHADOW_MAX_BYTES = previousCap;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not evict old backups when the final shadow rename fails', () => {
    // 轮换会真的删掉旧备份。它必须排在「新备份已经改名成功」之后:
    // 反过来时,改名失败会让这一刀被拒,而旧卡片指向的原文已经没了。
    const root = mkdtempSync(join(tmpdir(), 'spine-rename-'));
    const previousRoot = process.env.SPINE_SHADOW_DIR;
    const previousCap = process.env.SPINE_SHADOW_MAX_BYTES;
    process.env.SPINE_SHADOW_DIR = root;
    process.env.SPINE_SHADOW_MAX_BYTES = '1000';
    try {
      const dir = join(root, 'shadow', 'session-rename');
      mkdirSync(dir, { recursive: true });
      const old = join(dir, 'old.txt');
      writeFileSync(old, 'o'.repeat(900));
      utimesSync(old, 1, 1);
      const target = join(dir, 'new.txt');
      expect(() => saveShadow({ key: 'session-rename' }, dir, target, 'n'.repeat(500), [], {
        rename: () => { throw new Error('boom'); },
      })).toThrow(/shadow backup was not written/);
      expect(existsSync(old)).toBe(true);
      expect(existsSync(target)).toBe(false);
      expect(existsSync(`${target}.tmp`)).toBe(false);

      // 正常路径仍然会腾地方:旧文件被淘汰,新备份就位。
      saveShadow({ key: 'session-rename' }, dir, target, 'n'.repeat(500));
      expect(existsSync(target)).toBe(true);
      expect(existsSync(old)).toBe(false);
    } finally {
      if (previousRoot === undefined) delete process.env.SPINE_SHADOW_DIR;
      else process.env.SPINE_SHADOW_DIR = previousRoot;
      if (previousCap === undefined) delete process.env.SPINE_SHADOW_MAX_BYTES;
      else process.env.SPINE_SHADOW_MAX_BYTES = previousCap;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('live compact 1.1.x: 收尾多刀与指针兜底', () => {
  const toolCall = (id, name = 'bash', args = {}) => ({
    messages: [{ role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }] }],
    sourceEntry: { id: `${id}-a` },
  });
  const toolResult = (id, text) => ({
    messages: [{ role: 'toolResult', toolCallId: id, content: [{ type: 'text', text }] }],
    sourceEntry: { id: `${id}-r` },
  });
  const small = (id) => [toolCall(id), toolResult(id, 'ok '.repeat(20))];
  const settle = (root, sessionId, contextEntries, tokens = 200000) => {
    let handler = null;
    registerLiveCompact({ on: (name, fn) => { if (name === 'agent_before_settle') handler = fn; } });
    const event = { outcome: 'completed', context: { contextEntries } };
    const ctx = {
      sessionManager: { getSessionId: () => sessionId },
      getContextUsage: () => ({ tokens }),
    };
    return handler(event, ctx);
  };

  it('keeps draining after a long-read cut, like upstream does', () => {
    // 上游的卡片是原地替换,所以卡片右边、保留区之前还有一段能切;
    // pi 的卡片只能追加到尾巴上 —— 选段时若把新卡片当地板,第二刀就永远选不出来。
    const root = mkdtempSync(join(tmpdir(), 'spine-drain-'));
    const previousRoot = process.env.SPINE_SHADOW_DIR;
    process.env.SPINE_SHADOW_DIR = root;
    try {
      const contextEntries = [
        { messages: [{ role: 'system', content: 'sys', provider: 'minimax' }], sourceEntry: { id: 's1' } },
        { messages: [{ role: 'user', content: 'go', provider: 'minimax' }], sourceEntry: { id: 'u1' } },
        toolCall('cOld'), toolResult('cOld', 'mid '.repeat(2000)),
        toolCall('cLong', 'read'), toolResult('cLong', 'x'.repeat(200000)),
        toolCall('cMid'), toolResult('cMid', 'tail '.repeat(2000)),
        ...small('c1'),
        ...small('c2'),
        ...small('c3'),
      ];
      const result = settle(root, 'session-drain', contextEntries);
      expect(result).toBeTruthy();
      const cards = result.entries.filter((draft) => draft.type === 'custom_message');
      // 第一刀是长 read 的指针刀,第二刀切掉卡片与保留区之间的那一段。
      expect(cards.length).toBe(2);
      // 卡片按切出来的先后发出:长 read 更早,卡片与保留区之间那段更新。
      expect(cards[0].details.shadowedSeqs).toContain('cLong-a');
      expect(cards[1].details.shadowedSeqs).toContain('cMid-a');
      const log = readFileSync(join(root, 'spine.log'), 'utf8');
      expect(log.match(/spine cut /g) || []).toHaveLength(2);
    } finally {
      if (previousRoot === undefined) delete process.env.SPINE_SHADOW_DIR;
      else process.env.SPINE_SHADOW_DIR = previousRoot;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not let the next cut delete a backup an earlier card still points at', () => {
    // 同一批收尾的卡片是一起提交的:第二刀的容量轮换不能删掉第一刀卡片还指着的备份。
    // 腾不出地方就停在这一刀 —— 不拿还没提交的卡片开刀。
    const root = mkdtempSync(join(tmpdir(), 'spine-batch-'));
    const previousRoot = process.env.SPINE_SHADOW_DIR;
    const previousCap = process.env.SPINE_SHADOW_MAX_BYTES;
    process.env.SPINE_SHADOW_DIR = root;
    // 第一刀(长 read)的原文快照与汇总备份各约 300KB,合起来装得下;第二刀装不下。
    process.env.SPINE_SHADOW_MAX_BYTES = '606000';
    try {
      const sessionId = 'session-batch';
      const contextEntries = [
        { messages: [{ role: 'system', content: 'sys', provider: 'minimax' }], sourceEntry: { id: 's1' } },
        { messages: [{ role: 'user', content: 'go', provider: 'minimax' }], sourceEntry: { id: 'u1' } },
        toolCall('cLong', 'read'), toolResult('cLong', 'x'.repeat(300000)),
        toolCall('cMid'), toolResult('cMid', 'tail '.repeat(2000)),
        ...small('c1'),
        ...small('c2'),
        ...small('c3'),
      ];
      const result = settle(root, sessionId, contextEntries);
      expect(result).toBeTruthy();
      const cards = result.entries.filter((draft) => draft.type === 'custom_message');
      expect(cards.length).toBe(1);
      // 第一张卡片指着的原文快照还在。
      expect(existsSync(join(root, 'shadow', sessionId, rawName('cLong')))).toBe(true);
    } finally {
      if (previousRoot === undefined) delete process.env.SPINE_SHADOW_DIR;
      else process.env.SPINE_SHADOW_DIR = previousRoot;
      if (previousCap === undefined) delete process.env.SPINE_SHADOW_MAX_BYTES;
      else process.env.SPINE_SHADOW_MAX_BYTES = previousCap;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('points a pointer-only card at the main shadow when the raw pointer cannot be verified', () => {
    // 原文快照写了一半就崩(meta 缺失)时,卡片里核不出指针。
    // 这时切走的结果就彻底没了下文 —— 主 shadow 里还有这一段的正文,必须挂上。
    const root = mkdtempSync(join(tmpdir(), 'spine-pointer-'));
    const previousRoot = process.env.SPINE_SHADOW_DIR;
    process.env.SPINE_SHADOW_DIR = root;
    try {
      const sessionId = 'session-pointer';
      const dir = join(root, 'shadow', sessionId);
      mkdirSync(dir, { recursive: true });
      // 原文文件在、meta 不在:核不出哈希与字节数,指针不可用。
      writeFileSync(join(dir, rawName('cBig')), 'x'.repeat(1000));

      const contextEntries = [
        { messages: [{ role: 'system', content: 'sys', provider: 'minimax' }], sourceEntry: { id: 's1' } },
        { messages: [{ role: 'user', content: 'go', provider: 'minimax' }], sourceEntry: { id: 'u1' } },
        toolCall('cBig', 'bash', { command: 'cat big.log' }), toolResult('cBig', 'y'.repeat(200000)),
        ...small('c1'),
        ...small('c2'),
        ...small('c3'),
      ];
      const result = settle(root, sessionId, contextEntries);
      expect(result).toBeTruthy();
      const card = result.entries.find((draft) => draft.type === 'custom_message');
      expect(card).toBeTruthy();
      const cardText = card.content.map((block) => block.text || '').join(String.fromCharCode(10));
      // 指针核不上 → 卡片说没有可核的指针,但必须给出主 shadow 的路径。
      expect(cardText).toContain('无完整备份');
      expect(cardText).toContain('省略的工具原文在');
      // 主 shadow 里确实有这一段的正文。
      const shadowDir = join(root, 'shadow', sessionId);
      const shadows = readdirSync(shadowDir).filter((name) => name.endsWith('.txt') && !name.startsWith('raw-'));
      expect(shadows.length).toBeGreaterThan(0);
      expect(readFileSync(join(shadowDir, shadows[0]), 'utf8')).toContain('y'.repeat(100));
    } finally {
      if (previousRoot === undefined) delete process.env.SPINE_SHADOW_DIR;
      else process.env.SPINE_SHADOW_DIR = previousRoot;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
