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
  it('首条对、后续某条错 → 归主机(SERVER_ERROR)并指出位置,不入缓存', async () => {
    // 只看首条的实现会放它过去:整批被缓存并交付,上层按首条填 dim,调方拿到一批
    // "声称同维度"其实不等长的向量。
    //
    // 错误码归主机而不是调方(review 第十三轮):首条**等于**请求的 2,说明这个型号
    // 明显吃得下 dimensions=2,是这一批响应畸形。报 INVALID_MODEL(→ INVALID_PARAMS)
    // 会让插件按手册去"改一个没问题的请求",可能永久降到另一个维度。
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
    await expect(client.embed(req)).rejects.toMatchObject({ code: 'SERVER_ERROR' });
    await expect(client.embed(req)).rejects.toThrow(/index 1.*requested dimensions=2/);
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

describe('EmbeddingClient · 响应位次必须是双射', () => {
  /**
   * 排序只保证顺序单调,不保证位次是双射(PR #1707 review)。上游回重复 index 时条数
   * 可能刚好对上 —— 于是所有条数校验都通过,某一项的向量被另一项静默顶掉,交付出去的
   * 是**错误位置**的向量。这类错误不报警,只让检索结果莫名其妙。
   */
  it('上下文化:外层文档 index 重复 → 拒绝,不静默用最后一组覆盖', async () => {
    // 请求两篇(各 1 chunk),响应外层 index 为 0/1/1:旧实现 Map.set 会让 doc1 被
    // 第三项顶掉,而多出来的那项永远不会被发现。
    const fetchImpl = respond({
      model: 'voyage/voyage-context-4',
      data: [
        { index: 0, data: [{ index: 0, embedding: [1, 1] }] },
        { index: 1, data: [{ index: 0, embedding: [2, 2] }] },
        { index: 1, data: [{ index: 0, embedding: [9, 9] }] },
      ],
    });
    await expect(
      clientWith(fetchImpl).embedDocuments({
        documents: [['a'], ['b']],
        model: 'voyage/voyage-context-4',
      }),
    ).rejects.toMatchObject({ code: 'SERVER_ERROR' });
  });

  it('上下文化:外层项数多于请求文档数 → 拒绝(即使覆盖了全部期望位次)', async () => {
    const fetchImpl = respond({
      model: 'voyage/voyage-context-4',
      data: [
        { index: 0, data: [{ index: 0, embedding: [1, 1] }] },
        { index: 1, data: [{ index: 0, embedding: [2, 2] }] },
      ],
    });
    await expect(
      clientWith(fetchImpl).embedDocuments({
        documents: [['only-one-doc']],
        model: 'voyage/voyage-context-4',
      }),
    ).rejects.toThrow(/document entries, expected 1/);
  });

  it('上下文化:内层 chunk index 重复 → 拒绝(条数对但位次错)', async () => {
    const fetchImpl = respond({
      model: 'voyage/voyage-context-4',
      data: [
        {
          index: 0,
          data: [
            { index: 0, embedding: [1, 1] },
            { index: 0, embedding: [2, 2] },
          ],
        },
      ],
    });
    await expect(
      clientWith(fetchImpl).embedDocuments({
        documents: [['a', 'b']],
        model: 'voyage/voyage-context-4',
      }),
    ).rejects.toThrow(/duplicate document 0 chunk index 0/);
  });

  it('上下文化:外层 index 越界 → 拒绝', async () => {
    const fetchImpl = respond({
      model: 'voyage/voyage-context-4',
      data: [{ index: 7, data: [{ index: 0, embedding: [1, 1] }] }],
    });
    await expect(
      clientWith(fetchImpl).embedDocuments({
        documents: [['a']],
        model: 'voyage/voyage-context-4',
      }),
    ).rejects.toThrow(/out of range/);
  });

  it('扁平形态:index 重复 → 拒绝(旧实现排序后条数对得上就放过了)', async () => {
    const fetchImpl = respond({
      model: 'voyage/voyage-4',
      data: [
        { object: 'embedding', index: 0, embedding: [1, 1] },
        { object: 'embedding', index: 0, embedding: [2, 2] },
      ],
      usage: { prompt_tokens: 2 },
    });
    await expect(
      clientWith(fetchImpl).embed({ texts: ['a', 'b'], model: 'voyage/voyage-4' }),
    ).rejects.toThrow(/duplicate embedding index 0/);
  });

  it('条数对上的坏形态仍报"形状不认识",不被位次校验抢先带偏', async () => {
    const fetchImpl = respond({
      model: 'voyage/voyage-4',
      data: [{ object: 'embedding', index: 0, vector: [1, 1] }],
    });
    await expect(
      clientWith(fetchImpl).embed({ texts: ['a'], model: 'voyage/voyage-4' }),
    ).rejects.toThrow(/unrecognized data shape/);
  });

  it('index 全缺省时退回数组序,照常可用(不能因为收紧把正常响应判错)', async () => {
    const fetchImpl = respond({
      model: 'voyage/voyage-context-4',
      data: [{ data: [{ embedding: [1, 1] }, { embedding: [2, 2] }] }],
    });
    const r = await clientWith(fetchImpl).embedDocuments({
      documents: [['a', 'b']],
      model: 'voyage/voyage-context-4',
    });
    expect(r.embeddings).toEqual([[[1, 1], [2, 2]]]);
  });
});

describe('EmbeddingClient · 默认维度路径也校验批内一致', () => {
  /**
   * 不传 dimensions 是文档示例和绝大多数调用走的路径,之前那里直接 return,等于整条
   * 默认路径零长度校验(PR #1707 review 第五轮)。判据是"全批与首条一致"而不是"等于
   * catalog 的 dim":catalog 的 dim 记的是上游**当前**的默认值,上游改默认时拿它硬判
   * 会把本来正常的响应全判失败;而批内不等长无论默认值是多少都一定是坏数据。
   */
  it('不传 dimensions 时,批内长度不一致仍然抛错、不入缓存', async () => {
    const fetchImpl = respond({
      model: 'voyage/voyage-4',
      data: [
        { object: 'embedding', index: 0, embedding: [1, 2, 3, 4] },
        { object: 'embedding', index: 1, embedding: [1, 2] },
      ],
      usage: { prompt_tokens: 2 },
    });
    const client = clientWith(fetchImpl);
    const req = { texts: ['a', 'b'], model: 'voyage/voyage-4' as const };
    // 没传 dimensions ⇒ 是上游响应畸形,不是调方参数错 → SERVER_ERROR(slot 译 INTERNAL)
    await expect(client.embed(req)).rejects.toMatchObject({ code: 'SERVER_ERROR' });
    await expect(client.embed(req)).rejects.toThrow(/mixed vector lengths \(4 then 2\)/);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // 首次一条都没入缓存
  });

  it('不传 dimensions 且全批等长 → 照常返回(不拿 catalog 的 dim 硬判)', async () => {
    // 故意给一个与 catalog dim(1024)不同的长度:上游改默认值不该让请求失败。
    const fetchImpl = respond({
      model: 'voyage/voyage-4',
      data: [
        { object: 'embedding', index: 0, embedding: [1, 2, 3] },
        { object: 'embedding', index: 1, embedding: [4, 5, 6] },
      ],
      usage: { prompt_tokens: 2 },
    });
    const r = await clientWith(fetchImpl).embed({
      texts: ['a', 'b'],
      model: 'voyage/voyage-4',
    });
    expect(r.embeddings.map((v) => v.length)).toEqual([3, 3]);
  });

  it('上下文化的默认维度路径同样受约束', async () => {
    const fetchImpl = respond({
      model: 'voyage/voyage-context-4',
      data: [{ data: [{ embedding: [1, 2] }, { embedding: [3, 4, 5] }] }],
    });
    await expect(
      clientWith(fetchImpl).embedDocuments({
        documents: [['a', 'b']],
        model: 'voyage/voyage-context-4',
      }),
    ).rejects.toThrow(/mixed vector lengths/);
  });
});

describe('EmbeddingClient · 缓存命中与新取回混合时的自洽', () => {
  /**
   * 上游在本进程存活期间调了默认维度时,一批里可能"命中项是旧维度、新取回是新维度",
   * 各自内部自洽 —— 只看新取回那部分的检查会放行,交付出去的是混合长度的向量
   * (PR #1707 review 第七轮)。对着 catalog 的 dim 判发现不了它:那个常量此时本身
   * 就过期了。唯一可靠信号是"同一批里长度不一致"。
   */
  it('上游改默认维度后:清缓存整批重取,交付的向量等长', async () => {
    let width = 2;
    const calls: string[][] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      calls.push(body.input);
      return new Response(
        JSON.stringify({
          model: 'voyage/voyage-4',
          data: body.input.map((_t, index) => ({
            object: 'embedding',
            index,
            embedding: Array.from({ length: width }, (_v, i) => i),
          })),
          usage: { prompt_tokens: 1 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    const client = clientWith(fetchImpl as unknown as ReturnType<typeof vi.fn>);

    // 1) 先把 'a' 以旧维度 2 存进缓存。
    const first = await client.embed({ texts: ['a'], model: 'voyage/voyage-4' });
    expect(first.embeddings[0]).toHaveLength(2);

    // 2) 上游改默认维度 → 请求 ['a','b']:'a' 命中旧的 2 维,'b' 新取回 4 维。
    width = 4;
    const mixed = await client.embed({ texts: ['a', 'b'], model: 'voyage/voyage-4' });

    // 交付的必须等长(而不是 [2 维, 4 维] 混着给出去)。
    expect(mixed.embeddings.map((v) => v.length)).toEqual([4, 4]);
    // 清缓存后整批重取:最后一次请求包含两条文本,且这次零命中。
    expect(calls[calls.length - 1]).toEqual(['a', 'b']);
    expect(mixed.cacheHits).toBe(0);
  });

  it('维度稳定时不触发重取(复查不能顺手废掉缓存)', async () => {
    const { client, fetchImpl } = harness();
    await client.embed({ texts: ['a'], model: 'voyage/voyage-4' });
    const second = await client.embed({ texts: ['a', 'b'], model: 'voyage/voyage-4' });
    expect(second.cacheHits).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // 首次 + 只取 'b',没有第三次
  });
});

describe('EmbeddingClient · 错误归属与重取的预算', () => {
  /**
   * 错误码要分清是谁错了(PR #1707 review 第八轮 + 第十三轮):slot 层把 INVALID_MODEL
   * 译成 INVALID_PARAMS、SERVER_ERROR 译成 INTERNAL。三种坏法归属不同 ——
   *   1. 显式传了维度、整批**一致地**不等于它 = 型号不吃这个维度 → INVALID_MODEL;
   *   2. 显式传了维度、批内**自相矛盾** = 型号吃得下(有条对上了),这批响应畸形 →
   *      SERVER_ERROR。第八轮只按"有没有传 dimensions"分,把这种也判成调方的错;
   *   3. 没传维度、批内不等长 = 上游响应畸形 → SERVER_ERROR。
   * 判错的代价不是多一行日志:手册说 INVALID_PARAMS "原样重试永远失败",插件会据此
   * 按一个假诊断重建索引。
   */
  it('三种坏法的错误归属:一致地不符归调方,批内矛盾与默认路径都归主机', async () => {
    // ① 整批一致地不是请求的 4 维 → 型号静默回了自己的默认 → 调方改参数才有救
    await expect(
      clientWith(
        respond({
          model: 'voyage/voyage-4',
          data: [
            { object: 'embedding', index: 0, embedding: [1, 2] },
            { object: 'embedding', index: 1, embedding: [3, 4] },
          ],
          usage: { prompt_tokens: 2 },
        }),
      ).embed({ texts: ['a', 'b'], model: 'voyage/voyage-4', dimensions: 4 }),
    ).rejects.toMatchObject({ code: 'INVALID_MODEL' });

    const ragged = () =>
      respond({
        model: 'voyage/voyage-4',
        data: [
          { object: 'embedding', index: 0, embedding: [1, 2, 3, 4] },
          { object: 'embedding', index: 1, embedding: [1, 2] },
        ],
        usage: { prompt_tokens: 2 },
      });
    // ② 显式传了 4、首条正是 4 而次条是 2 → 型号吃得下,这批畸形 → 归主机
    await expect(
      clientWith(ragged()).embed({
        texts: ['a', 'b'],
        model: 'voyage/voyage-4',
        dimensions: 4,
      }),
    ).rejects.toMatchObject({ code: 'SERVER_ERROR' });
    // ③ 没传维度、批内不等长 → 归主机
    await expect(
      clientWith(ragged()).embed({ texts: ['a', 'b'], model: 'voyage/voyage-4' }),
    ).rejects.toMatchObject({ code: 'SERVER_ERROR' });
  });

  it('清缓存重取吃同一份预算的剩余量:预算已耗尽时抛 TIMEOUT 而不是再等一轮', async () => {
    // 第一次取新向量把预算耗光(sleep > timeoutMs),随后混合长度触发重取 —— 重取不能
    // 重新计时,否则插件那一次 await 最长接近 2×预算。
    let width = 2;
    let calls = 0;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      if (calls > 1) await new Promise((r) => setTimeout(r, 80));
      return new Response(
        JSON.stringify({
          model: 'voyage/voyage-4',
          data: body.input.map((_t, index) => ({
            object: 'embedding',
            index,
            embedding: Array.from({ length: width }, (_v, i) => i),
          })),
          usage: { prompt_tokens: 1 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    const client = clientWith(fetchImpl as unknown as ReturnType<typeof vi.fn>);
    await client.embed({ texts: ['a'], model: 'voyage/voyage-4' }); // 以 2 维入缓存
    width = 4;
    await expect(
      client.embed({ texts: ['a', 'b'], model: 'voyage/voyage-4', timeoutMs: 60 }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    // 只发了首次入缓存 + 这次的 miss 取回;重取没有发出(预算已耗尽)。
    expect(calls).toBe(2);
  });
});

describe('EmbeddingClient · 全命中批次同样复查自洽', () => {
  /**
   * 到达路径不需要巧合(PR #1707 review 第九轮):A 在旧默认维度下入缓存 → 上游改默认 →
   * 某次只含 B 的请求把 B 以新维度入缓存(那次零命中、新批内部自洽,混合复查进不来)→
   * 此后任何同时要 A 和 B 的请求都是**全命中**,直接从早退分支返回混合长度的向量。
   */
  it('缓存里混着两种维度时,全命中请求也清缓存重取,交付等长', async () => {
    let width = 2;
    const calls: string[][] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      calls.push(body.input);
      return new Response(
        JSON.stringify({
          model: 'voyage/voyage-4',
          data: body.input.map((_t, index) => ({
            object: 'embedding',
            index,
            embedding: Array.from({ length: width }, (_v, i) => i),
          })),
          usage: { prompt_tokens: 1 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    const client = clientWith(fetchImpl as unknown as ReturnType<typeof vi.fn>);

    await client.embed({ texts: ['a'], model: 'voyage/voyage-4' }); // A → 2 维
    width = 4;
    await client.embed({ texts: ['b'], model: 'voyage/voyage-4' }); // B → 4 维(零命中)
    // 此刻缓存里 A=2 维、B=4 维,下面这次两条都命中。
    const both = await client.embed({ texts: ['a', 'b'], model: 'voyage/voyage-4' });

    expect(both.embeddings.map((v) => v.length)).toEqual([4, 4]);
    expect(calls[calls.length - 1]).toEqual(['a', 'b']);
    expect(both.cacheHits).toBe(0);
  });

  it('全命中且维度一致时不打网络(复查不能把正常的全命中变成一次请求)', async () => {
    const { client, fetchImpl } = harness();
    await client.embed({ texts: ['a', 'b'], model: 'voyage/voyage-4' });
    const again = await client.embed({ texts: ['a', 'b'], model: 'voyage/voyage-4' });
    expect(again.cacheHits).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('EmbeddingClient · 空向量一律拒绝', () => {
  /**
   * 缺省维度那条路径上,"全批与首条一致"对一批空数组是成立的(expected 取到 0),
   * 整批会通过校验、进缓存,slot 随后回一个 dim: 0 —— 插件把空向量写进索引,之后的
   * 缓存命中继续"成功"(PR #1707 review 第十轮)。默认维度允许变,但合法 embedding
   * 的长度必须为正,这条与维度无关。
   */
  it('不传 dimensions 且上游 200 回空数组 → SERVER_ERROR,且一条都不入缓存', async () => {
    const fetchImpl = respond({
      model: 'voyage/voyage-4',
      data: [
        { object: 'embedding', index: 0, embedding: [] },
        { object: 'embedding', index: 1, embedding: [] },
      ],
      usage: { prompt_tokens: 2 },
    });
    const client = clientWith(fetchImpl);
    const req = { texts: ['a', 'b'], model: 'voyage/voyage-4' as const };

    await expect(client.embed(req)).rejects.toMatchObject({ code: 'SERVER_ERROR' });
    await expect(client.embed(req)).rejects.toThrow(/empty embedding at index 0/);
    // 没入缓存 ⇒ 第二次仍然真的打了网络(否则会走全命中分支静默返回空向量)
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('只有其中一条为空也要拒绝(首条正常时不能被首条基准放过)', async () => {
    const fetchImpl = respond({
      model: 'voyage/voyage-4',
      data: [
        { object: 'embedding', index: 0, embedding: [1, 2] },
        { object: 'embedding', index: 1, embedding: [] },
      ],
    });
    await expect(
      clientWith(fetchImpl).embed({ texts: ['a', 'b'], model: 'voyage/voyage-4' }),
    ).rejects.toThrow(/empty embedding at index 1/);
  });

  it('上下文化路径同样拒绝空向量', async () => {
    const fetchImpl = respond({
      model: 'voyage/voyage-context-4',
      data: [{ data: [{ embedding: [1, 2] }, { embedding: [] }] }],
    });
    await expect(
      clientWith(fetchImpl).embedDocuments({
        documents: [['a', 'b']],
        model: 'voyage/voyage-context-4',
      }),
    ).rejects.toThrow(/empty embedding at group 0 index 1/);
  });
});

describe('EmbeddingClient · 缓存项记住上游实际型号', () => {
  /** 造一个"上游实际型号可切换"的网关:每次按当前 model 名回定宽向量。 */
  function switchableGateway(state: { model: string; width: number }) {
    const inputs: string[][] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      inputs.push(body.input);
      return new Response(
        JSON.stringify({
          object: 'list',
          model: state.model,
          data: body.input.map((_t, index) => ({
            object: 'embedding',
            index,
            embedding: Array.from({ length: state.width }, (_v, i) => i),
          })),
          usage: { prompt_tokens: 1 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    return { fetchImpl, inputs };
  }

  /**
   * 只存向量的话:首次未命中回网关型号(带版本号),第二次全命中回请求别名 ——
   * 同一段文本的 model 元数据凭空变了一次,插件会据此误判索引需要重建。
   */
  it('全命中时回缓存里记的实际型号,不回请求别名', async () => {
    const state = { model: 'voyage/voyage-4-20250101', width: 2 };
    const { fetchImpl } = switchableGateway(state);
    const client = clientWith(fetchImpl as unknown as ReturnType<typeof vi.fn>);

    const first = await client.embed({ texts: ['a'], model: 'voyage/voyage-4' });
    const second = await client.embed({ texts: ['a'], model: 'voyage/voyage-4' });

    expect(first.modelUsed).toBe('voyage/voyage-4-20250101');
    expect(second.cacheHits).toBe(1);
    expect(second.modelUsed).toBe(first.modelUsed);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  /**
   * 别名换后端**而维度恰好相同**时最危险:长度检查一律放行,旧缓存向量与新取回向量
   * 会被混在一批里、统一标成新型号。两个模型的向量不可比,而形状完全正常。
   */
  it('别名换了后端(维度相同)→ 清缓存整批重取,交付的一批同源', async () => {
    const state = { model: 'voyage/voyage-4-20250101', width: 2 };
    const { fetchImpl, inputs } = switchableGateway(state);
    const client = clientWith(fetchImpl as unknown as ReturnType<typeof vi.fn>);

    await client.embed({ texts: ['a'], model: 'voyage/voyage-4' }); // a → 旧后端
    state.model = 'voyage/voyage-4-20260801'; // 服务端换后端,维度不变
    const mixed = await client.embed({ texts: ['a', 'b'], model: 'voyage/voyage-4' });

    // a 命中旧型号、b 取回新型号 ⇒ 判为不同源,清缓存后整批重取
    expect(mixed.modelUsed).toBe('voyage/voyage-4-20260801');
    expect(mixed.cacheHits).toBe(0);
    expect(inputs[inputs.length - 1]).toEqual(['a', 'b']);
    expect(mixed.embeddings.map((v) => v.length)).toEqual([2, 2]);
  });

  it('全命中但缓存跨两个型号 → 同样重取(不打网络就交付混合结果是不行的)', async () => {
    const state = { model: 'voyage/voyage-4-20250101', width: 2 };
    const { fetchImpl, inputs } = switchableGateway(state);
    const client = clientWith(fetchImpl as unknown as ReturnType<typeof vi.fn>);

    await client.embed({ texts: ['a'], model: 'voyage/voyage-4' });
    state.model = 'voyage/voyage-4-20260801';
    await client.embed({ texts: ['b'], model: 'voyage/voyage-4' }); // 零命中,自己内部自洽
    // 此刻缓存里 a=旧型号、b=新型号,下面这次两条都命中
    const both = await client.embed({ texts: ['a', 'b'], model: 'voyage/voyage-4' });

    expect(both.cacheHits).toBe(0);
    expect(inputs[inputs.length - 1]).toEqual(['a', 'b']);
    expect(both.modelUsed).toBe('voyage/voyage-4-20260801');
  });

  it('上游不回 model 字段时退回请求别名,且不会因此反复重取', async () => {
    const fetchImpl = respond({
      data: [{ object: 'embedding', index: 0, embedding: [1, 2] }],
      usage: { prompt_tokens: 1 },
    });
    const client = clientWith(fetchImpl);

    const first = await client.embed({ texts: ['a'], model: 'voyage/voyage-4' });
    const second = await client.embed({ texts: ['a'], model: 'voyage/voyage-4' });

    expect(first.modelUsed).toBe('voyage/voyage-4');
    expect(second.modelUsed).toBe('voyage/voyage-4');
    expect(second.cacheHits).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('EmbeddingClient · 坐标必须是有限数字', () => {
  /**
   * 只看数组长度是不够的(PR #1707 review 第十一轮):200 响应里的 embedding 完全可能是
   * ["0.1", null, {}],甚至是个字符串 —— 后者连 .length 都有,维度校验读到的是字符数,
   * dim 看着还很合理。整批就这么被当成合法向量交付、入缓存,插件写进索引后每次检索都是
   * 噪声,而哪一步都没报错。
   */
  it('扁平路径:元素是字符串 → SERVER_ERROR,不入缓存', async () => {
    const fetchImpl = respond({
      model: 'voyage/voyage-4',
      data: [{ object: 'embedding', index: 0, embedding: ['0.1', '0.2'] }],
    });
    const client = clientWith(fetchImpl);
    const req = { texts: ['a'], model: 'voyage/voyage-4' as const };

    await expect(client.embed(req)).rejects.toMatchObject({ code: 'SERVER_ERROR' });
    await expect(client.embed(req)).rejects.toThrow(/coordinate 0 is not a finite number/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('扁平路径:null / 对象混在中间也拒(不是只看首个元素)', async () => {
    const fetchImpl = respond({
      model: 'voyage/voyage-4',
      data: [{ object: 'embedding', index: 0, embedding: [0.1, null, 0.3] }],
    });
    await expect(
      clientWith(fetchImpl).embed({ texts: ['a'], model: 'voyage/voyage-4' }),
    ).rejects.toThrow(/coordinate 1 is not a finite number \(got object\)/);
  });

  it('NaN / Infinity 也拒(会让余弦相似度整列变成 NaN)', async () => {
    // JSON 里没有 NaN 字面量,上游一般以 null 表达;这里直接构造非法数值字符串
    const fetchImpl = vi.fn(
      async () =>
        new Response('{"model":"voyage/voyage-4","data":[{"index":0,"embedding":[1e999,2]}]}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    await expect(
      clientWith(fetchImpl).embed({ texts: ['a'], model: 'voyage/voyage-4' }),
    ).rejects.toThrow(/coordinate 0 is not a finite number \(got Infinity\)/);
  });

  it('上下文化路径:嵌套形态同样逐坐标校验', async () => {
    const fetchImpl = respond({
      model: 'voyage/voyage-context-4',
      data: [{ data: [{ embedding: [1, 2] }, { embedding: [3, '4'] }] }],
    });
    await expect(
      clientWith(fetchImpl).embedDocuments({
        documents: [['a', 'b']],
        model: 'voyage/voyage-context-4',
      }),
    ).rejects.toThrow(/document 0 chunk 1 embedding coordinate 1 is not a finite number/);
  });

  it('嵌套形态里 embedding 是字符串 → 明确报"不是数组",不被 .length 蒙过去', async () => {
    const fetchImpl = respond({
      model: 'voyage/voyage-context-4',
      data: [{ data: [{ embedding: 'abcd' }] }],
    });
    await expect(
      clientWith(fetchImpl).embedDocuments({
        documents: [['a']],
        model: 'voyage/voyage-context-4',
      }),
    ).rejects.toThrow(/document 0 chunk 0 embedding is not an array \(got string\)/);
  });
});
