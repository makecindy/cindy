import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// 扩展源码 import 的 pi 包不在本仓依赖里:测试只覆盖纯函数,喂一个最小替身。
vi.mock('@earendil-works/pi-coding-agent', () => ({
  estimateTokens: (message) => Math.ceil(JSON.stringify(message ?? '').length / 4),
  generateSummaryWithUsage: vi.fn(),
}));

// 凭证扫描会把任何形似密钥的字面量当硬命中(哪怕只是测试夹具),所以夹具一律拼接构造:
// 源码里不存在连续的密钥形态,运行时的值仍然满足 redactSecrets 的规则,用例照旧贴着真规则跑。
const FAKE_OPENAI_KEY = ['sk', 'fixture-openai-key-0123456789'].join('-');
const FAKE_BEARER = ['fixture', 'bearer-0123456789'].join('-');
const FAKE_AWS_KEY = ['AKIA', 'FIXTUREPLACEHOLDER01'].join('');
const FAKE_GOOGLE_KEY = ['AIza', 'FixturePlaceholderABCDEFGHIJKLMNOPQRST'].join('');
const FAKE_PASSWORD = ['fixture', 'plain-password'].join('-');
const FAKE_DB_PASSWORD = ['fixture', 'db-password'].join('-');
const FAKE_OPENAI_KEY_2 = ['sk', 'fixture-openai-key-0987654321'].join('-');
const FAKE_REFRESH_TOKEN = ['fixture', 'refresh', 'token', '0123456789'].join('-');
const FAKE_STRIPE_KEY = ['sk', 'live', 'fixturestripeplaceholder0123'].join('_');
const FAKE_BASIC = ['dXNlcjpw', 'YXNzd29yZA=='].join('');
const FAKE_AWS_SESSION_TOKEN = ['AWS_SESSION', 'TOKEN'].join('_') + '=fixture-session-' + '0123456789abcdef';
const FAKE_AWS_SECRET = ['fixture', 'awssecret', '0123456789abcdef'].join('-');
const FAKE_NPM_TOKEN = ['npm', 'fixture0123456789abcdef0123456789'].join('_');
const FAKE_GH_PAT = ['github', 'pat', 'fixture0123456789abcdef0123'].join('_');
const FAKE_GH_TOKEN = ['ghp', 'fixtureabcdefghijklmnopqrst'].join('_');
const FAKE_BRACKET_PASSWORD = ['abc', '[defghijklmnop'].join('');

const { selectNewestChunk, balanceIndexes, buildCard, redactSecrets, attachBackupHint, isToolFailure, rotateShadow, pruneShadowSessions, spineRoot, keptToolRounds, chooseKeptSpan, reservedCutEnd, toolEvidenceLine, pointerFor, captureToolResult, planRawEntry, commitRawEntry, verifiedRaw, resolveEngine, selectCutIndexes, pointerSpanAllowed, pointerOnlyText, spineEntries, writeOwner, orderedDrainDrafts, withBackupHint, withoutFullBackupClaim, backupHint, discardRawSnapshots } = await import(
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

  it('masks credential shapes before a shadow file is written', () => {
    const raw = [
      `export OPENAI_API_KEY=${FAKE_OPENAI_KEY}`,
      `curl -H "Authorization: Bearer ${FAKE_BEARER}"`,
      'password: "' + FAKE_PASSWORD + '"',
      'normal text stays untouched: sk-short',
    ].join(String.fromCharCode(10));
    const out = redactSecrets(raw);
    expect(out).not.toContain(FAKE_OPENAI_KEY);
    expect(out).not.toContain(FAKE_BEARER);
    expect(out).not.toContain(FAKE_PASSWORD);
    expect(out).toContain('[REDACTED]');
    // 小于阈值的普通文本不能被误伤。
    expect(out).toContain('sk-short');
    // JSON 形态:闭引号夹在键名与冒号之间,也要按同一套规则打码。
    const json = redactSecrets('{"password":"example-password-value","api_key":"example-api-key-value"}');
    expect(json).not.toContain('example-password-value');
    expect(json).not.toContain('example-api-key-value');
    expect(json).toContain('"password":"[REDACTED]"');
    // 带后缀的键名与 Stripe 分段前缀:JSON 的 refresh_token、X_SECRET_KEY=、sk_live_…
    const more = redactSecrets([
      `{"refresh_token":"${FAKE_REFRESH_TOKEN}"}`,
      `STRIPE_SECRET_KEY=${FAKE_STRIPE_KEY}`,
    ].join(String.fromCharCode(10)));
    expect(more).not.toContain(FAKE_REFRESH_TOKEN);
    expect(more).not.toContain(FAKE_STRIPE_KEY);
    expect(more).toContain('[REDACTED]');
    // AWS_SECRET_ACCESS_KEY 这类 `_ACCESS_KEY` 后缀,以及密码里带方括号(不能因 `[` 提前截断)。
    const aws = redactSecrets([
      `AWS_SECRET_ACCESS_KEY=${FAKE_AWS_SECRET}`,
      `password="${FAKE_BRACKET_PASSWORD}"`,
    ].join(String.fromCharCode(10)));
    expect(aws).not.toContain(FAKE_AWS_SECRET);
    expect(aws).not.toContain(FAKE_BRACKET_PASSWORD);
    expect(aws).toContain('AWS_SECRET_ACCESS_KEY=[REDACTED]');
    expect(aws).toContain('password="[REDACTED]"');
    // HTTP Basic 认证头:base64 里是可直接复用的用户名口令。
    const basic = redactSecrets(`Authorization: Basic ${FAKE_BASIC}`);
    expect(basic).not.toContain(FAKE_BASIC);
    expect(basic).toContain('Authorization: Basic [REDACTED]');
    // JSON 形态:冒号后带引号,方案名前面还隔着 `"`。
    const quoted = redactSecrets(`{"Authorization":"Basic ${FAKE_BASIC}"}`);
    expect(quoted).not.toContain(FAKE_BASIC);
    expect(quoted).toContain('"Basic [REDACTED]');
    // Digest 是参数串,不能只打码掉 `username=` 就收工。
    const digest = redactSecrets(`Authorization: Digest username="alice", response="${FAKE_BASIC}", nonce="abc"`);
    expect(digest).not.toContain('alice');
    expect(digest).not.toContain(FAKE_BASIC);
    expect(digest).toContain('Authorization: Digest [REDACTED]');
    // 认证头之外的内容不能被这条规则吃掉。
    const plain = redactSecrets('POST /api/v1/items 201 (authorization flow)');
    expect(plain).toBe('POST /api/v1/items 201 (authorization flow)');
    // AWS 的会话令牌是另一套键名(`_SESSION_TOKEN`),不带 access_key 后缀。
    const sessionToken = redactSecrets(FAKE_AWS_SESSION_TOKEN);
    expect(sessionToken).not.toContain('fixture-session-0123456789abcdef');
    expect(sessionToken).toContain('=[REDACTED]');
  });

  it('redaction corpus: every credential form surfaced in review, plus a negative corpus', () => {
    // 十多轮 review 的漏点全是「下划线大写 + 敏感后缀」的新组合;键名规则已按类匹配(以
    // KEY/TOKEN/SECRET/... 结尾即命中)。以后再发现新形态,只需要往这两张表各加一行。
    const positives = [
      [`AWS_SECRET_ACCESS_KEY=${FAKE_AWS_SECRET}`, FAKE_AWS_SECRET],
      [`AWS_SESSION_TOKEN=${FAKE_AWS_SESSION_TOKEN.split('=')[1]}`, FAKE_AWS_SESSION_TOKEN.split('=')[1]],
      [`NPM_TOKEN=${FAKE_NPM_TOKEN}`, FAKE_NPM_TOKEN],
      [`//registry.npmjs.org/:_authToken=${FAKE_NPM_TOKEN}`, FAKE_NPM_TOKEN],
      [`STRIPE_SECRET_KEY=${FAKE_STRIPE_KEY}`, FAKE_STRIPE_KEY],
      [`OPENAI_API_KEY=${FAKE_OPENAI_KEY}`, FAKE_OPENAI_KEY],
      [`GITHUB_TOKEN=${FAKE_GH_TOKEN}`, FAKE_GH_TOKEN],
      [`2FA_TOKEN=${FAKE_REFRESH_TOKEN}`, FAKE_REFRESH_TOKEN],
      [`{"OAUTH_TOKEN":"${FAKE_REFRESH_TOKEN}"}`, FAKE_REFRESH_TOKEN],
      [`Authorization: Basic ${FAKE_BASIC}`, FAKE_BASIC],
      [`{"Authorization":"Basic ${FAKE_BASIC}"}`, FAKE_BASIC],
      [`Authorization: Digest username="alice", response="${FAKE_BASIC}", nonce="abc"`, FAKE_BASIC],
      [`password="${FAKE_BRACKET_PASSWORD}"`, FAKE_BRACKET_PASSWORD],
      [`postgres://cindy:${FAKE_DB_PASSWORD}@db.internal:5432/app`, FAKE_DB_PASSWORD],
      [`echo ${FAKE_NPM_TOKEN}`, FAKE_NPM_TOKEN],
      [`echo ${FAKE_GH_PAT}`, FAKE_GH_PAT],
    ];
    for (const [text, secret] of positives) {
      const out = redactSecrets(text);
      expect(out, text).not.toContain(secret);
      expect(out, text).toContain('[REDACTED]');
    }
    // 负语料:普通配置键、以 KEY 结尾的普通词、哈希与文档文本不能被误伤。
    const negatives = [
      'USE_MONKEY=monkeybusiness12',
      'x-sector=sector-value-12345',
      'author=alice@example.com',
      'tokenize=input12345',
      'sha256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      'MAX_TOKENS=4096 MODEL_TOKEN_LIMIT=8192',
      'NEXT_PUBLIC_API_URL=https://api.example.com/v1',
      'POST /api/v1/items 201 (authorization flow)',
      'npm_install_the_dev_dependencies_now',
    ];
    for (const text of negatives) {
      expect(redactSecrets(text), text).toBe(text);
    }
    // 打码必须幂等:同一段文本过两遍规则,结果不再变化。
    const once = redactSecrets(`AWS_SESSION_TOKEN=${FAKE_AWS_SESSION_TOKEN.split('=')[1]}${String.fromCharCode(10)}Authorization: Basic ${FAKE_BASIC}`);
    expect(redactSecrets(once)).toBe(once);
  });

  it('stays linear on long uppercase runs without a sensitive suffix', () => {
    // 起始边界被删掉的话,128K 连续大写会让这条规则跑 25 秒(实测),而它在同步的
    // settle 钩子里。阈值给到 2 秒:线性实现 <5ms,只有退化成 O(n²) 才会超。
    const wall = 'A'.repeat(128000) + ' padding text without any separator';
    const start = Date.now();
    redactSecrets(wall);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('masks cloud keys, connection-string passwords and PEM blocks', () => {
    // 工具结果里最常见的是「跑一条命令把凭证打出来」,这几种形态必须一起打码。
    // 私钥块同样按扫描规则拼接:源码里不出现连续的 "-----BEGIN … PRIVATE KEY-----" 形态。
    const pemEdge = (edge) => ['-----', edge, ' PRIVATE KEY-----'].join('');
    const pem = [pemEdge('BEGIN OPENSSH'), 'b3BlbnNzaC1rZXk', pemEdge('END OPENSSH')].join(String.fromCharCode(10));
    const raw = [
      `AWS_ACCESS_KEY_ID=${FAKE_AWS_KEY}`,
      `google key ${FAKE_GOOGLE_KEY}`,
      'DATABASE_URL=postgres://cindy:' + FAKE_DB_PASSWORD + '@db.internal:5432/app',
      pem,
    ].join(String.fromCharCode(10));
    const out = redactSecrets(raw);
    expect(out).not.toContain(FAKE_AWS_KEY);
    expect(out).not.toContain(FAKE_GOOGLE_KEY);
    expect(out).not.toContain(FAKE_DB_PASSWORD);
    expect(out).not.toContain('b3BlbnNzaC1rZXk');
    // 键名包着私钥块(`private_key="-----BEGIN ..."`):整块必须整体打码。
    // 若整块规则排在键名规则后面,`-----BEGIN` 先被换掉,开始标记没了,正文会原样留下。
    const wrapped = redactSecrets('private_key="' + pem + '"');
    expect(wrapped).not.toContain('b3BlbnNzaC1rZXk');
    expect(wrapped).not.toContain('OPENSSH');
    expect(wrapped).toContain('private_key=');
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

  it('plans a raw pointer without touching disk, redacts secrets before writing, hashes the saved bytes', () => {
    // 卡片先指向路径、切割被接受后才落盘;落盘内容与哈希必须是同一份脉敏后的字节。
    const dir = mkdtempSync(join(tmpdir(), 'spine-plan-'));
    try {
      const text = `export OPENAI_API_KEY=${FAKE_OPENAI_KEY_2}\nline two`;
      const planned = planRawEntry({ dir, toolCallId: 'c9', text });
      expect(planned.ok).toBe(true);
      expect(planned.pending).toBe(true);
      expect(existsSync(planned.path)).toBe(false);
      expect(planned.body).not.toContain(FAKE_OPENAI_KEY_2);
      expect(verifiedRaw(planned).ok).toBe(true);
      // 指针里的字节数必须是数字:把 Buffer 塞进去会把整段正文带进卡片。
      expect(typeof verifiedRaw(planned).bytes).toBe('number');
      expect(pointerFor(verifiedRaw(planned))).not.toContain('line two');
      const committed = commitRawEntry(planned);
      expect(committed.pending).toBeUndefined();
      expect(verifiedRaw(committed).ok).toBe(true);
      expect(readFileSync(committed.path, 'utf8')).not.toContain(FAKE_OPENAI_KEY_2);
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
    expect(resolveEngine({ provider: 'ollama', env: {} })).toEqual({ engine: 'local', source: 'provider' });
    expect(resolveEngine({ provider: 'minimax', env: {} })).toEqual({ engine: 'cloud', source: 'provider' });
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
    // pi 只能把卡片追加到尾巴上,而收尾是从新往旧切;不倒回来最老的摘要会落在最下面。
    const newest = { type: 'custom_message', content: [{ type: 'text', text: 'newest span' }] };
    const oldest = { type: 'custom_message', content: [{ type: 'text', text: 'oldest span' }] };
    const edit = { type: 'context_edit', targetId: 'e9', replacement: null };
    const out = orderedDrainDrafts([edit], [newest, oldest]);
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
    // 收尾模式不看保留区边界:总量还在水位之上就继续切(这里切到最新一轮)。
    expect(selectCutIndexes(items, { engine: 'cloud', totalTokens: 40000, drain: true, maxEnd: 2 })).toMatchObject({
      start: 7,
      end: 8,
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
    // 后面三轮都太小,凑够 CHUNK_MIN 就必须跨过带图的那一轮 —— 所以这里只能不切。
    expect(selectNewestChunk(entries, undefined, { drain: true, totalTokens: 60000 })).toBeNull();
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

    // 对照:同一个超大结果独占一条调用消息时,指针切法照旧成立。
    const control = [
      entry('system', 'sys'),
      entry('user', 'older'),
      entry('assistant', 'call', { calls: ['c9'] }),
      entry('toolResult', 'older result '.repeat(400), { results: ['c9'] }),
      entry('user', 'read one thing'),
      entry('assistant', 'call', { calls: ['c0'] }),
      entry('toolResult', huge, { results: ['c0'] }),
    ];
    const pointerCut = selectNewestChunk(control, undefined, { drain: true, totalTokens: 60000 });
    expect(pointerCut).toMatchObject({ start: 5, end: 6 });
  });

  it('keeps an oversized tool result as a pointer instead of refusing the cut', () => {
    const items = cut([
      ['user', 50],
      ['assistant', 100],
      ['tool', 40000],
      ['user', 50],
      ['assistant', 100],
      ['tool', 500],
    ]);
    const picked = selectCutIndexes(items, { engine: 'cloud', chunkMax: 32000 });
    expect(picked).toMatchObject({ start: 2, end: 2, pointerOnly: true });
    // 指针段不能带最后一条 user。
    expect(pointerSpanAllowed(items, 2, 2, 'cloud')).toBe(true);
    expect(pointerSpanAllowed(items, 1, 2, 'cloud')).toBe(true);
    expect(pointerSpanAllowed(items, 2, 3, 'cloud')).toBe(false);
    // 本地切法整段必须在最后一条 user 之后:这条超大的在它前面,不能动。
    expect(selectCutIndexes(items, { engine: 'local', chunkMax: 32000 })).toBeNull();
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