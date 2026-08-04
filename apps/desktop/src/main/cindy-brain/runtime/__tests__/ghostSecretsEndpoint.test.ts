import { describe, expect, it, vi } from 'vitest';

import { GhostKvError } from '../../ghostKvStore.js';
import { deriveGhostSecretTail } from '../../../../shared/providerSecrets.js';
import {
  GHOST_SECRET_VALUE_MAX_CHARS,
  handleGhostSecretsRequest,
  type GhostSecretsVault,
} from '../ghostSecretsEndpoint.js';

/**
 * 内存假保险库:端点层只关心分派与折叠,不碰 safeStorage。
 * tail 语义与真身(providerSecretStore)对齐:入库即截、读时只回预截值。
 */
function memVault(saved: Record<string, string> = {}): GhostSecretsVault & {
  data: Record<string, string>;
} {
  const data = { ...saved };
  const tails: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    const tail = deriveGhostSecretTail(value);
    if (tail) tails[key] = tail;
  }
  return {
    data,
    saved: vi.fn((_id: string, key: string) => key in data),
    tail: vi.fn((_id: string, key: string) => tails[key] ?? null),
    store: vi.fn((_id: string, key: string, value: string) => {
      data[key] = value;
      const tail = deriveGhostSecretTail(value);
      if (tail) tails[key] = tail;
      else delete tails[key];
      return true;
    }),
    remove: vi.fn((_id: string, key: string) => {
      delete data[key];
      delete tails[key];
    }),
  };
}

function call(args: {
  method: string;
  pathname: string;
  body?: string;
  keys?: string[];
  vault?: GhostSecretsVault;
}) {
  return handleGhostSecretsRequest({
    method: args.method,
    pathname: args.pathname,
    readBodyText: () => Promise.resolve(args.body ?? ''),
    userSecretKeys: args.keys ?? ['api_key'],
    vault: args.vault ?? memVault(),
    ghostId: 'demo',
  });
}

describe('cindy-brain · ghostSecretsEndpoint(user 凭证只写通道,意识收单)', () => {
  it('GET /secrets → 200 + 每条 user 凭证的 {key, saved}(无明文;短值无 tail)', async () => {
    const vault = memVault({ api_key: 'sk-secret' }); // 9 字符 < 12,不产指纹
    const out = await call({
      method: 'GET',
      pathname: '/secrets',
      keys: ['api_key', 'other'],
      vault,
    });
    expect(out.status).toBe(200);
    expect(JSON.parse(out.body ?? '')).toEqual([
      { key: 'api_key', saved: true },
      { key: 'other', saved: false },
    ]);
    expect(out.body).not.toContain('sk-secret'); // 只写通道:状态回查绝不带值
  });

  it('GET /secrets 长值 → 附尾 4 位指纹 tail;明文其余部分绝不出现', async () => {
    const vault = memVault({ api_key: 'mivo_abcdefgh1234' });
    const out = await call({ method: 'GET', pathname: '/secrets', keys: ['api_key'], vault });
    expect(out.status).toBe(200);
    expect(JSON.parse(out.body ?? '')).toEqual([{ key: 'api_key', saved: true, tail: '1234' }]);
    expect(out.body).not.toContain('mivo_abcdefgh'); // 指纹之外一个字符都不多给
  });

  it('未存值的键即便保险库留有孤儿指纹也不回 tail', async () => {
    const vault = memVault();
    (vault.tail as ReturnType<typeof vi.fn>).mockReturnValue('leak');
    const out = await call({ method: 'GET', pathname: '/secrets', keys: ['api_key'], vault });
    expect(JSON.parse(out.body ?? '')).toEqual([{ key: 'api_key', saved: false }]);
  });

  it('login-email 身份凭证:GET 附 identity(登录邮箱);未登录 saved:false 无 identity', async () => {
    const base = {
      method: 'GET',
      pathname: '/secrets',
      readBodyText: () => Promise.resolve(''),
      userSecretKeys: ['api_key'],
      identitySecretKeys: ['pages_token'],
      vault: memVault({ api_key: 'mivo_abcdefgh1234' }),
      ghostId: 'demo',
    };
    const on = await handleGhostSecretsRequest({ ...base, getLoginEmail: () => ' a@example.com ' });
    expect(JSON.parse(on.body ?? '')).toEqual([
      { key: 'api_key', saved: true, tail: '1234' },
      { key: 'pages_token', saved: true, identity: 'a@example.com' },
    ]);
    const off = await handleGhostSecretsRequest({ ...base, getLoginEmail: () => null });
    expect(JSON.parse(off.body ?? '')).toEqual([
      { key: 'api_key', saved: true, tail: '1234' },
      { key: 'pages_token', saved: false },
    ]);
  });

  it('login-email 键不可配置:PUT/POST/DELETE 一律 405', async () => {
    for (const method of ['GET', 'PUT', 'POST', 'DELETE']) {
      const out = await handleGhostSecretsRequest({
        method,
        pathname: '/secrets/pages_token',
        readBodyText: () => Promise.resolve('{"value":"x"}'),
        userSecretKeys: [],
        identitySecretKeys: ['pages_token'],
        getLoginEmail: () => 'a@example.com',
        vault: memVault(),
        ghostId: 'demo',
      });
      expect(out.status, method).toBe(405);
    }
  });

  it('oidc-token 只回 Host 托管就绪状态，不回 token/audience/身份资料且不可写删', async () => {
    const base = {
      readBodyText: () => Promise.resolve('{"value":"forged"}'),
      userSecretKeys: [] as string[],
      managedSecretStates: [{ key: 'cindy_identity', saved: true }],
      vault: memVault(),
      ghostId: 'demo',
    };
    const list = await handleGhostSecretsRequest({
      ...base,
      method: 'GET',
      pathname: '/secrets',
    });
    expect(JSON.parse(list.body ?? '')).toEqual([
      { key: 'cindy_identity', saved: true, managed: true },
    ]);
    expect(list.body).not.toMatch(/token|audience|membership|org-example/i);

    for (const method of ['GET', 'PUT', 'POST', 'DELETE']) {
      const out = await handleGhostSecretsRequest({
        ...base,
        method,
        pathname: '/secrets/cindy_identity',
      });
      expect(out.status, method).toBe(405);
    }
  });

  it('PUT /secrets/<key> 合法值 → 204 且 trim 后入库;POST 等价', async () => {
    for (const method of ['PUT', 'POST']) {
      const vault = memVault();
      const out = await call({
        method,
        pathname: '/secrets/api_key',
        body: JSON.stringify({ value: '  mivo_abc123  ' }),
        vault,
      });
      expect(out.status, method).toBe(204);
      expect(vault.store).toHaveBeenCalledWith('demo', 'api_key', 'mivo_abc123');
    }
  });

  it('onStored 通知钩子:入库成功才触发,失败/DELETE 不触发;钩子抛错不影响 204', async () => {
    // 成功 → 触发一次,带 secretKey
    const onStored = vi.fn();
    const okOut = await handleGhostSecretsRequest({
      method: 'PUT',
      pathname: '/secrets/api_key',
      readBodyText: () => Promise.resolve('{"value":"v"}'),
      userSecretKeys: ['api_key'],
      vault: memVault(),
      ghostId: 'demo',
      onStored,
    });
    expect(okOut.status).toBe(204);
    expect(onStored).toHaveBeenCalledTimes(1);
    expect(onStored).toHaveBeenCalledWith('api_key');

    // 写失败 → 不触发
    const onStoredFail = vi.fn();
    const failing: GhostSecretsVault = { saved: () => false, tail: () => null, store: () => false, remove: () => {} };
    await handleGhostSecretsRequest({
      method: 'PUT',
      pathname: '/secrets/api_key',
      readBodyText: () => Promise.resolve('{"value":"v"}'),
      userSecretKeys: ['api_key'],
      vault: failing,
      ghostId: 'demo',
      onStored: onStoredFail,
    });
    expect(onStoredFail).not.toHaveBeenCalled();

    // DELETE → 不触发(清除不是值得全局提示的事件)
    const onStoredDel = vi.fn();
    await handleGhostSecretsRequest({
      method: 'DELETE',
      pathname: '/secrets/api_key',
      readBodyText: () => Promise.resolve(''),
      userSecretKeys: ['api_key'],
      vault: memVault({ api_key: 'v' }),
      ghostId: 'demo',
      onStored: onStoredDel,
    });
    expect(onStoredDel).not.toHaveBeenCalled();

    // 钩子抛错 → 入库结果仍是 204(提示挂了不折叠真成功)
    const out = await handleGhostSecretsRequest({
      method: 'PUT',
      pathname: '/secrets/api_key',
      readBodyText: () => Promise.resolve('{"value":"v"}'),
      userSecretKeys: ['api_key'],
      vault: memVault(),
      ghostId: 'demo',
      onStored: () => {
        throw new Error('toast down');
      },
    });
    expect(out.status).toBe(204);
  });

  it('未声明 / 带子路径的 key → 统一 404,不给区分面', async () => {
    for (const pathname of ['/secrets/unknown', '/secrets/', '/secrets/a/b']) {
      expect((await call({ method: 'PUT', pathname, body: '{"value":"x"}' })).status, pathname).toBe(404);
    }
  });

  it('坏 body(非 JSON / 缺 value / 非字符串 / 空白值)→ 400', async () => {
    for (const body of ['{broken', '{}', '{"value":42}', '{"value":"   "}', '"str"', '[1]']) {
      const out = await call({ method: 'PUT', pathname: '/secrets/api_key', body });
      expect(out.status, body).toBe(400);
    }
  });

  it('值超长 → 413;有界读取器抛 TOO_LARGE → 413', async () => {
    const long = JSON.stringify({ value: 'x'.repeat(GHOST_SECRET_VALUE_MAX_CHARS + 1) });
    expect((await call({ method: 'PUT', pathname: '/secrets/api_key', body: long })).status).toBe(413);

    const out = await handleGhostSecretsRequest({
      method: 'PUT',
      pathname: '/secrets/api_key',
      readBodyText: () => Promise.reject(new GhostKvError('TOO_LARGE', 'x')),
      userSecretKeys: ['api_key'],
      vault: memVault(),
      ghostId: 'demo',
    });
    expect(out.status).toBe(413);
  });

  it('DELETE → 204 幂等;方法不符 → 405', async () => {
    const vault = memVault({ api_key: 'v' });
    expect((await call({ method: 'DELETE', pathname: '/secrets/api_key', vault })).status).toBe(204);
    expect(vault.data.api_key).toBeUndefined();
    expect((await call({ method: 'DELETE', pathname: '/secrets/api_key', vault })).status).toBe(204);

    expect((await call({ method: 'POST', pathname: '/secrets' })).status).toBe(405);
    expect((await call({ method: 'PATCH', pathname: '/secrets/api_key', body: '{"value":"x"}' })).status).toBe(405);
    expect((await call({ method: 'GET', pathname: '/secrets/api_key' })).status).toBe(405);
  });

  it('保险库写失败(store 返回 false)→ 500;意外抛错 → 500 不外泄', async () => {
    const failing: GhostSecretsVault = {
      saved: () => false,
      tail: () => null,
      store: () => false,
      remove: () => {},
    };
    expect(
      (await call({ method: 'PUT', pathname: '/secrets/api_key', body: '{"value":"x"}', vault: failing })).status,
    ).toBe(500);

    const boom: GhostSecretsVault = {
      saved: () => {
        throw new Error('safeStorage down: C:\\Users\\secret');
      },
      tail: () => {
        throw new Error('safeStorage down: C:\\Users\\secret');
      },
      store: () => {
        throw new Error('safeStorage down: C:\\Users\\secret');
      },
      remove: () => {
        throw new Error('safeStorage down: C:\\Users\\secret');
      },
    };
    const got = await call({ method: 'GET', pathname: '/secrets', vault: boom });
    expect(got.status).toBe(500);
    expect(got.body).toBeUndefined();
    expect(
      (await call({ method: 'PUT', pathname: '/secrets/api_key', body: '{"value":"x"}', vault: boom })).status,
    ).toBe(500);
    expect((await call({ method: 'DELETE', pathname: '/secrets/api_key', vault: boom })).status).toBe(500);
  });
});
