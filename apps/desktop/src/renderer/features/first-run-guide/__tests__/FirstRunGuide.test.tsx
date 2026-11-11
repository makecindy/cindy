// @vitest-environment jsdom
/**
 * PR #9997: real guide navigation must stay parked until the requested connection is new;
 * a delayed balance must survive stepping away. Step-selection tests cannot cover effects.
 * Minimal failures: Cindy AI already connected; balance resolves on the finish step. Tier: unit. Standalone Vitest duration: 5.01s (357ms tests).
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { FirstRunGuide } from '../FirstRunGuide';
import { closeFirstRunGuide, getFirstRunGuideState, openFirstRunGuide } from '../firstRunGuideStore';

const mock = vi.hoisted(() => ({
  providers: [{ id: 'xd', name: 'Cindy AI', connected: true }, { id: 'openai', name: 'OpenAI', connected: false }],
  balance: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ mode: 'cloud', user: { membershipKind: 'personal' } }) }));
vi.mock('@/hooks/useProviders', () => ({ useProviders: () => ({ providers: mock.providers, loading: false }) }));
vi.mock('@/hooks/useProviderOnboarding', () => ({ useProviderOnboarding: () => ({ xdProvider: mock.providers[0], detectedRows: [], primaryRows: [{ kind: 'builtin', provider: mock.providers[1] }] }) }));
vi.mock('@/hooks/useSignInToCindy', () => ({ useSignInToCindy: () => vi.fn() }));
vi.mock('@/components/settings/useProviderSubscriptionCard', () => ({ useProviderSubscriptionCard: () => null }));
vi.mock('@/components/settings/SessionImportSection', () => ({ estimateMinutes: () => 0, useFormatSize: () => String }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => ({ confirm: vi.fn() }) }));
vi.mock('@/components/branding/ThemeBrandLockup', () => ({ ThemeBrandLockup: () => null }));
vi.mock('@/themes/theme-service', () => ({ themeService: { getCurrentTheme: () => 'light', onDidChangeTheme: () => () => {} } }));
vi.mock('@/features/billing/api', () => ({ billingApi: { getBalance: mock.balance } }));

afterEach(() => { cleanup(); closeFirstRunGuide(); vi.clearAllMocks(); mock.providers[1].connected = false; });

async function showModels() {
  Object.assign(window, { electronAPI: {
    localDb: { sessionImport: { scan: async () => ({ candidates: [], sources: [] }) } },
    companionImport: { sources: async () => [] },
    setupMigration: { state: async () => ({ lastRun: null }) },
  } });
  openFirstRunGuide({ manual: false, migration: false, legacyMigrated: false });
  const view = render(<MemoryRouter><FirstRunGuide /></MemoryRouter>);
  await act(async () => {});
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'firstRunGuide.intro.start' })); });
  return view;
}

it('keeps billing parked even when a model was already usable', async () => {
  mock.balance.mockResolvedValue(null);
  await showModels();
  fireEvent.click(screen.getByRole('button', { name: 'billing.sidebar' }));
  expect(getFirstRunGuideState().parked).toBe(true);
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('resumes only after the requested provider becomes connected', async () => {
  mock.balance.mockResolvedValue(null);
  const view = await showModels();
  fireEvent.click(screen.getByRole('button', { name: /OpenAI/ }));
  expect(getFirstRunGuideState().parked).toBe(true);
  mock.providers = [...mock.providers];
  view.rerender(<MemoryRouter><FirstRunGuide /></MemoryRouter>);
  expect(getFirstRunGuideState().parked).toBe(true);
  mock.providers = mock.providers.map((p) => p.id === 'openai' ? { ...p, connected: true } : p);
  view.rerender(<MemoryRouter><FirstRunGuide /></MemoryRouter>);
  expect(getFirstRunGuideState().parked).toBe(false);
  expect(screen.getByRole('dialog')).toBeTruthy();
});

it.each([false, true])('retains a delayed balance result across steps (rejected=%s)', async (reject) => {
  let resolve!: (value: unknown) => void;
  let fail!: (error: Error) => void;
  mock.balance.mockReturnValue(new Promise((done, failed) => { resolve = done; fail = failed; }));
  await showModels();
  fireEvent.click(screen.getByRole('button', { name: 'firstRunGuide.next' }));
  await act(async () => {
    if (reject) fail(new Error('offline'));
    else resolve({ available: '3', promotionalCredits: '3', purchasedCredits: '0', planCredits: '0' });
  });
  fireEvent.click(screen.getByRole('button', { name: 'setupMigration.back' }));
  expect(mock.balance).toHaveBeenCalledTimes(1);
  if (reject) expect(screen.getByText('firstRunGuide.models.cindy.active')).toBeTruthy();
  if (!reject) expect(screen.getByText(/3\.00/)).toBeTruthy();
});
