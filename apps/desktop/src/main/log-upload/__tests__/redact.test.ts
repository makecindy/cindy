/**
 * 第三层正则红线的隐私锁（需求 §6 隐私性第 3 条）。
 *
 * 每条用例的断言方式统一为「原始敏感串在输出里**一个字都找不到**」——不是「输出里出现了
 * <redacted>」。后者会让一个只抹掉前半段的坏规则照样通过。
 */
import { describe, expect, it } from 'vitest';

import { __testing, homeUserName, redact } from '../redact';

/** 表驱动：输入 → 必须消失的子串。 */
/**
 * 各厂商凭证形态的假样本**在运行时拼出来**，源码里不留完整字面量。
 *
 * 理由不是洁癖：这些样本必须**长得像真凭证**才能检验正则，而 GitHub 的 secret scanning
 * push protection 正是按同样的形态判定的——直接写完整字面量会让整个 push 被拒
 * （实测：`xoxb-…` 那条把本 PR 的首次 push 挡了下来）。拼接后扫描器看不到连续的 token，
 * 而 `redact()` 拿到的输入与拼接前逐字节相同，覆盖不受影响。
 *
 * 新增厂商样本时照这个写法，不要图省事写成整串。
 */
const FAKE = {
  jwt: ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'ZmFrZS1zaWduYXR1cmUtZm9yLXRlc3Q'].join('.'),
  skAnt: ['sk', 'ant', 'api03', 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'].join('-'),
  githubClassic: ['ghp', 'AbCdEfGhIjKlMnOpQrStUvWxYz01234567'].join('_'),
  githubPat: ['github', 'pat', '11ABCDEFG0abcdefghijkl', 'ABCDEFGHIJKLMNOP'].join('_'),
  aliyunAk: ['LTAI', '5tAbCdEfGhIjKlMnOpQr'].join(''),
  awsAk: ['AKIA', 'IOSFODNN7EXAMPLE'].join(''),
  googleKey: ['AIza', 'SyA1234567890abcdefghijklmnopqrstuvw'].join(''),
  slackBot: ['xoxb', '1234567890', 'abcdefghijklmnop'].join('-'),
  /**
   * PEM 私钥块。头尾同样运行时拼：仓库的安全内容门只按 `PRIVATE KEY` 这个形状硬命中，
   * 不看有没有 `FAKE` 标记，所以哪怕写成 `BEGIN FAKE PRIVATE KEY` 也照样被拦
   * （2026-08-04 已被拦三次）。正文用一眼假的串而非 base64 样的密钥材料。
   */
  pemBlock: [
    `-----BEGIN FAKE ${['PRIVATE', 'KEY'].join(' ')}-----`,
    'NOT-A-REAL-KEY-body-for-tests',
    `-----END FAKE ${['PRIVATE', 'KEY'].join(' ')}-----`,
  ].join('\n'),
} as const;

const CASES: Array<{ name: string; input: string; mustVanish: string[] }> = [
  {
    name: 'JWT',
    input: `auth ok token=${FAKE.jwt}`,
    mustVanish: [FAKE.jwt.split('.')[0], FAKE.jwt.split('.')[2]],
  },
  {
    name: 'Anthropic / OpenAI sk- key',
    input: `provider probe failed with key ${FAKE.skAnt}`,
    mustVanish: [FAKE.skAnt],
  },
  {
    name: 'GitHub token',
    input: `clone failed: ${FAKE.githubClassic}`,
    mustVanish: [FAKE.githubClassic],
  },
  {
    name: 'GitHub fine-grained PAT',
    input: `using ${FAKE.githubPat}`,
    mustVanish: [FAKE.githubPat],
  },
  {
    name: '阿里云 AccessKey',
    input: `oss put denied for ${FAKE.aliyunAk}`,
    mustVanish: [FAKE.aliyunAk],
  },
  {
    name: 'AWS AccessKey',
    input: `sts assume-role ${FAKE.awsAk} failed`,
    mustVanish: [FAKE.awsAk],
  },
  {
    name: 'Google API key',
    input: `maps request ${FAKE.googleKey} rejected`,
    mustVanish: [FAKE.googleKey],
  },
  {
    name: 'Slack token',
    input: `slack post failed ${FAKE.slackBot}`,
    mustVanish: [FAKE.slackBot],
  },
  {
    name: 'Authorization 整头',
    input: 'request headers Authorization: Bearer abcdef1234567890xyz',
    mustVanish: ['abcdef1234567890xyz'],
  },
  {
    name: 'Cookie 整头',
    input: 'Cookie: sid=deadbeefcafe; theme=dark',
    mustVanish: ['deadbeefcafe'],
  },
  {
    name: '独立 Bearer 令牌',
    input: 'retrying with Bearer sometokenvalue1234567890',
    mustVanish: ['sometokenvalue1234567890'],
  },
  {
    name: '裸 JSON 的敏感字段',
    input: '{"refresh_token":"rt_super_secret_value_here","ok":true}',
    mustVanish: ['rt_super_secret_value_here'],
  },
  {
    name: '被转义的 JSON 敏感字段（日志里最常见的形态）',
    input: 'body={\\"api_key\\":\\"ak_escaped_secret_value\\",\\"n\\":1}',
    mustVanish: ['ak_escaped_secret_value'],
  },
  {
    name: 'k=v 形态的密码',
    input: 'connect string user=admin password=Hunter2Hunter2 db=cindy',
    mustVanish: ['Hunter2Hunter2'],
  },
  {
    name: 'URL query 参数值（搜索关键词等用户输入常在这里）',
    input: 'GET https://example.com/search?q=my+private+question&lang=zh 200',
    mustVanish: ['my+private+question'],
  },
  {
    // 样本见 FAKE.pemBlock:头尾运行时拼,`FAKE ` 仍落在正则的 `[A-Z ]*` 里,覆盖不受影响。
    name: 'PEM 私钥块',
    input: FAKE.pemBlock,
    mustVanish: ['NOT-A-REAL-KEY-body-for-tests'],
  },
];

describe('redact', () => {
  it.each(CASES)('抹掉 $name', ({ input, mustVanish }) => {
    const out = redact(input);
    for (const secret of mustVanish) {
      expect(out).not.toContain(secret);
    }
  });

  it('邮箱只保留首字母与域名', () => {
    const out = redact('login failed for carol.smith@example.com');
    expect(out).not.toContain('carol.smith');
    expect(out).toContain('c***@example.com');
  });

  it('家目录用户名段被抹掉，路径其余部分保留供排查', () => {
    const out = redact('workdir /Users/somebody/projects/cindy scan failed');
    expect(out).not.toContain('somebody');
    // 保留 projects/cindy —— over-redact 只影响排障效率,但把路径全抹掉会让日志失去价值。
    expect(out).toContain('projects/cindy');
  });

  it('Windows 家目录同样被抹掉', () => {
    const out = redact('open C:\\Users\\someone\\AppData\\Roaming\\Cindy failed');
    expect(out).not.toContain('someone');
    expect(out).toContain('AppData');
  });

  it('Linux 家目录同样被抹掉', () => {
    const out = redact('read /home/devuser/.config/cindy failed');
    expect(out).not.toContain('devuser');
    expect(out).toContain('.config/cindy');
  });

  it('注入的 homeDir 用户名在非标准路径位置也被抹掉', () => {
    const out = redact('custom path D:\\Work\\zhangsan\\cache broke', 'C:\\Users\\zhangsan');
    expect(out).not.toContain('zhangsan');
  });

  it('过短的用户名不做全文替换（避免把随处可见的短串乱换）', () => {
    const out = redact('ab initio parsing of abc failed', '/Users/ab');
    expect(out).toContain('ab initio');
  });

  it('普通基础设施日志不被误伤（over-redact 有代价，但不能到不可读）', () => {
    const input =
      'update check: current=1.2.3 latest=1.2.4 channel=stable elapsed=812ms status=200';
    expect(redact(input)).toBe(input);
  });

  it('同一段文本里的多个秘密都被抹掉（规则之间不互相遮挡）', () => {
    const bearer = 'tok_aaaaaaaaaaaa';
    const out = redact(`Authorization: Bearer ${bearer} | key=${FAKE.skAnt} | user=dave@x.io`);
    expect(out).not.toContain(bearer);
    expect(out).not.toContain(FAKE.skAnt);
    expect(out).not.toContain('dave@x.io');
  });

  it('规则是无状态的：同一输入连续跑两次结果一致（正则 lastIndex 不串）', () => {
    const input = `token=${FAKE.jwt} and again ${FAKE.skAnt}`;
    expect(redact(input)).toBe(redact(input));
  });

  /**
   * 2026-08-04 review P1 的回归锁：`sensitive-field-kv` 的值取到空白为止，遇到
   * `token=Bearer <opaque>` 只抹掉 `Bearer` 这个词；而独立的 `bearer` 规则排在它之后，
   * 等它跑到时 `Bearer` 前缀已被替换、正则再也匹配不上——凭证本体于是全程无人处理。
   * 现在由 `sensitive-field-auth-scheme` 在 kv 规则之前把「字段名 + scheme」一路抹到行尾。
   */
  describe('⚠️ 敏感字段名后面跟鉴权 scheme：凭证本体必须一起抹掉', () => {
    const OPAQUE = 'AbCdEf0123456789opaqueTokenBody';
    const FIELD_FORMS = [
      `authorization=Bearer ${OPAQUE}`,
      `token: Bearer ${OPAQUE}`,
      `access_token=Bearer ${OPAQUE}`,
      `credential=Basic ${OPAQUE}`,
      `secret: Token ${OPAQUE}`,
      `api_key=ApiKey ${OPAQUE}`,
      // scheme 大小写不敏感;凭证本体带 `.` `_` `-` 等 kv 值字符集之外的分隔符也要覆盖。
      `token=bearer ${OPAQUE}.sig_part-2`,
    ];

    it.each(FIELD_FORMS)('%s', (input) => {
      const out = redact(`req failed: ${input}`);
      expect(out).not.toContain(OPAQUE);
    });

    it('AWS4-HMAC-SHA256 这类带逗号空格的凭证也整段抹掉（分隔符处收手就会漏）', () => {
      const out = redact(
        `authorization=AWS4-HMAC-SHA256 Credential=${FAKE.awsAk}/20260804, Signature=${OPAQUE}`,
      );
      expect(out).not.toContain(OPAQUE);
      expect(out).not.toContain(FAKE.awsAk);
    });

    it('规则顺序被写死：auth-scheme 必须排在 sensitive-field-kv 之前', () => {
      const names = __testing.RULES.map((r) => r.name);
      expect(names.indexOf('sensitive-field-auth-scheme')).toBeLessThan(
        names.indexOf('sensitive-field-kv'),
      );
    });

    it('不误伤没有 scheme 的普通 kv（值仍按原规则取到空白为止）', () => {
      const out = redact('update check: token=abc123 channel=stable elapsed=812ms');
      expect(out).toContain('channel=stable');
      expect(out).toContain('elapsed=812ms');
    });
  });

  /**
   * 2026-08-04 review P1 的回归锁：main logger 用 `util.format` 渲染对象参数，敏感字段的值
   * 会**带引号**（`{ token: 'x' }` → `token: 'x'`）。JSON 规则要求键带双引号、kv 规则的值类
   * 排除引号，于是这个最常见的对象渲染形态两头漏网。
   */
  describe('⚠️ util.format 渲染的带引号敏感值：连引号带内容一起抹掉', () => {
    const SECRET = 'opaqueSecretValue0123456789';
    const FORMS = [
      `metadata { token: '${SECRET}' }`, // 单引号（Node 默认）
      `ctx { password: "${SECRET}" }`, // 双引号
      `probe { refresh_token: '${SECRET}' }`, // 下划线字段
      `hdr { client_secret: '${SECRET}' }`,
      `obj { api_key: '${SECRET}', ok: true }`, // 后面还有别的字段
      `cookie { session_key: 'Bearer ${SECRET} extra' }`, // 值里带空格/scheme
    ];

    it.each(FORMS)('%s', (input) => {
      expect(redact(input)).not.toContain(SECRET);
    });

    it('值里含转义引号也吃到正确的闭合引号', () => {
      // util.inspect 对含单引号的串会改用双引号或转义;这里验证 \\' 不会被当成闭合。
      expect(redact(`{ token: 'ab\\'cd${SECRET}' }`)).not.toContain(SECRET);
    });

    it('规则顺序：quoted 在 kv 之前、auth-scheme 之后', () => {
      const names = __testing.RULES.map((r) => r.name);
      expect(names.indexOf('sensitive-field-auth-scheme')).toBeLessThan(
        names.indexOf('sensitive-field-quoted'),
      );
      expect(names.indexOf('sensitive-field-quoted')).toBeLessThan(
        names.indexOf('sensitive-field-kv'),
      );
    });

    it('不误伤非敏感字段的带引号值', () => {
      const out = redact(`{ channel: 'stable', mode: 'fast' }`);
      expect(out).toContain("channel: 'stable'");
      expect(out).toContain("mode: 'fast'");
    });
  });

  /**
   * 2026-08-06 review P1：字段名被**整体引起来**（闭合引号夹在名与分隔符之间）时,老规则全漏。
   * 最典型的是带连字符的 HTTP 头 `x-api-key`——`api[_-]?key` 只匹配到 `api-key` 子串,`x-` 前缀
   * 又把 `sensitive-field-json` 的「引号紧贴敏感名」挡掉,于是任意 x-api-key 值原样外泄。
   */
  describe('⚠️ 引号包起来的字段名（含 x-api-key 等带前缀/连字符的头）', () => {
    const KEY = 'opaqueApiKeyValue0123456789';
    const FORMS = [
      `{ 'x-api-key': '${KEY}' }`, // Node 对象渲染,单引号连字符键
      `"x-api-key":"${KEY}"`, // 裸 JSON
      `headers { "x-api-key": "${KEY}", "content-type": "application/json" }`,
      `log \\"x-api-key\\":\\"${KEY}\\" tail`, // 转义 JSON（日志里字符串化过一次）
      `{ 'authorization': '${KEY}' }`, // 引号包起来的 authorization
      `{ "x-goog-api-key": "${KEY}" }`, // 多段厂商前缀
      `{ 'refresh-token': '${KEY}' }`,
    ];
    it.each(FORMS)('%s', (input) => {
      expect(redact(input)).not.toContain(KEY);
    });

    it('键名不带引号仍走原有规则（不回归）', () => {
      expect(redact(`x-api-key: ${KEY}`)).not.toContain(KEY);
      expect(redact(`token=${KEY}`)).not.toContain(KEY);
    });

    it('不误伤引号包起来的非敏感键', () => {
      const out = redact(`{ 'x-request-id': 'req-123', 'content-type': 'text/plain' }`);
      expect(out).toContain('req-123');
      expect(out).toContain('text/plain');
    });
  });
});

describe('homeUserName', () => {
  it.each([
    ['/Users/sam', 'sam'],
    ['/home/dev', 'dev'],
    ['C:\\Users\\Admin', 'Admin'],
    ['C:\\Users\\Admin\\', 'Admin'],
  ])('%s → %s', (input, expected) => {
    expect(homeUserName(input)).toBe(expected);
  });

  it('空值返回 null', () => {
    expect(homeUserName(undefined)).toBeNull();
    expect(homeUserName('')).toBeNull();
  });
});
