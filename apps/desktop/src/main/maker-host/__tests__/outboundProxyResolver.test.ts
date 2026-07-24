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
  parseChromiumProxyResult,
  resetOutboundProxyResolverStateForTest,
  resolveDesktopOutboundProxy,
} from '../outbound-proxy-resolver.js';

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
  it('parses PROXY entries into http urls', () => {
    expect(parseChromiumProxyResult('PROXY 127.0.0.1:7890')).toBe('http://127.0.0.1:7890');
  });

  it('returns null for DIRECT', () => {
    expect(parseChromiumProxyResult('DIRECT')).toBe(null);
  });

  it('skips unsupported SOCKS/HTTPS entries and picks the next supported one', () => {
    expect(parseChromiumProxyResult('SOCKS5 127.0.0.1:7891; PROXY 127.0.0.1:7890; DIRECT'))
      .toBe('http://127.0.0.1:7890');
    expect(parseChromiumProxyResult('HTTPS secure.proxy:443; DIRECT')).toBe(null);
    expect(parseChromiumProxyResult('SOCKS 127.0.0.1:1080')).toBe(null);
  });

  it('tolerates malformed input', () => {
    expect(parseChromiumProxyResult('')).toBe(null);
    expect(parseChromiumProxyResult(';;')).toBe(null);
    expect(parseChromiumProxyResult('PROXY')).toBe(null);
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
