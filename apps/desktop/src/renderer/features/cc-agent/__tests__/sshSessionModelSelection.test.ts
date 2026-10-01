import { describe, expect, it, vi } from 'vitest';
import type { CatalogModel, ProviderView } from '@cindy/model-providers';
import { resolveSshSessionModelSelection } from '../sshSessionModelSelection';
import { sshModel, sshProvider, sshNativeCodexProvider } from './sshModelFixtures';

function resolve(
  providers: ProviderView[],
  patch: Partial<Parameters<typeof resolveSshSessionModelSelection>[0]> = {},
) {
  return resolveSshSessionModelSelection({
    providers,
    loading: false,
    loadFailed: false,
    agentKind: 'codex',
    preferred: { model: 'gpt-5.5-codex', effort: 'medium', fastMode: true },
    ...patch,
  });
}

describe('SSH creation model selection', () => {
  it('replaces a removed model with an actual catalog route without naming another default', () => {
    expect(resolve([sshNativeCodexProvider()])).toEqual({
      ok: true,
      model: 'available-model',
      providerId: 'openai',
      effort: 'high',
      fastMode: false,
    });
  });

  it('preserves a native preference and uses its effort and Fast capabilities', () => {
    const preferred = {
      model: 'chosen',
      providerId: 'openai',
      effort: 'low',
      fastMode: true,
    } as const;
    expect(
      resolve(
        [
          sshProvider('xd', [sshModel('chosen')]),
          sshNativeCodexProvider([
            sshModel('chosen', { efforts: ['low'], supportsFastMode: true }),
          ]),
        ],
        { preferred },
      ),
    ).toEqual({ ok: true, ...preferred });
  });

  it.each(['xd', 'custom-responses', 'openai-second', 'removed-account'])(
    'rejects an explicit %s connection instead of silently switching accounts',
    (providerId) => {
      expect(
        resolve([sshNativeCodexProvider(), sshProvider(providerId)], {
          preferred: { model: 'available-model', providerId, effort: 'high', fastMode: false },
        }),
      ).toEqual({ ok: false, reason: 'unsupported-codex-source' });
    },
  );

  it.each(['xd', 'custom-responses', 'openai-second', 'openai'])(
    'does not treat the controller-only %s route as a remote default login',
    (id) => {
      const provider = sshProvider(id, [sshModel('codex/gpt-5.6-luna')]);
      provider.routing.codex!.wireProtocol = 'openai-responses';
      if (id === 'openai-second') provider.auth = { method: 'oauth', native: 'codex' };
      expect(resolve([provider])).toEqual({ ok: false, reason: 'unsupported-codex-source' });
    },
  );

  it('ignores gateway aliases when choosing a fallback from a mixed catalog', () => {
    expect(
      resolve([
        sshProvider('xd', [sshModel('codex/gpt-5.6-luna')]),
        sshNativeCodexProvider([sshModel('native-model-from-discovery')]),
      ]),
    ).toMatchObject({ ok: true, providerId: 'openai', model: 'native-model-from-discovery' });
  });

  it.each(['chatgpt/only-local', 'xai/only-local'])(
    'rejects subscription bridge model %s',
    (id) => {
      expect(resolve([sshNativeCodexProvider([sshModel(id)])])).toEqual({
        ok: false,
        reason: 'no-route',
      });
    },
  );

  it('rejects a catalog containing only local bridges or independent OAuth accounts', () => {
    const bridge = sshProvider('bridge');
    bridge.routing.codex!.wireProtocol = 'openai-chat';
    const account = sshProvider('openai-second');
    account.auth = { method: 'oauth', native: 'codex' };
    expect(resolve([bridge, account])).toEqual({ ok: false, reason: 'unsupported-codex-source' });
  });

  it.each([
    { disabled: true },
    { status: 'retired' },
    { mode: 'image_generation' },
  ] satisfies Partial<CatalogModel>[])('rejects a non-selectable model: %j', (patch) => {
    expect(resolve([sshNativeCodexProvider([sshModel('bad', patch)])])).toEqual({
      ok: false,
      reason: 'no-route',
    });
  });

  it.each(['disconnected', 'suspended', 'failed-discovery', 'disabled'])(
    'excludes the native login when %s',
    (state) => {
      const provider = sshNativeCodexProvider();
      if (state === 'disconnected') provider.connected = false;
      if (state === 'suspended') provider.suspended = true;
      if (state === 'failed-discovery') {
        provider.modelDiscoveryFailure = { kind: 'upstream', at: '2026-09-22T00:00:00Z' };
      }
      if (state === 'disabled') provider.routing.codex!.disabled = true;
      expect(resolve([provider])).toEqual({ ok: false, reason: 'no-route' });
    },
  );

  it('does not confuse model visibility with route admission', () => {
    expect(
      resolve([sshNativeCodexProvider([sshModel('hidden', { defaultEnabled: false })])]),
    ).toMatchObject({
      ok: true,
      model: 'hidden',
      providerId: 'openai',
    });
  });

  it('applies saved tuning to the resolved model and clamps unsupported effort', () => {
    const getPresetEffort = vi.fn(() => 'max' as const);
    const getPresetFast = vi.fn(() => true);
    expect(
      resolve([sshNativeCodexProvider([sshModel('available-model', { supportsFastMode: true })])], {
        getPresetEffort,
        getPresetFast,
      }),
    ).toMatchObject({ ok: true, effort: 'high', fastMode: true });
    expect(getPresetEffort).toHaveBeenCalledWith('codex', 'openai', 'available-model');
    expect(getPresetFast).toHaveBeenCalledWith('codex', 'openai', 'available-model');
  });

  it('retains the ordinary draft policy when the catalog has no effort levels', () => {
    expect(
      resolve([sshNativeCodexProvider([sshModel('plain', { efforts: [], defaultEffort: null })])]),
    ).toMatchObject({
      ok: true,
      effort: 'medium',
      fastMode: false,
    });
  });

  it.each([
    { loading: true, loadFailed: false, reason: 'catalog-loading' },
    { loading: true, loadFailed: true, reason: 'catalog-error' },
    { loading: false, loadFailed: true, reason: 'catalog-error' },
  ])('never selects from unready/stale data: %j', ({ loading, loadFailed, reason }) => {
    expect(resolve([sshNativeCodexProvider()], { loading, loadFailed })).toEqual({
      ok: false,
      reason,
    });
  });

  it.each(['claude-code', 'pi'] as const)('preserves ordinary SSH creation for %s', (agentKind) => {
    expect(resolve([sshProvider('source', undefined, agentKind)], { agentKind })).toMatchObject({
      ok: true,
      providerId: 'source',
      model: 'available-model',
    });
  });
});
