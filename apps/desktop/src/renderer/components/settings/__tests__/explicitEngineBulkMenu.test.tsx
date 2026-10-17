// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuRadioGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuRadioItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onSelect,
    disabled,
  }: {
    children: ReactNode;
    onSelect?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" disabled={disabled} onClick={() => onSelect?.()}>
      {children}
    </button>
  ),
}));

import { UnifiedModelList } from '@/components/settings/UnifiedModelList';
import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog-provider';
import {
  __resetForTest,
  isModelEnabled,
  setModelVisibility,
  setModelVisibilityOwner,
} from '@/state/modelVisibilityPrefs';

import type { CatalogModel, ProviderView } from '@cindy/model-providers';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { resolvedLanguage: 'zh-CN', language: 'zh-CN' } }) }));
vi.mock('@/hooks/useModelPricing', () => ({
  useGatewayModelPricing: () => null,
  useReferenceModelPricing: () => null,
}));

function model(id: string, extra: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id,
    name: id,
    contextWindow: 100_000,
    efforts: [],
    defaultEffort: null,
    defaultEnabled: false,
    ...extra,
  } as CatalogModel;
}

const provider = {
  id: 'gateway',
  name: 'Gateway',
  source: 'user',
  connected: true,
  agents: ['claude-code', 'codex', 'pi'],
  auth: { method: 'api-key' },
  routing: {},
  models: {
    'claude-code': [
      model('already'),
      model('closed'),
      model('stopped', { disabled: true }),
      model('locked', { availability: 'requires_payment' }),
      model('old'),
    ],
    codex: [
      model('already'),
      model('closed'),
      model('stopped', { disabled: true }),
      model('locked', { availability: 'requires_payment' }),
      model('old', { status: 'retired' }),
    ],
    pi: [
      model('already'),
      model('closed'),
      model('stopped', { disabled: true }),
      model('locked', { availability: 'requires_payment' }),
      model('old'),
    ],
  },
} as ProviderView;

beforeEach(() => {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      maker: {
        claimLegacyModelVisibilityOwner: () => ({
          dataOwnerId: 'test-owner',
          ownerGeneration: 1,
          canWriteOwnerScoped: true,
          claimed: true,
          claimedByOtherOwner: false,
          canInitialize: true,
          profileOrigin: 'new',
        }),
        syncModelVisibility: async () => undefined,
      },
    },
  });
  setModelVisibilityOwner('test-owner', 1, 'cloud');
});

afterEach(() => {
  cleanup();
  __resetForTest();
});

describe('manage menu enables one existing engine and keeps it after reload', () => {
  it('writes only the chosen engine for operable models and reads it back after owner reload', async () => {
    expect(await setModelVisibility('claude-code', provider.id, 'already', true)).toBe(true);
    render(
      <ConfirmDialogProvider>
        <UnifiedModelList provider={provider} />
      </ConfirmDialogProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'settings.providers.models.manage.enableEngine.codex' }));
    await waitFor(() => {
      expect(isModelEnabled('codex', provider.id, { id: 'already', defaultEnabled: false })).toBe(true);
    });

    expect(isModelEnabled('claude-code', provider.id, { id: 'already', defaultEnabled: false })).toBe(true);
    expect(isModelEnabled('codex', provider.id, { id: 'already', defaultEnabled: false })).toBe(true);
    expect(isModelEnabled('pi', provider.id, { id: 'already', defaultEnabled: false })).toBe(false);
    expect(isModelEnabled('codex', provider.id, { id: 'closed', defaultEnabled: false })).toBe(true);
    expect(isModelEnabled('codex', provider.id, { id: 'stopped', defaultEnabled: false })).toBe(false);
    expect(isModelEnabled('codex', provider.id, { id: 'locked', defaultEnabled: false })).toBe(false);
    expect(isModelEnabled('codex', provider.id, { id: 'old', defaultEnabled: false })).toBe(false);
    expect(isModelEnabled('pi', provider.id, { id: 'old', defaultEnabled: false })).toBe(false);

    await setModelVisibilityOwner('test-owner', 2, 'cloud');
    expect(isModelEnabled('codex', provider.id, { id: 'already', defaultEnabled: false })).toBe(true);
    expect(isModelEnabled('codex', provider.id, { id: 'closed', defaultEnabled: false })).toBe(true);
    expect(isModelEnabled('claude-code', provider.id, { id: 'already', defaultEnabled: false })).toBe(true);
  });
});

describe('manage menu only offers engines that can enable current models', () => {
  it('keeps Codex and Pi out of a Claude Code only provider and writes that engine', async () => {
    const anthropicLike = {
      ...provider,
      id: 'anthropic',
      name: 'Anthropic',
      source: 'builtin',
      agents: ['claude-code'],
      models: {
        'claude-code': [model('claude-chat')],
      },
    } as ProviderView;
    expect(await setModelVisibility('claude-code', anthropicLike.id, 'claude-chat', true)).toBe(true);
    render(
      <ConfirmDialogProvider>
        <UnifiedModelList provider={anthropicLike} />
      </ConfirmDialogProvider>,
    );

    const enableClaude = screen.getByRole('button', { name: 'settings.providers.models.manage.enableEngine.claude-code' });
    fireEvent.click(enableClaude);
    await waitFor(() => {
      expect(isModelEnabled('claude-code', anthropicLike.id, { id: 'claude-chat', defaultEnabled: false })).toBe(true);
    });
    fireEvent.click(enableClaude);
    await waitFor(() => {
      expect(isModelEnabled('claude-code', anthropicLike.id, { id: 'claude-chat', defaultEnabled: false })).toBe(true);
    });
    expect(screen.queryByRole('button', { name: 'settings.providers.models.manage.enableEngine.codex' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'settings.providers.models.manage.enableEngine.pi' })).toBeNull();
    expect(isModelEnabled('codex', anthropicLike.id, { id: 'claude-chat', defaultEnabled: false })).toBe(false);
    expect(isModelEnabled('pi', anthropicLike.id, { id: 'claude-chat', defaultEnabled: false })).toBe(false);
  });

  it('hides an engine that is present but has no operable model', () => {
    const mixed = {
      ...provider,
      id: 'mixed-engines',
      models: {
        'claude-code': [model('claude-chat')],
        codex: [model('codex-old', { status: 'retired' })],
        pi: [model('pi-stopped', { disabled: true })],
      },
    } as ProviderView;
    render(
      <ConfirmDialogProvider>
        <UnifiedModelList provider={mixed} />
      </ConfirmDialogProvider>,
    );

    expect((screen.getByRole('button', { name: 'settings.providers.models.manage.enableEngine.claude-code' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole('button', { name: 'settings.providers.models.manage.enableEngine.codex' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'settings.providers.models.manage.enableEngine.pi' })).toBeNull();
  });

  it('does not show the engine group for a media-only provider that can still change visibility', () => {
    const mediaOnly = {
      ...provider,
      id: 'media-only',
      name: 'Media',
      models: {
        'claude-code': [],
        codex: [],
        pi: [],
      },
      imageModels: [{ id: 'gpt-image-2', name: 'GPT Image 2', defaultEnabled: false }],
      availableMediaModelIds: ['gpt-image-2'],
    } as ProviderView;
    render(
      <ConfirmDialogProvider>
        <UnifiedModelList provider={mediaOnly} />
      </ConfirmDialogProvider>,
    );

    expect((screen.getByRole('button', { name: 'settings.providers.models.manage.menu' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'settings.providers.models.manage.reset' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText('settings.providers.models.manage.enableEngines')).toBeNull();
    expect(screen.queryByRole('button', { name: 'settings.providers.models.manage.enableEngine.claude-code' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'settings.providers.models.manage.enableEngine.codex' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'settings.providers.models.manage.enableEngine.pi' })).toBeNull();
  });
});
