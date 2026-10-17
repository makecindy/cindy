/**
 * 供应商组替受邀者中转(docs/product-rules/provider-groups.md §4、§9)，三端同进程、经 JSON 往返模拟设备互联：
 * 受邀者 G ⇄ 组所在电脑 O(createRemoteAgentHost + groupRelay) ⇄ 组内电脑 M(createRemoteAgentHost)。
 *  - 受邀者的新任务按组交给 M；M 按受邀者隔离运行(受邀者目录、会话索引按 relay 分开)；
 *  - 两个受邀者用同一个任务 id 不会在 M 上撞车；续接只回到当初那台；不能接回别的受邀者的会话；
 *  - 启动阶段那台接不下(不支持按受邀者隔离)就换下一台；
 *  - 删掉受邀者时请 M 清掉它留下的东西，M 只清调用方自己的 relay。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isProviderSharePeer, providerShareGuestPeer, REMOTE_AGENT_MAX_RUNS_PER_CONTROLLER } from '@cindy/device-link';
import type { AgentEvent, AgentSessionHandle } from '@cindy/maker-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderGroupGuestRelay } from '../../provider-group/guestRelay';
import { createProviderGroupExternalLoad } from '../../provider-group/externalLoad';
import type { ProviderGroupRouter } from '../../provider-group/router';
import { decideProviderGroupFailure } from '../../provider-group/failurePolicy';

import { RemoteAgentPoller } from '../controller/poller';
import { RemoteAgentRunClient } from '../controller/runClient';
import { relayKeyFor, reshareKeyFor, type RelayRunFailure } from '../host/groupRelay';
import {
  createRemoteAgentHost,
  hostSessionIdFor,
  type GroupRelayMember,
  type GroupRelayPlan,
  type HostedStartInput,
  type RemoteAgentGroupRelayDeps,
} from '../host/runHost';

const GUEST_A = 'share-guest-a';
const GUEST_B = 'share-guest-b';
const OWNER_DEVICE = 'group-owner-mac';
const SESSION = 'task-1';

let root: string;

interface Started {
  input: HostedStartInput;
  sends: unknown[];
  /** 让这台上的 Agent 发出一个事件。 */
  emit(event: AgentEvent): void;
  /** 这台上是否正在运行一轮(写进状态)。 */
  running: boolean;
  /** 这台上的 Agent 事件流意外结束(进程退出等)。 */
  end(): void;
}

function fakeAgentHost(name: string, started: Started[], options: {
  trust: (controller: string) => 'guest' | 'owner';
  guestRelayCapable?: boolean;
  purge?: (hostSessionIds: readonly string[], nativeIds: readonly string[]) => Promise<void>;
  groupRelay?: RemoteAgentGroupRelayDeps;
  /** 这台的 Agent 启动失败(启动前受邀者目录已经建好)。 */
  failStart?: boolean;
  /** 这台的 Agent 一启动就结束。 */
  endImmediately?: boolean;
  /** 转分享的同意(本机是分享者)。 */
  reshare?: Parameters<typeof createRemoteAgentHost>[0]['reshare'];
  resolveProvider?: NonNullable<Parameters<typeof createRemoteAgentHost>[0]['providerAccess']>['resolve'];
}) {
  return createRemoteAgentHost({
    isAgentAvailable: () => true,
    startHosted: async (input) => {
      if (options.failStart) throw new Error('the agent could not start');
      const queue: AgentEvent[] = [];
      let wake: (() => void) | null = null;
      let ended = false;
      const record: Started = {
        input,
        sends: [],
        running: false,
        emit(event) {
          queue.push(event);
          wake?.();
          wake = null;
        },
        end() {
          ended = true;
          wake?.();
          wake = null;
        },
      };
      started.push(record);
      const handle: AgentSessionHandle = {
        id: `sdk-${name}-${input.hostSessionId}`,
        agentKind: input.kind,
        model: input.options.model,
        async send(message) {
          record.sends.push(message);
        },
        async steer() {},
        async abort() {},
        isTurnRunning: () => record.running,
        async close() {},
        events: () => ({
          [Symbol.asyncIterator]: (): AsyncIterator<AgentEvent> => ({
            next: async () => {
              if (options.endImmediately) return { value: undefined as unknown as AgentEvent, done: true };
              while (queue.length === 0 && !ended) await new Promise<void>((resolve) => { wake = resolve; });
              if (queue.length === 0) return { value: undefined as unknown as AgentEvent, done: true };
              return { value: queue.shift()!, done: false };
            },
          }),
        }),
        getUsageSnapshot: () => ({ tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 }),
        setInteractionResolver() {},
      };
      return handle;
    },
    isControllerAuthorized: () => true,
    controllerTrust: options.trust,
    providerAccess: {
      resolve: options.resolveProvider ?? (async (_kind, _model, providerId) => providerId ?? 'shared-provider'),
      isAllowed: () => true,
    },
    ...(options.guestRelayCapable === false ? {} : {
      bindGuestProviderRoute: async () => ({ routeToken: 'route', modelIds: ['claude-opus'], release: () => {} }),
    }),
    ...(options.purge ? { purgeHostedTranscripts: options.purge } : {}),
    ...(options.groupRelay ? { groupRelay: options.groupRelay } : {}),
    ...(options.reshare ? { reshare: options.reshare } : {}),
    captureOwner: () => 'owner',
    isOwnerCurrent: () => true,
    runsRoot: path.join(root, name),
  });
}

function openPayload(sessionId: string, extra: Record<string, unknown> = {}) {
  return {
    sessionId,
    virtualWorkspace: true,
    options: { model: 'claude-opus', ...(extra.options as object | undefined) },
    workspace: { workingDir: '/Users/guest/proj', platform: 'darwin', shell: 'zsh' },
    projectFiles: [],
    ancestorFiles: [],
    personal: { files: [] },
    mcpServers: [],
    ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== 'options')),
  };
}

const jsonRoundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

async function waitFor(condition: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function readOwnerGuestIndex(): Record<string, { controller: string; forgetPending?: string[]; nativeIds: string[] }> {
  return JSON.parse(fs.readFileSync(path.join(root, 'owner', 'guest-sessions.json'), 'utf8'));
}

async function waitForGuestPurge(controller: string, env: ReturnType<typeof setup>): Promise<void> {
  for (
    let requestIndex = 0;
    requestIndex < env.relay.forget.mock.results.length;
    requestIndex += 1
  ) {
    await Promise.allSettled([env.relay.forget.mock.results[requestIndex].value]);
  }
  // 远端删目录后还会写索引；等组所在电脑确认远端完成并落盘，避免 teardown 与后台写入竞争。
  await waitFor(() =>
    Object.values(readOwnerGuestIndex()).every((record) => record.controller !== controller),
  );
}

const MEMBER_MINI: GroupRelayMember = { memberKey: 'device:mini:anthropic-2', agentDeviceId: 'mini', providerId: 'anthropic-2', sameAccount: true };
const MEMBER_STUDIO: GroupRelayMember = { memberKey: 'device:studio:anthropic', agentDeviceId: 'studio', providerId: 'anthropic', sameAccount: true };

/** 真实组启动判定接到三端 harness，验证本机与中转启动入口确实服从任务错误和自动切换开关。 */
function startFailurePolicy(autoSwitch: boolean) {
  const router = { markCooling: vi.fn() } as unknown as ProviderGroupRouter;
  const externalLoad = createProviderGroupExternalLoad({ now: Date.now });
  return createProviderGroupGuestRelay({
    scope: () => ({ router, externalLoad, isCurrent: () => true }),
    readGroup: () => ({ strategy: 'order', autoSwitch, members: [
      { key: 'local', kind: 'local', agentDeviceId: null, providerId: 'shared-provider', limit: 4, weight: 1, paused: false },
      ...[MEMBER_MINI, MEMBER_STUDIO].map((m) => ({ key: m.memberKey, kind: 'device' as const, agentDeviceId: m.agentDeviceId, providerId: m.providerId, limit: 4, weight: 1, paused: false })),
    ] }),
    connect: () => { throw new Error('not used for failure decisions'); },
    now: Date.now,
    log: { warn: vi.fn() },
  }).noteStartFailure;
}

function setup(options: {
  plans?: GroupRelayPlan[];
  miniCapable?: boolean;
  switchWorthy?: (failure: RelayRunFailure) => boolean;
  /** mini 这台的 Agent 表现。 */
  mini?: { failStart?: boolean; endImmediately?: boolean };
  /** 组所在电脑本机的 Agent 表现(组选中本机这一台时)。 */
  owner?: { failStart?: boolean };
  /** 截住组所在电脑发给组内电脑的请求(模拟回包丢失、应答慢)。 */
  intercept?: (agentDeviceId: string, request: Record<string, unknown>, forward: () => Promise<unknown>) => Promise<unknown>;
} = {}) {
  const memberStarted: Record<string, Started[]> = { mini: [], studio: [] };
  const members = {
    mini: fakeAgentHost('mini', memberStarted.mini, {
      trust: () => 'owner',
      guestRelayCapable: options.miniCapable ?? true,
      purge: async () => undefined,
      ...options.mini,
    }),
    studio: fakeAgentHost('studio', memberStarted.studio, { trust: () => 'owner', purge: async () => undefined }),
  };
  const memberInvoke = (agentDeviceId: string) => async (args: unknown[]) => {
    const request = jsonRoundTrip(args[0]) as Record<string, unknown>;
    // 不在组里的设备 id(模拟连不上的电脑)在这里抛错。
    const forward = async () => jsonRoundTrip(await members[agentDeviceId as keyof typeof members].handle(OWNER_DEVICE, request));
    return options.intercept ? options.intercept(agentDeviceId, request, forward) : forward();
  };
  const pollers = new Map<string, RemoteAgentPoller>();
  const plans = [...(options.plans ?? [{ kind: 'member', ...MEMBER_MINI }])];
  const relay = {
    plan: vi.fn(async () => plans.shift() ?? null),
    connect: vi.fn((agentDeviceId: string) => {
      let poller = pollers.get(agentDeviceId);
      if (!poller) {
        poller = new RemoteAgentPoller(memberInvoke(agentDeviceId));
        pollers.set(agentDeviceId, poller);
      }
      return { invoke: poller.invoke, poller };
    }),
    // 与本机任务同一个判定：默认换下一台(guestRelay 的判定见 provider-group/__tests__/guestRelay.test.ts)。
    noteStartFailure: vi.fn<RemoteAgentGroupRelayDeps['noteStartFailure']>(() => true),
    noteRunFailure: vi.fn((_providerId: string, _member: GroupRelayMember, failure: RelayRunFailure) =>
      options.switchWorthy?.(failure) ?? true),
    trackRun: vi.fn(() => ({ setRunning: vi.fn(), release: vi.fn() })),
    forget: vi.fn(async (agentDeviceId: string, relayKey: string) => {
      await memberInvoke(agentDeviceId)([{ op: 'forget', relay: relayKey }]);
    }),
  } satisfies RemoteAgentGroupRelayDeps;
  const ownerStarted: Started[] = [];
  const owner = fakeAgentHost('owner', ownerStarted, {
    trust: (controller) => (controller.startsWith('share-') || isProviderSharePeer(controller) ? 'guest' : 'owner'),
    purge: async () => undefined,
    groupRelay: relay,
    ...options.owner,
  });
  return { owner, members, memberStarted, ownerStarted, relay };
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-group-relay-')));
});

afterEach(async () => {
  await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

let runSeq = 0;
function runId(): string {
  runSeq += 1;
  return `11111111-1111-4111-8111-${String(runSeq).padStart(12, '0')}`;
}

async function openAsGuest(env: ReturnType<typeof setup>, guest: string, payload: Record<string, unknown>) {
  const poller = new RemoteAgentPoller(async (args) => jsonRoundTrip(await env.owner.handle(guest, jsonRoundTrip(args[0]))));
  let counter = 0;
  /** 受邀者按顺序收到的事件与状态。 */
  const stream: Array<{ t: 'event'; event: AgentEvent } | { t: 'state'; state: Record<string, unknown> }> = [];
  const client = new RemoteAgentRunClient(runId(), poller, {
    onEvent: (event) => {
      stream.push({ t: 'event', event: event as AgentEvent });
    },
    onState: (state) => {
      stream.push({ t: 'state', state });
    },
    onRequest: async () => ({ type: 'callback', value: undefined }),
    onWs: () => undefined,
    onClosed: (reason) => {
      closedReason = reason;
    },
  }, () => `22222222-2222-4222-8222-${String(++counter + runSeq * 100).padStart(12, '0')}`);
  let closedReason: string | null = null;
  const started = await client.open('claude-code', payload);
  return { client, started, stream, isClosed: () => closedReason !== null, closedReason: () => closedReason };
}

const USAGE_LIMIT_ERROR: AgentEvent = {
  type: 'error',
  data: { message: 'You have hit your usage limit', isTerminal: true, usageLimit: true },
} as AgentEvent;

function switchTokenIn(stream: Awaited<ReturnType<typeof openAsGuest>>['stream']): string | undefined {
  for (const item of stream) {
    if (item.t === 'state' && typeof item.state.providerGroupSwitch === 'string') return item.state.providerGroupSwitch;
  }
  return undefined;
}

describe('provider group relay for shared users', () => {
  it('hands a shared user’s new task to the chosen computer, which runs it isolated as a shared user', async () => {
    const env = setup();
    const { client, started } = await openAsGuest(env, GUEST_A, openPayload(SESSION));
    expect(env.ownerStarted).toHaveLength(0);
    expect(env.memberStarted.mini).toHaveLength(1);
    const input = env.memberStarted.mini[0].input;
    expect(input.guest).toBe(true);
    expect(input.guestProvider?.providerId).toBe('anthropic-2');
    expect(input.options.providerId).toBe('anthropic-2');
    // 组内电脑上的任务 id 按受邀者派生，不是受邀者原来的 id。
    expect(input.hostSessionId).not.toBe(hostSessionIdFor(OWNER_DEVICE, SESSION));
    expect(input.guestHome).toContain(path.join('mini', 'guest-homes'));
    expect(started.id).toBe(`sdk-mini-${input.hostSessionId}`);
    await client.call('send', [{ content: 'hello', attachments: [] }, {}]);
    expect(env.memberStarted.mini[0].sends).toHaveLength(1);
    expect(env.relay.trackRun).toHaveBeenCalledWith('shared-provider', MEMBER_MINI.memberKey);
    await client.close('close', 'navigation');
  });

  it('keeps two shared users apart on the computer even with the same task id', async () => {
    const env = setup({ plans: [{ kind: 'member', ...MEMBER_MINI }, { kind: 'member', ...MEMBER_MINI }] });
    const a = await openAsGuest(env, GUEST_A, openPayload(SESSION));
    const b = await openAsGuest(env, GUEST_B, openPayload(SESSION));
    const [first, second] = env.memberStarted.mini.map((record) => record.input);
    expect(first.hostSessionId).not.toBe(second.hostSessionId);
    expect(first.guestHome).not.toBe(second.guestHome);
    await a.client.close('close', 'navigation');
    await b.client.close('close', 'navigation');
  });

  it('resumes only on the computer that ran the conversation, and never another shared user’s', async () => {
    const env = setup();
    const first = await openAsGuest(env, GUEST_A, openPayload(SESSION));
    const nativeId = first.started.id as string;
    await first.client.close('close', 'navigation');
    await waitFor(() => env.members.mini.runCount() === 0);

    const resumed = await openAsGuest(env, GUEST_A, openPayload(SESSION, { options: { resumeSessionId: nativeId } }));
    expect(env.relay.plan).toHaveBeenCalledTimes(1);
    expect(env.memberStarted.mini).toHaveLength(2);
    expect(env.memberStarted.mini[1].input.options.resumeSessionId).toBe(nativeId);
    await resumed.client.close('close', 'navigation');

    await expect(openAsGuest(env, GUEST_B, openPayload(SESSION, { options: { resumeSessionId: nativeId } })))
      .rejects.toThrow(/cannot be resumed/);
  });

  it('moves on to the next computer when the first cannot isolate shared users', async () => {
    const env = setup({ miniCapable: false, plans: [{ kind: 'member', ...MEMBER_MINI }, { kind: 'member', ...MEMBER_STUDIO }] });
    const { client } = await openAsGuest(env, GUEST_A, openPayload(SESSION));
    expect(env.memberStarted.mini).toHaveLength(0);
    expect(env.memberStarted.studio).toHaveLength(1);
    expect(env.relay.noteStartFailure).toHaveBeenCalledWith('shared-provider', MEMBER_MINI, expect.any(Error), 'claude-opus');
    expect(env.relay.plan).toHaveBeenLastCalledWith(expect.objectContaining({ exclude: new Set([MEMBER_MINI.memberKey]) }));
    await client.close('close', 'navigation');
  });

  it('moves on to the next computer when this computer was picked but its agent does not start', async () => {
    const env = setup({ owner: { failStart: true }, plans: [{ kind: 'local' }, { kind: 'member', ...MEMBER_MINI }] });
    const { client } = await openAsGuest(env, GUEST_A, openPayload(SESSION));
    expect(env.memberStarted.mini).toHaveLength(1);
    // 与组内电脑接不下同一个判定；换下一台时不再回到本机这一台。
    expect(env.relay.noteStartFailure).toHaveBeenCalledWith('shared-provider', expect.objectContaining({ memberKey: 'local' }), expect.any(Error), 'claude-opus');
    expect(env.relay.plan).toHaveBeenLastCalledWith(expect.objectContaining({ exclude: new Set(['local']) }));
    await client.close('close', 'navigation');
  });

  it.each(['local', 'remote', 'old-peer'] as const)('关闭自动换电脑后 %s 启动失败不尝试下一台', async (kind) => {
    const env = setup({
      ...(kind === 'local' ? { owner: { failStart: true } } : { mini: { failStart: true } }),
      ...(kind === 'old-peer' ? { miniCapable: false } : {}),
      plans: [kind === 'local' ? { kind: 'local' } : { kind: 'member', ...MEMBER_MINI }, { kind: 'member', ...MEMBER_STUDIO }],
    });
    env.relay.noteStartFailure.mockImplementation(startFailurePolicy(false));
    await expect(openAsGuest(env, GUEST_A, openPayload(SESSION))).rejects.toThrow();
    expect(env.relay.noteStartFailure).toHaveBeenCalledTimes(1);
    expect(env.relay.plan).toHaveBeenCalledTimes(1);
    expect(env.memberStarted.studio).toHaveLength(0);
  });

  it.each(['INVALID_PARAMS', 'SESSION_RUNNING', 'PRECONDITION_FAILED'])(
    '中转启动的 %s 任务错误不会逐台重试', async (code) => {
      const env = setup({
        plans: [{ kind: 'member', ...MEMBER_MINI }, { kind: 'member', ...MEMBER_STUDIO }],
        intercept: async (_device, request, forward) => {
          if (request.op === 'open') throw new Error(`[${code}] task cannot start`);
          return forward();
        },
      });
      env.relay.noteStartFailure.mockImplementation(startFailurePolicy(true));
      await expect(openAsGuest(env, GUEST_A, openPayload(SESSION))).rejects.toThrow(code);
      expect(env.relay.plan).toHaveBeenCalledTimes(1);
      expect(env.memberStarted.studio).toHaveLength(0);
    },
  );

  it('runs locally when the group picks this computer, and refuses when no computer can run it', async () => {
    const local = setup({ plans: [{ kind: 'local' }] });
    const { client } = await openAsGuest(local, GUEST_A, openPayload(SESSION));
    expect(local.ownerStarted).toHaveLength(1);
    expect(local.ownerStarted[0].input.guest).toBe(true);
    await client.close('close', 'navigation');

    const none = setup({ plans: [{ kind: 'unavailable' }] });
    await expect(openAsGuest(none, GUEST_A, openPayload(SESSION))).rejects.toThrow(/REMOTE_AGENT_UNAVAILABLE/);
  });

  it('asks the computer to forget a removed shared user, and the computer clears only that user', async () => {
    const env = setup({ plans: [{ kind: 'member', ...MEMBER_MINI }, { kind: 'member', ...MEMBER_MINI }] });
    const a = await openAsGuest(env, GUEST_A, openPayload(SESSION));
    const b = await openAsGuest(env, GUEST_B, openPayload(SESSION));
    const homeA = env.memberStarted.mini[0].input.guestHome!;
    const homeB = env.memberStarted.mini[1].input.guestHome!;
    expect(fs.existsSync(homeA) && fs.existsSync(homeB)).toBe(true);
    await env.owner.purgeControllers((controller) => controller === GUEST_A);
    await waitForGuestPurge(GUEST_A, env);
    expect(fs.existsSync(homeA)).toBe(false);
    expect(env.relay.forget).toHaveBeenCalledWith('mini', relayKeyFor(GUEST_A));
    expect(fs.existsSync(homeB)).toBe(true);
    // 另一个控制端拿着同一个 relay 键也清不掉别人的。
    await env.members.mini.handle('someone-else', { op: 'forget', relay: relayKeyFor(GUEST_B) });
    expect(fs.existsSync(homeB)).toBe(true);
    await b.client.close('close', 'navigation');
    void a;
  });

  it('runs a relayed task from a same-account computer as a shared user, never with owner trust', async () => {
    const started: Started[] = [];
    const member = fakeAgentHost('member', started, { trust: () => 'owner' });
    const poller = new RemoteAgentPoller(async (args) => jsonRoundTrip(await member.handle(OWNER_DEVICE, jsonRoundTrip(args[0]))));
    const client = new RemoteAgentRunClient(runId(), poller, {
      onEvent: () => undefined,
      onState: () => undefined,
      onRequest: async () => ({ type: 'callback', value: undefined }),
      onWs: () => undefined,
      onClosed: () => undefined,
    }, () => '33333333-3333-4333-8333-333333333333');
    await client.open('claude-code', openPayload('relayed', { relay: relayKeyFor(GUEST_A), groupAssigned: true }));
    expect(started[0].input.guest).toBe(true);
    // 被中转的任务不能凭 id 接上这台主人自己的会话。
    await expect(new RemoteAgentRunClient(runId(), poller, {
      onEvent: () => undefined,
      onState: () => undefined,
      onRequest: async () => ({ type: 'callback', value: undefined }),
      onWs: () => undefined,
      onClosed: () => undefined,
    }, () => '44444444-4444-4444-8444-444444444444')
      .open('claude-code', openPayload('relayed-2', { relay: relayKeyFor(GUEST_A), options: { resumeSessionId: 'owner-native' } })))
      .rejects.toThrow(/cannot be resumed/);
    await client.close('close', 'navigation');
  });
});

describe('provider group relay: starting, load and cleanup', () => {
  it('tries every computer in the group before giving up, however many there are', async () => {
    const unreachable = Array.from({ length: 9 }, (_, i): GroupRelayPlan => ({
      kind: 'member',
      memberKey: `device:off${i}:anthropic`,
      agentDeviceId: `off${i}`,
      providerId: 'anthropic',
      sameAccount: true,
    }));
    const env = setup({ plans: [...unreachable, { kind: 'member', ...MEMBER_STUDIO }] });
    const { client } = await openAsGuest(env, GUEST_A, openPayload(SESSION));
    expect(env.relay.noteStartFailure).toHaveBeenCalledTimes(9);
    expect(env.memberStarted.studio).toHaveLength(1);
    await client.close('close', 'navigation');
  });

  it('counts the load from the moment it picks, including tasks the group runs on this computer', async () => {
    const localLoad = { setRunning: vi.fn(), release: vi.fn() };
    const memberLoad = { setRunning: vi.fn(), release: vi.fn() };
    const env = setup({ plans: [{ kind: 'local', load: localLoad }, { kind: 'member', ...MEMBER_MINI, load: memberLoad }] });
    const local = await openAsGuest(env, GUEST_A, openPayload(SESSION));
    expect(env.relay.plan).toHaveBeenLastCalledWith(expect.objectContaining({ reserve: true }));
    expect(env.ownerStarted).toHaveLength(1);
    env.ownerStarted[0].emit({ type: 'text', data: { text: 'hi' } } as AgentEvent);
    await waitFor(() => localLoad.setRunning.mock.calls.length > 0);
    await local.client.close('close', 'navigation');
    await waitFor(() => localLoad.release.mock.calls.length > 0);

    const relayed = await openAsGuest(env, GUEST_A, openPayload('task-2'));
    // 选中时预占的负载直接交给中转任务，不再另记一份。
    expect(env.relay.trackRun).not.toHaveBeenCalled();
    await relayed.client.close('close', 'navigation');
    await waitFor(() => memberLoad.release.mock.calls.length > 0);
  });

  it('remembers a computer it handed the task to even if the agent failed to start there', async () => {
    const env = setup({ mini: { failStart: true }, plans: [{ kind: 'member', ...MEMBER_MINI }, { kind: 'member', ...MEMBER_STUDIO }] });
    const { client } = await openAsGuest(env, GUEST_A, openPayload(SESSION));
    expect(env.memberStarted.studio).toHaveLength(1);
    await client.close('close', 'navigation');
    await env.owner.purgeControllers((controller) => controller === GUEST_A);
    await waitForGuestPurge(GUEST_A, env);
    expect(env.relay.forget).toHaveBeenCalledWith('mini', relayKeyFor(GUEST_A));
    expect(env.relay.forget).toHaveBeenCalledWith('studio', relayKeyFor(GUEST_A));
  });

  it('waits for both computers to finish cleanup before polling the persisted guest index', async () => {
    function cleanupGate() {
      let release = () => {};
      let enter = () => {};
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      return { pending, entered, release, enter };
    }
    const cleanups = { mini: cleanupGate(), studio: cleanupGate() };
    const env = setup({
      mini: { failStart: true },
      plans: [
        { kind: 'member', ...MEMBER_MINI },
        { kind: 'member', ...MEMBER_STUDIO },
      ],
      intercept: async (agentDeviceId, request, forward) => {
        if (request.op === 'forget') {
          const cleanup = cleanups[agentDeviceId as keyof typeof cleanups];
          cleanup.enter();
          await cleanup.pending;
        }
        return forward();
      },
    });
    const { client } = await openAsGuest(env, GUEST_A, openPayload(SESSION));
    await client.close('close', 'navigation');
    await env.owner.purgeControllers((controller) => controller === GUEST_A);
    await cleanups.studio.entered;

    let outcome: 'purged' | Error | undefined;
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout'] });
    const purged = waitForGuestPurge(GUEST_A, env).then(
      () => {
        outcome = 'purged';
      },
      (error: Error) => {
        outcome = error;
      },
    );
    try {
      await vi.advanceTimersByTimeAsync(3_100);
      const whileStudioPending = outcome;
      vi.useRealTimers();
      cleanups.studio.release();
      await cleanups.mini.entered;
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout'] });
      await vi.advanceTimersByTimeAsync(3_100);
      const whileMiniPending = outcome;
      vi.useRealTimers();
      cleanups.mini.release();
      await purged;
      for (const request of env.relay.forget.mock.results) await request.value;
      await waitForGuestPurge(GUEST_A, env);

      expect(whileMiniPending).toBeUndefined();
      expect(whileStudioPending).toBeUndefined();
      expect(outcome).toBe('purged');
      expect(env.relay.forget).toHaveBeenCalledTimes(2);
      expect(env.relay.forget).toHaveBeenCalledWith('mini', relayKeyFor(GUEST_A));
      expect(env.relay.forget).toHaveBeenCalledWith('studio', relayKeyFor(GUEST_A));
    } finally {
      vi.useRealTimers();
      cleanups.mini.release();
      cleanups.studio.release();
    }
  });

  it('keeps the computers it could not reach when deleting a shared user, and asks them again later', async () => {
    const env = setup();
    const { client } = await openAsGuest(env, GUEST_A, openPayload(SESSION));
    await client.close('close', 'navigation');
    env.relay.forget.mockRejectedValueOnce(new Error('DEVICE_OFFLINE'));
    await env.owner.purgeControllers((controller) => controller === GUEST_A);
    await waitFor(() => env.relay.forget.mock.calls.length === 1);
    await waitFor(() => Object.values(readOwnerGuestIndex()).some((record) => record.forgetPending?.includes('mini')));
    // 本机这边已经清掉，只留下还要通知的那台。
    expect(Object.values(readOwnerGuestIndex()).every((record) => record.nativeIds.length === 0)).toBe(true);

    await env.owner.purgeControllers((controller) => controller === GUEST_A);
    await waitFor(() => env.relay.forget.mock.calls.length === 2);
    await waitForGuestPurge(GUEST_A, env);
    expect(Object.keys(readOwnerGuestIndex())).toHaveLength(0);
  });

  it('does not let a shared user get more tasks by filling in its own relay key', async () => {
    const started: Started[] = [];
    const host = fakeAgentHost('solo', started, { trust: () => 'guest' });
    const open = (i: number) => host.handle(GUEST_A, {
      op: 'open',
      runId: runId(),
      agentKind: 'claude-code',
      payload: { json: openPayload(`t${i}`, { relay: `r${i}` }) },
    });
    for (let i = 0; i < REMOTE_AGENT_MAX_RUNS_PER_CONTROLLER; i += 1) await open(i);
    await expect(open(99)).rejects.toThrow(/REMOTE_AGENT_BUSY/);
    await host.abortAll();
  });

  it('does not start the task on the computer when it ended while the computer was being checked', async () => {
    let releaseCaps!: () => void;
    const capsGate = new Promise<void>((resolve) => {
      releaseCaps = resolve;
    });
    let capsAsked!: () => void;
    const asked = new Promise<void>((resolve) => {
      capsAsked = resolve;
    });
    const env = setup({
      intercept: async (_device, request, forward) => {
        if (request.op === 'caps') {
          capsAsked();
          await capsGate;
        }
        return forward();
      },
    });
    const id = runId();
    await env.owner.handle(GUEST_A, { op: 'open', runId: id, agentKind: 'claude-code', payload: { json: openPayload(SESSION) } });
    await asked;
    await env.owner.handle(GUEST_A, { op: 'close', runId: id, mode: 'close', reason: 'navigation' });
    releaseCaps();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(env.memberStarted.mini).toHaveLength(0);
    expect(env.members.mini.runCount()).toBe(0);
  });

  it('passes on the end of a task that finished on the computer right after starting', async () => {
    // 那台的任务启动又结束了才放行拉取：启动与结束在同一次拉取里一起带回。
    const holder: { env?: ReturnType<typeof setup> } = {};
    holder.env = setup({
      mini: { endImmediately: true },
      intercept: async (_device, request, forward) => {
        if (request.op === 'poll') {
          await waitFor(() => holder.env!.memberStarted.mini.length === 1 && holder.env!.members.mini.runCount() === 0);
        }
        return forward();
      },
    });
    const guest = await openAsGuest(holder.env, GUEST_A, openPayload(SESSION));
    await waitFor(() => guest.isClosed());
  });

  it('closes the task on the computer when the answer to opening it was lost, then tries the next one', async () => {
    let lostRunId: unknown;
    const closed: unknown[] = [];
    const env = setup({
      plans: [{ kind: 'member', ...MEMBER_MINI }, { kind: 'member', ...MEMBER_STUDIO }],
      intercept: async (device, request, forward) => {
        const result = await forward();
        if (device === 'mini' && request.op === 'close') closed.push(request.runId);
        if (device === 'mini' && request.op === 'open' && lostRunId === undefined) {
          // 那台已经收下了打开，回包在路上丢了。
          lostRunId = request.runId;
          throw Object.assign(new Error('request timed out'), { code: 'INVOKE_TIMEOUT' });
        }
        return result;
      },
    });
    const { client } = await openAsGuest(env, GUEST_A, openPayload(SESSION));
    expect(env.memberStarted.studio).toHaveLength(1);
    // 换下一台之前已经用同一个任务 id 请那台关掉，那台上没有留下没人管的任务。
    expect(closed).toContain(lostRunId);
    await waitFor(() => env.members.mini.runCount() === 0);
    await client.close('close', 'navigation');
  });
});

describe('provider group "switch to another computer" for shared users', () => {
  it('sends the switch token before the error, and the reopened task avoids the failed computer', async () => {
    const env = setup({
      plans: [
        { kind: 'member', ...MEMBER_MINI },
        { kind: 'member', ...MEMBER_STUDIO },
        { kind: 'member', ...MEMBER_STUDIO },
      ],
    });
    const first = await openAsGuest(env, GUEST_A, openPayload(SESSION, { acceptsGroupSwitch: true }));
    env.memberStarted.mini[0].emit(USAGE_LIMIT_ERROR);
    await waitFor(() => first.stream.some((item) => item.t === 'event' && item.event.type === 'error'));
    const token = switchTokenIn(first.stream);
    expect(token).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    const tokenAt = first.stream.findIndex((item) => item.t === 'state' && item.state.providerGroupSwitch === token);
    const errorAt = first.stream.findIndex((item) => item.t === 'event' && item.event.type === 'error');
    expect(tokenAt).toBeLessThan(errorAt);
    expect(env.relay.noteRunFailure).toHaveBeenCalledWith(
      'shared-provider',
      MEMBER_MINI,
      expect.objectContaining({ usageLimit: true, message: 'You have hit your usage limit' }),
      'claude-opus',
    );
    expect(env.relay.plan).toHaveBeenLastCalledWith(expect.objectContaining({ exclude: new Set([MEMBER_MINI.memberKey]) }));
    await first.client.close('close', 'navigation');

    // 受邀者交接后带着凭证重新打开(全新会话)：组所在电脑避开出问题的那台。
    const reopened = await openAsGuest(env, GUEST_A, openPayload(SESSION, { acceptsGroupSwitch: true, groupSwitchToken: token }));
    expect(env.relay.plan).toHaveBeenLastCalledWith(expect.objectContaining({ exclude: new Set([MEMBER_MINI.memberKey]) }));
    expect(env.memberStarted.studio).toHaveLength(1);
    await reopened.client.close('close', 'navigation');
  });

  it.each([
    { code: 'REMOTE_AGENT_UNAVAILABLE', autoSwitch: true, offersSwitch: true },
    { code: 'INVALID_PARAMS', autoSwitch: true, offersSwitch: false },
    { code: 'SESSION_RUNNING', autoSwitch: true, offersSwitch: false },
    { code: 'REMOTE_AGENT_UNAVAILABLE', autoSwitch: false, offersSwitch: false },
  ])('续接的 $code 错误，autoSwitch=$autoSwitch，是否发换电脑凭证=$offersSwitch', async ({ code, autoSwitch, offersSwitch }) => {
    let failResume = false;
    const env = setup({
      intercept: async (_agentDeviceId, request, forward) => {
        if (failResume && request.op === 'open') throw new Error(`[${code}] cannot reopen`);
        return forward();
      },
      plans: [{ kind: 'member', ...MEMBER_MINI }, { kind: 'member', ...MEMBER_STUDIO }],
    });
    env.relay.noteStartFailure.mockImplementation(startFailurePolicy(autoSwitch));
    const first = await openAsGuest(env, GUEST_A, openPayload(SESSION, { acceptsGroupSwitch: true }));
    const nativeId = first.started.id as string;
    await first.client.close('close', 'navigation');
    await waitFor(() => env.members.mini.runCount() === 0);

    failResume = true;
    const poller = new RemoteAgentPoller(async (args) => jsonRoundTrip(await env.owner.handle(GUEST_A, jsonRoundTrip(args[0]))));
    const stream: Array<Record<string, unknown>> = [];
    const client = new RemoteAgentRunClient(runId(), poller, {
      onEvent: () => undefined,
      onState: (state) => { stream.push(state); },
      onRequest: async () => ({ type: 'callback', value: undefined }),
      onWs: () => undefined,
      onClosed: () => undefined,
    }, () => `33333333-3333-4333-8333-${String(runSeq).padStart(12, '0')}`);
    await expect(client.open('claude-code', openPayload(SESSION, { acceptsGroupSwitch: true, options: { resumeSessionId: nativeId } })))
      .rejects.toThrow();
    // 续接只能回到原来那台：那台接不下时凭证排在启动失败前面，受邀者交接后作为全新任务重新打开，组换一台。
    expect(stream.some((state) => typeof state.providerGroupSwitch === 'string')).toBe(offersSwitch);
    expect(env.relay.plan).toHaveBeenCalledTimes(offersSwitch ? 2 : 1);
    if (offersSwitch) {
      expect(env.relay.plan).toHaveBeenLastCalledWith(expect.objectContaining({ exclude: new Set([MEMBER_MINI.memberKey]) }));
    }
  });

  it('accepts a token only once, and only from the shared user and task it was sent to', async () => {
    const env = setup({
      plans: [
        { kind: 'member', ...MEMBER_MINI },
        { kind: 'member', ...MEMBER_STUDIO },
        { kind: 'member', ...MEMBER_STUDIO },
        { kind: 'member', ...MEMBER_STUDIO },
        { kind: 'member', ...MEMBER_STUDIO },
      ],
    });
    const first = await openAsGuest(env, GUEST_A, openPayload(SESSION, { acceptsGroupSwitch: true }));
    env.memberStarted.mini[0].emit(USAGE_LIMIT_ERROR);
    await waitFor(() => switchTokenIn(first.stream) !== undefined);
    const token = switchTokenIn(first.stream)!;
    await first.client.close('close', 'navigation');

    const otherGuest = await openAsGuest(env, GUEST_B, openPayload(SESSION, { groupSwitchToken: token }));
    expect(env.relay.plan).toHaveBeenLastCalledWith(expect.objectContaining({ exclude: new Set() }));
    await otherGuest.client.close('close', 'navigation');
    const otherTask = await openAsGuest(env, GUEST_A, openPayload('task-2', { groupSwitchToken: token }));
    expect(env.relay.plan).toHaveBeenLastCalledWith(expect.objectContaining({ exclude: new Set() }));
    await otherTask.client.close('close', 'navigation');

    const used = await openAsGuest(env, GUEST_A, openPayload(SESSION, { groupSwitchToken: token }));
    expect(env.relay.plan).toHaveBeenLastCalledWith(expect.objectContaining({ exclude: new Set([MEMBER_MINI.memberKey]) }));
    await used.client.close('close', 'navigation');
    const again = await openAsGuest(env, GUEST_A, openPayload(SESSION, { groupSwitchToken: token }));
    expect(env.relay.plan).toHaveBeenLastCalledWith(expect.objectContaining({ exclude: new Set() }));
    await again.client.close('close', 'navigation');
  });

  it('only forwards the original error to old shared users, or when the failure is not about the computer', async () => {
    const env = setup({
      plans: [{ kind: 'member', ...MEMBER_MINI }, { kind: 'member', ...MEMBER_MINI }],
      switchWorthy: (failure) => failure.usageLimit === true,
    });
    const legacy = await openAsGuest(env, GUEST_A, openPayload(SESSION));
    env.memberStarted.mini[0].emit(USAGE_LIMIT_ERROR);
    await waitFor(() => legacy.stream.some((item) => item.t === 'event' && item.event.type === 'error'));
    expect(switchTokenIn(legacy.stream)).toBeUndefined();
    // 没声明的受邀者：那台照样按组的口径冷却。
    expect(env.relay.noteRunFailure).toHaveBeenCalledTimes(1);
    await legacy.client.close('close', 'navigation');

    const declared = await openAsGuest(env, GUEST_B, openPayload(SESSION, { acceptsGroupSwitch: true }));
    env.memberStarted.mini[1].emit({ type: 'error', data: { message: 'prompt is too long', isTerminal: true } } as AgentEvent);
    await waitFor(() => declared.stream.some((item) => item.t === 'event' && item.event.type === 'error'));
    expect(switchTokenIn(declared.stream)).toBeUndefined();
    expect(env.relay.plan).toHaveBeenCalledTimes(2);
    await declared.client.close('close', 'navigation');
  });

  it.each(['local', 'member'] as const)('forwards the Claude output limit from %s without offering another computer', async (kind) => {
    const env = setup({
      plans: [kind === 'local' ? { kind: 'local' } : { kind: 'member', ...MEMBER_MINI }, { kind: 'member', ...MEMBER_STUDIO }],
      switchWorthy: (failure) => decideProviderGroupFailure(failure, 'run').action === 'switch',
    });
    const guest = await openAsGuest(env, GUEST_A, openPayload(SESSION, { acceptsGroupSwitch: true }));
    const data = { sdkError: 'max_output_tokens', message: 'SDK request failed', isTerminal: true };
    const record = kind === 'local' ? env.ownerStarted[0] : env.memberStarted.mini[0];
    record.emit({ type: 'error', data } as AgentEvent);
    await waitFor(() => guest.stream.some((item) => item.t === 'event' && item.event.type === 'error'));
    expect(guest.stream).toContainEqual(expect.objectContaining({ t: 'event', event: expect.objectContaining({ type: 'error', data }) }));
    expect(env.relay.noteRunFailure).toHaveBeenCalledWith(
      'shared-provider', expect.anything(), expect.objectContaining({ sdkError: 'max_output_tokens' }),
      'claude-opus',
    );
    expect(switchTokenIn(guest.stream)).toBeUndefined();
    expect(env.relay.plan).toHaveBeenCalledTimes(1);
    expect(env.memberStarted.studio).toHaveLength(0);
    await guest.client.close('close', 'navigation');
  });

  it('also offers another computer when the group ran the task on the group computer itself', async () => {
    const env = setup({ plans: [{ kind: 'local' }, { kind: 'member', ...MEMBER_MINI }, { kind: 'member', ...MEMBER_MINI }] });
    const first = await openAsGuest(env, GUEST_A, openPayload(SESSION, { acceptsGroupSwitch: true }));
    expect(env.ownerStarted).toHaveLength(1);
    env.ownerStarted[0].emit(USAGE_LIMIT_ERROR);
    await waitFor(() => first.stream.some((item) => item.t === 'event' && item.event.type === 'error'));
    const token = switchTokenIn(first.stream);
    expect(token).toBeDefined();
    const tokenAt = first.stream.findIndex((item) => item.t === 'state' && item.state.providerGroupSwitch === token);
    const errorAt = first.stream.findIndex((item) => item.t === 'event' && item.event.type === 'error');
    expect(tokenAt).toBeLessThan(errorAt);
    expect(env.relay.noteRunFailure).toHaveBeenCalledWith(
      'shared-provider',
      expect.objectContaining({ memberKey: 'local' }),
      expect.objectContaining({ usageLimit: true }),
      'claude-opus',
    );
    await first.client.close('close', 'navigation');

    const reopened = await openAsGuest(env, GUEST_A, openPayload(SESSION, { acceptsGroupSwitch: true, groupSwitchToken: token }));
    expect(env.relay.plan).toHaveBeenLastCalledWith(expect.objectContaining({ exclude: new Set(['local']) }));
    expect(env.memberStarted.mini).toHaveLength(1);
    await reopened.client.close('close', 'navigation');
  });

  it('offers another computer when the agent on the group computer itself ends in the middle of a turn', async () => {
    const env = setup({ plans: [{ kind: 'local' }, { kind: 'member', ...MEMBER_MINI }] });
    const guest = await openAsGuest(env, GUEST_A, openPayload(SESSION, { acceptsGroupSwitch: true }));
    const record = env.ownerStarted[0];
    record.running = true;
    record.emit({ type: 'text', data: { text: 'working' } } as AgentEvent);
    await waitFor(() => guest.stream.some((item) => item.t === 'state' && item.state.turnRunning === true));
    // 本机的 Agent 进程退出：事件流没有 done 就结束了。
    record.end();
    await waitFor(() => guest.isClosed());
    expect(switchTokenIn(guest.stream)).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(guest.closedReason()).toBe('error');
    expect(env.relay.noteRunFailure).toHaveBeenCalledWith(
      'shared-provider',
      expect.objectContaining({ memberKey: 'local' }),
      expect.objectContaining({ reason: 'remote_agent_closed' }),
      'claude-opus',
    );
  });

  it('offers another computer when the computer’s task ends unexpectedly in the middle of a turn', async () => {
    const env = setup({ plans: [{ kind: 'member', ...MEMBER_MINI }, { kind: 'member', ...MEMBER_STUDIO }] });
    const guest = await openAsGuest(env, GUEST_A, openPayload(SESSION, { acceptsGroupSwitch: true }));
    const record = env.memberStarted.mini[0];
    record.running = true;
    record.emit({ type: 'text', data: { text: 'working' } } as AgentEvent);
    await waitFor(() => guest.stream.some((item) => item.t === 'state' && item.state.turnRunning === true));
    // 那台把组所在电脑的任务结束了(撤权、崩溃等)，不是正常收尾。
    await env.members.mini.purgeControllers((controller) => controller === OWNER_DEVICE);
    await waitFor(() => guest.isClosed());
    expect(switchTokenIn(guest.stream)).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(env.relay.noteRunFailure).toHaveBeenCalledWith(
      'shared-provider',
      MEMBER_MINI,
      expect.objectContaining({ reason: 'remote_agent_closed' }),
      'claude-opus',
    );
  });

  it('stops offering once every computer has been tried this round', async () => {
    const env = setup({
      plans: [
        { kind: 'member', ...MEMBER_MINI },
        { kind: 'member', ...MEMBER_STUDIO },
        { kind: 'member', ...MEMBER_STUDIO },
        { kind: 'unavailable' },
        { kind: 'member', ...MEMBER_MINI },
      ],
    });
    const first = await openAsGuest(env, GUEST_A, openPayload(SESSION, { acceptsGroupSwitch: true }));
    env.memberStarted.mini[0].emit(USAGE_LIMIT_ERROR);
    await waitFor(() => switchTokenIn(first.stream) !== undefined);
    await first.client.close('close', 'navigation');
    const second = await openAsGuest(env, GUEST_A, openPayload(SESSION, {
      acceptsGroupSwitch: true,
      groupSwitchToken: switchTokenIn(first.stream),
    }));
    env.memberStarted.studio[0].emit(USAGE_LIMIT_ERROR);
    await waitFor(() => second.stream.some((item) => item.t === 'event' && item.event.type === 'error'));
    expect(env.relay.plan).toHaveBeenLastCalledWith(expect.objectContaining({
      exclude: new Set([MEMBER_MINI.memberKey, MEMBER_STUDIO.memberKey]),
    }));
    expect(switchTokenIn(second.stream)).toBeUndefined();

    // 用户亲自重试开始新的一轮：已经恢复的那台又能接手。
    await second.client.call('send', [{ content: 'try again', attachments: [] }, { groupNewRound: true }]);
    env.memberStarted.studio[0].emit(USAGE_LIMIT_ERROR);
    await waitFor(() => switchTokenIn(second.stream) !== undefined);
    expect(env.relay.plan).toHaveBeenLastCalledWith(expect.objectContaining({ exclude: new Set([MEMBER_STUDIO.memberKey]) }));
    await second.client.close('close', 'navigation');
  });
});

// 转分享(docs/product-rules/provider-sharing.md §4.3)：受邀者 B 的组替 B 分享的人 C 转来的任务，只在本机主人 A 同意过 C 时运行。
describe('provider group reshare consent', () => {
  /** B 的组所在电脑在 A 这台上的身份(A 的受邀者)。 */
  const B_GROUP = providerShareGuestPeer('a-share', 'b-member', 'b-device');
  /** C(B 分享的人)在 B 那台上的身份。 */
  const C_AT_B = providerShareGuestPeer('b-share', 'c-member', 'c-device');
  const C_KEY = reshareKeyFor('b-share', 'c-member');

  function memberHost(approved: Set<string>, resolveProvider?: NonNullable<Parameters<typeof createRemoteAgentHost>[0]['providerAccess']>['resolve']) {
    const started: Started[] = [];
    const sync = vi.fn(async (_controller: string, entries: readonly { key: string }[], batch?: { id: string; index: number; count: number }) => ({
      entries: entries.map((entry) => ({ key: entry.key, state: approved.has(entry.key) ? 'approved' as const : 'pending' as const })),
      ...(batch ? { batch: { ...batch, complete: false } } : {}),
    }));
    const host = fakeAgentHost('a', started, {
      trust: (controller) => (isProviderSharePeer(controller) ? 'guest' : 'owner'),
      reshare: { sync, allows: (controller, key) => controller === B_GROUP && !!key && approved.has(key) },
      resolveProvider,
    });
    const open = (payload: Record<string, unknown>) => host.handle(B_GROUP, {
      op: 'open',
      runId: runId(),
      agentKind: 'claude-code',
      payload: { json: openPayload('relayed', payload) },
    });
    return { host, started, sync, open };
  }

  it('declares consent support only to shared users and records whom their group computer reports', async () => {
    const env = memberHost(new Set([C_KEY]));
    expect(await env.host.handle(B_GROUP, { op: 'caps' })).toMatchObject({ reshareConsent: true, reshareBatch: true });
    expect(await env.host.handle('same-account-mac', { op: 'caps' })).not.toHaveProperty('reshareConsent');
    expect(await env.host.handle(B_GROUP, { op: 'reshare', entries: [{ key: C_KEY, name: 'Carol' }] }))
      .toEqual({ entries: [{ key: C_KEY, state: 'approved' }] });
    expect(env.sync).toHaveBeenCalledWith(B_GROUP, [{ key: C_KEY, name: 'Carol' }], undefined);
    const batch = { id: 'batch-a1b2c3d4e5f6', index: 0, count: 2 };
    expect(await env.host.handle(B_GROUP, { op: 'reshare', entries: [{ key: C_KEY, name: 'Carol' }], batch }))
      .toEqual({ entries: [{ key: C_KEY, state: 'approved' }], batch: { ...batch, complete: false } });
    expect(env.sync).toHaveBeenCalledWith(B_GROUP, [{ key: C_KEY, name: 'Carol' }], batch);
    // 同账号电脑经组使用不需要同意，也不能报人。
    await expect(env.host.handle('same-account-mac', { op: 'reshare', entries: [] })).rejects.toThrow(/REMOTE_AGENT_INVALID/);
  });

  it('refuses a relayed task for someone the owner has not agreed to, and runs it once agreed', async () => {
    const approved = new Set<string>();
    const env = memberHost(approved);
    await expect(env.open({ relay: relayKeyFor(C_AT_B), groupAssigned: true, reshareKey: C_KEY }))
      .rejects.toThrow(/REMOTE_AGENT_RESHARE_NOT_ALLOWED/);
    // 旧组所在电脑不带转分享键：回已有的错误码，它照常换组里下一台。
    await expect(env.open({ relay: relayKeyFor(C_AT_B), groupAssigned: true }))
      .rejects.toThrow(/REMOTE_AGENT_PROVIDER_NOT_ALLOWED/);
    expect(env.host.runCount()).toBe(0);
    // 受邀者 B 自己的任务(不是被转来的)不需要同意。
    await env.open({ groupAssigned: true });
    await waitFor(() => env.started.length === 1);
    approved.add(C_KEY);
    await env.open({ relay: relayKeyFor(C_AT_B), groupAssigned: true, reshareKey: C_KEY });
    await waitFor(() => env.started.length === 2);
    expect(env.started[1].input.guest).toBe(true);
    await env.host.abortAll();
  });

  it('stops the relayed tasks of a person right away when the owner withdraws agreement', async () => {
    const approved = new Set([C_KEY]);
    const env = memberHost(approved);
    await env.open({ relay: relayKeyFor(C_AT_B), groupAssigned: true, reshareKey: C_KEY });
    await env.open({ groupAssigned: true });
    expect(env.host.runCount()).toBe(2);
    approved.delete(C_KEY);
    await env.host.abortReshare((controller) => controller === B_GROUP, C_KEY);
    // 只结束 C 的任务，B 自己的照常运行。
    await waitFor(() => env.host.runCount() === 1);
    await env.host.abortAll();
  });

  it.each([false, true])('does not register a relayed task after consent is withdrawn during provider lookup (resume: %s)', async (resume) => {
    const approved = new Set([C_KEY]);
    const resolveProvider = vi.fn(async () => 'shared-provider');
    const env = memberHost(approved, resolveProvider);
    const payload = { relay: relayKeyFor(C_AT_B), groupAssigned: true, reshareKey: C_KEY };
    let resumeSessionId: string | undefined;
    if (resume) {
      await env.open(payload);
      await waitFor(() => env.started.length === 1);
      resumeSessionId = `sdk-a-${env.started[0].input.hostSessionId}`;
      await env.host.abortAll();
    }
    let release!: () => void;
    resolveProvider.mockImplementationOnce(() => new Promise<string>((resolve) => { release = () => resolve('shared-provider'); }));
    const opening = env.open({ ...payload, ...(resumeSessionId ? { options: { resumeSessionId } } : {}) });
    const rejected = expect(opening).rejects.toThrow(/REMOTE_AGENT_RESHARE_NOT_ALLOWED/);
    await waitFor(() => !!release);
    approved.delete(C_KEY);
    await env.host.abortReshare((controller) => controller === B_GROUP, C_KEY);
    release();
    await rejected;
    expect(env.host.runCount()).toBe(0);
    expect(env.started).toHaveLength(resume ? 1 : 0);
  });

  it('asks the group to pick only computers that agreed to this person, and tells a shared-in computer who it is', async () => {
    const SHARED_IN: GroupRelayMember = { memberKey: 'share:a-share:anthropic', agentDeviceId: 'studio', providerId: 'anthropic', sameAccount: false };
    const opens: Array<Record<string, unknown>> = [];
    const env = setup({
      plans: [{ kind: 'member', ...SHARED_IN }, { kind: 'member', ...MEMBER_MINI }],
      intercept: async (_agentDeviceId, request, forward) => {
        if (request.op === 'caps' && _agentDeviceId === 'studio') return { ...await forward() as object, reshareConsent: true };
        if (request.op === 'open') opens.push((request.payload as { json: Record<string, unknown> }).json);
        return forward();
      },
    });
    const first = await openAsGuest(env, C_AT_B, openPayload(SESSION, { reshareKey: 'f'.repeat(32) }));
    expect(env.relay.plan).toHaveBeenCalledWith(expect.objectContaining({ reshareKey: C_KEY }));
    // 带的是本机按分享与成员派生的键，受邀者自己填的不转发。
    expect(opens[0]).toMatchObject({ relay: relayKeyFor(C_AT_B), groupAssigned: true, reshareKey: C_KEY });
    await first.client.close('close', 'navigation');
    const second = await openAsGuest(env, C_AT_B, openPayload('task-2'));
    // 同账号的组内电脑不需要同意，不带键。
    expect(opens[1]).not.toHaveProperty('reshareKey');
    await second.client.close('close', 'navigation');
  });

  it('marks consent for re-checking when the shared-in computer refuses the person, then tries the next computer', async () => {
    const SHARED_IN: GroupRelayMember = { memberKey: 'share:a-share:anthropic', agentDeviceId: 'studio', providerId: 'anthropic', sameAccount: false };
    const noteReshareDenied = vi.fn();
    const env = setup({
      plans: [{ kind: 'member', ...SHARED_IN }, { kind: 'member', ...MEMBER_MINI }],
      intercept: async (_agentDeviceId, request, forward) => {
        if (request.op === 'caps' && _agentDeviceId === 'studio') return { ...await forward() as object, reshareConsent: true };
        if (request.op === 'open' && _agentDeviceId === 'studio') {
          throw new Error('[REMOTE_AGENT_RESHARE_NOT_ALLOWED] the owner of this computer has not agreed to this user');
        }
        return forward();
      },
    });
    (env.relay as RemoteAgentGroupRelayDeps).noteReshareDenied = noteReshareDenied;
    const { client } = await openAsGuest(env, C_AT_B, openPayload(SESSION));
    expect(noteReshareDenied).toHaveBeenCalledWith('studio', C_KEY);
    expect(env.memberStarted.mini).toHaveLength(1);
    await client.close('close', 'navigation');
  });

  it('skips an old shared-in computer even when cached consent selected it', async () => {
    const shared: GroupRelayMember = { memberKey: 'share:a:anthropic', agentDeviceId: 'studio', providerId: 'anthropic', sameAccount: false };
    const opened: string[] = [];
    const env = setup({
      plans: [{ kind: 'member', ...shared }, { kind: 'member', ...MEMBER_MINI }],
      intercept: async (id, request, forward) => {
        if (request.op === 'open') opened.push(id);
        return forward();
      },
    });
    const { client } = await openAsGuest(env, C_AT_B, openPayload(SESSION));
    expect(opened).toEqual(['mini']);
    expect(env.memberStarted.studio).toHaveLength(0);
    expect(env.relay.noteStartFailure).toHaveBeenCalledWith('shared-provider', shared, expect.objectContaining({ message: expect.stringContaining('REMOTE_AGENT_PEER_TOO_OLD') }), 'claude-opus');
    await client.close('close', 'navigation');
  });

  it('checks consent capability again when resuming an existing relay binding after downgrade', async () => {
    const shared: GroupRelayMember = { memberKey: 'share:a:anthropic', agentDeviceId: 'studio', providerId: 'anthropic', sameAccount: false };
    let capable = true;
    let capsChecks = 0;
    let opens = 0;
    const env = setup({
      plans: [{ kind: 'member', ...shared }],
      intercept: async (id, request, forward) => {
        if (request.op === 'caps' && id === 'studio') {
          capsChecks += 1;
          return { ...await forward() as object, ...(capable ? { reshareConsent: true } : {}) };
        }
        if (request.op === 'open' && id === 'studio') opens += 1;
        return forward();
      },
    });
    const first = await openAsGuest(env, C_AT_B, openPayload(SESSION));
    const nativeId = first.started.id;
    await first.client.close('close', 'navigation');
    capable = false;
    await expect(openAsGuest(env, C_AT_B, openPayload(SESSION, { options: { resumeSessionId: nativeId } })))
      .rejects.toThrow(/REMOTE_AGENT_UNAVAILABLE/);
    expect(capsChecks).toBe(2);
    expect(opens).toBe(1);
    expect(env.memberStarted.studio).toHaveLength(1);
    // 续接使用已有绑定，没有经过 plan，仍必须挡住旧端。
    expect(env.relay.plan).toHaveBeenCalledTimes(1);
    await env.owner.abortAll();
  });
});
