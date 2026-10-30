/**
 * pluginModelPrefsIpc.test.ts — 插件详情「模型与任务」的读通道:沿用 ghosts:errand-prefs,
 * 额外带出系统辅助模型显示名;旧的逐能力 ghosts:cindy-prefs 通道已移除。
 * 回调取自生产 index.ts 源码(同 ghostLocalFileIpc 的抽取方式)。
 */

import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { createGhostProductionCallbacks } from './ghostProductionCallbacksFixture.js';

type SyncHandler = (event: { returnValue?: unknown }, ...args: unknown[]) => void;

const createCallbacks = createGhostProductionCallbacks<{ errandPrefs: SyncHandler }>({
  callbacks: { errandPrefs: ['ipcMain.on', 'ghosts:errand-prefs'] },
});

function read(deps: Record<string, unknown>, ghostId: unknown): unknown {
  const event: { returnValue?: unknown } = {};
  createCallbacks(deps).errandPrefs(event, ghostId);
  return event.returnValue;
}

describe('ghosts:errand-prefs (plugin model & tasks)', () => {
  it('returns the stored config and the current auxiliary model label, read fresh each time', () => {
    const readPluginTaskConfig = vi.fn(() => ({ permissionMode: 'auto' }));
    let refs = ['cat:xai:codex:grok-4.6'];
    const deps = {
      readPluginTaskConfig,
      getEffectiveAuxiliaryModelChain: () => ({ refs }),
      formatAuxiliaryModelRefLabel: (ref: string) => (ref.endsWith('grok-4.6') ? 'Grok 4.6' : 'GPT-5.5'),
    };
    expect(read(deps, 'writer')).toEqual({
      config: { permissionMode: 'auto' },
      auxiliaryModelLabel: 'Grok 4.6',
    });
    expect(readPluginTaskConfig).toHaveBeenCalledWith('writer');
    // 系统辅助模型改了:不缓存,下次打开详情页即跟随。
    refs = ['cat:openai:codex:gpt-5.5'];
    expect(read(deps, 'writer')).toMatchObject({ auxiliaryModelLabel: 'GPT-5.5' });
  });

  it('reports no auxiliary model when the chain is empty and ignores malformed ids', () => {
    const readPluginTaskConfig = vi.fn();
    expect(read({
      readPluginTaskConfig,
      getEffectiveAuxiliaryModelChain: () => ({ refs: [] }),
      formatAuxiliaryModelRefLabel: vi.fn(),
    }, 42)).toEqual({ config: {}, auxiliaryModelLabel: null });
    expect(readPluginTaskConfig).not.toHaveBeenCalled();
  });

  it('no longer registers the per-ability cindy-prefs channels', () => {
    const source = fs.readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    expect(source).not.toContain("'ghosts:cindy-prefs'");
    expect(source).not.toContain("'ghosts:cindy-prefs:set'");
  });
});

// unit: invoke the real Host defaults reader; hidden values must never be read,
// and opting back in must expose the original saved values without migration.
const createDefaults = createGhostProductionCallbacks<{ getPluginTaskDefaults(id: string): Record<string, unknown> | undefined }>({
  functions: ['getPluginTaskDefaults'],
});
it('opts out of every saved default without modifying storage or affecting another plugin', () => {
  const configs = { hidden: { model: 'old', permissionMode: 'bypassPermissions', workingDir: '/old' }, visible: { model: 'current' } };
  const readConfig = vi.fn((id: keyof typeof configs) => configs[id]);
  let hidden = true;
  const api = createDefaults({ readPluginTaskConfig: readConfig, findGhostForInstanceId: (id: string) =>
    id === 'missing' ? null : ({ manifest: { showTaskPreferences: id === 'hidden' ? !hidden : undefined } }) });
  expect(api.getPluginTaskDefaults('hidden')).toBeUndefined();
  expect(api.getPluginTaskDefaults('missing')).toBeUndefined();
  expect(readConfig).not.toHaveBeenCalled();
  configs.hidden.permissionMode = 'ask';
  expect(api.getPluginTaskDefaults('hidden')).toBeUndefined();
  expect(api.getPluginTaskDefaults('visible')).toEqual(configs.visible);
  hidden = false;
  expect(api.getPluginTaskDefaults('hidden')).toEqual(configs.hidden);
});

type OneshotSelection = { providerId?: string; agentKind: string; model: string } | null;

const createSelection = createGhostProductionCallbacks<{
  getPluginOneshotModelSelection: (ghostId: string) => OneshotSelection;
}>({ functions: ['getPluginTaskDefaults', 'getPluginOneshotModelSelection'] });

describe('getPluginOneshotModelSelection (plugin oneshot model pin)', () => {
  function select(config: Record<string, unknown>, resolved: OneshotSelection, showTaskPreferences?: boolean): {
    result: OneshotSelection;
    resolve: ReturnType<typeof vi.fn>;
  } {
    const resolve = vi.fn(() => resolved);
    const { getPluginOneshotModelSelection } = createSelection({
      readPluginTaskConfig: () => config,
      findGhostForInstanceId: () => ({ manifest: { showTaskPreferences } }),
      resolveOneshotCatalogModel: resolve,
      getActiveCatalog: () => ({}),
      readModelDisableOverrides: () => undefined,
      readProviderOrder: () => ['xd', 'openai'],
      hasOneshotProviderCredential: () => true,
    });
    return { result: getPluginOneshotModelSelection('writer'), resolve };
  }

  // unit: a hidden settings card must not pin oneshot billing/model routing.
  // Existing cases cover provider matching but not a plugin opting out of defaults.
  it('ignores a stored model when the plugin opts out of host task preferences', () => {
    const { result, resolve } = select({ agentKind: 'cc', providerId: 'old', model: 'old' }, null, false);
    expect(result).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('keeps the user-chosen provider when the Pi route only resolves on another provider', () => {
    // 用户选的供应商没有快问快答通道,目录只在另一家解析到同名模型:不换供应商。
    const { result, resolve } = select(
      { agentKind: 'pi', providerId: 'my-relay', model: 'gpt-5.5' },
      { providerId: 'openai', agentKind: 'codex', model: 'gpt-5.5' },
    );
    expect(resolve.mock.calls[0]?.[3]).toEqual(['my-relay', 'xd', 'openai']);
    expect(result).toEqual({ agentKind: 'pi', model: 'gpt-5.5', providerId: 'my-relay' });
  });

  it('uses the resolved oneshot route when it stays on the user-chosen provider', () => {
    const { result } = select(
      { agentKind: 'pi', providerId: 'my-relay', model: 'gpt-5.5' },
      { providerId: 'my-relay', agentKind: 'codex', model: 'gpt-5.5' },
    );
    expect(result).toEqual({ providerId: 'my-relay', agentKind: 'codex', model: 'gpt-5.5' });
  });

  it('accepts any resolved provider when the user did not choose one', () => {
    const { result } = select(
      { model: 'gpt-5.5' },
      { providerId: 'openai', agentKind: 'codex', model: 'gpt-5.5' },
    );
    expect(result).toEqual({ providerId: 'openai', agentKind: 'codex', model: 'gpt-5.5' });
  });

  it('returns null when no model is chosen and pins explicit non-Pi selections as-is', () => {
    expect(select({}, null).result).toBeNull();
    const { result, resolve } = select({ agentKind: 'cc', providerId: 'anthropic', model: 'claude-sonnet' }, null);
    expect(resolve).not.toHaveBeenCalled();
    expect(result).toEqual({ agentKind: 'claude-code', model: 'claude-sonnet', providerId: 'anthropic' });
  });
});
