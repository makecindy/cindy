/** 测试价值
 * - 生产入口与可观察结果：Agent-Net 会话层的三条通道（`SessionLanes`，docs/agent-net-session-plan.md 第 10.1 节）；
 *   业务拿到消息的先后：结果等它之前发出的推送，交互请求等它之前的普通请求，但都不等后台通道上的大块数据。
 * - Bug／规则依据：基线里小请求一直等到大消息传完（Device Link 一条队列）；拆成通道以后又不能丢掉业务依赖的先后（第 5.2 节）。
 * - 现有覆盖缺口：新模块，没有别处覆盖。
 * - 最小失败输入：一条推送、一条后台大结果、一条交互结果，通道字节按不同顺序到达；以及普通、后台、交互三条请求；
 *   一条通道上连着五条推送，按单字节、不规则分片、整段一片三种切法到达（一片里有几帧加半帧，收齐一帧才拼接）；
 *   一条因为太大改走后台通道的写之后的读与写（2026-11-17 审查：之后的「发送」可能先于它执行）；一条关链之前的推送与订阅
 *   （关链走控制通道时越过了它们，推送被对方丢掉、订阅在关链之后才处理）。
 * - tier：unit，内存里的字节，默认按 1、5、64、3 字节轮流拆开喂。 */
import { afterEach, expect, it, vi } from 'vitest';
import { SessionLanes, type SessionLane } from '../session/lanes.js';
import { SessionPeer, type SessionHandle, type SessionRole } from '../session/peer.js';
import { serveWorkerSessions, WorkerSessions, SESSION_BACKLOG_REPORT_MS } from '../session/workerSessions.js';

function pair() {
  const wire: Record<SessionLane, Uint8Array[]> = { control: [], normal: [], background: [] };
  const delivered: unknown[] = [];
  const sender = new SessionLanes({ write: (lane, bytes) => wire[lane].push(bytes), deliver() {}, onError(error) { throw error; } });
  const receiver = new SessionLanes({ write() {}, deliver: (message) => { delivered.push(message); }, onError(error) { throw error; } });
  // 把一条通道上已写出的字节按不规则的片交给对端：分片任意，按序到达。
  const arrive = (lane: SessionLane, sizes = [1, 5, 64, 3]) => {
    const bytes = Uint8Array.from(wire[lane].splice(0).flatMap((chunk) => [...chunk]));
    for (let offset = 0, index = 0; offset < bytes.length; index++) {
      const size = sizes[index % sizes.length];
      receiver.receive(lane, bytes.slice(offset, offset + size));
      offset += size;
    }
  };
  return { sender, delivered, arrive };
}

it('holds a result for the pushes sent before it, but not for bulk data on another lane', () => {
  const { sender, delivered, arrive } = pair();
  sender.send('normal', 'push', 'push-1');
  sender.send('background', 'result', 'bulk-result');
  sender.send('control', 'result', 'send-receipt');
  arrive('control');
  expect(delivered).toEqual([]);
  arrive('normal');
  expect(delivered).toEqual(['push-1', 'send-receipt']);
  arrive('background');
  expect(delivered).toEqual(['push-1', 'send-receipt', 'bulk-result']);
});

it('lets an interactive request overtake background uploads but not earlier normal requests', () => {
  const { sender, delivered, arrive } = pair();
  sender.send('normal', 'request', 'set-model');
  sender.send('background', 'request', 'upload-chunk');
  sender.send('control', 'request', 'send-message');
  arrive('control');
  expect(delivered).toEqual([]);
  arrive('normal');
  expect(delivered).toEqual(['set-model', 'send-message']);
  arrive('background');
  expect(delivered).toEqual(['set-model', 'send-message', 'upload-chunk']);
});

it('moves a bulk request to the background lane: a later read overtakes it, a later write keeps its place', () => {
  const { sender, delivered, arrive } = pair();
  const bulk = 'x'.repeat(300 * 1024);
  sender.send('normal', 'request', 'set-model');
  expect(sender.send('normal', 'request', bulk)).toBe('background');
  sender.send('control', 'request', 'list-sessions', { unordered: true });
  sender.send('normal', 'request', 'send-message');
  arrive('control');
  expect(delivered).toEqual([]);
  arrive('normal');
  expect(delivered).toEqual(['set-model', 'list-sessions']);
  arrive('background');
  expect(delivered.map((m) => (m === bulk ? 'bulk-edit' : m))).toEqual(['set-model', 'list-sessions', 'bulk-edit', 'send-message']);
});

it('holds a link close until the pushes and requests sent before it are delivered', () => {
  const { sender, delivered, arrive } = pair();
  sender.send('normal', 'push', 'last-push');
  sender.send('normal', 'request', 'subscribe');
  sender.send('control', 'control', 'close', { afterEarlier: true });
  arrive('control');
  expect(delivered).toEqual([]);
  arrive('normal');
  expect(delivered).toEqual(['last-push', 'subscribe', 'close']);
});

// Wire validation keeps malformed dependency metadata inside this session's error handler.
it.each([{ p: [0] }, { r: -1 }, { b: 1.5 }, { o: 2 }])('refuses invalid lane dependencies: %j', (dependency) => {
  const deliver = vi.fn(), onError = vi.fn();
  const receiver = new SessionLanes({ write() {}, deliver, onError });
  const json = new TextEncoder().encode(JSON.stringify({ c: 'request', m: 'sample', ...dependency }));
  const bytes = new Uint8Array(4 + json.length);
  new DataView(bytes.buffer).setUint32(0, json.length);
  bytes.set(json, 4);
  receiver.receive('normal', bytes);
  expect(onError).toHaveBeenCalledWith(new Error('AGENT_NET_SESSION_FRAME_INVALID'));
  expect(deliver).not.toHaveBeenCalled();
});

it('delivers every message in order whatever the chunk boundaries', () => {
  for (const sizes of [[1], [5, 64, 3], [1 << 20]]) {
    const { sender, delivered, arrive } = pair();
    for (let index = 0; index < 5; index++) sender.send('normal', 'push', `push-${index}`);
    arrive('normal', sizes);
    expect(delivered).toEqual(['push-0', 'push-1', 'push-2', 'push-3', 'push-4']);
  }
});

/** 测试价值
 * - 生产入口与可观察结果：会话层的 `SessionPeer.request`（Desktop 的会话跑在 Agent-Net worker 里，超时也在这里算）；
 *   调用方已经报了超时的请求，被控端还会不会交给业务。
 * - Bug／规则依据：docs/agent-net-session-plan.md 第 5.4 节「调用方已判定失败的请求之后也不执行」。原来超时只在本机报失败：
 *   断网十几秒、请求超时后网络恢复，核心把请求重传过去照样执行，界面说失败、消息却发出去了，用户再发一次就重复。
 *   Device Link 在这种情况下把超时的请求从待发队列里撤掉。
 * - 现有覆盖缺口：会话层其它用例只测先后和送达，没有测超时以后。
 * - 最小失败输入：断网 15 秒（调用方 10 秒超时），恢复后请求比「取消」先到；以及会话上第一条请求超时后「取消」先到。
 * - tier：unit，内存里的字节、假时钟，没有真实等待。 */
function peers() {
  const sent: Record<SessionLane, Uint8Array[]> = { control: [], normal: [], background: [] };
  let toPeer!: (lane: SessionLane, bytes: Uint8Array) => void;
  let toCaller!: (lane: SessionLane, bytes: Uint8Array) => void;
  const ran: string[] = [];
  const caller = new SessionPeer({ wire: { write: (lane, bytes) => { sent[lane].push(bytes); }, bufferedAmount: 0,
    onData: (handler) => { toCaller = handler; } }, laneFor: () => 'normal' });
  const callee = new SessionPeer({ wire: { write: (lane, bytes) => toCaller(lane, bytes), bufferedAmount: 0,
    onData: (handler) => { toPeer = handler; } }, laneFor: () => 'normal',
    onOpen: (id) => { callee.accept(id, { accepted: true }); },
    onRequest: (request) => { ran.push(request.channel); } });
  const arrive = (lane: SessionLane) => { for (const bytes of sent[lane].splice(0)) toPeer(lane, bytes); };
  return { caller, ran, arrive };
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
afterEach(() => { vi.useRealTimers(); });

it('does not start a request that reaches the peer after its time limit, even ahead of its cancel', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const { caller, ran, arrive } = peers();
  void caller.request('test:list', [], { timeoutMs: 10_000 });
  arrive('normal');
  await settle();
  expect(ran).toEqual(['test:list']);
  const sending = caller.request('test:send-message', [], { timeoutMs: 10_000 });
  // 断网 15 秒：调用方 10 秒时报了超时；恢复后核心先重传更早写出的请求，取消后到。
  vi.advanceTimersByTime(15_000);
  await expect(sending).resolves.toMatchObject({ ok: false, error: { code: 'INVOKE_TIMEOUT' } });
  arrive('normal');
  arrive('control');
  await settle();
  expect(ran).toEqual(['test:list']);
});

/** 测试价值（委托里的单向会话）
 * - 生产入口与可观察结果：`SessionPeer` 的 `role`（跨账号委托里的会话由 portableSocket.ts 的 sessionScope 给定）：
 *   受邀者一端只能建链、调用、取消、关闭，分享资源一端只能接受、回结果、推送、关闭；对方发来不该它发的消息不交给业务，
 *   本端越界的调用直接报 FORBIDDEN。
 * - Bug／规则依据：供应商分享 §9 第 1 条「绝不降级为整台电脑的远程控制」，以及 scopedRoutes.ts 里分享帧的边界（受邀者只发
 *   link-open / link-close / invoke，分享资源一端只发 link-accept / link-close / invoke-result / push）。跨账号改走会话层以后，
 *   这条边界由会话自己守。
 * - 现有覆盖缺口：新能力；其余会话用例都是同账号设备之间的双向会话。
 * - 最小失败输入：不守规矩的受邀者（双向会话）向分享资源一端推送、发在线状态；分享资源一端反过来建链、调用；
 *   不守规矩的分享资源一端（双向会话）向受邀者建链、调用。
 * - tier：unit，内存里的字节，假计时器，没有真实等待。 */
function linked(roles: [SessionRole, SessionRole]) {
  const toPeer: Array<(lane: SessionLane, bytes: Uint8Array) => void> = [];
  const seen: [string[], string[]] = [[], []];
  const ends: SessionPeer[] = [];
  for (const index of [0, 1] as const) {
    ends[index] = new SessionPeer({ role: roles[index], laneFor: () => 'normal',
      wire: { write: (lane, bytes) => toPeer[1 - index](lane, bytes), bufferedAmount: 0, onData: (handler) => { toPeer[index] = handler; } },
      onOpen: (id) => { seen[index].push('open'); ends[index].accept(id, { accepted: true }); },
      onRequest: (request) => { seen[index].push('request:' + request.channel); ends[index].respond(request.id, { ok: true, result: request.args[0] }); },
      onPush: (channel) => { seen[index].push('push:' + channel); },
      onPresence: () => { seen[index].push('presence'); },
      onClose: (reason) => { seen[index].push('close:' + reason); } });
  }
  return { ends, seen };
}

it('keeps a session inside a delegation one-way whichever end misbehaves', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  // A modified guest that does not hold itself to its role, against the resource's computer.
  const { ends: [guest, host], seen } = linked(['both', 'serve']);
  guest.push('test:forged-event', 1);
  guest.presence({ remoteControlEnabled: true });
  await expect(guest.open({ controllerName: 'guest' }, 1000)).resolves.toEqual({ accepted: true });
  await expect(guest.request('test:echo', ['allowed'], { timeoutMs: 1000 })).resolves.toEqual({ ok: true, result: 'allowed' });
  await settle();
  expect(seen[1]).toEqual(['open', 'request:test:echo']);
  await expect(host.open({ controllerName: 'host' }, 1000)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(host.request('test:take-over', [], { timeoutMs: 1000 })).resolves.toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  expect(() => host.presence({})).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
  expect(seen[0]).toEqual([]);

  // A modified resource side against a guest: it may answer and push, never take control of the guest's computer.
  const reverse = linked(['both', 'call']);
  const [owner, visitor] = reverse.ends;
  const opening = owner.open({ controllerName: 'owner' }, 1000);
  const calling = owner.request('test:read-guest-files', [], { timeoutMs: 1000 });
  owner.push('test:event', 1);
  await settle();
  expect(reverse.seen[1]).toEqual(['push:test:event']);
  expect(() => visitor.push('test:event', 1)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
  expect(() => visitor.respond('unknown', { ok: true, result: null })).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
  vi.advanceTimersByTime(1000);
  await expect(opening).rejects.toMatchObject({ code: 'LINK_TIMEOUT' });
  await expect(calling).resolves.toMatchObject({ ok: false, error: { code: 'INVOKE_TIMEOUT' } });
  expect(reverse.seen[1]).toEqual(['push:test:event']);
});

it('uses link acceptance to expire the first request without waiting for cancel', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const { caller, ran, arrive } = peers();
  const opened = caller.open({}, 1000);
  arrive('control');
  await expect(opened).resolves.toEqual({ accepted: true });
  const request = caller.request('test:write', [], { timeoutMs: 1000 });
  vi.advanceTimersByTime(1100);
  await expect(request).resolves.toMatchObject({ ok: false, error: { code: 'INVOKE_TIMEOUT' } });
  arrive('normal');
  expect(ran).toEqual([]);
  arrive('control');
});

it('drops a timed-out request when its cancel gets to the peer first', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const { caller, ran, arrive } = peers();
  const sending = caller.request('test:send-message', [], { timeoutMs: 10_000 });
  vi.advanceTimersByTime(10_000);
  await expect(sending).resolves.toMatchObject({ ok: false, error: { code: 'INVOKE_TIMEOUT' } });
  // 取消走控制通道先到；这是会话上的第一条请求，单看到达时间看不出它晚了，只能靠取消。
  arrive('control');
  arrive('normal');
  await settle();
  expect(ran).toEqual([]);
});


/** 测试价值
 * - 生产入口与可观察结果：Main 读到的会话积压（WorkerSessions 给出的 bufferedAmount，Desktop 当作链路的队列深度，
 *   高了就先不推任务文字）。worker 的通道还压着数据时，积压清掉以后 Main 自己就能读到，不用等下一次调用。
 * - Bug 依据：2026-11-17 审查，积压只在 Main 发下一条消息时更新；推送因为「队列满」全被拦下后再没有消息，读数一直是满的，
 *   对方那边任务文字停住，直到隔十几秒的后台读取带回新读数。
 * - 最小失败输入：一次推送后 worker 的通道里还有数据，之后清空，Main 不再发任何消息。tier：unit（真实的两半，内存里相连）。 */
it('lets Main see a session backlog drain without sending anything more', async () => {
  vi.useFakeTimers();
  let backlog = 0;
  const workerSession = { bufferedAmount: 0, push() { backlog = 300_000; } };
  Object.defineProperty(workerSession, 'bufferedAmount', { get: () => backlog });
  let fromWorker: (message: unknown) => void = () => undefined;
  let announced: SessionHandle | null = null;
  const main = new WorkerSessions((message) => worker(message), (_key, session) => { announced = session; });
  let onSession: ((key: string, session: never, device: string) => void) | null = null;
  const worker = serveWorkerSessions({
    useSessions() {}, session: () => workerSession as never, onSession: (listener) => { onSession = listener as never; },
  }, (message) => fromWorker(message));
  fromWorker = (message) => main.receive(message);
  main.use({ laneFor: () => 'normal', handlers: () => ({}) });
  onSession!('peer', undefined as never, 'peer');
  announced!.push('maker:event-batch', { text: 'x' });
  expect(announced!.bufferedAmount).toBe(300_000);
  backlog = 0;
  await vi.advanceTimersByTimeAsync(SESSION_BACKLOG_REPORT_MS * 2);
  expect(announced!.bufferedAmount).toBe(0);
});
