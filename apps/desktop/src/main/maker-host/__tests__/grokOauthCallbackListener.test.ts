/**
 * CallbackListener(xAI OAuth loopback 回调)回归单测 —— issue #491。
 *
 * xAI 新版 consent 页(accounts.x.ai)授权后不再 302 重定向,而是页面 JS 跨源
 * fetch http://127.0.0.1:56121/callback 投递 code。回归点:
 *   - CORS/PNA preflight(OPTIONS)必须 204 放行且不得终止登录流 —— 修复前它落进
 *     缺 code 分支直接 reject,整个登录被 preflight 杀死;
 *   - 回执必须带 CORS 头(白名单限 xAI auth 域),否则 consent 页 fetch 读不到结果;
 *   - 无 code 无 error 的杂请求不得终止等待中的登录;
 *   - 首个终态结果落定后,重试回调不得覆盖 pendingRes / 登录结果。
 */

import { request as httpRequest } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  shell: { openExternal: vi.fn() },
  app: {
    getPath: vi.fn(() => '/tmp/xdt-maker-test'),
    getAppPath: vi.fn(() => '/tmp/xdt-maker-test/app'),
    isPackaged: false,
  },
  safeStorage: { isEncryptionAvailable: vi.fn(() => false) },
}));

import {
  CallbackListener,
  XAI_CALLBACK_PORT_OCCUPIED_MESSAGE,
  xaiCallbackCorsHeaders,
} from '../grok-oauth-login.js';

const PORT = 56121;
const XAI_ORIGIN = 'https://accounts.x.ai';

interface HttpResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** 用 node:http 直发请求(fetch 不允许自定义 Origin 这类受管头)。 */
function send(
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      // agent:false —— 每请求独立连接。全局 agent 的 keep-alive 会把上一个用例
      // 已关闭 server 的死 socket 复用给下一个用例,产生假 ECONNRESET。
      { host: '127.0.0.1', port: PORT, method, path, headers, agent: false },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => (body += chunk.toString('utf-8')));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** 断言 promise 在 wait 毫秒内保持 pending(登录流未被终止)。 */
async function expectStillPending(p: Promise<unknown>, wait = 50): Promise<void> {
  const outcome = await Promise.race([
    p.then(
      () => 'settled',
      () => 'settled',
    ),
    new Promise<string>((r) => setTimeout(() => r('pending'), wait)),
  ]);
  expect(outcome).toBe('pending');
}

describe('xaiCallbackCorsHeaders', () => {
  it('白名单 origin(accounts.x.ai / auth.x.ai)返回完整 CORS + PNA 头', () => {
    for (const origin of ['https://accounts.x.ai', 'https://auth.x.ai']) {
      const h = xaiCallbackCorsHeaders(origin);
      expect(h['Access-Control-Allow-Origin']).toBe(origin);
      expect(h['Access-Control-Allow-Methods']).toBe('GET, OPTIONS');
      expect(h['Access-Control-Allow-Private-Network']).toBe('true');
      expect(h.Vary).toBe('Origin');
    }
  });

  it('非白名单 / 缺失 origin 不放行', () => {
    expect(xaiCallbackCorsHeaders('https://evil.example')).toEqual({});
    expect(xaiCallbackCorsHeaders('http://accounts.x.ai')).toEqual({});
    expect(xaiCallbackCorsHeaders(undefined)).toEqual({});
  });
});

/**
 * 绑 56121 时它可能短暂被别人占着,有两个来源:
 *   1. 文件内部:close() 同步返回但端口是异步释放的,上一个用例「调过 close」
 *      不等于端口已交还,下一个用例立刻重绑就撞上;
 *   2. 文件外部:56121 落在临时端口段内(macOS 49152–65535 / Linux 32768–60999),
 *      任何用 listen(0) 拿端口的并发用例都可能被内核分到它。desktop unit tier
 *      一轮 1330 个文件、threads 池下还共享同一个进程,这不是理论风险 —— CI 上
 *      两轮分别撞在不同用例的 beforeEach 上。而 xAI 只接受
 *      http://127.0.0.1:56121/callback,端口换不了。
 *
 * 两者是同一句话,所以只留一个判据:仅在引擎明确报出「端口被占用」时短暂重试,
 * 其它启动失败原样抛出,不掩盖真正的问题。每次重试用全新实例,免得复用一个
 * listen 失败过的 server。同族的客户端那一半由 send() 的 agent:false 处理。
 *
 * 判据必须与生产同源:start() 把底层错误包成新 Error、丢掉了 err.code,只剩文本可看,
 * 而按端口号做子串匹配会连 EACCES / EADDRNOTAVAIL 一起收进来(它们的原文里同样带端口
 * 号),把真正的启动故障当成「端口被占」白重试 100 次。所以整条比对生产导出的那句
 * EADDRINUSE 专属提示。
 */
async function startFreshListener(): Promise<CallbackListener> {
  for (let attempt = 1; ; attempt += 1) {
    const candidate = new CallbackListener();
    try {
      await candidate.start();
      return candidate;
    } catch (err) {
      candidate.close();
      const occupied = err instanceof Error && err.message === XAI_CALLBACK_PORT_OCCUPIED_MESSAGE;
      if (!occupied || attempt >= 100) throw err;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

describe('CallbackListener(xAI loopback 回调)', () => {
  let listener: CallbackListener;

  beforeEach(async () => {
    listener = await startFreshListener();
  });

  afterEach(() => {
    listener.close();
  });

  it('OPTIONS preflight 回 204 + CORS/PNA 头,且不终止登录流', async () => {
    const codePromise = listener.waitForCode('state-1');
    codePromise.catch(() => undefined);

    const res = await send('OPTIONS', '/callback', {
      origin: XAI_ORIGIN,
      'access-control-request-method': 'GET',
      'access-control-request-private-network': 'true',
    });
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(XAI_ORIGIN);
    expect(res.headers['access-control-allow-private-network']).toBe('true');

    // 修复前:preflight 落进缺 code 分支,登录流被 reject 杀死。
    await expectStillPending(codePromise);

    // preflight 后正式 GET 仍能完成登录。
    const getPromise = send('GET', '/callback?code=abc123&state=state-1', {
      origin: XAI_ORIGIN,
    });
    await expect(codePromise).resolves.toBe('abc123');
    listener.succeed();
    const getRes = await getPromise;
    expect(getRes.status).toBe(200);
    expect(getRes.headers['access-control-allow-origin']).toBe(XAI_ORIGIN);
  });

  it('无 code 无 error 的杂请求回 400 但登录继续等待', async () => {
    const codePromise = listener.waitForCode('state-2');
    codePromise.catch(() => undefined);

    // 完全无参数(走 state-mismatch 拒绝)与 state 匹配但缺 code(走缺 code 分支)
    // 两条路径都不得终止登录。
    const res = await send('GET', '/callback');
    expect(res.status).toBe(400);
    const matchedNoCode = await send('GET', '/callback?state=state-2');
    expect(matchedNoCode.status).toBe(400);
    await expectStillPending(codePromise);

    const getPromise = send('GET', '/callback?code=xyz&state=state-2');
    await expect(codePromise).resolves.toBe('xyz');
    listener.succeed();
    await getPromise;
  });

  it('state 匹配的 error 回调终止登录并透出 error_description', async () => {
    const codePromise = listener.waitForCode('state-3');
    // 与生产 runGrokOAuthLogin 同模式预挂 no-op catch:reject 可能先于下方
    // rejects 断言挂载,避免被记成 unhandled rejection。
    codePromise.catch(() => undefined);
    const res = await send(
      'GET',
      '/callback?error=access_denied&error_description=user%20denied&state=state-3',
      { origin: XAI_ORIGIN },
    );
    expect(res.status).toBe(400);
    expect(res.headers['access-control-allow-origin']).toBe(XAI_ORIGIN);
    await expect(codePromise).rejects.toThrow('No authorization code received');
  });

  it('state 不匹配的回调(旧登录 tab 滞留重试)回 400 但不终止当前登录', async () => {
    const codePromise = listener.waitForCode('expected-state');

    // 旧 tab 带旧 state 的 code 重试与 error 回调都只被拒,不得 settle 当前登录。
    const staleCode = await send('GET', '/callback?code=abc&state=wrong-state', {
      origin: XAI_ORIGIN,
    });
    expect(staleCode.status).toBe(400);
    const staleError = await send(
      'GET',
      '/callback?error=access_denied&state=wrong-state',
      { origin: XAI_ORIGIN },
    );
    expect(staleError.status).toBe(400);
    await expectStillPending(codePromise);

    // 当前登录自己的回调随后到达,仍正常完成。
    const getPromise = send('GET', '/callback?code=real&state=expected-state', {
      origin: XAI_ORIGIN,
    });
    await expect(codePromise).resolves.toBe('real');
    listener.succeed();
    await getPromise;
  });

  it('exchange 进行中的重试回调挂起同候,succeed() 后与首个一起收到 200', async () => {
    const codePromise = listener.waitForCode('state-5');

    const firstGet = send('GET', '/callback?code=first&state=state-5', {
      origin: XAI_ORIGIN,
    });
    await expect(codePromise).resolves.toBe('first');

    // token 交换进行中,页面重试 fetch —— 不能提前拿到 200(交换随后可能失败),
    // 必须与首个连接一起等 succeed()/fail() 收口。
    const retry = send('GET', '/callback?code=first&state=state-5', {
      origin: XAI_ORIGIN,
    });
    await expectStillPending(retry);

    // exchange 挂起窗口内 state 不匹配的请求立即 400 拒绝,不得入 pending 挂起
    // (否则不知道 state 的本机进程可囤积任意多连接)。
    const staleDuringExchange = await send('GET', '/callback?code=x&state=wrong', {
      origin: XAI_ORIGIN,
    });
    expect(staleDuringExchange.status).toBe(400);

    listener.succeed();
    const [first, second] = await Promise.all([firstGet, retry]);
    for (const r of [first, second]) {
      expect(r.status).toBe(200);
      expect(r.headers['access-control-allow-origin']).toBe(XAI_ORIGIN);
      expect(r.body).toContain('html');
    }

    // 成功收口后的迟到回调直接重放成功回执;state 不匹配的迟到请求仍被 400 拒绝,
    // 不得吃到成功重放。
    const late = await send('GET', '/callback?code=first&state=state-5', {
      origin: XAI_ORIGIN,
    });
    expect(late.status).toBe(200);
    const staleAfterSuccess = await send('GET', '/callback?code=x&state=wrong', {
      origin: XAI_ORIGIN,
    });
    expect(staleAfterSuccess.status).toBe(400);
  });

  it('exchange 失败后挂起的重试与首个一起收到 500,迟到回调重放 400', async () => {
    const codePromise = listener.waitForCode('state-5b');
    const firstGet = send('GET', '/callback?code=bad&state=state-5b', {
      origin: XAI_ORIGIN,
    });
    await expect(codePromise).resolves.toBe('bad');
    const retry = send('GET', '/callback?code=bad&state=state-5b', {
      origin: XAI_ORIGIN,
    });
    await expectStillPending(retry);

    listener.fail('exchange exploded');
    const [first, second] = await Promise.all([firstGet, retry]);
    expect(first.status).toBe(500);
    expect(second.status).toBe(500);

    const late = await send('GET', '/callback?code=bad&state=state-5b', {
      origin: XAI_ORIGIN,
    });
    expect(late.status).toBe(400);
  });

  it('error 终态后的重试回调重放 4xx,不得误报成功', async () => {
    const codePromise = listener.waitForCode('state-5c');
    codePromise.catch(() => undefined);
    // state 必须匹配:否则请求走 state-mismatch 分支被拒,终态从未建立,
    // 本用例就测不到「error 终态后的重放」路径(3f98a3f 曾漏改此处)。
    const first = await send('GET', '/callback?error=access_denied&state=state-5c', {
      origin: XAI_ORIGIN,
    });
    expect(first.status).toBe(400);
    await expect(codePromise).rejects.toThrow('No authorization code received');

    const retry = await send('GET', '/callback?error=access_denied&state=state-5c', {
      origin: XAI_ORIGIN,
    });
    expect(retry.status).toBe(400);
    expect(retry.headers['access-control-allow-origin']).toBe(XAI_ORIGIN);
  });

  it('非白名单 origin 的响应不带 CORS 放行头', async () => {
    const codePromise = listener.waitForCode('state-6');
    const getPromise = send('GET', '/callback?code=ok&state=state-6', {
      origin: 'https://evil.example',
    });
    await expect(codePromise).resolves.toBe('ok');
    listener.succeed();
    const res = await getPromise;
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('挂起连接被客户端中止后 succeed() 不抛错,状态机不受影响', async () => {
    const codePromise = listener.waitForCode('state-7');

    // 发起回调后立刻掐断客户端连接(用户在 exchange 期间关掉授权页)。
    const aborted = await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: PORT,
          method: 'GET',
          path: '/callback?code=abort-me&state=state-7',
          headers: { origin: XAI_ORIGIN },
          agent: false,
        },
        () => resolve(),
      );
      req.on('error', reject);
      req.end();
      // code 被消费(连接进入 pending hold)后销毁 socket。
      void codePromise.then(() => {
        setTimeout(() => {
          req.destroy();
          resolve();
        }, 30);
      });
    }).then(
      () => true,
      () => true,
    );
    expect(aborted).toBe(true);
    await expect(codePromise).resolves.toBe('abort-me');

    // 凭证已落盘场景:succeed() 面对已中止的连接不得抛错。
    expect(() => listener.succeed()).not.toThrow();

    // 状态机仍是成功终态:迟到回调拿到成功重放。
    const late = await send('GET', '/callback?code=abort-me&state=state-7', {
      origin: XAI_ORIGIN,
    });
    expect(late.status).toBe(200);
  });

  it('回调端口被占用时 start() 报可读错误', async () => {
    const blocker = new CallbackListener();
    // beforeEach 已占 56121,新实例 start 应失败。整条比对,不按端口号做子串匹配
    // ——后者对任何带端口号的 listen 失败都成立(见 startFreshListener 说明)。
    await expect(blocker.start()).rejects.toThrow(XAI_CALLBACK_PORT_OCCUPIED_MESSAGE);
    blocker.close();
    // 上面那条是同源比对,改文案不会让它失败;这句守住「用户看得见端口号」这个可读性
    // 要求本身,顺带交叉校验测试里的 PORT 与生产的 REDIRECT_PORT 没有跑偏。
    expect(XAI_CALLBACK_PORT_OCCUPIED_MESSAGE).toContain(String(PORT));
  });
});
