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

import type { AgentEvent, AgentSessionHandle } from '@cindy/maker-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RemoteAgentPoller } from '../controller/poller';
import { RemoteAgentRunClient } from '../controller/runClient';
import { relayKeyFor, type RelayRunFailure } from '../host/groupRelay';
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
}

function fakeAgentHost(name: string, started: Started[], options: {
  trust: (controller: string) => 'guest' | 'owner';
  guestRelayCapable?: boolean;
  purge?: (hostSessionIds: readonly string[], nativeIds: readonly string[]) => Promise<void>;
  groupRelay?: RemoteAgentGroupRelayDeps;
}) {
  return createRemoteAgentHost({
    isAgentAvailable: () => true,
    startHosted: async (input) => {
      const queue: AgentEvent[] = [];
      let wake: (() => void) | null = null;
      const record: Started = {
        input,
        sends: [],
        running: false,
        emit(event) {
          queue.push(event);
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
              while (queue.length === 0) await new Promise<void>((resolve) => { wake = resolve; });
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
      resolve: async (_kind, _model, providerId) => providerId ?? 'shared-provider',
      isAllowed: () => true,
    },
    ...(options.guestRelayCapable === false ? {} : {
      bindGuestProviderRoute: async () => ({ routeToken: 'route', modelIds: ['claude-opus'], release: () => {} }),
    }),
    ...(options.purge ? { purgeHostedTranscripts: options.purge } : {}),
    ...(options.groupRelay ? { groupRelay: options.groupRelay } : {}),
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

const MEMBER_MINI: GroupRelayMember = { memberKey: 'device:mini:anthropic-2', agentDeviceId: 'mini', providerId: 'anthropic-2', sameAccount: true };
const MEMBER_STUDIO: GroupRelayMember = { memberKey: 'device:studio:anthropic', agentDeviceId: 'studio', providerId: 'anthropic', sameAccount: true };

function setup(options: {
  plans?: GroupRelayPlan[];
  miniCapable?: boolean;
  switchWorthy?: (failure: RelayRunFailure) => boolean;
} = {}) {
  const memberStarted: Record<string, Started[]> = { mini: [], studio: [] };
  const members = {
    mini: fakeAgentHost('mini', memberStarted.mini, {
      trust: () => 'owner',
      guestRelayCapable: options.miniCapable ?? true,
      purge: async () => undefined,
    }),
    studio: fakeAgentHost('studio', memberStarted.studio, { trust: () => 'owner', purge: async () => undefined }),
  };
  const memberInvoke = (agentDeviceId: string) => async (args: unknown[]) =>
    jsonRoundTrip(await members[agentDeviceId as keyof typeof members].handle(OWNER_DEVICE, jsonRoundTrip(args[0])));
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
    noteStartFailure: vi.fn(),
    noteRunFailure: vi.fn((_providerId: string, _member: GroupRelayMember, failure: RelayRunFailure) =>
      options.switchWorthy?.(failure) ?? true),
    trackRun: vi.fn(() => ({ setRunning: vi.fn(), release: vi.fn() })),
    forget: vi.fn(async (agentDeviceId: string, relayKey: string) => {
      await memberInvoke(agentDeviceId)([{ op: 'forget', relay: relayKey }]);
    }),
  } satisfies RemoteAgentGroupRelayDeps;
  const ownerStarted: Started[] = [];
  const owner = fakeAgentHost('owner', ownerStarted, {
    trust: (controller) => (controller.startsWith('share-') ? 'guest' : 'owner'),
    purge: async () => undefined,
    groupRelay: relay,
  });
  return { owner, members, memberStarted, ownerStarted, relay };
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-group-relay-')));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
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
  return { client, started, stream, isClosed: () => closedReason !== null };
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
    expect(env.relay.noteStartFailure).toHaveBeenCalledWith('shared-provider', MEMBER_MINI, expect.any(Error));
    expect(env.relay.plan).toHaveBeenLastCalledWith(expect.objectContaining({ exclude: new Set([MEMBER_MINI.memberKey]) }));
    await client.close('close', 'navigation');
  });

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
    await waitFor(() => !fs.existsSync(homeA));
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
    );
    expect(env.relay.plan).toHaveBeenLastCalledWith(expect.objectContaining({ exclude: new Set([MEMBER_MINI.memberKey]) }));
    await first.client.close('close', 'navigation');

    // 受邀者交接后带着凭证重新打开(全新会话)：组所在电脑避开出问题的那台。
    const reopened = await openAsGuest(env, GUEST_A, openPayload(SESSION, { acceptsGroupSwitch: true, groupSwitchToken: token }));
    expect(env.relay.plan).toHaveBeenLastCalledWith(expect.objectContaining({ exclude: new Set([MEMBER_MINI.memberKey]) }));
    expect(env.memberStarted.studio).toHaveLength(1);
    await reopened.client.close('close', 'navigation');
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
    );
    await first.client.close('close', 'navigation');

    const reopened = await openAsGuest(env, GUEST_A, openPayload(SESSION, { acceptsGroupSwitch: true, groupSwitchToken: token }));
    expect(env.relay.plan).toHaveBeenLastCalledWith(expect.objectContaining({ exclude: new Set(['local']) }));
    expect(env.memberStarted.mini).toHaveLength(1);
    await reopened.client.close('close', 'navigation');
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
    );
  });

  it('stops offering once every computer has been tried this round', async () => {
    const env = setup({
      plans: [
        { kind: 'member', ...MEMBER_MINI },
        { kind: 'member', ...MEMBER_STUDIO },
        { kind: 'member', ...MEMBER_STUDIO },
        { kind: 'unavailable' },
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
    await second.client.close('close', 'navigation');
  });
});
