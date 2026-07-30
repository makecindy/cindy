/**
 * 分阶段网络诊断的探针编排与摘要格式。
 *
 * 三个探针全部注入(不起 Electron、不碰真实网络),重点验证:
 *  - 任一探针失败不影响其它两段(否则最有价值的组合——「DNS/TCP 都通,Chromium 仍
 *    报 ERR_FAILED」——就永远拿不到);
 *  - 摘要是一行、可直接进日志与弹框。
 */
import { describe, expect, it, vi } from 'vitest';

// createDefaultProbes 静态 import electron(architecture-invariants.md §2 禁止 main
// 运行时动态 import);本文件只测注入探针的编排,mock 到能加载模块即可。
vi.mock('electron', () => ({
  session: { defaultSession: { resolveProxy: vi.fn(async () => 'DIRECT') } },
}));

import {
  formatEndpointFetchDiagnosis,
  probeEndpointFetch,
  type EndpointFetchProbes,
} from '../endpointFetchDiagnostics';

const URL_UNDER_TEST = 'https://hotfix.example.com/cindy/endpoint.json?t=1';

function probes(overrides: Partial<EndpointFetchProbes> = {}): EndpointFetchProbes {
  return {
    resolveProxy: vi.fn(async () => 'DIRECT'),
    lookupHost: vi.fn(async () => ['203.0.113.7']),
    connectTcp: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('probeEndpointFetch', () => {
  it('三段全通:摘要含代理决策、地址与耗时', async () => {
    const report = await probeEndpointFetch(URL_UNDER_TEST, probes());
    expect(report.proxy).toEqual({ ok: true, value: 'DIRECT' });
    expect(report.dns).toEqual({ ok: true, addresses: ['203.0.113.7'] });
    expect(report.tcp.ok).toBe(true);
    const summary = formatEndpointFetchDiagnosis(report);
    expect(summary).toContain('proxy=DIRECT');
    expect(summary).toContain('dns=ok(203.0.113.7)');
    expect(summary).toMatch(/tcp=ok\(\d+ms\)/);
    expect(summary.split('\n')).toHaveLength(1);
  });

  it('按 URL 解析出 host 与端口传给探针', async () => {
    const p = probes();
    await probeEndpointFetch('https://cdn.example.com:8443/endpoint.json', p);
    expect(p.lookupHost).toHaveBeenCalledWith('cdn.example.com');
    expect(p.connectTcp).toHaveBeenCalledWith('cdn.example.com', 8443, expect.any(Number));
  });

  it('http 无端口时探 80', async () => {
    const p = probes();
    await probeEndpointFetch('http://cdn.example.com/endpoint.json', p);
    expect(p.connectTcp).toHaveBeenCalledWith('cdn.example.com', 80, expect.any(Number));
  });

  it('DNS 失败不影响代理与 TCP 两段', async () => {
    const report = await probeEndpointFetch(
      URL_UNDER_TEST,
      probes({
        lookupHost: async () => {
          const err = new Error('getaddrinfo ENOTFOUND') as NodeJS.ErrnoException;
          err.code = 'ENOTFOUND';
          throw err;
        },
      }),
    );
    expect(report.dns).toEqual({ ok: false, error: 'ENOTFOUND' });
    expect(report.proxy.ok).toBe(true);
    expect(report.tcp.ok).toBe(true);
    expect(formatEndpointFetchDiagnosis(report)).toContain('dns=fail(ENOTFOUND)');
  });

  it('代理解析失败单独记账,不整份放弃', async () => {
    const report = await probeEndpointFetch(
      URL_UNDER_TEST,
      probes({
        resolveProxy: async () => {
          throw new Error('session unavailable');
        },
      }),
    );
    expect(report.proxy.ok).toBe(false);
    expect(report.dns.ok).toBe(true);
    expect(formatEndpointFetchDiagnosis(report)).toContain('proxy=fail(session unavailable)');
  });

  it('TCP 超时进摘要', async () => {
    const report = await probeEndpointFetch(
      URL_UNDER_TEST,
      probes({
        connectTcp: async () => {
          throw new Error('ETIMEDOUT');
        },
      }),
    );
    expect(formatEndpointFetchDiagnosis(report)).toContain('tcp=fail(ETIMEDOUT)');
  });

  it('URL 非法时三段都记 invalid-url,不抛错', async () => {
    const p = probes();
    const report = await probeEndpointFetch('not a url', p);
    expect(report.proxy).toEqual({ ok: false, error: 'invalid-url' });
    expect(report.dns).toEqual({ ok: false, error: 'invalid-url' });
    expect(report.tcp).toEqual({ ok: false, error: 'invalid-url' });
    expect(p.lookupHost).not.toHaveBeenCalled();
  });

  it('代理返回空串归一为 unknown(不产出空摘要字段)', async () => {
    const report = await probeEndpointFetch(URL_UNDER_TEST, probes({ resolveProxy: async () => '  ' }));
    expect(formatEndpointFetchDiagnosis(report)).toContain('proxy=unknown');
  });

  it('DNS 返回多地址时摘要只留前两条', async () => {
    const report = await probeEndpointFetch(
      URL_UNDER_TEST,
      probes({ lookupHost: async () => ['1.1.1.1', '2.2.2.2', '3.3.3.3'] }),
    );
    expect(formatEndpointFetchDiagnosis(report)).toContain('dns=ok(1.1.1.1,2.2.2.2)');
  });

  it('errno code 是数字时也不炸(诊断自己不能成为失败源)', async () => {
    const report = await probeEndpointFetch(
      URL_UNDER_TEST,
      probes({
        lookupHost: async () => {
          const err = new Error('boom') as Error & { code: number };
          err.code = 12345;
          throw err;
        },
      }),
    );
    expect(report.dns).toEqual({ ok: false, error: '12345' });
  });

  describe('每段都必须受 deadline 约束', () => {
    /** 永不 settle 的 promise:模拟 PAC/代理解析或 OS DNS 查询挂住。 */
    const never = () => new Promise<never>(() => {});

    it.each([
      ['proxy', { resolveProxy: never }],
      ['dns', { lookupHost: never }],
      ['tcp', { connectTcp: never }],
    ] as const)('%s 永不返回时按 deadline 记失败,整轮仍然返回', async (stage, override) => {
      const startedAt = Date.now();
      const report = await probeEndpointFetch(
        URL_UNDER_TEST,
        probes(override as Partial<EndpointFetchProbes>),
        30,
      );
      // 关键不是耗时精确,而是"会返回":这段跑在 app.ready 的阻断路径上,
      // 挂住就等于阻断框(连同离线出口)永远不出现,表现为启动卡死。
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      const outcome = report[stage];
      expect(outcome.ok).toBe(false);
      expect(outcome.ok === false && outcome.error).toBe(`${stage}-timeout-30ms`);
      // 其它两段照常出结果。
      for (const other of ['proxy', 'dns', 'tcp'] as const) {
        if (other !== stage) expect(report[other].ok).toBe(true);
      }
    });
  });
});
