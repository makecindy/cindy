import { afterEach, describe, expect, it, vi } from 'vitest';
import { SETTINGS_SNAPSHOT_COMPATIBILITY_FIXTURE, type SettingsSnapshotAnyReport } from '../../../shared/settingsSnapshot.js';
import { SETTINGS_SNAPSHOT_CAPABILITIES, SETTINGS_SNAPSHOT_V2_COMPATIBILITY_FIXTURE } from '../../../shared/settingsSnapshotV2.js';
import { createSettingsSnapshotPublisher, getSettingsSnapshotProtocol, postSettingsSnapshot, type SnapshotFetch, type SnapshotPublishContext } from '../snapshotPublisher.js';

const context: SnapshotPublishContext = { scopeKey: 'test-owner:1:invalid-device', baseUrl: 'https://cloud.example.invalid/api', accessToken: 'invalid-test-token' };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const v2 = () => structuredClone(SETTINGS_SNAPSHOT_V2_COMPATIBILITY_FIXTURE);
const v1 = () => structuredClone(SETTINGS_SNAPSHOT_COMPATIBILITY_FIXTURE);
const signal = () => new AbortController().signal;
const receipt = (revision: number) => ({ revision, receivedAtMs: Date.now(), expiresAtMs: Date.now() + 180_000 });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('只读能力协商', () => {
  it('200严格协商v2，固定URL、无Cookie、禁止跳转与缓存', async () => {
    const fetcher = vi.fn<SnapshotFetch>().mockResolvedValue(response(SETTINGS_SNAPSHOT_CAPABILITIES));
    expect(await getSettingsSnapshotProtocol(fetcher, context, signal())).toBe(2);
    expect(fetcher).toHaveBeenCalledWith('https://cloud.example.invalid/api/instances/self/settings-snapshot/capabilities', expect.objectContaining({
      method: 'GET', headers: { Authorization: 'Bearer invalid-test-token' }, credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
    }));
  });
  it('只对明确的旧端404或有效v1能力选择v1', async () => {
    const fetcher = vi.fn<SnapshotFetch>().mockResolvedValue(response({}, 404));
    expect(await getSettingsSnapshotProtocol(fetcher, context, signal())).toBe(1);
    fetcher.mockResolvedValue(response({ schemaVersion: 1, supportedVersions: [1], limits: { v1: { maxBytes: 8192 } } }));
    expect(await getSettingsSnapshotProtocol(fetcher, context, signal())).toBe(1);
  });
  it.each([401, 403, 429, 500, 503, 302])('HTTP %s不作为降级成功', async status => {
    const fetcher = vi.fn<SnapshotFetch>().mockResolvedValue(response(SETTINGS_SNAPSHOT_CAPABILITIES, status));
    expect(await getSettingsSnapshotProtocol(fetcher, context, signal())).toBeNull();
  });
  it.each([
    {}, { ...SETTINGS_SNAPSHOT_CAPABILITIES, supportedVersions: [2] },
    { ...SETTINGS_SNAPSHOT_CAPABILITIES, token: 'invalid-test-secret' },
    { ...SETTINGS_SNAPSHOT_CAPABILITIES, limits: { v1: { maxBytes: 131072 } } },
  ])('畸形能力不放宽预算或降级', async body => {
    const fetcher = vi.fn<SnapshotFetch>().mockResolvedValue(response(body));
    expect(await getSettingsSnapshotProtocol(fetcher, context, signal())).toBeNull();
  });
  it('含或不含Content-Length的超大能力都拒绝', async () => {
    for (const headers of [new Headers(), new Headers({ 'content-length': '5000' })]) {
      const fetcher = vi.fn<SnapshotFetch>().mockResolvedValue(new Response(' '.repeat(4200) + JSON.stringify(SETTINGS_SNAPSHOT_CAPABILITIES), { headers }));
      expect(await getSettingsSnapshotProtocol(fetcher, context, signal())).toBeNull();
    }
  });
  it('网络错误不回显原始正文或凭据', async () => {
    const fetcher = vi.fn<SnapshotFetch>().mockRejectedValue(new Error('invalid-test-secret'));
    expect(await getSettingsSnapshotProtocol(fetcher, context, signal())).toBeNull();
  });
});

describe('双版本单请求上报', () => {
  function setup() {
    vi.useFakeTimers(); vi.setSystemTime(v2().capturedAtMs);
    let current: SnapshotPublishContext | null = { ...context };
    let sample = v2();
    const reports: SettingsSnapshotAnyReport[] = [];
    const fetcher = vi.fn<SnapshotFetch>().mockImplementation(async (_url, init) => {
      if (init.method === 'GET') return response(SETTINGS_SNAPSHOT_CAPABILITIES);
      const report = JSON.parse(String(init.body)) as SettingsSnapshotAnyReport;
      reports.push(report);
      return response(receipt(report.baseRevision + 1));
    });
    const readV2 = vi.fn(() => ({ fields: structuredClone(sample.fields), collections: structuredClone(sample.collections) }));
    const readDomains = vi.fn(() => v1().domains);
    const publisher = createSettingsSnapshotPublisher({ getContext: () => current, readV2, readDomains, fetch: fetcher, random: () => 0 });
    return { publisher, fetcher, reports, readV2, readDomains,
      setContext(value: SnapshotPublishContext | null) { current = value; },
      setSample(value: typeof sample) { sample = value; },
    };
  }
  it('确认v2后才采样，能力缓存五分钟、过期后重查', async () => {
    const h = setup(); h.publisher.start(); await vi.advanceTimersByTimeAsync(0);
    expect(h.reports[0].schemaVersion).toBe(2); expect(h.readDomains).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(299_999);
    expect(h.fetcher.mock.calls.filter(([, init]) => init.method === 'GET')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.fetcher.mock.calls.filter(([, init]) => init.method === 'GET')).toHaveLength(2);
    expect(h.reports).toHaveLength(6); h.publisher.stop();
  });
  it('旧端404只发v1，不采样v2', async () => {
    const h = setup(); h.fetcher.mockResolvedValueOnce(response({}, 404));
    h.publisher.start(); await vi.advanceTimersByTimeAsync(0);
    expect(h.readV2).not.toHaveBeenCalled(); expect(h.reports[0].schemaVersion).toBe(1); h.publisher.stop();
  });
  it.each([401, 403, 500])('能力HTTP %s不采样、不POST', async status => {
    const h = setup(); h.fetcher.mockResolvedValueOnce(response({}, status));
    h.publisher.start(); await vi.advanceTimersByTimeAsync(0);
    expect(h.fetcher).toHaveBeenCalledTimes(1); expect(h.readV2).not.toHaveBeenCalled(); expect(h.readDomains).not.toHaveBeenCalled(); h.publisher.stop();
  });
  it('在途协商身份失效，迟到成功不能触发旧身份POST', async () => {
    const h = setup(); let resolve!: (response: Response) => void; let pendingSignal: AbortSignal | null | undefined;
    h.fetcher.mockImplementationOnce((_url, init) => { pendingSignal = init.signal; return new Promise(done => { resolve = done; }); });
    h.publisher.start(); await vi.advanceTimersByTimeAsync(0);
    h.setContext({ ...context, scopeKey: 'test-other-owner:2' }); h.publisher.requestPublish();
    expect(pendingSignal?.aborted).toBe(true); resolve(response(SETTINGS_SNAPSHOT_CAPABILITIES));
    await vi.advanceTimersByTimeAsync(750);
    expect(h.reports).toHaveLength(1); expect(h.reports[0].baseRevision).toBe(0);
    expect(h.fetcher.mock.calls.filter(([, init]) => init.method === 'GET')).toHaveLength(2); h.publisher.stop();
  });
  it('endpoint改变和stop/start清空协商缓存', async () => {
    const h = setup(); h.publisher.start(); await vi.advanceTimersByTimeAsync(0);
    h.setContext({ ...context, baseUrl: 'https://another.example.invalid' }); h.publisher.requestPublish();
    await vi.advanceTimersByTimeAsync(750);
    expect(h.fetcher.mock.calls.filter(([, init]) => init.method === 'GET')).toHaveLength(2);
    h.publisher.stop(); h.publisher.start(); await vi.advanceTimersByTimeAsync(0);
    expect(h.fetcher.mock.calls.filter(([, init]) => init.method === 'GET')).toHaveLength(3); h.publisher.stop();
  });
  it('能力查询和POST合用8秒超时链，超时不降级', async () => {
    const h = setup(); let firstSignal: AbortSignal | null | undefined;
    h.fetcher.mockImplementationOnce((_url, init) => { firstSignal = init.signal; return new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
    }); });
    h.publisher.start(); await vi.advanceTimersByTimeAsync(8_000);
    expect(firstSignal?.aborted).toBe(true); expect(h.fetcher).toHaveBeenCalledTimes(1); expect(h.readV2).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.reports).toHaveLength(1); expect(h.reports[0].schemaVersion).toBe(2); h.publisher.stop();
  });
  it('v2畸形或预算超限不POST，也不偷偷改发v1', async () => {
    const h = setup(); const sample = v2();
    sample.collections.modelVisibility = { status: 'complete', total: 33, omitted: 0, entries: Array.from({ length: 33 }, (_, i) => ({ ordinal: i + 1, source: 'override', enabled: true })) };
    h.setSample(sample); h.publisher.start(); await vi.advanceTimersByTimeAsync(0);
    expect(h.fetcher).toHaveBeenCalledTimes(1); expect(h.readDomains).not.toHaveBeenCalled(); expect(h.reports).toEqual([]); h.publisher.stop();
  });
  it('409重采样新正文与reportId，不回放旧报告', async () => {
    const h = setup(); h.fetcher.mockImplementationOnce(async () => response(SETTINGS_SNAPSHOT_CAPABILITIES));
    let failedId: string | undefined;
    h.fetcher.mockImplementationOnce(async (_url, init) => {
      failedId = (JSON.parse(String(init.body)) as SettingsSnapshotAnyReport).reportId;
      return response({ error: { code: 'SETTINGS_SNAPSHOT_REVISION_CONFLICT', currentRevision: 8 } }, 409);
    });
    h.publisher.start(); await vi.advanceTimersByTimeAsync(0);
    const changed = v2(); changed.fields['databaseWarning.thresholdGiB'] = { status: 'value', value: 20, source: 'override' }; h.setSample(changed);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.readV2).toHaveBeenCalledTimes(2); expect(h.reports[0].baseRevision).toBe(8); expect(h.reports[0].reportId).not.toBe(failedId);
    expect(h.reports[0]).toMatchObject({ fields: { 'databaseWarning.thresholdGiB': { value: 20 } } }); h.publisher.stop();
  });
  it('v2原始字段额外秘密在transport拒绝', async () => {
    const fetcher = vi.fn<SnapshotFetch>(); const report = { ...v2(), rawSettings: 'invalid-test-secret' };
    expect(await postSettingsSnapshot(fetcher, context, report, signal())).toEqual({ status: 'invalid' }); expect(fetcher).not.toHaveBeenCalled();
  });
});
