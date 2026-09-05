// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';
import { UnifiedModelList } from '../components/settings/UnifiedModelList';
import {
  __resetForTest,
  isModelEnabled,
  setModelVisibility,
  setModelVisibilityOwner,
} from '../state/modelVisibilityPrefs';

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
function command(key: string) {
  menu();
  fireEvent.click(
    screen.getByRole('menuitem', { name: `settings.providers.models.manage.${key}` }),
  );
}

beforeEach(() => {
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
  setModelVisibilityOwner('management', 1, 'cloud');
});
afterEach(() => {
  cleanup();
  __resetForTest();
});

it('all selection enables one recommended harness, clear always closes it, and repeat works', () => {
  render(<UnifiedModelList provider={provider} />);
  command('showAll');
  for (let i = 0; i < models.length; i++) {
    expect(enabled('pi', i)).toBe(true);
    expect(enabled('codex', i)).toBe(false);
    expect(enabled('claude-code', i)).toBe(false);
  }
  command('hideAll');
  expect(enabled('pi')).toBe(false);
  command('showAll');
  expect(enabled('pi')).toBe(true);
  command('reset');
  expect(enabled('pi')).toBe(false);
});

it('search and arrangement never write preferences; bulk selection preserves advanced choices', () => {
  act(() => {
    setModelVisibility('codex', 'xd', models[0].id, true);
  });
  render(<UnifiedModelList provider={provider} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Gemini 0' } });
  menu();
  fireEvent.click(
    screen.getByRole('menuitemradio', { name: 'settings.providers.models.manage.byName' }),
  );
  expect(enabled('codex')).toBe(true);
  expect(enabled('pi')).toBe(false);
  command('showAll');
  expect(enabled('codex')).toBe(true);
  expect(enabled('pi')).toBe(false);
  expect(enabled('pi', 1)).toBe(true);
  // Clearing acts on all models in this source, even while a search is active.
  command('hideAll');
  expect(enabled('codex')).toBe(false);
  expect(enabled('pi', 1)).toBe(false);
});
