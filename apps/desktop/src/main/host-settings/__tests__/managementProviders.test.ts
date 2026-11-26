import { describe, expect, it, vi } from 'vitest';
vi.mock('../../maker-host/custom-provider-store.js', () => ({ getCustomProvider: vi.fn() }));
import { listProviderManagement } from '../managementProviders.js';
import { registerCloudDomainCall } from '../managementCalls.js';
import type { ManagementExecution } from '../management.js';
import { setProviderSetup, type ProviderSetup } from '../../instance-runtime/providerSetup.js';

// The call table fills only on a managed cloud instance.
vi.mock('../../instance-runtime/config.js', () => ({ getInstanceConfig: () => ({}) }));

describe('provider management', () => {
  it('uses the official Claude CLI and offers no independent Claude login', async () => {
    registerCloudDomainCall('maker:provider:list', () => ({ providers: [
      { id: 'anthropic', name: 'Claude', source: 'builtin', connected: false, auth: { method: 'oauth' } },
      { id: 'custom:old', name: 'Old Claude', source: 'user', connected: false, auth: { method: 'oauth', native: 'claude' } },
      { id: 'openai', name: 'OpenAI', source: 'builtin', connected: false, auth: { method: 'oauth' } },
    ] }));
    registerCloudDomainCall('maker:provider:presets', () => ({ presets: [] }));
    const login = vi.fn(() => ({ ok: true })), create = vi.fn();
    registerCloudDomainCall('maker:claude-oauth:login', login);
    registerCloudDomainCall('maker:provider:custom:create', create);
    const entries = await listProviderManagement({ key: 'fixture', assertCurrent() {} });
    expect(entries.find(e => e.id === 'add:anthropic')).toBeUndefined();
    expect(entries.find(e => e.id === 'add:openai')).toBeDefined();
    const old = entries.find(e => e.label === 'Old Claude')!;
    expect(old.actions.map(a => a.intent)).toEqual(['delete']);
    const execution: ManagementExecution = { signal: new AbortController().signal, assertCurrent() {}, onCancel() {}, prompt() {} };
    await entries.find(e => e.id === 'provider:anthropic')!.actions.find(a => a.intent === 'authorize')!.run({}, execution);
    expect(login).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
  });
});

describe('cloud provider setup ticket', () => {
  it('is listed only on a managed instance and applies its stage for the current owner', async () => {
    registerCloudDomainCall('maker:provider:list', () => ({ providers: [] }));
    registerCloudDomainCall('maker:provider:presets', () => ({ presets: [] }));
    const caller = { key: 'fixture', assertCurrent() {} };
    expect((await listProviderManagement(caller)).some((e) => e.id === 'setup:apply')).toBe(false);
    const apply = vi.fn(async () => undefined);
    setProviderSetup({ setup: { apply } as unknown as ProviderSetup, owner: () => 'owner-1:7' });
    try {
      const item = (await listProviderManagement(caller)).find((e) => e.id === 'setup:apply')!;
      const action = item.actions[0]!;
      expect(action.fields?.map((field) => [field.name, field.kind, field.required])).toEqual([
        ['stage', 'text', true],
        ['secrets', 'password', false],
      ]);
      const execution: ManagementExecution = { signal: new AbortController().signal, assertCurrent() {}, onCancel() {}, prompt() {} };
      await action.run({ stage: 'stage-1', secrets: '{"apiKey":"k"}' }, execution);
      expect(apply).toHaveBeenCalledWith('owner-1:7', 'stage-1', '{"apiKey":"k"}', execution);
    } finally {
      setProviderSetup(null);
    }
  });
});
