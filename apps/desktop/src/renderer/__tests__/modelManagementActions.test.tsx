// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';
import { UnifiedModelList } from '../components/settings/UnifiedModelList';
import {
  __resetForTest,
  isModelEnabled,
  setModelVisibility,
  setModelVisibilityOwner,
} from '../state/modelVisibilityPrefs';

const writeFailure = vi.hoisted(() => vi.fn());
vi.mock('@/lib/toast', () => ({ toast: { error: writeFailure } }));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn() }),
}));
vi.mock('../hooks/useModelPricing', () => ({
  useGatewayModelPricing: () => null,
  useReferenceModelPricing: () => null,
}));
vi.mock('../components/settings/ModelAdvancedDrawer', () => ({ ModelAdvancedDrawer: () => null }));

const models = Array.from({ length: 9 }, (_, i) => ({
  id: `google/gemini-${i}`,
  name: `Gemini ${i}`,
  contextWindow: 100000,
  efforts: [],
  defaultEffort: null,
  defaultEnabled: false,
}));
const provider: ProviderView = {
  id: 'xd',
  name: 'Cindy AI',
  source: 'builtin',
  connected: true,
  auth: { method: 'apiKey' },
  agents: ['claude-code', 'codex', 'pi'],
  routing: {},
  models: {
    'claude-code': models,
    codex: models,
    pi: models.map((m) => ({ ...m, piApi: 'google-generative-ai' })),
  },
};
const enabled = (agent: 'claude-code' | 'codex' | 'pi', i = 0) =>
  isModelEnabled(agent, provider.id, provider.models[agent]![i]);
function menu() {
  fireEvent.keyDown(screen.getByRole('button', { name: 'settings.providers.models.manage.menu' }), {
    key: 'Enter',
  });
}
async function command(key: string) {
  menu();
  await act(async () => {
    fireEvent.click(
      screen.getByRole('menuitem', { name: `settings.providers.models.manage.${key}` }),
    );
  });
}

beforeEach(async () => {
  writeFailure.mockClear();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      maker: {
        claimLegacyModelVisibilityOwner: () => ({
          dataOwnerId: 'management',
          ownerGeneration: 1,
          canWriteOwnerScoped: true,
          canInitialize: true,
        }),
        syncModelVisibility: vi.fn(async () => undefined),
      },
    },
  });
  __resetForTest();
  await setModelVisibilityOwner('management', 1, 'cloud');
});
afterEach(() => {
  cleanup();
  __resetForTest();
  vi.restoreAllMocks();
});

it('all selection enables one recommended harness, clear always closes it, and repeat works', async () => {
  render(<UnifiedModelList provider={provider} />);
  await command('showAll');
  for (let i = 0; i < models.length; i++) {
    expect(enabled('pi', i)).toBe(true);
    expect(enabled('codex', i)).toBe(false);
    expect(enabled('claude-code', i)).toBe(false);
  }
  await command('hideAll');
  expect(enabled('pi')).toBe(false);
  await command('showAll');
  expect(enabled('pi')).toBe(true);
  await command('reset');
  expect(enabled('pi')).toBe(false);
});

it('search and arrangement never write preferences; bulk selection preserves advanced choices', async () => {
  await act(async () => {
    await setModelVisibility('codex', 'xd', models[0].id, true);
  });
  render(<UnifiedModelList provider={provider} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Gemini 0' } });
  menu();
  fireEvent.click(
    screen.getByRole('menuitemradio', { name: 'settings.providers.models.manage.byName' }),
  );
  expect(enabled('codex')).toBe(true);
  expect(enabled('pi')).toBe(false);
  await command('showAll');
  expect(enabled('codex')).toBe(true);
  expect(enabled('pi')).toBe(false);
  expect(enabled('pi', 1)).toBe(true);
  // Clearing acts on all models in this source, even while a search is active.
  await command('hideAll');
  expect(enabled('codex')).toBe(false);
  expect(enabled('pi', 1)).toBe(false);
});

it('waits for the shared lock and reports asynchronous write failures', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const request = vi.fn((_key: string, run: () => boolean) => held.then(run));
  vi.stubGlobal('navigator', { locks: { request } });
  try {
    render(<UnifiedModelList provider={provider} />);
    await command('showAll');
    expect(enabled('pi')).toBe(false);
    await act(async () => release());
    await waitFor(() => expect(enabled('pi')).toBe(true));
    request.mockRejectedValueOnce(new Error('lock unavailable'));
    await command('hideAll');
    await waitFor(() => expect(writeFailure).toHaveBeenCalledWith('settings.providers.models.visibilityWriteFailed'));
    expect(enabled('pi')).toBe(true);
  } finally { vi.unstubAllGlobals(); }
});
