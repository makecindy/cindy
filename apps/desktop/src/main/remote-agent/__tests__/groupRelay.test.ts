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
import { relayKeyFor } from '../host/groupRelay';
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
      const record: Started = { input, sends: [] };
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
        async close() {},
        events: () => ({
          [Symbol.asyncIterator]: (): AsyncIterator<AgentEvent> => ({
            next: () => new Promise<IteratorResult<AgentEvent>>(() => undefined),
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

function setup(options: { plans?: GroupRelayPlan[]; miniCapable?: boolean } = {}) {
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
  const client = new RemoteAgentRunClient(runId(), poller, {
    onEvent: () => undefined,
    onState: () => undefined,
    onRequest: async () => ({ type: 'callback', value: undefined }),
    onWs: () => undefined,
    onClosed: () => undefined,
  }, () => `22222222-2222-4222-8222-${String(++counter + runSeq * 100).padStart(12, '0')}`);
  const started = await client.open('claude-code', payload);
  return { client, started };
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
