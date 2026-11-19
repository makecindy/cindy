/** 测试价值
 * - 生产入口与可观察结果：AgentNetSessionLinks（Agent-Net 会话层上的控制链路）和 routeSessionPeers（按对端选路）。
 *   两台电脑之间不经 Device Link：建链、调用、推送、断线，业务拿到的帧形状、结果与错误码和走 Device Link 时一样；
 *   结果压缩与增量、推送压缩真的在线上起作用（线上字节明显少于原文）。
 * - Bug／规则依据：docs/agent-net-session-plan.md 第 10.1 节（独立上层，业务不改）；2026-11-14 用户要求完整版，
 *   Device Link 的结果压缩、增量与推送压缩都要有。
 * - 现有覆盖缺口：新模块。会话协议本身由 packages/agent-net 的测试覆盖，这里覆盖 Device Link 接口的翻译与选路。
 * - 最小失败输入：一次建链；同一列表读两次（第二次只差一行，走增量）；一条带归属标记的大推送；业务失败结果；
 *   会话断掉时在途的读与写（读报 PEER_RESET 让业务重开后重读一次，写报 DEVICE_OFFLINE 不重试，都标为已发出）与离线事件；
 *   Device Link 上的链路等着恢复时建链与调用都不改走会话；Device Link 空闲时连建链前的调用也走会话，一个对端只走一条路
 *   （2026-11-15 隔离验收：列表与探测先经 Device Link 发出，对端把结果放进本机已不存在的旧链路，59 秒后超时）；原客户端返回它自己时（connectionFor、crossAccountConnection），
 *   拿到的是分路这一层（入口里有「connectionFor(peer) === client」这类身份比较，2026-11-15 隔离验收时发现）；
 *   对端刚连上、会话还在路上时建链与调用先等会话（不等就落到 Device Link 并一直用到断链），宽限期过了或对端没连着就不等；
 *   对端此刻在 Agent-Net 上在线、还没有连接（本机刚启动，2026-11-17 真机）时先连上再等，不在线的不拨、当场交给 Device Link，
 *   拨不了的不等满；对端在中转上签名说开着 Agent-Net、Device Link 要改到主连接重开时，等它的会话再在会话上开；
 *   跨账号（供应商分享）的受邀者第一次建链：分享连接用到时才拨，先连上再等会话，线上编码和 Device Link 给跨账号的一样不压缩、
 *   不做增量，按对端取连接拿到的是那条分享连接，离线事件带它的代次（业务按这个代次丢弃过期事件）。
 * - tier：unit，两个真实的 SessionPeer 在内存里相连，真实的 Node 压缩编码器。 */
import { describe, expect, it, vi } from 'vitest';
import { AgentNetSessionLinks, SESSION_INVOKE_REPLAY, SessionPeer, agentNetSessionLane, routeSessionPeers, type AgentNetSessionLinksOptions, type SessionLane } from '@cindy/agent-net';
import { DeviceLinkError, providerShareGuestPeer, providerShareHostPeer, type DeviceLinkClient, type DeviceLinkPeerRouteStateChanged, type Envelope,
  type InvokeResultPayload } from '@cindy/device-link';
import { desktopTransferCodec } from '../transferCodec';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const openPayload = { controllerName: 'test', protocolVersion: 1, appVersion: 'test' };

/**
 * 控制端与被控端各自一个 AgentNetSessionLinks，会话在内存里按通道依序送达。默认是同账号的 b-controller 与 a-host；
 * 跨账号时两端各用对方的逻辑对端键（受邀者看分享资源的电脑、分享资源一端看受邀者成员）。
 */
function pair(options: { connected?: boolean; connectedAt?(id: string): number | null; hostKey?: string; controllerKey?: string;
  connect?(id: string): Promise<boolean>; agentNetPeer?(id: string): 'online' | 'offline' | null; controllerEpoch?(id: string): number;
  reopenLink?(id: string): void; hostInvokeEpoch?(id: string): string | null; controllerLog?: AgentNetSessionLinksOptions['log'] } = {}) {
  const hostKey = options.hostKey ?? 'a-host', controllerKey = options.controllerKey ?? 'b-controller';
  const sessions: Record<'host' | 'controller', SessionPeer | null> = { host: null, controller: null };
  const bytes = { toHost: 0, toController: 0 };
  /** 控制端写出的每一段数据所在的通道。 */
  const controllerLanes: SessionLane[] = [];
  const links = {
    host: new AgentNetSessionLinks({ session: (id) => (id === controllerKey ? sessions.host : null), connectionEpoch: () => 7,
      selfDeviceId: () => 'a-host', transferCodec: desktopTransferCodec, invokeEpoch: options.hostInvokeEpoch, log: quiet }),
    controller: new AgentNetSessionLinks({ session: (id) => (id === hostKey ? sessions.controller : null), connectionEpoch: options.controllerEpoch ?? (() => 3),
      selfDeviceId: () => 'b-controller', transferCodec: desktopTransferCodec, connectedAt: options.connectedAt, connect: options.connect,
      agentNetPeer: options.agentNetPeer, reopenLink: options.reopenLink, log: options.controllerLog ?? quiet }),
  };
  const receivers: Record<'host' | 'controller', ((lane: SessionLane, data: Uint8Array) => void) | null> = { host: null, controller: null };
  const wire = (side: 'host' | 'controller') => ({
    write: (lane: SessionLane, data: Uint8Array) => {
      const to = side === 'host' ? 'controller' : 'host';
      bytes[to === 'host' ? 'toHost' : 'toController'] += data.length;
      if (side === 'controller') controllerLanes.push(lane);
      const copy = data.slice();
      queueMicrotask(() => receivers[to]?.(lane, copy));
    },
    get bufferedAmount() { return 0; },
    onData: (handler: (lane: SessionLane, data: Uint8Array) => void) => { receivers[side] = handler; },
  });
  const scoped = options.hostKey !== undefined;
  const connect = () => {
    sessions.host = new SessionPeer({ wire: wire('host'), laneFor: agentNetSessionLane, ...(scoped ? { role: 'serve' as const } : {}),
      ...links.host.handlers(controllerKey) });
    sessions.controller = new SessionPeer({ wire: wire('controller'), laneFor: agentNetSessionLane, ...(scoped ? { role: 'call' as const } : {}),
      ...links.controller.handlers(hostKey) });
  };
  if (options.connected !== false) connect();
  return { links, sessions, bytes, connect, controllerLanes };
}

/** 一个空闲的 Device Link 客户端（没有链路、不等恢复、没有待发）：走到它的建链与调用记进 calls。 */
function idleDeviceLink(calls: string[], deviceLinkGeneration = 0): DeviceLinkClient {
  return {
    onPresenceChanged: () => () => {},
    onPeerStreamAccepted: () => () => {},
    onPeerRouteStateChanged: () => () => {},
    getPeerLinkGeneration: () => deviceLinkGeneration,
    isLinkReady: () => false,
    needsLinkRecovery: () => false,
    hasPendingRequestsTo: () => false,
    getReliableSendQueueDepth: () => 0,
    openLink: async (dst: string) => { calls.push(`device-link:openLink:${dst}`); return { appVersion: 'dl', allowlistHash: 'dl' }; },
    invoke: async (dst: string) => { calls.push(`device-link:invoke:${dst}`); return { ok: true, result: 'device-link' }; },
  } as unknown as DeviceLinkClient;
}

/** 被控端接受建链、调用都回 'session'。 */
function answerOnSession(host: AgentNetSessionLinks): void {
  host.onFrame((env) => {
    if (env.kind === 'link-open') host.sendLinkAccept(env.src!, env.id!, { appVersion: 'host', allowlistHash: 'hash' });
    if (env.kind === 'invoke') host.sendInvokeResult(env.src!, env.id!, { ok: true, result: 'session' });
  });
}

function listResult(rows: number, changed = -1) {
  return { items: Array.from({ length: rows }, (_, index) => ({ id: `session-${index}`, title: `Task number ${index}`,
    updatedAt: index === changed ? 2_000_000 : 1_000_000 + index, preview: 'x'.repeat(120) })) };
}

describe('AgentNetSessionLinks', () => {
  // Unit #11345: sharing uses the session adapter too. Earlier saturation tests
  // reserved only control slots; 12 held metadata reads still blocked ordinary
  // model/context calls. Exercise both actual admission and SessionPeer lanes
  // with the existing scoped pair, without importing the renderer or real I/O.
  it('keeps shared catalog preloads inside background capacity while model calls proceed', async () => {
    const hostKey = providerShareHostPeer('share', 'host'), controllerKey = providerShareGuestPeer('share', 'member', 'controller');
    const { links, controllerLanes } = pair({ hostKey, controllerKey });
    const metadata = ['maker:provider:list', 'maker:get-capabilities', 'maker:list-available-agents', 'maker:agent:status'];
    const held: Envelope[] = [], visible: string[] = [];
    const pending: Promise<unknown>[] = [];
    links.host.onFrame(env => {
      if (env.kind === 'link-open') links.host.sendLinkAccept(env.src!, env.id!, { appVersion: 'host', allowlistHash: 'hash' });
      if (env.kind !== 'invoke') return;
      const channel = (env.payload as { channel: string }).channel;
      if (metadata.includes(channel)) held.push(env);
      else {
        visible.push(((env.payload as { args: [{ method: string }] }).args[0]).method);
        links.host.sendInvokeResult(env.src!, env.id!, { ok: true, result: 'visible' });
      }
    });
    await links.controller.openLink(hostKey, openPayload);
    controllerLanes.length = 0;
    for (let n = 0; n < 12; n++) pending.push(links.controller.invoke(hostKey, { channel: metadata[n % metadata.length], args: [] }).catch(error => error));
    const reads = ['setModel', 'getContextUsage'].map(method => links.controller.invoke(hostKey, {
      channel: 'maker:remote-agent:v1', args: [{ op: 'call', method }],
    }));
    pending.push(...reads.map(request => request.catch(error => error)));
    for (let n = 0; n < 20; n++) await Promise.resolve();
    try {
      expect(held).toHaveLength(4);
      expect(visible).toEqual(['setModel', 'getContextUsage']);
      expect(controllerLanes.slice(0, 4)).toEqual(['background', 'background', 'background', 'background']);
      await expect(Promise.all(reads)).resolves.toEqual([{ ok: true, result: 'visible' }, { ok: true, result: 'visible' }]);
    } finally {
      links.controller.closeLink(hostKey, 'user');
      for (const env of held) links.host.sendInvokeResult(env.src!, env.id!, { ok: true, result: null });
      await Promise.allSettled(pending);
      links.controller.stop(); links.host.stop();
    }
    expect(held).toHaveLength(4);
  });

  // Unit #11345: the session route must execute the dispatch-only guard after
  // admission, never after a result. Twelve polls + one cancelled queued poll
  // cover the boundary without changing admission constants or real-time waits.
  it('drops a cancelled queued invoke and preserves an already dispatched result', async () => {
    const { links } = pair();
    const sent: Envelope[] = [];
    links.host.onFrame(env => {
      if (env.kind === 'link-open') links.host.sendLinkAccept(env.src!, env.id!, { appVersion: 'host', allowlistHash: 'hash' });
      if (env.kind === 'invoke') sent.push(env);
    });
    await links.controller.openLink('a-host', openPayload);
    const payload = { channel: 'maker:remote-agent:v1', args: [{ op: 'poll' }] };
    let cancelled = false;
    const guard = () => { if (cancelled) throw new DOMException('cancelled', 'AbortError'); };
    const active = Array.from({ length: 12 }, () => links.controller.invoke('a-host', payload, undefined, { beforeDispatch: guard }));
    await vi.waitFor(() => expect(sent).toHaveLength(12));
    const queued = links.controller.invoke('a-host', payload, undefined, { beforeDispatch: guard }).catch(error => error);
    cancelled = true;
    try {
      for (const env of sent) links.host.sendInvokeResult(env.src!, env.id!, { ok: true, result: 'accepted' });
      expect(await queued).toMatchObject({ name: 'AbortError' });
      expect(await Promise.all(active)).toEqual(Array.from({ length: 12 }, () => ({ ok: true, result: 'accepted' })));
      expect(sent).toHaveLength(12);
    } finally { links.controller.stop(); links.host.stop(); await Promise.allSettled([...active, queued]); }
  });

  // Unit regression #11345: DeviceLinkClient admission coverage did not exercise
  // the Agent-Net route or its wire lane. With 12 polls pending + a full bounded
  // queue, two controls must reach the host on control, the third must fail, and
  // closing must cancel queued uploads without dispatching them on a later link.
  it('admits remote agent controls on their wire lane under bounded saturation', async () => {
    const { links, controllerLanes } = pair();
    const held: Envelope[] = [];
    const controls: Envelope[] = [];
    links.host.onFrame(env => {
      if (env.kind === 'link-open') links.host.sendLinkAccept(env.src!, env.id!, { appVersion: 'host', allowlistHash: 'hash' });
      if (env.kind !== 'invoke') return;
      const request = (env.payload as { args: [{ op: string }] }).args[0];
      if (request.op === 'call') controls.push(env);
      else held.push(env);
    });
    await links.controller.openLink('a-host', openPayload);
    const channel = 'maker:remote-agent:v1';
    const active = Array.from({ length: 12 }, () => links.controller.invoke('a-host', { channel, args: [{ op: 'poll' }] }));
    await vi.waitFor(() => expect(held).toHaveLength(12));
    const queued = Array.from({ length: 128 }, () => links.controller.invoke('a-host', { channel, args: [{ op: 'upload' }] }).catch(error => error));
    controllerLanes.length = 0;
    const control = () => links.controller.invoke('a-host', { channel, args: [{ op: 'call', method: 'abort' }] });
    const admitted = [control(), control()];
    // Flush only microtasks; failing classification must not turn into a real 30s wait.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    try {
      expect(controls).toHaveLength(2);
      expect(controllerLanes).toEqual(['control', 'control']);
      await expect(control()).rejects.toMatchObject({ code: 'BACKPRESSURE' });
    } finally {
      links.controller.closeLink('a-host', 'user');
      for (const env of [...held, ...controls]) links.host.sendInvokeResult(env.src!, env.id!, { ok: true, result: null });
      await Promise.allSettled([...active, ...admitted, ...queued]);
      links.controller.stop(); links.host.stop();
    }
    expect(held).toHaveLength(12);
    expect(await Promise.all(queued)).toEqual(Array.from({ length: 128 }, () => expect.objectContaining({ code: 'LINK_NOT_OPEN' })));
  });

  it('opens a control link and reads a list through the same result compression and delta as Device Link', async () => {
    const { links, bytes } = pair();
    let result: unknown = listResult(200);
    const hostFrames: Envelope[] = [];
    links.host.onFrame((env) => {
      hostFrames.push(env);
      if (env.kind === 'link-open') links.host.sendLinkAccept(env.src!, env.id!, { appVersion: 'host', allowlistHash: 'hash', capabilities: ['github-read-v1'] });
      if (env.kind === 'invoke') links.host.sendInvokeResult(env.src!, env.id!, { ok: true, result });
    });
    await expect(links.controller.openLink('a-host', openPayload)).resolves.toMatchObject({ appVersion: 'host' });
    expect(hostFrames[0]).toMatchObject({ kind: 'link-open', src: 'b-controller', payload: { controllerName: 'test' } });
    expect(links.controller.isLinkReady('a-host')).toBe(true);
    expect(links.controller.getPeerLinkGeneration('a-host')).toBe(1);
    expect(links.host.getPeerLinkGeneration('b-controller')).toBe(1);

    const raw = JSON.stringify(result).length;
    let before = bytes.toController;
    await expect(links.controller.invoke('a-host', { channel: 'local-db:sessions:list', args: [{ limit: 200 }] })).resolves
      .toEqual({ ok: true, result: listResult(200) });
    expect(bytes.toController - before).toBeLessThan(raw / 4);
    expect(hostFrames[1]).toMatchObject({ kind: 'invoke', src: 'b-controller', payload: { channel: 'local-db:sessions:list', transfer: { gzip: 1, delta: 1 } } });

    result = listResult(200, 5);
    before = bytes.toController;
    await expect(links.controller.invoke('a-host', { channel: 'local-db:sessions:list', args: [{ limit: 200 }] })).resolves
      .toEqual({ ok: true, result: listResult(200, 5) });
    // 第二次带着上次的版本号去，只差一行：回来的只有增量。
    expect(bytes.toController - before).toBeLessThan(2_000);
  });

  it('delivers a compressed push with its owner stamp and returns business failures as results', async () => {
    const { links, bytes } = pair();
    const controllerFrames: Envelope[] = [];
    links.controller.onFrame((env) => { controllerFrames.push(env); });
    links.host.onFrame((env) => {
      if (env.kind === 'link-open') links.host.sendLinkAccept(env.src!, env.id!, { appVersion: 'host', allowlistHash: 'hash' });
      if (env.kind === 'invoke') links.host.sendInvokeResult(env.src!, env.id!, { ok: false, error: { code: 'CHANNEL_NOT_ALLOWED', message: 'no' } });
    });
    await links.controller.openLink('a-host', openPayload);
    const payload = { sessionId: 's1', events: Array.from({ length: 80 }, (_, index) => ({ type: 'text', text: `streamed text chunk ${index} `.repeat(4) })) };
    const ownerStamp = { ownerUserId: 'user-1', ownerEpoch: 4 } as never;
    const before = bytes.toController;
    links.host.sendPush('b-controller', 'maker:event-batch', payload, ownerStamp);
    await expect.poll(() => controllerFrames.length).toBe(1);
    expect(controllerFrames[0]).toMatchObject({ kind: 'push', src: 'a-host', payload: { channel: 'maker:event-batch', payload, ownerStamp } });
    expect(bytes.toController - before).toBeLessThan(JSON.stringify(payload).length / 3);

    await expect(links.controller.invoke('a-host', { channel: 'local-db:sessions:get', args: ['s1'] })).resolves
      .toEqual({ ok: false, error: { code: 'CHANNEL_NOT_ALLOWED', message: 'no' } } satisfies InvokeResultPayload);
  });

  it('fails calls in flight when the session breaks and reports the peer offline at its link generation', async () => {
    const lines: string[] = [];
    const { links, sessions } = pair({ controllerLog: { ...quiet, debug: (line: string) => { lines.push(line); }, warn: (line: string) => { lines.push(line); } } });
    links.host.onFrame((env) => {
      if (env.kind === 'link-open') links.host.sendLinkAccept(env.src!, env.id!, { appVersion: 'host', allowlistHash: 'hash' });
    });
    const offline: unknown[] = [];
    links.controller.onPeerRouteStateChanged((change) => offline.push(change));
    await links.controller.openLink('a-host', openPayload);
    const read = links.controller.invoke('a-host', { channel: 'local-db:sessions:get', args: ['never-answered'] });
    // 写在途时会话断了：在自己的时限内等链路重开（见下一个用例）；这里没人重开，时限到了才报「可能已执行」。
    const write = links.controller.invoke('a-host', { channel: 'maker:send-message', args: ['s1', 'hello'] }, 40);
    await expect.poll(() => links.controller.hasPendingRequestsTo('a-host')).toBe(true);
    sessions.controller!.dispose('DEVICE_OFFLINE');
    await expect(read).rejects.toMatchObject({ code: 'PEER_RESET', inFlight: true });
    await expect(write).rejects.toMatchObject({ code: 'DEVICE_OFFLINE', inFlight: true });
    // 会话上的请求日志和 Device Link 的一样能查（2026-11-17）：通道（不在远程调用名单里的写 unknown，这里的测试通道就是）、设备、错误码与耗时，
    // 不写参数（消息正文）。
    const logged = lines.find((line) => line.startsWith('agent-net session request failed channel=unknown'));
    expect(logged).toMatch(/code=DEVICE_OFFLINE elapsed=\d+ms$/);
    expect(lines.join('\n')).not.toContain('hello');
    expect(offline).toEqual([{ deviceId: 'a-host', state: 'offline', connectionEpoch: 3, linkGeneration: 1 }]);
    expect(links.controller.isLinkReady('a-host')).toBe(false);
    expect(links.controller.needsLinkRecovery('a-host')).toBe(true);
    // 会话没了以后的调用没写出去：LINK_NOT_OPEN、不算已发出，业务可以放心重开再发。
    await expect(links.controller.invoke('a-host', { channel: 'local-db:sessions:get', args: [] })).rejects
      .toSatisfy((error) => error instanceof DeviceLinkError && error.code === 'LINK_NOT_OPEN' && error.inFlight !== true);
  });

  // 2026-11-17 审查：写在途时连接断了（换网、对方重建节点），Device Link 重连后按原序号续传、结果照样回来；会话上原来直接报
  // 「可能已执行」，界面显示发送失败。现在会话回来时请业务重开链路，重开后用原请求号再发，对方按请求号去重，只执行一次。
  it('sends a write that was in flight when the session broke again on the re-opened link, with its request id, so it runs once', async () => {
    let controller: AgentNetSessionLinks | null = null;
    const { links, sessions, connect } = pair({ reopenLink: (id) => { void controller?.openLink(id, openPayload); }, hostInvokeEpoch: () => 'run-1' });
    controller = links.controller;
    const seen: string[] = [];
    const replay: Array<true | undefined> = [];
    links.host.onFrame((env) => {
      if (env.kind === 'link-open') links.host.sendLinkAccept(env.src!, env.id!, { appVersion: 'host', allowlistHash: 'hash' });
      if (env.kind !== 'invoke') return;
      const payload = env.payload as { [SESSION_INVOKE_REPLAY]?: true };
      replay.push(payload[SESSION_INVOKE_REPLAY]);
      if (seen.push(env.id!) === 2) links.host.sendInvokeResult(env.src!, env.id!, { ok: true, result: 'sent once' });
    });
    await links.controller.openLink('a-host', openPayload);
    const write = links.controller.invoke('a-host', { channel: 'maker:send-message', args: ['s1', 'hello'] }, 5_000);
    await expect.poll(() => seen.length).toBe(1);
    sessions.controller!.dispose('DEVICE_OFFLINE');
    sessions.host!.dispose('DEVICE_OFFLINE');
    connect();
    await expect(write).resolves.toEqual({ ok: true, result: 'sent once' });
    expect(seen).toEqual([seen[0], seen[0]]);
    expect(replay).toEqual([undefined, true]);
    expect(links.controller.getPeerLinkGeneration('a-host')).toBe(2);
  });

  // 跨账号（供应商分享）同样续：分享连接是用到时才拨的，会话断时马上请业务重开（重开循环先拨通对方电脑），重开后用原请求号再发。
  it('sends a guest write again on the re-dialed share connection after its session broke, and it runs once', async () => {
    const hostKey = providerShareHostPeer('share-1', 'a-host'), guestKey = providerShareGuestPeer('share-1', 'member-1', 'g-guest');
    let controller: AgentNetSessionLinks | null = null;
    let reopening = false;
    const { links, sessions, connect } = pair({ hostKey, controllerKey: guestKey, hostInvokeEpoch: () => 'run-1',
      reopenLink: (id) => {
        if (reopening) return;
        reopening = true;
        connect();
        void controller?.openLink(id, openPayload).finally(() => { reopening = false; });
      } });
    controller = links.controller;
    const seen: string[] = [];
    links.host.onFrame((env) => {
      if (env.kind === 'link-open') links.host.sendLinkAccept(env.src!, env.id!, { appVersion: 'host', allowlistHash: 'hash' });
      if (env.kind === 'invoke' && seen.push(env.id!) === 2) links.host.sendInvokeResult(env.src!, env.id!, { ok: true, result: 'sent once' });
    });
    await links.controller.openLink(hostKey, openPayload);
    const write = links.controller.invoke(hostKey, { channel: 'maker:send-message', args: ['s1', 'hello'] }, 5_000);
    await expect.poll(() => seen.length).toBe(1);
    sessions.controller!.dispose('DEVICE_OFFLINE');
    sessions.host!.dispose('DEVICE_OFFLINE');
    await expect(write).resolves.toEqual({ ok: true, result: 'sent once' });
    expect(seen).toEqual([seen[0], seen[0]]);
  });

  // 对方中途重启（或清空了去重记忆：登出、关远程控制）：它已经不记得那次请求，再发会重复执行；和原来一样报「可能已执行」，不再发。
  it('does not send a write again once the re-opened link says the peer no longer remembers it', async () => {
    let controller: AgentNetSessionLinks | null = null;
    let run = 'run-1';
    const { links, sessions, connect } = pair({ reopenLink: (id) => { void controller?.openLink(id, openPayload); }, hostInvokeEpoch: () => run });
    controller = links.controller;
    const seen: string[] = [];
    links.host.onFrame((env) => {
      if (env.kind === 'link-open') links.host.sendLinkAccept(env.src!, env.id!, { appVersion: 'host', allowlistHash: 'hash' });
      if (env.kind === 'invoke') seen.push(env.id!);
    });
    await links.controller.openLink('a-host', openPayload);
    const write = links.controller.invoke('a-host', { channel: 'maker:send-message', args: ['s1', 'hello'] }, 5_000);
    await expect.poll(() => seen.length).toBe(1);
    sessions.controller!.dispose('DEVICE_OFFLINE');
    sessions.host!.dispose('DEVICE_OFFLINE');
    run = 'run-2';
    connect();
    await expect(write).rejects.toMatchObject({ code: 'DEVICE_OFFLINE', inFlight: true });
    expect(seen).toHaveLength(1);
    await expect.poll(() => links.controller.getPeerLinkGeneration('a-host')).toBe(2);
  });

  // 2026-11-17 审查：对方撤了本机的权限、或关了远程控制，Device Link 当场报错；会话上原来要等满建链超时，界面一直在连接中。
  it('ends a control link the target refuses at once, as Device Link does, instead of waiting for the timeout', async () => {
    const { links } = pair();
    links.host.onFrame((env) => { if (env.kind === 'link-open') links.host.closeLink(env.src!, 'revoked', 'inbound'); });
    const startedAt = performance.now();
    await expect(links.controller.openLink('a-host', openPayload, 20_000)).rejects.toMatchObject({ code: 'ACCESS_REVOKED' });
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(links.controller.ownsOutbound('a-host')).toBe(false);
    // 对方的 presence 说关了远程控制：不发出去，当场报 REMOTE_DISABLED。
    links.controller.noteRemoteControlDisabled('a-host');
    await expect(links.controller.openLink('a-host', openPayload)).rejects.toMatchObject({ code: 'REMOTE_DISABLED' });
  });

  it('routes a peer to the session unless a Device Link link is up or waiting to recover, and replies on the path a request came by', async () => {
    const { links } = pair();
    links.host.onFrame((env) => {
      if (env.kind === 'link-open') links.host.sendLinkAccept(env.src!, env.id!, { appVersion: 'host', allowlistHash: 'hash' });
      if (env.kind === 'invoke') links.host.sendInvokeResult(env.src!, env.id!, { ok: true, result: 'session' });
    });
    const calls: string[] = [];
    let deviceLinkRecovering = true;
    const deviceLink = {
      onPresenceChanged: () => () => {},
      isLinkReady: () => false,
      needsLinkRecovery: () => deviceLinkRecovering,
      // 列表这类不需要链路的请求还在途：不挡会话。
      hasPendingRequestsTo: () => true,
      getReliableSendQueueDepth: () => 0,
      openLink: async () => { calls.push('device-link:openLink'); return { appVersion: 'dl', allowlistHash: 'dl' }; },
      invoke: async () => { calls.push('device-link:invoke'); return { ok: true, result: 'device-link' }; },
      sendInvokeResult: () => { calls.push('device-link:sendInvokeResult'); },
      connectionFor() { return deviceLink; },
      crossAccountConnection() { return deviceLink; },
    } as unknown as DeviceLinkClient;
    const controller = routeSessionPeers(deviceLink, links.controller);
    expect(controller.connectionFor('peer-on-device-link')).toBe(controller);
    expect(controller.crossAccountConnection()).toBe(controller);
    await expect(controller.invoke('a-host', { channel: 'device-link:remote-desktop:v1', args: [] })).resolves.toEqual({ ok: true, result: 'device-link' });
    await expect(controller.openLink('a-host', openPayload)).resolves.toMatchObject({ appVersion: 'dl' });
    deviceLinkRecovering = false;
    // 还没建链的调用也走会话。
    await expect(controller.invoke('a-host', { channel: 'device-link:remote-desktop:v1', args: [] })).resolves.toEqual({ ok: true, result: 'session' });
    await expect(controller.openLink('a-host', openPayload)).resolves.toMatchObject({ appVersion: 'host' });
    expect(calls).toEqual(['device-link:invoke', 'device-link:openLink']);
    expect(controller.isLinkReady('a-host')).toBe(true);
    expect(controller.connectionFor('a-host')).toBe(controller);
    // 不是从会话来的请求，结果交回 Device Link。
    controller.sendInvokeResult('a-host', 'request-from-device-link', { ok: true, result: 1 });
    expect(calls).toEqual(['device-link:invoke', 'device-link:openLink', 'device-link:sendInvokeResult']);
  });

  it('waits for the session of a peer that just connected instead of settling on Device Link, and only within the grace period', async ({ onTestFinished }) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    onTestFinished(() => { vi.useRealTimers(); });
    const connectedAt = new Map<string, number>([['a-host', performance.now()]]);
    const { links, connect } = pair({ connected: false, connectedAt: (id) => connectedAt.get(id) ?? null });
    answerOnSession(links.host);
    const calls: string[] = [];
    const controller = routeSessionPeers(idleDeviceLink(calls), links.controller);
    // 连接刚建好、会话还没到：建链与之前的调用都等它，到了就走会话。
    const probe = controller.invoke('a-host', { channel: 'device-link:remote-desktop:v1', args: [] });
    const opened = controller.openLink('a-host', openPayload);
    setTimeout(connect, 20);
    await vi.advanceTimersByTimeAsync(20);
    await expect(probe).resolves.toEqual({ ok: true, result: 'session' });
    await expect(opened).resolves.toMatchObject({ appVersion: 'host' });
    expect(calls).toEqual([]);
    // 没连着的对端不等，照常交给 Device Link（离线时立即失败，不拖慢）。
    void controller.invoke('offline-peer', { channel: 'device-link:remote-desktop:v1', args: [] });
    expect(calls).toEqual(['device-link:invoke:offline-peer']);
    // 连上快满宽限期还没有会话（对端没启用会话）：等到宽限期结束改走 Device Link，之后不再等。
    connectedAt.set('c-old', performance.now() - 1450.25);
    const late = controller.openLink('c-old', openPayload);
    await vi.advanceTimersByTimeAsync(49);
    expect(calls).toEqual(['device-link:invoke:offline-peer']);
    // Only 49.75 ms remained when the timer was scheduled.
    await vi.advanceTimersByTimeAsync(1);
    await expect(late).resolves.toMatchObject({ appVersion: 'dl' });
    void controller.invoke('c-old', { channel: 'device-link:remote-desktop:v1', args: [] });
    expect(calls).toEqual(['device-link:invoke:offline-peer', 'device-link:openLink:c-old', 'device-link:invoke:c-old']);
  });

  // 2026-11-17 真机：本机刚启动 22 毫秒就向同账号的 Host 建链，和它的 Agent-Net 连接 0.3 秒后才建好；这一次按「没连着」交给了
  // Device Link，第一条消息成了 Device Link 的帧，这条链路之后一直不换路。对方此刻在 Agent-Net 上在线时先连上再等会话。
  it('connects first to an online peer it has no connection to yet, so the first link starts on the session', async () => {
    const connectedAt = new Map<string, number>([['c-old', performance.now() - 5000]]);
    const online = new Set(['a-host', 'c-old', 'd-gone']);
    const dialed: string[] = [];
    const { links, connect } = pair({ connected: false, connectedAt: (id) => connectedAt.get(id) ?? null,
      agentNetPeer: (id) => (online.has(id) ? 'online' : null),
      connect: async (id) => {
        dialed.push(id);
        if (id !== 'a-host') return false;
        connectedAt.set(id, performance.now()); setTimeout(connect, 20); return true;
      } });
    answerOnSession(links.host);
    const calls: string[] = [];
    const controller = routeSessionPeers(idleDeviceLink(calls), links.controller);
    await expect(controller.openLink('a-host', openPayload)).resolves.toMatchObject({ appVersion: 'host' });
    await expect(controller.invoke('a-host', { channel: 'local-db:sessions:list', args: [] })).resolves.toEqual({ ok: true, result: 'session' });
    expect(dialed).toEqual(['a-host']);
    expect(calls).toEqual([]);
    // 不在 Agent-Net 上在线（或本机关着 Agent-Net）：不拨，当场交给 Device Link，和原来一样同步。
    void controller.openLink('offline-peer', openPayload);
    expect(calls).toEqual(['device-link:openLink:offline-peer']);
    // 早就连着却没有会话的旧版对端：不拨也不等。
    void controller.openLink('c-old', openPayload);
    expect(calls).toEqual(['device-link:openLink:offline-peer', 'device-link:openLink:c-old']);
    // 拨不了（目录还说在线，其实刚下线）：不等满宽限期，马上交给 Device Link（真机上曾先等 3 秒再走 Device Link 又等 3 秒）。
    const goneAt = performance.now();
    await expect(controller.openLink('d-gone', openPayload)).resolves.toMatchObject({ appVersion: 'dl' });
    expect(performance.now() - goneAt).toBeLessThan(500);
    expect(dialed).toEqual(['a-host', 'd-gone']);
  });

  // 同日真机：Host 重启时先连上 Device Link 中转，0.7 秒后才上 Agent-Net；控制端在这段时间里重试建链，中转上的探测拿到它
  // 「开着 Agent-Net」的签名回答，Device Link 改到主连接上重开，link-open 在会话出现之前作为 Device Link 的帧排进连接。
  it('opens the re-open of a peer that attested Agent-Net on its session once it arrives, and on the main connection otherwise', async () => {
    const connectedAt = new Map<string, number>([['c-old', performance.now() - 5000]]);
    const { links, connect } = pair({ connected: false, connectedAt: (id) => connectedAt.get(id) ?? null });
    answerOnSession(links.host);
    let primaryOpens = 0;
    const primary = async () => { primaryOpens++; return { appVersion: 'dl', allowlistHash: 'dl' }; };
    const opening = links.controller.openAttested('a-host', openPayload, undefined, primary);
    setTimeout(connect, 20); // 它上了 Agent-Net，两端自己连上
    await expect(opening).resolves.toMatchObject({ appVersion: 'host' });
    expect(primaryOpens).toBe(0);
    expect(links.controller.ownsOutbound('a-host')).toBe(true);
    // 连着却过了宽限期仍没有会话（没有会话层的 Agent-Net 旧版）：当场按原来在主连接上开，不等满。
    const oldAt = performance.now();
    await expect(links.controller.openAttested('c-old', openPayload, undefined, primary)).resolves.toMatchObject({ appVersion: 'dl' });
    expect(performance.now() - oldAt).toBeLessThan(500);
    expect(primaryOpens).toBe(1);
  });

  // 2026-11-17 排查：① 会话上什么推送都收，同账号的一台电脑没建链也能往业务里推任意通道（Device Link 只收链路上的和三个无链路通道）；
  // ② 允许被控请求等无链路推送仍走 Device Link；③ 远程桌面续租心跳排在普通通道里，和任务列表、历史页抢。
  it('takes pushes only on a control link except the unlinked ones, sends those on the session, and renews remote desktop on control', async () => {
    const { links, sessions, controllerLanes } = pair();
    answerOnSession(links.host);
    const received: string[] = [];
    links.controller.onFrame((env) => { if (env.kind === 'push') received.push((env.payload as { channel: string }).channel); });
    const hostPushes: string[] = [];
    links.host.onFrame((env) => { if (env.kind === 'push') hostPushes.push((env.payload as { channel: string }).channel); });
    // No control link yet: an ordinary push is dropped, the consent request is not.
    links.host.sendPush('b-controller', 'maker:event', { text: 'x' });
    // The outer topic and the wrapped topic must describe the same push.
    sessions.host!.push('device-link:remote-control-consent', { channel: 'device-link:voice:dictionary:sync-state', payload: { v: 1 } });
    links.host.sendPush('b-controller', 'device-link:remote-control-consent', { op: 'request' });
    // 自己电脑之间的词典同步也不需要链路（2026-11-17 审查：原来成了连接上的 Device Link 帧）。
    links.host.sendPush('b-controller', 'device-link:voice:dictionary:sync-state', { v: 1 });
    await vi.waitFor(() => expect(received).toEqual(['device-link:remote-control-consent', 'device-link:voice:dictionary:sync-state']));
    // The controller's own unlinked push goes on the session, not the idle Device Link.
    const calls: string[] = [];
    const deviceLink = { ...idleDeviceLink(calls), sendPush: (dst: string) => calls.push(`device-link:sendPush:${dst}`) } as unknown as DeviceLinkClient;
    const controller = routeSessionPeers(deviceLink, links.controller);
    controller.sendPush('a-host', 'device-link:remote-control-consent', { op: 'request' });
    controller.sendPush('a-host', 'device-link:voice:dictionary:sync-state', { v: 1 });
    controller.sendPush('a-host', 'maker:event', { text: 'y' });
    await vi.waitFor(() => expect(hostPushes).toEqual(['device-link:remote-control-consent', 'device-link:voice:dictionary:sync-state']));
    expect(calls).toEqual(['device-link:sendPush:a-host']);
    // Remote desktop: the lease heartbeat on the control lane, a screenshot on the normal one.
    await controller.openLink('a-host', openPayload);
    controllerLanes.length = 0;
    await controller.invoke('a-host', { channel: 'device-link:remote-desktop:v1', args: [{ op: 'heartbeat', lease: 'l' }] });
    expect(controllerLanes).toEqual(['control']);
    controllerLanes.length = 0;
    await controller.invoke('a-host', { channel: 'device-link:remote-desktop:v1', args: [{ op: 'frame', lease: 'l' }] });
    expect(controllerLanes).toEqual(['normal']);
    // On the link, an ordinary push arrives again.
    links.host.sendPush('b-controller', 'maker:event', { text: 'z' });
    await vi.waitFor(() => expect(received).toEqual(['device-link:remote-control-consent', 'device-link:voice:dictionary:sync-state', 'maker:event']));
  });

  // 2026-11-17 真机复验：对方经会话推回文件夹的包时，1 MiB 的块按大小走后台通道，最后一小块走普通通道、越过前面还在路上的大块先到，
  // 按顺序追加的接收端拒收（FILE_PEER_BLOCK），整包改走云端中转。同一次上传的块都走后台通道，按发出顺序到。
  it('keeps the blocks of one upload in send order on the background lane, the small last one too', async () => {
    const { links, controllerLanes } = pair();
    const order: number[] = [];
    links.host.onFrame((env) => {
      if (env.kind === 'link-open') links.host.sendLinkAccept(env.src!, env.id!, { appVersion: 'host', allowlistHash: 'hash' });
      if (env.kind !== 'invoke') return;
      order.push((env.payload as { args: [{ block: number }] }).args[0].block);
      links.host.sendInvokeResult(env.src!, env.id!, { ok: true, result: '{}' });
    });
    await links.controller.openLink('a-host', openPayload);
    controllerLanes.length = 0;
    const write = (block: number, bytes: number) => links.controller.invoke('a-host', { channel: 'device-link:file-peer',
      args: [{ action: 'stream-rpc', connection: '00000000-0000-4000-8000-000000000000', block, payload: '{}', body: 'A'.repeat(bytes) }] });
    await Promise.all([write(0, 1_398_104), write(1, 1_398_104), write(2, 4_096)]);
    expect(order).toEqual([0, 1, 2]);
    expect([...new Set(controllerLanes)]).toEqual(['background']);
  });

  // 2026-11-19 公网对照（xdt-server 中转，250 KB/s、往返 220 ms）：远程任务启动时上传块一次 2～4 块在途，走普通通道时停止要排在它们后面，
  // 往返从 0.4 秒涨到 1.3 秒，64 KB/s 时到 5.5 秒。上传块走后台通道，同一任务的其他远程任务调用照旧走普通通道。
  it('sends remote-agent upload chunks on the background lane and the other remote-agent calls on the normal lane', async () => {
    const { links, controllerLanes } = pair();
    answerOnSession(links.host);
    await links.controller.openLink('a-host', openPayload);
    controllerLanes.length = 0;
    await links.controller.invoke('a-host', { channel: 'maker:remote-agent:v1', args: [{ op: 'upload', uploadId: 'u1', index: 0, data: 'AAAA' }] });
    expect(controllerLanes).toEqual(['background']);
    controllerLanes.length = 0;
    await links.controller.invoke('a-host', { channel: 'maker:remote-agent:v1', args: [{ op: 'poll', runs: [], waitMs: 0 }] });
    expect(controllerLanes).toEqual(['normal']);
  });

  // 2026-11-17 排查：会话上的建链总报同一个流标识，共享任务的主人电脑重启后来源代次不前进，界面把新推送当旧的丢掉；会话断开时先清链路
  // 状态再发离线事件，按对端取的代次落回 Device Link 的，它在 Device Link 上建过更多次链路时离线事件被当成过期丢掉（index.ts 比代次）。
  it('reports a new stream per session and keeps the session generation for its offline event', async () => {
    const { links, sessions, connect } = pair();
    answerOnSession(links.host);
    const calls: string[] = [];
    const controller = routeSessionPeers(idleDeviceLink(calls, 5), links.controller);
    const streams: string[] = [];
    controller.onPeerStreamAccepted((_peer, streamId) => streams.push(streamId));
    const offline: Array<{ event: number; current: number }> = [];
    controller.onPeerRouteStateChanged((change) => {
      if (change.state === 'offline') offline.push({ event: change.linkGeneration, current: controller.getPeerLinkGeneration(change.deviceId) });
    });
    await controller.openLink('a-host', openPayload);
    controller.closeLink('a-host', 'user');
    await controller.openLink('a-host', openPayload); // same session: same stream
    sessions.controller!.dispose('DEVICE_OFFLINE'); sessions.host!.dispose('DEVICE_OFFLINE');
    // The offline event's generation is the one the business reads back for this peer, not Device Link's 5.
    expect(offline).toEqual([{ event: 2, current: 2 }]);
    connect(); // the host restarted: a new session
    await controller.openLink('a-host', openPayload);
    expect(streams).toHaveLength(3);
    expect(streams[1]).toBe(streams[0]);
    expect(streams[2]).not.toBe(streams[0]);
    expect(calls).toEqual([]);
  });

  // 2026-11-17 review：会话断了、重开落到 Device Link（会话没及时回来）以后，控制方向的状态要改由 Device Link 报。原来会话上那条
  // 「断了待恢复」「被本机关过」一直留着：这个对端永远「待恢复」，每次调用都先再建一次链、接受后的补订阅又触发重建；断开发不到
  // Device Link 那条；用户关过一次，之后 Device Link 上的链路断了也不自动重建。对端经会话控制本机、会话断了时，按对端取连接还是这一层，
  // 离线事件按会话的代次比（换成原连接会拿 Device Link 的代次去比，事件被当成过期丢掉）。
  it('hands the control direction back to Device Link once a re-open lands there, and keeps the session generation for a dropped inbound link', async () => {
    const { links, sessions, connect } = pair();
    answerOnSession(links.host);
    const calls: string[] = [];
    let deviceLinkReady = false;
    const legacy = { getPeerLinkGeneration: () => 9 };
    const deviceLink = {
      ...idleDeviceLink(calls, 9),
      isLinkReady: () => deviceLinkReady,
      isOutboundExplicitlyClosed: () => false,
      closeLink: (dst: string, reason: string) => { calls.push(`device-link:closeLink:${dst}:${reason}`); },
      sendLinkAccept: () => {},
      connectionFor: () => legacy,
    } as unknown as DeviceLinkClient;
    const controller = routeSessionPeers(deviceLink, links.controller);
    const dropSession = () => { sessions.controller!.dispose('DEVICE_OFFLINE'); sessions.host!.dispose('DEVICE_OFFLINE'); };
    const reopenOnDeviceLink = async () => {
      await expect(controller.openLink('a-host', openPayload)).resolves.toMatchObject({ appVersion: 'dl' });
      deviceLinkReady = true;
    };

    // 用户关过会话上的链路，会话又断了，重开落到 Device Link：不再算「本机显式关过」。
    await controller.openLink('a-host', openPayload);
    controller.closeLink('a-host', 'user');
    expect(controller.isOutboundExplicitlyClosed('a-host')).toBe(true);
    dropSession();
    await reopenOnDeviceLink();
    expect(controller.isOutboundExplicitlyClosed('a-host')).toBe(false);

    // Device Link 那条断了，会话回来了：在会话上开；会话又断，重开落到 Device Link：不再「待恢复」，断开交给 Device Link。
    deviceLinkReady = false;
    connect();
    await controller.openLink('a-host', openPayload);
    dropSession();
    expect(controller.needsLinkRecovery('a-host')).toBe(true);
    await reopenOnDeviceLink();
    expect(controller.needsLinkRecovery('a-host')).toBe(false);
    controller.closeLink('a-host', 'user');
    expect(calls).toEqual(['device-link:openLink:a-host', 'device-link:openLink:a-host', 'device-link:closeLink:a-host:user']);

    // 被控端：对端经会话控制本机，会话断了。离线事件发出时，按对端取到的连接报的是会话的代次。
    const host = routeSessionPeers(deviceLink, links.host);
    const seen: Array<{ event: number; current: number }> = [];
    host.onPeerRouteStateChanged((change) => {
      seen.push({ event: change.linkGeneration, current: host.connectionFor(change.deviceId).getPeerLinkGeneration(change.deviceId) });
    });
    connect();
    await links.controller.openLink('a-host', openPayload);
    dropSession();
    expect(seen).toEqual([{ event: 3, current: 3 }]);
  });

  // 跨账号（2026-11-16，第三步）：受邀者的分享连接是用到时才拨的，第一次建链先连上再等会话；线上编码和 Device Link 给跨账号的一样
  // （不用结果缓存、列表与历史增量、推送压缩）；按对端取连接拿到的仍是那条分享连接（状态、代次看它），链路状态是会话上的。
  it('carries a guest link to a shared provider over its session with the cross-account encoding of Device Link', async () => {
    const hostKey = providerShareHostPeer('share-1', 'a-host'), guestKey = providerShareGuestPeer('share-1', 'member-1', 'g-guest');
    const connectedAt = new Map<string, number>();
    let dialed = 0;
    const { links, bytes, connect, sessions } = pair({ connected: false, hostKey, controllerKey: guestKey, connectedAt: (id) => connectedAt.get(id) ?? null,
      controllerEpoch: (id) => (id === hostKey ? 11 : 3),
      // 只有 share-1 有能开会话的分享连接（Agent-Net 开着）。
      agentNetPeer: (id) => (id === hostKey ? 'online' : null),
      // 拨号成功、连接建好；对方宣告会话要再过一会儿。
      connect: async (id) => { dialed++; connectedAt.set(id, performance.now()); setTimeout(connect, 20); return true; } });
    const hostFrames: Envelope[] = [];
    const big = 'event text '.repeat(20_000);
    links.host.onFrame((env) => {
      hostFrames.push(env);
      if (env.kind === 'link-open') links.host.sendLinkAccept(env.src!, env.id!, { appVersion: 'host', allowlistHash: 'hash' });
      if (env.kind === 'invoke') {
        links.host.sendPush(env.src!, 'maker:event', { text: big });
        links.host.sendInvokeResult(env.src!, env.id!, { ok: true, result: listResult(200) });
      }
    });
    const pushes: Envelope[] = [];
    links.controller.onFrame((env) => { if (env.kind === 'push') pushes.push(env); });
    const calls: string[] = [];
    const shareConnection = { getStatus: () => 'online', getConnectionEpoch: () => 11,
      isLinkReady: () => false, needsLinkRecovery: () => false, getReliableSendQueueDepth: () => 0 } as unknown as DeviceLinkClient;
    const deviceLink = {
      onPresenceChanged: () => () => {},
      isLinkReady: () => false, needsLinkRecovery: () => false, hasPendingRequestsTo: () => false, getReliableSendQueueDepth: () => 0,
      openLink: async () => { calls.push('device-link:openLink'); return { appVersion: 'dl', allowlistHash: 'dl' }; },
      invoke: async () => { calls.push('device-link:invoke'); return { ok: true, result: 'device-link' }; },
      connectionFor: (id: string) => (id === hostKey ? shareConnection : deviceLink),
    } as unknown as DeviceLinkClient;
    const guest = routeSessionPeers(deviceLink, links.controller);
    expect(guest.connectionFor(hostKey)).toBe(shareConnection);
    await expect(guest.openLink(hostKey, openPayload)).resolves.toMatchObject({ appVersion: 'host' });
    expect(dialed).toBe(1);
    expect(calls).toEqual([]);
    expect(hostFrames[0]).toMatchObject({ kind: 'link-open', src: guestKey });
    expect((hostFrames[0].payload as { capabilities?: string[] }).capabilities ?? []).toEqual([]);
    for (let read = 0; read < 2; read++) {
      await expect(guest.invoke(hostKey, { channel: 'local-db:sessions:list', args: [{ limit: 200 }] })).resolves.toEqual({ ok: true, result: listResult(200) });
    }
    expect(hostFrames.filter((env) => env.kind === 'invoke').map((env) => (env.payload as { transfer?: unknown }).transfer)).toEqual([undefined, undefined]);
    await vi.waitFor(() => expect(pushes).toHaveLength(2));
    expect(pushes[0]).toMatchObject({ src: hostKey, payload: { channel: 'maker:event', payload: { text: big } } });
    expect(bytes.toController).toBeGreaterThan(2 * (big.length + JSON.stringify(listResult(200)).length));
    // 业务看这条分享连接的状态与代次，链路状态看会话；离线事件的代次也是这条连接的。
    const view = guest.connectionFor(hostKey);
    expect(view).not.toBe(guest);
    expect(view.getStatus()).toBe('online');
    expect(view.getConnectionEpoch()).toBe(11);
    expect(view.isLinkReady(hostKey)).toBe(true);
    expect(view.getPeerLinkGeneration(hostKey)).toBe(1);
    const offline: DeviceLinkPeerRouteStateChanged[] = [];
    links.controller.onPeerRouteStateChanged((change) => offline.push(change));
    sessions.controller!.dispose('DEVICE_OFFLINE');
    expect(offline).toEqual([{ deviceId: hostKey, state: 'offline', connectionEpoch: 11, linkGeneration: 1 }]);
    // 没有能开会话的连接（Agent-Net 关着，或这个资源只在 Device Link 上）：不拨，当场交给 Device Link，和原来一样同步。
    void guest.openLink(providerShareHostPeer('share-2', 'a-host'), openPayload);
    expect(calls).toEqual(['device-link:openLink']);
    expect(dialed).toBe(1);
  });
});
