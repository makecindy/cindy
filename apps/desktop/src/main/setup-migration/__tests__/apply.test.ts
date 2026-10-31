import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createOverrideSettingsFile, portableOverrideSettings } from '../../maker-host/override-settings-file.js';
import type { GhostManifest } from '../../../shared/ghost.js';
import type { GhostInstallConsentRequest } from '../../../shared/ghostInstallConsent.js';
import type { SetupMigrationProgress } from '../../../shared/setupMigration.js';
import { applySetupPlan, type InstalledGhostRef, type SetupApplyDeps } from '../apply.js';
import { buildSetupPlan } from '../plan.js';
import { installFacts, planInputs, plugin, snapshot } from './fixtures.js';

const manifest = (id: string) => ({ id, name: id, version: '1.0.0' }) as unknown as GhostManifest;

function harness(overrides: Partial<SetupApplyDeps> = {}) {
  const installed = new Map<string, InstalledGhostRef>();
  const prompts: Array<Omit<GhostInstallConsentRequest, 'requestId'>> = [];
  const deps: SetupApplyDeps = {
    marketNames: vi.fn(async () => new Set<string>()),
    addMarketSource: vi.fn(async () => {}),
    pluginDetail: vi.fn(async (pluginId: string) => ({ releaseId: `rel-${pluginId}`, manifest: manifest(pluginId) })),
    installPlugin: vi.fn(async (pluginId, _options, prompt) => {
      const ghostId = pluginId.replace(/^plg_/, '').replace(/^custom:[^/]+\//, '');
      const accepted = await prompt({ initiator: 'user', origin: 'market', facts: installFacts(ghostId) });
      if (!accepted) throw Object.assign(new Error('cancelled'), { code: 'MUTATION_CANCELLED' });
      const ref = { instanceKey: `_root__${ghostId}`, enabled: true, approval: 'approved:1' };
      installed.set(ghostId, ref);
      return ref;
    }),
    findGhost: vi.fn((ghostId: string) => installed.get(ghostId) ?? null),
    setPluginEnabled: vi.fn(async (ghost, enabled) => {
      ghost.enabled = enabled;
    }),
    windowPrompt: vi.fn(async (request) => {
      prompts.push(request);
      return true;
    }),
    installSkill: vi.fn(async (name: string) => ({ absolutePath: `/home/u/.agents/skills/${name}` })),
    setSkillEnabled: vi.fn(async () => {}),
    findSkill: vi.fn(async () => null),
    settingsGroup: vi.fn(() => null),
    pluginSetupMissing: vi.fn(() => null),
    assertCurrent: vi.fn(),
    ...overrides,
  };
  return { deps, installed, prompts };
}

describe('applySetupPlan', () => {
  it('installs confirmed plugins without asking again, and keeps a source-disabled plugin off', async () => {
    const source = snapshot({ plugins: [plugin({ ghostId: 'gmail', enabled: false })] });
    const plan = buildSetupPlan(
      planInputs({
        snapshot: source,
        catalog: new Map([['plg_gmail', { pluginId: 'plg_gmail', releaseId: 'r', version: '1.0.0', consent: installFacts('gmail') }]]),
      }),
    );
    const { deps, installed, prompts } = harness();
    const progress: SetupMigrationProgress[] = [];
    const result = await applySetupPlan(
      { plan, snapshot: source, keys: new Set(['plugin:_root:gmail']), approvedPluginKeys: new Set(['plugin:_root:gmail']), emit: (p) => progress.push(p) },
      deps,
    );
    expect(result.results).toEqual([{ key: 'plugin:_root:gmail', outcome: 'done' }]);
    expect(prompts).toEqual([]);
    expect(installed.get('gmail')?.enabled).toBe(false);
    expect(deps.installPlugin).toHaveBeenCalledWith('plg_gmail', { expectedReleaseId: 'rel-plg_gmail' }, expect.any(Function));
    expect(progress.map((p) => p.phase)).toEqual(['running', 'done']);
  });

  it('falls back to the ordinary confirmation when the real package asks for different permissions', async () => {
    const source = snapshot({ plugins: [plugin({ ghostId: 'gmail' })] });
    const plan = buildSetupPlan(
      planInputs({
        snapshot: source,
        // The user saw permissions for another host than the package will request.
        catalog: new Map([['plg_gmail', { pluginId: 'plg_gmail', releaseId: 'r', version: '1.0.0', consent: installFacts('gmail', 'old') }]]),
      }),
    );
    const { deps, prompts } = harness();
    await applySetupPlan(
      { plan, snapshot: source, keys: new Set([plan.plugins[0].key]), approvedPluginKeys: new Set([plan.plugins[0].key]), emit: () => {} },
      deps,
    );
    expect(prompts).toHaveLength(1);
  });

  it('asks per plugin when the user did not confirm the batch', async () => {
    const source = snapshot({ plugins: [plugin({ ghostId: 'gmail' })] });
    const plan = buildSetupPlan(
      planInputs({
        snapshot: source,
        catalog: new Map([['plg_gmail', { pluginId: 'plg_gmail', releaseId: 'r', version: '1.0.0', consent: installFacts('gmail') }]]),
      }),
    );
    const { deps, prompts } = harness({ windowPrompt: vi.fn(async () => false) });
    const result = await applySetupPlan(
      { plan, snapshot: source, keys: new Set([plan.plugins[0].key]), approvedPluginKeys: new Set(), emit: () => {} },
      deps,
    );
    expect(prompts).toEqual([]);
    expect(deps.windowPrompt).toHaveBeenCalledTimes(1);
    expect(result.results).toEqual([{ key: plan.plugins[0].key, outcome: 'failed', code: 'MUTATION_CANCELLED' }]);
  });

  it('adds a portable custom marketplace before installing from it, and reports a failed one per plugin', async () => {
    const source = snapshot({
      plugins: [
        plugin({ ghostId: 'a', source: 'custom-market', marketName: 'acme', pluginId: 'custom:acme/a' }),
        plugin({ ghostId: 'b', source: 'custom-market', marketName: 'broken', pluginId: 'custom:broken/b' }),
      ],
      marketSources: [
        { name: 'acme', url: 'https://github.com/acme/m.git', ref: null, sparsePaths: [] },
        { name: 'broken', url: 'https://github.com/acme/broken.git', ref: null, sparsePaths: [] },
      ],
    });
    const plan = buildSetupPlan(planInputs({ snapshot: source }));
    const { deps } = harness({
      addMarketSource: vi.fn(async (market) => {
        if (market.name === 'broken') throw Object.assign(new Error('x'), { code: 'GIT_CLONE_FAILED' });
      }),
    });
    const result = await applySetupPlan(
      { plan, snapshot: source, keys: new Set(plan.plugins.map((p) => p.key)), approvedPluginKeys: new Set(), emit: () => {} },
      deps,
    );
    expect(deps.addMarketSource).toHaveBeenCalledTimes(2);
    expect(deps.installPlugin).toHaveBeenCalledWith(
      'custom:acme/a',
      expect.objectContaining({ expectedManifest: expect.anything() }),
      expect.any(Function),
    );
    expect(result.results).toEqual([
      { key: 'plugin:_root:a', outcome: 'done' },
      { key: 'plugin:_root:b', outcome: 'failed', code: 'GIT_CLONE_FAILED' },
    ]);
  });

  it('keeps a value another process changed after the preview, deciding inside the write lock', async () => {
    // Review repro (PR #6473): the preview saw no local value, then another store instance
    // on the same file wrote limit 9; applying must keep it instead of writing the source's 3.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-setup-apply-'));
    try {
      const file = path.join(dir, 'settings.json');
      const open = () =>
        createOverrideSettingsFile<{ limit: number; depth: number }>({
          filePath: () => file,
          defaults: { limit: 1, depth: 1 },
          normalize: (raw) => {
            const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
            return {
              limit: typeof r.limit === 'number' ? r.limit : 1,
              depth: typeof r.depth === 'number' ? r.depth : 1,
            };
          },
          log: { info: vi.fn(), warn: vi.fn() },
          label: 'setup-apply-test',
        });
      const here = portableOverrideSettings(open());
      const source = snapshot({ settings: [{ id: 'collaboration', values: { limit: 3, depth: 2 } }] });
      const plan = buildSetupPlan(
        planInputs({ snapshot: source, settings: [{ id: 'collaboration', customized: here.readCustomized() }] }),
      );
      await open().writePatchAtomic({ limit: 9 });
      const { deps } = harness({ settingsGroup: () => here });
      const result = await applySetupPlan(
        { plan, snapshot: source, keys: new Set(['settings:collaboration']), approvedPluginKeys: new Set(), emit: () => {} },
        deps,
      );
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ limit: 9, depth: 2 });
      expect(result.results).toEqual([{ key: 'settings:collaboration', outcome: 'done' }]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps going after one failure and installs disabled skills as disabled', async () => {
    const source = snapshot({
      skills: [
        { name: 'deploy', version: '1.0.0', catalogScope: 'market', origin: 'installed', enabled: false },
        { name: 'review', version: '1.0.0', catalogScope: 'team', origin: 'installed', enabled: true },
      ],
    });
    const plan = buildSetupPlan(planInputs({ snapshot: source }));
    const { deps } = harness({
      installSkill: vi.fn(async (name: string) => {
        if (name === 'review') throw Object.assign(new Error('x'), { code: 'SKILL_NETWORK' });
        return { absolutePath: `/s/${name}` };
      }),
    });
    const result = await applySetupPlan(
      { plan, snapshot: source, keys: new Set(['skill:deploy', 'skill:review']), approvedPluginKeys: new Set(), emit: () => {} },
      deps,
    );
    expect(deps.setSkillEnabled).toHaveBeenCalledWith('/s/deploy', false);
    expect(result.results).toEqual([
      { key: 'skill:deploy', outcome: 'done' },
      { key: 'skill:review', outcome: 'failed', code: 'SKILL_NETWORK' },
    ]);
  });

  it('copies only the on/off choice of a skill that is already installed here', async () => {
    const source = snapshot({
      skills: [{ name: 'deploy', version: '1.0.0', catalogScope: 'market', origin: 'installed', enabled: false }],
    });
    const plan = buildSetupPlan(
      planInputs({ snapshot: source, localSkills: new Map([['deploy', { enabled: true }]]) }),
    );
    expect(plan.skills[0].state).toBe('ready');
    const { deps } = harness({ findSkill: vi.fn(async () => ({ absolutePath: '/s/deploy', enabled: true })) });
    const result = await applySetupPlan(
      { plan, snapshot: source, keys: new Set(['skill:deploy']), approvedPluginKeys: new Set(), emit: () => {} },
      deps,
    );
    expect(deps.installSkill).not.toHaveBeenCalled();
    expect(deps.setSkillEnabled).toHaveBeenCalledWith('/s/deploy', false);
    expect(result.results).toEqual([{ key: 'skill:deploy', outcome: 'done' }]);
  });

  it('stops writing once the account changes', async () => {
    const source = snapshot({ skills: [{ name: 'deploy', version: null, catalogScope: null, origin: 'installed', enabled: true }] });
    const plan = buildSetupPlan(planInputs({ snapshot: source }));
    const { deps } = harness({
      assertCurrent: () => {
        throw Object.assign(new Error('x'), { code: 'SETUP_PLAN_EXPIRED' });
      },
    });
    const result = await applySetupPlan(
      { plan, snapshot: source, keys: new Set(['skill:deploy']), approvedPluginKeys: new Set(), emit: () => {} },
      deps,
    );
    expect(deps.installSkill).not.toHaveBeenCalled();
    expect(result.results[0]).toEqual({ key: 'skill:deploy', outcome: 'failed', code: 'SETUP_PLAN_EXPIRED' });
  });

  it('lists accounts to reconnect only for plugins that were set up on the other computer', async () => {
    const source = snapshot({
      plugins: [plugin({ ghostId: 'gmail', setupReady: true }), plugin({ ghostId: 'notes', setupReady: false })],
      providers: [{ id: 'or', name: 'OpenRouter', auth: 'apiKey', config: { id: 'or', runtimes: {} } }],
    });
    const plan = buildSetupPlan(
      planInputs({
        snapshot: source,
        catalog: new Map([
          ['plg_gmail', { pluginId: 'plg_gmail', releaseId: 'r', version: '1.0.0', consent: installFacts('gmail') }],
          ['plg_notes', { pluginId: 'plg_notes', releaseId: 'r', version: '1.0.0', consent: installFacts('notes') }],
        ]),
      }),
    );
    const { deps } = harness({ pluginSetupMissing: () => ['Gmail account'] });
    const result = await applySetupPlan(
      {
        plan,
        snapshot: source,
        keys: new Set(['plugin:_root:gmail', 'plugin:_root:notes']),
        approvedPluginKeys: new Set(['plugin:_root:gmail', 'plugin:_root:notes']),
        emit: () => {},
      },
      deps,
    );
    expect(result.checklist).toEqual([
      { id: 'plugin-setup:_root__gmail', kind: 'plugin-setup', label: 'gmail', ref: '_root__gmail', details: ['Gmail account'] },
    ]);
  });
});
