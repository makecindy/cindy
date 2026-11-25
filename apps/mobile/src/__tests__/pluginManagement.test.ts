// @vitest-environment jsdom
import { isPinnedHighRiskPermission, PINNED_HIGH_RISK_MIN_HEIGHT, pinnedHighRiskMaxHeight, pluginConsentPresentation } from '@/plugins/pluginConsentPresentation';
import { DeviceLinkError, sharedTaskHostPeer, providerShareHostPeer } from '@cindy/device-link';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { getMobileAuthOwner, setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { createPluginManagementClient, type PluginManagementInvoke } from '@/plugins/pluginManagementClient';
import { createPluginPromptReads } from '@/plugins/pluginPromptReads';
import { pluginUiApprovalNotice } from '@/plugins/pluginUiApprovalNotice';
import { PluginPromptReadsProvider, usePluginPromptReads } from '@/plugins/PluginPromptReadsContext';
import { createPluginManagementController } from '@/plugins/pluginManagementController';
import { isBoundedPluginResponse, parsePluginManagementDetail, parsePluginManagementReceipt,
  parsePluginManagementSnapshot, marketItemMatchesPlugin, pluginNeedsUiApproval, type ManagedPlugin,
  parsePluginUiConsent, samePluginMarketSourceIdentity, type ManagedMarketDetail, type PluginManagementReceipt, type PluginManagementSnapshot } from '@/plugins/pluginManagementTypes';
import { parsePluginMarketPage, pluginMarketIconUri } from '@/plugins/pluginMarketCatalog';

vi.mock('expo-crypto', () => ({ randomUUID: () => 'operation-1' }));
const appState = vi.hoisted(() => ({ currentState: 'active', listeners: new Set<(state: string) => void>() }));
const promptLink = vi.hoisted(() => ({ invoke: vi.fn(), connectionEpoch: 0, presenceVersion: 0,
  status: 'online', onRemoteResourceChanged: vi.fn(() => () => undefined), getSubscriptionIdentity: vi.fn(() => 0) }));
vi.mock('react-native', () => ({ AppState: {
  get currentState() { return appState.currentState; },
  addEventListener: (_event: string, listener: (state: string) => void) => {
    appState.listeners.add(listener); return { remove: () => appState.listeners.delete(listener) };
  },
} }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ accountGeneration: 1 }) }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => promptLink }));
vi.mock('@/device-link/revokedDevicesStore', () => ({ useRevokedDevices: () => null }));

/* 测试价值
 * 生产入口：mobile management client/controller；观察 Host 请求、确认、未知结果与当前设备事实。
 * 依据：plugin-security-and-authoring §1.1 安装身份，remote-and-mobile-adaptation 故障半径/不重放。
 * 缺口：已有 pluginClient/page 测试没有管理事务；Desktop 测试不经过手机版 owner/队列 fence。
 * 最小失败输入：begin 丢回执、同物理键更换批准、排队后切设备/账号/离线；tier: unit（内存 Host、假时钟）。
 * 实测耗时：定向两文件 Vitest 0.989s（本文件测试 496ms）；无真实网络/插件/凭证。
 *
 * 手机插件市场（2026-11-25 增补）
 * - 生产入口与可观察结果：client.catalog/catalogPaging、parsePluginMarketPage、controller.install（无已装实例）；
 *   观察发往 Host 的请求形状、解析后的页面与安装回执阶段。
 * - 依据：same-account-remote-plugin-management.md「新控制端先探测能力…普通读取失败不得回退全量」；
 *   plugin-security-and-authoring §5.4 分页只做 discovery；brief 要求有界解析、缺字段降级。
 * - 缺口：此前手机只有升级（带 installed）的安装用例，没有全新安装与分页读取。
 * - 最小失败输入：旧 Host 页面缺 nextCursor/counts/publisherKind；101 条或计数不自洽的页面；
 *   INVALID_PARAMS 与普通网络错误的区分；不带 installed 的 begin。tier: unit（内存 Host）。
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
function host(handler?: (request: Envelope) => unknown | Promise<unknown>, marketDetail: ManagedMarketDetail = detail) {
  const requests: Envelope[] = [];
  let facts = snapshot();
  const invoke = vi.fn(async (_id: string, channel: string, args?: unknown[], options?: { preSend?: () => void; onRequestWritten?: () => void }) => {
    options?.preSend?.();
    // Like the transport: the request is written once its last check passed; a handler that throws lost the reply.
    options?.onRequestWritten?.();
    if (channel.endsWith(':manifest')) return capability;
    const request = args?.[0] as Envelope;
    requests.push(request);
    let result;
    if (request.actionId === 'management:snapshot') result = facts;
    else if (request.actionId === 'management:market-detail') result = marketDetail;
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

// Maintainer reviews 08:48 and 09:30: `preSend` is only a check (the mobile invoke calls it at entry, after a direct-path
// attempt, once connected, and right before the first socket write), never evidence that a request was written, and a
// link handshake's writes are not this request's. Written is what the transport reports for the request itself: a reply,
// or `onRequestWritten` (its first socket write) before the failure. A mutation that was never written is a plain failure.
describe('what counts as written', () => {
  const uninstall = (client: ReturnType<typeof createPluginManagementClient>) => client.begin({ operationId: 'operation-1', kind: 'uninstall', installed: plugin });
  const handshakeTimeout = () => { const error = new DeviceLinkError('INVOKE_TIMEOUT', 'no link-accept after the handshake was written'); error.inFlight = true; return error; };
  it.each([
    // [case, how the transport ends, outcome unknown]
    ['refused at the entry check', 'entry', false],
    ['refused at the last check before the write (it was never written)', 'dequeue', false],
    ['expired before the first write (BACKPRESSURE, not in flight)', 'expired', false],
    ['failed in the link handshake after the handshake was written (in flight, but not this request)', 'handshake', false],
    ['written, then the reply was lost (in flight)', 'lost', true],
    ['written, then refused at a later check (a resend after the first write)', 'resend', true],
  ] as const)('classifies a write %s', async (_name, end, unknown) => {
    let active = true;
    const invoke = vi.fn(async (_d, _c, _a, opts) => {
      if (end === 'entry') active = false;
      opts!.preSend!();
      if (end === 'handshake') throw handshakeTimeout();
      if (end === 'dequeue') active = false;
      opts!.preSend!();
      if (end === 'expired') { const error = new DeviceLinkError('BACKPRESSURE', 'expired before socket write'); error.inFlight = false; throw error; }
      opts!.onRequestWritten!();
      if (end === 'resend') { active = false; opts!.preSend!(); }
      const error = new DeviceLinkError('INVOKE_TIMEOUT', 'no reply after first socket write'); error.inFlight = true; throw error;
    }) as PluginManagementInvoke;
    const client = createPluginManagementClient({ invoke, deviceId: 'host-1', isCurrent: () => active });
    await expect(uninstall(client)).rejects.toMatchObject({ outcomeUnknown: unknown });
  });
  it('classifies an answer from the transport, never from a passing check or a handshake', async () => {
    let active = true;
    // Passes the entry check, then is refused right before the write: not written, a plain failure.
    const refused = vi.fn(async (_d, _c, _a, opts) => { opts!.preSend!(); active = false; opts!.preSend!(); }) as PluginManagementInvoke;
    await expect(createPluginManagementClient({ invoke: refused, deviceId: 'host-1', isCurrent: () => active })
      .answer('operation-1', 'consent-1', true)).rejects.toMatchObject({ outcomeUnknown: false });
    // Only the handshake was written and timed out: not written.
    const handshake = vi.fn(async (_d, _c, _a, opts) => { opts!.preSend!(); throw handshakeTimeout(); }) as PluginManagementInvoke;
    await expect(createPluginManagementClient({ invoke: handshake, deviceId: 'host-1' })
      .answer('operation-1', 'consent-1', true)).rejects.toMatchObject({ outcomeUnknown: false });
    // Written, reply lost: unknown.
    const lost = vi.fn(async (_d, _c, _a, opts) => { opts!.preSend!(); opts!.preSend!(); opts!.onRequestWritten!();
      const error = new DeviceLinkError('INVOKE_TIMEOUT', 'lost'); error.inFlight = true; throw error; }) as PluginManagementInvoke;
    await expect(createPluginManagementClient({ invoke: lost, deviceId: 'host-1' }).answer('operation-1', 'consent-1', true))
      .rejects.toMatchObject({ outcomeUnknown: true });
    const replied = vi.fn(async (_d, _c, _a, opts) => { opts!.preSend!(); opts!.preSend!(); opts!.onRequestWritten!(); return { effects: [], result: receipt('running') }; }) as PluginManagementInvoke;
    await expect(createPluginManagementClient({ invoke: replied, deviceId: 'host-1' }).answer('operation-1', 'consent-1', true))
      .resolves.toMatchObject({ phase: 'running' });
  });
});

// Maintainer review 09:30 #3 (reproduced on b93ba486 with 0 writes: it ended "unknown", the original-operation lookup
// said NOT_FOUND and it stayed unknown, so this computer's management slot could not start the next operation).
// A disable is queued; a refresh meanwhile finds the instance gone, so the last send check stops it before the write.
// Minimal failing input: one queued disable, one refresh without the instance. Tier: unit (in-memory Host).
describe('a queued operation stopped before it was written', () => {
  it('fails, frees the management slot and is never looked up or sent again', async () => {
    let facts = snapshot();
    let hold: Promise<void> | undefined;
    let release!: () => void;
    const requests: Envelope[] = [];
    // Production order: the check at entry, the queue, the last check, then the write.
    const invoke = vi.fn(async (_id: string, channel: string, args?: unknown[], options?: { preSend?: () => void; onRequestWritten?: () => void }) => {
      options?.preSend?.();
      const request = args?.[0] as Envelope;
      if (!channel.endsWith(':manifest') && request.actionId === 'management:begin' && hold) await hold;
      options?.preSend?.();
      options?.onRequestWritten?.();
      if (channel.endsWith(':manifest')) return capability;
      requests.push(request);
      if (request.actionId === 'management:snapshot') return { effects: [], result: facts };
      if (request.actionId === 'management:operation') throw Object.assign(new Error('forgotten'), { code: 'NOT_FOUND' });
      return { effects: [], result: receipt('succeeded') };
    }) as unknown as PluginManagementInvoke;
    const c = controller(createPluginManagementClient({ deviceId: 'host-1', invoke }));
    await c.refresh();
    hold = new Promise((resolve) => { release = resolve; });
    const disabling = c.setEnabled(plugin, false);
    await vi.waitFor(() => expect(c.getState()).toMatchObject({ busy: true, outcome: 'running', operationId: 'operation-1' }));
    facts = snapshot([]);
    await c.refresh();
    release();
    await disabling;
    expect(requests.filter((r) => r.actionId === 'management:begin')).toHaveLength(0);
    expect(c.getState()).toMatchObject({ busy: false, outcome: 'failed', errorCode: 'PLUGIN_MANAGEMENT_STALE' });
    await c.reconcile();
    expect(requests.filter((r) => r.actionId === 'management:operation')).toHaveLength(0);
    // The slot is free: once the plugin is back, the next operation starts and is sent once.
    hold = undefined;
    facts = snapshot();
    await c.refresh();
    await c.setEnabled(plugin, false);
    expect(requests.filter((r) => r.actionId === 'management:begin')).toHaveLength(1);
    expect(c.getState()).toMatchObject({ busy: false, outcome: 'succeeded' });
  });
});

// Maintainer review 10:36 #1: a result belongs to the account, computer and operation, not to the connection epoch.
// Going offline and coming back are separate events inserted between a request's enqueue, its last check before the
// write (dequeue), the write and its reply, for every kind of operation:
// - never written (stopped at the dequeue check because the computer went offline while it was queued): a begin fails
//   and frees the management slot; an answer or cancel leaves its operation as the computer reports it; a lookup that
//   lands later never turns it back into an unknown result;
// - written, reply lost: unknown, looked up only, never sent again.
// Minimal failing input: enqueue → offline → dequeue refused → reconnect (b93ba486..51996243 kept the slot taken).
// The begin orders fail before this change; the answer and cancel orders also pass on the old code (existing behaviour).
// Tier: unit (in-memory Host, every valid order enumerated).
describe('offline and reconnect between enqueue, dequeue, write and reply', () => {
  type Target = 'begin' | 'answer' | 'cancel';
  type Step = 'offline' | 'online' | 'dequeue' | 'reply' | 'query';
  const lost = () => { const error = new DeviceLinkError('INVOKE_TIMEOUT', 'no reply after first socket write'); error.inFlight = true; return error; };
  const notFound = () => Object.assign(new Error('forgotten'), { code: 'NOT_FOUND' });
  const orderings = (items: Step[]): Step[][] => items.length <= 1 ? [items]
    : items.flatMap((first, index) => orderings([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [first, ...rest]));
  const at = (order: Step[], step: Step) => order.indexOf(step);
  // Never written: offline comes before the dequeue check; the reconnect's lookup comes after the reconnect.
  const refusedOrders = orderings(['offline', 'online', 'dequeue', 'query'])
    .filter((o) => at(o, 'offline') < at(o, 'dequeue') && at(o, 'offline') < at(o, 'online') && at(o, 'online') < at(o, 'query'));
  // Written: the dequeue check passes first, then the reply is lost somewhere among going offline and coming back.
  const writtenOrders = orderings(['reply', 'offline', 'online', 'query'])
    .filter((o) => at(o, 'offline') < at(o, 'online') && at(o, 'online') < at(o, 'query')).map((o): Step[] => ['dequeue', ...o]);
  function rig(target: Target, lookup: () => unknown) {
    const written: string[] = [];
    const gates = new Map<string, ReturnType<typeof deferred<void>>>();
    const gate = (name: string) => { if (!gates.has(name)) gates.set(name, deferred<void>()); return gates.get(name)!; };
    let holding = false;
    const invoke = vi.fn(async (_id: string, channel: string, args?: unknown[], options?: { preSend?: () => void; onRequestWritten?: () => void }) => {
      options?.preSend?.();
      const request = args?.[0] as Envelope | undefined;
      const held = holding && request?.actionId === `management:${target}`;
      const query = holding && request?.actionId === 'management:operation';
      if (held) await gate('dequeue').promise;
      options?.preSend?.();
      options?.onRequestWritten?.();
      if (channel.endsWith(':manifest')) return capability;
      written.push(request!.actionId);
      if (held) { await gate('reply').promise; throw lost(); }
      if (query) { await gate('query').promise; return { effects: [], result: lookup() }; }
      if (request!.actionId === 'management:snapshot') return { effects: [], result: snapshot() };
      if (request!.actionId === 'management:market-detail') return { effects: [], result: detail };
      if (request!.actionId === 'management:begin') return { effects: [], result: target === 'answer' ? confirmation() : target === 'cancel' ? receipt('running') : receipt('succeeded') };
      if (request!.actionId === 'management:cancel') return { effects: [], result: receipt('cancelled') };
      return { effects: [], result: receipt('succeeded') };
    }) as unknown as PluginManagementInvoke;
    const c = createPluginManagementController(createPluginManagementClient({ deviceId: 'host-1', invoke }),
      { createOperationId: () => 'operation-1', pollIntervalMs: 60_000 });
    controllers.push(c);
    const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
    const run = async (order: Step[]) => {
      for (const step of order) {
        if (step === 'offline') c.setOnline(false);
        else if (step === 'online') c.setOnline(true);
        else if (step === 'dequeue') gate('dequeue').resolve();
        else if (step === 'reply') gate('reply').resolve();
        else gate('query').resolve();
        await flush();
      }
    };
    return { c, written, run, hold: (value: boolean) => { holding = value; }, flush,
      count: (action: string) => written.filter((id) => id === `management:${action}`).length };
  }
  const begins = [
    ['disable', (c: ReturnType<typeof createPluginManagementController>) => c.setEnabled(plugin, false)],
    ['uninstall', (c: ReturnType<typeof createPluginManagementController>) => c.uninstall(plugin)],
    ['update', (c: ReturnType<typeof createPluginManagementController>) => c.install(detail, plugin)],
  ] as const;
  describe.each(begins)('begin (%s)', (_kind, startOperation) => {
    it.each(refusedOrders.map((o) => [o.join(' → '), o] as const))('never written: %s', async (_label, order) => {
      const r = rig('begin', () => { throw notFound(); });
      await r.c.refresh();
      r.hold(true);
      void startOperation(r.c);
      await r.flush();
      await r.run(order);
      expect(r.count('begin')).toBe(0);
      expect(r.c.getState()).toMatchObject({ outcome: 'failed', busy: false });
      // The slot is free: the next operation starts and is written once.
      r.hold(false);
      await startOperation(r.c);
      expect(r.count('begin')).toBe(1);
      expect(r.c.getState().outcome).toBe('succeeded');
    });
    it.each(writtenOrders.map((o) => [o.join(' → '), o] as const))('written, reply lost: %s', async (_label, order) => {
      const r = rig('begin', () => { throw notFound(); });
      await r.c.refresh();
      r.hold(true);
      void startOperation(r.c);
      await r.flush();
      await r.run(order);
      expect(r.count('begin')).toBe(1);
      expect(r.c.getState()).toMatchObject({ outcome: 'unknown', operationId: 'operation-1' });
      // Held as unknown: another start sends nothing; the reconnect only looked the operation up.
      await startOperation(r.c);
      expect(r.count('begin')).toBe(1);
      expect(r.count('operation')).toBeGreaterThan(0);
    });
  });
  describe('answer', () => {
    it.each(refusedOrders.map((o) => [o.join(' → '), o] as const))('never written: %s', async (_label, order) => {
      // The computer still waits for the answer; its lookup returns the consent.
      const r = rig('answer', () => confirmation());
      await r.c.refresh(); await r.c.install(detail, plugin);
      expect(r.c.getState().outcome).toBe('confirmation');
      r.hold(true);
      void r.c.answer(true);
      await r.flush();
      await r.run(order);
      expect(r.count('answer')).toBe(0);
      expect(r.c.getState()).toMatchObject({ outcome: 'confirmation', busy: false });
      r.hold(false);
      await r.c.answer(true);
      expect(r.count('answer')).toBe(1);
      expect(r.c.getState().outcome).toBe('succeeded');
    });
    it.each(writtenOrders.map((o) => [o.join(' → '), o] as const))('written, reply lost: %s', async (_label, order) => {
      const r = rig('answer', () => receipt('running'));
      await r.c.refresh(); await r.c.install(detail, plugin);
      r.hold(true);
      void r.c.answer(true);
      await r.flush();
      await r.run(order);
      expect(r.count('answer')).toBe(1);
      expect(r.c.getState()).toMatchObject({ outcome: 'running', busy: false });
    });
  });
  describe('cancel', () => {
    it.each(refusedOrders.map((o) => [o.join(' → '), o] as const))('never written: %s', async (_label, order) => {
      const r = rig('cancel', () => receipt('running'));
      await r.c.refresh(); await r.c.uninstall(plugin);
      expect(r.c.getState().outcome).toBe('running');
      r.hold(true);
      void r.c.cancel();
      await r.flush();
      await r.run(order);
      expect(r.count('cancel')).toBe(0);
      expect(r.c.getState()).toMatchObject({ outcome: 'running', busy: false });
    });
    it.each(writtenOrders.map((o) => [o.join(' → '), o] as const))('written, reply lost: %s', async (_label, order) => {
      const r = rig('cancel', () => receipt('cancelled'));
      await r.c.refresh(); await r.c.uninstall(plugin);
      r.hold(true);
      void r.c.cancel();
      await r.flush();
      await r.run(order);
      expect(r.count('cancel')).toBe(1);
      expect(r.c.getState()).toMatchObject({ outcome: 'cancelled', busy: false });
    });
  });
});

// Maintainer review 11:45: an old answer or cancel stopped at its last check must not release the busy state a newer
// request holds (two opposite answers were written for one consent), and a late, older lookup must not reopen a
// consent the Host already moved past. Model check from a shown consent: every reachable sequence of events
// (going offline or online; each request's dequeue check, its delivery or its lost reply; the person tapping Allow,
// Reject or Check result whenever the screen lets them), with these invariants after every step:
// ① Allow / Reject are tappable only when no request holds busy and no answer to this consent is in flight or written;
// ② at most one answer is written per consent request; ③ at most one lookup is in flight on the current connection;
// ④ once the Host's later phase was shown, the consent never shows again; ⑤ busy is never held with nothing in flight.
// Minimal failing input (54a3e8db): Reject queued → offline → online → lookup → Allow written → old Reject refused.
// Tier: unit (in-memory Host; bounded depth, every enabled event at every step).
describe('busy belongs to one request; one answer per consent', () => {
  type Pending = { kind: 'answer' | 'operation' | 'cancel'; confirmed?: boolean; stage: 'queued' | 'written'; epoch: number;
    dequeue(): void; deliver?(): void; reply?(): void; lose(): void };
  const lostError = () => { const error = new DeviceLinkError('INVOKE_TIMEOUT', 'no reply after first socket write'); error.inFlight = true; return error; };
  function rig() {
    const host = { phase: 'confirmation' as 'confirmation' | 'running' | 'succeeded' | 'cancelled', answersWritten: 0 };
    const hostReceipt = (): PluginManagementReceipt => host.phase === 'confirmation' ? confirmation() : receipt(host.phase);
    const pending: Pending[] = [];
    let connection = 0;
    const settle = (item: Pending) => { const index = pending.indexOf(item); if (index >= 0) pending.splice(index, 1); };
    // The Host applies a delivered answer or cancel once (a cancel ends anything not finished).
    const apply = (item: Pending) => {
      if (item.kind === 'answer' && host.phase === 'confirmation') host.phase = item.confirmed ? 'running' : 'cancelled';
      if (item.kind === 'cancel' && (host.phase === 'confirmation' || host.phase === 'running')) host.phase = 'cancelled';
    };
    const invoke = (async (_id: string, channel: string, args?: unknown[], options?: { preSend?: () => void; onRequestWritten?: () => void }) => {
      options?.preSend?.();
      const request = args?.[0] as Envelope | undefined;
      const action = request?.actionId;
      if (action !== 'management:answer' && action !== 'management:operation' && action !== 'management:cancel') {
        options?.preSend?.(); options?.onRequestWritten?.();
        if (channel.endsWith(':manifest')) return capability;
        if (action === 'management:snapshot') return { effects: [], result: snapshot() };
        if (action === 'management:market-detail') return { effects: [], result: detail };
        if (action === 'management:begin') return { effects: [], result: confirmation() };
        throw new Error('unexpected ' + action);
      }
      return new Promise((resolve, reject) => {
        const item: Pending = { kind: action === 'management:answer' ? 'answer' : action === 'management:cancel' ? 'cancel' : 'operation',
          stage: 'queued', epoch: connection,
          confirmed: (request!.input as { confirmed?: boolean }).confirmed,
          dequeue: () => {
            try { options?.preSend?.(); } catch (error) { settle(item); reject(error); return; }
            options?.onRequestWritten?.();
            item.stage = 'written';
            if (item.kind === 'answer') host.answersWritten += 1;
            else { const captured = hostReceipt(); if (host.phase === 'running') host.phase = 'succeeded';
              item.reply = () => { settle(item); resolve({ effects: [], result: captured }); }; }
          },
          deliver: () => {
            settle(item);
            apply(item);
            resolve({ effects: [], result: hostReceipt() });
          },
          lose: () => {
            settle(item);
            apply(item);
            reject(lostError());
          },
        };
        pending.push(item);
      });
    }) as unknown as PluginManagementInvoke;
    const c = createPluginManagementController(createPluginManagementClient({ deviceId: 'host-1', invoke }),
      { createOperationId: () => 'operation-1', pollIntervalMs: 3_600_000 });
    controllers.push(c);
    return { c, host, pending, toggle: () => { connection += 1; }, connection: () => connection };
  }
  // Every step settles on microtasks alone (the rig never uses timers), which keeps the exhaustive walk fast.
  const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
  type Event = string;
  async function replay(events: Event[]) {
    const r = rig();
    await r.c.refresh(); await r.c.install(detail, plugin);
    expect(r.c.getState().outcome).toBe('confirmation');
    let hostPhaseShown = false, violation: string | null = null, offline = 0, online = 0, taps = 0, checks = 0, cancels = 0;
    const tappable = () => { const st = r.c.getState(); return st.outcome === 'confirmation' && st.online && !st.busy && !st.answerHeld; };
    const check = (step: string) => {
      const st = r.c.getState();
      const answering = r.pending.some((item) => item.kind === 'answer');
      if (tappable() && (answering || r.host.answersWritten > 0)) violation ??= `① tappable while an answer is in flight or written (${step})`;
      if (tappable() && r.host.phase !== 'confirmation' && r.pending.length === 0) violation ??= `④ consent tappable after the Host moved on (${step})`;
      if (r.host.answersWritten > 1) violation ??= `② ${r.host.answersWritten} answers written (${step})`;
      if (r.pending.filter((item) => item.kind === 'operation' && item.epoch === r.connection()).length > 1) violation ??= `③ two lookups in flight (${step})`;
      if (st.outcome === 'running' || st.outcome === 'succeeded' || st.outcome === 'cancelled') hostPhaseShown = true;
      if (hostPhaseShown && st.outcome === 'confirmation') violation ??= `④ consent reopened (${step})`;
      if (st.busy && r.pending.length === 0) violation ??= `⑤ busy with nothing in flight (${step})`;
    };
    const enabled = (): Event[] => {
      const st = r.c.getState(), list: Event[] = [];
      if (st.online && offline === 0) list.push('offline');
      if (!st.online && online === 0) list.push('online');
      if (tappable() && taps < 2) list.push('allow', 'reject');
      if (st.outcome === 'unknown' && st.online && !st.busy && checks < 2) list.push('check');
      // Cancellation races queued and in-flight requests (the controller accepts it while busy).
      if (cancels === 0 && st.online && st.operationId && !['succeeded', 'cancelled', 'failed'].includes(st.outcome)) list.push('cancel');
      r.pending.forEach((item, index) => {
        if (item.stage === 'queued') list.push(`dequeue#${index}`);
        else { if (item.kind === 'operation') list.push(`reply#${index}`); else list.push(`deliver#${index}`); list.push(`lose#${index}`); }
      });
      return list;
    };
    for (const event of events) {
      const [name, at] = event.split('#');
      const item = at !== undefined ? r.pending[Number(at)] : undefined;
      if (name === 'offline') { offline += 1; r.toggle(); r.c.setOnline(false); }
      else if (name === 'online') { online += 1; r.toggle(); r.c.setOnline(true); }
      else if (name === 'allow' || name === 'reject') { taps += 1; void r.c.answer(name === 'allow'); }
      else if (name === 'check') { checks += 1; void r.c.reconcile(); }
      else if (name === 'cancel') { cancels += 1; void r.c.cancel(); }
      else if (name === 'dequeue') item!.dequeue();
      else if (name === 'deliver') item!.deliver!();
      else if (name === 'reply') item!.reply!();
      else item!.lose();
      await flush();
      check(events.join(' → '));
    }
    return { violation, next: enabled() };
  }
  it('keeps the invariants after every step of every reachable sequence', async () => {
    const violations = new Set<string>();
    let paths = 0;
    const explore = async (events: Event[]): Promise<void> => {
      const { violation, next } = await replay(events);
      if (violation) { violations.add(violation); return; }
      if (!next.length || events.length >= 7) { paths += 1; return; }
      for (const event of next) await explore([...events, event]);
    };
    await explore([]);
    expect([...violations].slice(0, 10)).toEqual([]);
    expect(paths).toBeGreaterThan(100);
  }, 120_000);
  // The two orders the maintainer reproduced, as plain regressions.
  it('keeps a consent unanswerable while an old Reject is queued, then lets exactly one answer through', async () => {
    const r = rig();
    await r.c.refresh(); await r.c.install(detail, plugin);
    void r.c.answer(false); await flush();                      // Reject queued
    r.toggle(); r.c.setOnline(false); await flush();             // offline
    r.toggle(); r.c.setOnline(true); await flush();              // online: the lookup is queued
    const lookup = r.pending.find((item) => item.kind === 'operation')!;
    lookup.dequeue(); await flush(); lookup.reply!(); await flush();
    // The consent is back, but the old Reject may still leave: Allow and Reject stay unavailable.
    expect(r.c.getState()).toMatchObject({ outcome: 'confirmation', answerHeld: 'consent-1' });
    void r.c.answer(true); await flush();
    expect(r.pending.filter((item) => item.kind === 'answer')).toHaveLength(1);
    r.pending.find((item) => item.kind === 'answer')!.dequeue(); await flush(); // the old Reject is refused: never written
    expect(r.c.getState()).toMatchObject({ outcome: 'confirmation', busy: false, answerHeld: null });
    void r.c.answer(true); await flush();                        // Allow queued
    const allow = r.pending.find((item) => item.kind === 'answer')!;
    allow.dequeue(); await flush();                              // Allow written, waiting
    expect(r.c.getState()).toMatchObject({ busy: true, answerHeld: 'consent-1' });
    void r.c.answer(false); await flush();
    expect(r.host.answersWritten).toBe(1);
    allow.deliver!(); await flush();
    expect(r.c.getState()).toMatchObject({ busy: false, outcome: 'running' });
  });
  it('keeps the reconnect lookup holding busy when an old cancel is stopped at its last check', async () => {
    const r = rig();
    await r.c.refresh(); await r.c.install(detail, plugin);
    void r.c.cancel(); await flush();                            // cancel queued (sent as an operation-scoped request)
    r.toggle(); r.c.setOnline(false); await flush();
    r.toggle(); r.c.setOnline(true); await flush();              // the reconnect lookup is queued
    const lookups = () => r.pending.filter((item) => item.kind === 'operation');
    expect(lookups()).toHaveLength(1);
    const old = r.pending.find((item) => item.kind === 'cancel');
    old?.dequeue(); await flush();                               // the old cancel is refused
    expect(r.c.getState().busy).toBe(true);
    await r.c.reconcile(); await flush();                        // no second lookup while the first holds busy
    expect(lookups()).toHaveLength(1);
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
    // Allow was never written, so the operation still waits on the computer: the consent stays (Reject still works)
    // with the reason, instead of an unknown result (maintainer review 10:36: an unwritten request releases its hold).
    expect(c.getState()).toMatchObject({ outcome: 'confirmation', busy: false, errorCode: 'PLUGIN_INSTALL_CHANGED' });
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
    // The begin was never written (no write receipt), so the operation never existed on the computer: whatever the
    // cancel reply said, it ends as a plain failure and frees the slot (maintainer review 10:36).
    expect(c.getState()).toMatchObject({ outcome: 'failed', busy: false });
    expect(h.requests.some((r) => r.actionId === 'management:begin')).toBe(false);
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
    // The queued write's last check refuses it after the reconnect; like the real transport, a refused request never
    // gets a reply, it fails as never written.
    let refusal: unknown;
    try { preSend(); } catch (error) { refusal = error; }
    expect(refusal).toMatchObject({ message: 'PLUGIN_MANAGEMENT_STALE' });
    const recoveredOutcome = c.getState().outcome;
    queued.reject(refusal); await pending;
    // An unwritten answer or cancel leaves the operation as the computer reported it; an unwritten begin means the
    // operation never existed on the computer, so it ends as a plain failure.
    expect(c.getState().outcome).toBe(action === 'begin' ? 'failed' : recoveredOutcome);
    expect(h.requests.some((r) => r.actionId === `management:${action}`)).toBe(false);
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
    // The written begin's reply is the Host's state of this operation: it lands by operation id even though the
    // computer went offline meanwhile (maintainer reviews 10:36 and 11:45: results belong to the operation).
    c.setOnline(false); begin.resolve(receipt('succeeded')); await start;
    expect(c.getState()).toMatchObject({ online: false, outcome: 'succeeded' });
    c.setOnline(true);
    await vi.waitFor(() => expect(c.getState().busy).toBe(false));
    // A final outcome is never changed by the reconnect, and nothing is sent again.
    expect(c.getState().outcome).toBe('succeeded');
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
describe('mobile plugin market', () => {
  const fresh: ManagedMarketDetail = { ...detail, installState: 'not-installed', enabled: null };
  it('installs a plugin the computer does not have yet: begin without an instance, consent, then the new instance is read back', async () => {
    const installedNow = { ...plugin, manifest };
    const h = host((request) => {
      if (request.actionId === 'management:begin') return confirmation();
      h.setFacts(snapshot([installedNow]));
      return receipt('succeeded');
    }, fresh);
    h.setFacts(snapshot([]));
    const c = controller(h.client); await c.refresh();
    await c.install(fresh);
    expect(c.getState().outcome).toBe('confirmation');
    const begin = h.requests.find((r) => r.actionId === 'management:begin')!;
    expect(begin.resourceRef).toBeUndefined();
    expect(begin.input).toEqual({ operationId: 'operation-1', kind: 'install', pluginId: 'market/demo', expectedReleaseId: 'release-2' });
    await c.answer(true);
    expect(c.getState()).toMatchObject({ outcome: 'succeeded', busy: false });
    expect(c.getState().snapshot?.ghosts.map((g) => g.instanceKey)).toEqual([plugin.instanceKey]);
    expect(h.requests.filter((r) => r.actionId === 'management:begin')).toHaveLength(1);
  });
  it('accepts an older paging Host page with optional fields missing and degrades unknown publisher labels', () => {
    const page = parsePluginMarketPage({ items: [{ ...fresh, publisherKind: 'partner', customIconKey: 'target-only' }] });
    expect(page).toMatchObject({ nextCursor: null, counts: null, organizationAccessError: null, unavailableReason: null,
      customSourceNames: [], unavailableCustomSourceNames: [] });
    expect(page.items[0]).not.toHaveProperty('publisherKind');
    expect(page.items[0]).not.toHaveProperty('customIconKey');
    expect(page.items[0]).not.toHaveProperty('manifest');
    expect(parsePluginMarketPage({ items: [{ ...fresh, publisherKind: 'official' }], nextCursor: 'next',
      counts: { all: 3, public: 2, organization: 0, personal: 0, custom: 1, official: 1 } })).toMatchObject({
      nextCursor: 'next', counts: { all: 3, official: 1 }, items: [{ publisherKind: 'official' }] });
  });
  it.each([
    ['too many items', { items: Array(101).fill(fresh) }],
    ['oversized cursor', { items: [], nextCursor: 'x'.repeat(2049) }],
    ['non-string cursor', { items: [], nextCursor: 5 }],
    ['counts that do not add up', { items: [], counts: { all: 3, public: 1, organization: 0, personal: 0, custom: 0 } }],
    ['publisher subsets larger than public', { items: [], counts: { all: 1, public: 1, organization: 0, personal: 0, custom: 0, official: 1, community: 1 } }],
    ['a malformed item', { items: [{ ...fresh, releaseId: '' }] }],
  ])('rejects a market page with %s', (_name, value) => {
    expect(() => parsePluginMarketPage(value)).toThrow('INVALID_RESPONSE');
  });
  it('sends one bounded catalog query and treats only INVALID_PARAMS as an older Host', async () => {
    const inputs: unknown[] = [];
    let capabilities: () => unknown = () => ({ catalogPaging: true });
    const invoke = vi.fn(async (_id: string, _channel: string, args?: unknown[]) => {
      const input = (args?.[0] as Envelope).input;
      inputs.push(input);
      return { effects: [], result: input.read === 'capabilities' ? capabilities() : { items: [fresh], nextCursor: null } };
    }) as unknown as PluginManagementInvoke;
    const client = createPluginManagementClient({ deviceId: 'host-1', invoke });
    await expect(client.catalog({ query: ' cal ', scope: 'public', limit: 100, excludeInstalled: true, counts: false }))
      .resolves.toMatchObject({ items: [{ pluginId: 'market/demo' }] });
    expect(inputs.at(-1)).toEqual({ read: 'catalog', query: { query: 'cal', scope: 'public', limit: 100, excludeInstalled: true, counts: false } });
    await expect(client.catalog({ query: 'x'.repeat(101) })).rejects.toThrow('INVALID_INPUT');
    expect(inputs).toHaveLength(1);
    await expect(client.catalogPaging()).resolves.toBe(true);
    capabilities = () => { throw Object.assign(new Error('old'), { code: 'INVALID_PARAMS' }); };
    await expect(client.catalogPaging()).resolves.toBe(false);
    // The real wire form: dispatch IPC_ERROR → Error("[INVALID_PARAMS] …") with no code.
    capabilities = () => { throw new Error('[INVALID_PARAMS] Invalid plugin management request'); };
    await expect(client.catalogPaging()).resolves.toBe(false);
    capabilities = () => { throw Object.assign(new Error('offline'), { code: 'TIMEOUT' }); };
    await expect(client.catalogPaging()).rejects.toThrow('TIMEOUT');
  });
  it.each([
    ['https://cdn.example.test/icon.png', '2099-01-01T00:00:00.000Z', true],
    ['http://cdn.example.test/icon.png', '2099-01-01T00:00:00.000Z', false],
    ['https://cdn.example.test/icon.png', '2000-01-01T00:00:00.000Z', false],
    ['not a url', '2099-01-01T00:00:00.000Z', false],
  ])('loads only unexpired HTTPS icons (%s, %s)', (url, expiresAt, loads) => {
    const icon = { mimeType: 'image/png', sha256: 'a'.repeat(64), sizeBytes: 10, url, expiresAt };
    expect(pluginMarketIconUri({ icon })).toBe(loads ? url : undefined);
  });
});

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

// Production readers/controllers, real protocol envelopes: switches previously downloaded
// the complete plugin market for every chat hint. Display reuse must never authorize a write.
describe('shared chat plugin hints', () => {
  // Unit: the provider's AppState listener controls remote hint reads. Reader-only
  // tests miss this branch: background → inactive must reuse, active must refresh.
  it('only invalidates the provider cache when AppState returns to active', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const h = host(); promptLink.invoke.mockImplementation(h.invoke);
    appState.currentState = 'active';
    let reads: ReturnType<typeof createPluginPromptReads> | null = null;
    function Probe() { reads = usePluginPromptReads(); return null; }
    const root = createRoot(document.createElement('div'));
    try {
      await act(async () => { root.render(createElement(PluginPromptReadsProvider, { children: createElement(Probe) })); });
      await reads!.read('host-1');
      expect(h.requests).toHaveLength(1);
      for (const next of ['background', 'inactive', 'active']) {
        act(() => {
          appState.currentState = next;
          appState.listeners.forEach(listener => listener(next));
        });
        // A lifecycle event invalidates lazily; no read is sent without a consumer.
        expect(h.requests).toHaveLength(1);
        const read = reads!.read('host-1');
        await vi.advanceTimersByTimeAsync(250);
        await read;
        expect(h.requests).toHaveLength(next === 'active' ? 2 : 1);
      }
    } finally {
      act(() => root.unmount());
      vi.unstubAllGlobals();
      appState.currentState = 'active';
      promptLink.invoke.mockReset();
    }
  });
  it('uses the lightweight consent action when the Host advertises it', async () => {
    const requests: Envelope[] = [];
    const invoke = vi.fn(async (_id: string, channel: string, args?: unknown[]) => {
      if (channel.endsWith(':manifest')) return { protocolVersion: 1, collections: [{ id: 'plugins', actions: [
        { id: 'management:snapshot' }, { id: 'management:ui-consent' },
      ] }] };
      const request = args?.[0] as Envelope;
      requests.push(request);
      return { effects: [], result: request.actionId === 'management:ui-consent'
        ? { version: 1, uiCapabilityApproval: true, item: { instanceKey: '_root__demo', name: 'Demo', approvalToken: `approved:${plugin.approval.state === 'approved' ? plugin.approval.revision : 'invalid'}` } }
        : snapshot() };
    }) as unknown as PluginManagementInvoke;
    const reads = createPluginPromptReads(invoke, () => true);
    const display = await reads.read('host-1');
    expect(requests.map(request => request.actionId)).toEqual(['management:ui-consent']);
    expect(display.snapshot).toBeNull();
    expect(display.uiConsent).toMatchObject({ version: 1, uiCapabilityApproval: true, item: { instanceKey: '_root__demo' } });
    expect(parsePluginUiConsent(display.uiConsent)).toEqual(display.uiConsent);
  });
  it('falls back to the full snapshot for an older Host', async () => {
    const h = host(); const reads = createPluginPromptReads(h.invoke, () => true);
    const display = await reads.read('host-1');
    expect(h.requests.map(request => request.actionId)).toEqual(['management:snapshot']);
    expect(display.snapshot?.ghosts).toEqual([]);
    expect(display.uiConsent).toBeUndefined();
  });
  it('re-reads full Host facts by exact instance before a lightweight hint mutation', async () => {
    const needsUi = { ...plugin, manifest: { ...plugin.manifest, tools: [{ name: 'run' }],
      mcpApps: { ui: { resources: [{ uri: 'ui://run', file: 'page.html' }], tools: { run: {} } } } } };
    const actions: string[] = [];
    const invoke = vi.fn(async (_id: string, channel: string, args?: unknown[]) => {
      if (channel.endsWith(':manifest')) return { protocolVersion: 1, collections: [{ id: 'plugins', actions: [
        { id: 'management:snapshot' }, { id: 'management:ui-consent' },
      ] }] };
      const request = args?.[0] as Envelope; actions.push(request.actionId);
      if (request.actionId === 'management:ui-consent') return { effects: [], result: { version: 1,
        uiCapabilityApproval: true, item: { instanceKey: needsUi.instanceKey, name: needsUi.manifest.name,
          approvalToken: `approved:${plugin.approval.state === 'approved' ? plugin.approval.revision : 'invalid'}` } } };
      if (request.actionId === 'management:snapshot') return { effects: [], result: { ...snapshot([needsUi]), uiCapabilityApproval: true } };
      return { effects: [], result: receipt('succeeded') };
    }) as unknown as PluginManagementInvoke;
    const client = createPluginManagementClient({ deviceId: 'host-1', invoke });
    const reads = createPluginPromptReads(invoke, () => true);
    const c = createPluginManagementController(client, { readDisplay: () => reads.read('host-1'), createOperationId: () => 'operation-1' });
    controllers.push(c); await c.refresh();
    const item = c.getState().uiConsent?.item;
    expect(item?.instanceKey).toBe(needsUi.instanceKey);
    await c.approveUiFromConsent(item!);
    expect(actions).toEqual(['management:ui-consent', 'management:snapshot', 'management:begin', 'management:snapshot']);
    expect(c.getState().outcome).toBe('succeeded');
  });
  it('shares concurrent and sequential switches, drops market data, and invalidates on changes/expiry', async () => {
    vi.useFakeTimers();
    const h = host(); const reads = createPluginPromptReads(h.invoke, () => true);
    const results = await Promise.all(Array.from({ length: 20 }, () => reads.read('host-1')));
    for (let n = 0; n < 20; n++) expect(await reads.read('host-1')).toBe(results[0]);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0].actionId).toBe('management:snapshot');
    expect(results[0].snapshot?.market.items).toEqual([]);
    const event = {};
    reads.invalidate('host-1', event);
    const fresh = reads.read('host-1');
    reads.invalidate('host-1', event); // Provider + visible consumer see the same push.
    await vi.advanceTimersByTimeAsync(250);
    await fresh;
    expect(h.requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(30001);
    await reads.read('host-1');
    expect(h.requests).toHaveLength(3);
  });
  it('coalesces a notification burst and keeps one in-flight refresh', async () => {
    vi.useFakeTimers(); const h = host(); const reads = createPluginPromptReads(h.invoke, () => true);
    await reads.read('host-1'); h.requests.length = 0;
    const event = {}; reads.invalidate('host-1', event); const first = reads.read('host-1');
    reads.invalidate('host-1', event); const second = reads.read('host-1');
    expect(second).toBe(first); await vi.advanceTimersByTimeAsync(250); await first;
    expect(h.requests).toHaveLength(1);
  });
  it('rejects invalidated in-flight replies and retries after a read failure', async () => {
    const h = host(); const pending = deferred<unknown>();
    const invoke = vi.fn().mockReturnValueOnce(pending.promise).mockImplementation(h.invoke) as PluginManagementInvoke;
    const reads = createPluginPromptReads(invoke, () => true);
    const first = reads.read('host-1');
    const rejection = expect(first).rejects.toThrow('PLUGIN_MANAGEMENT_STALE');
    await Promise.resolve(); reads.invalidate(); pending.resolve(capability); await rejection;
    await expect(reads.read('host-1')).resolves.toMatchObject({ capability: 'supported' });
    reads.invalidate();
    vi.mocked(invoke).mockRejectedValueOnce(new Error('offline'));
    await expect(reads.read('host-1')).rejects.toThrow('offline');
    await expect(reads.read('host-1')).resolves.toMatchObject({ capability: 'supported' });
  });
  it('rechecks live facts before a mutation even when the display was shared', async () => {
    const h = host(); const reads = createPluginPromptReads(h.invoke, () => true);
    const c = createPluginManagementController(h.client, { readDisplay: () => reads.read('host-1') });
    controllers.push(c); await c.refresh();
    h.setFacts(snapshot([])); // Plugin removed after the hint was fetched.
    await c.setEnabled(plugin, false);
    expect(h.requests.map(r => r.actionId)).toEqual(['management:snapshot', 'management:snapshot']);
    expect(c.getState()).toMatchObject({ outcome: 'failed', errorCode: 'PLUGIN_INSTALL_CHANGED' });
  });
  it('fences a shared read when the account changes', async () => {
    const h = host(); const pending = deferred<unknown>();
    const invoke = vi.fn().mockReturnValueOnce(pending.promise).mockImplementation(h.invoke) as PluginManagementInvoke;
    const reads = createPluginPromptReads(invoke, () => true);
    const first = reads.read('host-1'); const rejection = expect(first).rejects.toThrow('PLUGIN_MANAGEMENT_STALE');
    await Promise.resolve(); setMobileAuthOwner('new-owner'); pending.resolve(capability); await rejection;
  });
});

it('does not reuse a chat hint across a sessions subscription gap', async () => {
  const h = host(); let subscription: number | null = 1;
  const reads = createPluginPromptReads(h.invoke, () => true, () => subscription);
  await reads.read('host-1'); await reads.read('host-1'); expect(h.requests).toHaveLength(1);
  subscription = null; await reads.read('host-1'); expect(h.requests).toHaveLength(2);
  subscription = 2; await reads.read('host-1'); expect(h.requests).toHaveLength(3);
});

it('retains an actionable UI hint while excluding suppressed, approved and unrelated plugins', async () => {
  const h = host();
  const needsUi = { ...plugin, manifest: { ...plugin.manifest, tools: [{ name: 'run' }],
    mcpApps: { ui: { resources: [{ uri: 'ui://run', file: 'page.html' }], tools: { run: {} } } } } };
  h.setFacts({ ...snapshot([needsUi,
    { ...needsUi, instanceKey: '_root__suppressed', uiPromptSuppressed: true },
    { ...needsUi, instanceKey: '_root__approved', uiCapabilityApproved: true },
    { ...plugin, instanceKey: '_root__ordinary' }]), uiCapabilityApproval: true });
  const reads = createPluginPromptReads(h.invoke, () => true);
  const display = await reads.read('host-1');
  expect(display.snapshot?.ghosts).toEqual([needsUi]);
  expect(display.snapshot?.uiCapabilityApproval).toBe(true);
  expect(display.snapshot?.market.items).toEqual([]);
});

// PR #10206 review regressions, unit: real reader/controller/notice entries.
// Existing tests missed changed consent revisions, distinct notifications during
// debounce/failure, old-generation cleanup and unsupported proactive prompts.
// Only transport is controlled; fake timers expose requests and final UI outcomes.
describe('plugin hint review regressions', () => {
  const needsUi: ManagedPlugin = { ...plugin, manifest: { ...plugin.manifest, tools: [{ name: 'run' }],
    mcpApps: { ui: { resources: [{ uri: 'ui://run', file: 'page.html' }], tools: { run: {} } } } } };
  const consent = { version: 1 as const, uiCapabilityApproval: true as const, item: {
    instanceKey: plugin.instanceKey, name: plugin.manifest.name,
    approvalToken: 'approved:12345678-1234-4123-8123-123456789abc',
  } };
  function compactHost() {
    const h = host(() => receipt('succeeded'));
    const invoke: PluginManagementInvoke = async (id, channel, args, options) => {
      options?.preSend?.();
      if (channel.endsWith(':manifest')) return { collections: [{ id: 'plugins', actions: [
        { id: 'management:snapshot' }, { id: 'management:ui-consent' },
      ] }] } as never;
      if ((args?.[0] as Envelope)?.actionId === 'management:ui-consent') return { result: consent } as never;
      return h.invoke(id, channel, args, options);
    };
    const client = createPluginManagementClient({ deviceId: 'host-1', invoke });
    const reads = createPluginPromptReads(invoke, () => true);
    const c = createPluginManagementController(client, { readDisplay: () => reads.read('host-1'), createOperationId: () => 'operation-1' });
    controllers.push(c);
    return { ...h, c };
  }
  it.each(['approveUiFromConsent', 'deferUiFromConsent'] as const)(
    'keeps the displayed approval revision for %s', async action => {
      vi.useFakeTimers();
      const h = compactHost(); await h.c.refresh();
      const displayed = h.c.getState().uiConsent!.item!;
      h.setFacts({ ...snapshot([{ ...needsUi, approval: { state: 'approved', revision: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } }]), uiCapabilityApproval: true });
      await h.c[action](displayed);
      expect(h.requests.filter(r => r.actionId === 'management:begin')).toHaveLength(0);
      expect(h.c.getState()).toMatchObject({ outcome: 'failed', errorCode: 'PLUGIN_INSTALL_CHANGED' });
      h.setFacts({ ...snapshot([needsUi]), uiCapabilityApproval: true });
      await h.c[action](displayed);
      expect(h.requests.filter(r => r.actionId === 'management:begin')).toEqual([
        expect.objectContaining({ resourceRef: expect.objectContaining({ id: displayed.instanceKey }),
          input: expect.objectContaining({ expectedInstalledApproval: displayed.approvalToken }) }),
      ]);
    },
  );
  it.each([{ queued: false, retryFails: false }, { queued: true, retryFails: false }, { queued: true, retryFails: true }])(
    'consumes a notification queued during a failed read ($queued, retryFails=$retryFails)', async ({ queued, retryFails }) => {
    vi.useFakeTimers();
    const h = host(); const pending = deferred<unknown>(); let calls = 0;
    const invoke: PluginManagementInvoke = async (id, channel, args, options) => {
      if (!channel.endsWith(':manifest')) {
        calls++;
        if (calls === 1) return await pending.promise as never;
        // The one notification allows one follow-up, not an automatic retry loop.
        if (retryFails) throw new Error('READ_FAILED');
      }
      return h.invoke(id, channel, args, options);
    };
    const reads = createPluginPromptReads(invoke, () => true);
    const release = reads.retain('host-1'); // This retry fixture represents a visible consumer.
    const result = reads.read('host-1').catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    if (queued) { reads.invalidate('host-1', {}); void reads.read('host-1').catch(() => {}); }
    pending.reject(new Error('READ_FAILED'));
    await vi.advanceTimersByTimeAsync(250);
    expect(calls).toBe(queued ? 2 : 1);
    expect(await result).toMatchObject(queued && !retryFails ? { capability: 'supported' } : { message: 'READ_FAILED' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toBe(queued ? 2 : 1);
    release();
  });
  it('consumes distinct notifications received inside the same debounce window', async () => {
    vi.useFakeTimers();
    const h = host(); const reads = createPluginPromptReads(h.invoke, () => true);
    await reads.read('host-1');
    reads.invalidate('host-1', {}); const result = reads.read('host-1');
    await vi.advanceTimersByTimeAsync(100);
    reads.invalidate('host-1', {}); void reads.read('host-1');
    await vi.advanceTimersByTimeAsync(1000); await result;
    expect(h.requests.map(r => r.actionId)).toEqual(['management:snapshot', 'management:snapshot']);
  });
  it('does not let an old read clear a new connection generation in-flight read', async () => {
    vi.useFakeTimers();
    const h = host(); const old = deferred<unknown>(), fresh = deferred<unknown>(); let calls = 0;
    const invoke: PluginManagementInvoke = async (id, channel, args, options) => {
      if (!channel.endsWith(':manifest')) {
        calls++;
        if (calls === 1) return await old.promise as never;
        if (calls === 2) return await fresh.promise as never;
      }
      return h.invoke(id, channel, args, options);
    };
    const reads = createPluginPromptReads(invoke, () => true);
    const first = reads.read('host-1').catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    reads.invalidate();
    const second = reads.read('host-1').catch(error => error);
    await vi.advanceTimersByTimeAsync(250);
    old.resolve({ result: snapshot() });
    expect(await first).toMatchObject({ message: 'PLUGIN_MANAGEMENT_STALE' });
    const third = reads.read('host-1').catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    fresh.resolve({ result: snapshot() });
    const results = await Promise.all([second, third]);
    expect(calls).toBe(2);
    expect(results).toEqual([expect.objectContaining({ capability: 'supported' }), expect.objectContaining({ capability: 'supported' })]);
  });
  it.each(['unsupported', 'snapshot', 'ui-consent'] as const)(
    'requires UI approval capability for proactive hints (%s)', async source => {
      vi.useFakeTimers();
      const h = host(); h.setFacts({ ...snapshot([needsUi]), ...(source === 'snapshot' ? { uiCapabilityApproval: true as const } : {}) });
      const c = controller(h.client); await c.refresh();
      const state = source === 'ui-consent' ? { ...c.getState(), snapshot: null, uiConsent: consent } : c.getState();
      const target = source === 'ui-consent' ? consent.item : needsUi;
      const notice = pluginUiApprovalNotice(target, state, c, key => key, true);
      if (source === 'unsupported') {
        expect(notice).toBeUndefined();
        // The explicit settings view retains its existing update-Host explanation.
        expect(pluginUiApprovalNotice(target, state, c, key => key)?.detail).toBe('plugins.uiApproval.updateHost');
      } else expect(notice?.actions).toHaveLength(2);
    },
  );
});

// R7: display refreshes must not erase full facts used by begin/answer guards.
// Unit: real controller/client, delayed full read and actual lightweight response.
it.each(['begin', 'answer'] as const)('keeps full authorization facts when a hint wins during %s', async stage => {
  vi.useFakeTimers();
  const pending = deferred<unknown>(); let fullReads = 0;
  const h = host(() => stage === 'answer' ? confirmation() : receipt('succeeded'));
  h.setFacts({ ...snapshot(), uiCapabilityApproval: true });
  const item = { instanceKey: plugin.instanceKey, name: plugin.manifest.name,
    approvalToken: 'approved:12345678-1234-4123-8123-123456789abc' };
  const invoke: PluginManagementInvoke = async (id, channel, args, opts) => {
    opts?.preSend?.();
    const action = (args?.[0] as Envelope)?.actionId;
    if (channel.endsWith(':manifest')) return { collections: [{ id: 'plugins', actions: [
      { id: 'management:snapshot' }, { id: 'management:ui-consent' },
    ] }] } as never;
    if (action === 'management:ui-consent') return { result: { version: 1, uiCapabilityApproval: true, item } } as never;
    if (action === 'management:snapshot' && ++fullReads === (stage === 'begin' ? 1 : 2)) return await pending.promise as never;
    return h.invoke(id, channel, args, opts);
  };
  const reads = createPluginPromptReads(invoke, () => true);
  const c = createPluginManagementController(createPluginManagementClient({ deviceId: 'host-1', invoke }), {
    readDisplay: () => reads.read('host-1'), createOperationId: () => 'operation-1',
  });
  controllers.push(c); await c.refresh();
  if (stage === 'answer') await c.approveUiFromConsent(item);
  const operation = stage === 'begin' ? c.approveUiFromConsent(item) : c.answer(true);
  await vi.advanceTimersByTimeAsync(0);
  reads.invalidate('host-1', {}); const refreshed = c.refresh();
  await vi.advanceTimersByTimeAsync(250); await refreshed;
  expect(c.getState().snapshot).toBeNull();
  pending.resolve({ result: { ...snapshot(), uiCapabilityApproval: true } });
  await operation;
  expect(h.requests.filter(r => r.actionId === `management:${stage}`)).toHaveLength(1);
  expect(c.getState().errorCode).toBeNull();
});

// Public projection / unit: new source is optional and must not extend the old
// four-value trust enum; future source values remain an exception warning.
it.each([
  [{ kind: 'market' }, undefined],
  [{ kind: 'local' }, 'mcpApps.source.local'],
  [{ kind: 'third-party' }, 'mcpApps.source.third-party'],
  [{ kind: 'future' }, 'mcpApps.source.unknown'],
  [undefined, 'mcpApps.source.unknown'],
])('presents installation source independently of the legacy confirmation trust (%j)', (installationSource, warning) => {
  const input = { ...confirmation(), consent: { ...confirmation().consent, trust: 'unverified', ...(installationSource ? { installationSource } : {}) } };
  const consent = parsePluginManagementReceipt(input, 'operation-1').consent!;
  expect(pluginConsentPresentation(consent, key => key).trust).toBe(warning);
  expect(consent.trust).toBe('unverified');
  expect(() => parsePluginManagementReceipt({ ...input, consent: { ...input.consent, trust: 'local' } }, 'operation-1')).toThrow('INVALID_RESPONSE');
});

/* 测试价值（PR 评审：确认面板来源文案与高风险摘要，2026-11-25）
 * - 生产入口与可观察结果：pluginConsentPresentation（两端确认面板共用）与 parsePluginManagementReceipt 的输出文字。
 * - 依据：维护者要求渠道统一为电脑端口径、高风险权限在确认前可见；电脑端 ghostInstallConsentSourceLabel /
 *   ghostInstallSourceNoticeKey；ghostPermissionItems 只有 node:execute 的说明自标「高风险」。
 * - 缺口：此前只测 trust 行；没有覆盖来源行、来源说明、高风险的判断口径和升级只看新增。
 * - 最小失败输入：社区插件被写成「官方市场」；Node 权限混在列表里没有固定摘要；node:secret 被当作高风险。
 * - tier: unit。
 */
describe('confirmation sheet wording', () => {
  // Interpolating stand-in for i18next, so names and devices are visible in assertions.
  const t = (key: string, args?: Record<string, unknown>) => {
    const values = Object.entries(args ?? {}).filter(([name]) => name !== 'defaultValue').map(([name, value]) => `${name}=${String(value)}`);
    return values.length ? `${key}(${values.join(',')})` : key;
  };
  const item = (key: string, kind: string, labelKey: string, detailKey?: string) => ({ key, kind, labelKey, ...(detailKey ? { detailKey } : {}) });
  const nodeExecute = (labelKey = 'nodeRuntime') => item('node:execute', 'node', labelKey, 'nodeRuntimeDetail');
  const install = (consent: Record<string, unknown>, permissions: any[]) => ({ requestId: 'r', initiator: 'user', origin: 'market',
    ...consent, facts: { kind: 'install', ghostId: 'demo', name: 'Demo', version: '1', permissions } }) as any;

  // Contract V2.4b (2026-11-25, #12731 00b3c1a6): a source switch is confirmed like a first install with the new source's
  // full permissions, and only `originSourceChanged` marks it, whatever the origin. An explicit replacement with the
  // plugin market's version comes as origin 'market' without a source; the phone cannot start one, but shows it like
  // the computer: every permission and every high-risk item, the market sentence, no repository line, and Allow.
  it('shows a source switch like a first install, with the sentence for its origin', () => {
    const permissions = [nodeExecute(), item('agent:background', 'agent', 'agentBackground'), item('tool:open', 'tool', 'tool')];
    const market = pluginConsentPresentation(install({ originSourceChanged: true }, permissions), t, 'Mac');
    expect(market.originSourceChanged).toBe('plugins.notice.consentSource.marketSourceChanged');
    expect(market.repository).toBeUndefined();
    expect(market.allowBlocked).toBe(false);
    // An update of the plugin already there: the computer name, not "install to".
    expect(market.device).toBe('Mac');
    expect(market.permissions).toHaveLength(3);
    expect(market.highRisk?.lines).toHaveLength(2);
    // A custom market names the repository it shows (#12731 e2fbe72a): only a Git source asks to trust "the repository
    // shown above"; a local folder, or no usable source, gets the sentence without it.
    const git = { kind: 'git', repository: 'github.com/acme/plugins', sourceId: 'SourceB_0123456789abcd' };
    const custom = pluginConsentPresentation(install({ origin: 'custom-market', originLabel: 'Team', originSource: git, originSourceChanged: true }, permissions), t, 'Mac');
    expect(custom.originSourceChanged).toBe('plugins.notice.consentSource.originSourceChanged');
    expect(custom).toMatchObject({ allowBlocked: false, device: 'Mac' });
    expect(custom.highRisk?.lines).toHaveLength(2);
    const folder = pluginConsentPresentation(install({ origin: 'custom-market', originLabel: 'Team',
      originSource: { kind: 'local', sourceId: 'SourceB_0123456789abcd' }, originSourceChanged: true }, permissions), t, 'Mac');
    expect(folder).toMatchObject({ originSourceChanged: 'plugins.notice.consentSource.sourceChangedIsolated', allowBlocked: false });
    // The relaxed check does not relax the custom-market rule: without a source only Reject stays available.
    const sourceless = pluginConsentPresentation(install({ origin: 'custom-market', originLabel: 'Team', originSourceChanged: true }, permissions), t, 'Mac');
    expect(sourceless).toMatchObject({ originSourceChanged: 'plugins.notice.consentSource.sourceChangedIsolated', allowBlocked: true });
    // Other origins have no switch sentence, like the computer.
    expect(pluginConsentPresentation(install({ origin: 'local-file', originSourceChanged: true }, permissions), t, 'Mac').originSourceChanged).toBeUndefined();
    // A plain first install still says where it goes.
    expect(pluginConsentPresentation(install({}, permissions), t, 'Mac').device).toBe('plugins.market.installTo(device=Mac)');
  });
  it('pins the Host items it treats as high risk, by their stable keys', () => {
    for (const key of ['node:execute', 'node:secret:token:worker.cjs:run', 'node:resident', 'agent:background', 'agent:errand'])
      expect(isPinnedHighRiskPermission({ key })).toBe(true);
    // Lower-risk items share kinds with them; the kind alone must not decide.
    for (const key of ['node:child-spawn', 'agent:user-action', 'agent:tasks', 'harnesses', 'fs', 'notify', 'code'])
      expect(isPinnedHighRiskPermission({ key })).toBe(false);
    const secret = { ...item('node:secret:token:worker.cjs:run', 'node', 'nodeSecret', 'nodeSecretDetail'), labelArgs: { name: 'API token' }, detail: 'run' };
    const view = pluginConsentPresentation(install({}, [item('notify', 'notify', 'notify', 'notifyDetail'), secret, nodeExecute('nodeMcp')]), t, 'Mac');
    // Pinned above the buttons: a heading and one short line per high-risk class, in the Host's order.
    expect(view.highRisk).toEqual({ title: 'plugins.management.highRiskTitle',
      lines: ['plugins.management.permissions.nodeMcp', 'plugins.management.permissions.nodeSecretOne'] });
    // The scrolled list keeps every full explanation (credential names and methods included), high-risk items first.
    expect(view.permissions.map((row) => [row.title, row.detail])).toEqual([
      ['plugins.management.permissions.nodeSecret(name=API token)', 'plugins.management.permissions.nodeSecretDetail\n\nrun'],
      ['plugins.management.permissions.nodeMcp', 'plugins.management.permissions.nodeRuntimeDetail'],
      ['plugins.management.permissions.notify', 'plugins.management.permissions.notifyDetail'],
    ]);
    expect(pluginConsentPresentation(install({}, [item('notify', 'notify', 'notify', 'notifyDetail')]), t).highRisk).toBeUndefined();
  });

  // Maintainer review (2026-11-25): an approved Node plugin whose update only adds a credential binding, and a
  // first install without Node that asks for Agent high-risk permissions, both had no summary above the buttons.
  // Maintainer review 03:10 #2: the Host allows 4 credential bindings with up to 16 methods each; the pinned area
  // must stay bounded while every credential name and method remains reachable in the scrolled list.
  it('keeps the pinned summary bounded for many credential bindings and methods', () => {
    const methods = Array.from({ length: 16 }, (_, index) => `method_${index}`);
    const bindings = Array.from({ length: 4 }, (_, index) => ({ ...item(`node:secret:token${index}:worker.cjs:${methods.join(',')}`,
      'node', 'nodeSecret', 'nodeSecretDetail'), labelArgs: { name: `Token ${index}` }, detail: methods.join('\n') }));
    const view = pluginConsentPresentation(install({}, [...bindings, item('node:resident', 'node', 'nodeResident', 'nodeResidentDetail'),
      nodeExecute(), item('agent:background', 'agent', 'agentBackground', 'agentBackgroundDetail'),
      item('agent:errand', 'agent', 'agentErrand', 'agentErrandDetail')]), t, 'Mac');
    expect(view.highRisk?.lines).toEqual(['plugins.management.permissions.nodeRuntime', 'plugins.management.permissions.nodeSecretCount(count=4)',
      'plugins.management.permissions.nodeResident', 'plugins.management.permissions.agentBackground', 'plugins.management.permissions.agentErrand']);
    expect(JSON.stringify(view.highRisk)).not.toMatch(/method_|Token \d/);
    const scrolled = view.permissions.map((row) => `${row.title}\n${row.detail}`).join('\n');
    for (let index = 0; index < 4; index++) expect(scrolled).toContain(`Token ${index}`);
    for (const method of methods) expect(scrolled.split(method).length - 1).toBeGreaterThanOrEqual(4);
  });
  // iOS layout re-check (3587f6ca, accessibility-large): the end of a credential line ("to the local Node program") was
  // cut. Every pinned line is now shown in full, and the credential lines name the receiver first.
  it('names the receiver first in the pinned credential lines', async () => {
    for (const locale of ['en', 'zh-CN'] as const) {
      const strings = (await import(`@/i18n/locales/${locale}/plugins.json`)).default.management.permissions;
      const receiver = locale === 'en' ? 'Local Node program' : '本机 Node 程序';
      expect(strings.nodeSecretOne.startsWith(receiver)).toBe(true);
      expect(strings.nodeSecretCount.startsWith(receiver)).toBe(true);
    }
  });
  // Layout re-checks (3587f6ca): the summary's bound must leave the identity block (name, computer, source,
  // repository, source notes), its heading and the buttons in view without scrolling. Matrix of measured heights
  // (dp/pt) for Chinese / English / German × default (914) and short (610) screens × normal and large text.
  it('bounds the pinned summary so the identity block and buttons always stay in view', () => {
    const chrome = 80;
    const cases = [
      // [case, available, identity, heading, actions]
      ['zh default normal', 777, 170, 20, 48], ['zh default large', 777, 230, 26, 60],
      ['zh short normal', 518, 170, 20, 48], ['zh short large', 518, 230, 26, 60],
      ['en default normal', 777, 190, 20, 48], ['en default large', 777, 300, 26, 60],
      ['en short normal', 518, 190, 20, 48], ['en short large', 518, 300, 26, 60],
      ['de default normal', 777, 210, 20, 48], ['de default large', 777, 330, 26, 60],
      ['de short normal', 518, 210, 20, 48], ['de short large', 518, 330, 26, 60],
    ] as const;
    for (const [name, available, identity, heading, actions] of cases) {
      const cap = pinnedHighRiskMaxHeight({ available, chrome, identity, heading, actions });
      expect(cap, name).toBeGreaterThanOrEqual(PINNED_HIGH_RISK_MIN_HEIGHT);
      // Whatever the summary takes, the identity block still fits above it, unless only the one-line floor is left.
      if (cap > PINNED_HIGH_RISK_MIN_HEIGHT) expect(available - chrome - heading - actions - cap, name).toBeGreaterThanOrEqual(identity);
    }
    // Before measuring: a conservative quarter of the sheet.
    expect(pinnedHighRiskMaxHeight({ available: 700, chrome, identity: 0, heading: 0, actions: 0 })).toBe(175);
  });
  it('orders the pinned classes the same way whatever order the package declares them in', () => {
    const resident = item('node:resident', 'node', 'nodeResident', 'nodeResidentDetail');
    const errand = item('agent:errand', 'agent', 'agentErrand', 'agentErrandDetail');
    const background = item('agent:background', 'agent', 'agentBackground', 'agentBackgroundDetail');
    const view = pluginConsentPresentation(install({}, [errand, resident, background, nodeExecute()]), t, 'Mac');
    expect(view.highRisk?.lines).toEqual(['plugins.management.permissions.nodeRuntime', 'plugins.management.permissions.nodeResident',
      'plugins.management.permissions.agentBackground', 'plugins.management.permissions.agentErrand']);
  });
  it('pins an update that only adds a credential binding to an approved Node plugin', () => {
    const secret = { ...item('node:secret:token:worker.cjs:run', 'node', 'nodeSecret', 'nodeSecretDetail'), labelArgs: { name: 'API token' }, detail: 'run' };
    const view = pluginConsentPresentation({ requestId: 'r', initiator: 'user', origin: 'market',
      facts: { kind: 'update', ghostId: 'demo', name: 'Demo', version: '2', previousVersion: '1', added: [secret], removed: [],
        unchangedCount: 3, builtinOauthClientChanged: false } } as any, t, 'Mac');
    expect(view.highRisk).toEqual({ title: 'plugins.management.highRiskTitle', lines: ['plugins.management.permissions.nodeSecretOne'] });
    expect(view.permissions[0]).toEqual({ title: 'plugins.management.permissions.added · plugins.management.permissions.nodeSecret(name=API token)',
      detail: 'plugins.management.permissions.nodeSecretDetail\n\nrun' });
  });
  // Maintainer review 04:09: the Host accepts binding names up to 64 characters, line breaks included. Interpolated
  // into the two-line summary, a long name pushed "to the local Node program" out of view while Allow stayed enabled.
  it('keeps the package-declared name out of the pinned line for an update that adds one binding with a long name', () => {
    const name = 'Production deployment token\nfor the shared release pipeline\n(rotated every Monday)';
    const secret = { ...item('node:secret:deploy:worker.cjs:publish', 'node', 'nodeSecret', 'nodeSecretDetail'), labelArgs: { name }, detail: 'publish' };
    const view = pluginConsentPresentation({ requestId: 'r', initiator: 'user', origin: 'market',
      facts: { kind: 'update', ghostId: 'demo', name: 'Demo', version: '2', previousVersion: '1', added: [secret], removed: [],
        unchangedCount: 3, builtinOauthClientChanged: false } } as any, t, 'Mac');
    expect(view.highRisk?.lines).toEqual(['plugins.management.permissions.nodeSecretOne']);
    expect(JSON.stringify(view.highRisk)).not.toContain('Production');
    // The full name and its method stay in the scrolled list.
    expect(view.permissions[0].title).toContain(name);
    expect(view.permissions[0].detail).toContain('publish');
  });
  it('pins Agent high-risk permissions in a first install without Node', () => {
    const view = pluginConsentPresentation(install({}, [item('agent:errand', 'agent', 'agentErrand', 'agentErrandDetail'),
      item('agent:background', 'agent', 'agentBackground', 'agentBackgroundDetail'), item('agent:user-action', 'agent', 'agentUserAction', 'agentUserActionDetail')]), t, 'Mac');
    expect(view.highRisk?.lines).toEqual(['plugins.management.permissions.agentBackground', 'plugins.management.permissions.agentErrand']);
    expect(view.permissions[2]).toEqual({ title: 'plugins.management.permissions.agentUserAction', detail: 'plugins.management.permissions.agentUserActionDetail' });
  });

  it('uses the computer\'s source line and source notices, and says which computer a new install goes to', () => {
    const official = pluginConsentPresentation(install({}, []), t, 'Mac');
    expect(official).toMatchObject({ device: 'plugins.market.installTo(device=Mac)', origin: 'plugins.notice.consentSource.market', sourceNotice: undefined });
    expect(pluginConsentPresentation(install({ communityMarket: true }, []), t)).toMatchObject({
      origin: 'plugins.notice.consentSource.market', sourceNotice: 'plugins.notice.sourceNotice.community' });
    expect(pluginConsentPresentation(install({ origin: 'custom-market', originLabel: 'Demo Git Market' }, []), t)).toMatchObject({
      origin: 'plugins.notice.consentSource.customMarket(name=Demo Git Market)', sourceNotice: 'plugins.notice.sourceNotice.customMarket' });
    expect(pluginConsentPresentation(install({ origin: 'custom-market' }, []), t).origin).toBe('plugins.notice.consentSource.customMarketUnnamed');
    expect(pluginConsentPresentation(install({ origin: 'local-file' }, []), t)).toMatchObject({
      origin: 'plugins.notice.consentSource.localFile', sourceNotice: 'plugins.notice.sourceNotice.localFile' });
    // A user-started install adds no initiator text; an Agent-started one wraps the source like the computer.
    expect(pluginConsentPresentation(install({ initiator: 'agent' }, []), t).origin)
      .toBe('plugins.notice.consentSource.initiatedByAgent(origin=plugins.notice.consentSource.market)');
    expect(pluginConsentPresentation(install({ purpose: 'ui-capability' }, []), t).origin)
      .toBe('plugins.notice.consentSource.market · plugins.uiApproval.purpose');
  });

  it('pins a high-risk item in an update only when the update adds it', () => {
    const update = (added: any[], removed: any[]) => ({ requestId: 'r', initiator: 'user', origin: 'market', communityMarket: true,
      facts: { kind: 'update', ghostId: 'demo', name: 'Demo', version: '2', previousVersion: '1', added, removed,
        unchangedCount: 2, builtinOauthClientChanged: false } }) as any;
    const adds = pluginConsentPresentation(update([item('notify', 'notify', 'notify'), nodeExecute()], []), t, 'Mac');
    expect(adds).toMatchObject({ device: 'Mac', sourceNotice: undefined,
      highRisk: { title: 'plugins.management.highRiskTitle', lines: ['plugins.management.permissions.nodeRuntime'] } });
    expect(adds.permissions[0].title).toBe('plugins.management.permissions.added · plugins.management.permissions.nodeRuntime');
    const removes = pluginConsentPresentation(update([item('notify', 'notify', 'notify')], [nodeExecute()]), t, 'Mac');
    expect(removes.highRisk).toBeUndefined();
    expect(removes.permissions[1]).toEqual({ title: 'plugins.management.permissions.removed · plugins.management.permissions.nodeRuntime',
      detail: 'plugins.management.permissions.nodeRuntimeDetail' });
  });

  // PR #12684 maintainer review: a custom-market install names the Host-generated repository next to the computer.
  it('names the repository of a custom-market install right under the computer line', () => {
    const custom = (originSource?: unknown) => install({ origin: 'custom-market', originLabel: 'Acme',
      ...(originSource ? { originSource } : {}) }, []);
    expect(pluginConsentPresentation(custom({ kind: 'git', repository: 'github.com/acme/plugins' }), t, 'Mac'))
      .toMatchObject({ device: 'plugins.market.installTo(device=Mac)', repository: 'plugins.notice.consentSource.repository(repository=github.com/acme/plugins)' });
    expect(pluginConsentPresentation(custom({ kind: 'git', repository: 'github.com/acme/plugins', ref: 'main' }), t).repository)
      .toBe('plugins.notice.consentSource.repositoryRef(repository=github.com/acme/plugins,ref=main)');
    expect(pluginConsentPresentation(custom({ kind: 'local' }), t).repository).toBe('plugins.notice.consentSource.localFolder');
    // Market installs never show a repository line, even if a Host sent one.
    expect(pluginConsentPresentation(install({ originSource: { kind: 'git', repository: 'github.com/acme/plugins' } }, []), t).repository).toBeUndefined();
  });
  // Maintainer review 05:55 #3 (contract #12731): a custom-market consent without a source is not allowed on the
  // phone, install or update; the line says how to continue on the computer.
  it('blocks Allow for a custom-market install or update without a source, and for another source than the one chosen', () => {
    const named = install({ origin: 'custom-market', originLabel: 'Acme', originSource: { kind: 'git', repository: 'github.com/acme/plugins' } }, []);
    const unnamed = install({ origin: 'custom-market', originLabel: 'Acme' }, []);
    const update = { ...unnamed, facts: { kind: 'update', ghostId: 'demo', name: 'Demo', version: '2', previousVersion: '1', added: [],
      removed: [], unchangedCount: 0, builtinOauthClientChanged: false } };
    expect(pluginConsentPresentation(unnamed, t, 'Mac')).toMatchObject({ allowBlocked: true,
      repository: 'plugins.notice.consentSource.repositoryMissingInstall' });
    expect(pluginConsentPresentation(update, t, 'Mac')).toMatchObject({ allowBlocked: true,
      repository: 'plugins.notice.consentSource.repositoryMissingUpdate' });
    expect(pluginConsentPresentation(named, t, 'Mac').allowBlocked).toBe(false);
    // Maintainer review 05:55 #2: compared with the full identity chosen on the phone, sourceId included.
    const chosen = { kind: 'git' as const, repository: 'github.com/acme/plugins', sourceId: 'SourceA_0123456789abcd' };
    const consented = (sourceId: string) => install({ origin: 'custom-market', originLabel: 'Acme', originSource: { ...chosen, sourceId } }, []);
    expect(pluginConsentPresentation(consented(chosen.sourceId), t, 'Mac', chosen)).toMatchObject({ allowBlocked: false, sourceChanged: undefined });
    expect(pluginConsentPresentation(consented('SourceB_0123456789abcd'), t, 'Mac', chosen))
      .toMatchObject({ allowBlocked: true, sourceChanged: 'plugins.notice.consentSource.sourceChanged' });
    // Official and community market installs carry no repository and are never blocked by its absence.
    expect(pluginConsentPresentation(install({}, []), t, 'Mac')).toMatchObject({ allowBlocked: false, repository: undefined });
  });
  // Contract v2: git { kind, repository, ref?, sourceId } or local { kind, sourceId }; sourceId is 22 base64url chars.
  it('accepts only a credential-free source identity from the Host', () => {
    const id = 'AbCdEfGhIjKlMnOpQr_-12';
    const receipt = (originSource: unknown) => ({ operationId: 'op', phase: 'confirmation', consent: { requestId: 'r', initiator: 'user',
      origin: 'custom-market', originLabel: 'Acme', originSource, facts: { kind: 'install', ghostId: 'demo', name: 'Demo', version: '1', permissions: [] } } });
    for (const value of [{ kind: 'local', sourceId: id }, { kind: 'git', repository: 'github.com/acme/plugins', sourceId: id },
      { kind: 'git', repository: 'gitlab.example.com/g/s/plugins', ref: 'v1.2', sourceId: id }])
      expect(parsePluginManagementReceipt(receipt(value), 'op').consent?.originSource).toEqual(value);
    for (const value of [{ kind: 'git', repository: 'https://ghp_x@github.com/acme/plugins', sourceId: id },
      { kind: 'git', repository: 'github.com/acme', sourceId: id }, { kind: 'git', repository: 'github.com/acme/plugins?token=x', sourceId: id },
      { kind: 'local', sourceId: id, path: '/Users/me/market' }, { kind: 'git', repository: 'github.com/a/b', sourceId: id, url: 'x' },
      { kind: 'git', repository: 'github.com/acme/plugins', ref: '--upload-pack=x', sourceId: id },
      // sourceId is required and has a fixed shape (first-edition objects without it are rejected).
      { kind: 'git', repository: 'github.com/acme/plugins' }, { kind: 'local' }, { kind: 'local', sourceId: 'short' },
      { kind: 'local', sourceId: id + '=' }, 'github.com/acme/plugins'])
      expect(() => parsePluginManagementReceipt(receipt(value), 'op')).toThrow('INVALID_RESPONSE');
    // A page item with an unusable identity or installedSourceId keeps the item but drops the field (checks then fail closed).
    const item = (extra: Record<string, unknown>) => parsePluginMarketPage({ items: [{ ...detail, installState: 'not-installed', enabled: null,
      sourceType: 'git-market', sourceMarketName: 'Acme', ...extra }] }).items[0]!;
    expect(item({ sourceIdentity: { kind: 'git', repository: 'https://u:p@github.com/a/b', sourceId: id } })).not.toHaveProperty('sourceIdentity');
    expect(item({ sourceIdentity: { kind: 'git', repository: 'github.com/a/b', sourceId: id } }).sourceIdentity)
      .toEqual({ kind: 'git', repository: 'github.com/a/b', sourceId: id });
    expect(item({ installedSourceId: 'not-an-id' })).not.toHaveProperty('installedSourceId');
    expect(item({ installedSourceId: id }).installedSourceId).toBe(id);
  });
  // Contract V2.9: installedOperationId matches ^[A-Za-z0-9_-]{8,128}$ (on page items, server items included, and on
  // the market detail); any other value counts as absent, so a lost-receipt result stays unconfirmed.
  it('keeps only a well-formed installed operation id from the Host', () => {
    const uuid = '12345678-1234-4123-8123-123456789abc';
    const item = (extra: Record<string, unknown>) => parsePluginMarketPage({ items: [{ ...detail, installState: 'installed', enabled: true, ...extra }] }).items[0]!;
    expect(item({ installedOperationId: uuid }).installedOperationId).toBe(uuid);
    expect(item({ installedOperationId: 'a'.repeat(128) }).installedOperationId).toBe('a'.repeat(128));
    for (const value of ['short7!', 'abcdefg', 'a'.repeat(129), 'has space ok', 'semi;colon', 12345678, null])
      expect(item({ installedOperationId: value })).not.toHaveProperty('installedOperationId');
    expect(parsePluginManagementDetail({ ...detail, installState: 'installed', installedOperationId: uuid }).installedOperationId).toBe(uuid);
    expect(parsePluginManagementDetail({ ...detail, installState: 'installed', installedOperationId: 'bad id' })).not.toHaveProperty('installedOperationId');
  });
  // Maintainer review 04:44 #1: every local folder used to compare equal; two folders now differ by sourceId.
  it('compares source identities on every key, sourceId included', () => {
    const a = 'SourceA_0123456789abcd', b = 'SourceB_0123456789abcd';
    expect(samePluginMarketSourceIdentity({ kind: 'local', sourceId: a }, { kind: 'local', sourceId: a })).toBe(true);
    expect(samePluginMarketSourceIdentity({ kind: 'local', sourceId: a }, { kind: 'local', sourceId: b })).toBe(false);
    const git = { kind: 'git' as const, repository: 'github.com/acme/plugins', sourceId: a };
    expect(samePluginMarketSourceIdentity(git, { ...git })).toBe(true);
    expect(samePluginMarketSourceIdentity(git, { ...git, sourceId: b })).toBe(false);
    expect(samePluginMarketSourceIdentity(git, { ...git, ref: 'main' })).toBe(false);
    expect(samePluginMarketSourceIdentity(git, undefined)).toBe(false);
  });
  // Contract V2.4b: a custom-market update from another (verifiable) source than the installed instance carries
  // originSourceChanged (older builds of #12731 sent it on update facts, current ones on install facts); the phone says so next to the repository, like the computer's dialog.
  it('says when a custom-market update comes from another source than the installed version', () => {
    const id = 'SourceA_0123456789abcd';
    const receipt = (originSourceChanged: unknown, kind = 'update') => ({ operationId: 'op', phase: 'confirmation', consent: {
      requestId: 'r', initiator: 'user', origin: 'custom-market', originLabel: 'Acme', originSource: { kind: 'local', sourceId: id },
      ...(originSourceChanged === undefined ? {} : { originSourceChanged }),
      facts: kind === 'update' ? { kind: 'update', ghostId: 'demo', name: 'Demo', version: '2', previousVersion: '1', added: [], removed: [],
        unchangedCount: 1, builtinOauthClientChanged: false } : { kind: 'install', ghostId: 'demo', name: 'Demo', version: '1', permissions: [] } } });
    const consent = parsePluginManagementReceipt(receipt(true), 'op').consent!;
    expect(consent.originSourceChanged).toBe(true);
    // This consent's source is a local folder: no repository is shown, so the sentence without it (#12731 e2fbe72a).
    expect(pluginConsentPresentation(consent, t, 'Mac').originSourceChanged).toBe('plugins.notice.consentSource.sourceChangedIsolated');
    expect(pluginConsentPresentation(parsePluginManagementReceipt(receipt(undefined), 'op').consent!, t, 'Mac').originSourceChanged).toBeUndefined();
    // Contract V2.4b (2026-11-25 update): a source switch is confirmed like a first install (full permissions of the
    // new source, facts.kind 'install'); the sentence shows there too. Any other value makes the receipt invalid.
    expect(pluginConsentPresentation(parsePluginManagementReceipt(receipt(true, 'install'), 'op').consent!, t, 'Mac').originSourceChanged)
      .toBe('plugins.notice.consentSource.sourceChangedIsolated');
    for (const value of [false, 'true', 1]) expect(() => parsePluginManagementReceipt(receipt(value), 'op')).toThrow('INVALID_RESPONSE');
  });
  it('accepts the community flag only as true', () => {
    const receipt = (communityMarket: unknown) => ({ operationId: 'op', phase: 'confirmation', consent: { requestId: 'r', initiator: 'user',
      origin: 'market', ...(communityMarket === undefined ? {} : { communityMarket }), facts: { kind: 'install', ghostId: 'demo', name: 'Demo', version: '1', permissions: [] } } });
    expect(parsePluginManagementReceipt(receipt(true), 'op').consent?.communityMarket).toBe(true);
    expect(parsePluginManagementReceipt(receipt(undefined), 'op').consent?.communityMarket).toBeUndefined();
    for (const value of ['true', 1, false, null]) expect(() => parsePluginManagementReceipt(receipt(value), 'op')).toThrow('INVALID_RESPONSE');
  });
});
