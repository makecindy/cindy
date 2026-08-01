import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electronState = vi.hoisted(() => ({
  ready: true,
  resolveProxy: vi.fn<(url: string) => Promise<string>>(async () => 'DIRECT'),
}));

const loggerState = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../logger-adapter.js', () => ({
  createMakerLogger: () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: loggerState.info,
    warn: loggerState.warn,
    error: vi.fn(),
    child: vi.fn(),
    isDebugEnabled: () => false,
  }),
}));

// 覆盖全局 electron stub 的 app.isReady / session.resolveProxy,其余成员沿用 stub
// (logger 等模块还要用 app.getPath)。
vi.mock('electron', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    app: Object.assign(Object.create(actual.app as object), {
      isReady: () => electronState.ready,
    }),
    session: {
      defaultSession: {
        resolveProxy: (url: string) => electronState.resolveProxy(url),
      },
    },
  };
});

import {
  getOutboundPathSnapshotFor,
  parseChromiumProxyResult,
  resetOutboundProxyResolverStateForTest,
  resolveDesktopOutboundProxy,
} from '../outbound-proxy-resolver.js';

/** 单 origin 查询的简写(快照按上游分桶,测试里绝大多数断言只关心一个上游)。 */
const snapshotFor = (origin: string) => getOutboundPathSnapshotFor([origin]);

const PROXY_ENV_KEYS = [
  'HTTPS_PROXY', 'https_proxy',
  'HTTP_PROXY', 'http_proxy',
  'ALL_PROXY', 'all_proxy',
  'NO_PROXY', 'no_proxy',
] as const;

// 开发机 shell 可能真的设了代理 env;逐 key 摘除并在测试后恢复,防止环境泄漏进断言。
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of PROXY_ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  electronState.ready = true;
  electronState.resolveProxy.mockReset();
  electronState.resolveProxy.mockResolvedValue('DIRECT');
  loggerState.info.mockClear();
  loggerState.warn.mockClear();
  resetOutboundProxyResolverStateForTest();
});

afterEach(() => {
  for (const key of PROXY_ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('parseChromiumProxyResult', () => {
  /** 只关心选中的地址时的简写(verdict 的另一半 skippedUnsupported 另有专门用例)。 */
  const urlOf = (result: string) => parseChromiumProxyResult(result).url;

  it('parses PROXY entries into http urls', () => {
    expect(urlOf('PROXY 127.0.0.1:7890')).toBe('http://127.0.0.1:7890');
  });

  it('returns null for DIRECT', () => {
    expect(urlOf('DIRECT')).toBe(null);
  });

  it('uses SOCKS5 when it is the only usable candidate', () => {
    expect(urlOf('SOCKS5 127.0.0.1:7891')).toBe('socks5://127.0.0.1:7891');
    // 「代理软件只开 SOCKS 出口」的典型形态 —— 此时直连会因本机解不出上游而 ENOTFOUND。
    expect(urlOf('SOCKS5 127.0.0.1:7891; DIRECT')).toBe('socks5://127.0.0.1:7891');
    expect(urlOf('HTTPS secure.proxy:443; SOCKS5 127.0.0.1:7891'))
      .toBe('socks5://127.0.0.1:7891');
  });

  it('prefers PROXY over SOCKS5 in a mixed chain (resolver cannot express PAC fallback)', () => {
    // 回归防护:resolver 只能给一个结果,选中的条目连不上就是失败、不会退到下一个。
    // 支持 SOCKS5 之前这两串都选 PROXY(SOCKS5 条目被跳过);若改成选 SOCKS5,
    // 该端点一挂就成 502,凭空多出一种原来不存在的失败模式。
    expect(urlOf('SOCKS5 127.0.0.1:7891; PROXY 127.0.0.1:7890; DIRECT'))
      .toBe('http://127.0.0.1:7890');
    expect(urlOf('PROXY 127.0.0.1:7890; SOCKS5 127.0.0.1:7891'))
      .toBe('http://127.0.0.1:7890');
  });

  it('stops at DIRECT and skips unsupported HTTPS/SOCKS(v4) entries', () => {
    expect(urlOf('HTTPS secure.proxy:443; DIRECT')).toBe(null);
    // DIRECT 之后的条目不再考虑:PAC 里 DIRECT 意味着「到此为止,直连即可」。
    expect(urlOf('DIRECT; PROXY 127.0.0.1:7890')).toBe(null);
    expect(urlOf('DIRECT; SOCKS5 127.0.0.1:7891')).toBe(null);
    // Chromium 里裸 SOCKS 前缀就是 v4,不支持。
    expect(urlOf('SOCKS 127.0.0.1:1080')).toBe(null);
    expect(urlOf('SOCKS 127.0.0.1:1080; PROXY 127.0.0.1:7890'))
      .toBe('http://127.0.0.1:7890');
  });

  it('reports whether a configured-but-unusable entry was skipped', () => {
    // 转发行为不受这个标志影响(照旧直连),但诊断必须能区分「系统说没有代理」和
    // 「系统列了代理、Cindy 用不了」—— 后者的动作是把那条改成 HTTP/SOCKS5。
    expect(parseChromiumProxyResult('HTTPS corporate.proxy:443; DIRECT')).toEqual({
      url: null,
      skippedUnsupported: true,
    });
    expect(parseChromiumProxyResult('SOCKS legacy.proxy:1080')).toEqual({
      url: null,
      skippedUnsupported: true,
    });
    // 真 DIRECT / 无条目不算「跳过了不支持的条目」。
    expect(parseChromiumProxyResult('DIRECT')).toEqual({ url: null, skippedUnsupported: false });
    expect(parseChromiumProxyResult('')).toEqual({ url: null, skippedUnsupported: false });
    // 有可用候选时标志不影响结果,但仍如实反映扫描过程。
    expect(parseChromiumProxyResult('HTTPS secure.proxy:443; PROXY 127.0.0.1:7890')).toEqual({
      url: 'http://127.0.0.1:7890',
      skippedUnsupported: true,
    });
    // DIRECT 之前没有不支持条目 → false(DIRECT 之后的一律不看)。
    expect(parseChromiumProxyResult('DIRECT; HTTPS secure.proxy:443')).toEqual({
      url: null,
      skippedUnsupported: false,
    });
  });

  it('tolerates malformed input', () => {
    expect(urlOf('')).toBe(null);
    expect(urlOf(';;')).toBe(null);
    expect(urlOf('PROXY')).toBe(null);
  });
});

describe('resolveDesktopOutboundProxy', () => {
  it('prefers proxy env vars and does not consult the system proxy', async () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:6152';
    await expect(resolveDesktopOutboundProxy('https://chatgpt.com:443')).resolves.toBe('http://127.0.0.1:6152');
    expect(electronState.resolveProxy).not.toHaveBeenCalled();
  });

  it('returns credentialed env proxy verbatim but only logs the redacted form', async () => {
    process.env.HTTPS_PROXY = 'http://user:sekret@127.0.0.1:6152';
    await expect(resolveDesktopOutboundProxy('https://chatgpt.com:443')).resolves.toBe('http://user:sekret@127.0.0.1:6152');
    const logged = JSON.stringify([...loggerState.info.mock.calls, ...loggerState.warn.mock.calls]);
    expect(logged).not.toContain('sekret');
    expect(logged).toContain('http://127.0.0.1:6152');
  });

  it('treats env NO_PROXY hits as direct without falling back to the system proxy', async () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:6152';
    process.env.NO_PROXY = 'chatgpt.com';
    electronState.resolveProxy.mockResolvedValue('PROXY 127.0.0.1:7890');
    await expect(resolveDesktopOutboundProxy('https://chatgpt.com:443')).resolves.toBe(null);
    expect(electronState.resolveProxy).not.toHaveBeenCalled();
  });

  it('falls back to the system proxy when no proxy env is set', async () => {
    electronState.resolveProxy.mockResolvedValue('PROXY 127.0.0.1:7890; DIRECT');
    await expect(resolveDesktopOutboundProxy('https://chatgpt.com:443')).resolves.toBe('http://127.0.0.1:7890');
    expect(electronState.resolveProxy).toHaveBeenCalledWith('https://chatgpt.com:443');
  });

  it('caches system proxy resolutions per upstream origin', async () => {
    electronState.resolveProxy.mockResolvedValue('PROXY 127.0.0.1:7890');
    await resolveDesktopOutboundProxy('https://chatgpt.com:443');
    await resolveDesktopOutboundProxy('https://chatgpt.com:443');
    expect(electronState.resolveProxy).toHaveBeenCalledTimes(1);
    await resolveDesktopOutboundProxy('https://api.x.ai:443');
    expect(electronState.resolveProxy).toHaveBeenCalledTimes(2);
  });

  it('fails open to direct when system resolution throws or app is not ready', async () => {
    electronState.resolveProxy.mockRejectedValue(new Error('boom'));
    await expect(resolveDesktopOutboundProxy('https://chatgpt.com:443')).resolves.toBe(null);

    resetOutboundProxyResolverStateForTest();
    electronState.ready = false;
    electronState.resolveProxy.mockReset();
    await expect(resolveDesktopOutboundProxy('https://chatgpt.com:443')).resolves.toBe(null);
    expect(electronState.resolveProxy).not.toHaveBeenCalled();
  });
});

describe('getOutboundPathSnapshotFor', () => {
  it('is null until a resolution happens', () => {
    expect(snapshotFor('https://chatgpt.com:443')).toBe(null);
  });

  it('keys snapshots by upstream so a shared resolver cannot cross-contaminate', async () => {
    // 回归防护:这个 resolver 由 codex proxy / anthropic-compat proxy / 通用
    // outbound-fetch 共用。曾经存单值槽,最后完成解析的请求会覆盖它 —— 于是
    // codex 的错误消息里可能出现属于 Anthropic 上游的判定。NO_PROXY 逐 origin
    // 生效时两者结论甚至相反(如下:chatgpt 被豁免直连,api.anthropic 走代理)。
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7890';
    process.env.NO_PROXY = 'chatgpt.com';
    await resolveDesktopOutboundProxy('https://chatgpt.com:443');
    await resolveDesktopOutboundProxy('https://api.anthropic.com:443');

    expect(snapshotFor('https://chatgpt.com:443')).toMatchObject({ kind: 'direct', source: 'env' });
    expect(snapshotFor('https://api.anthropic.com:443')).toMatchObject({
      kind: 'proxy',
      proxy: 'http://127.0.0.1:7890',
    });
    // 没解析过的上游不会借用别人的判定。
    expect(snapshotFor('https://api.x.ai:443')).toBe(null);
  });

  it('accepts full base URLs and returns the newest among candidate origins', async () => {
    // 调用方(maker-host)手里是带 path 的 base URL,不归一成 origin 会永远查不中。
    electronState.resolveProxy.mockResolvedValue('PROXY 127.0.0.1:7890');
    await resolveDesktopOutboundProxy('https://chatgpt.com:443');
    expect(getOutboundPathSnapshotFor(['https://chatgpt.com/backend-api/codex']))
      .toMatchObject({ kind: 'proxy' });

    // 多候选:codex 的出口随凭证模式在 ChatGPT / gateway 间切换,取最新那条。
    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      electronState.resolveProxy.mockResolvedValue('DIRECT');
      await resolveDesktopOutboundProxy('https://gateway.example:443');
      const picked = getOutboundPathSnapshotFor([
        'https://chatgpt.com/backend-api/codex',
        'https://gateway.example/v1',
      ]);
      expect(picked).toMatchObject({ kind: 'direct', upstream: 'https://gateway.example' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('records env-sourced proxies with a redacted address', async () => {
    process.env.HTTPS_PROXY = 'http://user:sekret@127.0.0.1:6152';
    await resolveDesktopOutboundProxy('https://chatgpt.com:443');
    const snap = snapshotFor('https://chatgpt.com:443');
    expect(snap).toMatchObject({
      source: 'env',
      kind: 'proxy',
      proxy: 'http://127.0.0.1:6152',
      // origin 形态由 originForLog 归一;默认端口按 URL.host 语义省略。
      upstream: 'https://chatgpt.com',
    });
    // 快照会进用户可见的错误消息,凭证绝不能出现在里面。
    expect(JSON.stringify(snap)).not.toContain('sekret');
  });

  it('records a confirmed direct path when the system proxy reports DIRECT', async () => {
    electronState.resolveProxy.mockResolvedValue('DIRECT');
    await resolveDesktopOutboundProxy('https://chatgpt.com:443');
    expect(snapshotFor('https://chatgpt.com:443')).toMatchObject({
      source: 'system',
      kind: 'direct',
    });
    expect(snapshotFor('https://chatgpt.com:443')?.reason).toBeUndefined();
  });

  it('distinguishes an unresolved path from a confirmed direct one', async () => {
    // 这是本快照存在的理由:超时/异常下返回的 null 是 fail-open 猜测,不是「确认无代理」。
    // 报成 direct 会让高墙网络里的用户以为代理判定正常,把排查带向反方向。
    electronState.resolveProxy.mockImplementation(() => new Promise(() => {}));
    vi.useFakeTimers();
    try {
      const pending = resolveDesktopOutboundProxy('https://chatgpt.com:443');
      await vi.advanceTimersByTimeAsync(2100);
      await expect(pending).resolves.toBe(null);
    } finally {
      vi.useRealTimers();
    }
    expect(snapshotFor('https://chatgpt.com:443')).toMatchObject({
      source: 'system',
      kind: 'unknown',
      reason: 'resolve_timeout',
    });

    resetOutboundProxyResolverStateForTest();
    electronState.resolveProxy.mockReset();
    electronState.resolveProxy.mockRejectedValue(new Error('boom'));
    await resolveDesktopOutboundProxy('https://chatgpt.com:443');
    expect(snapshotFor('https://chatgpt.com:443')).toMatchObject({
      kind: 'unknown',
      reason: 'resolve_failed',
    });

    resetOutboundProxyResolverStateForTest();
    electronState.ready = false;
    await resolveDesktopOutboundProxy('https://chatgpt.com:443');
    expect(snapshotFor('https://chatgpt.com:443')).toMatchObject({
      kind: 'unknown',
      reason: 'app_not_ready',
    });
  });

  it('re-resolves a failed lookup on the short TTL, not the 30s success TTL', async () => {
    // 行为变化(本次改动):原实现只对「超时」用短 TTL,resolveProxy **抛错**时
    // 落到 30s 长 TTL —— 瞬时故障会让接下来 30 秒一直用直连兜底。两种「没问出来」
    // 都该快速重试,统一走短 TTL。
    vi.useFakeTimers();
    try {
      electronState.resolveProxy.mockRejectedValue(new Error('boom'));
      await resolveDesktopOutboundProxy('https://chatgpt.com:443');
      expect(electronState.resolveProxy).toHaveBeenCalledTimes(1);

      // 短 TTL(5s)内仍复用缓存,不打爆解析路径。
      await vi.advanceTimersByTimeAsync(4_000);
      await resolveDesktopOutboundProxy('https://chatgpt.com:443');
      expect(electronState.resolveProxy).toHaveBeenCalledTimes(1);

      // 越过短 TTL 后重新解析;若仍按 30s 缓存,这里就不会有第二次调用。
      await vi.advanceTimersByTimeAsync(2_000);
      electronState.resolveProxy.mockResolvedValue('PROXY 127.0.0.1:7890');
      await expect(resolveDesktopOutboundProxy('https://chatgpt.com:443')).resolves.toBe('http://127.0.0.1:7890');
      expect(electronState.resolveProxy).toHaveBeenCalledTimes(2);
      expect(snapshotFor('https://chatgpt.com:443')).toMatchObject({ kind: 'proxy' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps per-path PAC verdicts apart instead of collapsing them to the origin', async () => {
    // outbound-fetch 按「origin + path」解析(per-path PAC 靠它,见其 resolveKeyOf),
    // 所以同 origin、不同 requestPath 的两个 chat-bridge 会话可以拿到不同判定。
    // 早先按 origin 归一存快照会让后到的那条覆盖前一条。
    electronState.resolveProxy.mockImplementation(async (url: string) =>
      url.includes('/v1/chat/completions') ? 'PROXY 127.0.0.1:7890' : 'DIRECT');

    await resolveDesktopOutboundProxy('https://api.moonshot.cn/v1/chat/completions');
    await resolveDesktopOutboundProxy('https://api.moonshot.cn/v1/responses');

    // 两条 path 的结论相反 → 无法确定失败的那次走了哪条,宁可不报也不谎报。
    expect(snapshotFor('https://api.moonshot.cn/v1')).toBe(null);
  });

  it('still reports when every path under the origin agrees', async () => {
    electronState.resolveProxy.mockResolvedValue('PROXY 127.0.0.1:7890');
    await resolveDesktopOutboundProxy('https://api.moonshot.cn/v1/chat/completions');
    await resolveDesktopOutboundProxy('https://api.moonshot.cn/v1/responses');

    // 判定一致(PAC 只看 host 是常态)→ 照常给结论。
    expect(snapshotFor('https://api.moonshot.cn/v1')).toMatchObject({
      kind: 'proxy',
      proxy: 'http://127.0.0.1:7890',
      // 展示仍只用 origin —— path 可能带业务语义,不进用户可见消息。
      upstream: 'https://api.moonshot.cn',
    });
  });

  it('does not claim a proxy path for env values the forwarding layer rejects', async () => {
    // envResolver 只做「哪个变量适用」,不校验值可用性。转发层的 parseOutboundProxyUrl
    // 会拒收 https://(TLS-to-proxy)与 socks4://,实际走直连 —— 此时报「已经过该代理」
    // 就是谎报。判定必须用转发层同一个解析器。
    for (const bad of ['https://corporate.proxy:443', 'socks4://legacy.proxy:1080']) {
      resetOutboundProxyResolverStateForTest();
      process.env.HTTPS_PROXY = bad;
      await resolveDesktopOutboundProxy('https://chatgpt.com:443');
      const snap = snapshotFor('https://chatgpt.com:443');
      expect(snap).toMatchObject({ source: 'env', kind: 'unsupported' });
      // 谎报的地址绝不能出现。
      expect(snap?.proxy).toBeUndefined();
    }

    // 可用形态照旧记 proxy。
    resetOutboundProxyResolverStateForTest();
    process.env.HTTPS_PROXY = 'socks5://127.0.0.1:7891';
    await resolveDesktopOutboundProxy('https://chatgpt.com:443');
    expect(snapshotFor('https://chatgpt.com:443')).toMatchObject({
      kind: 'proxy',
      proxy: 'socks5://127.0.0.1:7891',
    });
  });

  it('classifies a configured-but-unusable system proxy as unsupported, not direct', async () => {
    // 企业环境常见:PAC 只给 HTTPS(TLS-to-proxy)出口。行为上确实直连了,但把它
    // 报成「系统报告无代理」会让用户以为代理配置正常,真正的动作是换成 HTTP/SOCKS5。
    electronState.resolveProxy.mockResolvedValue('HTTPS corporate.proxy:443; DIRECT');
    await expect(resolveDesktopOutboundProxy('https://chatgpt.com:443')).resolves.toBe(null);
    expect(snapshotFor('https://chatgpt.com:443')).toMatchObject({
      source: 'system',
      kind: 'unsupported',
    });

    // 真 DIRECT 仍是 direct,两者不能混。
    resetOutboundProxyResolverStateForTest();
    electronState.resolveProxy.mockResolvedValue('DIRECT');
    await resolveDesktopOutboundProxy('https://chatgpt.com:443');
    expect(snapshotFor('https://chatgpt.com:443')).toMatchObject({ kind: 'direct' });
  });

  it('keeps the unsupported verdict when a cached resolution is reused', async () => {
    // 与 unknownReason 同理:标志不跟着缓存走,缓存命中时会把 unsupported 降级成 direct。
    electronState.resolveProxy.mockResolvedValue('HTTPS corporate.proxy:443');
    await resolveDesktopOutboundProxy('https://chatgpt.com:443');
    electronState.resolveProxy.mockClear();
    await resolveDesktopOutboundProxy('https://chatgpt.com:443');
    expect(electronState.resolveProxy).not.toHaveBeenCalled();
    expect(snapshotFor('https://chatgpt.com:443')).toMatchObject({ kind: 'unsupported' });
  });

  it('keeps the unknown verdict when a cached fallback is reused', async () => {
    // unknownReason 必须跟着缓存走,否则缓存命中时会把当初的兜底重新报成 direct。
    electronState.resolveProxy.mockRejectedValue(new Error('boom'));
    await resolveDesktopOutboundProxy('https://chatgpt.com:443');
    electronState.resolveProxy.mockClear();
    await resolveDesktopOutboundProxy('https://chatgpt.com:443');
    expect(electronState.resolveProxy).not.toHaveBeenCalled();
    expect(snapshotFor('https://chatgpt.com:443')).toMatchObject({
      kind: 'unknown',
      reason: 'resolve_failed',
    });
  });
});
