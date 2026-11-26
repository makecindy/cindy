import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { createPluginManagementClient, type PluginManagementInvoke } from '@/plugins/pluginManagementClient';
import { createPluginManagementController } from '@/plugins/pluginManagementController';
import { pluginOperationOpens } from '@/plugins/pluginOperationOpens';
import type { ManagedMarketDetail, ManagedPlugin, PluginManagementSnapshot } from '@/plugins/pluginManagementTypes';

vi.mock('expo-crypto', () => ({ randomUUID: () => 'operation-1' }));

/* 测试价值（维护者 03:52 复审 c6efda5691：成功后的回读竞态；调度要求按事件排列枚举）
 * - 生产入口与可观察结果：真实 controller + client（只替换传输）。结果到达后 `finalReadback` 与发布的快照。
 * - 依据：结果之后的读取状态只在发布快照处收口，按发出先后判断「结果之后发出」；没有发布就不标 read；读取失败、被取代
 *   且没有接替、断线都进入可恢复的 failed，之后满足条件的发布把它恢复成 read（plugin-mobile-implementation.md）。
 * - 缺口：页面层只有维护者点名的两种顺序；这里把事件的全部合法排列跑一遍。
 * - 事件：结果到达（begin 的回包，或断线后重连按原操作号查回执得知）、回读返回（成功 / 超时）、变更通知刷新发出 / 返回、
 *   断线、重连（自动发出刷新或查回执）、重连读取返回；加上「第一笔 failed → 第二笔开始 → 快照发布」。
 * - 不变量（每一步之后）：标成 read 时，发布的快照一定来自结果之后发出的读取，且按它只会打开 ① 的实例；全部事件之后
 *   一定离开 pending；begin 只发一次。修改前（c6efda5691）这些排列里有失败（见 PR 的验证记录）。tier: unit（纯 controller）。
 * - 单独成文件：pluginManagement.test.ts 已接近单文件预算，这组枚举在 node 环境下运行。
 */

const manifest = { schemaVersion: 3 as const, id: 'demo', name: 'Demo', version: '2', kind: 'chip' };
const detail: ManagedMarketDetail = { pluginId: 'market/demo', ghostId: 'demo', namespace: null, name: 'Demo',
  description: null, author: null, scope: 'public', organizationId: null, defaultInstall: false,
  releaseId: 'release-2', version: '2', publishedAt: '', icon: null, installState: 'not-installed',
  enabled: null, sourceType: 'server', sourceMarketName: null, manifest };
const installed: ManagedPlugin = { instanceKey: '_root__demo', namespace: null, manifest,
  enabled: true, approval: { state: 'approved', revision: '12345678-1234-4123-8123-123456789abc' } };
const capability = { protocolVersion: 1, collections: [{ id: 'plugins', actions: [{ id: 'management:snapshot', label: 'Manage' }] }] };

type Cause = 'setup' | 'result' | 'change' | 'reconnect';
interface Read { cause: Cause; afterResult: boolean; release: (ok: boolean) => void; done: boolean; snapshot: PluginManagementSnapshot }
/**
 * A computer that commits the install as soon as begin reaches it; begin's reply, and every installed read after it, are
 * held until the test releases them. Each read is tagged with the event that sent it and whether the phone knew the
 * result when it went out; its snapshot object carries that tag, so the published one can be traced back.
 */
function world(operationId = 'operation-1') {
  let committed = false, resultKnown = false, cause: Cause = 'setup', begins = 0;
  let beginReply: ((ok: boolean) => void) | undefined;
  const reads: Read[] = [];
  // Which read a published snapshot came from: its reply names it (the parser keeps custom market names).
  const facts = (tag: string): PluginManagementSnapshot => ({ version: 1, ghosts: committed ? [installed] : [],
    market: { items: committed ? [{ ...detail, installState: 'installed', installedOperationId: operationId, installedOperationAttribution: 'self' }] : [],
      unavailableReason: null, customSourceNames: [tag], unavailableCustomSourceNames: [] } });
  const origin = (snapshot: PluginManagementSnapshot | null) => {
    const tag = snapshot?.market.customSourceNames[0];
    return tag?.startsWith('read-') ? reads[Number(tag.slice(5))] : undefined;
  };
  const invoke = (async (_id: string, channel: string, args?: unknown[], options?: { preSend?: () => void; onRequestWritten?: () => void }) => {
    options?.preSend?.();
    options?.onRequestWritten?.();
    if (channel.endsWith(':manifest')) return capability;
    const request = args?.[0] as { actionId: string; input?: Record<string, unknown> };
    if (request.actionId === 'management:market-detail') return { effects: [], result: detail };
    if (request.actionId === 'management:begin') {
      begins += 1; committed = true;
      const ok = await new Promise<boolean>((resolve) => { beginReply = resolve; });
      if (!ok) throw new Error('[TIMEOUT] remote invoke timed out');
      return { effects: [], result: { operationId, phase: 'succeeded' } };
    }
    if (request.actionId === 'management:operation') return { effects: [], result: { operationId, phase: committed ? 'succeeded' : 'running' } };
    if (request.actionId === 'management:snapshot' && request.input?.read === 'capabilities') return { effects: [], result: { catalogPaging: true } };
    if (request.actionId !== 'management:snapshot') throw new Error('unexpected ' + request.actionId);
    if (!committed) return { effects: [], result: facts('setup') };
    const snapshot = facts('read-' + reads.length);
    const read = { cause, afterResult: resultKnown, done: false, snapshot } as Read;
    reads.push(read);
    const ok = await new Promise<boolean>((resolve) => { read.release = resolve; });
    read.done = true;
    if (!ok) throw new Error('[TIMEOUT] remote invoke timed out');
    return { effects: [], result: snapshot };
  }) as unknown as PluginManagementInvoke;
  const client = createPluginManagementClient({ deviceId: 'host-1', invoke });
  return {
    client, reads, origin, begins: () => begins,
    setCause: (next: Cause) => { cause = next; },
    markResultKnown: () => { resultKnown = true; },
    replyBegin: (ok: boolean) => { const reply = beginReply; beginReply = undefined; reply?.(ok); },
    releaseReads: (of: Cause, ok: boolean) => { for (const read of reads) if (read.cause === of && !read.done) read.release(ok); },
  };
}
const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
const controllers: Array<ReturnType<typeof createPluginManagementController>> = [];
beforeEach(() => { setMobileAuthOwner('owner'); });
afterEach(() => { controllers.forEach((value) => value.dispose()); controllers.length = 0; });

type Step = 'result' | 'readback' | 'changeSent' | 'changeBack' | 'offline' | 'online' | 'onlineBack';
const perms = <T,>(items: T[]): T[][] => items.length <= 1 ? [items]
  : items.flatMap((first, index) => perms([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [first, ...rest]));
const legal = (order: Step[]) => {
  const at = (step: Step) => order.indexOf(step);
  const before = (a: Step, b: Step) => at(a) < 0 || at(b) < 0 || at(a) < at(b);
  return before('result', 'readback') && before('changeSent', 'changeBack') && before('offline', 'online') && before('online', 'onlineBack');
};
const sets: Step[][] = [['result', 'readback'], ['result', 'readback', 'changeSent', 'changeBack'],
  ['result', 'readback', 'offline', 'online', 'onlineBack'], ['result', 'readback', 'changeSent', 'changeBack', 'offline', 'online', 'onlineBack']];
const orders = sets.flatMap((set) => perms(set).filter(legal));
const cases = orders.flatMap((order) => [true, false].map((readbackOk) => [order.join(' → ') + (readbackOk ? '' : ' (its read times out)'), order, readbackOk] as const));

describe("a success's read settles only on a snapshot read after the result (maintainer review 03:52)", () => {
  it('has the orders the maintainer reproduced among them', () => {
    expect(cases.length).toBe(2 * (1 + 6 + 10 + 210));
    // M-1: offline while the read is out, it times out, back online, the reconnect read lands.
    expect(cases.some(([, order, ok]) => !ok && order.join() === 'result,offline,readback,online,onlineBack')).toBe(true);
    // M-2: a change refresh goes out after the result, the row's read lands first, then the refresh.
    expect(cases.some(([, order, ok]) => ok && order.join() === 'result,changeSent,readback,changeBack')).toBe(true);
    // A refresh sent before the result is known (it must not count).
    expect(cases.some(([, order]) => order.join() === 'changeSent,result,readback,changeBack')).toBe(true);
  });
  it.each(cases)('%s', async (_label, order, readbackOk) => {
    const w = world();
    const c = createPluginManagementController(w.client, { createOperationId: () => 'operation-1',
      scheduler: { set: () => undefined, clear: () => undefined } });
    controllers.push(c);
    await c.refresh();
    void c.install(detail);
    await flush();
    expect(w.begins()).toBe(1);
    const check = () => {
      const state = c.getState();
      if (state.finalReadback !== 'read') return;
      // Settled only on a published snapshot read after the result arrived on the phone.
      const read = w.origin(state.snapshot);
      expect(read?.afterResult).toBe(true);
      // And "Open" from it only for this operation's proven instance (V2.10 ①).
      expect(pluginOperationOpens({ operationId: 'operation-1', entry: 'market-install', who: {}, detail },
        { ghosts: state.snapshot!.ghosts, market: state.snapshot!.market.items })).toEqual({ open: true, instanceKey: '_root__demo' });
    };
    for (const step of order) {
      switch (step) {
        case 'result':
          // Known now unless a reconnect lookup told it already (begin's late reply then says nothing new).
          if (!['succeeded', 'failed', 'cancelled'].includes(c.getState().outcome)) w.markResultKnown();
          w.setCause('result'); w.replyBegin(true); break;
        case 'readback': w.releaseReads('result', readbackOk); break;
        case 'changeSent': w.setCause('change'); void c.refresh(); break;
        case 'changeBack': w.releaseReads('change', true); break;
        case 'offline': c.setOnline(false); break;
        // Back online: a lookup of the original operation (the result may be learnt here) or a refresh.
        case 'online': w.setCause('reconnect'); if (c.getState().outcome === 'unknown') w.markResultKnown(); c.setOnline(true); break;
        case 'onlineBack': w.releaseReads('reconnect', true); break;
      }
      await flush();
      check();
    }
    // All events happened: never left waiting for a read.
    expect(c.getState().outcome).toBe('succeeded');
    expect(c.getState().finalReadback).not.toBe('pending');
    expect(c.getState().finalReadback).toBeDefined();
    // Recoverable: one more read after it (a refresh, "Read again") that lands settles it on that snapshot.
    w.setCause('change'); void c.refresh();
    await flush();
    w.releaseReads('change', true);
    await flush();
    check();
    expect(c.getState().finalReadback).toBe('read');
    expect(w.begins()).toBe(1);
  });

  // Dispatcher: the first install's read failed (its view handed it over); a second install starts on the same controller.
  // Nothing of the first settles the second: its read state starts over, and only reads after its own result count.
  it('a second install after the first one failed to read starts its read state over', async () => {
    const w = world();
    const c = createPluginManagementController(w.client, { createOperationId: () => 'operation-1',
      scheduler: { set: () => undefined, clear: () => undefined } });
    controllers.push(c);
    await c.refresh();
    void c.install(detail);
    await flush();
    w.markResultKnown(); w.setCause('result'); w.replyBegin(true);
    await flush();
    w.releaseReads('result', false);
    await flush();
    expect(c.getState().finalReadback).toBe('failed');
    // A refresh issued for the first result is still out when the second install starts.
    w.setCause('change'); void c.refresh();
    await flush();
    void c.install(detail);
    await flush();
    expect(c.getState()).toMatchObject({ finalReadback: undefined });
    // The first result's late refresh lands: it settles nothing of the second.
    w.releaseReads('change', true);
    await flush();
    expect(c.getState().finalReadback).toBeUndefined();
  });
});
