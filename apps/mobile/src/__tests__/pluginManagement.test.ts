// @vitest-environment jsdom
import { CONSENT_FADE_HEIGHT, consentSummaryFadeAllowed, isPinnedHighRiskPermission, PINNED_HIGH_RISK_MIN_HEIGHT, planConsentSheet, pluginConsentPresentation } from '@/plugins/pluginConsentPresentation';
import { DeviceLinkError, sharedTaskHostPeer, providerShareHostPeer } from '@cindy/device-link';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent, setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { createPluginManagementClient, type PluginManagementInvoke } from '@/plugins/pluginManagementClient';
import { createPluginPromptReads } from '@/plugins/pluginPromptReads';
import { pluginUiApprovalNotice } from '@/plugins/pluginUiApprovalNotice';
import { PluginPromptReadsProvider, usePluginPromptReads } from '@/plugins/PluginPromptReadsContext';
import { createPluginManagementController, nextDetachedStep } from '@/plugins/pluginManagementController';
import { invokeSendEvidence } from '@/device-link/invokeSendEvidence';
import { pluginOperationOpens } from '@/plugins/pluginOperationOpens';
import { CONTRACT_SAMPLE_OPERATION_ID, CONTRACT_SAMPLES, HOST_INSTALL_SITUATIONS, hostInstallFacts, secondShapes, type HostInstallSituation } from './hostPluginInstallFacts';
import { declaredPluginConsent, declaredTaskCardConsent, pluginConsentAllowance } from '@/plugins/pluginConsentAllowance';
import { isBoundedPluginResponse, parsePluginManagementDetail, parsePluginManagementReceipt,
  parsePluginManagementSnapshot, marketItemMatchesPlugin, pluginNeedsUiApproval, type ManagedPlugin,
  parsePluginUiConsent, samePluginMarketSourceIdentity, isPluginMarketSourceIdentity, type ManagedMarketDetail, type PluginManagementReceipt, type PluginManagementSnapshot } from '@/plugins/pluginManagementTypes';
import { createPluginManagementSlot, pluginManagementSlotFor, pluginOperationHold } from '@/plugins/pluginManagementSlot';
import { parsePluginMarketPage, pluginMarketFacts, pluginMarketIconUri, pluginMarketShowsCommunityNotice, pluginMarketSourceUnverified,
  pluginMarketSubtitle } from '@/plugins/pluginMarketCatalog';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
/** The computer a test's slot belongs to (one slot per account and computer). */
const SLOT_WHO = { name: 'Demo', deviceId: 'host-1', deviceName: 'Host' };
/**
 * The leave-cancel as the product reaches it: only for the consent the confirmation sheet put on screen (dispatcher
 * L-2), so a test of the cancel's own mechanics first shows that consent, as the sheet does.
 */
function shownCancel(c: { getState(): { receipt: { consent?: { requestId: string } } | null }; markConsentShown(id: string): void; cancel(): Promise<void> }) {
  const requestId = c.getState().receipt?.consent?.requestId;
  if (requestId) c.markConsentShown(requestId);
  return c.cancel();
}

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
/**
 * The consent the Host asks for when this file's usual operation (updating `plugin` 1 → 2 to `detail`) stops at one: an
 * update's facts (dispatcher O-4: a consent may be allowed only when it declares what was chosen).
 */
const confirmation = (): PluginManagementReceipt => ({ ...receipt('confirmation'), consent: { requestId: 'consent-1',
  initiator: 'user', origin: 'market', facts: { kind: 'update', ghostId: 'demo', name: 'Demo', version: '2', previousVersion: '1',
    added: [], removed: [], unchangedCount: 0, builtinOauthClientChanged: false } } });
/** A page approval's consent for `plugin` as the computer asks it (its installed version, purpose ui-capability). */
const uiConfirmation = (): PluginManagementReceipt => ({ ...receipt('confirmation'), consent: { requestId: 'consent-1',
  initiator: 'user', origin: 'local-file', purpose: 'ui-capability', facts: { kind: 'update', ghostId: 'demo', name: 'Demo',
    version: '1', previousVersion: '1', added: [], removed: [], unchangedCount: 0, builtinOauthClientChanged: false } } });
const capability = { protocolVersion: 1, collections: [{ id: 'plugins', actions: [{ id: 'management:snapshot', label: 'Manage' }] }] };
/** Like vi.waitFor, without its 50 ms polling: retries the assertion while promises settle (file performance budget). */
async function eventually(assertion: () => void) {
  let last: unknown;
  for (let i = 0; i < 400; i++) {
    try { assertion(); return; } catch (error) { last = error; }
    await (i < 300 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, 0)));
  }
  throw last;
}
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
type Envelope = { actionId: string; input: Record<string, unknown>; resourceRef?: { id: string } };
function host(handler?: (request: Envelope) => unknown | Promise<unknown>, marketDetail: ManagedMarketDetail = detail) {
  const requests: Envelope[] = [];
  let facts = snapshot();
  const invoke = vi.fn(async (_id: string, channel: string, args?: unknown[], options?: { preSend?: () => void; onRequestWritten?: () => void; onNotSent?: () => void }) => {
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
  // Unit: the mobile reader has no package size field in its model and accepts it from a newer Host.
  it('continues reading snapshots and details with additional package metadata', () => {
    const extended = { ...detail, sizeBytes: 1200 };
    const value = snapshot();
    expect(parsePluginManagementSnapshot({ ...value, market: { ...value.market, items: [extended] } })
      .market.items[0]).toMatchObject(detail);
    expect(parsePluginManagementDetail(extended)).toMatchObject(detail);
  });
  // Merge check after main 5fd5f542c0: the other optional fields a newer Host now sends (sortValue on catalog items,
  // release updates on the detail, sizeBytes everywhere) do not make the strict reader reject the whole response;
  // the source identity keeps its strict key check. Same shapes as apps/desktop/src/shared/pluginMarket.ts. Unit.
  it('accepts catalog pages and details carrying the newer optional market fields', () => {
    const id = 'DemoGitMarketSource001';
    const updates = [{ version: '2', publishedAt: '2026-11-20T08:00:00.000Z', releaseNotes: 'Faster sync' },
      { version: '1', publishedAt: '2026-10-01T08:00:00.000Z', releaseNotes: '' }];
    expect(parsePluginManagementDetail({ ...detail, sizeBytes: 1200, sortValue: 42, updates })).toMatchObject(detail);
    const page = parsePluginMarketPage({ items: [{ ...detail, sizeBytes: 1200, sortValue: 'trending' }], nextCursor: null });
    expect(page.items[0]).toMatchObject({ pluginId: detail.pluginId, releaseId: detail.releaseId });
    const custom = parsePluginMarketPage({ items: [{ ...detail, sourceType: 'git-market', sourceMarketName: 'Acme', sizeBytes: 1,
      sourceIdentity: { kind: 'git', repository: 'github.com/a/b', sourceId: id, sizeBytes: 1 } }] }).items[0]!;
    expect(custom).not.toHaveProperty('sourceIdentity');
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
    // Dispatcher N-1: a transport that reports neither a write nor a refusal says nothing: possibly written, so a
    // lost begin is looked up, never shown as "failed, try again" (which would invite a second begin).
    ['failed with no evidence either way (a transport that reports nothing)', 'silent', true],
    ['written, then the reply was lost (in flight)', 'lost', true],
    ['written, then refused at a later check (a resend after the first write)', 'resend', true],
  ] as const)('classifies a write %s', async (_name, end, unknown) => {
    let active = true;
    const invoke = vi.fn(async (_d, _c, _a, opts) => {
      if (end === 'entry') active = false;
      opts!.preSend!();
      // As DeviceLinkContext.invoke reports them: link recovery that failed, the client's own "never written" mark.
      if (end === 'handshake') { opts!.onNotSent!(); throw handshakeTimeout(); }
      if (end === 'silent') throw new Error('transport failed');
      if (end === 'dequeue') active = false;
      opts!.preSend!();
      if (end === 'expired') { const error = new DeviceLinkError('BACKPRESSURE', 'expired before socket write'); error.inFlight = false; opts!.onNotSent!(); throw error; }
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
    const handshake = vi.fn(async (_d, _c, _a, opts) => { opts!.preSend!(); opts!.onNotSent!(); throw handshakeTimeout(); }) as PluginManagementInvoke;
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
    const invoke = vi.fn(async (_id: string, channel: string, args?: unknown[], options?: { preSend?: () => void; onRequestWritten?: () => void; onNotSent?: () => void }) => {
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
    await eventually(() => expect(c.getState()).toMatchObject({ busy: true, outcome: 'running', operationId: 'operation-1' }));
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
    const invoke = vi.fn(async (_id: string, channel: string, args?: unknown[], options?: { preSend?: () => void; onRequestWritten?: () => void; onNotSent?: () => void }) => {
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
      // A cancel is only ever sent for a consent shown and not answered (maintainer review 17:43), so its case starts there.
      if (request!.actionId === 'management:begin') return { effects: [], result: target === 'answer' || target === 'cancel' ? confirmation() : receipt('succeeded') };
      if (request!.actionId === 'management:cancel') return { effects: [], result: receipt('cancelled') };
      return { effects: [], result: receipt('succeeded') };
    }) as unknown as PluginManagementInvoke;
    const c = createPluginManagementController(createPluginManagementClient({ deviceId: 'host-1', invoke }),
      { createOperationId: () => 'operation-1', pollIntervalMs: 60_000 });
    controllers.push(c);
    // Every reply here settles through promises only (no timers: polling is 60 s away), so draining the microtask queue
    // is enough; a timer tick per step only cost time (file performance budget).
    const flush = async () => { for (let i = 0; i < 200; i++) await Promise.resolve(); };
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
      // Never written: the computer still shows the consent, and that is what a lookup returns.
      const r = rig('cancel', () => confirmation());
      await r.c.refresh(); await r.c.uninstall(plugin);
      expect(r.c.getState().outcome).toBe('confirmation');
      r.hold(true);
      void shownCancel(r.c);
      await r.flush();
      await r.run(order);
      expect(r.count('cancel')).toBe(0);
      // Never written: the consent stays as the computer shows it (the one cancel is spent; nothing is sent again).
      expect(r.c.getState()).toMatchObject({ outcome: 'confirmation', busy: false });
      expect(r.c.cancelPhase()).toBe('over');
    });
    it.each(writtenOrders.map((o) => [o.join(' → '), o] as const))('written, reply lost: %s', async (_label, order) => {
      const r = rig('cancel', () => receipt('cancelled'));
      await r.c.refresh(); await r.c.uninstall(plugin);
      r.hold(true);
      void shownCancel(r.c);
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
// ④ once the Host's later phase was shown, the consent never shows again; ⑤ busy is never held with nothing in flight;
// ⑥ (dispatcher O-3) every request ends in exactly one class (answered, written, known not sent), and an unknown result
// only follows a written mutation.
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
    // ⑥ (dispatcher O-3) Each request ends in exactly one class: answered, written (then lost), or known not sent; the
    // two reports never both come and each at most once. The stand-in transport below sits behind the same decision
    // DeviceLinkContext.invoke makes (invokeSendEvidence), as production does.
    const ends: Array<{ action: string; written: number; notSent: number; answered: boolean; failed: boolean }> = [];
    const transport = (async (_id: string, channel: string, args?: unknown[], options?: { preSend?: () => void; onRequestWritten?: () => void }) => {
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
    });
    const invoke = (async (id: string, channel: string, args?: unknown[], options?: { preSend?: () => void; onRequestWritten?: () => void; onNotSent?: () => void }) => {
      const end = { action: (args?.[0] as Envelope | undefined)?.actionId ?? channel, written: 0, notSent: 0, answered: false, failed: false };
      ends.push(end);
      const evidence = invokeSendEvidence({
        onRequestWritten: () => { end.written += 1; options?.onRequestWritten?.(); },
        onNotSent: () => { end.notSent += 1; options?.onNotSent?.(); },
      });
      try {
        const result = await evidence.viaTransport(() => transport(id, channel, args, { preSend: options?.preSend, onRequestWritten: evidence.onRequestWritten }));
        end.answered = true;
        return result;
      } catch (error) { end.failed = true; evidence.failed(); throw error; }
    }) as unknown as PluginManagementInvoke;
    const c = createPluginManagementController(createPluginManagementClient({ deviceId: 'host-1', invoke }),
      { createOperationId: () => 'operation-1', pollIntervalMs: 3_600_000 });
    controllers.push(c);
    return { c, host, pending, ends, toggle: () => { connection += 1; }, connection: () => connection };
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
      for (const end of r.ends) {
        if (end.written > 1 || end.notSent > 1 || (end.written && end.notSent)) violation ??= `⑥ ${end.action} reported written ${end.written}, not sent ${end.notSent} (${step})`;
        if (end.failed && !end.answered && end.written + end.notSent !== 1) violation ??= `⑥ ${end.action} failed in no class (${step})`;
      }
      // An unknown result only after a mutation was handed to the transport and written.
      if (st.outcome === 'unknown' && !r.ends.some((end) => end.action !== 'management:operation' && end.written > 0))
        violation ??= `⑥ unknown with no mutation written (${step})`;
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
      else if (name === 'cancel') { cancels += 1; void shownCancel(r.c); }
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
    void shownCancel(r.c); await flush();                            // cancel queued (sent as an operation-scoped request)
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

// Maintainer review 13:02 (liveness): a late write receipt and a reconnect lookup overwrote each other and verification
// stopped (A: late begin consent after Allow already ran → unknown with no next poll; B: late begin `running` while a
// lookup held busy, then the lookup's `succeeded` dropped → stuck in progress); an answer written with its reply lost,
// after a later lookup still found the same consent, left both buttons disabled with nothing to tap or poll.
// Model check from begin in flight, against a stand-in Host that moves on by itself (accepted → consent → after an
// answer running → final). Events: going offline or online; each request's check before the write (in queue order,
// as on one link), its delivery or lost reply (any order); the Host moving on; a poll timer firing; Allow, Reject or
// Check result whenever tappable. States already seen are pruned, so deeper orders (about ten steps) are reached.
// After every step: ①–⑤ as above, plus ⑥ a non-final operation with nothing in flight on an online computer has a
// poll scheduled or a tappable consent; ⑦ the phase shown never goes back behind one the Host has reached and the
// phone has shown. At every leaf, ⑧ after releasing everything in flight and letting polls run (no taps), the phone
// shows the Host's real result. Minimal failing inputs: the two orders above and the stuck consent (ea3874b2).
// Tier: unit (in-memory Host, fake timers).
describe('progress only moves forward and never stops', () => {
  type Kind = 'begin' | 'answer' | 'operation' | 'cancel';
  type Item = { kind: Kind; seq: number; confirmed?: boolean; stage: 'queued' | 'written'; epoch: number; arrived: boolean;
    dequeue(): void; arrive(): void; deliver(): void; lose(): void; refuse(): void };
  const lostError = () => { const error = new DeviceLinkError('INVOKE_TIMEOUT', 'no reply after first socket write'); error.inFlight = true; return error; };
  const notFound = () => Object.assign(new Error('[NOT_FOUND] gone'), { code: 'NOT_FOUND' });
  const POLL = 1000;
  // `promptOnAccept`: the Host shows the consent before answering begin; `consent: false`: an operation without one.
  function rig(hostOptions: { promptOnAccept?: boolean; consent?: boolean; lookupInvalid?: boolean } = {}) {
    const host = { phase: 'none' as 'none' | 'accepted' | 'confirmation' | 'running' | 'succeeded' | 'cancelled', allowed: false, answersWritten: 0 };
    const hostReceipt = (): PluginManagementReceipt | null => host.phase === 'none' ? null
      : host.phase === 'confirmation' ? confirmation() : receipt(host.phase === 'accepted' ? 'running' : host.phase);
    const pending: Item[] = [], transit: Item[] = [];
    let connection = 0, seq = 0;
    // This replay's own timers (the controller's scheduler), so liveness never counts another path's poll.
    const timers: Array<{ run: () => void; delayMs: number }> = [];
    const scheduler = { set: (run: () => void, delayMs: number) => { const timer = { run, delayMs }; timers.push(timer); return timer; },
      clear: (handle: unknown) => { const index = timers.indexOf(handle as typeof timers[number]); if (index >= 0) timers.splice(index, 1); } };
    const sent = { lookups: 0, snapshots: 0 };
    // Every management request written, in order, and every request asked for (written or not).
    const writes: string[] = [], asked: string[] = [];
    // Consents the view put on screen, and the consent each cancel was asked for (⑫).
    const shown = new Set<string>(), cancelledConsents: Array<string | undefined> = [];
    const settle = (item: Item) => { const index = pending.indexOf(item); if (index >= 0) pending.splice(index, 1); };
    const invoke = (async (_id: string, channel: string, args?: unknown[], options?: { preSend?: () => void; onRequestWritten?: () => void; onNotSent?: () => void }) => {
      options?.preSend?.();
      const request = args?.[0] as Envelope | undefined;
      const action = request?.actionId?.replace('management:', '');
      if (!['begin', 'answer', 'operation', 'cancel'].includes(action ?? '')) {
        options?.preSend?.(); options?.onRequestWritten?.();
        if (channel.endsWith(':manifest')) return capability;
        if (action === 'snapshot') { sent.snapshots += 1; return { effects: [], result: snapshot() }; }
        if (action === 'market-detail') return { effects: [], result: detail };
        throw new Error('unexpected ' + action);
      }
      if (action === 'operation') sent.lookups += 1;
      if (action === 'cancel') cancelledConsents.push(c.getState().receipt?.consent?.requestId);
      asked.push(action!);
      return new Promise((resolve, reject) => {
        let reply: (() => void) | undefined;
        const item: Item = { kind: action as Kind, seq: ++seq, stage: 'queued', epoch: connection, arrived: false,
          confirmed: (request!.input as { confirmed?: boolean }).confirmed,
          dequeue: () => {
            try { options?.preSend?.(); } catch (error) { settle(item); reject(error); return; }
            options?.onRequestWritten?.();
            item.stage = 'written';
            writes.push(item.kind);
            if (item.kind === 'answer') host.answersWritten += 1;
            // Written; it reaches the Host later (it may still arrive after its reply was given up on).
            transit.push(item);
          },
          // The Host takes the request now and answers with its state at that moment.
          arrive: () => {
            transit.splice(transit.indexOf(item), 1);
            item.arrived = true;
            if (item.kind === 'begin' && host.phase === 'none') host.phase = hostOptions.promptOnAccept ? 'confirmation' : 'accepted';
            if (item.kind === 'answer' && host.phase === 'confirmation') { host.phase = 'running'; host.allowed = !!item.confirmed; }
            if (item.kind === 'cancel' && ['accepted', 'confirmation', 'running'].includes(host.phase)) host.phase = 'cancelled';
            const captured = hostReceipt();
            reply = () => {
              if (item.kind === 'operation' && hostOptions.lookupInvalid) resolve({ effects: [], result: { phase: 'nonsense' } });
              else if (captured) resolve({ effects: [], result: captured }); else reject(notFound());
            };
          },
          deliver: () => { settle(item); reply!(); },
          lose: () => { settle(item); reject(lostError()); },
          // Refused before its first write (the link said no): never written.
          refuse: () => { settle(item); options?.onNotSent?.(); reject(new Error('refused before the first write')); },
        };
        pending.push(item);
      });
    }) as unknown as PluginManagementInvoke;
    const c = createPluginManagementController(createPluginManagementClient({ deviceId: 'host-1', invoke }),
      { createOperationId: () => 'operation-1', pollIntervalMs: POLL, scheduler });
    controllers.push(c);
    // The page slot held for this operation, and its view: shown, or gone (driven as usePluginManagement does).
    const slot = createPluginManagementSlot();
    const token = slot.tryAcquire('update', SLOT_WHO)!;
    const hold = pluginOperationHold(slot, token);
    const view = { detached: false, gone: false, steps: [] as string[], lostCheck: false };
    let stopReview: (() => void) | undefined;
    const review = () => {
      if (!view.detached || view.gone) return;
      const next = nextDetachedStep(c);
      if (next === 'letGo') {
        view.gone = true; view.steps.push('letGo');
        // ⑪ evidence: what the controller still had when it was let go (a written, unsettled operation must not be).
        view.lostCheck = !!c.pendingCheck();
        stopReview?.(); c.dispose();
      }
      else if (next === 'cancel') { view.steps.push('cancel'); void c.cancel(); }
    };
    return { c, host, pending, transit, timers, sent, writes, asked, slot, token, hold, view, shown, cancelledConsents,
      consentless: hostOptions.consent === false, toggle: () => { connection += 1; }, connection: () => connection,
      leave: () => { view.detached = true; stopReview = c.subscribe(review); review(); },
      back: () => { view.detached = false; stopReview?.(); stopReview = undefined; },
      // Done with this replay: its controller and timers go before the next path starts.
      dispose: () => { stopReview?.(); c.dispose(); controllers.splice(controllers.indexOf(c), 1); timers.length = 0; } };
  }
  const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
  type R = ReturnType<typeof rig>;
  const finalOutcome = (o: string) => o === 'succeeded' || o === 'cancelled' || o === 'failed';
  const tappable = (r: R) => { const st = r.c.getState(); return st.outcome === 'confirmation' && st.online && !st.busy && !st.answerHeld; };
  async function step(r: R, event: string, counts: Record<string, number>) {
    const [name, at] = event.split('#');
    const item = at !== undefined ? [...r.pending, ...r.transit].find((entry) => entry.seq === Number(at)) : undefined;
    counts[name] = (counts[name] ?? 0) + 1;
    if (name === 'offline') { r.toggle(); r.c.setOnline(false); }
    else if (name === 'online') { r.toggle(); r.c.setOnline(true); }
    else if (name === 'allow' || name === 'reject') void r.c.answer(name === 'allow');
    else if (name === 'check' || name === 'recordCheck') void r.c.reconcile();
    else if (name === 'host') {
      if (r.host.phase === 'accepted') r.host.phase = r.consentless ? 'succeeded' : 'confirmation';
      else if (r.host.phase === 'running') r.host.phase = r.host.allowed ? 'succeeded' : 'cancelled';
    } else if (name === 'tick') r.timers.shift()?.run();
    else if (name === 'leave') r.leave();
    else if (name === 'return') r.back();
    else if (name === 'refuse') item!.refuse();
    else if (name === 'dequeue') item!.dequeue();
    else if (name === 'arrive') item!.arrive();
    else if (name === 'deliver') item!.deliver();
    else item!.lose();
    await flush();
    // A view on screen shows the consent it has (the sheet marks it); a view gone shows nothing.
    const consent = r.c.getState().receipt?.consent?.requestId;
    if (!r.view.detached && !r.view.gone && r.c.getState().outcome === 'confirmation' && consent) { r.c.markConsentShown(consent); r.shown.add(consent); }
  }
  function enabled(r: R, counts: Record<string, number>): string[] {
    const st = r.c.getState(), list: string[] = [];
    if (st.online && !counts.offline) list.push('offline');
    if (!st.online && !counts.online) list.push('online');
    // Taps need the view on screen.
    if (!r.view.detached && tappable(r) && (counts.allow ?? 0) + (counts.reject ?? 0) < 2) list.push('allow', 'reject');
    if (!r.view.detached && st.outcome === 'unknown' && st.online && !st.busy && !counts.check) list.push('check');
    // Maintainer review 20:45: "Check result" from the list of pending checks, the view gone (it may find a consent nobody
    // saw, for example after begin's reply was lost and the lookups stopped).
    if (r.view.detached && !r.view.gone && st.outcome === 'unknown' && st.online && !st.busy && !counts.recordCheck) list.push('recordCheck');
    if ((r.host.phase === 'accepted' || r.host.phase === 'running') && (counts.host ?? 0) < 3) list.push('host');
    if (r.timers.length > 0 && (counts.tick ?? 0) < 3) list.push('tick');
    const firstQueued = r.pending.find((entry) => entry.stage === 'queued');
    if (firstQueued) list.push(`dequeue#${firstQueued.seq}`);
    // Maintainer review 17:43: the view going away and coming back, and a cancel refused before its first write.
    // (Leaving once, between requests; coming back once, while nothing is in flight: the orders that matter, without
    // multiplying every interleaving.)
    if (!r.view.detached && !r.view.gone && !counts.leave && !firstQueued) list.push('leave');
    if (r.view.detached && !r.view.gone && !counts.return && r.pending.length === 0) list.push('return');
    if (firstQueued?.kind === 'cancel') list.push(`refuse#${firstQueued.seq}`);
    // Requests reach the Host in the order they were written; a reply comes only after that, a lost one any time.
    if (r.transit.length) list.push(`arrive#${r.transit[0].seq}`);
    for (const entry of r.pending) if (entry.stage === 'written') {
      if (entry.arrived) list.push(`deliver#${entry.seq}`);
      list.push(`lose#${entry.seq}`);
    }
    return list;
  }
  function check(r: R, shown: { rank: number }, path: string): string | null {
    const st = r.c.getState();
    // ⑩ One cancel at most, asked for and written; never after an answer was written; the slot never goes while a write
    // of this operation is still on its way, and is never left held by a controller that was let go.
    if (r.asked.filter((kind) => kind === 'cancel').length > 1) return `⑩ cancel asked for twice (${path})`;
    const firstAnswer = r.writes.indexOf('answer'), cancelAt = r.writes.indexOf('cancel');
    if (firstAnswer >= 0 && cancelAt > firstAnswer) return `⑩ cancel written after an answer (${path})`;
    // The computer's slot is this operation's alone here (its first token, or one it took back after waiting for a check).
    const slotHeld = !!r.slot.holder('host-1');
    if (!slotHeld && r.pending.some((entry) => entry.kind !== 'operation'))
      return `⑩ slot released with a ${r.pending.find((entry) => entry.kind !== 'operation')!.kind} in flight (${path})`;
    if (r.view.gone && slotHeld) return `⑩ slot held by a controller that was let go (${path})`;
    // ⑫ (maintainer review 20:45, dispatcher L-2) Nothing the list of pending checks or a gone view drives writes: a
    // cancel is only ever asked for a consent the view showed; an answer only comes from a tap on a view on screen.
    const unseen = r.cancelledConsents.find((id) => !id || !r.shown.has(id));
    if (r.cancelledConsents.length && unseen !== undefined) return `⑫ cancel of a consent never shown (${path})`;
    // ⑪ (maintainer review 18:45) An operation whose begin was written keeps a pending check until its final result,
    // whatever happens to its view or the connection (offline, leaving, lookups stopped, the receipt gone): it is never
    // let go before that. While the check waits for the person, the computer's slot is free; while the operation moves
    // on by itself, it holds the slot.
    if (r.view.lostCheck) return `⑪ a written operation was let go before its final result (${path})`;
    if (r.view.gone) return null;
    const check = r.c.pendingCheck();
    if (r.writes.includes('begin') && !finalOutcome(st.outcome) && !check) return `⑪ written and unsettled, but no pending check (${path})`;
    if (check?.waiting && slotHeld) return `⑪ slot kept by a result waiting to be checked (${path})`;
    if (check && !check.waiting && r.pending.length === 0 && !st.busy && !slotHeld)
      return `⑪ moving on by itself without its computer's slot (${path})`;
    if (tappable(r) && r.pending.some((entry) => entry.kind === 'answer')) return `① tappable while an answer is in flight (${path})`;
    if (r.host.answersWritten > 1) return `② ${r.host.answersWritten} answers written (${path})`;
    if (r.pending.filter((entry) => entry.kind === 'operation' && entry.epoch === r.connection()).length > 1) return `③ two lookups in flight (${path})`;
    if (st.busy && r.pending.length === 0) return `⑤ busy with nothing in flight (${path})`;
    const open = !!st.operationId && ['running', 'confirmation', 'unknown'].includes(st.outcome);
    if (open && st.online && r.pending.length === 0 && !st.busy && !tappable(r) && r.timers.length === 0
      && !(st.outcome === 'unknown' && st.missingReceiptFacts !== undefined && st.missingReceiptFacts !== null))
      return `⑥ stuck: ${st.outcome}${st.answerHeld ? ' (answer held)' : ''} with nothing in flight and no poll (${path})`;
    const rank = st.outcome === 'confirmation' ? 1 : st.outcome === 'running' ? (r.host.answersWritten > 0 && r.host.phase !== 'confirmation' ? 2 : 0)
      : finalOutcome(st.outcome) ? 3 : -1;
    if (rank >= 0 && rank < shown.rank) return `⑦ went back to ${st.outcome} (${path})`;
    shown.rank = Math.max(shown.rank, rank);
    return null;
  }
  async function drain(r: R) {
    const counts: Record<string, number> = {};
    for (let i = 0; i < 60; i++) {
      if (!r.c.getState().online) { await step(r, 'online', counts); continue; }
      const queued = r.pending.find((entry) => entry.stage === 'queued');
      if (queued) { await step(r, `dequeue#${queued.seq}`, counts); continue; }
      if (r.transit.length) { await step(r, `arrive#${r.transit[0].seq}`, counts); continue; }
      const written = r.pending.find((entry) => entry.stage === 'written' && entry.arrived);
      if (written) { await step(r, `deliver#${written.seq}`, counts); continue; }
      if (r.host.phase === 'accepted' || r.host.phase === 'running') { await step(r, 'host', counts); continue; }
      if (r.timers.length > 0) { await step(r, 'tick', counts); continue; }
      break;
    }
    // A result waiting for the person (lookups stopped, the receipt gone) is settled by their "Check result", once.
    if (!r.view.gone && r.c.pendingCheck()?.waiting) {
      await step(r, 'check', counts);
      for (let i = 0; i < 20; i++) {
        const next = r.pending.find((entry) => entry.stage === 'queued') ?? r.transit[0] ?? r.pending.find((entry) => entry.stage === 'written' && entry.arrived);
        if (!next) break;
        await step(r, `${next.stage === 'queued' ? 'dequeue' : r.transit.includes(next) ? 'arrive' : 'deliver'}#${next.seq}`, counts);
      }
    }
    const st = r.c.getState();
    // Let go: this phone stopped following it (nothing written for that); it must not hold the slot.
    if (r.view.gone) return r.slot.holder('host-1') ? '⑩ slot held after letting go' : r.view.lostCheck ? '⑪ written operation let go' : null;
    if (r.host.phase === 'none') return st.outcome === 'failed' ? null : `⑧ Host never took the begin, phone shows ${st.outcome}`;
    if (r.host.phase === 'confirmation') return tappable(r) ? null : `⑧ Host waits for an answer, phone shows ${st.outcome}${st.answerHeld ? ' (held)' : ''}`;
    return st.outcome === r.host.phase ? null : `⑧ Host ${r.host.phase}, phone shows ${st.outcome}`;
  }
  async function replay(events: string[]) {
    const r = rig();
    await r.c.refresh();
    void r.c.install(detail, plugin, r.hold);
    await flush();
    const counts: Record<string, number> = {}, shown = { rank: -1 };
    // ⑨ pace: within lookups that bring nothing new from the Host, the delay never shrinks (see the controller's pace).
    const sig = () => { const st = r.c.getState(); return JSON.stringify([st.receipt?.phase, st.receipt?.consent?.requestId]); };
    let pace: { delay: number; sig: string } | null = null;
    for (let i = 0; i < events.length; i++) {
      const lostLookup = events[i].startsWith('lose#')
        && r.pending.some((entry) => entry.kind === 'operation' && `lose#${entry.seq}` === events[i]);
      const snapshotsBefore = r.sent.snapshots;
      if (['online', 'offline', 'check', 'allow', 'reject'].includes(events[i])) pace = null;
      if (events[i] === 'tick' && r.timers.length) {
        const delay = r.timers[0].delayMs, now = sig();
        if (pace && pace.sig === now && delay < pace.delay)
          return { violation: `⑨ lookup delay shrank ${pace.delay} → ${delay} without progress (${events.slice(0, i + 1).join(' → ')})`, r, counts, next: [] as string[] };
        pace = { delay, sig: now };
      }
      await step(r, events[i], counts);
      const path = events.slice(0, i + 1).join(' → ');
      // ⑨ Automatic lookups are bounded by the timer firings (plus reconnects and taps); a failed lookup reads no snapshot.
      if (r.sent.lookups > (counts.tick ?? 0) + (counts.online ?? 0) + (counts.check ?? 0) + 1)
        return { violation: `⑨ ${r.sent.lookups} lookups for ${counts.tick ?? 0} timer firings (${path})`, r, counts, next: [] as string[] };
      if (lostLookup && r.sent.snapshots > snapshotsBefore)
        return { violation: `⑨ snapshot read after a failed lookup (${path})`, r, counts, next: [] as string[] };
      const violation = check(r, shown, path);
      if (violation) return { violation, r, counts, next: [] as string[] };
    }
    return { violation: null, r, counts, next: enabled(r, counts) };
  }
  const fingerprint = (r: R, counts: Record<string, number>) => JSON.stringify([r.host, r.c.getState().outcome, r.c.getState().busy,
    r.c.getState().answerHeld, r.c.getState().online, r.c.getState().receipt?.phase, r.timers.length,
    r.pending.map((entry) => [entry.kind, entry.stage, entry.arrived, entry.confirmed, entry.epoch === r.connection()]),
    r.transit.map((entry) => [entry.kind, entry.confirmed]), r.view.detached, r.view.gone, r.c.cancelPhase(), r.writes, counts, [...r.shown]]);
  // The maintainer's orders, as plain regressions (each fails on ea3874b2 and e46ff0aa).
  const run = async (r: R, events: string[]) => { const counts = {}; for (const event of events) await step(r, event, counts); };
  it('A: a late begin consent after Allow already ran neither goes back nor stops the polling', async () => {
    {
      const r = rig({ promptOnAccept: true });
      await r.c.refresh(); void r.c.install(detail, plugin); await flush();
      await run(r, ['dequeue#1', 'arrive#1', 'offline', 'online', 'dequeue#2', 'arrive#2', 'deliver#2']);
      expect(r.c.getState().outcome).toBe('confirmation');
      await run(r, ['allow', 'dequeue#3', 'arrive#3', 'deliver#3']);
      expect(r.c.getState().outcome).toBe('running');
      await run(r, ['deliver#1']);                                 // the begin's consent arrives late
      expect(r.c.getState().outcome).toBe('running');
      await run(r, ['host', 'tick']);                              // the Host finishes; the next poll shows it
      const lookup = r.pending.find((entry) => entry.kind === 'operation')!;
      await run(r, [`dequeue#${lookup.seq}`, `arrive#${lookup.seq}`, `deliver#${lookup.seq}`]);
      expect(r.c.getState()).toMatchObject({ outcome: 'succeeded', busy: false });
    }
  });
  it('B: a final outcome from the reconnect lookup lands after a late begin running', async () => {
    {
      const r = rig({ consent: false });
      await r.c.refresh(); void r.c.uninstall(plugin); await flush();
      await run(r, ['dequeue#1', 'arrive#1', 'offline', 'online', 'host', 'dequeue#2', 'arrive#2', 'deliver#1', 'deliver#2']);
      expect(r.c.getState()).toMatchObject({ outcome: 'succeeded', busy: false });
    }
  });
  it('a written answer whose reply is lost after a later lookup still found its consent becomes checkable, then settles', async () => {
    {
      const r = rig();
      await r.c.refresh(); void r.c.install(detail, plugin); await flush();
      await run(r, ['dequeue#1', 'arrive#1', 'deliver#1', 'host', 'tick', 'dequeue#2', 'arrive#2', 'deliver#2']);
      expect(r.c.getState().outcome).toBe('confirmation');
      await run(r, ['allow', 'dequeue#3', 'offline', 'online', 'dequeue#4', 'arrive#4', 'deliver#4']);
      expect(r.c.getState()).toMatchObject({ outcome: 'confirmation', answerHeld: 'consent-1' });
      await run(r, ['lose#3']);                                    // the answer's reply is lost
      // Not a dead end: a checkable unknown result whose answer stays locked, looked up by itself.
      expect(r.c.getState()).toMatchObject({ outcome: 'unknown', answerHeld: 'consent-1', busy: false });
      expect(r.timers.length).toBeGreaterThan(0);
      await run(r, ['arrive#3', 'host', 'tick']);                  // the answer reached the Host after all; it finishes
      const lookup = r.pending.find((entry) => entry.kind === 'operation')!;
      await run(r, [`dequeue#${lookup.seq}`, `arrive#${lookup.seq}`, `deliver#${lookup.seq}`]);
      expect(r.c.getState()).toMatchObject({ outcome: 'succeeded' });
      expect(r.host.answersWritten).toBe(1);
    }
  });
  it('keeps every invariant after every step, and reaches the Host result without taps', async () => {
    const violations = new Set<string>(), seen = new Set<string>();
    let leaves = 0;
    const explore = async (events: string[]): Promise<void> => {
      const { violation, r, counts, next } = await replay(events);
      if (violation) { violations.add(violation); r.dispose(); return; }
      const key = fingerprint(r, counts);
      if (seen.has(key)) { r.dispose(); return; }
      seen.add(key);
      if (!next.length || events.length >= 10) {
        leaves += 1;
        const end = await drain(r);
        if (end) violations.add(`${end} (${events.join(' → ')})`);
        r.dispose();
        return;
      }
      r.dispose();
      for (const event of next) await explore([...events, event]);
    };
    await explore([]);
    expect([...violations].slice(0, 8)).toEqual([]);
    expect(leaves).toBeGreaterThan(200);
  }, 30_000);
  // Maintainer review 14:18 #1: a lookup that keeps failing while the computer stays online made one lookup and one
  // extra snapshot read per second, for as long as the failure lasted. Now: no snapshot on a failed lookup, lookups
  // back off and stop after a few failures (a protocol error stops them at once); "Check result" stays available, and
  // coming back online starts over. Minimal failing input: a written begin whose reply is lost, then lookups that time out.
  it('backs off and stops automatic lookups that keep failing, without reading a snapshot each time', async () => {
    const r = rig();
    await r.c.refresh(); void r.c.install(detail, plugin); await flush();
    await run(r, ['dequeue#1', 'arrive#1', 'lose#1']);          // the begin's reply is lost: unknown
    expect(r.c.getState().outcome).toBe('unknown');
    const snapshots = r.sent.snapshots, delays: number[] = [];
    for (let i = 0; i < 10 && r.timers.length; i++) {
      delays.push(r.timers[0].delayMs);
      await run(r, ['tick']);
      const lookup = r.pending.find((entry) => entry.kind === 'operation')!;
      await run(r, [`dequeue#${lookup.seq}`, `arrive#${lookup.seq}`, `lose#${lookup.seq}`]);
    }
    expect(r.sent.lookups).toBe(4);
    expect(delays).toEqual([POLL, 2 * POLL, 4 * POLL, 8 * POLL]);
    expect(r.sent.snapshots).toBe(snapshots);
    // Stopped, not stuck: "Check result" can be tapped, and it looks up once.
    expect(r.c.getState()).toMatchObject({ outcome: 'unknown', busy: false, online: true });
    expect(r.timers).toHaveLength(0);
    void r.c.reconcile(); await flush();
    expect(r.sent.lookups).toBe(5);
    const manual = r.pending.find((entry) => entry.kind === 'operation')!;
    await run(r, [`dequeue#${manual.seq}`, `arrive#${manual.seq}`, `lose#${manual.seq}`]);
    expect(r.timers).toHaveLength(0);
    // Back online after going away: automatic lookups start over.
    await run(r, ['offline', 'online']);
    expect(r.sent.lookups).toBe(6);
  });
  /* 测试价值（维护者 15:37 复审第 3 条；调度要求的统一节奏）
   * - 生产入口与可观察结果：真实 controller + client 接隔离传输；观察自动查询的间隔、答复写出次数。
   * - 依据：只有观察到的进展（回执的秩上升）重置节奏；同一个已答复的确认、同一个进行中状态都算没有进展，按同一规则
   *   翻倍、封顶（进行中 5 秒，其余 30 秒），同一段里间隔不减；成功但没有进展的查询不停，速率由封顶限制。
   * - 缺口：写出 Allow 后回包丢失，Host 一直返回同一个确认时，每秒查一次、无界。
   * - 最小失败输入：Allow 写出、回包丢失，十次查询都返回原 requestId。tier: unit。
   */
  it('backs off while the Host keeps showing the consent this phone already answered', async () => {
    const r = rig({ promptOnAccept: true });
    await r.c.refresh(); void r.c.install(detail, plugin); await flush();
    await run(r, ['dequeue#1', 'arrive#1', 'deliver#1']);       // the Host shows the consent
    expect(r.c.getState().outcome).toBe('confirmation');
    void r.c.answer(true); await flush();
    const answer = r.pending.find((entry) => entry.kind === 'answer')!;
    // Written, but it never reaches the Host and its reply is lost: the Host keeps showing the same consent.
    await run(r, [`dequeue#${answer.seq}`, `lose#${answer.seq}`]);
    expect(r.c.getState()).toMatchObject({ outcome: 'unknown', answerHeld: 'consent-1' });
    const delays: number[] = [];
    for (let i = 0; i < 10; i++) {
      delays.push(r.timers[0].delayMs);
      await run(r, ['tick']);
      const lookup = r.pending.find((entry) => entry.kind === 'operation')!;
      await run(r, [`dequeue#${lookup.seq}`, `arrive#${lookup.seq}`, `deliver#${lookup.seq}`]);
      expect(r.c.getState()).toMatchObject({ outcome: 'unknown', answerHeld: 'consent-1' });
    }
    expect(r.host.answersWritten).toBe(1);
    expect(delays).toEqual([POLL, 2 * POLL, 4 * POLL, 8 * POLL, 16 * POLL, 30_000, 30_000, 30_000, 30_000, 30_000]);
    // Still looked up (bounded rate), and "Check result" stays available without a second answer.
    expect(r.timers.map((timer) => timer.delayMs)).toEqual([30_000]);
    void r.c.reconcile(); await flush();
    expect(r.pending.filter((entry) => entry.kind === 'answer')).toHaveLength(0);
  });
  it('backs off while the Host keeps reporting the same running state, and starts over on progress', async () => {
    const r = rig();
    await r.c.refresh(); void r.c.install(detail, plugin); await flush();
    await run(r, ['dequeue#1', 'arrive#1', 'deliver#1']);       // running; the Host stays there (slow download)
    expect(r.c.getState().outcome).toBe('running');
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      delays.push(r.timers[0].delayMs);
      await run(r, ['tick']);
      const lookup = r.pending.find((entry) => entry.kind === 'operation')!;
      await run(r, [`dequeue#${lookup.seq}`, `arrive#${lookup.seq}`, `deliver#${lookup.seq}`]);
    }
    expect(delays).toEqual([POLL, 2 * POLL, 4 * POLL, 5_000, 5_000, 5_000]);
    // Progress (the Host now shows its consent): the pace starts over once the person answered.
    await run(r, ['host', 'tick']);
    const lookup = r.pending.find((entry) => entry.kind === 'operation')!;
    await run(r, [`dequeue#${lookup.seq}`, `arrive#${lookup.seq}`, `deliver#${lookup.seq}`]);
    expect(r.c.getState().outcome).toBe('confirmation');
    void r.c.answer(true); await flush();
    const answer = r.pending.find((entry) => entry.kind === 'answer')!;
    await run(r, [`dequeue#${answer.seq}`, `arrive#${answer.seq}`, `deliver#${answer.seq}`]);
    expect(r.c.getState().outcome).toBe('running');
    expect(r.timers.map((timer) => timer.delayMs)).toEqual([POLL]);
  });
  /* 测试价值（维护者 17:43 复审第 1 条；调度要求 F）
   * - 生产入口与可观察结果：真实 controller + client 接隔离传输，视图走开后按 usePluginManagement 同一个决策函数
   *   `nextDetachedStep` 推进；观察写出的 management:* 顺序与页面占用的持有、释放时刻。
   * - 依据：每项操作最多一次取消，只在确认已出现、本机从未写出答复时；取消在途时持有占用；写出前失败不重试、只放开本机；
   *   写出后结果不明只核实原操作；已写出答复的操作任何路径都不取消；放弃跟踪不写任何东西。
   * - 缺口：watcher 在取消收尾前反复进入；丢回包后再次取消；已允许的操作在离开时被取消。
   * - 最小失败输入：下面三种各一次。tier: unit。
   */
  it('cancels a consent left unanswered once; refused before writing, it stays a pending check that waits for the person, with nothing written', async () => {
    const r = rig({ promptOnAccept: true });
    await r.c.refresh(); void r.c.install(detail, plugin, r.hold); await flush();
    await run(r, ['dequeue#1', 'arrive#1', 'deliver#1']);
    expect(r.c.getState().outcome).toBe('confirmation');
    await run(r, ['leave']);
    const cancel = r.pending.find((entry) => entry.kind === 'cancel')!;
    expect(r.slot.holds(r.token)).toBe(true);                     // held while the cancel is on its way
    await run(r, [`refuse#${cancel.seq}`]);
    expect(r.asked).toEqual(['begin', 'cancel']);
    expect(r.writes).toEqual(['begin']);
    // Maintainer review 18:45: the begin was written, so it is kept (its "Check result" and "Stop tracking" stay); the
    // computer's slot goes, as nothing moves it on by itself.
    expect(r.view.steps).toEqual(['cancel']);
    expect(r.c.pendingCheck()).toMatchObject({ operationId: 'operation-1', entry: 'update', waiting: true });
    expect(r.slot.holder('host-1')).toBeNull();
    expect(r.pending).toEqual([]);
  });
  it('after a written cancel whose reply is lost, only looks up the operation, never cancels again', async () => {
    const r = rig({ promptOnAccept: true, lookupInvalid: true });
    await r.c.refresh(); void r.c.install(detail, plugin, r.hold); await flush();
    await run(r, ['dequeue#1', 'arrive#1', 'deliver#1', 'leave']);
    const cancel = r.pending.find((entry) => entry.kind === 'cancel')!;
    await run(r, [`dequeue#${cancel.seq}`, `lose#${cancel.seq}`]);
    expect(r.c.getState().outcome).toBe('unknown');
    expect(r.slot.holds(r.token)).toBe(true);
    await run(r, ['tick']);
    const lookup = r.pending.find((entry) => entry.kind === 'operation')!;
    expect(r.slot.holds(r.token)).toBe(true);                     // the lookup is still on its way
    await run(r, [`dequeue#${lookup.seq}`, `arrive#${lookup.seq}`, `deliver#${lookup.seq}`]);
    // INVALID_RESPONSE stops the lookups; it waits for the person's "Check result" (kept, the slot free), no second cancel.
    expect(r.asked).toEqual(['begin', 'cancel', 'operation']);
    expect(r.writes).toEqual(['begin', 'cancel', 'operation']);
    expect(r.view.steps).toEqual(['cancel']);
    expect(r.c.pendingCheck()?.waiting).toBe(true);
    expect(r.slot.holder('host-1')).toBeNull();
  });
  it('never cancels an operation whose Allow was written, even when it is left after lookups stopped', async () => {
    const r = rig({ promptOnAccept: true, lookupInvalid: true });
    await r.c.refresh(); void r.c.install(detail, plugin, r.hold); await flush();
    await run(r, ['dequeue#1', 'arrive#1', 'deliver#1']);
    void r.c.answer(true); await flush();
    const answer = r.pending.find((entry) => entry.kind === 'answer')!;
    await run(r, [`dequeue#${answer.seq}`, `arrive#${answer.seq}`, `lose#${answer.seq}`, 'tick']);
    const lookup = r.pending.find((entry) => entry.kind === 'operation')!;
    await run(r, [`dequeue#${lookup.seq}`, `arrive#${lookup.seq}`, `deliver#${lookup.seq}`]);
    expect(r.c.lookupsStopped()).toBe(true);
    await run(r, ['leave']);
    expect(r.asked).toEqual(['begin', 'answer', 'operation']);
    expect(r.writes).toEqual(['begin', 'answer', 'operation']);
    expect(r.view.steps).toEqual([]);                             // kept as a pending check, never cancelled
    expect(r.c.pendingCheck()?.waiting).toBe(true);
    expect(r.host.phase).toBe('running');                         // the computer goes on with it
    expect(r.slot.holder('host-1')).toBeNull();
  });
  // The rule is about the operation, not one consent: once this phone wrote an answer to it, nothing cancels it, even
  // when the computer then shows a second consent and the view goes away.
  it('does not cancel a second consent of an operation whose first consent was answered', async () => {
    const second: PluginManagementReceipt = { ...confirmation(), consent: { ...confirmation().consent!, requestId: 'consent-2' } };
    const h = host((request) => request.actionId === 'management:begin' ? confirmation()
      : request.actionId === 'management:answer' ? second : receipt('running'));
    const c = controller(h.client); await c.refresh();
    await c.install(detail, plugin);
    await c.answer(true);
    expect(c.getState()).toMatchObject({ outcome: 'confirmation', answerHeld: null });
    expect(nextDetachedStep(c)).toBe('letGo');
    expect(c.mayCancel()).toBe(false);
    await shownCancel(c);
    expect(h.requests.map((request) => request.actionId).filter((id) => id !== 'management:snapshot' && id !== 'management:market-detail'))
      .toEqual(['management:begin', 'management:answer']);
  });
  it('stops automatic lookups at once on a protocol error and keeps "Check result"', async () => {
    const r = rig({ lookupInvalid: true });
    await r.c.refresh(); void r.c.install(detail, plugin); await flush();
    await run(r, ['dequeue#1', 'arrive#1', 'lose#1', 'tick']);
    const lookup = r.pending.find((entry) => entry.kind === 'operation')!;
    await run(r, [`dequeue#${lookup.seq}`, `arrive#${lookup.seq}`, `deliver#${lookup.seq}`]);
    expect(r.c.getState()).toMatchObject({ outcome: 'unknown', errorCode: 'INVALID_RESPONSE', busy: false });
    expect(r.timers).toHaveLength(0);
    expect(r.sent.lookups).toBe(1);
  });
});

/* 测试价值（维护者 15:37 复审；页面占用的凭据语义）
 * - 生产入口与可观察结果：pluginManagementSlot 与真实 controller（传输替身）；观察占用的持有者与写出。
 * - 依据：只有持有者的凭据能释放；同一个凭据可能经两条路径释放（市场安装的行结束、它交给的 controller 结束），晚到的
 *   那次不能放掉别人此后拿到的占用。
 * - 缺口：渲染态或布尔 saving 由任意一方清零，第一笔结束就让第三个入口恢复。
 * - 最小失败输入：凭据 1 已被行结束释放、凭据 2 已拿到时，持有凭据 1 的 controller 被释放。tier: unit。
 */
describe('page management slot', () => {
  it('lets only the holder release it, once, and refuses a second taker', () => {
    const slot = createPluginManagementSlot();
    const first = slot.tryAcquire('update', SLOT_WHO)!;
    expect(slot.tryAcquire('market-install', SLOT_WHO)).toBeNull();
    expect(slot.tryAcquire('update', SLOT_WHO)).toBeNull();
    expect(slot.release({ id: first.id + 1, entry: 'update', who: SLOT_WHO })).toBe(false);
    expect(slot.holds(first)).toBe(true);
    expect(slot.release(first)).toBe(true);
    const second = slot.tryAcquire('enable', SLOT_WHO)!;
    // A late release of the earlier token (a second path ending the same entry) leaves the new holder alone.
    expect(slot.release(first)).toBe(false);
    expect(slot.holder('host-1')).toBe(second);
  });
  it('keeps a later holder when the controller of an earlier one goes after the entry already released it', async () => {
    const slot = createPluginManagementSlot();
    const requests: string[] = [];
    const invoke = (async (_id: string, channel: string, args?: unknown[], options?: { preSend?: () => void; onRequestWritten?: () => void; onNotSent?: () => void }) => {
      options?.preSend?.(); options?.onRequestWritten?.();
      if (channel.endsWith(':manifest')) return capability;
      const action = (args?.[0] as Envelope).actionId.replace('management:', '');
      requests.push(action);
      if (action === 'snapshot') return { effects: [], result: snapshot() };
      if (action === 'market-detail') return { effects: [], result: detail };
      return new Promise(() => {});                       // begin stays in flight
    }) as unknown as PluginManagementInvoke;
    const c = createPluginManagementController(createPluginManagementClient({ deviceId: 'host-1', invoke }), { createOperationId: () => 'operation-1' });
    controllers.push(c);
    await c.refresh();
    const first = slot.tryAcquire('market-install', SLOT_WHO)!;
    void c.install(detail, plugin, pluginOperationHold(slot, first));
    for (let i = 0; i < 50; i++) await Promise.resolve();
    expect(requests).toContain('begin');
    // The market row settled this attempt on its own (for example from the computer's facts) and released it…
    slot.release(first);
    const second = slot.tryAcquire('update', SLOT_WHO)!;
    // …then the controller that still held the first token goes.
    c.dispose();
    expect(slot.holder('host-1')).toBe(second);
  });
  it('gives the next account a free slot, and releases the previous account\'s', async () => {
    const owner = getMobileAuthOwner();
    const previous = pluginManagementSlotFor(owner);
    const invoke = (async (_id: string, channel: string, args?: unknown[], options?: { preSend?: () => void; onRequestWritten?: () => void; onNotSent?: () => void }) => {
      options?.preSend?.(); options?.onRequestWritten?.();
      if (channel.endsWith(':manifest')) return capability;
      const action = (args?.[0] as Envelope).actionId.replace('management:', '');
      if (action === 'snapshot') return { effects: [], result: snapshot() };
      if (action === 'market-detail') return { effects: [], result: detail };
      return begin.promise;
    }) as unknown as PluginManagementInvoke;
    const begin = deferred<unknown>();
    // As usePluginManagement builds it: current only while the account is the same.
    const c = createPluginManagementController(createPluginManagementClient({ deviceId: 'host-1', invoke,
      isCurrent: () => isMobileAuthOwnerCurrent(owner) }), { createOperationId: () => 'operation-1' });
    controllers.push(c);
    await c.refresh();
    const token = previous.tryAcquire('update', SLOT_WHO)!;
    void c.install(detail, plugin, pluginOperationHold(previous, token));
    for (let i = 0; i < 50; i++) await Promise.resolve();
    setMobileAuthOwner('another-account-for-slot');
    try {
      // The next account starts with its own free slot at once.
      expect(pluginManagementSlotFor().holder('host-1')).toBeNull();
      // The previous account's slot goes once the begin already on its way settles (never while a write is out).
      expect(previous.holder('host-1')).not.toBeNull();
      begin.resolve({ effects: [], result: receipt('running') });
      for (let i = 0; i < 50; i++) await Promise.resolve();
      expect(previous.holder('host-1')).toBeNull();
    } finally { setMobileAuthOwner(owner.accountId || null); }
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
  // Maintainer review 17:43: a cancel is a state of the operation, sent at most once and only for a consent shown and
  // never answered; while the operation only runs (no consent yet) nothing is cancelled and its result stands.
  it('sends no cancel while the operation runs without a consent, so a committed result stands', async () => {
    const begin = deferred<PluginManagementReceipt>();
    const h = host((r) => r.actionId === 'management:begin' ? begin.promise : receipt('succeeded'));
    const c = controller(h.client); await c.refresh();
    const start = c.uninstall(plugin);
    await eventually(() => expect(c.getState().operationId).toBe('operation-1'));
    await shownCancel(c); begin.resolve(receipt('running')); await start;
    expect(c.getState().outcome).toBe('running');
    await c.reconcile();
    expect(c.getState().outcome).toBe('succeeded');
    expect(h.requests.some((r) => r.actionId === 'management:cancel')).toBe(false);
  });
  it('writes no cancel for a begin still queued (no consent shown yet), and leaves the begin as it was', async () => {
    const queued = deferred<unknown>(); let preSend!: () => void;
    const h = host();
    const invoke = (async (d, channel, args, opts) => {
      if ((args?.[0] as Envelope)?.actionId === 'management:begin') { preSend = opts!.preSend!; return queued.promise; }
      return h.invoke(d, channel, args, opts);
    }) as PluginManagementInvoke;
    const c = controller(createPluginManagementClient({ invoke, deviceId: 'host-1' })); await c.refresh();
    const start = c.uninstall(plugin);
    await eventually(() => expect(preSend).toBeTypeOf('function'));
    await shownCancel(c);
    expect(() => preSend()).not.toThrow();
    queued.resolve({ effects: [], result: receipt('succeeded') }); await start;
    expect(c.getState()).toMatchObject({ outcome: 'succeeded', busy: false });
    expect(h.requests.some((r) => r.actionId === 'management:cancel')).toBe(false);
  });
  it.each(['begin', 'answer', 'cancel'] as const)('permanently fences queued %s across offline and online epochs', async (action) => {
    const queued = deferred<unknown>(); let preSend!: () => void;
    // Answer and cancel both start from a consent shown (a cancel is only sent for an unanswered consent).
    const h = host((r) => action === 'answer' || r.actionId === 'management:begin' ? confirmation() : receipt());
    const invoke = (async (d, channel, args, opts) => {
      if ((args?.[0] as Envelope)?.actionId === `management:${action}`) { preSend = opts!.preSend!; return queued.promise; }
      return h.invoke(d, channel, args, opts);
    }) as PluginManagementInvoke;
    const c = controller(createPluginManagementClient({ invoke, deviceId: 'host-1' })); await c.refresh();
    let pending: Promise<void>;
    if (action === 'begin') pending = c.install(detail, plugin);
    else { await c.install(detail, plugin); pending = action === 'answer' ? c.answer(true) : shownCancel(c); }
    await eventually(() => expect(preSend).toBeTypeOf('function'));
    c.setOnline(false); c.setOnline(true);
    await eventually(() => expect(c.getState().busy).toBe(false));
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
  // Maintainer review 17:43 (c): disposing only ends this phone's tracking; it writes nothing, so an operation that was
  // allowed is never stopped on the computer by leaving, and an unanswered consent is cancelled (once) before, not here.
  it.each([['running', () => receipt()], ['a consent', () => confirmation()]] as const)(
    'writes nothing when disposed with an operation in %s', async (_name, begin) => {
      const h = host((r) => r.actionId === 'management:begin' ? begin() : receipt());
      const c = controller(createPluginManagementClient({ invoke: h.invoke, deviceId: 'original-host' }));
      await c.refresh(); await c.uninstall(plugin);
      const before = h.requests.length;
      c.dispose();
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(h.requests.slice(before)).toEqual([]);
    });
  it('ignores late offline results and reconnects by operation lookup, with no write replay', async () => {
    const begin = deferred<PluginManagementReceipt>();
    const h = host((r) => r.actionId === 'management:begin' ? begin.promise : receipt('cancelled'));
    const c = controller(h.client); await c.refresh(); const start = c.uninstall(plugin);
    await eventually(() => expect(c.getState().operationId).toBe('operation-1'));
    // The written begin's reply is the Host's state of this operation: it lands by operation id even though the
    // computer went offline meanwhile (maintainer reviews 10:36 and 11:45: results belong to the operation).
    c.setOnline(false); begin.resolve(receipt('succeeded')); await start;
    expect(c.getState()).toMatchObject({ online: false, outcome: 'succeeded' });
    c.setOnline(true);
    await eventually(() => expect(c.getState().busy).toBe(false));
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
      // A first install's consent (dispatcher O-4: it declares a first install of the version chosen).
      if (request.actionId === 'management:begin') return { ...confirmation(), consent: { ...confirmation().consent!,
        facts: { kind: 'install', ghostId: 'demo', name: 'Demo', version: fresh.version, permissions: [] } } };
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
    const h = host((r) => r.actionId === 'management:begin' ? uiConfirmation() : r.actionId === 'management:answer' ? Promise.reject(new Error('TIMEOUT')) : receipt('succeeded'));
    h.setFacts({ ...snapshot(), uiCapabilityApproval: true });
    const c = controller(h.client); await c.refresh(); await c.approveUi(plugin); await c.answer(true);
    expect(c.getState().outcome).toBe('unknown');
    await c.answer(true); await c.reconcile();
    expect(h.requests.filter((r) => r.actionId === 'management:answer')).toHaveLength(1);
    expect(h.requests.filter((r) => r.actionId === 'management:begin')).toHaveLength(1);
    expect(c.getState().outcome).toBe('succeeded');
  });
  it.each(['revision', 'owner', 'disconnect'] as const)('does not send a stale UI confirmation after %s changes', async (change) => {
    const h = host(() => uiConfirmation());
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
    // The reads wait out a 250 ms notification window after an invalidation; fake timers step over it (performance budget).
    vi.useFakeTimers();
    try {
      const h = host(); const pending = deferred<unknown>();
      const invoke = vi.fn().mockReturnValueOnce(pending.promise).mockImplementation(h.invoke) as PluginManagementInvoke;
      const reads = createPluginPromptReads(invoke, () => true);
      const settled = async <T,>(assertion: Promise<T>) => { await vi.advanceTimersByTimeAsync(300); return assertion; };
      const first = reads.read('host-1');
      const rejection = expect(first).rejects.toThrow('PLUGIN_MANAGEMENT_STALE');
      await Promise.resolve(); reads.invalidate(); pending.resolve(capability); await rejection;
      await settled(expect(reads.read('host-1')).resolves.toMatchObject({ capability: 'supported' }));
      reads.invalidate();
      vi.mocked(invoke).mockRejectedValueOnce(new Error('offline'));
      await settled(expect(reads.read('host-1')).rejects.toThrow('offline'));
      await settled(expect(reads.read('host-1')).resolves.toMatchObject({ capability: 'supported' }));
    } finally { vi.useRealTimers(); }
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
    expect(view.highRisk).toEqual({ title: 'plugins.management.highRiskTitleCount(title=plugins.management.highRiskTitle,count=2)',
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
  /* 测试价值（维护者 16:48 复审；两档布局的不变量）
   * - 生产入口与可观察结果：两端面板共用的 `planConsentSheet`（纯函数）。
   * - 依据：放得下「身份块完整 + 摘要标题 + 前两项（不足两项则全部）」才固定摘要；否则单一滚动区；提示不参与。
   * - 缺口：两条提示测得后，摘要分到 0 高度。
   * - 最小失败输入：可分配 100、身份块 384、标题 40、五项 [36, 48, 40, 40, 48]。tier: unit；约一万个组合，纯计算。
   */
  it('never squeezes a text area to nothing: compact when the identity block and two items do not fit (maintainer numbers)', () => {
    expect(planConsentSheet({ available: 100, identity: 384, heading: 40, lines: [36, 48, 40, 40, 48], gap: 4 })).toEqual({ mode: 'compact' });
    // Room for everything: nothing changes.
    expect(planConsentSheet({ available: 640, identity: 210, heading: 20, lines: [20, 20, 20, 20, 20], gap: 4 }))
      .toEqual({ mode: 'regular', summaryLines: 116, clipped: false, guaranteed: 44 });
    // The identity block and two items fit, the rest scrolls inside the summary.
    expect(planConsentSheet({ available: 332, identity: 230, heading: 25, lines: [20, 20, 20, 20, 20], gap: 4 }))
      .toEqual({ mode: 'regular', summaryLines: 77, clipped: true, guaranteed: 44 });
    // Dispatcher P-3 (iOS XXXL, SE): room for the two items and 1 pt of the third (55 of 5 items) is no longer regular;
    // with the fade's height of the third showing it is.
    expect(planConsentSheet({ available: 255 + 55, identity: 230, heading: 25, lines: [27, 27, 27, 27, 27], gap: 0 })).toEqual({ mode: 'compact' });
    expect(planConsentSheet({ available: 255 + 54 + CONSENT_FADE_HEIGHT, identity: 230, heading: 25, lines: [27, 27, 27, 27, 27], gap: 0 }))
      .toEqual({ mode: 'regular', summaryLines: 54 + CONSENT_FADE_HEIGHT, clipped: true, guaranteed: 54 });
  });
  it('keeps the two-layout invariants for every height, text size and item count', () => {
    const availables = [0, 1, 10, 43, 44, 88, 100, 200, 320, 480, 640, 900];
    const identities = [0, 40, 120, 230, 384, 600];
    const headings = [0, 20, 40, 60];
    const patterns = [[20], [36, 48, 40], [48]];
    let checked = 0;
    for (const gap of [4, 8]) for (const available of availables) for (const identity of identities) for (const heading of headings)
      for (let count = 0; count <= 6; count++) for (const pattern of patterns) {
        const lines = Array.from({ length: count }, (_, index) => pattern[index % pattern.length]);
        const input = { available, identity, heading, lines, gap };
        const name = JSON.stringify(input);
        const plan = planConsentSheet(input);
        checked += 1;
        // ⑥ The same input always plans the same way (nothing to oscillate on).
        expect(planConsentSheet({ ...input, lines: [...lines] }), name).toEqual(plan);
        // ⑤ Hints are not an input: whatever their heights, measured or not, the plan is the same.
        expect(planConsentSheet({ ...input, summaryHint: 48, listHint: 48 } as typeof input), name).toEqual(plan);
        if (count === 0) { expect(plan, name).toEqual({ mode: 'regular', summaryLines: 0, clipped: false, guaranteed: 0 }); continue; }
        const measured = identity > 0 && heading > 0;
        const sum = (n: number) => lines.slice(0, n).reduce((total, line) => total + line, 0) + Math.max(0, Math.min(n, count) - 1) * gap;
        const floor = sum(Math.min(2, count)), full = sum(count);
        if (plan.mode === 'compact') {
          // ③ Compact only when the regular layout's floor does not fit: everything, or (dispatcher P-3) the two items and
          // enough of the next to draw the fade over it (or nothing is measured and even one line would not).
          if (measured) expect(identity + heading + Math.min(full, floor + gap + CONSENT_FADE_HEIGHT), name).toBeGreaterThan(available);
          continue;
        }
        // ① A pinned summary always gets a real height, and so does the list above it.
        expect(plan.summaryLines, name).toBeGreaterThan(0);
        if (measured) {
          // ② At least the heading's two items (all, if fewer); never more than all of them.
          expect(plan.summaryLines, name).toBeGreaterThanOrEqual(floor);
          expect(plan.summaryLines, name).toBeLessThanOrEqual(full);
          expect(plan.clipped, name).toBe(plan.summaryLines < full);
          // ④ Within the room, with the identity block in full above it.
          expect(identity + heading + plan.summaryLines, name).toBeLessThanOrEqual(available);
          // ⑦ (dispatcher N-3) The fade over the pinned summary never reaches its guaranteed two items: drawn only when
          // what shows below them is at least the fade's height (otherwise only the scrollbar says there is more).
          expect(plan.guaranteed, name).toBe(floor);
          if (consentSummaryFadeAllowed(plan)) expect(plan.summaryLines - CONSENT_FADE_HEIGHT, name).toBeGreaterThanOrEqual(plan.guaranteed);
          // ⑨ (dispatcher P-3) Regular and not all shown ⇒ the fade can be drawn (part of the next item always shows).
          if (plan.clipped) expect(consentSummaryFadeAllowed(plan), name).toBe(true);
        } else {
          expect(plan.summaryLines + PINNED_HIGH_RISK_MIN_HEIGHT, name).toBeLessThanOrEqual(available);
        }
      }
    expect(checked).toBe(2 * availables.length * identities.length * headings.length * 7 * patterns.length);
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
    expect(view.highRisk).toEqual({ title: 'plugins.management.highRiskTitleCount(title=plugins.management.highRiskTitle,count=1)', lines: ['plugins.management.permissions.nodeSecretOne'] });
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
      highRisk: { title: 'plugins.management.highRiskTitleCount(title=plugins.management.highRiskTitle,count=1)', lines: ['plugins.management.permissions.nodeRuntime'] } });
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
    const chose = (consent: any) => pluginConsentAllowance({ kind: 'install', deviceId: 'host-1', pluginId: 'custom-market:Acme/demo',
      ghostId: 'demo', version: '1', releaseId: 'release-1', sourceType: 'git-market', source: chosen }, declaredPluginConsent(consent, 'host-1'));
    expect(pluginConsentPresentation(consented(chosen.sourceId), t, 'Mac', chose(consented(chosen.sourceId)))).toMatchObject({ allowBlocked: false, sourceChanged: undefined });
    expect(pluginConsentPresentation(consented('SourceB_0123456789abcd'), t, 'Mac', chose(consented('SourceB_0123456789abcd'))))
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
  /* 测试价值（缺仓库信息的说明，调度 2026-11-25 文案决定，提案，待维护者确认）
   * - 生产入口与可观察结果：12 种语言的实际文案；市场条目经真实解析后的判定。
   * - 依据：手机分不清缺省原因（电脑上的 Cindy 较旧、Host 升级后 Git 市场还没刷新、地址生成不出身份），说明不能暗示
   *   以后会有，长句要先让更新并刷新、再给「仍不行就在电脑上做」的出口；只在非官方市场出现。
   * - 缺口：旧文案写「暂未 / yet」，只让刷新再试。
   * - 最小失败输入：zh-CN market.sourceUnverified 含「暂」。tier: unit。
   */
  it('words the missing repository information the same way in every language, without implying it comes later', () => {
    const locales = resolve(process.cwd(), 'src/i18n/locales');
    const read = (language: string, file: string, key: string) => key.split('.')
      .reduce((node: any, part) => node?.[part], JSON.parse(readFileSync(resolve(locales, language, `${file}.json`), 'utf8')));
    const keys = [['plugins', 'market.sourceUnverified'], ['plugins', 'market.sourceUnverifiedShort'], ['plugins', 'management.sourceUnverified'],
      ['plugins', 'notice.consentSource.repositoryMissingInstall'], ['plugins', 'notice.consentSource.repositoryMissingUpdate'],
      ['interaction', 'permission.installSourceUnverified']] as const;
    const languages = readdirSync(locales);
    expect(languages).toHaveLength(12);
    for (const language of languages) for (const [file, key] of keys) {
      const value = read(language, file, key);
      expect(typeof value, `${language} ${key}`).toBe('string');
      expect(value, `${language} ${key}`).not.toMatch(/暂|暫|\byet\b|\bnoch\b|\bencore\b|\baún\b|\bainda\b|まだ|아직/i);
    }
    // zh-CN as decided: update and refresh first, then the way out; the card ends with deny here, confirm on the computer.
    expect(read('zh-CN', 'plugins', 'market.sourceUnverified')).toBe('这台电脑没有提供这个自定义市场的仓库信息，不能从手机安装。请先在那台电脑上更新 Cindy 并刷新这个市场；若仍不行，请直接在电脑上安装。');
    expect(read('zh-CN', 'plugins', 'notice.consentSource.repositoryMissingInstall')).toBe(read('zh-CN', 'plugins', 'market.sourceUnverified'));
    expect(read('zh-CN', 'plugins', 'notice.consentSource.repositoryMissingUpdate')).toBe(read('zh-CN', 'plugins', 'management.sourceUnverified'));
    expect(read('zh-CN', 'plugins', 'management.sourceUnverified')).toContain('若仍不行，请直接在电脑上更新这个插件');
    expect(read('zh-CN', 'plugins', 'market.sourceUnverifiedShort')).toBe('缺少仓库信息，不能从手机安装');
    expect(read('zh-CN', 'interaction', 'permission.installSourceUnverified')).toMatch(/这里只能拒绝，要安装请在电脑上确认。$/);
  });
  // Covers existing behavior; keeps the phone and the computer from drifting apart. The literals are the same as in the
  // computer's apps/desktop/src/shared/__tests__/pluginMarket.test.ts (`isPluginMarketSourceIdentity` there, the
  // repositories its generator produces there): what the computer accepts and generates, the phone accepts; what it
  // rejects, the phone rejects. Change both together. Tier: unit.
  it('accepts exactly the source identities the computer accepts and generates', () => {
    const SOURCE_ID = 'AbCdEfGhIjKlMnOpQrStUv';
    for (const valid of [
      { kind: 'git', repository: 'github.com/acme/plugins', sourceId: SOURCE_ID },
      { kind: 'git', repository: 'github.com/acme/plugins', ref: 'main', sourceId: SOURCE_ID },
      { kind: 'local', sourceId: SOURCE_ID },
      // Generated there from real addresses (https / ssh / scp / nested groups / a fetched mirror with a ref).
      { kind: 'git', repository: 'gitlab.example.com/group/sub/plugins', sourceId: SOURCE_ID },
      { kind: 'git', repository: 'mirror.example.test/tenant/plugins', sourceId: SOURCE_ID },
      { kind: 'git', repository: 'mirror.example.test/tenant/plugins', ref: 'release/2026', sourceId: SOURCE_ID },
    ]) expect(isPluginMarketSourceIdentity(valid), JSON.stringify(valid)).toBe(true);
    for (const invalid of [
      null, 'github.com/acme/plugins', { kind: 'local' }, { kind: 'git', repository: 'github.com/acme/plugins' },
      { kind: 'git', repository: 'github.com/acme', sourceId: SOURCE_ID },
      { kind: 'git', repository: 'github.com/acme/plugins', sourceId: `${SOURCE_ID}=` },
      { kind: 'git', repository: 'github.com/acme/plugins', url: 'https://github.com/acme/plugins', sourceId: SOURCE_ID },
      // A ref that is not a valid one (or not a string): the computer now sends no identity at all, never one without it.
      { kind: 'git', repository: 'github.com/acme/plugins', ref: 7, sourceId: SOURCE_ID },
      { kind: 'git', repository: 'github.com/acme/plugins', ref: '-x', sourceId: SOURCE_ID },
      { kind: 'local', path: '/tmp/market', sourceId: SOURCE_ID },
    ]) expect(isPluginMarketSourceIdentity(invalid), JSON.stringify(invalid)).toBe(false);
  });
  /* 测试价值（与桌面 5fd5f542c0 的市场详情对齐，调度 2026-11-25 决定，提案，待维护者确认）
   * - 生产入口与可观察结果：市场条目经真实解析后，详情的资料行、名称下的副标题、社区声明是否出现。
   * - 依据：桌面详情资料为「版本 v1.2 / 作者（显示时）/ 来源：公开市场、组织、自定义」，头部只放作者与徽标，公开的社区
   *   作者插件有社区声明；这是安全提示，手机不能比电脑少。自定义市场在手机上保留市场名。
   * - 缺口：手机来源一格对所有服务端插件都写「插件市场」，版本不带 v、没有作者，副标题重复徽标与版本，没有社区声明。
   * - 最小失败输入：公开的官方插件（来源应为公开市场）；公开的社区插件（应有社区声明）。tier: unit。
   */
  it('shows the market detail facts, subtitle and community notice the way the computer does', () => {
    const t = (key: string) => key;
    const item = (extra: Record<string, unknown>) => parsePluginMarketPage({ items: [{ ...detail, installState: 'not-installed',
      enabled: null, version: '1.4.2', author: 'Ada', ...extra }] }).items[0]!;
    const facts = (extra: Record<string, unknown>) => Object.fromEntries(pluginMarketFacts(item(extra), t).map((fact) => [fact.key, fact.value]));
    const official = { sourceType: 'server', scope: 'public', publisherKind: 'official' };
    const community = { sourceType: 'server', scope: 'public', publisherKind: 'personal' };
    const organization = { sourceType: 'server', scope: 'organization', publisherKind: null };
    const custom = { sourceType: 'git-market', scope: 'public', publisherKind: null, sourceMarketName: 'Acme' };
    expect(facts(official)).toEqual({ version: 'v1.4.2', author: 'Ada', source: 'plugins.market.publicInstall', identifier: 'demo' });
    // Community authors stay anonymous, as on the computer.
    expect(facts(community)).toEqual({ version: 'v1.4.2', source: 'plugins.market.publicInstall', identifier: 'demo' });
    expect(facts(organization)).toMatchObject({ author: 'Ada', source: 'plugins.market.scope.organization' });
    expect(facts(custom)).toMatchObject({ author: 'Ada', source: 'Acme' });
    expect(pluginMarketFacts(item(official), t).map((fact) => fact.key)).toEqual(['version', 'author', 'source', 'identifier']);
    // Under the name: the author only (no scope or version repeating the badge and the facts).
    expect(pluginMarketSubtitle(item(official))).toBe('Ada');
    expect(pluginMarketSubtitle(item(community))).toBe('');
    // The community notice: public plugins by community authors only.
    expect([official, community, organization, custom].map((extra) => pluginMarketShowsCommunityNotice(item(extra))))
      .toEqual([false, true, false, false]);
  });
  // The update action uses the computer's own label in every language (desktop settings.ghosts.page.updateTo, copied
  // verbatim; desktop 5fd5f542c0 made the computer say "update" throughout). Chinese no longer says 升级 for a plugin.
  it('names a plugin update the way the computer does', () => {
    const locales = resolve(process.cwd(), 'src/i18n/locales');
    const plugins = (language: string) => JSON.parse(readFileSync(resolve(locales, language, 'plugins.json'), 'utf8'));
    for (const language of readdirSync(locales)) {
      const updateTo: string = plugins(language).management.updateTo;
      expect(updateTo, language).toContain('v{{version}}');
      expect(plugins(language).management, language).not.toHaveProperty('update');
      expect(JSON.stringify(plugins(language)), language).not.toMatch(/升级|升級|升之|其升/);
    }
    expect(plugins('zh-CN').management.updateTo).toBe('更新到 v{{version}}');
    expect(plugins('en').management.updateTo).toBe('Update to v{{version}}');
    // Where updating Cindy and updating the plugin share a sentence, the plugin is named.
    expect(plugins('zh-CN').management.sourceUnverified).toContain('请直接在电脑上更新这个插件');
    expect(plugins('en').management.sourceUnverified).toContain('update the plugin on the computer');
  });
  // Covers existing behavior: the repository is what the person checks, so the longest allowed one (256 characters, no
  // spaces) reaches the confirmation line whole, from the Host receipt through parsing; the line itself wraps on screen.
  it('keeps a 256-character repository whole from the receipt to the confirmation line', () => {
    const repository = 'github.com/' + 'o'.repeat(100) + '/' + 'r'.repeat(100) + '/' + 'p'.repeat(43);
    expect(repository).toHaveLength(256);
    const parsed = parsePluginManagementReceipt({ operationId: 'op', phase: 'confirmation', consent: {
      requestId: 'r', origin: 'custom-market', originLabel: 'Acme', initiator: 'user',
      originSource: { kind: 'git', repository, sourceId: 'DemoGitMarketSource001' },
      facts: { kind: 'install', ghostId: 'demo', name: 'Demo', version: '1', permissions: [] } } }, 'op');
    const t = (key: string, args?: Record<string, unknown>) => args ? `${key}|${args.repository ?? ''}` : key;
    expect(pluginConsentPresentation(parsed.consent!, t as any, 'Mac').repository).toBe(`plugins.notice.consentSource.repository|${repository}`);
  });
  // Covers existing behavior: the market shows it only off the official market, for a missing or unusable identity.
  it('marks only a non-official market item without a usable identity as missing its repository', () => {
    const id = 'DemoGitMarketSource001';
    const item = (extra: Record<string, unknown>) => parsePluginMarketPage({ items: [{ ...detail, installState: 'not-installed', enabled: null,
      sourceMarketName: 'Acme', ...extra }] }).items[0]!;
    expect(pluginMarketSourceUnverified(item({ sourceType: 'server' }))).toBe(false);
    expect(pluginMarketSourceUnverified(item({ sourceType: 'git-market' }))).toBe(true);
    expect(pluginMarketSourceUnverified(item({ sourceType: 'git-market', sourceIdentity: { kind: 'git', repository: 'https://u:p@github.com/a/b', sourceId: id } }))).toBe(true);
    expect(pluginMarketSourceUnverified(item({ sourceType: 'git-market', sourceIdentity: { kind: 'git', repository: 'github.com/a/b', sourceId: id } }))).toBe(false);
    expect(pluginMarketSourceUnverified(item({ sourceType: 'git-market', sourceIdentity: { kind: 'local', sourceId: id } }))).toBe(false);
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

// Dispatcher O-2, R-1, R-2, R-3 (maintainer review 01:21 of #12684; contract V2.10): one decision for every "Open"
// after an operation. It reads only the computer's newest facts: a success receipt is a past result. The facts are the
// computer's own shapes: the contract's three samples byte for byte, and the same rules per situation
// (hostPluginInstallFacts.ts). Minimal failing inputs on 5983ba71dd: a same-version reinstall by the computer or
// another controller still opened after a final receipt; only the catalog's next release (sample ①) lost "Open".
// Tier: unit (pure).
describe('whether a finished operation opens an instance', () => {
  const finished = (entry: 'market-install' | 'update' | 'page-approval' | 'uninstall' | 'enable' | 'task-settings', instanceKey?: string) =>
    ({ operationId: 'operation-1', entry, who: { instanceKey }, detail: entry === 'market-install' || entry === 'update' ? detail : undefined });
  const updated: ManagedPlugin = { ...plugin, manifest: { ...plugin.manifest, version: '2' } };
  const facts = (situation: HostInstallSituation) => hostInstallFacts(situation, { operationId: 'operation-1',
    target: { ...detail, installState: 'installed' }, instance: updated, next: { releaseId: 'release-3', version: '3' } });
  const expected: Record<HostInstallSituation, ReturnType<typeof pluginOperationOpens>> = {
    own: { open: true, instanceKey: '_root__demo' },
    catalogAdvanced: { open: true, instanceKey: '_root__demo' },
    localReinstall: { open: false, reason: 'unconfirmed' },
    otherControllerReinstall: { open: false, reason: 'unconfirmed' },
    bindingLost: { open: false, reason: 'unconfirmed' },
    otherControllerUpdate: { open: false, reason: 'unconfirmed' },
    olderHost: { open: false, reason: 'legacy' },
    uninstalled: { open: false, reason: 'gone' },
  };
  it.each(HOST_INSTALL_SITUATIONS.flatMap((situation) => (['market-install', 'update'] as const).map((entry) => [situation, entry] as const)))(
    '%s, %s', (situation, entry) => {
      const { ghosts, record } = facts(situation);
      // The same answer from the installed snapshot's records and from the market detail, before and after parsing.
      const parsed = parsePluginManagementDetail({ ...record, manifest: { ...manifest, version: record.version } });
      for (const market of [[record], record, parsed])
        expect(pluginOperationOpens(finished(entry, '_root__demo'), { ghosts, market })).toEqual(expected[situation]);
    });
  // The contract's samples as sent (catalog 2.1.0, the computer on 2.0.0), parsed by the phone's own parser.
  it.each([['own', { open: true, instanceKey: 'weather-chip' }], ['unattributed', { open: false, reason: 'unconfirmed' }],
    ['olderHost', { open: false, reason: 'legacy' }]] as const)('contract V2.10 sample %s', (name, opens) => {
    const sample = CONTRACT_SAMPLES[name];
    const target = { ...sample, releaseId: 'custom:Acme%20Team%20Plugins:weather-chip:2.0.0', version: '2.0.0' };
    const ghost: ManagedPlugin = { ...plugin, instanceKey: 'weather-chip', manifest: { ...plugin.manifest, id: 'weather-chip', version: '2.0.0' } };
    const operation = { operationId: CONTRACT_SAMPLE_OPERATION_ID, entry: 'market-install' as const, who: {}, detail: target };
    const parsed = parsePluginManagementDetail({ ...detail, ...sample, manifest: { ...manifest, id: 'weather-chip', version: sample.version } });
    expect(pluginOperationOpens(operation, { ghosts: [ghost], market: parsed })).toEqual(opens);
  });
  // Every shape contract V2.10 lists under ② (not proven), through the phone's parser: never Open, never "older computer".
  it.each(secondShapes('operation-1'))('② %s', (_name, fields) => {
    const parsed = parsePluginManagementDetail({ ...detail, installState: 'update-available', ...fields });
    expect(pluginOperationOpens(finished('market-install'), { ghosts: [updated], market: parsed })).toEqual({ open: false, reason: 'unconfirmed' });
    // The catalog page's parser keeps the same reading.
    const { manifest: _manifest, ...summary } = detail;
    const [item] = parsePluginMarketPage({ items: [{ ...summary, installState: 'update-available', ...fields }] }).items;
    expect(pluginOperationOpens(finished('market-install'), { ghosts: [updated], market: item })).toEqual({ open: false, reason: 'unconfirmed' });
  });
  it.each([
    ['the same name in another namespace', [{ ...updated, instanceKey: 'team__demo', namespace: 'team' }],
      [{ ...detail, namespace: 'team', installState: 'installed' as const, installedOperationId: 'operation-1', installedOperationAttribution: 'self' as const }], 'unconfirmed'],
    // An instance is there but the response names no record of it (the Host sends this shape when it could not read its
    // catalog, for a plugin whose market was removed, and on the first read after an install): what the computer says
    // about this install was not read, so nothing is settled ("could not read", read again); never "not on the computer
    // now", and never "cannot confirm" from a record that was not there to say so. Whether the response calls its market
    // part complete plays no part (minimal failing input on a337ae955c: a complete-looking response gave 'unconfirmed').
    // With no instance of the plugin there at all it is gone.
    ['no record of it, an instance there', [updated], [], 'unread'],
    ['a record saying not installed, an instance there', [updated], [{ ...detail, installState: 'not-installed' as const }], 'unconfirmed'],
    ['no record of it, no instance', [], [], 'gone'],
    // A package of the same id from elsewhere is there: not this attempt's instance, and not "gone" (V2.10: unconfirmed).
    ['a conflict', [updated], [{ ...detail, installState: 'conflict' as const }], 'unconfirmed'],
  ] as const)('install: %s', (_name, ghosts, market, reason) => {
    expect(pluginOperationOpens(finished('market-install'), { ghosts, market })).toEqual({ open: false, reason });
  });
  it('install: what a response does name about the plugin decides, whatever else it left out', () => {
    const own = { ...detail, installState: 'installed' as const, installedOperationId: 'operation-1', installedOperationAttribution: 'self' as const };
    const other = { ...detail, pluginId: 'market/other', ghostId: 'other', name: 'Other', installState: 'installed' as const };
    expect(pluginOperationOpens(finished('market-install'), { ghosts: [updated], market: [other, own] })).toEqual({ open: true, instanceKey: updated.instanceKey });
    // Records of other plugins are not a record of this one.
    expect(pluginOperationOpens(finished('market-install'), { ghosts: [updated], market: [other] })).toEqual({ open: false, reason: 'unread' });
    expect(pluginOperationOpens(finished('market-install'), { ghosts: [], market: [other] })).toEqual({ open: false, reason: 'gone' });
  });
  // The Host shape asserted by apps/desktop plugin-market service.test.ts ("isolated-root"): a server summary carries no
  // `namespace` before the install; once installed the same item is projected with `namespace: null` beside the
  // `_root__<id>` instance. The attempt recorded the item read before the install, so the instance is found by the
  // record of the same response (it failed before: "not on the computer now" for a proven install). Tier: unit (pure).
  it('install: the item read before the install has no namespace; the record beside the instance has the root one', () => {
    const { namespace: _omitted, ...before } = detail;
    const root = { ...updated, instanceKey: '_root__demo', namespace: null };
    const own = { ...detail, namespace: null, installState: 'installed' as const, installedOperationId: 'operation-1', installedOperationAttribution: 'self' as const };
    const operation = { ...finished('market-install'), detail: before };
    expect(pluginOperationOpens(operation, { ghosts: [root], market: [own] })).toEqual({ open: true, instanceKey: '_root__demo' });
    // Still not an org instance of the same id, and never without the computer's evidence.
    expect(pluginOperationOpens(operation, { ghosts: [{ ...root, instanceKey: 'team__demo', namespace: 'team' }], market: [own] })).toEqual({ open: false, reason: 'gone' });
    expect(pluginOperationOpens(operation, { ghosts: [root], market: [{ ...own, installedOperationId: undefined, installedOperationAttribution: 'unattributed' as const }] }))
      .toEqual({ open: false, reason: 'unconfirmed' });
    // The record's namespace is exact: an instance in the older layout (no namespace, keyed by its id) listed first
    // is not taken for the root one the record names.
    const { namespace: _none, ...older } = { ...updated, instanceKey: 'demo' };
    expect(pluginOperationOpens(operation, { ghosts: [older as ManagedPlugin, root], market: [own] })).toEqual({ open: true, instanceKey: '_root__demo' });
  });
  // Contract V2.10 case 7b (Host 0b93a48c25): a remote update of the old simulator migrates it to a new plugin id; after a
  // Host restart (receipt gone) the device that ran it reads 'self' with its id, another device 'unattributed'. On the
  // phone the old instance never pairs with the new market item (other ghostId), so the update entry cannot start it;
  // the market install of the new plugin is the phone's way in, and it opens only for the device that ran it. No new
  // rule; covers existing behaviour. Tier: unit (pure).
  it('contract case 7b: the old simulator migrated by this device opens; another device keeps the result without Open', () => {
    const target = { ...detail, pluginId: 'market/cindy-simulator', ghostId: 'cindy-simulator', installState: 'installed' as const };
    const migrated: ManagedPlugin = { ...plugin, instanceKey: '_root__cindy-simulator', manifest: { ...manifest, id: 'cindy-simulator' } };
    const old: ManagedPlugin = { ...plugin, instanceKey: '_root__baguette-simulator', manifest: { ...manifest, id: 'baguette-simulator' } };
    expect(marketItemMatchesPlugin(target, old)).toBe(false);
    const install = { operationId: 'op-0000000000000001', entry: 'market-install' as const, who: {}, detail: target };
    const read = (fields: Record<string, unknown>) => parsePluginManagementDetail({ ...target, ...fields, manifest: { ...manifest, id: 'cindy-simulator' } });
    expect(pluginOperationOpens(install, { ghosts: [migrated], market: read({ installedOperationAttribution: 'self', installedOperationId: 'op-0000000000000001' }) }))
      .toEqual({ open: true, instanceKey: '_root__cindy-simulator' });
    expect(pluginOperationOpens(install, { ghosts: [migrated], market: read({ installedOperationAttribution: 'unattributed' }) }))
      .toEqual({ open: false, reason: 'unconfirmed' });
  });
  it('update: another instance of the plugin with its own gone', () => {
    const { record } = facts('own');
    expect(pluginOperationOpens(finished('update', '_root__demo'), { ghosts: [{ ...updated, instanceKey: 'demo-copy' }], market: [record] }))
      .toEqual({ open: false, reason: 'gone' });
  });
  it('page approval: its own instance with its pages approved now', () => {
    const approved = { ...plugin, uiCapabilityApproved: true as const };
    expect(pluginOperationOpens(finished('page-approval', '_root__demo'), { ghosts: [approved] })).toEqual({ open: true, instanceKey: '_root__demo' });
    expect(pluginOperationOpens(finished('page-approval', '_root__demo'), { ghosts: [plugin] })).toEqual({ open: false, reason: 'unconfirmed' });
    expect(pluginOperationOpens(finished('page-approval', 'demo-copy'), { ghosts: [approved] })).toEqual({ open: false, reason: 'gone' });
  });
  it.each(['uninstall', 'enable', 'task-settings'] as const)('%s never opens one', (entry) => {
    expect(pluginOperationOpens(finished(entry, '_root__demo'), { ghosts: [updated] })).toMatchObject({ open: false });
  });
});

// Dispatcher O-4: the one decision whether a consent can be allowed (pluginConsentAllowance), field by field. From a
// consent that declares exactly what was chosen (allowed), one declared field changed at a time; each is refused, and
// only the Host's source switch (`originSourceChanged` on an update that comes back as a first install) is the switch
// flow. Minimal failing input on 015469869c: a consent of another source type (or version, kind, plugin) was allowed
// because only custom-market consents were compared. Tier: unit (pure).
describe('whether a consent can be allowed', () => {
  const git = { kind: 'git' as const, repository: 'github.com/acme/plugins', ref: 'main', sourceId: 'SourceA_0123456789abcd' };
  const chosen = { kind: 'update' as const, deviceId: 'host-1', pluginId: 'custom:Acme/demo', ghostId: 'demo', version: '2',
    releaseId: 'release-2', sourceType: 'git-market' as const, source: git };
  const declared = { deviceId: 'host-1', ghostId: 'demo', version: '2', kind: 'update' as const, origin: 'custom-market' as const, source: git };
  it('allows exactly what was chosen', () => {
    expect(pluginConsentAllowance(chosen, declared)).toEqual({ allow: true, sourceSwitch: false });
    expect(pluginConsentAllowance(chosen, { ...declared, kind: 'install', originSourceChanged: true })).toEqual({ allow: true, sourceSwitch: true });
  });
  it.each([
    ['another computer', { deviceId: 'host-2' }, 'changed', 'deviceId'],
    ['another plugin', { ghostId: 'other' }, 'changed', 'ghostId'],
    ['another version', { version: '3' }, 'changed', 'version'],
    ['a first install for an update', { kind: 'install' as const }, 'changed', 'kind'],
    ['an update marked as a source switch', { originSourceChanged: true }, 'changed', 'kind'],
    ['a page approval for an update', { purpose: 'ui-capability' as const }, 'changed', 'purpose'],
    ['the server market (another source type)', { origin: 'market' as const, source: undefined }, 'source-changed', 'sourceType'],
    ['a local file (another source type)', { origin: 'local-file' as const, source: undefined }, 'source-changed', 'sourceType'],
    ['a local folder for a Git market (another source kind)', { source: { kind: 'local' as const, sourceId: git.sourceId } }, 'source-changed', 'sourceType'],
    ['another repository', { source: { ...git, repository: 'github.com/other/plugins' } }, 'source-changed', 'source'],
    ['another ref', { source: { ...git, ref: 'next' } }, 'source-changed', 'source'],
    ['no ref', { source: { kind: 'git' as const, repository: git.repository, sourceId: git.sourceId } }, 'source-changed', 'source'],
    ['another source id', { source: { ...git, sourceId: 'SourceB_0123456789abcd' } }, 'source-changed', 'source'],
    ['no source', { source: undefined }, 'source-unverified', 'source'],
    ['a malformed source', { sourceMalformed: true }, 'source-unverified', 'source'],
  ] as const)('refuses %s', (_name, change, reason, field) => {
    expect(pluginConsentAllowance(chosen, { ...declared, ...change })).toEqual({ allow: false, reason, field });
  });
  it('a first install takes no source switch; the server market asks for the market origin; a page approval its purpose', () => {
    const install = { ...chosen, kind: 'install' as const };
    expect(pluginConsentAllowance(install, { ...declared, kind: 'install' })).toEqual({ allow: true, sourceSwitch: false });
    expect(pluginConsentAllowance(install, { ...declared, kind: 'install', originSourceChanged: true })).toMatchObject({ allow: false, field: 'kind' });
    const server = { ...chosen, sourceType: 'server' as const, source: null };
    expect(pluginConsentAllowance(server, { ...declared, origin: 'market', source: undefined })).toEqual({ allow: true, sourceSwitch: false });
    expect(pluginConsentAllowance(server, declared)).toMatchObject({ allow: false, reason: 'source-changed', field: 'sourceType' });
    const pages = { kind: 'ui-capability' as const, deviceId: 'host-1', ghostId: 'demo', version: '1' };
    expect(pluginConsentAllowance(pages, { deviceId: 'host-1', ghostId: 'demo', version: '1', kind: 'update', purpose: 'ui-capability', origin: 'local-file' }))
      .toEqual({ allow: true, sourceSwitch: false });
    expect(pluginConsentAllowance(pages, { deviceId: 'host-1', ghostId: 'demo', version: '1', kind: 'update', origin: 'local-file' }))
      .toMatchObject({ allow: false, field: 'purpose' });
  });
  it('without a choice (an Agent task card, a prompt started elsewhere) only the declaration rules apply', () => {
    expect(pluginConsentAllowance(null, declaredTaskCardConsent({ ghost_id: 'demo', version: '1', operation: 'install', origin: 'market' }, 'host-1'))).toMatchObject({ allow: true });
    expect(pluginConsentAllowance(null, declaredTaskCardConsent({ ghost_id: 'demo', version: '1', operation: 'install' }, 'host-1'))).toMatchObject({ allow: false, field: 'origin' });
    expect(pluginConsentAllowance(null, declaredTaskCardConsent({ ghost_id: 'demo', version: '1', operation: 'update' }, 'host-1'))).toMatchObject({ allow: true });
    expect(pluginConsentAllowance(null, declaredTaskCardConsent({ operation: 'update', origin: 'custom-market' }, 'host-1'))).toMatchObject({ allow: false, reason: 'source-unverified' });
    expect(pluginConsentAllowance(null, declaredTaskCardConsent({ operation: 'update', origin: 'custom-market', source: { kind: 'git', sourceId: 'x' } }, 'host-1')))
      .toMatchObject({ allow: false, reason: 'source-unverified' });
  });
});

// Dispatcher O-4: the controller checks the same decision right before it writes an Allow, whoever calls it (a sheet
// that missed it, a stale callback). A consent of another source type or kind than the update chosen: no answer
// written, the consent stays to be rejected. Minimal failing input on 015469869c: an official-market update whose
// consent names a custom market wrote Allow. Tier: unit (in-memory Host).
describe('the controller writes Allow only for a consent that declares what was chosen', () => {
  it.each([
    ['another source type', { origin: 'custom-market', originLabel: 'Team', originSource: { kind: 'git', repository: 'github.com/acme/market', sourceId: 'SourceA_0123456789abcd' } }, 'PLUGIN_SOURCE_CHANGED'],
    ['a first install for the update chosen', { facts: { kind: 'install', ghostId: 'demo', name: 'Demo', version: '2', permissions: [] } }, 'PLUGIN_CONSENT_CHANGED'],
    ['another version', { facts: { ...(confirmation().consent!.facts), version: '3' } }, 'PLUGIN_CONSENT_CHANGED'],
  ] as const)('%s', async (_name, change, code) => {
    const h = host((request) => request.actionId === 'management:begin'
      ? { ...confirmation(), consent: { ...confirmation().consent!, ...change } } : receipt('running'));
    const c = controller(h.client); await c.refresh();
    await c.install(detail, plugin);
    expect(c.getState().outcome).toBe('confirmation');
    await c.answer(true);
    expect(h.requests.filter((r) => r.actionId === 'management:answer')).toEqual([]);
    expect(c.getState()).toMatchObject({ outcome: 'confirmation', errorCode: code, busy: false });
    await c.answer(false);
    expect(h.requests.filter((r) => r.actionId === 'management:answer').map((r) => r.input.confirmed)).toEqual([false]);
  });
});
