/**
 * 「允许被远程调用」：Agent 替另一台电脑运行时只能用本机开放了的供应商。
 * 启动、换来源、进行中关掉授权后的下一条消息，都在运行 Agent 的这台核对。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AgentEvent, AgentSessionHandle } from '@cindy/maker-core';
import type { ProviderView } from '@cindy/model-providers';
import { providerShareGuestPeer } from '@cindy/device-link';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startRemoteAgentSession } from '../controller/startRemote';
import { createGuestProviderRouteBinder, guestProviderModelIds, resolveGuestProviderId, resolveSharedProviderId } from '../host/providerAccess';
import { createRemoteAgentHost, type HostedStartInput } from '../host/runHost';
import { captureGuestRequestUsage, guestProviderModelAllowed, guestProviderRouteForToken, resetGuestProviderRoutesForTest } from '../../maker-host/guest-provider-route-store';

const RG = path.resolve(__dirname, '../../../../../ripgrep-bin', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'rg.exe' : 'rg');

const view = (id: string, models: string[]): ProviderView => ({
  id,
  name: id,
  agents: ['claude-code'],
  connected: true,
  models: { 'claude-code': models.map((model) => ({ id: model, name: model, efforts: [], defaultEffort: null })) },
  routing: { 'claude-code': {} },
}) as unknown as ProviderView;

describe('resolveSharedProviderId', () => {
  const views = [view('xd', ['opus']), view('spark', ['opus', 'sonnet'])];
  const sharedOnly = (allowed: string[]) => (providerId: string) => allowed.includes(providerId);

  it('only accepts an explicit source this computer opened for remote use', () => {
    expect(resolveSharedProviderId(views, sharedOnly(['spark']), 'claude-code', 'opus', 'spark')).toBe('spark');
    expect(resolveSharedProviderId(views, sharedOnly(['spark']), 'claude-code', 'opus', 'xd')).toBeNull();
    // 授权名单里留着、但供应商已经不在了。
    expect(resolveSharedProviderId(views, sharedOnly(['gone']), 'claude-code', 'opus', 'gone')).toBeNull();
  });

  it('picks the default only among opened providers when no source is given', () => {
    // xd 是本机的原生默认，但没开放，落到开放的 spark。
    expect(resolveSharedProviderId(views, sharedOnly(['spark']), 'claude-code', 'opus', null)).toBe('spark');
    expect(resolveSharedProviderId(views, sharedOnly(['xd']), 'claude-code', 'sonnet', undefined)).toBeNull();
    expect(resolveSharedProviderId(views, sharedOnly([]), 'claude-code', 'opus', null)).toBeNull();
  });
});

describe('resolveGuestProviderId (shared-provider guests)', () => {
  const views = [view('xd', ['opus', 'haiku']), view('spark', ['opus', 'sonnet'])];
  const allowed = (providerId: string) => providerId === 'spark';

  it('pins the source to the shared provider, also when none is given', () => {
    expect(resolveGuestProviderId(views, 'spark', allowed, 'claude-code', 'sonnet', 'spark')).toBe('spark');
    expect(resolveGuestProviderId(views, 'spark', allowed, 'claude-code', 'sonnet', null)).toBe('spark');
    expect(resolveGuestProviderId(views, 'spark', allowed, 'claude-code', 'opus', undefined)).toBe('spark');
  });

  it('refuses a model the shared provider does not offer, even if another provider here does', () => {
    expect(resolveGuestProviderId(views, 'spark', allowed, 'claude-code', 'haiku', null)).toBeNull();
    expect(resolveGuestProviderId(views, 'spark', allowed, 'claude-code', 'haiku', 'spark')).toBeNull();
    expect(resolveGuestProviderId(views, 'spark', allowed, 'claude-code', '', null)).toBeNull();
    expect(resolveGuestProviderId(views, 'spark', allowed, 'codex', 'sonnet', null)).toBeNull();
  });

  it('refuses another provider, a withdrawn share and a closed provider', () => {
    expect(resolveGuestProviderId(views, 'spark', allowed, 'claude-code', 'opus', 'xd')).toBeNull();
    expect(resolveGuestProviderId(views, undefined, allowed, 'claude-code', 'opus', null)).toBeNull();
    expect(resolveGuestProviderId(views, 'spark', () => false, 'claude-code', 'opus', null)).toBeNull();
  });

  it('lists the shared provider\'s models for the agent', () => {
    expect(guestProviderModelIds(views, 'spark', 'claude-code')).toEqual(['opus', 'sonnet']);
    expect(guestProviderModelIds(views, 'spark', 'codex')).toEqual([]);
    expect(guestProviderModelIds(views, 'gone', 'claude-code')).toEqual([]);
  });
});

let root: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-ra-access-')));
});

afterEach(() => {
  resetGuestProviderRoutesForTest();
  fs.rmSync(root, { recursive: true, force: true });
});

// Unit regression for review 4328468761 / provider-groups §4, sharing §12.
// The host tests stubbed this production binder and missed that relay controllers
// have no direct-share member. Minimum: an authorized same-account controller
// binding a guest-isolated task. Verify the real proxy grant, including revocation.
describe('guest proxy binding for direct shares and same-account group relays', () => {
  // Regression companion to RemoteModelAccessDialog: one visible GPT row grants
  // both exact IDs. Existing binder tests only covered Claude with unprefixed IDs.
  // Unit: switching to Pi must retain its bridge ID and still enforce revocation.
  it('keeps the exact GPT route for Codex, Pi and Claude Code after a grouped grant', async () => {
    const rootId = 'gpt-6.1-sol';
    const bridgeId = 'chatgpt/gpt-6.1-sol';
    const grants = new Set([rootId, bridgeId]);
    const provider: ProviderView = {
      ...view('openai', [bridgeId]),
      auth: { method: 'oauth' },
      agents: ['codex', 'pi', 'claude-code'],
      models: {
        codex: [{ id: rootId, name: 'GPT-6.1-Sol', contextWindow: 200_000, efforts: [], defaultEffort: null }],
        pi: [{ id: bridgeId, name: 'GPT-6.1-Sol', contextWindow: 200_000, efforts: [], defaultEffort: null }],
        'claude-code': [{ id: bridgeId, name: 'GPT-6.1-Sol', contextWindow: 200_000, efforts: [], defaultEffort: null }],
      },
    };
    const binder = createGuestProviderRouteBinder({
      readProviders: async () => [provider],
      guestAccess: () => ({ providerId: 'openai', memberId: 'alice' }),
      ownerAllowed: () => true, providerAllowed: () => true,
      modelAccess: {
        allows: (_providerId, model) => grants.has(model),
        read: () => ({ models: [...grants], providerModels: [...grants] }),
      },
    });
    for (const kind of ['codex', 'pi', 'claude-code'] as const) {
      const id = kind === 'codex' ? rootId : bridgeId;
      const binding = await binder({ kind, hostSessionId: `gpt-${kind}`, sessionId: `gpt-task-${kind}`, providerId: 'openai',
        controller: providerShareGuestPeer('share', 'alice', 'phone'), isCurrent: () => true });
      expect(binding?.modelIds).toEqual([id]);
      expect(await binding?.allowsModel?.(id)).toBe(true);
      grants.delete(id);
      expect(await binding?.allowsModel?.(id)).toBe(false);
      grants.add(id);
      binding?.release();
    }
  });
  // Unit integration: native receipt metering zeroes terminal counters. A
  // delegated M must retain turn metering until its receipts can reach O.
  it.each([false, true])('keeps the native usage owner correct for delegated=%s', async delegated => {
    const provider = { ...view('openai', []), auth: { method: 'oauth', native: 'codex' },
      models: { codex: [{ id: 'gpt', name: 'gpt', efforts: [], defaultEffort: null }] } } as unknown as ProviderView;
    const record = vi.fn();
    const binder = createGuestProviderRouteBinder({
      readProviders: async () => [provider], recordRequestUsage: record,
      receiptMeteringAllowed: () => !delegated,
      guestAccess: () => ({ providerId: 'openai', memberId: 'alice' }),
      ownerAllowed: () => true, providerAllowed: () => true,
      modelAccess: { allows: () => true, read: () => ({ models: null, providerModels: null }) },
    });
    const route = await binder({ kind: 'codex', hostSessionId: 'metered-host', sessionId: 'metered-task',
      providerId: 'openai', controller: providerShareGuestPeer('share', 'alice', 'phone'), isCurrent: () => true });
    expect(route?.receiptMetering).toBe(!delegated);
    expect(typeof captureGuestRequestUsage('metered-host', 'gpt')).toBe(delegated ? 'undefined' : 'function');
    route?.release();
  });

  it('enforces a changed member budget on the next request and exempts same-account callers', async () => {
    let blocked = true;
    const checks: Array<string | undefined> = [];
    const binder = createGuestProviderRouteBinder({
      readProviders: async () => [view('spark', ['opus', 'sonnet'])],
      guestAccess: () => ({ providerId: 'spark', memberId: 'alice' }), ownerAllowed: () => true, providerAllowed: () => true,
      modelAccess: { allows: () => true, read: () => ({ models: null, providerModels: null, memberBudget: { enabled: true, rules: [{}] } }) },
      memberBudgetAllows: async (_provider, model, member) => { checks.push(member); return !member || !blocked || model === 'sonnet'; },
    });
    const guest = await binder({ kind: 'claude-code', hostSessionId: 'guest-budget', sessionId: 'guest-task', providerId: 'spark', controller: providerShareGuestPeer('share', 'alice', 'phone'), isCurrent: () => true });
    const owner = await binder({ kind: 'claude-code', hostSessionId: 'owner-budget', sessionId: 'owner-task', providerId: 'spark', controller: 'owner-device', isCurrent: () => true });
    expect(guest!.modelIds).toEqual(['opus', 'sonnet']);
    blocked = false;
    checks.length = 0;
    expect(await guest!.allowsModel!('opus')).toBe(true);
    blocked = true;
    expect(await guest!.allowsModel!('opus')).toBe(false);
    expect(await guest!.allowsModel!('sonnet')).toBe(true);
    expect(await owner!.allowsModel!('opus')).toBe(true);
    expect(checks).toEqual(['alice', 'alice', 'alice', undefined]);
  });

  // Provider groups may route concurrent tasks from one guest device to two
  // local providers on the same M. The real proxy binding must use the task ID (unit tier).
  it('pins each concurrent delegated task to its own local provider and model', async () => {
    const peer = providerShareGuestPeer('share-1', 'member-1', 'guest-device');
    const taskProviders = new Map([['task-spark', 'spark'], ['task-xd', 'xd']]);
    const binder = createGuestProviderRouteBinder({
      readProviders: async () => [view('spark', ['opus']), view('xd', ['haiku'])],
      guestAccess: (_controller, sessionId) => {
        const providerId = taskProviders.get(sessionId);
        return providerId ? { providerId, memberId: 'member-1' } : null;
      },
      ownerAllowed: () => true, providerAllowed: () => true,
      modelAllowed: (_controller, model, sessionId) =>
        (sessionId === 'task-spark' && model === 'opus') || (sessionId === 'task-xd' && model === 'haiku'),
      modelRestricted: () => true,
      modelAccess: { allows: () => true, read: () => ({ models: null, providerModels: null }) },
    });
    const base = { kind: 'claude-code' as const, controller: peer, isCurrent: () => true };
    const spark = await binder({ ...base, sessionId: 'task-spark', hostSessionId: 'host-spark', providerId: 'spark' });
    const xd = await binder({ ...base, sessionId: 'task-xd', hostSessionId: 'host-xd', providerId: 'xd' });
    expect(spark).not.toBeNull();
    expect(xd).not.toBeNull();
    expect(await spark!.allowsModel?.('opus')).toBe(true);
    expect(await spark!.allowsModel?.('haiku')).toBe(false);
    expect(await xd!.allowsModel?.('haiku')).toBe(true);
    expect(await xd!.allowsModel?.('opus')).toBe(false);
    expect(await binder({ ...base, sessionId: 'task-spark', hostSessionId: 'wrong-source', providerId: 'xd' }))
      .toBeNull();
    taskProviders.set('task-spark', 'xd');
    expect(await spark!.allowsModel?.('opus')).toBe(false);
    expect(await xd!.allowsModel?.('haiku')).toBe(true);
    spark!.release();
    xd!.release();
  });

  it('lists future switch models while the delegated task executes only its currently granted model', async () => {
    const peer = providerShareGuestPeer('share-1', 'member-1', 'guest-device');
    let grantedModel = 'opus';
    const binder = createGuestProviderRouteBinder({
      readProviders: async () => [view('spark', ['opus', 'sonnet'])],
      guestAccess: () => ({ providerId: 'spark', memberId: 'member-1' }),
      ownerAllowed: () => true, providerAllowed: () => true,
      modelAllowed: (_controller, model, sessionId) => sessionId === 'task-1' && model === grantedModel,
      modelRestricted: () => true,
      modelAccess: { allows: () => true, read: () => ({ models: ['opus', 'sonnet'], providerModels: ['opus', 'sonnet'] }) },
    });
    const binding = await binder({ kind: 'claude-code', hostSessionId: 'host-task-1', sessionId: 'task-1',
      providerId: 'spark', controller: peer, isCurrent: () => true });
    expect(binding?.modelIds).toEqual(['opus', 'sonnet']);
    expect(await binding?.allowsModel?.('opus')).toBe(true);
    expect(await binding?.allowsModel?.('sonnet')).toBe(false);
    grantedModel = 'sonnet';
    expect(await binding?.allowsModel?.('opus')).toBe(false);
    expect(await binding?.allowsModel?.('sonnet')).toBe(true);
    binding?.release();
  });
  // Unit: an async authorization response must not resurrect a replaced binding.
  it('rejects a failed grant query or one arriving after the task binding was released', async () => {
    let finish!: (allowed: boolean) => void;
    let unavailable = true;
    const binder = createGuestProviderRouteBinder({
      readProviders: async () => [view('spark', ['opus', 'sonnet'])],
      guestAccess: () => null, ownerAllowed: () => true, providerAllowed: () => true,
      modelAccess: { allows: () => true, read: () => ({ models: null, providerModels: null }) },
    });
    const binding = await binder({ kind: 'claude-code', hostSessionId: 'late', sessionId: 'source-late', providerId: 'spark', controller: 'owner', isCurrent: () => true,
      relayModelAccess: { models: ['opus'], allows: () => unavailable ? Promise.reject(new Error('link unavailable')) : new Promise(resolve => { finish = resolve; }) } });
    expect(binding!.modelIds).toEqual(['opus']);
    expect(await guestProviderModelAllowed('spark', 'opus', 'late')).toBe(false);
    unavailable = false;
    const request = guestProviderModelAllowed('spark', 'opus', 'late');
    binding!.release();
    finish(true);
    expect(await request).toBe(false);
  });
  it.each(['relay', 'share'])('binds a %s with its live model permissions and an authorized CLI catalog', async (kind) => {
    const controller = kind === 'relay' ? 'owner-device' : providerShareGuestPeer('share-1', 'member-1', 'guest-device');
    let active = true;
    let providerEnabled = true;
    const providerModels = new Set(['opus']);
    const memberModels = new Set(['opus']);
    const binder = createGuestProviderRouteBinder({
      readProviders: async () => [view('spark', ['opus', 'sonnet'])],
      guestAccess: () => kind === 'share' && active ? { providerId: 'spark', memberId: 'member-1' } : null,
      ownerAllowed: () => active,
      providerAllowed: () => providerEnabled,
      modelAccess: {
        allows: (_providerId, model, memberId) => providerModels.has(model) && (!memberId || memberModels.has(model)),
        read: (_providerId, memberId) => ({ models: [...(memberId ? memberModels : providerModels)], providerModels: [...providerModels] }),
      },
    });
    const input = { kind: 'claude-code' as const, hostSessionId: 'bound-guest', sessionId: 'source-guest', providerId: 'spark', controller, isCurrent: () => true };
    const binding = await binder(input);
    expect(binding).not.toBeNull();
    expect(binding!.modelIds).toEqual(['opus']);
    expect(guestProviderRouteForToken(binding!.routeToken)).toEqual({ sessionId: input.hostSessionId, providerId: 'spark' });
    const allows = (model: string) => guestProviderModelAllowed('spark', model, input.hostSessionId);
    expect(await allows('opus')).toBe(true);
    expect(await allows('sonnet')).toBe(false);
    providerModels.add('sonnet');
    expect(await allows('sonnet')).toBe(kind === 'relay');
    memberModels.add('sonnet');
    expect(await allows('sonnet')).toBe(true);
    providerEnabled = false;
    expect(await allows('opus')).toBe(false);
    providerEnabled = true;
    active = false;
    expect(await allows('opus')).toBe(false);
    expect(await binder(input)).toBeNull();
    binding!.release();
    expect(guestProviderRouteForToken(binding!.routeToken)).toBeNull();
  });
});

function recordingHandle(input: HostedStartInput, calls: { sends: number; models: unknown[][] }): AgentSessionHandle {
  // 事件流保持打开到 close，任务才不会在第一次调用前就结束。
  let closed!: () => void;
  const untilClosed = new Promise<void>((resolve) => {
    closed = resolve;
  });
  return {
    id: 'sdk-1',
    agentKind: input.kind,
    model: input.options.model,
    async send() {
      calls.sends += 1;
    },
    async steer() {},
    async abort() {},
    async close() {
      closed();
    },
    async setModel(...args: unknown[]) {
      calls.models.push(args);
    },
    events: () => ({
      async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
        await untilClosed;
      },
    }),
    getUsageSnapshot: () => ({ tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 }),
    setInteractionResolver() {},
  } as unknown as AgentSessionHandle;
}

async function setup(allowed: Set<string>, guest?: { sharedProviderId: string }, modelAllowed: (id: string, model: string) => boolean = () => true) {
  const project = path.join(root, 'proj');
  fs.mkdirSync(project, { recursive: true });
  const inputs: HostedStartInput[] = [];
  const calls = { sends: 0, models: [] as unknown[][] };
  const binds: Array<{ hostSessionId: string; providerId: string }> = [];
  const releases = { count: 0 };
  const views = guest ? [view('xd', ['opus', 'haiku']), view('spark', ['opus', 'sonnet'])] : [view('xd', ['opus']), view('spark', ['opus'])];
  const host = createRemoteAgentHost({
    isAgentAvailable: () => true,
    startHosted: async (input) => {
      inputs.push(input);
      return recordingHandle(input, calls);
    },
    isControllerAuthorized: () => true,
    ...(guest ? { controllerTrust: () => 'guest' as const } : {}),
    providerAccess: {
      resolve: async (kind, model, providerId) => guest
        ? resolveGuestProviderId(views, guest.sharedProviderId, (id) => allowed.has(id) && modelAllowed(id, model), kind, model, providerId)
        : resolveSharedProviderId(views, (id) => allowed.has(id) && modelAllowed(id, model), kind, model, providerId),
      isAllowed: (id, _controller, model) => allowed.has(id) && modelAllowed(id, model ?? ''),
    },
    ...(guest ? {
      bindGuestProviderRoute: async ({ hostSessionId, providerId }: { hostSessionId: string; providerId: string }) => {
        binds.push({ hostSessionId, providerId });
        return { routeToken: 'route-token', modelIds: ['opus', 'sonnet'], release: () => { releases.count += 1; } };
      },
    } : {}),
    captureOwner: () => 'owner',
    isOwnerCurrent: () => true,
    runsRoot: path.join(root, 'host'),
  });
  const start = (providerId: string | null, model = 'opus') => startRemoteAgentSession('claude-code', {
    sessionId: `task-${randomUUID()}`,
    workingDir: project,
    model,
    providerId,
    permissionMode: 'default',
  }, {
    invoke: async (args) => JSON.parse(JSON.stringify(await host.handle('controller-1', JSON.parse(JSON.stringify(args[0]))) ?? null)),
    rgPath: RG,
    prepareMcp: async () => ({ servers: new Map(), dispose() {} }),
    collectProjectFiles: async () => [],
    isGitRepo: async () => false,
    newId: randomUUID,
  });
  return { host, inputs, calls, binds, releases, start };
}

describe('remote agent provider access on the computer running the agent', () => {
  it('refuses to start on a provider that is not opened for remote use', async () => {
    const { host, inputs, start } = await setup(new Set(['spark']));
    await expect(start('xd')).rejects.toThrow('REMOTE_AGENT_PROVIDER_NOT_ALLOWED');
    expect(inputs).toHaveLength(0);
    host.dispose();
  });

  it('starts with the opened provider made explicit, even when the other computer sent none', async () => {
    const { host, inputs, start } = await setup(new Set(['spark']));
    const handle = await start(null);
    expect(inputs[0]?.options.providerId).toBe('spark');
    await handle.close({ reason: 'navigation' });
    host.dispose();
  });

  it('checks a source switch and stops new turns once the provider is closed again', async () => {
    const allowed = new Set(['spark']);
    const { host, calls, start } = await setup(allowed);
    const handle = await start('spark');
    await expect(handle.setModel!('opus', { providerId: 'xd' })).rejects.toThrow('REMOTE_AGENT_PROVIDER_NOT_ALLOWED');
    await handle.setModel!('opus', { providerId: null });
    expect(calls.models.at(-1)?.[1]).toMatchObject({ providerId: 'spark' });

    await handle.send({ content: [{ type: 'text', text: 'hi' }] } as never);
    expect(calls.sends).toBe(1);
    allowed.delete('spark');
    await expect(handle.send({ content: [{ type: 'text', text: 'again' }] } as never)).rejects.toThrow('REMOTE_AGENT_PROVIDER_NOT_ALLOWED');
    expect(calls.sends).toBe(1);
    await handle.close({ reason: 'navigation' });
    host.dispose();
  });

  it('leaves a same-account model-only switch untouched', async () => {
    const { host, calls, start } = await setup(new Set(['spark']));
    const handle = await start('spark');
    await handle.setModel!('opus');
    // 不带来源的换模型仍原样到达 Agent；现在也会复核远程型号范围。
    expect(calls.models.at(-1)).toEqual(['opus', null]);
    await handle.close({ reason: 'navigation' });
    host.dispose();
  });
});

describe('shared-provider guest models on the computer running the agent', () => {
  const guest = { sharedProviderId: 'spark' };

  it('refuses to start a guest on a model the shared provider does not offer', async () => {
    const { host, inputs, binds, start } = await setup(new Set(['spark', 'xd']), guest);
    // haiku 只有本机的 xd 提供：不能借它用到本机的其它供应商。
    await expect(start(null, 'haiku')).rejects.toThrow('REMOTE_AGENT_PROVIDER_NOT_ALLOWED');
    await expect(start('xd', 'opus')).rejects.toThrow('REMOTE_AGENT_PROVIDER_NOT_ALLOWED');
    expect(inputs).toHaveLength(0);
    expect(binds).toHaveLength(0);
    host.dispose();
  });

  it('binds the guest to the shared provider and checks every model switch', async () => {
    const { host, inputs, calls, binds, releases, start } = await setup(new Set(['spark', 'xd']), guest);
    const handle = await start(null, 'opus');
    expect(inputs[0]?.options.providerId).toBe('spark');
    expect(inputs[0]?.guestProvider).toEqual({ providerId: 'spark', modelIds: ['opus', 'sonnet'], routeToken: 'route-token' });
    expect(binds).toEqual([{ hostSessionId: inputs[0]!.hostSessionId, providerId: 'spark' }]);

    // 只换模型(没带来源)也核对，并显式钉在分享的供应商上。
    await expect(handle.setModel!('haiku')).rejects.toThrow('REMOTE_AGENT_PROVIDER_NOT_ALLOWED');
    await expect(handle.setModel!('opus', { providerId: 'xd' })).rejects.toThrow('REMOTE_AGENT_PROVIDER_NOT_ALLOWED');
    await handle.setModel!('sonnet');
    expect(calls.models).toEqual([['sonnet', { providerId: 'spark' }]]);

    await handle.close({ reason: 'navigation' });
    await vi.waitFor(() => expect(releases.count).toBe(1));
    host.dispose();
  });
});

/* 用户要求的型号授权此前只有目录隐藏；最小输入为允许一个型号，随后撤回。
 * 经生产 startRemoteAgentSession → host 协议验证创建、无来源切模型、发消息与插话；沿用本文件 unit fixture。 */
describe.each([false, true])('remote model access, shared guest=%s', (guest) => {
  it('blocks a model on start, a model-only switch, and sends after access is revoked', async () => {
    const models = new Set(['opus']);
    const { host, calls, inputs, start } = await setup(new Set(['spark']), guest ? { sharedProviderId: 'spark' } : undefined, (_id, model) => models.has(model));
    try {
      await expect(start('spark', 'sonnet')).rejects.toThrow('REMOTE_AGENT_PROVIDER_NOT_ALLOWED');
      expect(inputs).toHaveLength(0);
      const handle = await start('spark', 'opus');
      await expect(handle.setModel!('sonnet')).rejects.toThrow('REMOTE_AGENT_PROVIDER_NOT_ALLOWED');
      expect(calls.models).toHaveLength(0);
      await handle.send({ content: [{ type: 'text', text: 'allowed' }] } as never);
      models.clear();
      await expect(handle.send({ content: [{ type: 'text', text: 'blocked' }] } as never)).rejects.toThrow('REMOTE_AGENT_PROVIDER_NOT_ALLOWED');
      await expect(handle.steer!({ content: [{ type: 'text', text: 'blocked' }] } as never)).rejects.toThrow('REMOTE_AGENT_PROVIDER_NOT_ALLOWED');
      expect(calls.sends).toBe(1);
      await handle.close({ reason: 'navigation' });
    } finally { host.dispose(); }
  });
});
