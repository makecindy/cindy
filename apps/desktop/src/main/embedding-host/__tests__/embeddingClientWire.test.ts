/**
 * embeddingClientWire.test.ts — EmbeddingClient 的 wire 行为单测(注入 fetch,不出网)。
 *
 * 为什么这份测试放在 desktop 而不是 packages/embedding-client:该包当前在
 * `scripts/test-workspaces.config.mjs` 里登记为 noCollectableWorkspace(无测试),
 * 升级成 required workspace 要给它加 vitest devDependency 并改 lockfile —— 与本次
 * 改动无关的扩面。desktop 是该包唯一 consumer,在这里测能连带覆盖真实调用链。
 * 将来若那个包自己长出测试目录,把本文件整体搬过去(断言无需改动)。
 *
 * 锁住的三件事都是"错了不报错、只是结果悄悄不对"的类型:
 *   1. input_type 的**按家翻译**(各家值域互斥,透传等于让一半模型确定性报错);
 *   2. 维度参数统一用 OpenAI 的 `dimensions` 名字(voyage 自己的名字对另两家被吞);
 *   3. inputType / dimensions 计入缓存 key(漏计 = 后到的请求静默拿到前一档的向量)。
 */

import { describe, it, expect, vi } from 'vitest';

import { EmbeddingClient, EmbeddingError } from '@cindy/embedding-client';

/** 造一个回固定维度的假网关;返回抓到的每次请求体供断言。 */
function harness(dim = 4) {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    const inputs = body.input as string[];
    const width = typeof body.dimensions === 'number' ? body.dimensions : dim;
    return new Response(
      JSON.stringify({
        object: 'list',
        model: String(body.model),
        data: inputs.map((_t, index) => ({
          object: 'embedding',
          index,
          embedding: Array.from({ length: width }, (_v, i) => i),
        })),
        usage: { prompt_tokens: 3 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  });
  const client = new EmbeddingClient({
    baseUrl: 'https://gateway.invalid',
    getApiKey: () => 'test-key',
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return { client, bodies, fetchImpl };
}

describe('EmbeddingClient · input_type 按 provider 翻译', () => {
  it('voyage 发小写 query / document(它对大写枚举回 500)', async () => {
    const { client, bodies } = harness();
    await client.embed({ texts: ['a'], model: 'voyage/voyage-4', inputType: 'query' });
    await client.embed({ texts: ['b'], model: 'voyage/voyage-4', inputType: 'document' });
    expect(bodies[0].input_type).toBe('query');
    expect(bodies[1].input_type).toBe('document');
  });

  it('google 发 Vertex 大写枚举(它对小写回 400)', async () => {
    const { client, bodies } = harness();
    await client.embed({
      texts: ['a'],
      model: 'gemini-embedding-2-preview',
      inputType: 'query',
    });
    await client.embed({
      texts: ['b'],
      model: 'gemini-embedding-2-preview',
      inputType: 'document',
    });
    expect(bodies[0].input_type).toBe('RETRIEVAL_QUERY');
    expect(bodies[1].input_type).toBe('RETRIEVAL_DOCUMENT');
  });

  it('openai 根本不发这个字段(该 API 没有此参数,发了只是无意义字段)', async () => {
    const { client, bodies } = harness();
    await client.embed({ texts: ['a'], model: 'text-embedding-3-small', inputType: 'query' });
    expect(bodies[0]).not.toHaveProperty('input_type');
  });

  it('不传 inputType 时任何家都不发该字段', async () => {
    const { client, bodies } = harness();
    await client.embed({ texts: ['a'], model: 'voyage/voyage-4' });
    expect(bodies[0]).not.toHaveProperty('input_type');
  });
});

describe('EmbeddingClient · 维度参数', () => {
  it('统一发 OpenAI 的 dimensions,不发 voyage 的 output_dimension', async () => {
    const { client, bodies } = harness();
    await client.embed({ texts: ['a'], model: 'voyage/voyage-4', dimensions: 512 });
    expect(bodies[0].dimensions).toBe(512);
    expect(bodies[0]).not.toHaveProperty('output_dimension');
  });

  it('返回长度与请求维度不符 → 抛 INVALID_MODEL,不把错长度交出去', async () => {
    // 上游对"不支持的维度"可能静默回默认长度;静默那条最危险 —— 调方按请求值
    // 建索引,拿到的却是另一个长度。
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          object: 'list',
          model: 'text-embedding-3-small',
          data: [{ object: 'embedding', index: 0, embedding: [1, 2, 3] }],
          usage: { prompt_tokens: 1 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const client = new EmbeddingClient({
      baseUrl: 'https://gateway.invalid',
      getApiKey: () => 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      client.embed({ texts: ['a'], model: 'text-embedding-3-small', dimensions: 512 }),
    ).rejects.toMatchObject({ code: 'INVALID_MODEL' });
  });
});

describe('EmbeddingClient · 缓存 key 隔离', () => {
  it('同文本不同 inputType 各自打网络(不能互相串味)', async () => {
    const { client, fetchImpl } = harness();
    await client.embed({ texts: ['同一段话'], model: 'voyage/voyage-4', inputType: 'document' });
    await client.embed({ texts: ['同一段话'], model: 'voyage/voyage-4', inputType: 'query' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('同文本不同 dimensions 各自打网络', async () => {
    const { client, fetchImpl } = harness();
    await client.embed({ texts: ['x'], model: 'voyage/voyage-4', dimensions: 512 });
    await client.embed({ texts: ['x'], model: 'voyage/voyage-4', dimensions: 256 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('同文本同参数第二次走缓存,不打网络', async () => {
    const { client, fetchImpl } = harness();
    const first = await client.embed({
      texts: ['x'],
      model: 'voyage/voyage-4',
      inputType: 'query',
    });
    const second = await client.embed({
      texts: ['x'],
      model: 'voyage/voyage-4',
      inputType: 'query',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(second.cacheHits).toBe(1);
    expect(second.embeddings).toEqual(first.embeddings);
  });

  it('两者都不传时的 key 与旧行为一致(仍然命中同一条缓存)', async () => {
    const { client, fetchImpl } = harness();
    await client.embed({ texts: ['x'], model: 'voyage/voyage-4' });
    await client.embed({ texts: ['x'], model: 'voyage/voyage-4' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('EmbeddingClient · 既有契约不回归', () => {
  it('未知模型本地早拒(不出网)', async () => {
    const { client, fetchImpl } = harness();
    await expect(
      client.embed({ texts: ['x'], model: 'not-a-model' as never }),
    ).rejects.toBeInstanceOf(EmbeddingError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('空 texts 直接返空,不出网', async () => {
    const { client, fetchImpl } = harness();
    const r = await client.embed({ texts: [], model: 'voyage/voyage-4' });
    expect(r.embeddings).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

/**
 * 响应形态解析 —— fixture 逐字取自 2026-08-04 live gateway (LiteLLM) 实抓:
 *   - 普通型号回一层 flat;
 *   - voyage-context-* 回两层嵌套,**且查询侧(一维 input)也是两层**。
 * 后者是这组用例的重点:形态由型号决定,不由请求维度决定,所以扁平路径也必须
 * 能吃嵌套响应 —— 只按 data[].embedding 解析会对 context 型号直接失败。
 */
function respond(body: unknown) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
}

function clientWith(fetchImpl: ReturnType<typeof vi.fn>) {
  return new EmbeddingClient({
    baseUrl: 'https://gateway.invalid',
    getApiKey: () => 'k',
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
}

describe('EmbeddingClient · 响应形态', () => {
  it('一层 flat(普通型号):按 index 定位,顺序错乱也能对上', async () => {
    const fetchImpl = respond({
      data: [
        { object: 'embedding', index: 1, embedding: [0.4, 0.5, 0.6] },
        { object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] },
      ],
      model: 'voyage/voyage-4-large',
      usage: { prompt_tokens: 10 },
    });
    const r = await clientWith(fetchImpl).embed({
      texts: ['文本A', '文本B'],
      model: 'voyage/voyage-4-large',
    });
    expect(r.embeddings).toEqual([
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ]);
  });

  it('两层嵌套 + 一维请求(context 查询侧):摊平回一维,不报错', async () => {
    const fetchImpl = respond({
      model: 'voyage/voyage-context-4',
      data: [{ data: [{ embedding: [0.1, 0.2] }] }],
      usage: { prompt_tokens: 5 },
    });
    const r = await clientWith(fetchImpl).embed({
      texts: ['法国的首都是哪里？'],
      model: 'voyage/voyage-context-4',
      inputType: 'query',
    });
    expect(r.embeddings).toEqual([[0.1, 0.2]]);
  });

  it('两层嵌套 + 二维请求(context 索引侧):按文档分组返回', async () => {
    const fetchImpl = respond({
      model: 'voyage/voyage-context-4',
      data: [
        {
          object: 'list',
          index: 0,
          data: [
            { object: 'embedding', index: 0, embedding: [0.1, 0.2] },
            { object: 'embedding', index: 1, embedding: [0.3, 0.4] },
          ],
        },
      ],
      usage: { prompt_tokens: 20, total_tokens: 20 },
    });
    const r = await clientWith(fetchImpl).embedDocuments({
      documents: [['chunk1', 'chunk2']],
      model: 'voyage/voyage-context-4',
      inputType: 'document',
    });
    expect(r.embeddings).toEqual([[[0.1, 0.2], [0.3, 0.4]]]);
    expect(r.tokensUsed).toBe(20);
  });

  it('二维请求发出的 wire body:input 保持二维,input_type 按 voyage 翻译', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_u: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          model: 'voyage/voyage-context-4',
          data: [{ data: [{ embedding: [1, 2] }, { embedding: [3, 4] }] }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    await clientWith(fetchImpl as unknown as ReturnType<typeof vi.fn>).embedDocuments({
      documents: [['a', 'b']],
      model: 'voyage/voyage-context-4',
      inputType: 'document',
      dimensions: 2,
    });
    expect(bodies[0].input).toEqual([['a', 'b']]);
    expect(bodies[0].input_type).toBe('document');
    expect(bodies[0].dimensions).toBe(2);
  });

  it('分组条数与请求不符 → 抛错而不是给半个结果', async () => {
    const fetchImpl = respond({
      model: 'voyage/voyage-context-4',
      data: [{ data: [{ embedding: [0.1, 0.2] }] }], // 请求 2 个 chunk 只回 1 个
    });
    await expect(
      clientWith(fetchImpl).embedDocuments({
        documents: [['a', 'b']],
        model: 'voyage/voyage-context-4',
      }),
    ).rejects.toMatchObject({ code: 'SERVER_ERROR' });
  });

  it('data 形状不认识 → 明确报错,不静默返空', async () => {
    const fetchImpl = respond({ model: 'voyage/voyage-4', data: [{ nope: true }] });
    await expect(
      clientWith(fetchImpl).embed({ texts: ['x'], model: 'voyage/voyage-4' }),
    ).rejects.toMatchObject({ code: 'SERVER_ERROR' });
  });

  it('上下文化不走缓存:同 chunk 第二次仍出网(向量取决于所在文档)', async () => {
    const fetchImpl = respond({
      model: 'voyage/voyage-context-4',
      data: [{ data: [{ embedding: [0.1, 0.2] }] }],
    });
    const client = clientWith(fetchImpl);
    const req = {
      documents: [['同一段文字']],
      model: 'voyage/voyage-context-4' as const,
    };
    await client.embedDocuments(req);
    await client.embedDocuments(req);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('空 documents 直接返空,不出网', async () => {
    const fetchImpl = respond({});
    const r = await clientWith(fetchImpl).embedDocuments({
      documents: [],
      model: 'voyage/voyage-context-4',
    });
    expect(r.embeddings).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

/**
 * 时间预算与缓存写入时机 —— 两条都来自 PR #1707 review,都是"错了不报错"的类型:
 *   - 没有预算:网关连上却不返数据时 await 永不落地,调方的并发额度被永久占住;
 *   - 先写缓存后校验维度:第一次调用正确抛错,第二次同参请求全命中缓存直接返回,
 *     把第一次已判定非法的向量当成功交付出去。
 */
describe('EmbeddingClient · 时间预算', () => {
  it('timeoutMs 到点 abort 在途请求,抛 TIMEOUT 而不是挂死', async () => {
    // 尊重 signal 的假 fetch(真 fetch / undici 的契约)。不给 signal 就永不 settle,
    // 正是 review 指出的挂起场景。
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    );
    await expect(
      clientWith(fetchImpl as unknown as ReturnType<typeof vi.fn>).embed({
        texts: ['x'],
        model: 'voyage/voyage-4',
        timeoutMs: 30,
      }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('不传 timeoutMs 时不带 signal(不给未声明预算的调方强加超时)', async () => {
    const inits: Array<RequestInit | undefined> = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      inits.push(init);
      return new Response(
        JSON.stringify({ model: 'voyage/voyage-4', data: [{ index: 0, embedding: [1, 2] }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    await clientWith(fetchImpl as unknown as ReturnType<typeof vi.fn>).embed({
      texts: ['x'],
      model: 'voyage/voyage-4',
    });
    expect(inits[0]?.signal).toBeUndefined();
  });

  it('预算是整条链的:重试不会把最坏等待放大成 n 倍预算', async () => {
    // 每次都 500(可重试)。预算 60ms 远小于退避总和,应在退避前就抛 TIMEOUT,
    // 而不是把 RETRY_DELAYS_MS 全睡一遍。
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }));
    const started = Date.now();
    await expect(
      clientWith(fetchImpl as unknown as ReturnType<typeof vi.fn>).embed({
        texts: ['x'],
        model: 'voyage/voyage-4',
        timeoutMs: 60,
      }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    // 上限给得宽松(CI 机器抖动),关键是它没有跑完全部退避(那要数秒)。
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('上下文化路径同样受预算约束', async () => {
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    );
    await expect(
      clientWith(fetchImpl as unknown as ReturnType<typeof vi.fn>).embedDocuments({
        documents: [['a', 'b']],
        model: 'voyage/voyage-context-4',
        timeoutMs: 30,
      }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});

describe('EmbeddingClient · 非法响应不入缓存', () => {
  it('维度不符抛错后缓存为空:第二次同参请求仍出网并仍然抛错', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            model: 'text-embedding-3-small',
            data: [{ object: 'embedding', index: 0, embedding: [1, 2, 3] }],
            usage: { prompt_tokens: 1 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    const client = clientWith(fetchImpl as unknown as ReturnType<typeof vi.fn>);
    const req = { texts: ['a'], model: 'text-embedding-3-small' as const, dimensions: 512 };
    await expect(client.embed(req)).rejects.toMatchObject({ code: 'INVALID_MODEL' });
    // 先写后判的实现会在这里全缓存命中、静默返回那条长度 3 的向量。
    await expect(client.embed(req)).rejects.toMatchObject({ code: 'INVALID_MODEL' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('维度相符时照常入缓存(自检不该顺手废掉缓存)', async () => {
    const { client, fetchImpl } = harness();
    const req = { texts: ['a'], model: 'voyage/voyage-4' as const, dimensions: 8 };
    await client.embed(req);
    const second = await client.embed(req);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(second.cacheHits).toBe(1);
  });
});

describe('EmbeddingClient · 维度自检覆盖批内每一条', () => {
  it('首条对、后续某条错 → 抛 INVALID_MODEL 并指出位置,不入缓存', async () => {
    // 只看首条的实现会放它过去:整批被缓存并交付,上层按首条填 dim,调方拿到一批
    // "声称同维度"其实不等长的向量。
    const fetchImpl = respond({
      model: 'text-embedding-3-small',
      data: [
        { object: 'embedding', index: 0, embedding: [1, 2] },
        { object: 'embedding', index: 1, embedding: [1, 2, 3] },
      ],
      usage: { prompt_tokens: 2 },
    });
    const client = clientWith(fetchImpl);
    const req = { texts: ['a', 'b'], model: 'text-embedding-3-small' as const, dimensions: 2 };
    await expect(client.embed(req)).rejects.toMatchObject({ code: 'INVALID_MODEL' });
    await expect(client.embed(req)).rejects.toThrow(/index 1/);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // 第二次仍出网 = 首次一条都没入缓存
  });

  it('上下文化:非首篇非首块的错长度同样被抓出,报文带分组下标', async () => {
    const fetchImpl = respond({
      model: 'voyage/voyage-context-4',
      data: [
        { data: [{ embedding: [1, 2] }, { embedding: [3, 4] }] },
        { data: [{ embedding: [5, 6] }, { embedding: [7, 8, 9] }] },
      ],
    });
    await expect(
      clientWith(fetchImpl).embedDocuments({
        documents: [['a', 'b'], ['c', 'd']],
        model: 'voyage/voyage-context-4',
        dimensions: 2,
      }),
    ).rejects.toThrow(/group 1 index 1/);
  });

  it('全批都对时照常返回(自检不能把合法批判错)', async () => {
    const { client } = harness();
    const r = await client.embed({
      texts: ['a', 'b'],
      model: 'voyage/voyage-4',
      dimensions: 8,
    });
    expect(r.embeddings.every((v) => v.length === 8)).toBe(true);
  });
});
