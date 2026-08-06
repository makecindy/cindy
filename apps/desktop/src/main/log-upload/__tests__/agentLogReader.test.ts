/**
 * `agent-<date>.ndjson`（proxy 流）读侧的隐私锁。
 *
 * 这条流的危险性和 main 流不是一个量级：**proxy 自己就会把请求体与上游错误体写进日志上下文**，
 * 而 `logger.emit()` 用 `util.format(...args)` 把上下文对象渲染进 `msg`。所以「取整条 msg +
 * 正则兜底」等于把 prompt 原文一起带走（2026-08-04 review P1）。
 *
 * 现在的口径是**逐字段重建**：等级闸 + 标记截断 + 标量字段白名单。本文件锁的就是
 * 「名单外的东西没有出口」这件事，而不是「某几个正则能抹掉它」。
 */
import { describe, expect, it } from 'vitest';

import { __testing, parseAgentLogText } from '../agentLogReader';
import {
  findOffsetAtOrBefore,
  parseMainHeadTimestamp,
  type RandomAccessFile,
} from '../mainLogReader';

const { rebuildProxyMsg, isProxyScope, parseNdjsonTimestamp, MAX_MARKER_CHARS } = __testing;

const TS = new Date(2026, 7, 4, 10, 0, 0).getTime();

/** 造一行 NDJSON，字段与 logger.writeAgentRecord 一致。 */
function ndjson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ts: TS,
    tz: 480,
    level: 'info',
    source: 'proxy',
    scope: 'cc-proxy/req',
    sessionId: '',
    seq: 1,
    msg: '▶ inbound request from client',
    ...over,
  });
}

function parse(lines: string[]): ReturnType<typeof parseAgentLogText> {
  return parseAgentLogText(lines.join('\n'), { fromFileStart: true });
}

/**
 * proxy 真实会写的两条带 body 的记录，形状抄自
 * `packages/anthropic-compat-proxy/src/server.ts`（`util.format` 渲染后的样子）。
 */
const PROMPT = '用户的私密对话正文 + 被读进上下文的文件内容';
const INBOUND_WITH_BODY =
  "▶ inbound request from client { reqId: 'r-1', method: 'POST', " +
  "upstreamBase: 'https://api.anthropic.com', url: '/v1/messages', bytes: 4096, " +
  `body: '{"messages":[{"role":"user","content":"${PROMPT}"}]}' }`;
const UPSTREAM_ERR_WITH_BODY =
  "◀ upstream response (non-2xx) { reqId: 'r-2', status: 400, " +
  "contentType: 'application/json', bytes: 220, errorType: 'invalid_request_error', " +
  `body: '{"error":{"message":"${PROMPT}"}}' }`;

describe('等级闸', () => {
  it('⚠️ debug 记录整条丢 —— 请求体 dump 就发在 debug', () => {
    const result = parse([ndjson({ level: 'debug', msg: INBOUND_WITH_BODY })]);
    expect(result.records).toHaveLength(0);
    expect(result.droppedBySource).toBe(1);
  });

  it('trace 同样丢', () => {
    expect(parse([ndjson({ level: 'trace', msg: INBOUND_WITH_BODY })]).records).toHaveLength(0);
  });

  it('等级缺失 / 不认识 ⇒ 丢（未知不该比明确的 debug 更宽松）', () => {
    expect(parse([ndjson({ level: undefined })]).records).toHaveLength(0);
    expect(parse([ndjson({ level: 'verbose' })]).records).toHaveLength(0);
    expect(parse([ndjson({ level: 42 })]).records).toHaveLength(0);
  });

  it('info / warn / error / fatal 放行', () => {
    for (const level of ['info', 'warn', 'error', 'fatal']) {
      expect(parse([ndjson({ level })]).records).toHaveLength(1);
    }
  });
});

describe('字段白名单：名单外的键没有出口', () => {
  it('⚠️ warn 级的上游错误体不会被带出（它不在 debug 级，等级闸挡不住）', () => {
    const result = parse([ndjson({ level: 'warn', msg: UPSTREAM_ERR_WITH_BODY })]);

    expect(result.records).toHaveLength(1);
    const { msg } = result.records[0];
    expect(msg).not.toContain(PROMPT);
    expect(msg).not.toContain('body');
    expect(msg).not.toContain('messages');
    // 白名单里的标量照常带出 —— 这条流的价值就在状态码与错误类型。
    expect(msg).toContain('status=400');
    expect(msg).toContain('errorType=invalid_request_error');
    expect(msg).toContain('reqId=r-2');
  });

  it('⚠️ 即使请求体 dump 出现在 info 级也带不出正文（不依赖等级闸这一道）', () => {
    const result = parse([ndjson({ level: 'info', msg: INBOUND_WITH_BODY })]);

    expect(result.records).toHaveLength(1);
    expect(result.records[0].msg).not.toContain(PROMPT);
    expect(result.records[0].msg).not.toContain('content');
    expect(result.records[0].msg).toContain('bytes=4096');
    expect(result.records[0].msg).toContain('method=POST');
  });

  it('未来新增的上下文键默认不带出（deny-by-default）', () => {
    const msg = "◀ done { reqId: 'r-3', status: 200, newFangledField: '不该出现的值' }";
    const out = parse([ndjson({ msg })]).records[0].msg;
    expect(out).not.toContain('newFangledField');
    expect(out).not.toContain('不该出现的值');
    expect(out).toContain('status=200');
  });

  it('值的形状不匹配就当没有（不给写日志的人决定「这个值安全」）', () => {
    // status 不是三位数字、reqId 带空格与中文:两条都不该带出。
    const msg = "x { status: 'unknown', reqId: 'r 4 中文' }";
    const out = parse([ndjson({ msg })]).records[0].msg;
    expect(out).not.toContain('status=');
    expect(out).not.toContain('reqId=');
  });
});

describe('rebuildProxyMsg', () => {
  it('标记只取渲染对象之前那一截 —— 对象里的值不可能进标记', () => {
    expect(rebuildProxyMsg("marker text { body: '正文' }")).toBe('marker text');
  });

  it('标记超长被截断', () => {
    const long = 'm'.repeat(MAX_MARKER_CHARS * 3);
    expect(rebuildProxyMsg(long)).toHaveLength(MAX_MARKER_CHARS);
  });

  it('纯字符串消息（没有上下文对象）整条当标记，仍走 redact', () => {
    expect(rebuildProxyMsg('token=abcdefghijklmnop')).not.toContain('abcdefghijklmnop');
  });

  it('家目录用户名在标记里也被抹掉', () => {
    expect(rebuildProxyMsg('spawn /Users/someone/bin/x failed')).not.toContain('someone');
  });

  it('没有任何白名单字段时只留标记，不留空格尾巴', () => {
    expect(rebuildProxyMsg('▶ hello { unknown: 1 }')).toBe('▶ hello');
  });
});

describe('双闸：source 与 scope', () => {
  it('source 不是 proxy ⇒ 丢', () => {
    expect(parse([ndjson({ source: 'maker' })]).records).toHaveLength(0);
  });

  it('source 写成 proxy 但 scope 不在 proxy 根下 ⇒ 丢', () => {
    const result = parse([ndjson({ source: 'proxy', scope: 'maker/agent' })]);
    expect(result.records).toHaveLength(0);
    expect(result.droppedBySource).toBe(1);
  });

  it('isProxyScope 只认根本身与 / : 两种子 scope 分隔', () => {
    expect(isProxyScope('cc-proxy')).toBe(true);
    expect(isProxyScope('cc-proxy/req')).toBe(true);
    expect(isProxyScope('codex-proxy:upstream')).toBe(true);
    // 前缀相同但不是同一个 scope —— 不能被 startsWith 蒙过去。
    expect(isProxyScope('cc-proxyish')).toBe(false);
    expect(isProxyScope('not-cc-proxy')).toBe(false);
  });
});

describe('parseNdjsonTimestamp', () => {
  it('取 ts（epoch ms）', () => {
    expect(parseNdjsonTimestamp(JSON.stringify({ ts: 1775_000_000_000, msg: 'x' }))).toBe(
      1775_000_000_000,
    );
  });
  it('坏行 / 半行 / 缺 ts / ts 非数 ⇒ null', () => {
    expect(parseNdjsonTimestamp('{ half line')).toBeNull();
    expect(parseNdjsonTimestamp('')).toBeNull();
    expect(parseNdjsonTimestamp(JSON.stringify({ level: 'info' }))).toBeNull();
    expect(parseNdjsonTimestamp(JSON.stringify({ ts: 'nope' }))).toBeNull();
  });
});

/**
 * 2026-08-04 review P2 的回归锁：崩溃补传读超大 `agent-*.ndjson` 时用 `findOffsetAtOrBefore`
 * 定位，但它原先只认 main 记录头。喂 NDJSON 会一条时间戳都解不出 ⇒ 二分恒收敛到 0 ⇒ 读窗口
 * 错定在最旧记录、彻底错过崩溃现场。这里锁「NDJSON 解析器能定位、main 解析器不能」这对。
 */
describe('findOffsetAtOrBefore：NDJSON 需要 NDJSON 时间戳解析器', () => {
  /** 造一个 ~200KB 的 NDJSON 文件，时间戳从 base 起每行 +1s。 */
  function ndjsonFile(base: number, count: number): { file: RandomAccessFile; buf: Buffer } {
    const lines: string[] = [];
    for (let i = 0; i < count; i += 1) {
      lines.push(
        JSON.stringify({
          ts: base + i * 1000,
          level: 'info',
          source: 'proxy',
          scope: 'cc-proxy/req',
          msg: `noise ${'x'.repeat(200)}`,
        }),
      );
    }
    const buf = Buffer.from(`${lines.join('\n')}\n`, 'utf8');
    return {
      buf,
      file: {
        size: async () => buf.length,
        read: async (offset: number, length: number) =>
          buf.subarray(offset, Math.min(offset + length, buf.length)),
      },
    };
  }

  const BASE = new Date(2026, 7, 4, 0, 0, 0).getTime();

  it('NDJSON 解析器：定位到目标时刻附近，而不是文件开头', async () => {
    const { file, buf } = ndjsonFile(BASE, 1000); // ~220KB
    const target = BASE + 800 * 1000; // 第 800 行附近
    const offset = await findOffsetAtOrBefore(file, target, parseNdjsonTimestamp);

    // 落在文件中后段(不是 0),且该偏移处之后第一条记录的时间戳不晚于目标。
    expect(offset).toBeGreaterThan(buf.length / 2);
    const tail = buf.subarray(offset).toString('utf8');
    const firstFull = tail.slice(tail.indexOf('\n') + 1).split('\n')[0];
    expect(parseNdjsonTimestamp(firstFull)!).toBeLessThanOrEqual(target);
  });

  it('⚠️ 用 main 记录头解析器喂 NDJSON ⇒ 恒收敛到 0（这就是修复前的行为）', async () => {
    const { file } = ndjsonFile(BASE, 1000);
    const target = BASE + 800 * 1000;
    const offset = await findOffsetAtOrBefore(file, target, parseMainHeadTimestamp);
    expect(offset).toBe(0);
  });
});

describe('行级健壮性', () => {
  it('坏行 / 半行跳过，不影响后续记录', () => {
    const result = parse(['{ not json', ndjson(), '']);
    expect(result.records).toHaveLength(1);
  });

  it('窗口从中间切进来时第一行丢弃', () => {
    const result = parseAgentLogText([ndjson(), ndjson()].join('\n'), { fromFileStart: false });
    expect(result.records).toHaveLength(1);
  });

  it('时间戳非法 ⇒ 丢', () => {
    expect(parse([ndjson({ ts: 'not-a-number' })]).records).toHaveLength(0);
  });
});
