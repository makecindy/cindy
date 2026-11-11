// Guard tier: engineering-conventions section 3.2. Existing cross-file
// credential, permission, protocol, race, and design contracts are isolated
// from runtime unit tests. No new input or assertion is introduced here.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 分流形态的源码守卫(同 authLoginFlowReset.test.ts 的既有做法):
 * openSystemBrowserAuthorization 未导出,且两条分支各自依赖 Electron 与网络,
 * 集成测试代价过高;而"清单为空必须回落 loopback"是本次改动对现网用户的核心
 * 承诺——写反方向会让所有人登录不了,值得单独钉住。
 */
describe('openSystemBrowserAuthorization 分流', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/main/authManager.ts'), 'utf8').replace(
    /\r\n/g,
    '\n',
  );

  it('按本次登录区域的端点清单分流,空值回落 loopback(默认关闭)', () => {
    const start = source.indexOf('async function openSystemBrowserAuthorization(');
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf('\n}', start));

    expect(body).toContain('client: CindyAuthClient');
    expect(body).toContain('loginRealm: AuthRegion');
    expect(body).not.toContain('pendingAuthRealm ?? activeAuthRealm');
    expect(body).toContain(
      "getClientEndpointForRealm(loginRealm, 'authDesktopCallbackUrl')",
    );
    // 三元方向:非空 → hosted,空 → loopback。写反即所有存量用户登录中断。
    expect(body).toContain('? openHostedBrowserAuthorization(');
    expect(body).toContain(': openLoopbackBrowserAuthorization(');
  });

  it('authorize、callback 与轮询复用 action 冻结的 auth client', () => {
    const hostedStart = source.indexOf('async function openHostedBrowserAuthorization(');
    const hostedBody = source.slice(hostedStart, source.indexOf('\n}\n', hostedStart));
    const loopbackStart = source.indexOf('async function openLoopbackBrowserAuthorization(');
    const loopbackBody = source.slice(
      loopbackStart,
      source.indexOf('\n}\n\n// ── Refresh scheduling', loopbackStart),
    );
    const actionStart = source.indexOf('async function runLoginAction(');
    expect(actionStart).toBeGreaterThan(-1);
    const actionBody = source.slice(
      actionStart,
      source.indexOf('\n}\n\nexport async function dispatchLoginAction', actionStart),
    );

    expect(hostedBody).toContain('client: CindyAuthClient');
    expect(hostedBody).toContain('client.buildAuthorizeUrl(');
    expect(hostedBody).not.toContain('createAuthClient()');
    expect(loopbackBody).toContain('client: CindyAuthClient');
    expect(loopbackBody).toContain('client.buildAuthorizeUrl(');
    expect(loopbackBody).not.toContain('createAuthClient()');
    expect(actionBody).toContain('const client = createAuthClient(loginRealm);');
    expect(actionBody).toContain(
      'openSystemBrowserAuthorization(\n          client,\n          loginRealm,',
    );
    expect(actionBody).toContain('client.exchangeAuthorizationCode(');
  });

  /**
   * 取回凭据必须与走浏览器的 state 分离。写回 input.state 会让任何能读浏览历史的
   * 扩展 / 同机进程抢先消费掉一次性结果,把真实客户端顶成 expired。
   */
  /**
   * 唤起浏览器这一步发生在轮询开始之前,若只是 await 它,取消信号与五分钟预算都够
   * 不着——shell.openExternal 在系统默认浏览器冷启动等情况下可能长时间不返回。
   */
  it('唤起浏览器与取消/超时竞速,并从同一份预算里扣时间', () => {
    const hostedStart = source.indexOf('async function openHostedBrowserAuthorization(');
    const hostedBody = source.slice(hostedStart, source.indexOf('\n}\n', hostedStart));

    expect(hostedBody).toContain('launchAuthBrowser(() => shell.openExternal(authUrl), signal)');
    expect(hostedBody).toContain('if (!launched.opened) return { error: launched.error };');
    const loopbackStart = source.indexOf('async function openLoopbackBrowserAuthorization(');
    const loopbackBody = source.slice(loopbackStart, source.indexOf('\n}\n', loopbackStart));
    expect(loopbackBody).toContain('launchAuthBrowser(() => shell.openExternal(authUrl), launchCancellation.signal)');
    expect(loopbackBody).toContain('launchCancellation.abort();');
    // 不能是裸 await:那样取消与超时都落不到这一步上
    expect(hostedBody).not.toMatch(/await shell\.openExternal\(authUrl\);/);
    // 轮询预算要扣掉唤起已花的时间,整次尝试仍是一个五分钟
    expect(hostedBody).toContain('deadline - Date.now()');
  });

  it('轮询用的是 pollSecret,不是会进浏览器的 state', () => {
    const hostedStart = source.indexOf('async function openHostedBrowserAuthorization(');
    const hostedBody = source.slice(hostedStart, source.indexOf('\n}\n', hostedStart));

    expect(hostedBody).toContain('createDesktopPollCredentials()');
    expect(hostedBody).toContain('pollDesktopAuthorization(pollSecret');
    // authorize 收到的必须是哈希后的 clientState,而不是原像
    expect(hostedBody).toContain('state: clientState');
    expect(hostedBody).not.toContain('pollDesktopAuthorization(input.state');
  });

  it('托管链路不落地本地监听,loopback 链路保持原样', () => {
    const hostedStart = source.indexOf('async function openHostedBrowserAuthorization(');
    expect(hostedStart).toBeGreaterThan(-1);
    const hostedBody = source.slice(hostedStart, source.indexOf('\n}\n', hostedStart));
    // 先钉住切片真的取到了函数体,否则下面两条 not.toContain 会在空串上假通过。
    expect(hostedBody).toContain('runHostedCallbackPolling({');
    expect(hostedBody).toContain('shell.openExternal(authUrl)');
    // 托管链路整个不碰本地 HTTP server —— 这正是它绕开 IP 暴露的前提。
    expect(hostedBody).not.toContain('createServer(');
    expect(hostedBody).not.toContain('127.0.0.1');

    // loopback 链路仍是那台随机端口监听,回退路径没有被顺手改掉。
    const loopbackStart = source.indexOf('async function openLoopbackBrowserAuthorization(');
    expect(loopbackStart).toBeGreaterThan(-1);
    const loopbackBody = source.slice(loopbackStart);
    expect(loopbackBody).toContain("server.listen(0, '127.0.0.1'");
    expect(loopbackBody).toContain('http://127.0.0.1:${address.port}/auth/callback');
  });
});
