/**
 * 供应商组替受邀者中转(docs/product-rules/provider-groups.md §4、§9)，三端同进程、经 JSON 往返模拟设备互联：
 * 受邀者 G ⇄ 组所在电脑 O(createRemoteAgentHost + groupRelay) ⇄ 组内电脑 M(createRemoteAgentHost)。
 *  - 受邀者的新任务按组交给 M；M 按受邀者隔离运行(受邀者目录、会话索引按 relay 分开)；
 *  - 两个受邀者用同一个任务 id 不会在 M 上撞车；续接只回到当初那台；不能接回别的受邀者的会话；
 *  - 启动阶段那台接不下(不支持按受邀者隔离)就换下一台；
 *  - 删掉受邀者时请 M 清掉它留下的东西，M 只清调用方自己的 relay。
 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { isProviderSharePeer, parseRemoteAgentPollResult, parseRemoteAgentStreamItem, providerShareGuestPeer, REMOTE_AGENT_MAX_RUNS_PER_CONTROLLER } from '@cindy/device-link';
import type { AgentEvent, AgentSessionHandle } from '@cindy/maker-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderGroupGuestRelay } from '../../provider-group/guestRelay';
import { createProviderGroupExternalLoad } from '../../provider-group/externalLoad';
import type { ProviderGroupRouter } from '../../provider-group/router';
import { decideProviderGroupFailure } from '../../provider-group/failurePolicy';

import { RemoteAgentPoller } from '../controller/poller';
import { RemoteAgentRemoteError, RemoteAgentRunClient } from '../controller/runClient';
import { LineSplitter } from '../eventLog';
import { relayConnId, relayKeyFor, reshareKeyFor, type RelayRunFailure } from '../host/groupRelay';
import { createGuestProviderRouteBinder } from '../host/providerAccess';
import { guestProviderRouteForToken } from '../../maker-host/guest-provider-route-store';
import { createProviderShareUsageStore } from '../../device-link/providerShareUsageStore';
import { memberBudgetStatus } from '../../device-link/providerShareBudgetCalculation';
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
  end(error?: Error): void;
}

function fakeAgentHost(name: string, started: Started[], options: {
  trust: (controller: string) => 'guest' | 'owner';
  guestRelayCapable?: boolean;
  purge?: (hostSessionIds: readonly string[], nativeIds: readonly string[]) => Promise<void>;
  groupRelay?: RemoteAgentGroupRelayDeps;
  directGuestExecution?: Parameters<typeof createRemoteAgentHost>[0]['directGuestExecution'];
  captureOwner?: () => unknown;
  isAgentAvailable?: Parameters<typeof createRemoteAgentHost>[0]['isAgentAvailable'];
  prepareImageEvent?: Parameters<typeof createRemoteAgentHost>[0]['prepareImageEvent'];
  imageArtifacts?: Parameters<typeof createRemoteAgentHost>[0]['imageArtifacts'];
  /** 这台的 Agent 启动失败(启动前受邀者目录已经建好)。 */
  failStart?: boolean;
  beforeStart?: (input: HostedStartInput) => Promise<void>;
  /** 这台的 Agent 一启动就结束。 */
  endImmediately?: boolean;
  onSend?: (record: Started) => void | Promise<void>;
  /** 转分享的同意(本机是分享者)。 */
  reshare?: Parameters<typeof createRemoteAgentHost>[0]['reshare'];
  resolveProvider?: NonNullable<Parameters<typeof createRemoteAgentHost>[0]['providerAccess']>['resolve'];
  modelAccess?: Partial<NonNullable<Parameters<typeof createRemoteAgentHost>[0]['providerAccess']>>;
  bindGuestProviderRoute?: Parameters<typeof createRemoteAgentHost>[0]['bindGuestProviderRoute'];
}) {
  return createRemoteAgentHost({
    forkHosted: async (_kind, opts) => ({ newSdkSessionId: `${opts.sourceSdkSessionId}-fork`, uuidMap: new Map([['old', 'new']]) }),
    prepareImageEvent: options.prepareImageEvent,
    imageArtifacts: options.imageArtifacts,
    isAgentAvailable: options.isAgentAvailable ?? (() => true),
    startHosted: async (input) => {
      if (options.failStart) throw new Error('the agent could not start');
      await options.beforeStart?.(input);
      const queue: AgentEvent[] = [];
      let wake: (() => void) | null = null;
      let ended = false;
      let endError: Error | undefined;
      const record: Started = {
        input,
        sends: [],
        running: false,
        emit(event) {
          queue.push(event);
          wake?.();
          wake = null;
        },
        end(error) {
          ended = true;
          endError = error;
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
          await options.onSend?.(record);
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
              if (queue.length === 0 && endError) throw endError;
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
      ...options.modelAccess,
    },
    ...(options.guestRelayCapable === false ? {} : {
      bindGuestProviderRoute: options.bindGuestProviderRoute ?? (async () => ({ routeToken: 'route', modelIds: ['claude-opus'], release: () => {} })),
    }),
    ...(options.purge ? { purgeHostedTranscripts: options.purge } : {}),
    ...(options.groupRelay ? { groupRelay: options.groupRelay } : {}),
    ...(options.directGuestExecution ? { directGuestExecution: options.directGuestExecution } : {}),
    ...(options.reshare ? { reshare: options.reshare } : {}),
    captureOwner: options.captureOwner ?? (() => 'owner'),
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

// An open ACK precedes native startup and guest-index persistence. In the
// forget races, a start-failed event must report its cause instead of becoming
// a started.length timeout. Keep the existing three-second observation budget.
async function waitForStarted(host: ReturnType<typeof fakeAgentHost>, peer: string, id: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  const splitter = new LineSplitter(64 * 1024 * 1024);
  let cursor = 0;
  let lastEvent = 'none';
  while (Date.now() < deadline) {
    const result = parseRemoteAgentPollResult(await host.handle(peer, {
      op: 'poll', runs: [{ runId: id, cursor }], waitMs: Math.max(0, deadline - Date.now()),
    }));
    const run = result.runs.find(item => item.runId === id);
    if (!run || run.missing) throw new Error(`Run ${id} disappeared before startup`);
    cursor = run.cursor;
    for (const line of splitter.push(Buffer.from(run.data ?? '', 'base64'))) {
      const item = parseRemoteAgentStreamItem(line);
      if (!item) continue;
      lastEvent = item.t;
      if (item.t === 'start-failed') throw new RemoteAgentRemoteError(item.error);
      if (item.t === 'started') return;
      if (item.t === 'closed') throw new Error(`Run ${id} closed before startup: ${item.reason}`);
    }
    if (run.done) throw new Error(`Run ${id} ended before startup; last event: ${lastEvent}`);
  }
  throw new Error(`Run ${id} did not start within 3000ms; cursor: ${cursor}; last event: ${lastEvent}`);
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
  mini?: { failStart?: boolean; endImmediately?: boolean; onSend?: (record: Started) => void | Promise<void>;
    isAgentAvailable?: Parameters<typeof createRemoteAgentHost>[0]['isAgentAvailable'] };
  memberBinder?: Parameters<typeof createRemoteAgentHost>[0]['bindGuestProviderRoute'];
  /** 组所在电脑本机的 Agent 表现(组选中本机这一台时)。 */
  owner?: { failStart?: boolean; onSend?: (record: Started) => void | Promise<void>;
    prepareImageEvent?: Parameters<typeof createRemoteAgentHost>[0]['prepareImageEvent'];
    modelAccess?: Partial<NonNullable<Parameters<typeof createRemoteAgentHost>[0]['providerAccess']>>;
    directGuestExecution?: Parameters<typeof createRemoteAgentHost>[0]['directGuestExecution'];
    isAgentAvailable?: Parameters<typeof createRemoteAgentHost>[0]['isAgentAvailable'] };
  /** 截住组所在电脑发给组内电脑的请求(模拟回包丢失、应答慢)。 */
  intercept?: (agentDeviceId: string, request: Record<string, unknown>, forward: () => Promise<unknown>) => Promise<unknown>;
} = {}) {
  const memberStarted: Record<string, Started[]> = { mini: [], studio: [] };
  const members = {
    mini: fakeAgentHost('mini', memberStarted.mini, {
      trust: () => 'owner',
      guestRelayCapable: options.miniCapable ?? true,
      bindGuestProviderRoute: options.memberBinder,
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
  // The member owner's deliberate disconnect must survive the intermediary and
  // must not offer the guest another computer to undo that decision.
  it('forwards an intentional member disconnect without offering a group switch', async () => {
    const env = setup({ plans: [{ kind: 'member', ...MEMBER_MINI }] });
    const guest = await openAsGuest(env, GUEST_A, openPayload(SESSION, { acceptsGroupSwitch: true }));
    try {
      await guest.client.call('send', [{ content: 'run' }, {}]);
      await env.members.mini.abortAll('navigation');
      await waitFor(() => guest.isClosed());
      expect(guest.closedReason()).toBe('controller-disconnected');
      expect(switchTokenIn(guest.stream)).toBeUndefined();
      expect(env.relay.noteRunFailure).not.toHaveBeenCalled();
      expect(env.relay.plan).toHaveBeenCalledTimes(1);
    } finally {
      await guest.client.close('close', 'navigation');
      for (const host of [env.owner, ...Object.values(env.members)]) { await host.abortAll(); host.dispose(); }
    }
  });

  it('does not let a group relay discard external application isolation on an older member', async () => {
    const env = setup({ intercept: async (_device, request, forward) => {
      const result = await forward();
      if (request.op === 'caps') delete (result as { localApplication?: boolean }).localApplication;
      return result;
    } });
    try {
      await expect(openAsGuest(env, GUEST_A, openPayload(SESSION, {
        options: { localApplication: { mcpName: 'hhh', hostToolsOnly: true, storageKey: 'a'.repeat(64) } }, mcpServers: ['hhh'],
      }))).rejects.toThrow();
      expect(env.memberStarted.mini).toHaveLength(0);
      expect(env.memberStarted.studio).toHaveLength(0);
    } finally { await env.owner.dispose(); await Promise.all(Object.values(env.members).map(member => member.dispose())); }
  });
  // Unit regression for provider-sharing.md §3: first local work must reach the member with its push,
  // before either poll batch can report hold. Existing relay cases did not carry this busy-state field.
  // Real guest -> owner Host.handle -> member RunClient.push with JSON serialization on both hops.
  it('forwards the first local hold with the process startup reply to the group member', async () => {
    let forwarded: Record<string, unknown> | undefined;
    const env = setup({ intercept: async (_device, request, forward) => {
      if (request.op === 'push') forwarded = request;
      return forward();
    } });
    const { client } = await openAsGuest(env, GUEST_A, openPayload(SESSION));
    try {
      await env.owner.handle(GUEST_A, {
        op: 'push', runId: client.runId, seq: 1, hold: true,
        frames: [{ connId: relayConnId(1, 'exec-1'), kind: 'message', data: '{"id":1,"result":{}}' }],
      });
      await vi.waitFor(() => expect(forwarded).toBeDefined());
      expect(forwarded).toMatchObject({
        hold: true,
        frames: [{ connId: 'exec-1', kind: 'message', data: '{"id":1,"result":{}}' }],
      });
    } finally {
      await client.close('close', 'navigation');
      for (const host of [env.owner, ...Object.values(env.members)]) { await host.abortAll(); host.dispose(); }
    }
  });

  // Review 4328897446, unit: the old three-host harness never exercised the
  // original member's model restrictions at the executing computer. A allows
  // only opus, while the executor offers opus and sonnet; revoke opus mid-run.
  it('projects the original member catalog and rechecks every child call across the relay', async () => {
    const allowed = new Set(['claude-opus']);
    const ledger = createProviderShareUsageStore(path.join(root, 'ratio-usage.json'));
    const record = (model: string, tokens: number) => ledger.record('share', GUEST_A, { providerId: 'shared-provider', kind: 'claude-code', memberKey: 'mini',
      samples: [{ model, inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, sdkCostUsd: 0, turns: 0 }] });
    record('claude-opus', 60); record('claude-sonnet', 140);
    const policy = { basis: 'member-input-output-7d' as const, enabled: true, recommendedModel: 'claude-sonnet',
      rules: [{ id: 'limit', models: ['claude-opus'], maxPercent: 50 }] };
    let executorAllowed = true;
    const binder = createGuestProviderRouteBinder({
      readProviders: async () => [{ id: MEMBER_MINI.providerId, models: { 'claude-code': [
        { id: 'claude-opus' }, { id: 'claude-sonnet' },
      ] } }] as never,
      guestAccess: () => null, ownerAllowed: () => true, providerAllowed: () => executorAllowed,
      modelAccess: { allows: () => true, read: () => ({ models: null, providerModels: null }) },
    });
    const check = vi.fn((_provider: string, controller: string, model?: string) => {
      if (controller !== GUEST_A || (model && !allowed.has(model))) return false;
      const status = memberBudgetStatus(ledger.memberTokenSnapshot(new Set(['share']), 'shared-provider', GUEST_A), policy);
      if (model && status.rules.some(rule => rule.models.includes(model) && rule.blocked))
        throw new Error('[REMOTE_AGENT_MEMBER_BUDGET_PAUSED] Model share reached');
      return true;
    });
    const env = setup({ memberBinder: binder, owner: { modelAccess: {
      isAllowed: check, models: async () => [...allowed], restricted: () => true,
    } } });
    try {
      const { client } = await openAsGuest(env, GUEST_A, openPayload(SESSION));
      try {
        const input = env.memberStarted.mini[0].input;
        expect(input.guestProvider!.modelIds).toEqual(['claude-opus']);
        const decision = async (model: string) => {
          const response = await fetch(input.tunnel.url + '/cindy/model-access', { method: 'POST',
            headers: { Authorization: 'Bearer ' + input.tunnel.token }, body: JSON.stringify({ model }) });
          return await response.json() as { allowed: boolean; code?: string };
        };
        const allows = async (model: string) => (await decision(model)).allowed;
        expect(await allows('claude-opus')).toBe(true);
        expect(await allows('claude-sonnet')).toBe(false);
        record('claude-opus', 200);
        expect(await decision('claude-opus')).toEqual({ allowed: false, code: 'REMOTE_AGENT_MEMBER_BUDGET_PAUSED' });
        await expect(client.call('send', [{ content: 'blocked', attachments: [] }, {}])).rejects.toThrow('[REMOTE_AGENT_MEMBER_BUDGET_PAUSED]');
        expect(env.memberStarted.mini[0].sends).toHaveLength(0);
        record('claude-sonnet', 200);
        expect(await allows('claude-opus')).toBe(true);
        await client.call('send', [{ content: 'resumed', attachments: [] }, {}]);
        expect(env.memberStarted.mini[0].sends).toHaveLength(1);
        allowed.clear();
        expect(await allows('claude-opus')).toBe(false);
        allowed.add('claude-opus');
        expect(await allows('claude-opus')).toBe(true);
        executorAllowed = false;
        expect(await allows('claude-opus')).toBe(false);
      } finally { await client.close('close', 'navigation'); }
    } finally {
      await ledger.flush();
      for (const host of [env.owner, ...Object.values(env.members)]) { await host.abortAll(); host.dispose(); }
    }
  });

  it.each([true, false])('handles a legacy executor with restricted=%s and stops it when new restrictions appear', async restrictedAtStart => {
    let restricted = restrictedAtStart;
    const env = setup({
      plans: [{ kind: 'member', ...MEMBER_MINI }, { kind: 'member', ...MEMBER_STUDIO }],
      owner: { modelAccess: { models: async () => ['claude-opus'], restricted: () => restricted } },
      intercept: async (id, request, forward) => {
        const result = await forward();
        return id === 'mini' && request.op === 'caps' ? { ...(result as object), relayModelAccess: undefined } : result;
      },
    });
    try {
      const { client } = await openAsGuest(env, GUEST_A, openPayload(SESSION));
      try {
        expect(env.memberStarted.mini).toHaveLength(restrictedAtStart ? 0 : 1);
        expect(env.memberStarted.studio).toHaveLength(restrictedAtStart ? 1 : 0);
        restricted = true;
        await env.owner.revalidateModelAccess();
        expect(env.owner.runCount()).toBe(restrictedAtStart ? 1 : 0);
      } finally { await client.close('close', 'navigation'); }
    } finally { for (const host of [env.owner, ...Object.values(env.members)]) { await host.abortAll(); host.dispose(); } }
  });
  // Unit regression for review 4328468761: existing three-computer tests stubbed
  // the production binding. The real binder must start an owner-relayed guest,
  // keep its isolated home/provider, and release the proxy token on close.
  it('starts and releases a same-account group relay through the production guest binder', async () => {
    const binder = createGuestProviderRouteBinder({
      readProviders: async () => [],
      guestAccess: () => null,
      ownerAllowed: controller => controller === OWNER_DEVICE,
      providerAllowed: provider => provider === MEMBER_MINI.providerId,
      modelAccess: { allows: () => true, read: () => ({ models: null, providerModels: null }) },
    });
    const env = setup({ memberBinder: binder });
    try {
      const { client } = await openAsGuest(env, GUEST_A, openPayload(SESSION));
      try {
        const input = env.memberStarted.mini[0].input;
        expect(input.guest).toBe(true);
        expect(input.guestHome).toContain(path.join('mini', 'guest-homes'));
        const token = input.guestProvider!.routeToken;
        expect(guestProviderRouteForToken(token)).toEqual({ sessionId: input.hostSessionId, providerId: MEMBER_MINI.providerId });
        await client.call('send', [{ content: 'hello', attachments: [] }, {}]);
        expect(env.memberStarted.mini[0].sends).toHaveLength(1);
        await client.close('close', 'navigation');
        await vi.waitFor(() => expect(guestProviderRouteForToken(token)).toBeNull());
      } finally { await client.close('close', 'navigation'); }
    } finally {
      for (const host of [env.owner, ...Object.values(env.members)]) { await host.abortAll(); host.dispose(); }
    }
  });

  // Public G -> O -> M handlers, with JSON serialization: a fork must remain pinned
  // to its original member and preserve the guest ownership needed for another fork.
  it('forks and resumes on the original member without allocating another group member', async () => {
    // The group owner need not have the member's harness installed.
    const env = setup({ owner: { isAgentAvailable: () => false } });
    const first = await openAsGuest(env, GUEST_A, openPayload(SESSION));
    const request = { op: 'fork', sourceSessionId: SESSION, newSessionId: 'child-task',
      agentKind: 'claude-code', sourceSdkSessionId: first.started.id, model: 'claude-opus', upToMessageId: 'old' };
    await first.client.close('close', 'navigation');
    const child = await env.owner.handle(GUEST_A, request) as { newSdkSessionId: string; uuidMap: unknown };
    expect(child).toEqual({ newSdkSessionId: `${first.started.id}-fork`, uuidMap: [['old', 'new']] });
    await expect(env.owner.handle(GUEST_B, request)).rejects.toThrow('REMOTE_AGENT_INVALID');
    await expect(env.owner.handle(GUEST_A, { ...request, sourceSessionId: 'child-task',
      newSessionId: 'grandchild-task', sourceSdkSessionId: child.newSdkSessionId }))
      .resolves.toMatchObject({ newSdkSessionId: `${child.newSdkSessionId}-fork` });
    const resumed = await openAsGuest(env, GUEST_A, openPayload('child-task', { options: { resumeSessionId: child.newSdkSessionId } }));
    expect(env.memberStarted.mini[1].input.options.resumeSessionId).toBe(child.newSdkSessionId);
    expect(env.relay.plan).toHaveBeenCalledTimes(1);
    await resumed.client.close('close', 'navigation');
  });
  // The guest cannot see or fix the member computer: a member whose agent went away
  // before the fork must surface as the neutral unavailable error, not "install it there".
  it('masks a member whose agent became unavailable before a guest fork', async () => {
    let available = true;
    const env = setup({ mini: { isAgentAvailable: () => available } });
    const first = await openAsGuest(env, GUEST_A, openPayload(SESSION));
    await first.client.close('close', 'navigation');
    available = false;
    await expect(env.owner.handle(GUEST_A, { op: 'fork', sourceSessionId: SESSION, newSessionId: 'child-task',
      agentKind: 'claude-code', sourceSdkSessionId: first.started.id, model: 'claude-opus', upToMessageId: 'old',
      acceptsForkFailed: true })).rejects.toThrow(/^\[REMOTE_AGENT_UNAVAILABLE\]/);
  });
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

  // #6420: the relay must retain the member's task/relay receipt, not just restage its bytes.
  it('carries the upstream artifact identity and clear generation through the provider-group relay', async () => {
    let finishPreparation!: () => void;
    const waiting = new Promise<void>((resolve) => { finishPreparation = resolve; });
    const prepareImageEvent = vi.fn(async (_sessionId: string, event: AgentEvent) => { await waiting; return event; });
    const env = setup({ owner: { prepareImageEvent } });
    const { client, stream, isClosed } = await openAsGuest(env, GUEST_A, openPayload(SESSION, { imageDeliveryEpoch: 123, acceptsImageDeliveryReceipts: true }));
    try {
      env.memberStarted.mini[0].emit({ type: 'image', source: 'codex', data: { kind: 'generation', blockId: 'image', deliveryEpoch: 999, url: 'data:image/png;base64,bytes' } } as AgentEvent);
      env.memberStarted.mini[0].end();
      await vi.waitFor(() => expect(prepareImageEvent).toHaveBeenCalledTimes(1));
      expect(isClosed()).toBe(false);
      finishPreparation();
      const call = prepareImageEvent.mock.calls[0] as unknown as [string, AgentEvent, { agentDeviceId: string; sessionId: string; relay: string }, boolean];
      expect(call[3]).toBe(true);
      expect(call[0]).toBe(hostSessionIdFor(GUEST_A, SESSION));
      expect(call[1].data).toMatchObject({ deliveryEpoch: 123 });
      expect(call[2]).toMatchObject({ agentDeviceId: 'mini', relay: relayKeyFor(GUEST_A) });
      const imageArtifacts = vi.fn(async (_sessionId: string) => ({ ok: true }));
      const member = fakeAgentHost('release-member', [], { trust: () => 'owner', imageArtifacts });
      try {
        await member.handle(OWNER_DEVICE, { op: 'images', ...call[2], action: 'release', imageId: 'a'.repeat(64) });
        expect(imageArtifacts.mock.calls[0]?.[0]).toBe(env.memberStarted.mini[0].input.hostSessionId);
        await member.handle('other-owner', { op: 'images', ...call[2], action: 'release', imageId: 'a'.repeat(64) });
        expect(imageArtifacts.mock.calls[1]?.[0]).not.toBe(imageArtifacts.mock.calls[0]?.[0]);
      } finally { member.dispose(); }
      await vi.waitFor(() => expect(stream.some((item) => item.t === 'event' && item.event.type === 'image')).toBe(true));
    } finally { finishPreparation(); await client.close('close', 'navigation'); }
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

  // Unit / real host.handle: service-only tests cannot prove old O history
  // bypasses allocation or that accepted fallback reaches the durable handoff.
  it('locates only for guests, preserves legacy O tasks, and claims a fresh fallback', async () => {
    const started: Started[] = [];
    const locate = vi.fn(async () => null);
    const allocate = vi.fn(async () => ({ deviceId: 'member', generation: runId() }));
    const acceptRelay = vi.fn(async () => undefined);
    const direct = {
      ownerScope: () => 'account', locate, allocate, acceptRelay,
      status: () => undefined, release: async () => undefined, switch: async () => ({}),
      sessionAllowed: () => true, sessionDelegated: () => false,
      usage: () => undefined, delegate: async () => true, forget: () => true,
    };
    const makeHost = () => fakeAgentHost('legacy-location', started, {
      trust: (controller) => controller === OWNER_DEVICE ? 'owner' : 'guest', directGuestExecution: direct,
    });
    let host = makeHost();
    try {
      await expect(host.handle(OWNER_DEVICE, { op: 'direct-locate', sessionId: SESSION })).rejects.toThrow('REMOTE_AGENT_INVALID');
      expect(locate).not.toHaveBeenCalled();
      expect(await host.handle(GUEST_A, { op: 'direct-locate', sessionId: SESSION })).toBeNull();
      await host.handle(GUEST_A, { op: 'open', runId: runId(), agentKind: 'claude-code',
        payload: { json: openPayload(SESSION) } });
      await waitFor(() => started.length === 1);
      expect(acceptRelay).toHaveBeenCalledWith(GUEST_A, SESSION, false);
      const request = { op: 'allocate', agentKind: 'claude-code', model: 'claude-opus', sessionId: SESSION };
      expect(await host.handle(GUEST_A, request)).toBeNull();
      expect(allocate).not.toHaveBeenCalled();
      await host.abortAll();
      host.dispose();
      host = makeHost();
      expect(await host.handle(GUEST_A, request)).toBeNull();
      expect(allocate).not.toHaveBeenCalled();
      // Equal task IDs under a different guest have their own route namespace.
      expect(await host.handle(GUEST_B, request)).toMatchObject({ deviceId: 'member' });
      expect(allocate).toHaveBeenCalledTimes(1);
    } finally {
      await host.abortAll();
      host.dispose();
    }
  });

  // Direct G→M has no relay key. The production host entry must persist O's
  // authenticated grant before allowing a later, idempotent deletion (unit tier).
  it('forgets only the direct guest delegated by this owner, including after the lease is gone', async () => {
    const started: Started[] = [];
    const purge = vi.fn(async () => undefined);
    const peer = providerShareGuestPeer('share-a', 'member-a', 'guest-pc');
    const other = providerShareGuestPeer('share-b', 'member-b', 'other-pc');
    let ownerGeneration = 1;
    const directSessions = new Map<string, Set<string>>();
    const makeHost = () => fakeAgentHost('direct-member', started, {
      trust: (controller) => isProviderSharePeer(controller) ? 'guest' : 'owner', purge,
      captureOwner: () => ({ ownerScopeKey: `account-one:${ownerGeneration}` }),
      directGuestExecution: {
        ownerScope: () => 'account-one',
        allocate: async () => null, status: () => undefined, release: async () => undefined,
        switch: async () => ({}),
        sessionAllowed: (controller, sessionId) => directSessions.get(controller)?.has(sessionId) === true,
        sessionDelegated: (controller, sessionId) => directSessions.get(controller)?.has(sessionId) === true,
        usage: () => undefined,
        delegate: async (_owner, request) => {
          const key = providerShareGuestPeer(request.shareId, request.memberId, request.guestDeviceId);
          const sessions = directSessions.get(key) ?? new Set<string>();
          sessions.add(request.sessionId);
          directSessions.set(key, sessions);
          return true;
        },
        forget: (_owner, controller) => { directSessions.delete(controller); return true; },
      },
    });
    let host = makeHost();
    const grant = (shareId: string, memberId: string, guestDeviceId: string, cleanupEpoch = 1,
      sessionId = 'task-direct') => ({
      op: 'delegate' as const, action: 'grant' as const, shareId, memberId, guestDeviceId,
      sessionId, providerId: 'shared-provider', model: 'claude-opus',
      generation: '11111111-1111-4111-8111-111111111111', cleanupEpoch,
    });
    const open = (controller: string, sessionId: string, extra: Record<string, unknown> = {}, id = runId()) =>
      host.handle(controller, { op: 'open', runId: id, agentKind: 'claude-code',
        payload: { json: openPayload(sessionId, extra) } });
    try {
      const directRunId = runId(), relayRunId = runId();
      await host.handle(OWNER_DEVICE, grant('share-a', 'member-a', 'guest-pc'));
      await host.handle(OWNER_DEVICE, grant('share-b', 'member-b', 'other-pc', 1, 'task-other'));
      await open(peer, 'task-direct', {}, directRunId);
      await open(other, 'task-other');
      await open(peer, 'task-relay', { relay: relayKeyFor(peer) }, relayRunId);
      await waitFor(() => started.length === 3);
      const directHome = started.find((item) => item.input.hostSessionId === hostSessionIdFor(peer, 'task-direct'))!.input.guestHome!;
      const otherHome = started.find((item) => item.input.hostSessionId === hostSessionIdFor(other, 'task-other'))!.input.guestHome!;
      const relayScope = `${peer}\0relay:${relayKeyFor(peer)}`;
      const relayHome = started.find((item) => item.input.hostSessionId === hostSessionIdFor(relayScope, 'task-relay'))!.input.guestHome!;
      const peerHash = createHash('sha256').update(peer).digest('hex').slice(0, 16);
      const base = path.join(root, 'direct-member');
      const directWorkspace = path.join(base, 'workspaces', peerHash, hostSessionIdFor(peer, 'task-direct'));
      const directAttachments = path.join(base, 'attachments', peerHash, directRunId);
      const relayWorkspace = path.join(base, 'workspaces', peerHash, hostSessionIdFor(relayScope, 'task-relay'));
      const relayAttachments = path.join(base, 'attachments', peerHash, relayRunId);
      // A restarted M has no live Run to clean. Recreate failed shutdown
      // residue under the real on-disk layout, alongside same-peer relay data.
      host.dispose();
      await waitFor(() => !fs.existsSync(directWorkspace) && !fs.existsSync(relayWorkspace)
        && !fs.existsSync(directAttachments) && !fs.existsSync(relayAttachments));
      directSessions.clear();
      host = makeHost();
      for (const dir of [directHome, otherHome, relayHome, directWorkspace, directAttachments,
        relayWorkspace, relayAttachments]) fs.mkdirSync(dir, { recursive: true });
      const forget = { op: 'forget', directGuest: { shareId: 'share-a', memberId: 'member-a',
        guestDeviceId: 'guest-pc', forgetId: '22222222-2222-4222-8222-222222222222', cleanupEpoch: 1 } };
      await expect(host.handle('other-owner', forget)).rejects.toThrow('REMOTE_AGENT_INVALID');
      await expect(host.handle(peer, forget)).rejects.toThrow('REMOTE_AGENT_INVALID');
      ownerGeneration = 2; // same account, a newer app-session generation
      await host.handle(OWNER_DEVICE, forget);
      expect(purge).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(directHome)).toBe(false);
      expect(fs.existsSync(otherHome)).toBe(true);
      expect(fs.existsSync(relayHome)).toBe(true);
      expect(fs.existsSync(directWorkspace)).toBe(false);
      expect(fs.existsSync(directAttachments)).toBe(false);
      expect(fs.existsSync(relayWorkspace)).toBe(true);
      expect(fs.existsSync(relayAttachments)).toBe(true);
      expect(purge).toHaveBeenCalledWith(expect.arrayContaining([hostSessionIdFor(peer, 'task-direct')]),
        expect.arrayContaining([expect.stringContaining('sdk-direct-member')]));
      await host.handle(OWNER_DEVICE, forget); // lost ACK: no second purge
      expect(purge).toHaveBeenCalledTimes(1);
      // A delayed old deletion can arrive after the same member rejoins on M.
      await host.handle(OWNER_DEVICE, grant('share-a', 'member-a', 'guest-pc', 2, 'task-new'));
      await open(peer, 'task-new');
      await waitFor(() => started.length === 4);
      const newHome = started.find((item) => item.input.hostSessionId === hostSessionIdFor(peer, 'task-new'))!.input.guestHome!;
      await host.handle(OWNER_DEVICE, forget);
      expect(fs.existsSync(newHome)).toBe(true);
      expect(purge).toHaveBeenCalledTimes(1);
    } finally {
      await host.dispose();
    }
  });

  // Unit / real host.handle + disk index: transcript-failure tests did not fail
  // the tombstone's atomic rename. A failed rename followed by the same forget
  // ID must keep rejecting (O keeps it pending), then survive retry and restart
  // with no old native IDs (provider-sharing-direct-execution, deletion rules).
  it('acknowledges a repeated direct forget only after its tombstone is durable', async () => {
    const started: Started[] = [];
    const peer = providerShareGuestPeer('share-durable', 'member-durable', 'guest-pc');
    const sessions = new Set<string>();
    const purge = vi.fn(async () => undefined);
    const makeHost = () => fakeAgentHost('direct-forget-durable', started, {
      trust: (controller) => isProviderSharePeer(controller) ? 'guest' : 'owner', purge,
      directGuestExecution: {
        ownerScope: () => 'account-one',
        allocate: async () => null, status: () => undefined, release: async () => undefined,
        switch: async () => ({}), usage: () => undefined,
        sessionAllowed: (_controller, sessionId) => sessions.has(sessionId),
        sessionDelegated: (_controller, sessionId) => sessions.has(sessionId),
        delegate: async (_owner, request) => { sessions.add(request.sessionId); return true; },
        forget: () => { sessions.clear(); return true; },
      },
    });
    let host = makeHost();
    const grant = (sessionId: string, cleanupEpoch: number) => host.handle(OWNER_DEVICE, {
      op: 'delegate', action: 'grant', shareId: 'share-durable', memberId: 'member-durable', guestDeviceId: 'guest-pc',
      sessionId, cleanupEpoch, providerId: 'shared-provider', model: 'claude-opus',
      generation: '11111111-1111-4111-8111-111111111111',
    });
    const open = (sessionId: string, extra = {}) => host.handle(peer, {
      op: 'open', runId: runId(), agentKind: 'claude-code', payload: { json: openPayload(sessionId, extra) },
    });
    const indexFile = path.join(root, 'direct-forget-durable', 'guest-sessions.json');
    const readRecord = () => Object.values(JSON.parse(fs.readFileSync(indexFile, 'utf8')) as Record<string,
      { controller: string; nativeIds: string[]; hostSessionIds: string[]; cleanupEpoch: number; lastDirectForgetId?: string }>)
      .find((record) => record.controller === peer)!;
    const request = { op: 'forget', directGuest: { shareId: 'share-durable', memberId: 'member-durable',
      guestDeviceId: 'guest-pc', forgetId: '22222222-2222-4222-8222-222222222222', cleanupEpoch: 1 } };
    let acknowledgements = 0;
    const forget = () => host.handle(OWNER_DEVICE, request).then(() => { acknowledgements += 1; });
    const originalRename = fs.promises.rename.bind(fs.promises);
    let failRename = false;
    let failedWrites = 0;
    const rename = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === indexFile && failRename) {
        failedWrites += 1;
        throw Object.assign(new Error('injected guest index rename failure'), { code: 'EIO' });
      }
      return originalRename(from, to);
    });
    try {
      await grant('old-task', 1);
      await open('old-task');
      await waitFor(() => started.length === 1 && readRecord().nativeIds.length === 1);
      const oldNative = readRecord().nativeIds[0];
      failRename = true;
      await expect(forget()).rejects.toThrow('injected guest index rename failure');
      await expect(forget()).rejects.toThrow('injected guest index rename failure');
      expect(acknowledgements).toBe(0);
      expect(failedWrites).toBe(2);
      expect(readRecord().nativeIds).toEqual([oldNative]);
      expect(readRecord().lastDirectForgetId).toBeUndefined();
      failRename = false;
      await forget();
      expect(acknowledgements).toBe(1);
      expect(readRecord()).toMatchObject({ hostSessionIds: [], nativeIds: [], cleanupEpoch: 1,
        lastDirectForgetId: request.directGuest.forgetId });
      const purges = purge.mock.calls.length;
      host.dispose();
      host = makeHost();
      await forget();
      expect(purge).toHaveBeenCalledTimes(purges);
      expect(readRecord().nativeIds).toEqual([]);
      await grant('new-task', 2);
      await expect(open('new-task', { options: { resumeSessionId: oldNative } })).rejects.toThrow('REMOTE_AGENT_INVALID');
      await open('new-task');
      await waitFor(() => started.length === 2 && readRecord().nativeIds.length === 1);
      await forget(); // old epoch must not delete the newly granted task
      expect(readRecord().cleanupEpoch).toBe(2);
      expect(readRecord().nativeIds).toEqual([`sdk-direct-forget-durable-${started[1].input.hostSessionId}`]);
      expect(fs.existsSync(started[1].input.guestHome!)).toBe(true);
    } finally {
      rename.mockRestore();
      await host.abortAll();
      host.dispose();
    }
  });

  // Host.handle regression (unit): sequential forget coverage missed F1/F2
  // sharing an ID while F1 is still deleting transcripts. An early F2 ACK let
  // a new epoch open before F1 overwrote its native IDs and cleanup epoch.
  it.each([false, true])('joins duplicate direct forgets until cleanup settles (failure=%s)', async (failFirst) => {
    const started: Started[] = [];
    const peer = providerShareGuestPeer('share-race', 'member-race', 'guest-pc');
    const sessions = new Set<string>();
    let releasePurge!: () => void;
    let enteredPurge!: () => void;
    const purging = new Promise<void>((resolve) => { enteredPurge = resolve; });
    const barrier = new Promise<void>((resolve) => { releasePurge = resolve; });
    const purge = vi.fn(async () => undefined).mockImplementationOnce(async () => {
      enteredPurge();
      await barrier;
      if (failFirst) throw new Error('transcript cleanup failed');
    });
    const host = fakeAgentHost('direct-forget-race', started, {
      trust: (controller) => isProviderSharePeer(controller) ? 'guest' : 'owner', purge,
      directGuestExecution: {
        ownerScope: () => 'account-one',
        allocate: async () => null, status: () => undefined, release: async () => undefined,
        switch: async () => ({}), usage: () => undefined,
        sessionAllowed: (_controller, sessionId) => sessions.has(sessionId),
        sessionDelegated: (_controller, sessionId) => sessions.has(sessionId),
        delegate: async (_owner, request) => { sessions.add(request.sessionId); return true; },
        forget: () => { sessions.clear(); return true; },
      },
    });
    const grant = (sessionId: string, cleanupEpoch: number) => host.handle(OWNER_DEVICE, {
      op: 'delegate', action: 'grant', shareId: 'share-race', memberId: 'member-race', guestDeviceId: 'guest-pc',
      sessionId, cleanupEpoch, providerId: 'shared-provider', model: 'claude-opus',
      generation: '11111111-1111-4111-8111-111111111111',
    });
    const oldRunId = runId();
    const newRunId = runId();
    const open = (sessionId: string, id: string) => host.handle(peer, { op: 'open', runId: id, agentKind: 'claude-code',
      payload: { json: openPayload(sessionId, { projectFiles: [{ path: 'AGENTS.md', data: Buffer.from('new task').toString('base64') }] }) } });
    const forget = { op: 'forget', directGuest: { shareId: 'share-race', memberId: 'member-race',
      guestDeviceId: 'guest-pc', forgetId: '22222222-2222-4222-8222-222222222222', cleanupEpoch: 1 } };
    const results: string[] = [];
    const capture = (label: string, work: Promise<unknown>) => work.then(() => { results.push(`${label}:ok`); },
      () => { results.push(`${label}:failed`); });
    try {
      await grant('old-task', 1);
      await open('old-task', oldRunId);
      await waitForStarted(host, peer, oldRunId);
      expect(started).toHaveLength(1);
      const first = capture('F1', host.handle(OWNER_DEVICE, forget));
      await purging;
      const second = host.handle(OWNER_DEVICE, forget);
      const secondResult = capture('F2', second);
      const reopened = second.then(async () => {
        await grant('new-task', 2);
        await open('new-task', newRunId);
      }, () => undefined);
      // Give the duplicate real file I/O a short scheduling window. F1 is held
      // by an explicit barrier; no wall-clock timeout releases the deletion.
      await new Promise((resolve) => setTimeout(resolve, 30));
      const earlyResults = [...results];
      releasePurge();
      await Promise.all([first, secondResult, reopened]);
      expect(earlyResults).toEqual([]);
      expect(results.sort()).toEqual(failFirst ? ['F1:failed', 'F2:failed'] : ['F1:ok', 'F2:ok']);
      expect(purge).toHaveBeenCalledTimes(1);
      if (failFirst) {
        // Failed cleanup must release its queue and dedupe entry for retry.
        await host.handle(OWNER_DEVICE, forget);
        await grant('new-task', 2);
        await open('new-task', newRunId);
      }
      await waitForStarted(host, peer, newRunId);
      expect(started).toHaveLength(2);
      const session = started[1].input;
      const indexFile = path.join(root, 'direct-forget-race', 'guest-sessions.json');
      await waitFor(() => fs.readFileSync(indexFile, 'utf8').includes(`sdk-direct-forget-race-${session.hostSessionId}`));
      // Also reject a delayed older epoch with a different ID, after persistence.
      await host.handle(OWNER_DEVICE, { ...forget, directGuest: { ...forget.directGuest,
        forgetId: '33333333-3333-4333-8333-333333333333' } });
      const records = JSON.parse(fs.readFileSync(indexFile, 'utf8')) as Record<string,
        { controller: string; cleanupEpoch: number; nativeIds: string[] }>;
      const record = Object.values(records).find((item) => item.controller === peer)!;
      expect(record.cleanupEpoch).toBe(2);
      expect(record.nativeIds).toContain(`sdk-direct-forget-race-${session.hostSessionId}`);
      expect(fs.existsSync(session.guestHome!)).toBe(true);
      expect(fs.readFileSync(path.join(session.shadowDir, 'AGENTS.md'), 'utf8')).toContain('new task');
    } finally {
      releasePurge();
      host.dispose();
    }
  });

  // Unit, #7783 integration: per-task revocation with an authorized sibling
  // used to return missing, which restart recovery interpreted as a lost process.
  it('ends a revoked direct task without exposing its buffer or restarting it', async () => {
    const started: Started[] = [];
    const sessions = new Set(['revoked', 'sibling']);
    const peer = providerShareGuestPeer('share-revoke', 'member-revoke', 'guest-pc');
    const host = fakeAgentHost('direct-revoke', started, {
      trust: () => 'guest',
      directGuestExecution: {
        ownerScope: () => 'account-one', allocate: async () => null, status() {},
        release: async () => {}, switch: async () => ({}), usage() {}, delegate: async () => false, forget: () => false,
        sessionAllowed: (_peer, sessionId) => sessions.has(sessionId),
        sessionDelegated: (_peer, sessionId) => sessions.has(sessionId),
      },
    });
    const ids = [runId(), runId()];
    try {
      for (const [index, sessionId] of ['revoked', 'sibling'].entries()) {
        await host.handle(peer, { op: 'open', runId: ids[index], agentKind: 'claude-code', payload: { json: openPayload(sessionId) } });
      }
      await waitFor(() => started.length === 2);
      sessions.delete('revoked');
      const result = await host.handle(peer, { op: 'poll', runs: ids.map(id => ({ runId: id, cursor: 0 })), waitMs: 0 }) as {
        runs: Array<{ runId: string; missing?: boolean; data?: string; done?: boolean }>;
      };
      const denied = result.runs.find(run => run.runId === ids[0])!;
      expect(denied.missing).not.toBe(true);
      expect(denied.done).toBe(true);
      expect(Buffer.from(denied.data!, 'base64').toString()).toBe(JSON.stringify({ t: 'closed', reason: 'access-revoked' }) + '\n');
      const sibling = result.runs.find(run => run.runId === ids[1]);
      expect(sibling?.missing).not.toBe(true);
      expect(sibling?.done).not.toBe(true);
    } finally { host.dispose(); }
  });

  // Unit: shutdown must publish a busy boundary before waiting for a direct
  // native startup; disposal must still drain that startup's late writes.
  it('drains a direct startup after publishing the shutdown boundary', async () => {
    const started: Started[] = [];
    let release!: () => void;
    let entered!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const starting = new Promise<void>(resolve => { entered = resolve; });
    let shadow = '';
    const host = fakeAgentHost('direct-shutdown', started, {
      trust: () => 'guest',
      beforeStart: async input => { shadow = input.shadowDir; entered(); await barrier; },
      directGuestExecution: {
        ownerScope: () => 'account-one', allocate: async () => null, status() {},
        release: async () => {}, switch: async () => ({}), usage() {}, delegate: async () => false, forget: () => false,
        sessionAllowed: () => true, sessionDelegated: () => true,
      },
    });
    const id = runId();
    try {
      await host.handle(GUEST_A, { op: 'open', runId: id, agentKind: 'claude-code', payload: { json: openPayload('shutdown-task') } });
      await starting;
      await host.abortAll('app-quit');
      const result = await host.handle(GUEST_A, { op: 'poll', runs: [{ runId: id, cursor: 0 }], waitMs: 0 }) as { runs: Array<{ data: string }> };
      expect(Buffer.from(result.runs[0].data, 'base64').toString()).toContain('"reason":"provider-restarting"');
      host.dispose();
      expect(fs.existsSync(shadow)).toBe(true);
      release();
      await waitFor(() => !fs.existsSync(shadow));
    } finally { release(); host.dispose(); }
  });

  // Host.handle(open/forget/delegate), unit: forgetting during native startup
  // must drain its late file writes before a newer grant/open. Sequential tests
  // miss this; a same-peer relay and poll must still progress while it drains.
  it('drains direct startup before forgetting and queues a newer grant/open without blocking relay or poll', async () => {
    const started: Started[] = [];
    const peer = providerShareGuestPeer('share-start', 'member-start', 'guest-pc');
    const sessions = new Set<string>();
    let releaseStart!: () => void;
    let enteredStart!: () => void;
    let revoked!: () => void;
    const starting = new Promise<void>((resolve) => { enteredStart = resolve; });
    const barrier = new Promise<void>((resolve) => { releaseStart = resolve; });
    const revoking = new Promise<void>((resolve) => { revoked = resolve; });
    const oldSessionId = hostSessionIdFor(peer, 'old-task');
    const purge = vi.fn(async () => undefined);
    const host = fakeAgentHost('direct-start-race', started, {
      trust: (controller) => isProviderSharePeer(controller) ? 'guest' : 'owner', purge,
      beforeStart: async (input) => {
        if (input.hostSessionId !== oldSessionId) return;
        enteredStart();
        await barrier;
        // A native startup already in progress may still create its files
        // after finishRun has marked the Run closing.
        fs.mkdirSync(input.guestHome!, { recursive: true });
        fs.writeFileSync(path.join(input.guestHome!, 'late-native.txt'), 'old history');
      },
      directGuestExecution: {
        ownerScope: () => 'account-one',
        allocate: async () => null, status: () => undefined, release: async () => undefined,
        switch: async () => ({}), usage: () => undefined,
        sessionAllowed: (_controller, sessionId) => sessions.has(sessionId),
        sessionDelegated: (_controller, sessionId) => sessions.has(sessionId),
        delegate: async (_owner, request) => { sessions.add(request.sessionId); return true; },
        forget: () => { sessions.clear(); revoked(); return true; },
      },
    });
    const grant = (sessionId: string, cleanupEpoch: number) => host.handle(OWNER_DEVICE, {
      op: 'delegate', action: 'grant', shareId: 'share-start', memberId: 'member-start', guestDeviceId: 'guest-pc',
      sessionId, cleanupEpoch, providerId: 'shared-provider', model: 'claude-opus',
      generation: '11111111-1111-4111-8111-111111111111',
    });
    const oldRunId = runId();
    const open = (sessionId: string, extra = {}, id = runId()) => host.handle(peer, { op: 'open', runId: id, agentKind: 'claude-code',
      payload: { json: openPayload(sessionId, extra) } });
    let pending: Promise<unknown> | undefined;
    try {
      await grant('old-task', 1);
      await open('old-task', {}, oldRunId);
      await starting;
      let forgetAcknowledged = false;
      const forget = host.handle(OWNER_DEVICE, { op: 'forget', directGuest: {
        shareId: 'share-start', memberId: 'member-start', guestDeviceId: 'guest-pc',
        forgetId: '22222222-2222-4222-8222-222222222222', cleanupEpoch: 1,
      } }).then(() => { forgetAcknowledged = true; });
      await revoking;
      const newGrant = grant('new-task', 2);
      const newRunId = runId();
      const newOpen = open('new-task', {}, newRunId);
      pending = Promise.all([forget, newGrant, newOpen]);
      const relayRunId = runId();
      await open('relay-task', { relay: relayKeyFor(peer) }, relayRunId);
      await waitForStarted(host, peer, relayRunId);
      expect(started.some((item) => item.input.hostSessionId !== oldSessionId)).toBe(true);
      await host.handle(peer, { op: 'poll', runs: [{ runId: oldRunId, cursor: 0 }], waitMs: 0 });
      await host.handle(OWNER_DEVICE, { op: 'delegate', action: 'grant',
        shareId: 'other-share', memberId: 'other-member', guestDeviceId: 'other-pc',
        sessionId: 'other-task', cleanupEpoch: 1, providerId: 'shared-provider', model: 'claude-opus',
        generation: '11111111-1111-4111-8111-111111111111' });
      expect(forgetAcknowledged).toBe(false);
      expect(purge).not.toHaveBeenCalled();
      expect(sessions.has('new-task')).toBe(false);
      expect(sessions.has('other-task')).toBe(true);
      releaseStart();
      await pending;
      await waitForStarted(host, peer, newRunId);
      expect(started).toHaveLength(3);
      const newSession = started.find((item) => item.input.hostSessionId === hostSessionIdFor(peer, 'new-task'))!.input;
      expect(fs.existsSync(newSession.guestHome!)).toBe(true);
      expect(fs.existsSync(path.join(newSession.guestHome!, 'late-native.txt'))).toBe(false);
      const relaySession = started.find((item) => item.input.hostSessionId !== oldSessionId && item.input !== newSession)!.input;
      expect(fs.existsSync(relaySession.guestHome!)).toBe(true);
      expect(purge).toHaveBeenCalledTimes(1);
      expect(purge).toHaveBeenCalledWith([oldSessionId], []);
      const indexFile = path.join(root, 'direct-start-race', 'guest-sessions.json');
      await waitFor(() => fs.readFileSync(indexFile, 'utf8').includes(`sdk-direct-start-race-${newSession.hostSessionId}`));
      const records = JSON.parse(fs.readFileSync(indexFile, 'utf8')) as Record<string,
        { controller: string; relay?: string; cleanupEpoch: number; nativeIds: string[] }>;
      const record = Object.values(records).find((item) => item.controller === peer && !item.relay)!;
      expect(record.cleanupEpoch).toBe(2);
      expect(record.nativeIds).toEqual([`sdk-direct-start-race-${newSession.hostSessionId}`]);
    } finally {
      releaseStart();
      await pending?.catch(() => undefined);
      host.dispose();
    }
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

  it.each([
    { groupAssigned: true },
    { groupAssigned: true, relay: relayKeyFor(GUEST_A) },
  ])('keeps the local group policy on a guest execution even when routing was already assigned: %j', async (extra) => {
    const env = setup({ plans: [{ kind: 'local' }] });
    const started: Started[] = [];
    const host = fakeAgentHost('policy-host', started, { trust: () => 'guest', groupRelay: env.relay });
    try {
      await host.handle(GUEST_A, { op: 'open', runId: runId(), agentKind: 'claude-code', payload: { json: openPayload('policy-task', extra) } });
      await waitFor(() => started.length > 0);
      expect(started[0].input.groupProviderId).toBe('shared-provider');
      expect(env.relay.plan).not.toHaveBeenCalled();
    } finally {
      await host.dispose();
    }
  });

  // Direct routing regression (provider-sharing-direct-execution.md): Host.handle(open)
  // must use M's server-checked task grant. Earlier cases all supplied groupAssigned,
  // so a G omitting that untrusted hint made M forward to its own group (unit tier).
  it('runs a delegated guest locally when G omits groupAssigned while ordinary guests still use the group', async () => {
    const env = setup();
    const started: Started[] = [];
    const delegated = new Set<string>();
    const directPeer = providerShareGuestPeer('share-a', 'member-a', 'guest-pc');
    const ordinaryPeer = providerShareGuestPeer('share-b', 'member-b', 'guest-pc');
    const grantKey = (controller: string, sessionId: string) => JSON.stringify([controller, sessionId]);
    const host = fakeAgentHost('assigned-member', started, {
      trust: (controller) => controller === OWNER_DEVICE ? 'owner' : 'guest',
      groupRelay: env.relay,
      directGuestExecution: {
        ownerScope: () => 'account-one',
        allocate: async () => null, status: () => undefined, release: async () => undefined,
        switch: async () => ({}),
        // Production sessionAllowed also permits an ordinary guest with no lease.
        sessionAllowed: () => true,
        sessionDelegated: (controller, sessionId) => delegated.has(grantKey(controller, sessionId)),
        usage: () => undefined,
        delegate: async (_owner, request) => {
          delegated.add(grantKey(providerShareGuestPeer(request.shareId, request.memberId,
            request.guestDeviceId), request.sessionId));
          return false;
        },
        forget: () => true,
      },
    });
    try {
      await host.handle(OWNER_DEVICE, { op: 'delegate', action: 'grant',
        shareId: 'share-a', memberId: 'member-a', guestDeviceId: 'guest-pc',
        sessionId: 'direct-task', providerId: 'shared-provider', model: 'claude-opus',
        generation: '11111111-1111-4111-8111-111111111111', cleanupEpoch: 1 });
      await host.handle(directPeer, { op: 'open', runId: runId(), agentKind: 'claude-code',
        payload: { json: openPayload('direct-task') } });
      expect(env.relay.plan).not.toHaveBeenCalled();
      await waitFor(() => started.length === 1);
      expect(started[0].input.guest).toBe(true);
      await host.handle(ordinaryPeer, { op: 'open', runId: runId(), agentKind: 'claude-code',
        payload: { json: openPayload('ordinary-task') } });
      await waitFor(() => env.memberStarted.mini.length === 1);
      expect(env.relay.plan).toHaveBeenCalledTimes(1);
    } finally {
      for (const item of [host, env.owner, ...Object.values(env.members)]) {
        await item.abortAll();
        item.dispose();
      }
    }
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

  // Unit: Host.handle(open) must release a reserved group slot if final admission throws.
  // Regression #7666/r4398894989: existing cleanup tests covered boolean denials, not budget exceptions.
  // Minimal input: group plan reserves a slot, then isAllowed throws the stable pause error before runs.set.
  it('releases reserved group load when final admission throws a member budget pause', async () => {
    const load = { setRunning: vi.fn(), release: vi.fn() };
    const paused = Object.assign(new Error('[REMOTE_AGENT_MEMBER_BUDGET_PAUSED] Model share reached'), {
      code: 'REMOTE_AGENT_MEMBER_BUDGET_PAUSED',
    });
    const env = setup({ plans: [{ kind: 'local', load }], owner: { modelAccess: { isAllowed: () => { throw paused; } } } });
    try {
      await expect(env.owner.handle(GUEST_A, {
        op: 'open', runId: runId(), agentKind: 'claude-code', payload: { json: openPayload(SESSION) },
      })).rejects.toBe(paused);
      expect(load.release).toHaveBeenCalledTimes(1);
      expect(env.owner.runCount()).toBe(0);
      expect(env.ownerStarted).toHaveLength(0);
    } finally {
      for (const host of [env.owner, ...Object.values(env.members)]) { await host.abortAll(); host.dispose(); }
    }
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
  // provider-groups.md §6.1, unit: exercise the real host, relay and run client.
  // Existing cases emitted a terminal event independently of send(), missing the
  // quota RPC rejection that could overtake the switch offer and lose recovery.
  // Cover local/relayed execution and both native-event orders; one failure must
  // produce one offer/error before rejecting send, then one send on the new host.
  it.each(['local', 'member'] as const)('settles quota replies through one switch offer on %s', async placement => {
    for (const eventFirst of [true, false]) {
      const onSend = (record: Started) => {
        if (eventFirst) record.emit(USAGE_LIMIT_ERROR);
        throw new Error('You have hit your usage limit');
      };
      const env = setup({
        plans: [
          placement === 'local' ? { kind: 'local' } : { kind: 'member', ...MEMBER_MINI },
          { kind: 'member', ...MEMBER_STUDIO },
          { kind: 'member', ...MEMBER_STUDIO },
        ],
        ...(placement === 'local' ? { owner: { onSend } } : { mini: { onSend } }),
      });
      const first = await openAsGuest(env, GUEST_A, openPayload(`${SESSION}-${eventFirst}`, { acceptsGroupSwitch: true }));
      const record = placement === 'local' ? env.ownerStarted[0] : env.memberStarted.mini[0];
      try {
        await expect(first.client.call('send', [{ type: 'user', content: 'finish the task' }, { throwOnStartFailure: true }]))
          .rejects.toThrow('usage limit');
        const token = switchTokenIn(first.stream);
        expect(token).toBeDefined();
        const errors = () => first.stream.filter(item => item.t === 'event' && item.event.type === 'error');
        expect(errors()).toHaveLength(1);
        expect(first.stream.findIndex(item => item.t === 'state' && item.state.providerGroupSwitch === token))
          .toBeLessThan(first.stream.findIndex(item => item.t === 'event' && item.event.type === 'error'));

        // A late or repeated SDK terminal must not offer another switch or resume.
        record.emit(USAGE_LIMIT_ERROR);
        record.emit({ type: 'status', source: 'claude-code', data: { status: 'quota-tail-flushed' } });
        await waitFor(() => first.stream.some(item => item.t === 'event'
          && (item.event.data as { status?: string })?.status === 'quota-tail-flushed'));
        expect(errors()).toHaveLength(1);
        expect(first.stream.filter(item => item.t === 'state' && item.state.providerGroupSwitch)).toHaveLength(1);
        expect(env.relay.noteRunFailure).toHaveBeenCalledTimes(1);
        await first.client.close('close', 'navigation');

        const next = await openAsGuest(env, GUEST_A, openPayload(`${SESSION}-${eventFirst}`, {
          acceptsGroupSwitch: true, groupSwitchToken: token,
        }));
        try {
          await next.client.call('send', [{ type: 'user', content: 'finish the task' }, {}]);
          expect(env.memberStarted.studio[0].sends).toHaveLength(1);
          expect(record.sends).toHaveLength(1);
        } finally {
          await next.client.close('close', 'navigation');
        }
      } finally {
        await first.client.close('close', 'navigation');
        for (const host of [env.owner, ...Object.values(env.members)]) { await host.abortAll(); host.dispose(); }
      }
    }
  });

  it('does not turn an uncertain send timeout into a quota event or switch offer', async () => {
    const env = setup({ mini: { onSend: () => { throw new Error('request timed out'); } } });
    const first = await openAsGuest(env, GUEST_A, openPayload(SESSION, { acceptsGroupSwitch: true }));
    try {
      await expect(first.client.call('send', [{ type: 'user', content: 'finish the task' }, {}]))
        .rejects.toThrow('request timed out');
      expect(switchTokenIn(first.stream)).toBeUndefined();
      expect(first.stream.some(item => item.t === 'event' && item.event.type === 'error')).toBe(false);
      expect(env.relay.noteRunFailure).not.toHaveBeenCalled();
      expect(env.memberStarted.mini[0].sends).toHaveLength(1);
    } finally {
      await first.client.close('close', 'navigation');
      for (const host of [env.owner, ...Object.values(env.members)]) { await host.abortAll(); host.dispose(); }
    }
  });

  it('ignores an obsolete quota rejection after the user stops and sends again', async () => {
    let entered!: () => void;
    const sending = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const response = new Promise<void>(resolve => { release = resolve; });
    const env = setup({ mini: { onSend: async record => {
      if (record.sends.length > 1) return;
      entered();
      await response;
      throw new Error('You have hit your usage limit');
    } } });
    const first = await openAsGuest(env, GUEST_A, openPayload(SESSION, { acceptsGroupSwitch: true }));
    const obsolete = first.client.call('send', [{ type: 'user', content: 'old attempt' }, {}]).catch(error => error);
    try {
      await sending;
      await first.client.call('abort', []);
      await first.client.call('send', [{ type: 'user', content: 'new attempt' }, { groupNewRound: true }]);
      release();
      expect(await obsolete).toMatchObject({ message: expect.stringContaining('usage limit') });
      expect(env.memberStarted.mini[0].sends).toHaveLength(2);
      expect(switchTokenIn(first.stream)).toBeUndefined();
      expect(first.stream.some(item => item.t === 'event' && item.event.type === 'error')).toBe(false);
      expect(env.relay.noteRunFailure).not.toHaveBeenCalled();
    } finally {
      release();
      await first.client.close('close', 'navigation');
      for (const host of [env.owner, ...Object.values(env.members)]) { await host.abortAll(); host.dispose(); }
    }
  });

  // A delayed group decision used to let the RPC rejection overtake its terminal
  // event. Keep it pending while another controller completes a send on the same
  // member: the failure's scope is one run, without resetting any shared link.
  it('holds a quota rejection behind its switch decision without blocking another controller', async () => {
    const env = setup({
      plans: [{ kind: 'member', ...MEMBER_MINI }, { kind: 'member', ...MEMBER_MINI }],
      mini: { onSend: record => {
        if (record !== failing) return;
        record.emit(USAGE_LIMIT_ERROR);
        throw new Error('You have hit your usage limit');
      } },
    });
    const first = await openAsGuest(env, GUEST_A, openPayload(SESSION, { acceptsGroupSwitch: true }));
    const failing = env.memberStarted.mini[0];
    const other = await openAsGuest(env, GUEST_B, openPayload(SESSION, { acceptsGroupSwitch: true }));
    let release!: () => void;
    const decision = new Promise<void>(resolve => { release = resolve; });
    env.relay.plan.mockImplementationOnce(async () => {
      await decision;
      return { kind: 'member', ...MEMBER_STUDIO };
    });
    let rejected = false;
    const send = first.client.call('send', [{ type: 'user', content: 'finish the task' }, {}]).catch(error => {
      rejected = true;
      return error;
    });
    try {
      await waitFor(() => env.relay.plan.mock.calls.length === 3);
      await other.client.call('send', [{ type: 'user', content: 'unrelated task' }, {}]);
      expect(env.memberStarted.mini[1].sends).toHaveLength(1);
      expect(other.isClosed()).toBe(false);
      expect(switchTokenIn(other.stream)).toBeUndefined();
      expect(rejected).toBe(false);
      release();
      expect(await send).toMatchObject({ message: expect.stringContaining('usage limit') });
      expect(switchTokenIn(first.stream)).toBeDefined();
      expect(first.stream.filter(item => item.t === 'event' && item.event.type === 'error')).toHaveLength(1);
    } finally {
      release();
      await Promise.all([first.client.close('close', 'navigation'), other.client.close('close', 'navigation')]);
      for (const host of [env.owner, ...Object.values(env.members)]) { await host.abortAll(); host.dispose(); }
    }
  });

  // Review r4386499053: an SDK stream/legacy member can end after rejecting send,
  // before the next-member decision completes. Only passive shutdown must wait;
  // otherwise closing invalidates the pending offer before it reaches the guest.
  it.each([
    ['local', 'end'], ['local', 'error'], ['local', 'explicit'],
    ['member', 'end'], ['member', 'error'], ['member', 'explicit'],
  ] as const)('settles pending quota recovery on %s shutdown (%s)', async (placement, endKind) => {
    let rejectQuota = placement === 'member';
    const env = setup({
      plans: [
        placement === 'local' ? { kind: 'local' } : { kind: 'member', ...MEMBER_MINI },
        { kind: 'member', ...MEMBER_MINI },
      ],
      owner: { onSend: () => { throw new Error('You have hit your usage limit'); } },
      // Model an older member returning a quota rejection without a native error.
      intercept: async (_device, request, forward) => {
        if (rejectQuota && request.op === 'call' && request.method === 'send') {
          rejectQuota = false;
          throw new Error('You have hit your usage limit');
        }
        return forward();
      },
    });
    const first = await openAsGuest(env, GUEST_A, openPayload(SESSION, { acceptsGroupSwitch: true }));
    const record = placement === 'local' ? env.ownerStarted[0] : env.memberStarted.mini[0];
    const other = await openAsGuest(env, GUEST_B, openPayload(SESSION));
    const memberEnded = placement === 'member'
      ? vi.spyOn(env.relay.connect(MEMBER_MINI.agentDeviceId).poller, 'unregister')
      : null;
    let release!: () => void;
    const decision = new Promise<void>(resolve => { release = resolve; });
    env.relay.plan.mockImplementationOnce(async () => {
      await decision;
      return { kind: 'member', ...MEMBER_STUDIO };
    });
    const send = first.client.call('send', [{ content: 'finish the task' }, {}]).catch(error => error);
    try {
      await waitFor(() => env.relay.plan.mock.calls.length === 3);
      if (endKind === 'explicit') {
        await first.client.close('close', 'navigation');
        expect(first.isClosed()).toBe(true);
        release();
        await send;
        expect(switchTokenIn(first.stream)).toBeUndefined();
        expect(first.stream.some(item => item.t === 'event' && item.event.type === 'error')).toBe(false);
        return;
      }
      record.end(endKind === 'error' ? new Error('agent stream ended unexpectedly') : undefined);
      if (memberEnded) await waitFor(() => memberEnded.mock.calls.length > 0);
      // Another full round trip lets the passive end propagate while plan waits.
      await other.client.call('send', [{ content: 'unrelated task' }, {}]);
      expect(first.isClosed()).toBe(false);
      expect(other.isClosed()).toBe(false);
      release();
      expect(await send).toMatchObject({ message: expect.stringContaining('usage limit') });
      await waitFor(() => first.isClosed());
      expect(switchTokenIn(first.stream)).toBeDefined();
      expect(first.stream.filter(item => item.t === 'event' && item.event.type === 'error')).toHaveLength(1);
      expect(env.relay.noteRunFailure).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await Promise.all([first.client.close('close', 'navigation'), other.client.close('close', 'navigation')]);
      for (const host of [env.owner, ...Object.values(env.members)]) { await host.abortAll(); host.dispose(); }
    }
  });

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

  it('accepts a retried token only from the shared user and task it was sent to', async () => {
    const switched = vi.fn(async () => undefined);
    const env = setup({
      owner: { directGuestExecution: {
        ownerScope: () => 'owner', allocate: async () => null,
        status: () => undefined, release: async () => undefined, switch: async () => ({}),
        switched, sessionAllowed: () => true, sessionDelegated: () => false,
        usage: () => undefined, delegate: async () => false, forget: () => false,
      } },
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
    expect(switched).not.toHaveBeenCalled();

    const used = await openAsGuest(env, GUEST_A, openPayload(SESSION, { groupSwitchToken: token }));
    expect(env.relay.plan).toHaveBeenLastCalledWith(expect.objectContaining({ exclude: new Set([MEMBER_MINI.memberKey]) }));
    expect(switched).toHaveBeenCalledWith(GUEST_A, SESSION, token);
    await used.client.close('close', 'navigation');
    const again = await openAsGuest(env, GUEST_A, openPayload(SESSION, { groupSwitchToken: token }));
    expect(env.relay.plan).toHaveBeenLastCalledWith(expect.objectContaining({ exclude: new Set([MEMBER_MINI.memberKey]) }));
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

// Unit: real Host.handle and the existing disk/agent boundary fixture. F3 was
// missed by write-only tombstone tests: one failed initial read, malformed tail,
// or failed strict rename must not erase ownership or acknowledge cached state.
describe('guest index failure recovery', () => {
  const peer = providerShareGuestPeer('share-index', 'member-index', 'guest-pc');
  const otherPeer = providerShareGuestPeer('share-other', 'member-other', 'other-pc');
  const digest = (controller: string) => createHash('sha256').update(controller).digest('hex').slice(0, 32);
  const forgetId = '22222222-2222-4222-8222-222222222222';
  function setupIndex() {
    const started: Started[] = [];
    const leases = new Set<string>();
    const host = fakeAgentHost('index-recovery', started, {
      trust: (controller) => isProviderSharePeer(controller) ? 'guest' : 'owner',
      directGuestExecution: {
        ownerScope: () => 'account-one', allocate: async () => null,
        status() {}, release: async () => {}, switch: async () => ({}), usage() {},
        sessionAllowed: (_controller, sessionId) => leases.has(sessionId),
        sessionDelegated: (_controller, sessionId) => leases.has(sessionId),
        delegate: async (_owner, request) => {
          if (request.action === 'grant') leases.add(request.sessionId);
          else leases.delete(request.sessionId);
          return true;
        },
        forget: () => true,
      },
    });
    const file = path.join(root, 'index-recovery', 'guest-sessions.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const record = { controller: peer, hostSessionIds: [hostSessionIdFor(peer, 'old')], nativeIds: ['native-old'],
      directOwnerDeviceId: OWNER_DEVICE, directOwnerScopeKey: 'account-one', cleanupEpoch: 9,
      lastDirectForgetId: forgetId, attachmentRunIds: [forgetId], forkWorkspaces: { 'native-old': [forgetId] } };
    const old = { [digest(peer)]: record, [digest(otherPeer)]: { controller: otherPeer, nativeIds: ['native-other'],
      members: { 'native-other': { memberKey: 'device:old:provider', agentDeviceId: 'old-device', providerId: 'provider' } } } };
    const grant = (owner = OWNER_DEVICE) => host.handle(owner, {
      op: 'delegate', action: 'grant', shareId: 'share-index', memberId: 'member-index', guestDeviceId: 'guest-pc',
      sessionId: 'old', cleanupEpoch: 9, providerId: 'shared-provider', model: 'claude-opus',
      generation: '11111111-1111-4111-8111-111111111111',
    });
    const fork = (controller = peer, nativeId = 'native-old') => host.handle(controller, {
      op: 'fork', agentKind: 'claude-code', sourceSessionId: 'old', sourceSdkSessionId: nativeId,
      newSessionId: 'forked', providerId: 'shared-provider', model: 'claude-opus',
    });
    return { host, file, record, old, grant, fork, leases };
  }
  it.each(['EBUSY', 'EIO'])('retries an initial %s in the same host without replacing old safety records', async (code) => {
    const env = setupIndex();
    const original = JSON.stringify(env.old, null, 2);
    fs.writeFileSync(env.file, original);
    const read = fs.promises.readFile.bind(fs.promises);
    let injected = false;
    const spy = vi.spyOn(fs.promises, 'readFile').mockImplementation((async (...args: Parameters<typeof read>) => {
      if (String(args[0]) === env.file && !injected) {
        injected = true;
        throw Object.assign(new Error(`injected ${code}`), { code });
      }
      return read(...args);
    }) as typeof read);
    try {
      await expect(env.grant()).rejects.toThrow(`injected ${code}`);
      expect(env.leases.size).toBe(0);
      expect(fs.readFileSync(env.file, 'utf8')).toBe(original);
      await env.grant();
      const saved = JSON.parse(fs.readFileSync(env.file, 'utf8'));
      expect(saved[digest(peer)]).toEqual(env.record);
      expect(saved[digest(otherPeer)].nativeIds).toEqual(['native-other']);
      expect(saved[digest(otherPeer)].members['native-other'].sameAccount).toBe(false);
      await expect(env.fork(otherPeer)).rejects.toThrow('REMOTE_AGENT_INVALID');
      await expect(env.fork()).resolves.toMatchObject({ newSdkSessionId: 'native-old-fork' });
      // A same-account caller does not acquire the guest index boundary.
      await expect(env.host.handle(OWNER_DEVICE, { op: 'caps' })).resolves.toMatchObject({ version: 1 });
    } finally { spy.mockRestore(); await env.host.dispose(); }
  });
  it.each([
    ['root', []], ['json', '{'], ['record', null], ['controller', 7], ['relay', []],
    ['nativeIds', ['native', 1]], ['hostSessionIds', ['../unsafe']], ['attachmentRunIds', ['unsafe-path']],
    ['forkWorkspaces', { native: ['unsafe-path'] }], ['members', { native: { memberKey: 'm', agentDeviceId: 'd' } }],
    ['relayDevices', ['ok', null]], ['forgetPending', {}], ['directOwnerDeviceId', ''],
    ['directOwnerScopeKey', false], ['cleanupEpoch', -1], ['lastDirectForgetId', 'bad'],
    ['identity', 'different-controller'],
  ])('rejects a corrupt %s without publishing a partial cache, then accepts a repaired file', async (field, value) => {
    const env = setupIndex();
    const tail = { ...env.record, controller: otherPeer };
    const invalid = field === 'root' ? JSON.stringify(value) : field === 'json' ? String(value)
      : JSON.stringify({ [digest(peer)]: env.record, [digest(otherPeer)]: field === 'record' ? value
        : { ...tail, [field === 'identity' ? 'controller' : String(field)]: value } });
    fs.writeFileSync(env.file, invalid);
    try {
      await expect(env.grant()).rejects.toThrow();
      await expect(env.grant()).rejects.toThrow();
      expect(env.leases.size).toBe(0);
      expect(fs.readFileSync(env.file, 'utf8')).toBe(invalid);
      fs.writeFileSync(env.file, JSON.stringify(env.old));
      await env.grant();
      expect(JSON.parse(fs.readFileSync(env.file, 'utf8'))[digest(peer)]).toEqual(env.record);
    } finally { await env.host.dispose(); }
  });
  it('retains omitted legacy fields and all native ownership entries during migration', async () => {
    const env = setupIndex();
    const nativeIds = Array.from({ length: 20_001 }, (_, i) => `native-${i}`);
    fs.writeFileSync(env.file, JSON.stringify({ [digest(peer)]: { controller: peer, nativeIds } }));
    try {
      await env.grant();
      expect(JSON.parse(fs.readFileSync(env.file, 'utf8'))[digest(peer)].nativeIds).toEqual(nativeIds);
      await expect(env.fork(peer, nativeIds.at(-1))).resolves.toMatchObject({ newSdkSessionId: 'native-20000-fork' });
    } finally { await env.host.dispose(); }
  });
  it('does not cache an owner whose grant failed to persist', async () => {
    const env = setupIndex();
    fs.writeFileSync(env.file, JSON.stringify({}));
    const rename = fs.promises.rename.bind(fs.promises);
    const spy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === env.file) throw new Error('injected rename failure');
      return rename(from, to);
    });
    try {
      await expect(env.grant()).rejects.toThrow('injected rename failure');
      expect(env.leases.size).toBe(0);
      expect(fs.readFileSync(env.file, 'utf8')).toBe('{}');
      spy.mockRestore();
      await expect(env.grant('replacement-owner')).resolves.toEqual({});
      expect(JSON.parse(fs.readFileSync(env.file, 'utf8'))[digest(peer)].directOwnerDeviceId).toBe('replacement-owner');
    } finally { spy.mockRestore(); await env.host.dispose(); }
  });
});

// Strict session writes must remain retryable as well as initial owner writes.
it('does not acknowledge a repeated direct fork whose native index write failed', async () => {
  const peer = providerShareGuestPeer('share-write', 'member-write', 'guest-pc');
  const host = fakeAgentHost('index-fork-write', [], {
    trust: (controller) => isProviderSharePeer(controller) ? 'guest' : 'owner',
    directGuestExecution: {
      ownerScope: () => 'account-one', allocate: async () => null,
      status() {}, release: async () => {}, switch: async () => ({}), usage() {},
      sessionAllowed: () => true, sessionDelegated: () => true,
      delegate: async () => true, forget: () => true,
    },
  });
  const file = path.join(root, 'index-fork-write', 'guest-sessions.json');
  const digest = createHash('sha256').update(peer).digest('hex').slice(0, 32);
  const record = { controller: peer, nativeIds: ['native-old'], hostSessionIds: [],
    directOwnerDeviceId: OWNER_DEVICE, directOwnerScopeKey: 'account-one', cleanupEpoch: 1 };
  const original = JSON.stringify({ [digest]: record });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, original);
  const rename = fs.promises.rename.bind(fs.promises);
  const spy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
    if (String(to) === file) throw new Error('injected session index failure');
    return rename(from, to);
  });
  const fork = () => host.handle(peer, { op: 'fork', agentKind: 'claude-code', sourceSessionId: 'old',
    sourceSdkSessionId: 'native-old', newSessionId: 'forked', providerId: 'shared-provider', model: 'claude-opus' });
  try {
    await expect(fork()).rejects.toThrow('injected session index failure');
    await expect(fork()).rejects.toThrow('injected session index failure');
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    spy.mockRestore();
    await expect(fork()).resolves.toMatchObject({ newSdkSessionId: 'native-old-fork' });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))[digest].nativeIds).toEqual(['native-old', 'native-old-fork']);
  } finally { spy.mockRestore(); await host.dispose(); }
});
