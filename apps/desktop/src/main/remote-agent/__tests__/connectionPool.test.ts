/**
 * 远程模型连接池：只在名额紧张时让出「不忙且闲置满设置时长」的连接；让出只结束对方的 Agent 进程，
 * 本机部分(执行器里的后台命令等)留着，再发消息时带原来的会话 id 连回来。
 *
 * 前半是连接池本身的判定；后半与 roundtrip.test.ts 同一套两端同进程的接线，被控端是真实的
 * createRemoteAgentHost(按设备计名额)，Agent 是假的。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AgentEvent, AgentSessionHandle, BackgroundTaskSnapshot, StartSessionOptions } from '@cindy/maker-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isRemoteRunLimitError,
  RemoteConnectionPool,
  type PooledRemoteConnection,
} from '../controller/connectionPool';
import { hostRewritesResumeId, startRemoteAgentSession, type StartRemoteAgentDeps } from '../controller/startRemote';
import { ExecServerRelay } from '../controller/execServerRelay';
import { RemoteExecutor } from '../executor/executor';
import { createRemoteAgentHost, type HostedStartInput } from '../host/runHost';
import type { RemoteAgentLimits } from '../../../shared/remoteAgentLimits';

// ─── 连接池本身 ────────────────────────────────────────────────────

interface FakeMember extends PooledRemoteConnection {
  name: string;
  occupied: boolean;
  idle: boolean;
  activity: number;
  released: number;
}

function member(name: string, activity: number, idle = true): FakeMember {
  const item: FakeMember = {
    name,
    occupied: true,
    idle,
    activity,
    released: 0,
    occupiesSlot: () => item.occupied,
    isIdle: () => item.idle,
    lastActivityAt: () => item.activity,
    release: async () => {
      if (!item.occupied || !item.idle) return false;
      item.occupied = false;
      item.released += 1;
      return true;
    },
  };
  return item;
}

const MINUTE = 60_000;

function poolWith(minutes: number, now: number) {
  let idleMinutes = minutes;
  const pool = new RemoteConnectionPool({ idleMinutes: () => idleMinutes, now: () => now, checkMs: 3_600_000 });
  return { pool, setMinutes: (value: number) => { idleMinutes = value; } };
}

describe('remote connection pool', () => {
  const now = 100 * MINUTE;

  it('recognizes capacity rejections from new and old hosts, but not staged-data pressure', () => {
    expect(isRemoteRunLimitError(new Error('[REMOTE_AGENT_BUSY] [DEVICE_LIMIT] remote task limit for this device reached'))).toBe(true);
    expect(isRemoteRunLimitError(new Error('[REMOTE_AGENT_BUSY] [TOTAL_LIMIT] remote task limit for the provider computer reached'))).toBe(true);
    expect(isRemoteRunLimitError(new Error('[REMOTE_AGENT_BUSY] too many tasks are running from this computer'))).toBe(true);
    expect(isRemoteRunLimitError(new Error('[REMOTE_AGENT_BUSY] too much staged data'))).toBe(false);
    expect(isRemoteRunLimitError(new Error('[REMOTE_AGENT_UNAVAILABLE] [DEVICE_LIMIT]'))).toBe(false);
  });

  it('does not release below the watermark, however long a connection has been idle', async () => {
    const { pool } = poolWith(10, now);
    pool.noteMaxRuns(10); // 水位线 8
    const members = Array.from({ length: 7 }, (_, index) => member(`m${index}`, now - 1_000 * MINUTE));
    members.forEach((item) => pool.add(item));
    await pool.trim();
    expect(members.map((item) => item.released)).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it('at the watermark releases eligible connections oldest first until below it', async () => {
    const { pool } = poolWith(10, now);
    pool.noteMaxRuns(10);
    const fresh = Array.from({ length: 6 }, (_, index) => member(`fresh${index}`, now - MINUTE));
    const old = member('old', now - 30 * MINUTE);
    const older = member('older', now - 60 * MINUTE);
    const busy = member('busy', now - 90 * MINUTE, false);
    [...fresh, old, older, busy].forEach((item) => pool.add(item));
    expect(pool.occupied()).toBe(9);
    await pool.trim();
    // 9 → 7：先让最久的 older，再让 old；忙的与闲置不足 10 分钟的不动。
    expect([older.released, old.released, busy.released]).toEqual([1, 1, 0]);
    expect(fresh.every((item) => item.released === 0)).toBe(true);
    expect(pool.occupied()).toBe(7);
  });

  it('at the watermark without eligible connections releases nothing', async () => {
    const { pool } = poolWith(10, now);
    pool.noteMaxRuns(5); // 水位线 4
    const members = [
      member('busy', now - 60 * MINUTE, false),
      member('recent1', now - 9 * MINUTE),
      member('recent2', now - MINUTE),
      member('recent3', now),
    ];
    members.forEach((item) => pool.add(item));
    await pool.trim();
    expect(members.map((item) => item.released)).toEqual([0, 0, 0, 0]);
  });

  it.each([
    [1, null],
    [2, null],
    [4, null],
    [5, 4],
    [16, 13],
  ])('maxRuns %i has watermark %s; small limits never release early', async (maxRuns, watermark) => {
    const { pool } = poolWith(10, now);
    pool.noteMaxRuns(maxRuns);
    expect(pool.watermark()).toBe(watermark);
    const members = Array.from({ length: maxRuns }, (_, index) => member(`m${index}`, now - (100 + index) * MINUTE));
    members.forEach((item) => pool.add(item));
    await pool.trim();
    const released = members.reduce((sum, item) => sum + item.released, 0);
    expect(released).toBe(watermark === null ? 0 : maxRuns - watermark + 1);
  });

  it('when full makes room for exactly one before opening, and only with an eligible connection', async () => {
    const { pool } = poolWith(10, now);
    pool.noteMaxRuns(2);
    const a = member('a', now - 20 * MINUTE);
    const b = member('b', now - 30 * MINUTE);
    const self = member('self', now, false);
    [a, b, self].forEach((item) => pool.add(item));
    await pool.beforeOpen(self);
    expect([a.released, b.released, self.released]).toEqual([0, 1, 0]);
    // 又满了，剩下的那个闲置不足：不让，照常打开(由对方裁决)。
    a.activity = now - MINUTE;
    const c = member('c', now - 5 * MINUTE);
    pool.add(c);
    await pool.beforeOpen(self);
    expect([a.released, c.released]).toEqual([0, 0]);
  });

  it('uses the latest caps value for the per-device limit', async () => {
    const { pool } = poolWith(10, now);
    const a = member('a', now - 20 * MINUTE);
    const self = member('self', now, false);
    [a, self].forEach((item) => pool.add(item));
    pool.noteMaxRuns(4);
    await pool.beforeOpen(self);
    expect(a.released).toBe(0);
    pool.noteMaxRuns(1);
    await pool.beforeOpen(self);
    expect(a.released).toBe(1);
  });

  // provider-sharing.md §3：提供方关闭或延长闲置收回后，不能按打开时缓存的旧时长继续让出；
  // 读不到当前设置也不能用旧值关进程。原来的用例只在打开前手动更新 caps，未覆盖定时 trim。
  it.each([0, 120, undefined, 'offline'] as const)('refreshes the provider policy before releasing when it becomes %s', async policy => {
    let offline = policy === 'offline';
    let minutes: number | undefined = typeof policy === 'number' ? policy : undefined;
    const pool = new RemoteConnectionPool({
      now: () => now, checkMs: 3_600_000,
      readCaps: async () => {
        if (offline) throw new Error('DEVICE_OFFLINE');
        return { maxRuns: 5, idleReclaimMinutes: minutes };
      },
    });
    pool.noteMaxRuns(5);
    pool.noteIdleReclaimMinutes(1);
    const members = Array.from({ length: 4 }, (_, index) => member(`m${index}`, now - 10 * MINUTE));
    const remove = members.map(item => pool.add(item));
    try {
      await pool.trim();
      expect(members.every(item => item.released === 0)).toBe(true);
      offline = false;
      minutes = 1;
      await pool.trim();
      expect(members.reduce((sum, item) => sum + item.released, 0)).toBe(1);
    } finally { remove.forEach(unregister => unregister()); }
  });

  it('after a capacity rejection releases one eligible connection, none when nothing qualifies', async () => {
    const { pool } = poolWith(10, now);
    pool.noteMaxRuns(16);
    const self = member('self', now, false);
    const a = member('a', now - 20 * MINUTE);
    const b = member('b', now - 40 * MINUTE);
    [self, a, b].forEach((item) => pool.add(item));
    expect(await pool.releaseForRetry(self)).toBe(true);
    expect([a.released, b.released]).toEqual([0, 1]);
    a.idle = false;
    expect(await pool.releaseForRetry(self)).toBe(false);
  });

  it('with 0 minutes never releases on any path', async () => {
    const { pool } = poolWith(0, now);
    pool.noteMaxRuns(5);
    const self = member('self', now, false);
    const members = Array.from({ length: 5 }, (_, index) => member(`m${index}`, now - 1_000 * MINUTE));
    [self, ...members].forEach((item) => pool.add(item));
    await pool.trim();
    await pool.beforeOpen(self);
    expect(await pool.releaseForRetry(self)).toBe(false);
    expect(members.every((item) => item.released === 0)).toBe(true);
  });

  it('only counts the idle threshold that is set when deciding', async () => {
    const { pool, setMinutes } = poolWith(30, now);
    pool.noteMaxRuns(1);
    const self = member('self', now, false);
    const a = member('a', now - 20 * MINUTE);
    [self, a].forEach((item) => pool.add(item));
    expect(await pool.releaseForRetry(self)).toBe(false);
    setMinutes(15);
    expect(await pool.releaseForRetry(self)).toBe(true);
  });

  // PR #6483 review：让出时 close 没送到，对方还占着名额，本机却当已释放，会直接打开撞上限。
  it('keeps counting a connection whose close did not get through until a retried close succeeds or the provider reclaims it', async () => {
    vi.useFakeTimers();
    try {
      const pool = new RemoteConnectionPool({ idleMinutes: () => 10, now: () => now, checkMs: 60 * MINUTE, closeRetryMs: 2_000, closeHoldMs: 3 * MINUTE });
      pool.noteMaxRuns(2);
      const stuck = member('stuck', now - 60 * MINUTE);
      stuck.occupied = false;
      const other = member('other', now - 30 * MINUTE);
      const self = member('self', now, false);
      [stuck, other, self].forEach((item) => pool.add(item));
      let retries = 0;
      let reachable = false;
      const retryClose = async () => {
        retries += 1;
        if (!reachable) throw new Error('link down');
      };
      pool.holdAfterFailedClose(stuck, retryClose);
      // 仍占位：本机已满，打开前先让另一条有资格的。
      await pool.beforeOpen(self);
      expect(other.released).toBe(1);
      expect(pool.occupied(self)).toBe(1);
      // 再发一次也没送到：一直占到对方自行回收的时间。
      await vi.advanceTimersByTimeAsync(2_000);
      expect(retries).toBe(1);
      expect(pool.occupied(self)).toBe(1);
      await vi.advanceTimersByTimeAsync(3 * MINUTE);
      expect(pool.occupied(self)).toBe(0);
      // 再发送到了：立即不再占位。
      reachable = true;
      pool.holdAfterFailedClose(stuck, retryClose);
      expect(pool.occupied(self)).toBe(1);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(retries).toBe(2);
      expect(pool.occupied(self)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // PR #6483 第四轮：占位随任务注销一起消失，对方的旧 run 却还占着名额。
  it('keeps a held old run counted after its task leaves the pool, until the provider reclaims it', async () => {
    vi.useFakeTimers();
    try {
      const pool = new RemoteConnectionPool({ idleMinutes: () => 10, now: () => now, checkMs: 60 * MINUTE, closeRetryMs: 2_000, closeHoldMs: 3 * MINUTE });
      const stuck = member('stuck', now - 60 * MINUTE);
      stuck.occupied = false;
      const leave = pool.add(stuck);
      pool.holdAfterFailedClose(stuck, async () => { throw new Error('link down'); });
      leave();
      expect(pool.occupied()).toBe(1);
      await vi.advanceTimersByTimeAsync(3 * MINUTE);
      expect(pool.occupied()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('checks the watermark periodically while connections are registered', async () => {
    vi.useFakeTimers();
    try {
      let clock = now;
      const pool = new RemoteConnectionPool({ idleMinutes: () => 10, now: () => clock, checkMs: MINUTE });
      pool.noteMaxRuns(5);
      const members = Array.from({ length: 4 }, (_, index) => member(`m${index}`, now - index * MINUTE));
      const leave = members.map((item) => pool.add(item));
      await vi.advanceTimersByTimeAsync(MINUTE);
      expect(members.every((item) => item.released === 0)).toBe(true);
      clock = now + 12 * MINUTE;
      await vi.advanceTimersByTimeAsync(MINUTE);
      expect(members.reduce((sum, item) => sum + item.released, 0)).toBe(1);
      expect(members[3].released).toBe(1);
      leave.forEach((fn) => fn());
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('resume ids the provider would rewrite', () => {
  const mac = { workingDir: '/Users/alice/work/app', homeDir: '/Users/alice', extraDirs: ['/Volumes/data/ref'], writableDirs: [] };
  const win = { workingDir: 'C:\\Users\\alice\\work\\app', homeDir: 'C:\\Users\\alice', extraDirs: [], writableDirs: [] };
  it.each([
    ['session uuid', 'f3b1c7de-0c2a-4c5e-9e7a-1a2b3c4d5e6f', mac, false],
    ['Pi file under another Mac user', '/Users/bob/Library/Application Support/Cindy/pi/sessions/s.jsonl', mac, true],
    ['Pi file under this home', '/Users/alice/Library/pi/s.jsonl', mac, true],
    ['Pi file under an extra folder', '/Volumes/data/ref/s.jsonl', mac, true],
    ['Pi file on a Linux provider', '/home/bob/.local/share/cindy/pi/s.jsonl', mac, false],
    ['Pi file on a Windows provider', 'C:\\Users\\bob\\AppData\\Roaming\\Cindy\\pi\\s.jsonl', mac, false],
    ['Pi file under another Windows user', 'C:\\Users\\bob\\AppData\\Roaming\\Cindy\\pi\\s.jsonl', win, true],
    ['Pi file on a Mac provider for a Windows task', '/Users/bob/Library/pi/s.jsonl', win, false],
  ] as const)('%s', (_label, id, workspace, rewritten) => {
    expect(hostRewritesResumeId(id, workspace)).toBe(rewritten);
  });
});

// ─── 两端接线 ────────────────────────────────────────────────────

const RG = path.resolve(__dirname, '../../../../../ripgrep-bin', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'rg.exe' : 'rg');
const CONTROLLER = 'controller-device-1';

let root: string;
let project: string;
let hostRoot: string;

function queue() {
  const items: AgentEvent[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  return {
    push(event: AgentEvent) {
      items.push(event);
      wake?.();
      wake = null;
    },
    end() {
      ended = true;
      wake?.();
      wake = null;
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (items.length) {
          yield items.shift()!;
          continue;
        }
        if (ended) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

interface Scenario {
  /** 被控端启动过的 Agent(每次打开一个)。 */
  started: HostedStartInput[];
  /** 被控端 Agent 收到的方法调用。 */
  calls: Array<{ method: string; args: unknown[] }>;
  /** 被控端收到的 close op 次数。 */
  closes: number;
  /** 打开时接不回会话：先问控制端能不能清掉，再开新会话。 */
  failResume: 'callback' | 'silent' | null;
  /** 对方 Agent 当前报告的后台任务 / 待唤醒数(实时读取)。 */
  backgroundTasks: BackgroundTaskSnapshot[];
  pendingWake: number;
  /** send 'hold' 时卡住，直到调用它。 */
  releaseHold: (() => void) | null;
  /** 接下来这么多次 setExtraDirs 报错。 */
  failSetExtraDirs: number;
}

let scenario: Scenario;
let nextNative = 0;
/**
 * 假 Agent 收到 'cat' 时按这个虚拟路径读文件。不写进消息：测试里对方的目录也在本机临时目录下，
 * 落在工作目录的上级目录里，写进消息会被当成本机路径再投影一次。
 */
let catTarget = '';
/** 下一个 Agent 的会话 id(模拟 Pi 的会话文件路径)。 */
let nextNativeId: string | null = null;

/** 假 Agent：会话 id 接回 resumeSessionId；按消息内容干活。 */
function fakeAgent(input: HostedStartInput): AgentSessionHandle {
  scenario.started.push(input);
  const events = queue();
  let running = false;
  const resume = input.options.resumeSessionId;
  let id = resume ?? `native-${(nextNative += 1)}`;
  if (nextNativeId) {
    id = nextNativeId;
    nextNativeId = null;
  }
  let model = input.options.model;
  let planMode = input.options.planMode === true;
  let effort = input.options.effort;
  const failResume = resume ? scenario.failResume : null;
  if (failResume) {
    id = `native-${(nextNative += 1)}`;
    if (failResume === 'callback') void input.onInvalidResumeSession?.(resume!);
  }
  const auth = { authorization: `Bearer ${input.tunnel.token}` };
  const tool = async (name: string, args: Record<string, unknown>) => {
    // 只收 JSON：声明 text/event-stream 时隧道会改回 SSE(给真实 Claude Code 保活用)。
    const response = await fetch(`${input.tunnel.url}/mcp/cindy_exec`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const body = await response.json() as { result: { content: Array<{ text: string }> } };
    return body.result.content.map((item) => item.text).join('');
  };
  const record = (method: string, args: unknown[]) => scenario.calls.push({ method, args });
  const say = (text: string) => events.push({ type: 'text', data: { text, isFinal: true }, source: input.kind });
  return {
    get id() {
      return id;
    },
    agentKind: input.kind,
    get model() {
      return model;
    },
    async send(message) {
      record('send', [message]);
      const text = typeof message.content === 'string' ? message.content : '';
      running = true;
      if (text === 'hold') {
        await new Promise<void>((resolve) => {
          scenario.releaseHold = resolve;
        });
      } else if (text === 'bg') {
        say(await tool('Bash', { command: 'while [ ! -e bg.go ]; do sleep 0.01; done; echo bg-finished', run_in_background: true }));
      } else if (text.startsWith('read ')) {
        say(await tool('BashOutput', { bash_id: text.slice(5) }));
      } else if (text === 'cat') {
        say(await tool('Read', { file_path: catTarget }));
      } else if (text === 'whoami') {
        say(`${id} ${model} ${effort ?? ''} plan:${planMode}`);
      } else {
        say(`ok:${text}`);
      }
      running = false;
      events.push({ type: 'done', data: {}, source: input.kind });
    },
    async steer() {},
    async abort() {
      record('abort', []);
    },
    async close() {
      events.end();
    },
    events: () => events,
    getUsageSnapshot: () => ({ tokenUsage: scenario.calls.length ? 7 : 0, contextTokens: scenario.calls.length ? 5 : 0, contextWindow: 100, costUsd: 0 }),
    setInteractionResolver() {},
    isTurnRunning: () => running,
    getPlanMode: () => planMode,
    getEffort: () => effort ?? null,
    listBackgroundTasks: () => scenario.backgroundTasks,
    countPendingWakeContinuations: () => scenario.pendingWake,
    async setPermissionMode(mode) {
      record('setPermissionMode', [mode]);
    },
    async setModel(next, opts) {
      record('setModel', [next, opts]);
      model = next;
      if (opts?.effort) effort = opts.effort;
    },
    async setEffort(next) {
      record('setEffort', [next]);
      effort = next;
    },
    async setPlanMode(enabled) {
      record('setPlanMode', [enabled]);
      planMode = enabled;
    },
    async setExtraDirs(dirs, libraryRoot) {
      record('setExtraDirs', [dirs, libraryRoot]);
      if (scenario.failSetExtraDirs > 0) {
        scenario.failSetExtraDirs -= 1;
        throw new Error('extra dirs rejected');
      }
    },
    async requiresModelSwitchRebuild() {
      record('requiresModelSwitchRebuild', []);
      return true;
    },
    async commitRewindFiles(userUuid, priorAssistantUuid) {
      record('commitRewindFiles', [userUuid, priorAssistantUuid]);
      return { ok: true } as never;
    },
  } as AgentSessionHandle;
}

let limits: RemoteAgentLimits;
let host: ReturnType<typeof createRemoteAgentHost>;
/** 改写 / 拦截被控端的回复(模拟旧版文案、暂存过多等)。 */
let intercept: ((request: Record<string, unknown>) => unknown) | null;
let opens: number;

function createHost() {
  return createRemoteAgentHost({
    readLimits: () => limits,
    isAgentAvailable: () => true,
    startHosted: async (input) => fakeAgent(input),
    isControllerAuthorized: () => true,
    captureOwner: () => 'owner',
    isOwnerCurrent: () => true,
    runsRoot: hostRoot,
  });
}

function deps(pool?: RemoteConnectionPool): StartRemoteAgentDeps {
  return {
    invoke: async (args) => {
      const request = JSON.parse(JSON.stringify(args[0])) as Record<string, unknown>;
      if (request.op === 'open') opens += 1;
      if (request.op === 'close') scenario.closes += 1;
      if (intercept) {
        const replaced = intercept(request);
        if (replaced !== undefined) return replaced;
      }
      const result = await host.handle(CONTROLLER, request);
      return JSON.parse(JSON.stringify(result ?? null));
    },
    rgPath: RG,
    prepareMcp: async () => ({ servers: new Map(), dispose() {} }),
    collectProjectFiles: async () => [],
    isGitRepo: async () => false,
    newId: randomUUID,
    ...(pool ? { pool } : {}),
  };
}

/** 极短的闲置阈值(分钟)：测试里「闲置满」只要等几毫秒。 */
const TINY_MINUTES = 1 / 60_000;
let idleMinutes: number;

function newPool(): RemoteConnectionPool {
  return new RemoteConnectionPool({ idleMinutes: () => idleMinutes, checkMs: 3_600_000 });
}

const opened: AgentSessionHandle[] = [];

async function start(pool: RemoteConnectionPool | undefined, extra: Partial<StartSessionOptions> = {}): Promise<AgentSessionHandle> {
  const handle = await startRemoteAgentSession('claude-code', {
    sessionId: randomUUID(), workingDir: project, model: 'm1', ...extra,
  } as StartSessionOptions, deps(pool));
  opened.push(handle);
  return handle;
}

/** 收集一个句柄的事件；`until` 等到满足条件的事件。 */
function watch(handle: AgentSessionHandle) {
  const seen: AgentEvent[] = [];
  const waiters: Array<{ test: (event: AgentEvent) => boolean; resolve: (event: AgentEvent) => void }> = [];
  void (async () => {
    for await (const event of handle.events()) {
      seen.push(event);
      for (const waiter of [...waiters]) {
        if (waiter.test(event)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(event);
        }
      }
    }
  })();
  return {
    seen,
    until: (test: (event: AgentEvent) => boolean) => new Promise<AgentEvent>((resolve) => {
      const found = seen.find(test);
      if (found) resolve(found);
      else waiters.push({ test, resolve });
    }),
  };
}

const textOf = (event: AgentEvent) => (event.data as { text?: string }).text ?? '';

/** 发一条消息，等它的回答。 */
async function ask(handle: AgentSessionHandle, watcher: ReturnType<typeof watch>, content: string): Promise<string> {
  const doneBefore = watcher.seen.filter((event) => event.type === 'done').length;
  await handle.send({ type: 'user', content });
  await watcher.until(() => watcher.seen.filter((event) => event.type === 'done').length > doneBefore);
  const texts = watcher.seen.filter((event) => event.type === 'text');
  return textOf(texts[texts.length - 1]);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-ra-pool-')));
  project = path.join(root, 'project');
  hostRoot = path.join(root, 'host');
  fs.mkdirSync(project);
  scenario = { started: [], calls: [], closes: 0, failResume: null, backgroundTasks: [], pendingWake: 0, releaseHold: null, failSetExtraDirs: 0 };
  limits = { perDevice: 1, total: 64 };
  intercept = null;
  opens = 0;
  idleMinutes = TINY_MINUTES;
  host = createHost();
});

afterEach(async () => {
  scenario.releaseHold?.();
  await Promise.allSettled(opened.splice(0).map((handle) => handle.close({ reason: 'navigation' })));
  await host.abortAll();
  host.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('remote connection pool with a real host', () => {
  // #6921 unit: startRemoteAgentSession must attempt every local cleanup and keep
  // its failure for repeated teardown. Existing pool cases only failed remote close.
  // Minimal input: one live run, with each local disposer failing after releasing
  // its real resource. Reuses the loopback host harness without a real Agent process.
  it('attempts every local disposer and retains all failures across account-boundary teardown', async () => {
    const pool = newPool();
    const failures = ['pool', 'relay', 'mcp', 'executor'].map((name) => new Error(`${name} cleanup failed`));
    const remove = vi.fn();
    const add = pool.add.bind(pool);
    const addSpy = vi.spyOn(pool, 'add').mockImplementation((member) => {
      const leave = add(member);
      return () => { leave(); remove(); throw failures[0]; };
    });
    const closeRelay = ExecServerRelay.prototype.close;
    const relaySpy = vi.spyOn(ExecServerRelay.prototype, 'close').mockImplementation(function (this: ExecServerRelay) {
      closeRelay.call(this);
      throw failures[1];
    });
    const closeExecutor = RemoteExecutor.prototype.close;
    const executorSpy = vi.spyOn(RemoteExecutor.prototype, 'close').mockImplementation(async function (this: RemoteExecutor) {
      await closeExecutor.call(this);
      throw failures[3];
    });
    const disposeMcp = vi.fn(() => { throw failures[2]; });
    try {
      const handle = await startRemoteAgentSession('codex', {
        sessionId: randomUUID(), workingDir: project, model: 'm1',
      }, {
        ...deps(pool),
        // The fake Agent does not open exec-server; no Codex process is launched.
        codexPath: () => path.join(root, 'unused-codex'),
        prepareMcp: async () => ({ servers: new Map(), dispose: disposeMcp }),
      });
      opened.push(handle);
      const first = await Promise.allSettled([handle.close({ reason: 'account-boundary' })]);
      expect(first[0].status).toBe('rejected');
      if (first[0].status !== 'rejected') throw new Error('Local cleanup failure must reach the owner');
      expect(first[0].reason).toBeInstanceOf(AggregateError);
      expect((first[0].reason as AggregateError).errors).toEqual(failures);
      const repeated = await Promise.allSettled([handle.detach!({ reason: 'account-boundary' })]);
      expect(repeated[0].status).toBe('rejected');
      if (repeated[0].status === 'rejected') expect(repeated[0].reason).toBe(first[0].reason);
      expect(remove).toHaveBeenCalledOnce();
      expect(relaySpy).toHaveBeenCalledOnce();
      expect(disposeMcp).toHaveBeenCalledOnce();
      expect(executorSpy).toHaveBeenCalledOnce();
      expect(pool.size).toBe(0);
    } finally {
      addSpy.mockRestore();
      relaySpy.mockRestore();
      executorSpy.mockRestore();
    }
  });

  // 回归：重启恢复遇到 1.5s 建连超时就失败；原用例只覆盖已连上的打开/连回。
  // 生产入口 startRemoteAgentSession，最小输入为 caps 连续两次 NOT_CONNECTED；
  // unit，假计时器验证等待期间另一控制端仍可请求，且恢复后只打开一个 run。
  it('waits for a reconnect before opening, without blocking another controller', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const ready = deps();
    let attempts = 0;
    const pending = startRemoteAgentSession('claude-code', {
      sessionId: 'restored-task', workingDir: project, model: 'm1', resumeSessionId: 'native-before-restart',
    } as StartSessionOptions, {
      ...ready,
      invoke: async (args) => {
        if ((args[0] as { op: string }).op === 'caps' && ++attempts <= 2) {
          throw Object.assign(new Error('not online within 1500ms'), { code: 'NOT_CONNECTED' });
        }
        return ready.invoke(args);
      },
    });
    void pending.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(attempts).toBe(1));
      expect(opens).toBe(0);
      await expect(host.handle('another-controller', { op: 'caps' })).resolves.toMatchObject({ virtualWorkspace: true });
      await vi.waitFor(() => expect(attempts).toBe(3));
      vi.useRealTimers();
      const handle = await pending;
      opened.push(handle);
      expect(opens).toBe(1);
      expect(scenario.started[0].options.resumeSessionId).toBe('native-before-restart');
    } finally {
      vi.useRealTimers();
    }
  });

  // 同一入口的停止分支：授权拒绝立即结束；open 的结果不明时不重放写入。
  it.each(['caps', 'open'] as const)('does not replay %s after a permanent denial or uncertain write', async (phase) => {
    const ready = deps();
    let attempts = 0;
    await expect(startRemoteAgentSession('claude-code', {
      sessionId: 'failed-resume', workingDir: project, model: 'm1',
    } as StartSessionOptions, {
      ...ready,
      invoke: async (args) => {
        if ((args[0] as { op: string }).op === phase) {
          attempts += 1;
          throw Object.assign(new Error(phase === 'caps' ? 'share paused' : 'reply lost'), {
            code: phase === 'caps' ? 'REMOTE_AGENT_SHARE_PAUSED' : 'NOT_CONNECTED',
          });
        }
        return ready.invoke(args);
      },
    })).rejects.toThrow();
    expect(attempts).toBe(1);
    expect(scenario.started).toHaveLength(0);
  });

  it('makes room when full, then reconnects the released task to the same conversation', async () => {
    const pool = newPool();
    const a = await start(pool);
    const aEvents = watch(a);
    expect(await ask(a, aEvents, 'hello')).toBe('ok:hello');
    const nativeA = a.id;
    await sleep(5);
    const b = await start(pool);
    // 对方只给 1 个名额：打开 b 之前先让出了 a。
    expect(host.limitUsage().total).toBe(1);
    expect(scenario.started).toHaveLength(2);
    expect(scenario.started[1].options.resumeSessionId).toBeUndefined();
    // a 的状态照常读，界面不变空。
    expect(a.id).toBe(nativeA);
    expect(a.getUsageSnapshot().tokenUsage).toBeGreaterThan(0);
    await sleep(5);
    expect(await ask(a, aEvents, 'whoami')).toBe(`${nativeA} m1  plan:false`);
    expect(scenario.started).toHaveLength(3);
    expect(scenario.started[2].options.resumeSessionId).toBe(nativeA);
    expect(host.limitUsage().total).toBe(1);
    // b 让出后照样能用。
    const bEvents = watch(b);
    await sleep(5);
    expect(await ask(b, bEvents, 'again')).toBe('ok:again');
  });

  it('keeps background commands on this computer across a release and reads them by the same id', async () => {
    const pool = newPool();
    const a = await start(pool);
    const events = watch(a);
    const started = await ask(a, events, 'bg');
    const id = /with ID: (\S+?)\./.exec(started)?.[1];
    expect(id).toBeTruthy();
    // 本机执行器里的后台命令不算忙：a 照样有资格让出。
    await sleep(5);
    await start(pool);
    expect(scenario.started).toHaveLength(2);
    // 让出、连回之后命令还在跑，按原 ID 读得到；放行后读到它跑完的输出。
    await sleep(5);
    expect(await ask(a, events, `read ${id}`)).toContain('<status>running</status>');
    expect(scenario.started[2].options.resumeSessionId).toBe(a.id);
    fs.writeFileSync(path.join(project, 'bg.go'), '');
    await vi.waitFor(async () => expect(await ask(a, events, `read ${id}`)).toContain('bg-finished'), { timeout: 5_000, interval: 20 });
    expect(scenario.started).toHaveLength(3);
  });

  // provider-sharing.md §3「闲置收回由提供方决定」：对方按闲置收回结束了 Agent 进程(closed 带 idleReclaimed)。新控制端不报错、
  // 不关句柄，本机后台命令留着；下一次发送带原来的会话 id 连回。改动前会当作任务结束关掉句柄，下一次发送直接失败。
  it('keeps this computer\'s part when the provider reclaims an idle task, then reconnects to the same conversation', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      limits = { perDevice: 16, total: 64, idleMinutes: TINY_MINUTES };
      const a = await start(undefined);
      const events = watch(a);
      const started = await ask(a, events, 'bg');
      const id = /with ID: (\S+?)\./.exec(started)?.[1];
      expect(id).toBeTruthy();
      const nativeA = a.id;
      await sleep(5);
      // 对方巡检：不忙且闲置满设置的时长，收回。
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(() => expect(host.runCount()).toBe(0));
      expect(events.seen.filter((event) => event.type === 'error')).toEqual([]);
      expect(await ask(a, events, `read ${id}`)).toContain('<status>running</status>');
      expect(scenario.started).toHaveLength(2);
      expect(scenario.started[1].options.resumeSessionId).toBe(nativeA);
      fs.writeFileSync(path.join(project, 'bg.go'), '');
      await vi.waitFor(async () => expect(await ask(a, events, `read ${id}`)).toContain('bg-finished'), { timeout: 5_000, interval: 20 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('records setting changes while released and opens with them, without reconnecting just for them', async () => {
    const pool = newPool();
    const extra = path.join(root, 'extra');
    fs.mkdirSync(extra);
    const a = await start(pool, { permissionMode: 'default' } as Partial<StartSessionOptions>);
    const events = watch(a);
    await ask(a, events, 'hello');
    await sleep(5);
    await start(pool);
    const before = scenario.calls.length;
    await a.setModel!('m2', { providerId: 'p2', effort: 'high' });
    await a.setPermissionMode!('acceptEdits');
    await a.setPlanMode!(true);
    await a.setExtraDirs!([extra]);
    await a.abort();
    expect(scenario.calls.slice(before)).toEqual([]);
    expect(scenario.started).toHaveLength(2);
    expect(a.model).toBe('m2');
    expect(a.getPlanMode?.()).toBe(true);
    expect(a.getEffort?.()).toBe('high');
    await sleep(5);
    expect(await ask(a, events, 'whoami')).toBe(`${a.id} m2 high plan:true`);
    const reopened = scenario.started[2];
    expect(reopened.options).toMatchObject({
      model: 'm2', providerId: 'p2', effort: 'high', permissionMode: 'acceptEdits', planMode: true,
      resumeSessionId: a.id,
    });
    // 目录：打开时仍给第一次的列表，连回后按运行中改目录补发。
    expect(reopened.workspace.extraDirs).toEqual([]);
    expect(scenario.calls.filter((call) => call.method === 'setExtraDirs').map((call) => (call.args[0] as string[]).length)).toEqual([1]);
  });

  it('does not reapply one-shot rewind or fork options when reconnecting', async () => {
    const pool = newPool();
    const a = await start(pool, { vendorOptions: { source: 's', resumeSessionAt: 'msg-1', forkSession: true } } as Partial<StartSessionOptions>);
    const events = watch(a);
    await ask(a, events, 'hello');
    expect(scenario.started[0].options.vendorOptions).toEqual({ source: 's', resumeSessionAt: 'msg-1', forkSession: true });
    await sleep(5);
    await start(pool);
    await sleep(5);
    await ask(a, events, 'again');
    expect(scenario.started[2].options.vendorOptions).toEqual({ source: 's' });
  });

  it('tells the user when the conversation could not be resumed, via the invalid-resume callback', async () => {
    const pool = newPool();
    const invalidated: string[] = [];
    const a = await start(pool, { onInvalidResumeSession: async (expected: string) => { invalidated.push(expected); return true; } } as Partial<StartSessionOptions>);
    const events = watch(a);
    await ask(a, events, 'hello');
    const original = a.id;
    await sleep(5);
    await start(pool);
    scenario.failResume = 'callback';
    await sleep(5);
    await ask(a, events, 'again');
    expect(invalidated).toEqual([original]);
    const lost = events.seen.filter((event) => event.type === 'error');
    expect(lost).toHaveLength(1);
    expect(lost[0].data).toMatchObject({ isTerminal: false });
    expect(String((lost[0].data as { message: string }).message)).toContain('[REMOTE_AGENT_RESUME_LOST]');
  });

  it('tells the user when the other computer silently started a different conversation', async () => {
    const pool = newPool();
    const a = await start(pool);
    const events = watch(a);
    await ask(a, events, 'hello');
    await sleep(5);
    await start(pool);
    scenario.failResume = 'silent';
    await sleep(5);
    await ask(a, events, 'again');
    const errors = events.seen.filter((event) => event.type === 'error');
    expect(errors.map((event) => (event.data as { message: string }).message)).toEqual([
      expect.stringContaining('[REMOTE_AGENT_RESUME_LOST]'),
    ]);
  });

  it('does not release a task while it is busy', async () => {
    const pool = newPool();
    const a = await start(pool);
    const events = watch(a);
    // 回合进行中。
    const sending = a.send({ type: 'user', content: 'hold' });
    await vi.waitFor(() => expect(scenario.releaseHold).not.toBeNull());
    await sleep(5);
    await expect(start(pool)).rejects.toThrow('[DEVICE_LIMIT]');
    scenario.releaseHold?.();
    await sending;
    await events.until((event) => event.type === 'done');
    expect(scenario.started).toHaveLength(1);
    expect(scenario.closes).toBe(0);
  });

  it.each([
    ['background tasks', () => { scenario.backgroundTasks = [{ taskId: 't1', taskType: 'local_agent' }]; }],
    ['pending wake continuations', () => { scenario.pendingWake = 1; }],
  ])('treats %s on the other computer as busy', async (_label, arrange) => {
    arrange();
    const pool = newPool();
    const a = await start(pool);
    const events = watch(a);
    await ask(a, events, 'hello');
    await sleep(5);
    await expect(start(pool)).rejects.toThrow('[DEVICE_LIMIT]');
    expect(a.id).toBeTruthy();
  });

  // PR #6483 复审：后台工作结束的状态更新不算活动，连接池拿后台工作开始前的时间判断，一结束就让出。
  it.each([
    ['background tasks', () => { scenario.backgroundTasks = [{ taskId: 't1', taskType: 'local_agent' }]; }, () => { scenario.backgroundTasks = []; }],
    ['pending wake continuations', () => { scenario.pendingWake = 1; }, () => { scenario.pendingWake = 0; }],
  ])('counts the end of long %s as activity and waits the full idle time after it', async (_label, arrange, finish) => {
    // 只假时钟与对方的定时状态推送(每 2 秒)：时间用 setSystemTime 跳，推送由 advanceTimers 触发。
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    try {
      limits = { perDevice: 16, total: 64 };
      idleMinutes = 10;
      arrange();
      const pool = new RemoteConnectionPool({ idleMinutes: () => idleMinutes, now: () => Date.now(), checkMs: 3_600_000 });
      const a = await start(pool);
      await ask(a, watch(a), 'hello');
      // 后台工作持续了 30 分钟，期间不让。
      vi.setSystemTime(Date.now() + 30 * 60_000);
      expect(await pool.releaseForRetry(member('other', 0, false))).toBe(false);
      finish();
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.waitFor(() => expect(a.listBackgroundTasks!().length + a.countPendingWakeContinuations!()).toBe(0));
      // 刚结束：从这时起算闲置，不立即让。
      expect(await pool.releaseForRetry(member('other', 0, false))).toBe(false);
      vi.setSystemTime(Date.now() + 10 * 60_000);
      expect(await pool.releaseForRetry(member('other', 0, false))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['0 minutes (the default: never release)', 0],
    ['an idle threshold not reached yet', 30],
  ])('with a single slot and %s reports the rejection without releasing or retrying', async (_label, minutes) => {
    idleMinutes = minutes;
    const pool = newPool();
    const a = await start(pool);
    const events = watch(a);
    await ask(a, events, 'hello');
    await sleep(5);
    opens = 0;
    await expect(start(pool)).rejects.toThrow('[REMOTE_AGENT_BUSY] [DEVICE_LIMIT]');
    expect(opens).toBe(1);
    expect(scenario.closes).toBe(0);
  });

  it.each([
    ['new', '[REMOTE_AGENT_BUSY] [DEVICE_LIMIT] remote task limit for this device reached'],
    ['old', '[REMOTE_AGENT_BUSY] too many tasks are running from this computer'],
  ])('after a capacity rejection (%s host wording) releases one and retries once', async (_label, message) => {
    limits = { perDevice: 16, total: 64 };
    const pool = newPool();
    const a = await start(pool);
    const events = watch(a);
    await ask(a, events, 'hello');
    await sleep(5);
    // 本机计数没到上限(对方刚调小了上限等)：对方拒绝第一次打开。
    let rejected = 0;
    intercept = (request) => {
      if (request.op === 'open' && rejected === 0) {
        rejected += 1;
        throw new Error(message);
      }
      return undefined;
    };
    opens = 0;
    await start(pool);
    expect(opens).toBe(2);
    expect(scenario.closes).toBe(1);
    expect(host.limitUsage().total).toBe(1);
  });

  it('retries a capacity rejection only once', async () => {
    limits = { perDevice: 16, total: 64 };
    const pool = newPool();
    for (const content of ['a', 'b']) {
      const handle = await start(pool);
      await ask(handle, watch(handle), content);
    }
    await sleep(5);
    intercept = (request) => {
      if (request.op === 'open') throw new Error('[REMOTE_AGENT_BUSY] [TOTAL_LIMIT] remote task limit for the provider computer reached');
      return undefined;
    };
    opens = 0;
    await expect(start(pool)).rejects.toThrow('[TOTAL_LIMIT]');
    expect(opens).toBe(2);
    expect(scenario.closes).toBe(1);
  });

  it('does not release for staged-data pressure', async () => {
    limits = { perDevice: 16, total: 64 };
    const pool = newPool();
    const a = await start(pool);
    await ask(a, watch(a), 'hello');
    await sleep(5);
    intercept = (request) => {
      if (request.op === 'open') throw new Error('[REMOTE_AGENT_BUSY] too much staged data');
      return undefined;
    };
    opens = 0;
    await expect(start(pool)).rejects.toThrow('too much staged data');
    expect(opens).toBe(1);
    expect(scenario.closes).toBe(0);
  });

  it('a send during a release waits for it and reconnects once; two sends open one connection', async () => {
    const pool = newPool();
    const a = await start(pool);
    const events = watch(a);
    await ask(a, events, 'hello');
    await sleep(5);
    // 让 close 慢一点，在让出进行中发消息。
    let closeGate: (() => void) | null = null;
    intercept = (request) => {
      if (request.op !== 'close' || closeGate) return undefined;
      return new Promise((resolve) => {
        closeGate = () => resolve(host.handle(CONTROLLER, request).then((value) => value ?? null));
      });
    };
    const releasing = pool.releaseForRetry(member('other', 0, false));
    await vi.waitFor(() => expect(closeGate).not.toBeNull());
    const first = a.send({ type: 'user', content: 'one' });
    const second = a.send({ type: 'user', content: 'two' });
    await sleep(5);
    expect(scenario.started).toHaveLength(1);
    closeGate!();
    expect(await releasing).toBe(true);
    await Promise.all([first, second]);
    await events.until(() => events.seen.filter((event) => event.type === 'done').length >= 3);
    expect(scenario.started).toHaveLength(2);
    expect(scenario.started[1].options.resumeSessionId).toBe(a.id);
    expect(scenario.calls.filter((call) => call.method === 'send')).toHaveLength(3);
  });

  // PR #6483 review：连回后恢复设置(reapply)完成前就算连上了，并发的第二条消息会抢在恢复前、甚至第一条之前发给对方。
  it('a second send during the post-reconnect restore waits for it and goes after the first', async () => {
    const pool = newPool();
    const a = await start(pool);
    const events = watch(a);
    await ask(a, events, 'hello');
    await a.setExtraDirs!([], path.join(root, 'library'));
    await sleep(5);
    await start(pool);
    await sleep(5);
    // 连回后补发 libraryRoot(setExtraDirs)时卡住。
    let restoreGate: (() => void) | null = null;
    intercept = (request) => {
      if (restoreGate || request.op !== 'call' || request.method !== 'setExtraDirs') return undefined;
      return new Promise((resolve) => {
        restoreGate = () => resolve(host.handle(CONTROLLER, request).then((value) => value ?? null));
      });
    };
    const before = scenario.calls.length;
    const first = a.send({ type: 'user', content: 'one' });
    await vi.waitFor(() => expect(restoreGate).not.toBeNull());
    const second = a.send({ type: 'user', content: 'two' });
    await sleep(5);
    expect(scenario.calls.slice(before).filter((call) => call.method === 'send')).toEqual([]);
    restoreGate!();
    await Promise.all([first, second]);
    await vi.waitFor(() => expect(scenario.calls.slice(before).map((call) => call.method === 'send'
      ? `send:${(call.args[0] as { content: string }).content}`
      : call.method)).toEqual(['setExtraDirs', 'send:one', 'send:two']));
    expect(scenario.started).toHaveLength(3);
  });

  it('after a failed reconnect the next send tries again instead of reusing the failed attempt', async () => {
    limits = { perDevice: 16, total: 64 };
    const pool = newPool();
    const a = await start(pool);
    const events = watch(a);
    await ask(a, events, 'hello');
    await sleep(5);
    expect(await pool.releaseForRetry(member('other', 0, false))).toBe(true);
    intercept = (request) => {
      if (request.op !== 'open') return undefined;
      intercept = null;
      throw new Error('[REMOTE_AGENT_UNAVAILABLE] offline');
    };
    await expect(a.send({ type: 'user', content: 'lost' })).rejects.toThrow('offline');
    expect(await ask(a, events, 'again')).toBe('ok:again');
    expect(scenario.started).toHaveLength(2);
  });

  it('when a release close does not get through, makes room before opening instead of hitting the limit, then closes it', async () => {
    limits = { perDevice: 2, total: 64 };
    const pool = new RemoteConnectionPool({ idleMinutes: () => idleMinutes, checkMs: 3_600_000, closeRetryMs: 20 });
    const a = await start(pool);
    await ask(a, watch(a), 'hello');
    await sleep(5);
    const b = await start(pool);
    await ask(b, watch(b), 'hello');
    // 让出 a 时 close 第一次没送到对方。
    let dropped = false;
    intercept = (request) => {
      if (request.op !== 'close' || dropped) return undefined;
      dropped = true;
      throw new Error('[DEVICE_LINK_TIMEOUT] link down');
    };
    expect(await pool.releaseForRetry(member('other', 0, false))).toBe(true);
    expect(host.limitUsage().total).toBe(2);
    await sleep(5);
    opens = 0;
    await start(pool);
    // 本机仍按 a 占着算：打开前先让了 b，没有白开一次撞上限。
    expect(opens).toBe(1);
    // 再发的 close 送到后，对方结束 a。
    await vi.waitFor(() => expect(host.limitUsage().total).toBe(1));
  });

  // PR #6483 review：连回后补发设置失败只记日志，消息照样在缺设置的 Agent 上执行。
  it('fails the reconnect when restoring settings fails: nothing is sent, the run is closed, and the next send restores them', async () => {
    limits = { perDevice: 16, total: 64 };
    const pool = newPool();
    const a = await start(pool);
    const events = watch(a);
    await ask(a, events, 'hello');
    await a.setExtraDirs!([], path.join(root, 'library'));
    await sleep(5);
    expect(await pool.releaseForRetry(member('other', 0, false))).toBe(true);
    expect(host.limitUsage().total).toBe(0);
    scenario.failSetExtraDirs = 1;
    const before = scenario.calls.length;
    await expect(a.send({ type: 'user', content: 'one' })).rejects.toThrow('[REMOTE_AGENT_UNAVAILABLE]');
    expect(scenario.calls.slice(before).map((call) => call.method)).toEqual(['setExtraDirs']);
    // 这次开的进程关掉、名额还回去。
    await vi.waitFor(() => expect(host.limitUsage().total).toBe(0));
    expect(await ask(a, events, 'two')).toBe('ok:two');
    expect(scenario.calls.slice(before).map((call) => call.method)).toEqual(['setExtraDirs', 'setExtraDirs', 'send']);
    expect(scenario.started).toHaveLength(3);
  });

  // PR #6483 第三轮：self 让出时 close 没送到，接回前本机不算自己的旧 run，对方按上限拒绝，且不会选 self 让出。
  it.each([
    ['gets through', 1, 'ok:again'],
    ['still fails', Infinity, '[DEVICE_LIMIT]'],
  ])('when its own release close did not get through and the retried close %s, a reconnect closes the old run first', async (_label, drops, outcome) => {
    const pool = new RemoteConnectionPool({ idleMinutes: () => idleMinutes, checkMs: 3_600_000, closeRetryMs: 3_600_000 });
    const a = await start(pool);
    const events = watch(a);
    await ask(a, events, 'hello');
    await sleep(5);
    let dropped = 0;
    intercept = (request) => {
      if (request.op !== 'close' || dropped >= drops) return undefined;
      dropped += 1;
      throw new Error('[DEVICE_LINK_TIMEOUT] link down');
    };
    expect(await pool.releaseForRetry(member('other', 0, false))).toBe(true);
    // 对方还开着 a 的旧 run(名额 1 已占满)。
    expect(host.limitUsage().total).toBe(1);
    opens = 0;
    if (outcome.startsWith('ok:')) {
      expect(await ask(a, events, 'again')).toBe(outcome);
      // 先关掉了 a 的旧 run 再打开，没有撞上限。
      expect(opens).toBe(1);
      expect(dropped).toBe(1);
      expect(host.limitUsage().total).toBe(1);
      expect(scenario.started).toHaveLength(2);
    } else {
      // 旧 run 还是关不掉：照常按对方的上限报错，不死循环。
      await expect(a.send({ type: 'user', content: 'again' })).rejects.toThrow(outcome);
      expect(opens).toBe(1);
      expect(dropped).toBeLessThanOrEqual(3);
    }
  });

  it('still counts the old run of a task closed while its release close was undelivered, then drops it once closed', async () => {
    limits = { perDevice: 2, total: 64 };
    const pool = new RemoteConnectionPool({ idleMinutes: () => idleMinutes, checkMs: 3_600_000, closeRetryMs: 50 });
    const a = await start(pool);
    await ask(a, watch(a), 'hello');
    await sleep(5);
    const b = await start(pool);
    await ask(b, watch(b), 'hello');
    let dropped = false;
    intercept = (request) => {
      if (request.op !== 'close' || dropped) return undefined;
      dropped = true;
      throw new Error('[DEVICE_LINK_TIMEOUT] link down');
    };
    expect(await pool.releaseForRetry(member('other', 0, false))).toBe(true);
    // 占位期间关掉任务 a：对方的旧 run 还在。
    await a.close({ reason: 'navigation' });
    expect(host.limitUsage().total).toBe(2);
    await sleep(5);
    opens = 0;
    await start(pool);
    // 仍按 a 的旧 run 占着算：打开前先让了 b，只开一次，没有撞上限。
    expect(opens).toBe(1);
    // 重发的 close 送到后，对方结束 a 的旧 run，本机也不再占位。
    await vi.waitFor(() => expect(host.limitUsage().total).toBe(1));
    await vi.waitFor(() => expect(pool.occupied()).toBe(1));
  });

  // PR #6483 review：接回前就取走了供应商组的「新一轮」标记，接回失败后重试不再带 groupNewRound。
  it('keeps the provider-group new-round mark until a reconnect succeeds', async () => {
    limits = { perDevice: 16, total: 64 };
    const pool = newPool();
    let newRound = false;
    const a = await startRemoteAgentSession('claude-code', {
      sessionId: randomUUID(), workingDir: project, model: 'm1',
    } as StartSessionOptions, {
      ...deps(pool),
      groupSwitch: { offer() {}, takeNewRound: () => { const taken = newRound; newRound = false; return taken; } },
    });
    opened.push(a);
    const events = watch(a);
    await ask(a, events, 'hello');
    await sleep(5);
    expect(await pool.releaseForRetry(member('other', 0, false))).toBe(true);
    newRound = true;
    const sentOptions: Array<Record<string, unknown>> = [];
    let offline = true;
    intercept = (request) => {
      if (request.op === 'open' && offline) {
        offline = false;
        throw new Error('[REMOTE_AGENT_UNAVAILABLE] offline');
      }
      if (request.op === 'call' && request.method === 'send') {
        sentOptions.push((request.payload as { json: unknown[] }).json[1] as Record<string, unknown>);
      }
      return undefined;
    };
    await expect(a.send({ type: 'user', content: 'lost' })).rejects.toThrow('offline');
    expect(newRound).toBe(true);
    expect(await ask(a, events, 'again')).toBe('ok:again');
    expect(sentOptions).toHaveLength(1);
    expect(sentOptions[0].groupNewRound).toBe(true);
    expect(newRound).toBe(false);
  });

  it('gives up a release once a send has started', async () => {
    const pool = newPool();
    const a = await start(pool);
    const events = watch(a);
    await ask(a, events, 'hello');
    await sleep(5);
    // 发送一开始(还没到对方)就不能再让。
    const sending = a.send({ type: 'user', content: 'hold' });
    expect(await pool.releaseForRetry(member('other', 0, false))).toBe(false);
    await vi.waitFor(() => expect(scenario.releaseHold).not.toBeNull());
    expect(await pool.releaseForRetry(member('other', 0, false))).toBe(false);
    scenario.releaseHold?.();
    await sending;
    await events.until((event) => event.type === 'done' && events.seen.filter((item) => item.type === 'done').length >= 2);
    expect(scenario.closes).toBe(0);
  });

  it.each(['navigation', 'account-boundary'] as const)('closing a released task (%s) does not contact the other computer', async (reason) => {
    const pool = newPool();
    const a = await start(pool);
    await ask(a, watch(a), 'hello');
    await sleep(5);
    await start(pool);
    const closes = scenario.closes;
    await expect(a.close({ reason })).resolves.toBeUndefined();
    await expect(a.close({ reason })).resolves.toBeUndefined();
    expect(scenario.closes).toBe(closes);
    expect(pool.size).toBe(1);
  });

  it('detaching a released task on app quit does not contact the other computer', async () => {
    const pool = newPool();
    const a = await start(pool);
    await ask(a, watch(a), 'hello');
    await sleep(5);
    await start(pool);
    const closes = scenario.closes;
    await expect(a.detach!({ reason: 'app-quit' })).resolves.toBeUndefined();
    expect(scenario.closes).toBe(closes);
  });

  it('closing during a release waits for it and stays quiet', async () => {
    const pool = newPool();
    const a = await start(pool);
    await ask(a, watch(a), 'hello');
    await sleep(5);
    let closeGate: (() => void) | null = null;
    intercept = (request) => {
      if (request.op !== 'close' || closeGate) return undefined;
      return new Promise((resolve) => {
        closeGate = () => resolve(host.handle(CONTROLLER, request).then((value) => value ?? null));
      });
    };
    const opening = start(pool);
    await vi.waitFor(() => expect(closeGate).not.toBeNull());
    const closing = a.close({ reason: 'navigation' });
    closeGate!();
    await expect(closing).resolves.toBeUndefined();
    await opening;
    expect(scenario.closes).toBe(1);
  });

  it('keeps a task whose session id the provider would rewrite, so its conversation is not lost', async () => {
    const pool = newPool();
    // 像 Pi 那样，会话 id 是对方电脑上的文件路径，且落在这台电脑工作目录的上级目录下。
    nextNativeId = path.join(project, '..', 'pi-sessions', 'a.jsonl');
    const a = await start(pool);
    const events = watch(a);
    await ask(a, events, 'hello');
    await sleep(5);
    await expect(start(pool)).rejects.toThrow('[DEVICE_LIMIT]');
    expect(scenario.closes).toBe(0);
  });

  it('keeps a task with a pending rewind until its next turn finishes', async () => {
    const pool = newPool();
    const a = await start(pool);
    const events = watch(a);
    await ask(a, events, 'hello');
    await a.commitRewindFiles!('', 'assistant-1');
    await sleep(5);
    await expect(start(pool)).rejects.toThrow('[DEVICE_LIMIT]');
    await ask(a, events, 'after rewind');
    await sleep(5);
    await start(pool);
    expect(scenario.closes).toBe(1);
  });

  it('carries rewind and fork options when released before the first turn ran', async () => {
    const pool = newPool();
    const vendorOptions = { resumeSessionAt: 'msg-1', forkSession: true };
    const a = await start(pool, { resumeSessionId: 'native-old', vendorOptions } as Partial<StartSessionOptions>);
    await sleep(5);
    await start(pool);
    const events = watch(a);
    await sleep(5);
    await ask(a, events, 'first');
    expect(scenario.started[2].options).toMatchObject({ resumeSessionId: 'native-old', vendorOptions });
  });

  it('closes the other computer\'s process when the task is closed while reconnecting', async () => {
    const pool = newPool();
    const a = await start(pool);
    await ask(a, watch(a), 'hello');
    await sleep(5);
    await start(pool);
    await sleep(5);
    // 连回的 open 在路上时关掉任务。
    let openGate: (() => void) | null = null;
    intercept = (request) => {
      if (request.op !== 'open' || openGate) return undefined;
      return new Promise((resolve) => {
        openGate = () => resolve(host.handle(CONTROLLER, request).then((value) => value ?? null));
      });
    };
    const sending = a.send({ type: 'user', content: 'late' });
    await vi.waitFor(() => expect(openGate).not.toBeNull());
    const closing = a.close({ reason: 'navigation' });
    openGate!();
    await closing;
    await expect(sending).rejects.toThrow();
    // b 为 a 让了位；a 连回途中被关掉，对方不能留下 a 的进程。
    await vi.waitFor(() => expect(host.limitUsage().total).toBe(0));
    expect(pool.size).toBe(1);
  });

  it('does not grant a cleared library folder again after reconnecting', async () => {
    const pool = newPool();
    const a = await start(pool);
    const events = watch(a);
    await ask(a, events, 'hello');
    await a.setExtraDirs!([], path.join(root, 'library'));
    await a.setExtraDirs!([]);
    await sleep(5);
    await start(pool);
    await sleep(5);
    const before = scenario.calls.length;
    await ask(a, events, 'again');
    expect(scenario.calls.slice(before).map((call) => call.method)).toEqual(['send']);
  });

  /** 建一个带标记文件的目录。 */
  const dirWith = (name: string) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'f.txt'), `in-${name}`);
    return dir;
  };
  const lastExtraDirs = () => scenario.calls.filter((call) => call.method === 'setExtraDirs').at(-1)!.args[0] as string[];
  /** 让对方 Agent 按虚拟路径读文件。 */
  const readVirtual = (handle: AgentSessionHandle, watcher: ReturnType<typeof watch>, file: string) => {
    catTarget = file;
    return ask(handle, watcher, 'cat');
  };

  // PR #6483 review：连回时用新的打开结果整体替换路径映射，运行中分配的 runtime-* 丢失；
  // 消息里的路径又在连回前按旧映射转换。
  it('keeps directories added while connected or released at their virtual paths after reconnecting', async () => {
    const pool = newPool();
    const live = dirWith('live');
    const later = dirWith('later');
    const a = await start(pool);
    const events = watch(a);
    await ask(a, events, 'hello');
    await a.setExtraDirs!([live]);
    const [liveVirtual] = lastExtraDirs();
    expect(liveVirtual).toContain('runtime-');
    await sleep(5);
    await start(pool);
    // 让出期间再加一个：只记在本机，连回后按运行中改目录补发。
    await a.setExtraDirs!([live, later]);
    await sleep(5);
    // 路径一律用 path.join 拼：Windows 上投影后的路径用反斜杠。
    await ask(a, events, `look at ${path.join(live, 'f.txt')} and ${path.join(later, 'f.txt')}`);
    expect(scenario.started).toHaveLength(3);
    expect(scenario.started[2].extraDirs).toEqual([]);
    const replayed = lastExtraDirs();
    expect(replayed[0]).toBe(liveVirtual);
    // 对方收到的消息里是连回后的虚拟路径。
    const sent = scenario.calls.filter((call) => call.method === 'send').at(-1)!.args[0] as { content: string };
    expect(sent.content).toBe(`look at ${path.join(replayed[0], 'f.txt')} and ${path.join(replayed[1], 'f.txt')}`);
    expect(await readVirtual(a, events, path.join(liveVirtual, 'f.txt'))).toContain('in-live');
    expect(await readVirtual(a, events, path.join(replayed[1], 'f.txt'))).toContain('in-later');
  });

  it('never points an old virtual path at another directory after a middle directory is removed and the task reconnects', async () => {
    const pool = newPool();
    const dirs = ['x', 'a', 'b'].map(dirWith);
    const a = await start(pool, { extraDirs: dirs });
    const events = watch(a);
    await ask(a, events, 'hello');
    const virtual = scenario.started[0].extraDirs!;
    expect(virtual).toHaveLength(3);
    await a.setExtraDirs!(dirs.slice(1));
    await sleep(5);
    await start(pool);
    await sleep(5);
    expect(await readVirtual(a, events, `${virtual[1]}/f.txt`)).toContain('in-a');
    expect(await readVirtual(a, events, `${virtual[2]}/f.txt`)).toContain('in-b');
    // 打开时给对方的仍是第一次的列表(序号不变)，删掉的那个由补发去掉。
    expect(scenario.started[2].extraDirs).toEqual(virtual);
    expect(lastExtraDirs()).toEqual(virtual.slice(1));
  });

  it('answers that a model switch needs no extra rebuild while released, without reconnecting', async () => {
    const pool = newPool();
    const a = await start(pool);
    await ask(a, watch(a), 'hello');
    expect(await a.requiresModelSwitchRebuild!('m2')).toBe(true);
    await sleep(5);
    await start(pool);
    expect(await a.requiresModelSwitchRebuild!('m2')).toBe(false);
    expect(scenario.started).toHaveLength(2);
  });

  it('keeps the last usage reading after reconnecting until the new process reports its own', async () => {
    const pool = newPool();
    const a = await start(pool);
    const events = watch(a);
    await ask(a, events, 'hello');
    const usage = a.getUsageSnapshot();
    expect(usage.tokenUsage).toBe(7);
    await sleep(5);
    await start(pool);
    expect(a.getUsageSnapshot()).toEqual(usage);
  });
});
