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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startRemoteAgentSession } from '../controller/startRemote';
import { guestProviderModelIds, resolveGuestProviderId, resolveSharedProviderId } from '../host/providerAccess';
import { createRemoteAgentHost, type HostedStartInput } from '../host/runHost';

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
  fs.rmSync(root, { recursive: true, force: true });
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

async function setup(allowed: Set<string>, guest?: { sharedProviderId: string }) {
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
        ? resolveGuestProviderId(views, guest.sharedProviderId, (id) => allowed.has(id), kind, model, providerId)
        : resolveSharedProviderId(views, (id) => allowed.has(id), kind, model, providerId),
      isAllowed: (id) => allowed.has(id),
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
    // 不带来源的换模型原样到达 Agent(沿用当前来源)，不经授权核对。
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
