import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSettingsManagement, type ManagementExecution } from '../management.js';
import { registerCloudDomainCall, registerCloudImCall } from '../managementCalls.js';
import { listPersonalBotManagement } from '../managementConnections.js';
import {
  configureCloudMcpCredentials,
  configureCloudMemoryManagement,
  listMcpManagement,
  listMemoryManagement,
} from '../managementData.js';

// The call table fills only on a managed cloud instance.
vi.mock('../../instance-runtime/config.js', () => ({ getInstanceConfig: () => ({}) }));

const caller = { key: 'fixture-owner-browser', assertCurrent() {} };
const execution: ManagementExecution = {
  signal: new AbortController().signal,
  assertCurrent() {},
  prompt() {},
  onCancel() {},
};
describe('cloud bot forms use native domain services', () => {
  it('keeps saved secrets out of the page and respects region visibility', async () => {
    registerCloudImCall('feishuBot:get-state', () => ({
      status: 'connected',
      appId: 'example-app',
      appSecret: 'NEVER-PROJECT',
      service: 'feishu',
    }));
    registerCloudImCall('feishuBot:save', () => ({ verdict: 'connected' }));
    const entries = await listPersonalBotManagement(caller, (id) => id === 'feishu', false);
    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries)).not.toContain('NEVER-PROJECT');
    expect(
      entries[0]!.actions[0]!.fields!.find((field) => field.name === 'service')!.options,
    ).toEqual([{ value: 'feishu', label: 'Feishu' }]);
    expect(
      entries[0]!.actions[0]!.fields!.find((field) => field.name === 'appSecret'),
    ).not.toHaveProperty('value');
  });
  it('does not report an existing healthy bot as success when replacement credentials fail', async () => {
    registerCloudImCall('telegramBot:get-status', () => ({
      status: { kind: 'connected' },
      ownerUserId: 'owner',
    }));
    const save = vi.fn(() => ({
      status: { kind: 'connected' },
      saveErrorStatus: { kind: 'error' },
    }));
    registerCloudImCall('telegramBot:set-config', save);
    const [entry] = await listPersonalBotManagement(caller, (id) => id === 'telegram');
    await expect(
      entry!.actions[0]!.run({ token: 'invalid', ownerUserId: 'owner' }, execution),
    ).rejects.toThrow('CONNECTION_FAILED');
    expect(save).toHaveBeenCalledWith({ token: 'invalid', ownerUserId: 'owner' });
  });
  it('rejects a stale bot identity before disconnecting another connection', async () => {
    let appId = 'first';
    const disconnect = vi.fn(() => ({ ok: true }));
    registerCloudImCall('feishuBot:get-state', () => ({
      status: 'connected',
      appId,
      service: 'feishu',
    }));
    registerCloudImCall('feishuBot:clear', disconnect);
    const [entry] = await listPersonalBotManagement(caller, (id) => id === 'feishu');
    appId = 'second';
    await expect(
      entry!.actions.find((action) => action.intent === 'disconnect')!.run({}, execution),
    ).rejects.toThrow('CHANGED');
    expect(disconnect).not.toHaveBeenCalled();
  });
});
describe('cloud data management uses isolated domain fixtures', () => {
  let servers: Array<{
      id: string;
      name: string;
      transport: 'http';
      url: string;
      headers: Record<string, string>;
    }>,
    tokens: Map<string, string>;
  beforeEach(() => {
    servers = [
      {
        id: 'example',
        name: 'Example',
        transport: 'http',
        url: 'https://mcp.example.invalid',
        headers: {},
      },
    ];
    tokens = new Map([['example', 'SECRET-NOT-RETURNED']]);
    configureCloudMcpCredentials({
      has: (id) => tokens.has(id),
      set: (id, value) => {
        tokens.set(id, value);
      },
      remove: (id) => {
        tokens.delete(id);
      },
    });
    registerCloudDomainCall('maker:mcp:custom:list', () => ({ servers: structuredClone(servers) }));
    registerCloudDomainCall('maker:mcp:custom:create', (input) => {
      servers.push(input as (typeof servers)[number]);
      return { ok: true };
    });
    registerCloudDomainCall('maker:mcp:custom:update', (input) => {
      servers = servers.map((item) =>
        item.id === (input as (typeof servers)[number]).id
          ? (input as (typeof servers)[number])
          : item,
      );
      return { ok: true };
    });
    registerCloudDomainCall('maker:mcp:custom:delete', (id) => {
      servers = servers.filter((item) => item.id !== id);
      return { ok: true };
    });
    registerCloudDomainCall('maker:mcp:custom:refresh', () => ({ ok: true }));
  });
  it('creates, edits and deletes MCP configuration without credential readback', async () => {
    let entries = await listMcpManagement(caller);
    expect(JSON.stringify(entries)).not.toContain('SECRET-NOT-RETURNED');
    await entries[0]!.actions[0]!.run(
      { name: 'New', url: 'https://new.example.invalid', transport: 'http' },
      execution,
    );
    expect(servers).toHaveLength(2);
    entries = await listMcpManagement(caller);
    const item = entries.find((item) => item.label === 'New')!;
    await item.actions
      .find((action) => action.intent === 'edit')!
      .run({ name: 'Edited', url: 'https://new.example.invalid', transport: 'http' }, execution);
    expect(servers.find((item) => item.name === 'Edited')).toBeDefined();
    entries = await listMcpManagement(caller);
    await entries
      .find((item) => item.label === 'Edited')!
      .actions.find((action) => action.intent === 'delete')!
      .run({}, execution);
    expect(servers.map((item) => item.id)).toEqual(['example']);
    expect(tokens.get('example')).toBe('SECRET-NOT-RETURNED');
  });
  it('edits a name without projecting or replacing a private MCP URL', async () => {
    servers[0]!.url = 'https://mcp.example.invalid/path?token=PRIVATE-URL-CREDENTIAL';
    const entry = (await listMcpManagement(caller)).find((item) => item.label === 'Example')!;
    expect(JSON.stringify(entry)).not.toContain('PRIVATE-URL-CREDENTIAL');
    const edit = entry.actions.find((action) => action.intent === 'edit')!;
    expect(edit.fields!.find((field) => field.name === 'url')).toMatchObject({
      value: '',
      required: false,
    });
    await edit.run({ name: 'Renamed', url: '', transport: 'http' }, execution);
    expect(servers[0]).toMatchObject({
      name: 'Renamed',
      url: 'https://mcp.example.invalid/path?token=PRIVATE-URL-CREDENTIAL',
    });
    expect(tokens.get('example')).toBe('SECRET-NOT-RETURNED');
  });
  it('requires clearing credentials before changing an MCP destination', async () => {
    let entries = await listMcpManagement(caller),
      entry = entries.find((item) => item.label === 'Example')!;
    await expect(
      entry.actions
        .find((action) => action.intent === 'edit')!
        .run(
          { name: 'Example', url: 'https://other.example.invalid', transport: 'http' },
          execution,
        ),
    ).rejects.toThrow('CLEAR_CREDENTIALS_FIRST');
    expect(servers[0]!.url).toBe('https://mcp.example.invalid');
    await entry.actions.find((action) => action.intent === 'disconnect')!.run({}, execution);
    entries = await listMcpManagement(caller);
    entry = entries.find((item) => item.label === 'Example')!;
    await entry.actions
      .find((action) => action.intent === 'edit')!
      .run({ name: 'Example', url: 'https://other.example.invalid', transport: 'http' }, execution);
    expect(servers[0]!.url).toBe('https://other.example.invalid');
    expect(tokens.size).toBe(0);
  });
  it('does not overwrite a newer MCP configuration using stale action fields', async () => {
    const entry = (await listMcpManagement(caller)).find((item) => item.label === 'Example')!;
    servers[0]!.name = 'Changed natively';
    await expect(
      entry.actions.find((action) => action.intent === 'delete')!.run({}, execution),
    ).rejects.toThrow('CHANGED');
    expect(servers[0]!.name).toBe('Changed natively');
  });
  it('lists memory actions without clearing any data, then clears only the selected native channel', async () => {
    const resetAll = vi.fn(async () => ({ removedCount: 2 })),
      resetAgentMemory = vi.fn(async () => ({ removedEntries: 1 }));
    configureCloudMemoryManagement({
      listAvailableAgents: () => ['claude-code', 'codex'],
      getAgentMemoryStatus: async () => ({ enabled: true, source: 'host-runtime' }),
      resetAgentMemory,
      makerMemory: { resetAll } as never,
    });
    const entries = await listMemoryManagement(caller);
    expect(resetAll).not.toHaveBeenCalled();
    expect(resetAgentMemory).not.toHaveBeenCalled();
    const manager = createSettingsManagement({ list: async () => entries });
    const page = await manager.execute(caller, { operation: 'list', section: 'memory' });
    expect(page.kind).toBe('page');
    expect(entries.every((item) => item.actions[0]!.confirmation)).toBe(true);
    await entries.find((item) => item.label === 'Codex')!.actions[0]!.run({}, execution);
    expect(resetAgentMemory).toHaveBeenCalledWith('codex');
    expect(resetAll).not.toHaveBeenCalled();
    manager.stop();
  });
});
