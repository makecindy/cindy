import { gzipSync } from 'node:zlib';

import { describe, expect, it, vi } from 'vitest';

import type { ResponseObserverCtx } from '@cindy/anthropic-compat-proxy';

import {
  createXaiAuthInvalidationObserver,
  createXaiBridgeAuthInvalidator,
  detectXaiBridgeAuthInvalidationReason,
  type XaiBridgeAuthFailure,
} from '../xai-bridge-auth-invalidation.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** api.x.ai 实测拒绝 OAuth 凭证时的真实响应体(2026-07)。 */
const REJECTED_BODY =
  '{"code":"unauthenticated:bad-credentials","error":"The OAuth2 access token could not be validated."}';

describe('xAI bridge auth invalidation', () => {
  it('只把认证状态码里的明确凭证作废信号分类为收口原因', () => {
    expect(detectXaiBridgeAuthInvalidationReason(403, REJECTED_BODY)).toBe('access_token_rejected');
    expect(detectXaiBridgeAuthInvalidationReason(401, REJECTED_BODY)).toBe('access_token_rejected');
    expect(
      detectXaiBridgeAuthInvalidationReason(403, 'The OAuth2 access token could not be validated.'),
    ).toBe('access_token_rejected');
  });

  it('不把普通 4xx 当成凭证失效', () => {
    // 不成形的 token 走 api.x.ai 另一条分支(400 invalid-argument),不是登录态问题。
    expect(
      detectXaiBridgeAuthInvalidationReason(
        400,
        '{"code":"invalid-argument","error":"Incorrect API key provided."}',
      ),
    ).toBeNull();
    // 配额 / 地域 / 模型未授权类 403 不带凭证作废标记,不能据此删用户凭证。
    expect(
      detectXaiBridgeAuthInvalidationReason(403, '{"code":"permission-denied","error":"no access"}'),
    ).toBeNull();
    expect(detectXaiBridgeAuthInvalidationReason(429, REJECTED_BODY)).toBeNull();
  });

  it('非作废信号直接放行,不触碰凭证', async () => {
    const recover = vi.fn(async () => 'refreshed' as const);
    const getCurrentAccessToken = vi.fn(async () => 'token-a');
    const handleFailure = createXaiBridgeAuthInvalidator({ getCurrentAccessToken, recover });

    await expect(
      handleFailure({ status: 429, body: REJECTED_BODY, failedAccessToken: 'token-a' }),
    ).resolves.toBe('ignored');
    expect(getCurrentAccessToken).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
  });

  it('当前凭证仍是失败 token 时执行收口', async () => {
    const recover = vi.fn(async () => 'refreshed' as const);
    const handleFailure = createXaiBridgeAuthInvalidator({
      getCurrentAccessToken: async () => 'token-a',
      recover,
    });

    await expect(
      handleFailure({ status: 403, body: REJECTED_BODY, failedAccessToken: 'token-a' }),
    ).resolves.toBe('refreshed');
    expect(recover).toHaveBeenCalledOnce();
    // 必须把被拒的 token 一并交给收口:等值检查到 recover 之间还有一次 await 边界,
    // 收口要用它重新绑定,否则会拿期间新登录的凭证承担旧 token 的失败。
    expect(recover).toHaveBeenCalledWith('access_token_rejected', 'token-a');
  });

  it('把 refresh_token 也被作废的结果原样回传', async () => {
    const handleFailure = createXaiBridgeAuthInvalidator({
      getCurrentAccessToken: async () => 'token-a',
      recover: async () => 'logged_out',
    });

    await expect(
      handleFailure({ status: 403, body: REJECTED_BODY, failedAccessToken: 'token-a' }),
    ).resolves.toBe('logged_out');
  });

  it('忽略新登录后迟到的旧 token 失败', async () => {
    const recover = vi.fn(async () => 'logged_out' as const);
    const handleFailure = createXaiBridgeAuthInvalidator({
      getCurrentAccessToken: async () => 'token-new',
      recover,
    });

    await expect(
      handleFailure({ status: 403, body: REJECTED_BODY, failedAccessToken: 'token-old' }),
    ).resolves.toBe('superseded');
    expect(recover).not.toHaveBeenCalled();
  });

  it('未登录(当前无凭证)时不执行收口', async () => {
    const recover = vi.fn(async () => 'logged_out' as const);
    const handleFailure = createXaiBridgeAuthInvalidator({
      getCurrentAccessToken: async () => null,
      recover,
    });

    await expect(
      handleFailure({ status: 403, body: REJECTED_BODY, failedAccessToken: 'token-a' }),
    ).resolves.toBe('superseded');
    expect(recover).not.toHaveBeenCalled();
  });

  it('合并同一失败 token 的并发收口', async () => {
    const currentToken = deferred<string | null>();
    const recover = vi.fn(async () => 'refreshed' as const);
    const getCurrentAccessToken = vi.fn(() => currentToken.promise);
    const handleFailure = createXaiBridgeAuthInvalidator({ getCurrentAccessToken, recover });
    const failure = {
      status: 403,
      body: REJECTED_BODY,
      failedAccessToken: 'token-a',
    };

    const first = handleFailure(failure);
    const second = handleFailure(failure);
    currentToken.resolve('token-a');

    await expect(Promise.all([first, second])).resolves.toEqual(['refreshed', 'refreshed']);
    expect(getCurrentAccessToken).toHaveBeenCalledOnce();
    expect(recover).toHaveBeenCalledOnce();
  });

  it('收口结束后释放合并槽位,后续失败重新收口', async () => {
    const recover = vi.fn(async () => 'unchanged' as const);
    const handleFailure = createXaiBridgeAuthInvalidator({
      getCurrentAccessToken: async () => 'token-a',
      recover,
    });
    const failure = { status: 403, body: REJECTED_BODY, failedAccessToken: 'token-a' };

    await handleFailure(failure);
    await handleFailure(failure);

    expect(recover).toHaveBeenCalledTimes(2);
  });
});

function observerCtx(overrides: Partial<ResponseObserverCtx> = {}): ResponseObserverCtx {
  return {
    reqId: 1,
    method: 'POST',
    url: '/v1/responses',
    upstreamBase: 'https://api.x.ai/v1',
    status: 403,
    // 客户端(codex 子进程)自带的 bearer 与实际路由注入的 xAI token 刻意不同 ——
    // 收口必须关联后者,读错就永远 superseded。
    requestHeaders: { authorization: 'Bearer codex-subprocess-token' },
    outboundHeaders: { authorization: 'Bearer token-a' },
    responseHeaders: {},
    requestBody: Buffer.alloc(0),
    ...overrides,
  };
}

describe('xAI codex-proxy auth invalidation observer', () => {
  it('成功响应与非认证状态码零开销跳过', () => {
    const handleFailure = vi.fn(async () => undefined);
    const observe = createXaiAuthInvalidationObserver(handleFailure);

    expect(observe(observerCtx({ status: 200 }))).toBeNull();
    expect(observe(observerCtx({ status: 500 }))).toBeNull();
    expect(handleFailure).not.toHaveBeenCalled();
  });

  it('非 xAI 上游不观察(避免误伤其它供应商凭证)', () => {
    const observe = createXaiAuthInvalidationObserver(async () => undefined);

    expect(observe(observerCtx({ upstreamBase: 'https://api.openai.com/v1' }))).toBeNull();
    expect(observe(observerCtx({ upstreamBase: 'not-a-url' }))).toBeNull();
  });

  it('请求没有 Bearer 时不观察(无从关联失败凭证)', () => {
    const observe = createXaiAuthInvalidationObserver(async () => undefined);

    expect(observe(observerCtx({ outboundHeaders: {} }))).toBeNull();
    expect(observe(observerCtx({ outboundHeaders: { authorization: 'Basic abc' } }))).toBeNull();
  });

  it('关联的是路由注入后的凭证,不是子进程自带的 bearer', () => {
    // 回归:xAI token 由 provider-route 经 headerOverride 注入,只有 outboundHeaders 里才有。
    // 早期版本读 requestHeaders,拿到 codex 自带 bearer → 等值比对永远不成立 → 收口静默失效。
    const handleFailure = vi.fn(async () => undefined);
    const observe = createXaiAuthInvalidationObserver(handleFailure);

    const sink = observe(observerCtx());
    sink!.onData?.(Buffer.from(REJECTED_BODY, 'utf-8'));
    sink!.onEnd?.();

    expect(handleFailure).toHaveBeenCalledWith(
      expect.objectContaining({ failedAccessToken: 'token-a' }),
    );
  });

  it('超大 chunk 按剩余空间裁剪,不整段驻留', () => {
    const seen: XaiBridgeAuthFailure[] = [];
    const observe = createXaiAuthInvalidationObserver(async (failure) => {
      seen.push(failure);
    });

    const sink = observe(observerCtx());
    // 首个 chunk 就远超上限:必须只留下上限内的部分。
    sink!.onData?.(Buffer.alloc(64 * 1024, 0x61));
    sink!.onData?.(Buffer.alloc(8 * 1024, 0x62));
    sink!.onEnd?.();

    expect(seen).toHaveLength(1);
    expect(seen[0].body).toBe('a'.repeat(8 * 1024));
  });

  it('401/403 命中 xAI 上游时把响应体与失败凭证交给收口', () => {
    const handleFailure = vi.fn(async () => undefined);
    const observe = createXaiAuthInvalidationObserver(handleFailure);

    const sink = observe(observerCtx());
    expect(sink).not.toBeNull();
    sink!.onData?.(Buffer.from(REJECTED_BODY, 'utf-8'));
    sink!.onEnd?.();

    expect(handleFailure).toHaveBeenCalledWith({
      status: 403,
      body: REJECTED_BODY,
      failedAccessToken: 'token-a',
    });
  });

  it('按 content-encoding 解压后再判定', () => {
    const handleFailure = vi.fn(async () => undefined);
    const observe = createXaiAuthInvalidationObserver(handleFailure);

    const sink = observe(observerCtx({ responseHeaders: { 'content-encoding': 'gzip' } }));
    sink!.onData?.(gzipSync(Buffer.from(REJECTED_BODY, 'utf-8')));
    sink!.onEnd?.();

    expect(handleFailure).toHaveBeenCalledWith(
      expect.objectContaining({ body: REJECTED_BODY }),
    );
  });
});
