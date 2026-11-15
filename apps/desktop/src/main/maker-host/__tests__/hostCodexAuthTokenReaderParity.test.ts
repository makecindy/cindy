/**
 * 测试价值
 * - 可观察结果：同一组情形下，桌面 maker-host/index.ts 的 createCodexAuthTokenReader 回调（原样从源码
 *   取出，在 VM 里执行，同 codexAuthTokenReaderBoundary.test.ts）与 Host 的读取器
 *   （apps/host/src/agent/codex-token-reader.ts，Host 自己的代码）给出相同的结果：返回的令牌或报错，
 *   以及是否读了凭据。
 * - 规则依据：放行表第 19 行丙 4。先取 oauth-bearer 状态、已登录才读凭据；每次读取都核对会话边界、
 *   owner、区域与 Codex 引擎，跨 await 核对 owner 范围。
 * - 最小失败输入：不经状态直接读；读状态期间 owner、区域、引擎或边界变化后仍返回令牌。
 * - tier：unit（两边都在进程内；状态、凭据与会话都是测试给出的，不读真实登录）。
 */
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const s = vi.hoisted(() => ({ owner: 'owner-a', scope: 'owner-a#1', pending: false, realm: 'global' as string, agentCurrent: true }));
vi.mock('../../appSessionState.js', async (original) => ({
  ...(await original<typeof import('../../appSessionState.js')>()),
  activeOwnerScopeKey: () => s.scope,
  getActiveAppSession: () => ({ mode: 'cloud', dataOwnerId: s.owner }),
  isAppSessionBoundaryPending: () => s.pending,
}));

const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
const callback = source.slice(source.indexOf('createCodexAuthTokenReader:') + 'createCodexAuthTokenReader:'.length,
  source.indexOf('recordCodexThreadLocation:', source.indexOf('createCodexAuthTokenReader:'))).trim().replace(/,$/, '');

type Reader = (providerId?: string) => () => Promise<{ accessToken: string; chatgptAccountId: string }>;
type Scenario = { name: string; authenticated: boolean; creds: boolean; during?: () => void; before?: () => void };
const scenarios: Scenario[] = [
  { name: 'stable', authenticated: true, creds: true },
  { name: 'not signed in', authenticated: false, creds: true },
  { name: 'no account id', authenticated: true, creds: false },
  { name: 'boundary before', authenticated: true, creds: true, before: () => { s.pending = true; } },
  { name: 'boundary during', authenticated: true, creds: true, during: () => { s.pending = true; } },
  { name: 'owner change during', authenticated: true, creds: true, during: () => { s.owner = 'owner-b'; s.scope = 'owner-b#2'; } },
  { name: 'scope change during', authenticated: true, creds: true, during: () => { s.scope = 'owner-a#2'; } },
  { name: 'realm change during', authenticated: true, creds: true, during: () => { s.realm = 'cn'; } },
  { name: 'agent replaced during', authenticated: true, creds: true, during: () => { s.agentCurrent = false; } },
  { name: 'owner change before', authenticated: true, creds: true, before: () => { s.owner = 'owner-b'; s.scope = 'owner-b#2'; } },
];

async function run(make: (ports: { getState: () => Promise<{ authenticated: boolean }>; readOneShotCreds: () => unknown }) => Reader, scenario: Scenario) {
  Object.assign(s, { owner: 'owner-a', scope: 'owner-a#1', pending: false, realm: 'global', agentCurrent: true });
  let reads = 0;
  const reader = make({
    getState: async () => { scenario.during?.(); return { authenticated: scenario.authenticated }; },
    readOneShotCreds: () => { reads += 1; return scenario.creds ? { accessToken: 'fixture-token', accountId: 'account-b' } : null; },
  })('account-b');
  scenario.before?.();
  try {
    return { value: await reader(), reads };
  } catch (error) {
    return { error: (error as Error).message, reads };
  }
}

describe('Host and desktop Codex token readers decide the same way', () => {
  it('gives the same result and the same credential reads in every scenario', async () => {
    const hostModule = '../../../../../host/src/agent/codex-token-reader.ts';
    const { createHostCodexAuthTokenReader } = (await import(/* @vite-ignore */ hostModule)) as {
      createHostCodexAuthTokenReader(ports: Record<string, unknown>): Reader;
    };
    const desktopAgent = {};
    const desktop = (ports: { getState: () => Promise<{ authenticated: boolean }>; readOneShotCreds: () => unknown }) => runInNewContext(`(${callback})`, {
      activeOwnerScopeKey: () => s.scope,
      getActiveAppSession: () => ({ mode: 'cloud', dataOwnerId: s.owner }),
      getActiveAuthRealm: () => s.realm,
      codexAgent: desktopAgent,
      get _codexAgent() { return s.agentCurrent ? desktopAgent : {}; },
      isAppSessionBoundaryPending: () => s.pending,
      desktopCodexAuthAdapter: { getState: ports.getState, readOneShotCreds: ports.readOneShotCreds },
    }) as Reader;
    const host = (ports: { getState: () => Promise<{ authenticated: boolean }>; readOneShotCreds: () => unknown }) => createHostCodexAuthTokenReader({
      codexAuthAdapter: { getState: ports.getState },
      readOneShotCreds: ports.readOneShotCreds,
      isCodexAgentCurrent: () => s.agentCurrent,
      readAuthRealm: () => s.realm,
    });
    const results: Record<string, unknown> = {};
    for (const scenario of scenarios) {
      const [d, h] = [await run(desktop, scenario), await run(host, scenario)];
      expect({ scenario: scenario.name, host: h }).toEqual({ scenario: scenario.name, host: d });
      results[scenario.name] = d;
    }
    // What the desktop decides, so a change on both sides cannot pass unnoticed.
    expect(results).toEqual({
      'stable': { value: { accessToken: 'fixture-token', chatgptAccountId: 'account-b' }, reads: 1 },
      'not signed in': { error: 'Codex account credentials are unavailable', reads: 0 },
      'no account id': { error: 'Codex account credentials are unavailable', reads: 1 },
      'boundary before': { error: 'Codex authentication owner changed', reads: 0 },
      'boundary during': { error: 'Codex authentication owner changed', reads: 0 },
      'owner change during': { error: 'Codex authentication owner changed', reads: 0 },
      'scope change during': { error: 'Codex authentication owner changed', reads: 0 },
      'realm change during': { error: 'Codex authentication owner changed', reads: 0 },
      'agent replaced during': { error: 'Codex authentication owner changed', reads: 0 },
      'owner change before': { error: 'Codex authentication owner changed', reads: 0 },
    });
  });
});
