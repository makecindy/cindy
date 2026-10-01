import { describe, expect, it, vi } from 'vitest';

import { GHOST_KV_MAX_BYTES, GhostKvError } from '../../ghostKvStore.js';
import { handleGhostKvRequest, readBoundedBodyText } from '../ghostKvEndpoint.js';

/** 内存假 store:端点层只关心分派与折叠,不落盘。 */
function memStore(initial: Record<string, unknown> = {}) {
  const data: Record<string, Record<string, unknown>> = { demo: initial };
  return {
    read: vi.fn((id: string) => data[id] ?? {}),
    write: vi.fn((id: string, v: Record<string, unknown>) => {
      data[id] = v;
    }),
  };
}

function call(args: {
  method: string;
  body?: string;
  store?: ReturnType<typeof memStore>;
}) {
  const store = args.store ?? memStore();
  return handleGhostKvRequest({
    method: args.method,
    readBodyText: () => Promise.resolve(args.body ?? ''),
    store,
    ghostId: 'demo',
  });
}

describe('cindy-brain · ghostKvEndpoint(/kv 分派纯函数)', () => {
  it.each(['PUT', 'POST'])('rejects a late %s body after its install target changes', async (method) => {
    const store = memStore({ source: 'replacement' });
    let current = true;
    let finishBody!: (body: string) => void;
    const body = new Promise<string>((resolve) => { finishBody = resolve; });
    const pending = handleGhostKvRequest({
      method, ghostId: 'demo', store, readBodyText: () => body,
      isCurrent: () => current,
    });
    current = false;
    finishBody('{"source":"old"}');
    expect(await pending).toEqual({ status: 403 });
    expect(store.write).not.toHaveBeenCalled();
    expect(store.read('demo')).toEqual({ source: 'replacement' });
  });

  it('rejects a non-current request before reading either its body or stored data', async () => {
    const store = memStore();
    const readBodyText = vi.fn(async () => '{"source":"old"}');
    for (const method of ['GET', 'PUT', 'POST']) {
      expect(await handleGhostKvRequest({
        method, ghostId: 'demo', store, readBodyText, isCurrent: () => false,
      })).toEqual({ status: 403 });
    }
    expect(readBodyText).not.toHaveBeenCalled();
    expect(store.read).not.toHaveBeenCalled();
    expect(store.write).not.toHaveBeenCalled();
  });

  it('preserves a late body from the unchanged current install', async () => {
    const store = memStore();
    let finishBody!: (body: string) => void;
    const body = new Promise<string>((resolve) => { finishBody = resolve; });
    const pending = handleGhostKvRequest({
      method: 'PUT', ghostId: 'demo', store, readBodyText: () => body, isCurrent: () => true,
    });
    finishBody('{"source":"current"}');
    expect(await pending).toEqual({ status: 204 });
    expect(store.write).toHaveBeenCalledExactlyOnceWith('demo', { source: 'current' });
  });

  it('GET → 200 + store 内容 JSON', async () => {
    const store = memStore({ theme: 'dark' });
    const out = await call({ method: 'GET', store });
    expect(out.status).toBe(200);
    expect(JSON.parse(out.body ?? '')).toEqual({ theme: 'dark' });
    expect(store.read).toHaveBeenCalledWith('demo');
  });

  it('PUT / POST 合法 object → 204 且 write 收到解析值', async () => {
    for (const method of ['PUT', 'POST']) {
      const store = memStore();
      const out = await call({ method, body: '{"a":1}', store });
      expect(out.status, method).toBe(204);
      expect(out.body, method).toBeUndefined();
      expect(store.write).toHaveBeenCalledWith('demo', { a: 1 });
    }
  });

  it('坏 JSON → 400,write 不被触及', async () => {
    const store = memStore();
    expect((await call({ method: 'PUT', body: '{broken', store })).status).toBe(400);
    expect(store.write).not.toHaveBeenCalled();
  });

  it('非 object(数组 / 标量 / null)→ 400', async () => {
    for (const body of ['[1,2]', '"str"', '42', 'null', 'true']) {
      expect((await call({ method: 'PUT', body })).status, body).toBe(400);
    }
  });

  it('超限 body → 413,且不进 JSON.parse(坏 JSON 超限也报 413 不报 400)', async () => {
    const over = `{"k":"${'x'.repeat(GHOST_KV_MAX_BYTES)}`; // 超限且故意不闭合
    const store = memStore();
    expect((await call({ method: 'PUT', body: over, store })).status).toBe(413);
    expect(store.write).not.toHaveBeenCalled();
  });

  it('其它 method(DELETE / PATCH / HEAD)→ 405', async () => {
    for (const method of ['DELETE', 'PATCH', 'HEAD']) {
      expect((await call({ method })).status, method).toBe(405);
    }
  });

  it('store.write 抛 GhostKvError → 按 code 映射 413/400', async () => {
    const tooLarge = {
      read: vi.fn(() => ({})),
      write: vi.fn(() => {
        throw new GhostKvError('TOO_LARGE', 'x');
      }),
    };
    expect(
      (await handleGhostKvRequest({
        method: 'PUT',
        readBodyText: () => Promise.resolve('{"a":1}'),
        store: tooLarge,
        ghostId: 'demo',
      })).status,
    ).toBe(413);

    const invalid = {
      read: vi.fn(() => ({})),
      write: vi.fn(() => {
        throw new GhostKvError('INVALID_GHOST_ID', 'x');
      }),
    };
    expect(
      (await handleGhostKvRequest({
        method: 'PUT',
        readBodyText: () => Promise.resolve('{"a":1}'),
        store: invalid,
        ghostId: 'demo',
      })).status,
    ).toBe(400);
  });

  it('store 意外抛错 → 500 且 body 不外泄错误细节', async () => {
    const boom = {
      read: vi.fn(() => {
        throw new Error('disk on fire: C:\\Users\\secret');
      }),
      write: vi.fn(() => {
        throw new Error('disk on fire: C:\\Users\\secret');
      }),
    };
    const got = await handleGhostKvRequest({
      method: 'GET',
      readBodyText: () => Promise.resolve(''),
      store: boom,
      ghostId: 'demo',
    });
    expect(got.status).toBe(500);
    expect(got.body).toBeUndefined();

    const put = await handleGhostKvRequest({
      method: 'PUT',
      readBodyText: () => Promise.resolve('{"a":1}'),
      store: boom,
      ghostId: 'demo',
    });
    expect(put.status).toBe(500);
    expect(put.body).toBeUndefined();
  });

  it('readBodyText 本身 reject(流被打断)→ 400 不炸', async () => {
    const store = memStore();
    const out = await handleGhostKvRequest({
      method: 'PUT',
      readBodyText: () => Promise.reject(new Error('aborted')),
      store,
      ghostId: 'demo',
    });
    expect(out.status).toBe(400);
  });
});

/** 假流式请求:按 chunk 序列喂 reader,记录是否被 cancel。 */
function fakeBodySource(args: { contentLength?: string; chunks?: Uint8Array[] }) {
  const chunks = [...(args.chunks ?? [])];
  let cancelled = false;
  return {
    cancelled: () => cancelled,
    source: {
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'content-length' ? (args.contentLength ?? null) : null,
      },
      body:
        args.chunks === undefined
          ? null
          : {
              getReader: () => ({
                read: () =>
                  Promise.resolve(
                    chunks.length > 0
                      ? { done: false, value: chunks.shift() }
                      : { done: true as const },
                  ),
                cancel: () => {
                  cancelled = true;
                  return Promise.resolve();
                },
              }),
            },
    },
  };
}

describe('cindy-brain · readBoundedBodyText(不受信 body 有界读取,防主进程 OOM)', () => {
  it('content-length 声明超限 → 不碰 body 直接抛 TOO_LARGE', async () => {
    const f = fakeBodySource({
      contentLength: String(GHOST_KV_MAX_BYTES + 1),
      chunks: [new TextEncoder().encode('{"a":1}')],
    });
    let caught: unknown;
    try {
      await readBoundedBodyText(f.source);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GhostKvError);
    expect((caught as GhostKvError).code).toBe('TOO_LARGE');
  });

  it('无 content-length 的超限流 → 累读过上限即断流抛 TOO_LARGE 并 cancel 余流', async () => {
    const chunk = new Uint8Array(16 * 1024).fill(120); // 16KB 'x'
    const f = fakeBodySource({ chunks: [chunk, chunk, chunk, chunk, chunk] }); // 80KB > 64KB
    let caught: unknown;
    try {
      await readBoundedBodyText(f.source);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GhostKvError);
    expect((caught as GhostKvError).code).toBe('TOO_LARGE');
    expect(f.cancelled()).toBe(true);
  });

  it('正常多 chunk 读取(CJK 跨 chunk 切断也解对)', async () => {
    const whole = new TextEncoder().encode('{"名":"值"}');
    // 故意在多字节字符中间切开
    const f = fakeBodySource({ chunks: [whole.slice(0, 5), whole.slice(5)] });
    expect(await readBoundedBodyText(f.source)).toBe('{"名":"值"}');
  });

  it('无 body → 空字符串;恰好压线的流放行', async () => {
    expect(await readBoundedBodyText(fakeBodySource({}).source)).toBe('');
    const exact = new Uint8Array(GHOST_KV_MAX_BYTES).fill(120);
    const f = fakeBodySource({ contentLength: String(GHOST_KV_MAX_BYTES), chunks: [exact] });
    const text = await readBoundedBodyText(f.source);
    expect(text.length).toBe(GHOST_KV_MAX_BYTES);
  });

  it('端点集成:readBodyText 抛 TOO_LARGE → 413(不是 400)', async () => {
    const store = { read: vi.fn(() => ({})), write: vi.fn() };
    const out = await handleGhostKvRequest({
      method: 'PUT',
      readBodyText: () => Promise.reject(new GhostKvError('TOO_LARGE', 'x')),
      store,
      ghostId: 'demo',
    });
    expect(out.status).toBe(413);
    expect(store.write).not.toHaveBeenCalled();
  });
});
