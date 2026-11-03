import { sharedTaskHostPeer, providerShareHostPeer } from '@cindy/device-link';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMobileAuthOwner, setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { createPluginManagementClient, type PluginManagementInvoke } from '@/plugins/pluginManagementClient';
import { createPluginManagementController } from '@/plugins/pluginManagementController';
import { isBoundedPluginResponse, parsePluginManagementDetail, parsePluginManagementReceipt,
  parsePluginManagementSnapshot, marketItemMatchesPlugin, pluginNeedsUiApproval, type ManagedPlugin,
  type ManagedMarketDetail, type PluginManagementReceipt, type PluginManagementSnapshot } from '@/plugins/pluginManagementTypes';

vi.mock('expo-crypto', () => ({ randomUUID: () => 'operation-1' }));

/* 测试价值
 * 生产入口：mobile management client/controller；观察 Host 请求、确认、未知结果与当前设备事实。
 * 依据：plugin-security-and-authoring §1.1 安装身份，remote-and-mobile-adaptation 故障半径/不重放。
 * 缺口：已有 pluginClient/page 测试没有管理事务；Desktop 测试不经过手机版 owner/队列 fence。
 * 最小失败输入：begin 丢回执、同物理键更换批准、排队后切设备/账号/离线；tier: unit（内存 Host、假时钟）。
 * 实测耗时：定向两文件 Vitest 0.989s（本文件测试 496ms）；无真实网络/插件/凭证。
 */
const manifest = { schemaVersion: 3 as const, id: 'demo', name: 'Demo', version: '2', kind: 'chip' };
const plugin: ManagedPlugin = { instanceKey: '_root__demo', namespace: null, manifest: { ...manifest, version: '1' },
  enabled: true, approval: { state: 'approved', revision: '12345678-1234-4123-8123-123456789abc' } };
const detail: ManagedMarketDetail = { pluginId: 'market/demo', ghostId: 'demo', namespace: null, name: 'Demo',
  description: null, author: null, scope: 'public', organizationId: null, defaultInstall: false,
  releaseId: 'release-2', version: '2', publishedAt: '', icon: null, installState: 'update-available',
  enabled: true, sourceType: 'server', sourceMarketName: null, manifest };
const snapshot = (ghosts: ManagedPlugin[] = [plugin]): PluginManagementSnapshot => ({ version: 1, ghosts,
  market: { items: [detail], unavailableReason: null, customSourceNames: [], unavailableCustomSourceNames: [] } });
const receipt = (phase: PluginManagementReceipt['phase'] = 'running'): PluginManagementReceipt => ({ operationId: 'operation-1', phase });
const confirmation = (): PluginManagementReceipt => ({ ...receipt('confirmation'), consent: { requestId: 'consent-1',
  initiator: 'user', origin: 'market', facts: { kind: 'install', ghostId: 'demo', name: 'Demo', version: '2', permissions: [] } } });
const capability = { protocolVersion: 1, collections: [{ id: 'plugins', actions: [{ id: 'management:snapshot', label: 'Manage' }] }] };
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
type Envelope = { actionId: string; input: Record<string, unknown>; resourceRef?: { id: string } };
function host(handler?: (request: Envelope) => unknown | Promise<unknown>) {
  const requests: Envelope[] = [];
  let facts = snapshot();
  const invoke = vi.fn(async (_id: string, channel: string, args?: unknown[], options?: { preSend?: () => void }) => {
    options?.preSend?.();
    if (channel.endsWith(':manifest')) return capability;
    const request = args?.[0] as Envelope;
    requests.push(request);
    let result;
    if (request.actionId === 'management:snapshot') result = facts;
    else if (request.actionId === 'management:market-detail') result = detail;
    else result = handler ? await handler(request) : receipt();
    return { effects: [], result };
  }) as unknown as PluginManagementInvoke;
  const client = createPluginManagementClient({ deviceId: 'host-1', invoke });
  return { invoke, requests, client, setFacts: (next: PluginManagementSnapshot) => { facts = next; } };
}
const controllers: Array<ReturnType<typeof createPluginManagementController>> = [];
function controller(client: ReturnType<typeof createPluginManagementClient>) {
  const value = createPluginManagementController(client, { createOperationId: () => 'operation-1' });
  controllers.push(value); return value;
}
beforeEach(() => { setMobileAuthOwner('owner'); });
afterEach(() => { controllers.forEach((value) => value.dispose()); controllers.length = 0; vi.useRealTimers(); });

describe('mobile management contract', () => {
  it.each([JSON.parse('{"__proto__":{}}'), { constructor: {} }, { value: Infinity }, new Date(),
    { value: 'x'.repeat(8_000_001) }, Array(50_001).fill(null)])('rejects non-JSON or oversized Host declarations', (value) => {
    expect(isBoundedPluginResponse(value)).toBe(false);
  });
  it('bounds recursion and validates receipt identity and permission facts', () => {
    let deep: unknown = null; for (let i = 0; i < 25; i++) deep = { child: deep };
    expect(isBoundedPluginResponse(deep)).toBe(false);
    expect(() => parsePluginManagementReceipt(receipt(), 'different-operation')).toThrow('INVALID_RESPONSE');
    expect(() => parsePluginManagementReceipt({ ...confirmation(), consent: { ...confirmation().consent,
      facts: { kind: 'install', ghostId: 'demo', name: 'Demo', version: '2', permissions: [{ key: 'fs' }] } } }, 'operation-1')).toThrow('INVALID_RESPONSE');
  });
  it('keeps namespace missing distinct from root, and removes Host-local icon lookup keys', () => {
    const legacy = { ...plugin }; delete legacy.namespace;
    const parsed = parsePluginManagementSnapshot({ ...snapshot([legacy]), market: { ...snapshot().market,
      items: [{ ...detail, customIconKey: 'target-only' }] } });
    expect(Object.hasOwn(parsed.ghosts[0], 'namespace')).toBe(false);
    expect(parsed.market.items[0]).not.toHaveProperty('customIconKey');
    expect(marketItemMatchesPlugin(detail, legacy)).toBe(false);
    expect(marketItemMatchesPlugin(detail, { ...plugin, namespace: 'enterprise' })).toBe(false);
    expect(() => parsePluginManagementSnapshot(snapshot([{ ...plugin, approval: { state: 'approved', revision: 'bad' } }]))).toThrow('INVALID_RESPONSE');
    expect(() => parsePluginManagementDetail({ ...detail, manifest: { ...manifest, id: 'other' } })).toThrow('INVALID_RESPONSE');
  });
  it('uses only the exact physical key for legacy namespace matches, never a same-named organization instance', () => {
    const legacyItem = { ...detail }; delete legacyItem.namespace;
    expect(marketItemMatchesPlugin(legacyItem, { ...plugin, instanceKey: 'demo' })).toBe(true);
    for (const instanceKey of ['enterprise__demo', '_root__demo', 'demo-enterprise']) {
      expect(marketItemMatchesPlugin(legacyItem, { ...plugin, instanceKey, namespace: 'enterprise' })).toBe(false);
    }
    const legacyPlugin = { ...plugin }; delete legacyPlugin.namespace;
    expect(marketItemMatchesPlugin(detail, legacyPlugin)).toBe(false);
  });
  it('detects an old Host without hiding transient or malformed discovery errors', async () => {
    const invoke = vi.fn().mockResolvedValueOnce({ collections: [{ id: 'plugins' }] })
      .mockRejectedValueOnce(Object.assign(new Error('blocked'), { code: 'CHANNEL_NOT_ALLOWED' }))
      .mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ collections: 'invalid' });
    const client = createPluginManagementClient({ invoke, deviceId: 'host-1' });
    await expect(client.capability()).resolves.toBe('unsupported');
    await expect(client.capability()).resolves.toBe('unsupported');
    await expect(client.capability()).rejects.toThrow('offline');
    await expect(client.capability()).rejects.toThrow('INVALID_RESPONSE');
  });
  it('binds upgrades to release, physical instance, and approval; custom install also retains the full manifest', async () => {
    const h = host();
    await h.client.begin({ operationId: 'operation-1', kind: 'install', detail, installed: plugin });
    expect(h.requests[0]).toMatchObject({ resourceRef: { id: plugin.instanceKey }, input: {
      expectedReleaseId: 'release-2', expectedInstalledApproval: `approved:${(plugin.approval as { revision: string }).revision}` } });
    expect(h.requests[0].input).not.toHaveProperty('expectedManifest');
    const custom = { ...detail, sourceType: 'git-market' as const, sourceMarketName: 'Custom', manifest: { ...manifest, extension: { keep: true } } };
    await h.client.begin({ operationId: 'operation-1', kind: 'install', detail: custom, installed: plugin });
    expect(h.requests[1].input.expectedManifest).toEqual(custom.manifest);
    expect(h.requests[1].input).not.toHaveProperty('allowSourceReplacement');
  });
  it('rejects source conflicts and byte-oversized custom install before sending', async () => {
    const h = host();
    expect(() => h.client.begin({ operationId: 'operation-1', kind: 'install', detail: { ...detail, installState: 'conflict' }, installed: plugin })).toThrow('PLUGIN_INSTALL_CHANGED');
    await expect(h.client.begin({ operationId: 'operation-1', kind: 'install', installed: plugin, detail: {
      ...detail, sourceType: 'local-market', manifest: { ...manifest, large: '汉'.repeat(25_000) } } })).rejects.toThrow('INPUT_TOO_LARGE');
    expect(h.requests).toHaveLength(0);
  });
  it.each(['target', 'account'] as const)('fences queued writes and late reads after changing %s', async (change) => {
    let active = true;
    const pending = deferred<unknown>();
    let preSend!: () => void;
    const invoke = vi.fn(async (_d, _c, _a, opts) => { preSend = opts!.preSend!; return pending.promise; }) as PluginManagementInvoke;
    const client = createPluginManagementClient({ invoke, deviceId: 'host-1', isCurrent: () => active });
    const request = client.begin({ operationId: 'operation-1', kind: 'uninstall', installed: plugin });
    if (change === 'target') active = false; else setMobileAuthOwner('replacement');
    expect(() => preSend()).toThrow('PLUGIN_MANAGEMENT_STALE');
    pending.resolve({ effects: [], result: receipt('succeeded') });
    await expect(request).rejects.toMatchObject({ message: 'PLUGIN_MANAGEMENT_STALE', outcomeUnknown: true });
  });
});

describe('mobile management transactions', () => {
  it('submits only the active consent request and preserves Host failure receipts', async () => {
    const h = host((r) => r.actionId === 'management:begin' ? confirmation() : { ...receipt('failed'), errorCode: 'PACKAGE_CHANGED' });
    const c = controller(h.client); await c.refresh(); await c.install(detail, plugin); await c.answer(true);
    expect(c.getState()).toMatchObject({ outcome: 'failed', errorCode: 'PACKAGE_CHANGED', busy: false });
    expect(h.requests.find((r) => r.actionId === 'management:answer')?.input).toEqual({
      operationId: 'operation-1', requestId: 'consent-1', confirmed: true,
    });
  });
  it('keeps a second target independent when the first target has an unknown write result', async () => {
    const first = host(() => { throw new Error('timeout'); });
    const second = host(() => receipt('succeeded'));
    const one = controller(first.client);
    const two = controller(createPluginManagementClient({ deviceId: 'host-2', invoke: second.invoke }));
    await Promise.all([one.refresh(), two.refresh()]);
    await one.uninstall(plugin); await two.setEnabled(plugin, false);
    expect(one.getState().outcome).toBe('unknown');
    expect(two.getState().outcome).toBe('succeeded');
  });
  it('queries the original operation after a lost begin response and never replays it, even when Host forgot the receipt', async () => {
    let missing = false;
    const h = host((request) => {
      if (request.actionId === 'management:begin') throw new Error('timeout');
      if (missing) throw Object.assign(new Error('forgotten'), { code: 'NOT_FOUND' });
      return receipt('succeeded');
    });
    const c = controller(h.client); await c.refresh(); await c.uninstall(plugin);
    expect(c.getState()).toMatchObject({ outcome: 'unknown', operationId: 'operation-1', busy: false });
    missing = true; await c.reconcile();
    expect(c.getState()).toMatchObject({ outcome: 'unknown', errorCode: 'NOT_FOUND' });
    await c.uninstall(plugin);
    missing = false; await c.reconcile();
    expect(c.getState().outcome).toBe('succeeded');
    expect(h.requests.filter((r) => r.actionId === 'management:begin')).toHaveLength(1);
  });
  it('refreshes before mutation and rejects a replaced install or changed release', async () => {
    const h = host(); const c = controller(h.client); await c.refresh();
    h.setFacts(snapshot([{ ...plugin, approval: { state: 'approved', revision: 'aaaaaaaa-1234-4123-8123-123456789abc' } }]));
    await c.uninstall(plugin);
    expect(c.getState()).toMatchObject({ outcome: 'failed', errorCode: 'PLUGIN_INSTALL_CHANGED' });
    await c.install({ ...detail, releaseId: 'old-release' }, plugin);
    expect(c.getState().errorCode).toBe('PLUGIN_RELEASE_CHANGED');
    expect(h.requests.some((r) => r.actionId === 'management:begin')).toBe(false);
  });
  it('requires the original installed generation again before accepting permission consent', async () => {
    const h = host(() => confirmation()); const c = controller(h.client); await c.refresh(); await c.install(detail, plugin);
    expect(c.getState().outcome).toBe('confirmation');
    h.setFacts(snapshot([{ ...plugin, approval: { state: 'invalid' } }]));
    await c.answer(true);
    expect(c.getState()).toMatchObject({ outcome: 'unknown', errorCode: 'PLUGIN_INSTALL_CHANGED' });
    expect(h.requests.some((r) => r.actionId === 'management:answer')).toBe(false);
  });
  it('preserves committed success when cancellation races the original begin response', async () => {
    const begin = deferred<PluginManagementReceipt>();
    const h = host((r) => r.actionId === 'management:begin' ? begin.promise : receipt('succeeded'));
    const c = controller(h.client); await c.refresh();
    const start = c.uninstall(plugin);
    await vi.waitFor(() => expect(c.getState().operationId).toBe('operation-1'));
    await c.cancel(); begin.resolve(receipt('running')); await start;
    expect(c.getState().outcome).toBe('succeeded');
  });
  it('blocks an enqueued begin after cancellation before transport sends it', async () => {
    const queued = deferred<unknown>(); let preSend!: () => void;
    const h = host();
    const invoke = (async (d, channel, args, opts) => {
      if ((args?.[0] as Envelope)?.actionId === 'management:begin') { preSend = opts!.preSend!; return queued.promise; }
      return h.invoke(d, channel, args, opts);
    }) as PluginManagementInvoke;
    const c = controller(createPluginManagementClient({ invoke, deviceId: 'host-1' })); await c.refresh();
    const start = c.uninstall(plugin);
    await vi.waitFor(() => expect(preSend).toBeTypeOf('function'));
    await c.cancel();
    expect(() => preSend()).toThrow('PLUGIN_MANAGEMENT_STALE');
    queued.reject(new Error('cancelled before send')); await start;
    expect(c.getState().outcome).toBe('running');
  });
  it.each(['begin', 'answer', 'cancel'] as const)('permanently fences queued %s across offline and online epochs', async (action) => {
    const queued = deferred<unknown>(); let preSend!: () => void;
    const h = host((r) => action === 'answer' || r.actionId === 'management:begin' && action !== 'cancel' ? confirmation() : receipt());
    const invoke = (async (d, channel, args, opts) => {
      if ((args?.[0] as Envelope)?.actionId === `management:${action}`) { preSend = opts!.preSend!; return queued.promise; }
      return h.invoke(d, channel, args, opts);
    }) as PluginManagementInvoke;
    const c = controller(createPluginManagementClient({ invoke, deviceId: 'host-1' })); await c.refresh();
    let pending: Promise<void>;
    if (action === 'begin') pending = c.install(detail, plugin);
    else { await c.install(detail, plugin); pending = action === 'answer' ? c.answer(true) : c.cancel(); }
    await vi.waitFor(() => expect(preSend).toBeTypeOf('function'));
    c.setOnline(false); c.setOnline(true);
    await vi.waitFor(() => expect(c.getState().busy).toBe(false));
    expect(c.getState().online).toBe(true);
    expect(() => preSend()).toThrow('PLUGIN_MANAGEMENT_STALE');
    const recoveredOutcome = c.getState().outcome;
    queued.resolve({ effects: [], result: receipt('succeeded') }); await pending;
    expect(c.getState().outcome).toBe(recoveredOutcome);
  });
  it('still cancels the original operation when the view becomes stale before disposal', async () => {
    let alive = true;
    const h = host();
    const c = controller(createPluginManagementClient({ invoke: h.invoke, deviceId: 'original-host', isCurrent: () => alive }));
    await c.refresh(); await c.uninstall(plugin); alive = false; c.dispose();
    await vi.waitFor(() => expect(h.requests.some((r) => r.actionId === 'management:cancel')).toBe(true));
    expect(h.requests.find((r) => r.actionId === 'management:cancel')?.input).toEqual({ operationId: 'operation-1' });
    expect(h.invoke).toHaveBeenLastCalledWith('original-host', expect.any(String), expect.any(Array), expect.any(Object));
  });
  it('blocks queued disposal cancellation after the account owner changes', async () => {
    let preSend!: () => void;
    const queued = deferred<unknown>(), h = host();
    const invoke = (async (d, channel, args, opts) => {
      if ((args?.[0] as Envelope)?.actionId === 'management:cancel') { preSend = opts!.preSend!; return queued.promise; }
      return h.invoke(d, channel, args, opts);
    }) as PluginManagementInvoke;
    const c = controller(createPluginManagementClient({ invoke, deviceId: 'original-host' }));
    await c.refresh(); await c.uninstall(plugin); c.dispose();
    expect(preSend).toBeTypeOf('function'); setMobileAuthOwner('replacement');
    expect(() => preSend()).toThrow('PLUGIN_MANAGEMENT_STALE');
    queued.reject(new Error('account switched'));
  });
  it('ignores late offline results and reconnects by operation lookup, with no write replay', async () => {
    const begin = deferred<PluginManagementReceipt>();
    const h = host((r) => r.actionId === 'management:begin' ? begin.promise : receipt('cancelled'));
    const c = controller(h.client); await c.refresh(); const start = c.uninstall(plugin);
    await vi.waitFor(() => expect(c.getState().operationId).toBe('operation-1'));
    c.setOnline(false); begin.resolve(receipt('succeeded')); await start;
    expect(c.getState()).toMatchObject({ online: false, outcome: 'unknown' });
    c.setOnline(true);
    await vi.waitFor(() => expect(c.getState().outcome).toBe('cancelled'));
    expect(h.requests.filter((r) => r.actionId === 'management:begin')).toHaveLength(1);
  });
  it('polls only running receipts, stops at confirmation, and clears account data on owner switch', async () => {
    vi.useFakeTimers();
    const h = host((r) => r.actionId === 'management:operation' ? confirmation() : receipt());
    const c = controller(h.client); await c.refresh(); await c.setEnabled(plugin, false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(c.getState().outcome).toBe('confirmation');
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.requests.filter((r) => r.actionId === 'management:operation')).toHaveLength(1);
    const oldOwner = getMobileAuthOwner(); setMobileAuthOwner('new-owner');
    expect(getMobileAuthOwner().generation).not.toBe(oldOwner.generation);
    expect(c.getState()).toMatchObject({ snapshot: null, operationId: null, receipt: null });
    await c.answer(true);
    expect(h.requests.some((r) => r.actionId === 'management:answer')).toBe(false);
  });
});

/* 新增依据：页面批准是增量能力；旧 Host 不接新写入，丢失回执不能重放。
 * 缺口/最小输入：v1 snapshot 缺 capability 或批准 answer 超时；tier: unit，真实 client/controller。 */
describe('interactive page capability approval', () => {
  it.each(['approve-ui', 'defer-ui'] as const)('requires advertised support before %s and binds the revision and consent version', async (kind) => {
    const h = host(() => receipt('succeeded'));
    const c = controller(h.client);
    await c.refresh();
    const start = () => kind === 'approve-ui' ? c.approveUi(plugin) : c.deferUi(plugin);
    await start();
    expect(c.getState()).toMatchObject({ outcome: 'failed', errorCode: 'PLUGIN_UI_APPROVAL_UNSUPPORTED' });
    expect(h.requests.some((r) => r.actionId === 'management:begin')).toBe(false);
    h.setFacts({ ...snapshot(), uiCapabilityApproval: true });
    await start();
    expect(h.requests.find((r) => r.actionId === 'management:begin')).toMatchObject({
      resourceRef: { id: plugin.instanceKey }, input: { kind, uiConsentVersion: 1,
        expectedInstalledApproval: 'approved:12345678-1234-4123-8123-123456789abc' },
    });
    expect(c.getState().outcome).toBe('succeeded');
  });
  it.each([false, true])('only marks generic install consent when the Host advertises UI approval (%s)', async (supported) => {
    const h = host(() => receipt('succeeded'));
    h.setFacts({ ...snapshot(), ...(supported ? { uiCapabilityApproval: true as const } : {}) });
    const c = controller(h.client); await c.refresh(); await c.install(detail, plugin);
    expect(h.requests.find((r) => r.actionId === 'management:begin')!.input.uiConsentVersion).toBe(supported ? 1 : undefined);
  });
  it('retains the UI purpose, trust, approval and Host suppression without assuming them on old Hosts', () => {
    const data = parsePluginManagementSnapshot({ ...snapshot([{ ...plugin, uiCapabilityApproved: true, uiPromptSuppressed: true }]), uiCapabilityApproval: true });
    expect(data.uiCapabilityApproval).toBe(true);
    expect(data.ghosts[0]).toMatchObject({ uiCapabilityApproved: true, uiPromptSuppressed: true });
    expect(parsePluginManagementSnapshot(snapshot()).uiCapabilityApproval).toBeUndefined();
    const consent = { ...confirmation().consent, purpose: 'ui-capability', trust: 'unverified' };
    expect(parsePluginManagementReceipt({ ...confirmation(), consent }, 'operation-1').consent).toMatchObject(consent);
    expect(() => parsePluginManagementSnapshot({ ...snapshot(), uiCapabilityApproval: 'true' })).toThrow('INVALID_RESPONSE');
  });
  it('queries a lost UI approval receipt without replaying the answer', async () => {
    const h = host((r) => r.actionId === 'management:begin' ? { ...confirmation(), consent: {
      ...confirmation().consent!, purpose: 'ui-capability',
    } } : r.actionId === 'management:answer' ? Promise.reject(new Error('TIMEOUT')) : receipt('succeeded'));
    h.setFacts({ ...snapshot(), uiCapabilityApproval: true });
    const c = controller(h.client); await c.refresh(); await c.approveUi(plugin); await c.answer(true);
    expect(c.getState().outcome).toBe('unknown');
    await c.answer(true); await c.reconcile();
    expect(h.requests.filter((r) => r.actionId === 'management:answer')).toHaveLength(1);
    expect(h.requests.filter((r) => r.actionId === 'management:begin')).toHaveLength(1);
    expect(c.getState().outcome).toBe('succeeded');
  });
  it.each(['revision', 'owner', 'disconnect'] as const)('does not send a stale UI confirmation after %s changes', async (change) => {
    const h = host(() => ({ ...confirmation(), consent: { ...confirmation().consent!, purpose: 'ui-capability' } }));
    h.setFacts({ ...snapshot(), uiCapabilityApproval: true });
    const c = controller(h.client); await c.refresh(); await c.approveUi(plugin);
    if (change === 'revision') h.setFacts({ ...snapshot([{ ...plugin, approval: { state: 'approved', revision: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } }]), uiCapabilityApproval: true });
    else if (change === 'owner') setMobileAuthOwner('other-owner');
    else c.setOnline(false);
    await c.answer(true);
    expect(h.requests.some((r) => r.actionId === 'management:answer')).toBe(false);
  });
});

it.each([sharedTaskHostPeer('task', 'device'), providerShareHostPeer('share', 'device')])('never sends management requests for a guest peer', async (deviceId) => {
  const invoke = vi.fn();
  const client = createPluginManagementClient({ deviceId, invoke });
  await expect(client.snapshot()).rejects.toThrow('PLUGIN_MANAGEMENT_OWNER_ONLY');
  await expect(client.answer('operation', 'request', true)).rejects.toThrow('PLUGIN_MANAGEMENT_OWNER_ONLY');
  expect(invoke).not.toHaveBeenCalled();
});

// Unit: mobile must not prompt for historical malformed page data sent by a Host.
// Existing optional-flag coverage did not validate the declaration itself.
it.each([null, 'legacy', [], { ui: { resources: [{ uri: 'ui://run', file: '../page.html' }], tools: { run: {} } } }])(
  'does not show page approval for inert historical mcpApps %j', mcpApps => {
    const parsed = parsePluginManagementSnapshot(snapshot([{ ...plugin, manifest: { ...plugin.manifest, tools: [{ name: 'run' }], mcpApps } }]));
    expect(pluginNeedsUiApproval(parsed.ghosts[0])).toBe(false);
    expect(pluginNeedsUiApproval({ ...parsed.ghosts[0], manifest: { ...parsed.ghosts[0].manifest,
      mcpApps: { ui: { resources: [{ uri: 'ui://run', file: 'page.html' }], tools: { run: {} } } } } })).toBe(true);
  },
);
