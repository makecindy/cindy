/**
 * Unit, what the new computer writes after the keys/SSH step
 * (docs/product-rules/new-device-setup-migration.md §2, §3 invariants 1, 4, 7). Production entry:
 * `applySetupPlan` with its real plan from `buildSetupPlan`; only the stores are fakes. New step:
 * no existing coverage. Minimal inputs: one API-key provider, one built-in key already here, one
 * plugin key, two SSH servers of which one is refused.
 */
import { describe, expect, it, vi } from 'vitest';

import type { SetupTransferApplyDeps } from '../transferApply.js';
import { applySetupPlan, type SetupApplyDeps } from '../apply.js';
import { buildSetupPlan } from '../plan.js';
import { planInputs, plugin, snapshot } from './fixtures.js';

const source = snapshot({
  transfer: 1,
  providers: [{ id: 'or', name: 'OpenRouter', auth: 'apiKey', config: { id: 'or', runtimes: {} } }],
  plugins: [plugin({ ghostId: 'gmail', setupReady: true })],
  hints: { builtinKeys: ['brave', 'tavily'], imChannels: [], sshHostCount: 2 },
  sshHosts: [
    { id: 'web', displayName: 'Web', hostname: 'web.example.com', port: 22, user: 'deploy', hostKey: null },
    { id: 'db', displayName: 'DB', hostname: '10.0.0.5', port: 22, user: 'root', hostKey: null },
  ],
});

function setup(transfer: Partial<SetupTransferApplyDeps> = {}) {
  const plan = buildSetupPlan(
    planInputs({
      snapshot: source,
      ghosts: [{ ghostId: 'gmail', namespace: null, instanceKey: '_root__gmail', enabled: true, builtin: false }],
      builtinKeys: new Set(['tavily']),
    }),
  );
  const writes: string[] = [];
  const deps: SetupTransferApplyDeps = {
    transfer: vi.fn<SetupTransferApplyDeps['transfer']>(async ({ onCode }) => {
      onCode('123456');
      return {
        secrets: {
          providers: [{ id: 'or', config: { id: 'or', runtimes: {} }, keys: { codex: 'sk-test-only' } }],
          mcpServers: [],
          builtinKeys: [{ id: 'brave', value: 'BSA-test' }],
          plugins: [{ ghostId: 'gmail', namespace: null, secrets: { api_key: 'k-test' } }],
        },
        ssh: [
          { host: 'web', outcome: 'added' as const },
          { host: 'db', outcome: 'failed' as const, code: 'SSH_CONNECT_FAILED' },
        ],
      };
    }),
    createProvider: vi.fn(async (config, keys) => {
      writes.push(`provider:${String(config.id)}:${Object.keys(keys).join(',')}`);
      return 'done' as const;
    }),
    createMcpServer: vi.fn(),
    hasBuiltinKey: (id) => id === 'tavily',
    storeBuiltinKey: vi.fn((id: string) => {
      writes.push(`builtin:${id}`);
      return true;
    }),
    pluginInstanceKey: (ghostId) => (ghostId === 'gmail' ? '_root__gmail' : null),
    storePluginSecrets: vi.fn((instanceKey: string, values: Record<string, string>) => {
      writes.push(`plugin:${instanceKey}:${Object.keys(values).join(',')}`);
      return 1;
    }),
    generateSshKey: vi.fn(async () => ({ privateKeyPath: '/home/new/.ssh/cindy', publicKey: 'ssh-ed25519 AAAA new' })),
    addSshHost: vi.fn(async (host, identityFile) => {
      writes.push(`ssh:${host.id}:${identityFile}`);
      return { outcome: 'done' as const };
    }),
    ...transfer,
  };
  const applyDeps = {
    marketNames: async () => new Set<string>(),
    addMarketSource: vi.fn(),
    pluginDetail: vi.fn(),
    installPlugin: vi.fn(),
    findGhost: () => null,
    setPluginEnabled: vi.fn(),
    windowPrompt: vi.fn(),
    installSkill: vi.fn(),
    setSkillEnabled: vi.fn(),
    findSkill: vi.fn(),
    settingsGroup: () => null,
    pluginSetupMissing: () => null,
    assertCurrent: () => {},
    transfer: deps,
  } as unknown as SetupApplyDeps;
  return { plan, deps, applyDeps, writes };
}

describe('setup keys and SSH step', () => {
  it('writes copied keys through this computer, keeps its own, and checks every server', async () => {
    const { plan, deps, applyDeps, writes } = setup();
    expect(plan.secrets?.items.map((item) => `${item.kind}:${item.ref}`)).toEqual([
      'provider:or',
      'builtin:brave',
      'plugin:plugin:_root:gmail',
    ]);
    const codes: string[] = [];
    const result = await applySetupPlan(
      {
        plan,
        snapshot: source,
        keys: new Set(['provider:or', 'secrets', 'ssh:web', 'ssh:db']),
        approvedPluginKeys: new Set(),
        emit: (progress) => {
          if (progress.confirmCode) codes.push(progress.confirmCode);
        },
      },
      applyDeps,
    );
    // Asked once, for keys and both servers, with this computer's new public key.
    expect(deps.transfer).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.transfer).mock.calls[0][0]).toMatchObject({
      secrets: { providers: ['or'], builtinKeys: ['brave'], plugins: [{ ghostId: 'gmail', namespace: null }] },
      ssh: { publicKey: 'ssh-ed25519 AAAA new', hosts: ['web', 'db'] },
    });
    expect(codes).toEqual(['123456']);
    expect(writes).toEqual([
      'provider:or:codex',
      'builtin:brave',
      'plugin:_root__gmail:api_key',
      'ssh:web:/home/new/.ssh/cindy',
    ]);
    // The window must not create the provider a second time without its key.
    expect(result.handledKeys).toEqual(['provider:or']);
    expect(result.results).toEqual(
      expect.arrayContaining([
        { key: 'secrets', outcome: 'done' },
        { key: 'provider:or', outcome: 'done' },
        { key: 'ssh:web', outcome: 'done' },
        { key: 'ssh:db', outcome: 'failed', code: 'SSH_CONNECT_FAILED' },
      ]),
    );
    expect(result.checklist.filter((item) => item.kind === 'ssh-host')).toEqual([
      { id: 'ssh-host:db', kind: 'ssh-host', label: 'DB', ref: 'db' },
    ]);
  });

  it('leaves everything to the ordinary steps when the other computer says no', async () => {
    const { plan, applyDeps, writes } = setup({
      transfer: vi.fn<SetupTransferApplyDeps['transfer']>(async () => {
        throw new Error('SETUP_TRANSFER_DECLINED');
      }),
    });
    const result = await applySetupPlan(
      { plan, snapshot: source, keys: new Set(['provider:or', 'secrets', 'ssh:web']), approvedPluginKeys: new Set(), emit: () => {} },
      applyDeps,
    );
    expect(writes).toEqual([]);
    expect(result.handledKeys).toEqual([]);
    expect(result.results).toEqual([
      { key: 'secrets', outcome: 'failed', code: 'SETUP_TRANSFER_DECLINED' },
      { key: 'ssh:web', outcome: 'failed', code: 'SETUP_TRANSFER_DECLINED' },
    ]);
    expect(result.checklist.map((item) => item.id)).toEqual(
      expect.arrayContaining(['provider-key:or', 'builtin-key:brave', 'ssh-host:web']),
    );
  });
});
