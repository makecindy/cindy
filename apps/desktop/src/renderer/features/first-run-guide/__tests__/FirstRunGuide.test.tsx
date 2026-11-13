// @vitest-environment jsdom
/**
 * PR #9997: real guide navigation must stay parked until a new connection is usable;
 * a delayed balance must survive stepping away. Step-selection tests cannot cover effects.
 * Minimal failures: Cindy AI already connected; balance resolves on the finish step. Tier: unit. Standalone Vitest duration: 2.42s (403ms tests).
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { FirstRunGuide } from '../FirstRunGuide';
import { closeFirstRunGuide, getFirstRunGuideState, openFirstRunGuide, parkFirstRunGuide, parkFirstRunGuideForConnection, useFirstRunGuideConnectionDialog } from '../firstRunGuideStore';

const mock = vi.hoisted(() => ({
  providers: [{ id: 'xd', name: 'Cindy AI', connected: true }, { id: 'openai', name: 'OpenAI', connected: false }],
  balance: vi.fn(),
  preset: false,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ mode: 'cloud', user: { membershipKind: 'personal' } }) }));
vi.mock('@/hooks/useProviders', () => ({ useProviders: () => ({ providers: mock.providers, loading: false }) }));
vi.mock('@/hooks/useProviderOnboarding', () => ({ useProviderOnboarding: () => ({ xdProvider: mock.providers[0], detectedRows: [], primaryRows: [mock.preset ? { kind: 'preset', preset: { id: 'openrouter', name: 'OpenRouter' } } : { kind: 'builtin', provider: mock.providers[1] }] }) }));
vi.mock('@/hooks/useSignInToCindy', () => ({ useSignInToCindy: () => vi.fn() }));
vi.mock('@/components/settings/useProviderSubscriptionCard', () => ({ useProviderSubscriptionCard: () => null }));
vi.mock('@/components/settings/SessionImportSection', () => ({ estimateMinutes: () => 0, useFormatSize: () => String }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => ({ confirm: vi.fn() }) }));
vi.mock('@/components/branding/ThemeBrandLockup', () => ({ ThemeBrandLockup: () => null }));
vi.mock('@/themes/theme-service', () => ({ themeService: { getCurrentTheme: () => 'light', onDidChangeTheme: () => () => {} } }));
vi.mock('@/features/billing/api', () => ({ billingApi: { getBalance: mock.balance } }));

afterEach(() => { cleanup(); closeFirstRunGuide(); vi.clearAllMocks(); mock.providers = [{ id: 'xd', name: 'Cindy AI', connected: true }, { id: 'openai', name: 'OpenAI', connected: false }]; mock.preset = false; });

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

// Last round covered only fixed IDs. A preset produces a user-named connection, not preset.id.
it.each(['preset', 'generic'])('returns after a renamed connection from the %s entry becomes usable', async (entry) => {
  mock.preset = true;
  mock.balance.mockResolvedValue(null);
  const view = await showModels();
  fireEvent.click(screen.getByRole('button', { name: entry === 'preset' ? /OpenRouter/ : 'firstRunGuide.models.own.more' }));
  expect(getFirstRunGuideState().parked).toBe(true);
  mock.providers = [...mock.providers, { id: 'my-renamed-plan-2', name: 'My renamed plan', connected: false }];
  view.rerender(<MemoryRouter><FirstRunGuide /></MemoryRouter>);
  expect(getFirstRunGuideState().parked).toBe(true);
  mock.providers = mock.providers.map((p) => p.id === 'my-renamed-plan-2' ? { ...p, connected: true } : p);
  view.rerender(<MemoryRouter><FirstRunGuide /></MemoryRouter>);
  expect(getFirstRunGuideState().parked).toBe(false);
  expect(screen.getByRole('dialog')).toBeTruthy();
});

it('forgets the previous connection wait after a manual return', async () => {
  mock.balance.mockResolvedValue(null);
  const view = await showModels();
  fireEvent.click(screen.getByRole('button', { name: /OpenAI/ }));
  fireEvent.click(screen.getByRole('button', { name: 'firstRunGuide.resume.back' }));
  expect(getFirstRunGuideState().parked).toBe(false);
  // A later navigation uses the generic park path, without starting a new connection.
  act(() => parkFirstRunGuide());
  mock.providers = mock.providers.map((p) => p.id === 'openai' ? { ...p, connected: true } : p);
  view.rerender(<MemoryRouter><FirstRunGuide /></MemoryRouter>);
  expect(getFirstRunGuideState().parked).toBe(true);
  expect(screen.queryByRole('dialog')).toBeNull();
});

// PR #9997 OAuth: connected credentials can arrive before the dialog's model-selection step ends.
function ConnectionDialogProbe({ callbacks }: { callbacks: { complete?: () => void; cancel?: () => void } }) {
  const handoff = useFirstRunGuideConnectionDialog();
  callbacks.complete = handoff.complete;
  callbacks.cancel = handoff.cancel;
  return null;
}

it.each(['complete', 'cancel', 'unmount'] as const)('does not cover an unfinished OAuth dialog, then handles %s', async outcome => {
  mock.preset = true;
  mock.balance.mockResolvedValue(null);
  const view = await showModels();
  fireEvent.click(screen.getByRole('button', { name: /OpenRouter/ }));
  const callbacks: { complete?: () => void; cancel?: () => void } = {};
  view.rerender(<MemoryRouter><FirstRunGuide /><ConnectionDialogProbe callbacks={callbacks} /></MemoryRouter>);
  mock.providers = [...mock.providers, { id: 'renamed-oauth-account', name: 'OAuth account', connected: true }];
  view.rerender(<MemoryRouter><FirstRunGuide /><ConnectionDialogProbe callbacks={callbacks} /></MemoryRouter>);
  expect(getFirstRunGuideState().parked).toBe(true);
  expect(screen.queryByRole('dialog')).toBeNull();
  if (outcome === 'unmount') {
    view.rerender(<MemoryRouter><FirstRunGuide /></MemoryRouter>);
    act(() => callbacks.complete?.()); // Late completion from an unmounted dialog is ignored.
  } else act(() => callbacks[outcome]?.());
  expect(getFirstRunGuideState().parked).toBe(outcome !== 'complete');
});

it('ignores an old dialog completion after the guide is closed and reopened', async () => {
  mock.balance.mockResolvedValue(null);
  const view = await showModels();
  fireEvent.click(screen.getByRole('button', { name: /OpenAI/ }));
  const callbacks: { complete?: () => void; cancel?: () => void } = {};
  view.rerender(<MemoryRouter><FirstRunGuide /><ConnectionDialogProbe callbacks={callbacks} /></MemoryRouter>);
  act(() => {
    closeFirstRunGuide();
    openFirstRunGuide({ manual: false, migration: false, legacyMigrated: false });
    parkFirstRunGuideForConnection(['xd']);
    callbacks.complete?.();
  });
  expect(getFirstRunGuideState().parked).toBe(true);
});
