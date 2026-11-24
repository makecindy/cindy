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
import { base64Codec, type Base64Platform } from '../session/binarySegments.js';
import { RESULT_STALL_MS, SessionPeer, type SessionHandle, type SessionRole } from '../session/peer.js';
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

// Unit: Main can cancel by request id while the worker owns the wire timeout.
it('forwards cancellation from Main to the worker session immediately', async () => {
  const { caller, ran, arrive } = peers();
  const main = new WorkerSessions((message) => worker(message), () => {});
  let onSession: Parameters<Parameters<typeof serveWorkerSessions>[0]['onSession']>[0] | undefined;
  const worker = serveWorkerSessions({
    useSessions() {},
    session: () => caller,
    onSession(listener) { onSession = listener; },
  }, (message) => main.receive(message));
  main.use({ laneFor: () => 'normal', handlers: () => ({}) });
  onSession!('peer', caller, 'peer');
  const proxy = main.session('peer')!;
  const result = proxy.request('test:read', [], { id: 'listing', timeoutMs: 10_000 });
  proxy.cancelRequest('listing');
  await expect(result).resolves.toMatchObject({ ok: false, error: { code: 'INVOKE_TIMEOUT' } });
  arrive('control');
  arrive('normal');
  await settle();
  expect(ran).toEqual([]);
});

/** 测试价值（会话 v2：大消息走自己的流）
 * - 生产入口与可观察结果：`SessionLanes` 带 `openBody`（两端都宣告了 agent-net-session-v2，portableSocket.ts）。64 KiB 以上的消息
 *   走一条自己的流，通道上只留一个占位；业务拿到消息的先后和 v1 一模一样，接收方从结果的第一个字节起就知道它在来（`onProgress`）；
 *   调用方放弃了的结果，发送方不再发剩下的，占位被跳过，同一通道后面的消息照常送达；对端是 v1 时线上的字节和原来一样。
 * - Bug／规则依据：docs/agent-net-session-plan.md 第 7 节 v2-2。慢线上大结果传得比请求时限还久，超时以后又按同样大小重新要
 *   （第 10.2 节）；业务依赖的先后（列表结果和它之后的补丁推送）不能因为换了流而变。
 * - 现有覆盖缺口：新能力，原有用例都是 v1 的通道。
 * - 最小失败输入：推送、大结果、推送、小结果，大结果的流一半先于占位、一半晚于占位；放弃通知先于占位到、晚于占位到、流的头几个字节
 *   都没发出（只有通知能让占位放行）、流提前结束；放弃以后已经发出的字节晚到；一千多次放弃之后会话仍可用（记下的放弃不能
 *   越积越多直到会话报积压）；没有 `openBody` 或消息小于 64 KiB 时帧的字节与 v1 相同。
 * - tier：unit，内存里的字节。 */
function bodyPair(options: { bodies?: boolean } = {}) {
  const wire: Record<SessionLane, Uint8Array[]> = { control: [], normal: [], background: [] };
  const streams = new Map<number, { lane: SessionLane; bytes: Uint8Array[]; end?: 'finish' | 'abandon'; sent: number }>();
  const delivered: unknown[] = [], progress: Array<[string, number, number]> = [];
  const sender = new SessionLanes({ write: (lane, bytes) => wire[lane].push(bytes), deliver() {}, onError(error) { throw error; },
    ...(options.bodies === false ? {} : { openBody: (lane: SessionLane, key: number) => {
      const stream: { lane: SessionLane; bytes: Uint8Array[]; end?: 'finish' | 'abandon'; sent: number } = { lane, bytes: [], sent: 0 };
      streams.set(key, stream);
      return { write: (bytes: Uint8Array) => { stream.bytes.push(bytes); }, finish: () => { stream.end ??= 'finish'; }, abandon: () => { stream.end = 'abandon'; } };
    } }) });
  const receiver = new SessionLanes({ write() {}, deliver: (message) => { delivered.push(message); }, onError(error) { throw error; },
    onProgress: (id, received, total) => { progress.push([id, received, total]); } });
  const arrive = (lane: SessionLane) => { for (const bytes of wire[lane].splice(0)) receiver.receive(lane, bytes); };
  /** The body stream's next bytes up to `upTo` of it, in 7000-byte pieces, then its end if `end`. */
  const arriveBody = (key: number, upTo: number, end: boolean) => {
    const stream = streams.get(key)!, all = Buffer.concat(stream.bytes);
    for (; stream.sent < Math.min(upTo, all.length); stream.sent += 7000) {
      receiver.receiveBody(key, new Uint8Array(all.subarray(stream.sent, Math.min(upTo, all.length, stream.sent + 7000))));
    }
    stream.sent = Math.min(stream.sent, upTo, all.length);
    if (end) receiver.receiveBody(key, null);
  };
  return { sender, receiver, wire, streams, delivered, progress, arrive, arriveBody };
}
const sizeOf = (chunks: Uint8Array[]) => chunks.reduce((total, chunk) => total + chunk.length, 0);

it('v2: carries a large result on a stream of its own, reports its progress and hands it over in v1 order', () => {
  const { sender, wire, streams, delivered, progress, arrive, arriveBody } = bodyPair();
  const result = { listed: 'row '.repeat(25_000) };
  sender.send('normal', 'push', 'push-1');
  sender.send('normal', 'result', result, { id: 'call-1' });
  sender.send('normal', 'push', 'push-2');
  sender.send('normal', 'result', 'small-result', { id: 'call-2' });
  expect(streams.size).toBe(1);
  const [key] = streams.keys(), total = JSON.stringify(result).length;
  expect(streams.get(key)).toMatchObject({ lane: 'normal', end: 'finish' });
  expect(sizeOf(wire.normal)).toBeLessThan(1024);
  arriveBody(key, 49_000, false);
  arrive('normal');
  // The placeholder knows its result's id: what already arrived counts as progress at once.
  expect(delivered).toEqual(['push-1']);
  expect(progress.at(-1)).toEqual(['call-1', 49_000, total]);
  arriveBody(key, Infinity, true);
  expect(progress.at(-1)).toEqual(['call-1', total, total]);
  expect(delivered).toEqual(['push-1', result, 'push-2', 'small-result']);
});

it('v2: skips a result its caller gave up on, whenever the notice comes, and keeps its lane going', () => {
  for (const when of ['notice-first', 'placeholder-first', 'no-head-sent', 'ended-short'] as const) {
    const { sender, streams, delivered, arrive, arriveBody } = bodyPair();
    sender.send('normal', 'result', 'x'.repeat(200_000), { id: 'gone' });
    sender.send('normal', 'push', 'after');
    const [key] = streams.keys();
    expect(sender.abandonResult('gone')).toBe(true);
    expect(sender.abandonResult('gone')).toBe(false);
    expect(streams.get(key)!.end).toBe('abandon');
    if (when === 'notice-first') { arrive('control'); arrive('normal'); }
    if (when === 'placeholder-first') { arriveBody(key, 14_000, false); arrive('normal'); expect(delivered).toEqual([]); arrive('control'); }
    // The core dropped the stream's first bytes with the rest: the placeholder would wait for ever without the notice.
    if (when === 'no-head-sent') { arrive('normal'); expect(delivered).toEqual([]); arrive('control'); }
    if (when === 'ended-short') { arriveBody(key, 14_000, true); arrive('normal'); }
    expect(delivered, when).toEqual(['after']);
    // Bytes of it already sent still arrive: dropped, not an error.
    arriveBody(key, 28_000, true);
    arrive('control');
    sender.send('normal', 'push', 'later');
    arrive('normal');
    expect(delivered, when).toEqual(['after', 'later']);
  }
});

it('v2: stays usable after more given-up results than it keeps notices for', () => {
  const delivered: unknown[] = [];
  const receiver = new SessionLanes({ write() {}, deliver: (message) => { delivered.push(message); }, onError(error) { throw error; } });
  const frame = (lane: SessionLane, value: object) => {
    const body = Buffer.from(JSON.stringify(value)), bytes = Buffer.alloc(4 + body.length);
    bytes.writeUInt32BE(body.length, 0); body.copy(bytes, 4);
    receiver.receive(lane, new Uint8Array(bytes));
  };
  for (let key = 1; key <= 1500; key++) {
    frame('control', { c: 'control', x: key });
    frame('normal', { c: 'result', p: [0, 0, 0], z: [key, 70_000], i: `call-${key}` });
    receiver.receiveBody(key, new Uint8Array(1350));
    receiver.receiveBody(key, null);
  }
  frame('normal', { m: 'still-open', c: 'push' });
  expect(delivered).toEqual(['still-open']);
});

it('v2: writes the same frame bytes as v1 to a v1 peer and for messages below a body', () => {
  const v1 = (message: unknown, kind: string, p?: number[]) => {
    const body = Buffer.from(JSON.stringify({ m: message, c: kind, ...(p ? { p } : {}) }));
    const bytes = Buffer.alloc(4 + body.length); bytes.writeUInt32BE(body.length, 0); body.copy(bytes, 4);
    return bytes;
  };
  const large = { rows: ['ü'.repeat(70_000)] }, small = { rows: ['a', null, 1.5] };
  for (const bodies of [false, true]) {
    const { sender, wire, streams } = bodyPair({ bodies });
    sender.send('normal', 'push', small);
    sender.send('normal', 'result', bodies ? small : large, { id: 'call-1' });
    expect(streams.size).toBe(0);
    expect(Buffer.concat(wire.normal)).toEqual(Buffer.concat([v1(small, 'push'), v1(bodies ? small : large, 'result', [0, 1, 0])]));
  }
});

/** 测试价值（会话 v2 的时限）
 * - 生产入口与可观察结果：`SessionPeer` 两端都开了 v2（`bodies`）：结果在流上一直有字节到，就不按请求的时限判超时；停住 15 秒
 *   （RESULT_STALL_MS）才报 INVOKE_TIMEOUT，并让对方放弃没发完的结果；调用方已经放弃、还在业务里的请求，结果不再发回。
 * - Bug／规则依据：docs/agent-net-session-plan.md 第 7 节 v2-2、第 10.2 节：慢线上一个大的远程任务结果 10 秒传不完，超时，
 *   又用同样的游标再要一次，直到放弃这个任务。
 * - 现有覆盖缺口：上面的用例只测通道上的字节；v1 的超时用例不涉及流。
 * - 最小失败输入：10 秒时限、每 5 秒到 10 KB、共 100 秒传完的结果；只到一片就停住的结果；时限过了还在业务里的请求。
 * - tier：unit，内存里的字节、假时钟，没有真实等待。 */
function bodyPeers() {
  const bodies = new Map<number, { bytes: Uint8Array[]; end?: 'finish' | 'abandon'; sent: number }>();
  let toCaller!: (lane: SessionLane, bytes: Uint8Array) => void, toCallee!: (lane: SessionLane, bytes: Uint8Array) => void;
  let bodyToCaller!: (key: number, bytes: Uint8Array | null) => void;
  const requests: string[] = [];
  let toCallerBytes = 0;
  const caller = new SessionPeer({ bodies: true, laneFor: () => 'normal', wire: { write: (lane, bytes) => toCallee(lane, bytes),
    bufferedAmount: 0, onData: (handler) => { toCaller = handler; }, onBody: (handler) => { bodyToCaller = handler; } } });
  const callee: SessionPeer = new SessionPeer({ bodies: true, laneFor: () => 'normal',
    wire: { write: (lane, bytes) => { toCallerBytes += bytes.length; toCaller(lane, bytes); }, bufferedAmount: 0,
      onData: (handler) => { toCallee = handler; },
      openBody: (_lane, key) => {
        const body: { bytes: Uint8Array[]; end?: 'finish' | 'abandon'; sent: number } = { bytes: [], sent: 0 };
        bodies.set(key, body);
        return { write: (bytes) => { body.bytes.push(bytes); }, finish: () => { body.end ??= 'finish'; }, abandon: () => { body.end = 'abandon'; } };
      } },
    onRequest: (request) => { requests.push(request.id); } });
  /** `count` pieces of 10 KB of the body with `key` reach the caller, one every `everyMs`; `end` then ends its stream. */
  const trickle = async (key: number, count: number, everyMs: number, end = false) => {
    const body = bodies.get(key)!, all = Buffer.concat(body.bytes);
    for (let index = 0; index < count && body.sent < all.length; index++) {
      await vi.advanceTimersByTimeAsync(everyMs);
      const piece = all.subarray(body.sent, body.sent + 10_000);
      body.sent += piece.length;
      bodyToCaller(key, new Uint8Array(piece));
    }
    if (end) bodyToCaller(key, null);
  };
  return { caller, callee, bodies, requests, trickle, sentToCaller: () => toCallerBytes };
}

it('v2: lets a large result take as long as its bytes keep coming, and gives up on one that stalls', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const { caller, callee, bodies, requests, trickle } = bodyPeers();
  const listing = { items: 'i'.repeat(190_000) };
  const slow = caller.request('test:list', [], { timeoutMs: 10_000 });
  callee.respond(requests[0], { ok: true, result: listing });
  const [first] = bodies.keys();
  await trickle(first, 20, 5_000, true);
  await expect(slow).resolves.toEqual({ ok: true, result: listing });

  const stalled = caller.request('test:list', [], { timeoutMs: 10_000 });
  callee.respond(requests[1], { ok: true, result: listing });
  const second = [...bodies.keys()][1];
  await trickle(second, 1, 1_000);
  await vi.advanceTimersByTimeAsync(RESULT_STALL_MS);
  await expect(stalled).resolves.toMatchObject({ ok: false, error: { code: 'INVOKE_TIMEOUT' } });
  // Its cancel reached the callee: the rest of the body is not sent.
  expect(bodies.get(second)!.end).toBe('abandon');
  // What was already sent of it still arrives; the session goes on.
  await trickle(second, 3, 10, true);
  const echo = caller.request('test:echo', [], { timeoutMs: 1_000 });
  callee.respond(requests[2], { ok: true, result: 'echo' });
  await expect(echo).resolves.toEqual({ ok: true, result: 'echo' });
});

// 2026-11-22 审查（#12063）：收齐的结果在同一通道上等前面一个还在传的大结果时，不能因为自己的字节停了就超时；整个会话都静下来才算。
it('v2: keeps a complete result waiting behind a larger one still arriving, and fails it only when the session goes quiet', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const { caller, callee, bodies, requests, trickle } = bodyPeers();
  const larger = { rows: 'r'.repeat(200_000) }, smaller = { rows: 's'.repeat(90_000) };
  const first = caller.request('test:list', [], { timeoutMs: 10_000 }), second = caller.request('test:list', [], { timeoutMs: 10_000 });
  callee.respond(requests[0], { ok: true, result: larger });
  callee.respond(requests[1], { ok: true, result: smaller });
  const [a, b] = bodies.keys();
  await trickle(b, 100, 0, true);
  // The larger one keeps arriving, 10 KB every 5 s, for over a minute: the complete one waits behind it.
  await trickle(a, 14, 5_000);
  let settled = false;
  void second.then(() => { settled = true; });
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).toBe(false);
  await trickle(a, 100, 5_000, true);
  await expect(first).resolves.toEqual({ ok: true, result: larger });
  await expect(second).resolves.toEqual({ ok: true, result: smaller });

  // Complete, but behind one whose bytes stopped (its caller set no limit, so nothing gives it up) and nothing else arrives: it fails
  // once the session has been quiet that long. (Had the one in front timed out, its cancel would have dropped it and let this through.)
  const third = caller.request('test:list', []), fourth = caller.request('test:list', [], { timeoutMs: 10_000 });
  callee.respond(requests[2], { ok: true, result: larger });
  callee.respond(requests[3], { ok: true, result: smaller });
  const [, , c, d] = bodies.keys();
  await trickle(d, 100, 0, true);
  await trickle(c, 1, 1_000);
  await vi.advanceTimersByTimeAsync(RESULT_STALL_MS - 2_000);
  let quiet = false;
  void fourth.then(() => { quiet = true; });
  await vi.advanceTimersByTimeAsync(0);
  expect(quiet).toBe(false);
  await vi.advanceTimersByTimeAsync(2_000);
  await expect(fourth).resolves.toMatchObject({ ok: false, error: { code: 'INVOKE_TIMEOUT' } });
  void third;
});

it('v2: does not send the result of a request its caller gave up on while the business ran it', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const { caller, callee, bodies, requests, sentToCaller } = bodyPeers();
  const call = caller.request('test:export', [], { timeoutMs: 1_000 });
  await vi.advanceTimersByTimeAsync(1_000);
  await expect(call).resolves.toMatchObject({ ok: false, error: { code: 'INVOKE_TIMEOUT' } });
  const before = sentToCaller();
  callee.respond(requests[0], { ok: true, result: 'e'.repeat(500_000) });
  expect(bodies.size).toBe(0);
  expect(sentToCaller()).toBe(before);
});

/** 测试价值（会话 v2 正文里的字节）
 * - 生产入口与可观察结果：`SessionLanes` 的正文流（两端都是 v2）。消息里长的、规范的 base64 字符串（文件块、远程任务的上传块）按它编码的
 *   字节传，正文比原来少约四分之一；对端交给业务的消息与发出的逐字符相同，包括不规范的 base64、短的、恰好以内部标记开头的字符串。
 *   手机没有 Node 的 `Buffer`：只有 `atob`／`btoa`、两样都没有时，编解码结果与 `Buffer` 相同。
 * - Bug／规则依据：docs/agent-net-session-plan.md 10.2「消息是头 + 二进制正文」；v1 里文件块、上传块都是 base64 文本，线上多三分之一。
 * - 现有覆盖缺口：新能力。
 * - 最小失败输入：一条结果里有 300 KB 的规范 base64、末尾多余位不为 0 的、用 URL 字符的、缺填充的、短的、以标记开头的字符串，
 *   以及把 base64 当键的对象；三种编解码环境下随机长度 0–70 KB 的字节。
 * - tier：unit，内存里的字节。 */
it('v2: carries long base64 strings as their bytes and hands every string back exactly', () => {
  const { sender, streams, delivered, arrive, arriveBody } = bodyPair();
  const random = (length: number) => Buffer.from(Array.from({ length }, (_, index) => (index * 7919 + length) % 251));
  const file = random(300_000).toString('base64');
  const nonCanonical = random(30_001).toString('base64').replace(/.(=+)$/, (_, padding: string) => 'B' + padding);
  const message = {
    data: file, nonCanonical, urlSafe: random(30_000).toString('base64url'), unpadded: random(30_001).toString('base64').replace(/=+$/, ''),
    short: random(3_000).toString('base64'), marked: '\u0000\u0001b#0', markedEscape: '\u0000\u0001b=x', nested: [{ again: file }],
    [random(20_000).toString('base64')]: 'base64 as a key',
  };
  expect(Buffer.from(nonCanonical, 'base64').toString('base64')).not.toBe(nonCanonical);
  sender.send('normal', 'result', message, { id: 'read-1' });
  const [key] = streams.keys(), sent = sizeOf(streams.get(key)!.bytes);
  arrive('normal');
  arriveBody(key, Infinity, true);
  expect(delivered).toEqual([message]);
  // Both 300 KB copies go as bytes: the body is well under the JSON it replaces.
  expect(sent).toBeLessThan(JSON.stringify(message).length - 2 * (file.length - file.length * 3 / 4) + 1024);
});

it.each(['buffer', 'atob', 'table'] as const)('v2: encodes and decodes body bytes the same with %s', (mode) => {
  const platform = mode === 'buffer' ? { Buffer } : mode === 'atob' ? { atob, btoa } : {};
  const { base64Of, canonicalBase64Bytes } = base64Codec(platform as Base64Platform);
  for (const length of [0, 1, 2, 3, 4, 5, 8191, 8192, 8193, 70_001]) {
    const bytes = Uint8Array.from({ length }, (_, index) => (index * 131 + length) % 256);
    const text = base64Of(bytes);
    expect(text).toBe(Buffer.from(bytes).toString('base64'));
    expect(canonicalBase64Bytes(text)).toEqual(bytes);
  }
  expect(canonicalBase64Bytes('QQ==')).toEqual(Uint8Array.of(65));
  for (const bad of ['QR==', 'QUJ=x', 'QUI', 'QU-_', 'Q===']) expect(canonicalBase64Bytes(bad)).toBeNull();
});
