import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SETTINGS_SNAPSHOT_COMPATIBILITY_FIXTURE,
  settingsSnapshotReportSchema,
  type SettingsSnapshotReport,
} from '../../../shared/settingsSnapshot.js';
import {
  createSettingsSnapshotPublisher,
  postSettingsSnapshot,
  settingsSnapshotPublishUrl,
  type SnapshotFetch,
  type SnapshotPublishContext,
} from '../snapshotPublisher.js';

const context: SnapshotPublishContext = {
  scopeKey: 'owner-example:1:device-example:global',
  baseUrl: 'https://cloud.example.invalid/api',
  accessToken: 'invalid-test-access-token',
};
const fixture = () => structuredClone(SETTINGS_SNAPSHOT_COMPATIBILITY_FIXTURE);
const receipt = (revision = 1, time = SETTINGS_SNAPSHOT_COMPATIBILITY_FIXTURE.capturedAtMs) => ({
  revision, receivedAtMs: time, expiresAtMs: time + 180_000,
});
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const signal = () => new AbortController().signal;

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('settingsSnapshot wire', () => {
  it('两端共同的非秘密 fixture 满足严格协议', () => {
    expect(settingsSnapshotReportSchema.parse(fixture())).toEqual(fixture());
  });
  it.each(['token', 'userPrompt', 'endpoint', 'path', 'ownerId'])('拒绝额外的 %s 字段', key => {
    expect(settingsSnapshotReportSchema.safeParse({ ...fixture(), [key]: 'private-value' }).success).toBe(false);
    const report = fixture();
    Object.assign(report.domains.personalization, { [key]: 'private-value' });
    expect(settingsSnapshotReportSchema.safeParse(report).success).toBe(false);
  });
  it('拒绝借模型字段传 URL 或秘密', () => {
    for (const value of ['https://private.example.invalid', '/private/profile', 'sk-invalid-example', 'Bearer-value']) {
      const report = fixture();
      if (report.domains.newTaskDefaults.status !== 'supported') throw new Error('fixture');
      report.domains.newTaskDefaults.fields.modelId = { value, source: 'override' };
      expect(settingsSnapshotReportSchema.safeParse(report).success).toBe(false);
    }
  });
});

describe('快照 transport', () => {
  it.each(['', 'http://cloud.example.invalid', 'file:///private/profile',
    'https://user:pass@cloud.example.invalid', 'https://cloud.example.invalid/?token=x',
    'https://cloud.example.invalid/#fragment', 'https://cloud.example.invalid/?',
    'https://cloud.example.invalid/#'])('不向不安全基址发送凭据: %s', baseUrl => {
    expect(settingsSnapshotPublishUrl(baseUrl)).toBeNull();
  });
  it('固定追加业务路径并保留部署前缀', () => {
    expect(settingsSnapshotPublishUrl(`${context.baseUrl}///`))
      .toBe('https://cloud.example.invalid/api/instances/self/settings-snapshot');
  });
  it('只发送 Bearer，禁止跳转、Cookie、缓存与 Referer', async () => {
    const fetcher = vi.fn<SnapshotFetch>().mockResolvedValue(response(receipt()));
    const result = await postSettingsSnapshot(fetcher, context, fixture(), signal());
    expect(result).toEqual({ status: 'published', receipt: receipt() });
    expect(fetcher).toHaveBeenCalledWith('https://cloud.example.invalid/api/instances/self/settings-snapshot',
      expect.objectContaining({ method: 'POST', redirect: 'error', credentials: 'omit',
        cache: 'no-store', referrerPolicy: 'no-referrer', headers: {
          'Content-Type': 'application/json', Authorization: 'Bearer invalid-test-access-token',
        } }));
  });
  it('DTO 外的字段在客户端即拒绝，不调用网络', async () => {
    const fetcher = vi.fn<SnapshotFetch>();
    const report = { ...fixture(), rawSettings: { token: 'invalid-test-secret' } };
    expect(await postSettingsSnapshot(fetcher, context, report, signal())).toEqual({ status: 'invalid' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('409 只接受已约定的版本冲突水位', async () => {
    const fetcher = vi.fn<SnapshotFetch>().mockResolvedValue(response({ error: {
      code: 'SETTINGS_SNAPSHOT_REVISION_CONFLICT', message: 'conflict', currentRevision: 7,
    } }, 409));
    expect(await postSettingsSnapshot(fetcher, context, fixture(), signal()))
      .toEqual({ status: 'conflict', currentRevision: 7 });
    fetcher.mockResolvedValue(response({ error: {
      code: 'SETTINGS_SNAPSHOT_INSTANCE_NOT_RUNNING', message: 'private', currentRevision: 9,
    } }, 409));
    expect(await postSettingsSnapshot(fetcher, context, fixture(), signal()))
      .toEqual({ status: 'unavailable' });
  });
  it('429 读取有界 Retry-After，不回传错误正文', async () => {
    const fetcher = vi.fn<SnapshotFetch>().mockResolvedValue(new Response('private', {
      status: 429, headers: { 'Retry-After': '20' },
    }));
    expect(await postSettingsSnapshot(fetcher, context, fixture(), signal()))
      .toEqual({ status: 'rateLimited', retryAfterMs: 20_000 });
  });
  it.each([401, 403, 404, 500, 302])('HTTP %s 不回显服务端消息', async status => {
    const fetcher = vi.fn<SnapshotFetch>().mockResolvedValue(response({ token: 'invalid-test-secret' }, status));
    expect(await postSettingsSnapshot(fetcher, context, fixture(), signal())).toEqual({ status: 'unavailable' });
  });
  it('网络异常不会泄漏 URL、凭据或原始异常', async () => {
    const fetcher = vi.fn<SnapshotFetch>().mockRejectedValue(new Error('private URL and bearer'));
    expect(await postSettingsSnapshot(fetcher, context, fixture(), signal())).toEqual({ status: 'unavailable' });
  });
  it.each([
    { ...receipt(), token: 'invalid-secret' },
    { ...receipt(), revision: 0 },
    { ...receipt(), expiresAtMs: receipt().receivedAtMs - 1 },
    { ...receipt(), expiresAtMs: receipt().receivedAtMs + 180_001 },
    { revision: Number.MAX_SAFE_INTEGER + 1, receivedAtMs: 1, expiresAtMs: 2 },
  ])('拒绝畸形接收回执', async body => {
    const fetcher = vi.fn<SnapshotFetch>().mockResolvedValue(response(body));
    expect(await postSettingsSnapshot(fetcher, context, fixture(), signal())).toEqual({ status: 'invalid' });
  });
  it('限制响应正文大小，包括没有 Content-Length 的流', async () => {
    const fetcher = vi.fn<SnapshotFetch>().mockResolvedValue(new Response('x'.repeat(5_000)));
    expect(await postSettingsSnapshot(fetcher, context, fixture(), signal())).toEqual({ status: 'invalid' });
  });
});

describe('单请求后台上报器', () => {
  function setup() {
    vi.useFakeTimers();
    vi.setSystemTime(SETTINGS_SNAPSHOT_COMPATIBILITY_FIXTURE.capturedAtMs);
    let current: SnapshotPublishContext | null = { ...context };
    let sample = fixture().domains;
    const reports: SettingsSnapshotReport[] = [];
    const fetcher = vi.fn<SnapshotFetch>().mockImplementation(async (_url, init) => {
      const report = JSON.parse(String(init.body)) as SettingsSnapshotReport;
      reports.push(report);
      return response(receipt(report.baseRevision + 1, Date.now()));
    });
    const readDomains = vi.fn(() => structuredClone(sample));
    const publisher = createSettingsSnapshotPublisher({ getContext: () => current,
      readDomains, fetch: fetcher, random: () => 0 });
    return { publisher, fetcher, reports, readDomains,
      setContext(value: SnapshotPublishContext | null) { current = value; },
      setSample(value: typeof sample) { sample = value; } };
  }

  it('未配置端点或身份时不采样、不发请求', async () => {
    const h = setup();
    h.setContext(null);
    h.publisher.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.fetcher).not.toHaveBeenCalled();
    expect(h.readDomains).not.toHaveBeenCalled();
    h.publisher.stop();
  });
  it('周期重采样，变更合并且遵守最短写间隔', async () => {
    const h = setup();
    h.publisher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.reports).toHaveLength(1);
    const changed = fixture().domains;
    if (changed.databaseWarning.status !== 'supported') throw new Error('fixture');
    changed.databaseWarning.fields.thresholdGiB.value = 20;
    h.setSample(changed);
    h.publisher.requestPublish();
    h.publisher.requestPublish();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(h.reports).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.reports).toHaveLength(2);
    expect(h.reports[1].baseRevision).toBe(1);
    expect(h.reports[1].domains.databaseWarning).toMatchObject({ fields: { thresholdGiB: { value: 20 } } });
    expect(h.reports[1].reportId).not.toBe(h.reports[0].reportId);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.reports).toHaveLength(3);
    h.publisher.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.reports).toHaveLength(3);
  });
  it('409 更新水位但不重放原正文，下一次重新采样', async () => {
    const h = setup();
    h.fetcher.mockResolvedValueOnce(response({ error: { code: 'SETTINGS_SNAPSHOT_REVISION_CONFLICT',
      currentRevision: 12, message: 'conflict' } }, 409));
    h.publisher.start();
    await vi.advanceTimersByTimeAsync(0);
    const changed = fixture().domains;
    changed.personalization = { status: 'unavailable', scope: 'owner', boundary: 'nextAgentStart' };
    h.setSample(changed);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.readDomains).toHaveBeenCalledTimes(2);
    expect(h.reports[0].baseRevision).toBe(12);
    expect(h.reports[0].domains.personalization.status).toBe('unavailable');
    h.publisher.stop();
  });
  it('身份改变取消旧请求，迟到回执不污染新 owner 的水位', async () => {
    const h = setup();
    let complete!: (value: Response) => void;
    let oldSignal: AbortSignal | undefined;
    h.fetcher.mockImplementationOnce((_url, init) => {
      oldSignal = init.signal ?? undefined;
      return new Promise<Response>(resolve => { complete = resolve; });
    });
    h.publisher.start();
    await vi.advanceTimersByTimeAsync(0);
    h.setContext({ ...context, scopeKey: 'another-owner:2:device-example:global' });
    h.publisher.requestPublish();
    expect(oldSignal?.aborted).toBe(true);
    complete(response(receipt(88)));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.reports[0].baseRevision).toBe(0);
    h.publisher.stop();
  });
  it('慢请求期间只保留一个变更意图，不并发发送', async () => {
    const h = setup();
    let complete!: (value: Response) => void;
    h.fetcher.mockImplementationOnce(() => new Promise<Response>(resolve => { complete = resolve; }));
    h.publisher.start();
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 20; i += 1) h.publisher.requestPublish();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    complete(response(receipt()));
    await vi.advanceTimersByTimeAsync(8_000);
    expect(h.fetcher).toHaveBeenCalledTimes(2);
    h.publisher.stop();
  });
  it('429 退避不被设置变更通知绕过', async () => {
    const h = setup();
    h.fetcher.mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '30' } }));
    h.publisher.start();
    await vi.advanceTimersByTimeAsync(0);
    h.publisher.requestPublish();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.fetcher).toHaveBeenCalledTimes(2);
    h.publisher.stop();
  });
  it('请求有超时且不重复复用超时的正文', async () => {
    const h = setup();
    h.fetcher.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    h.publisher.start();
    await vi.advanceTimersByTimeAsync(8_000);
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.fetcher).toHaveBeenCalledTimes(2);
    expect(h.readDomains).toHaveBeenCalledTimes(2);
    h.publisher.stop();
  });
});
