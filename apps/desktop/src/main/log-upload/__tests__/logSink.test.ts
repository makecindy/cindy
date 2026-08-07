/**
 * 免签写入客户端的锁。
 *
 * 重点两条：
 *  - **URL / 载荷形状**：project 走子域、logstore 走路径、原始时间戳作为普通字段携带
 *    （不依赖服务端的 `__time__`，否则崩溃时间线会被上报时刻覆盖）。
 *  - **部分成功算失败**：调用方靠「确实传成功且非空」才清除待补传标记，部分成功当成功会让
 *    剩下的记录永远补不上。
 */
import { describe, expect, it, vi } from 'vitest';

import { MAX_BATCH_BYTES, MAX_LOGS_PER_BATCH } from '../limits';
import { buildTrackUrl, sendLogs, splitBatches, toWireTags } from '../logSink';
import type { LogUploadMeta, LogUploadTarget, UploadRecord } from '../types';

const TARGET: LogUploadTarget = {
  project: 'cindy-client',
  logstore: 'client-log',
  endpointHost: 'cn-hangzhou.log.example.com',
};

const META: LogUploadMeta = {
  uploadCode: 'ABCD-2345',
  userId: 'user-1',
  deviceId: 'device-1',
  appVersion: '1.2.3',
  region: 'cn',
  platform: 'darwin',
  arch: 'arm64',
  osVersion: '24.6.0',
  uiLanguage: 'zh-CN',
  reason: 'manual',
};

function record(i: number, msg = `line ${i}`): UploadRecord {
  return {
    ts: `2026-08-04T10:00:${String(i % 60).padStart(2, '0')}.000+08:00`,
    level: 'info',
    src: 'main',
    scope: 'lifecycle',
    msg,
  };
}

function okResponse(status = 200): Response {
  return { status } as Response;
}

describe('buildTrackUrl', () => {
  it('project 走子域、logstore 走路径', () => {
    expect(buildTrackUrl(TARGET)).toBe(
      'https://cindy-client.cn-hangzhou.log.example.com/logstores/client-log/track',
    );
  });
});

describe('toWireTags', () => {
  it('带上后台检索需要的全部维度', () => {
    expect(toWireTags(META)).toMatchObject({
      uploadCode: 'ABCD-2345',
      userId: 'user-1',
      deviceId: 'device-1',
      appVersion: '1.2.3',
      region: 'cn',
      platform: 'darwin',
      arch: 'arm64',
      osVersion: '24.6.0',
      uiLanguage: 'zh-CN',
      reason: 'manual',
    });
  });

  it('未登录时不写 userId（显式空串会让后台的有值/无值判断变复杂）', () => {
    expect(toWireTags({ ...META, userId: '' })).not.toHaveProperty('userId');
  });

  it('崩溃路径带 crashToken 与 crashAtMs（把即时与补传两次归组）', () => {
    const tags = toWireTags({
      ...META,
      reason: 'crash-backfill',
      crashToken: 'deadbeef',
      crashAtMs: 1_775_000_000_000,
    });
    expect(tags.crashToken).toBe('deadbeef');
    expect(tags.crashAtMs).toBe('1775000000000');
  });

  it('全部值都是字符串（web tracking 只接受字符串字段）', () => {
    for (const value of Object.values(toWireTags({ ...META, crashAtMs: 1 }))) {
      expect(typeof value).toBe('string');
    }
  });
});

describe('splitBatches', () => {
  it('条数上限切批', () => {
    const records = Array.from({ length: MAX_LOGS_PER_BATCH * 2 + 3 }, (_, i) => record(i));
    const batches = splitBatches(records, META.uploadCode);
    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(MAX_LOGS_PER_BATCH);
    expect(batches[2]).toHaveLength(3);
  });

  it('字节上限切批（单条很大时批变小）', () => {
    const big = 'x'.repeat(400 * 1024);
    const records = [record(1, big), record(2, big), record(3, big), record(4, big)];
    const batches = splitBatches(records, META.uploadCode);
    expect(batches.length).toBeGreaterThan(1);
  });

  it('每条记录都带 uploadCode（不依赖 __tags__ 的服务端索引配置）', () => {
    const batches = splitBatches([record(1)], META.uploadCode);
    expect(batches[0][0].uploadCode).toBe(META.uploadCode);
  });

  it('原始时间戳作为普通字段携带，不被上报时刻覆盖', () => {
    const batches = splitBatches([record(7)], META.uploadCode);
    expect(batches[0][0].ts).toBe('2026-08-04T10:00:07.000+08:00');
  });

  it('空输入 ⇒ 空批次列表', () => {
    expect(splitBatches([], META.uploadCode)).toEqual([]);
  });

  /**
   * 2026-08-04 review P2 的回归锁：原先按 `JSON.stringify(log).length`（UTF-16 码元数）算
   * 预算，中文一个字符算 1 而实际 3 字节——**低估**，会让批在编码后超过服务端上限被整批拒收。
   */
  it('⚠️ 中文正文按 UTF-8 字节算预算：编码后的真实 body 不超过上限', () => {
    // 30 万个中文字符 ≈ 90 万 UTF-8 字节,但只有 30 万 UTF-16 码元 —— 按码元算会判成一批。
    const cjk = '中'.repeat(300 * 1024);
    const batches = splitBatches([record(1, cjk), record(2, cjk)], META.uploadCode);
    for (const batch of batches) {
      const body = JSON.stringify({
        __topic__: 'cindy-client-log',
        __source__: 'darwin-arm64',
        __tags__: toWireTags(META),
        __logs__: batch,
      });
      expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(MAX_BATCH_BYTES);
    }
  });

  it('emoji（代理对）同样按字节算', () => {
    const emoji = '🙂'.repeat(200 * 1024); // 2 码元 / 4 字节
    const batches = splitBatches([record(1, emoji)], META.uploadCode);
    expect(batches).toHaveLength(1);
    expect(
      Buffer.byteLength(JSON.stringify(batches[0]), 'utf8'),
    ).toBeGreaterThan(JSON.stringify(batches[0]).length);
  });
});

describe('sendLogs', () => {
  it('全部批次 2xx ⇒ ok', async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const records = Array.from({ length: MAX_LOGS_PER_BATCH + 1 }, (_, i) => record(i));

    const result = await sendLogs({ fetchImpl }, TARGET, META, records);

    expect(result).toEqual({ ok: true, batches: 2, records: MAX_LOGS_PER_BATCH + 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('POST 到 track 端点，带 JSON content-type 与 API 版本头', async () => {
    // 显式标注签名:否则 vi.fn 从无参实现推出 `[]` 参数元组,读 mock.calls 时无法断言。
    const fetchImpl = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(
      async () => okResponse(),
    );
    await sendLogs({ fetchImpl }, TARGET, META, [record(1)]);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(buildTrackUrl(TARGET));
    expect(init).toBeDefined();
    const request = init!;
    expect(request.method).toBe('POST');
    const headers = request.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['x-log-apiversion']).toBe('0.6.0');
    const body = JSON.parse(request.body as string);
    expect(body.__logs__).toHaveLength(1);
    expect(body.__tags__.uploadCode).toBe(META.uploadCode);
    expect(body.__source__).toBe('darwin-arm64');
  });

  /**
   * 2026-08-04 review P1 的回归锁：PutWebtracking 的两个必选头之一是 `x-log-bodyrawsize`
   * （未压缩正文的字节数），缺它部分区域直接 400。且必须按 **UTF-8 字节**（不是 body.length
   * 的 UTF-16 码元），否则中文正文会报小、和真实 body 对不上。
   */
  it('⚠️ 带 x-log-bodyrawsize，且值 = body 的 UTF-8 字节数', async () => {
    const fetchImpl = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(
      async () => okResponse(),
    );
    // 中文正文:UTF-8 字节数明显大于 UTF-16 码元数(body.length)。
    await sendLogs({ fetchImpl }, TARGET, META, [record(1, '中文日志正文占多字节')]);

    const init = fetchImpl.mock.calls[0][1]!;
    const headers = init.headers as Record<string, string>;
    const body = init.body as string;
    expect(headers['x-log-bodyrawsize']).toBe(String(Buffer.byteLength(body, 'utf8')));
    // 不压缩就不发 compresstype(发了服务端会按压缩解,反而坏)。
    expect(headers['x-log-compresstype']).toBeUndefined();
    // 证明确实按字节而非码元:两者对中文正文不相等。
    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(body.length);
    expect(headers['x-log-bodyrawsize']).not.toBe(String(body.length));
  });

  it('某一批非 2xx ⇒ 整次判失败，且停止后续批次', async () => {
    const fetchImpl = vi
      .fn<(input: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(okResponse())
      .mockResolvedValueOnce(okResponse(403))
      .mockResolvedValue(okResponse());
    const records = Array.from({ length: MAX_LOGS_PER_BATCH * 3 }, (_, i) => record(i));

    const result = await sendLogs({ fetchImpl }, TARGET, META, records);

    expect(result).toEqual({
      ok: false,
      batches: 1,
      sentRecords: MAX_LOGS_PER_BATCH,
      status: 403,
    });
    // 第三批不该被发出去。
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('网络层失败 ⇒ status 0（调用方据此保留待补传标记）', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    });

    const result = await sendLogs({ fetchImpl }, TARGET, META, [record(1)]);

    expect(result).toEqual({ ok: false, batches: 0, sentRecords: 0, status: 0 });
  });
});
