// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  BotAuthorizationService,
  type BotAuthorizationAdapter,
} from '../../../../main/maker-ipc/botAuthorizationService';
import { sanitizeBotAuthorizationMetaForRemote } from '../../../../main/cindy-brain/ghostSetupInteractionBridge';
import {
  readBotAuthorizationCard,
  type BotAuthorizationCard,
} from '../../../../shared/botAuthorization';
import type { GhostSetupAllowedAction } from '../../../../shared/ghost';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { __resetStickySessionOriginForTest } from '@/features/device-link/stickySessionOrigin';
import { BotAuthorizationCardView } from '../BotAuthorizationCard';

// Keep the actual Host snapshot/projection, card, shared form and transport routing.
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../../main/plugin-oauth/runtime', () => ({ supportsRemotePluginOauth: () => true }));
const invoke = vi.fn(async () => ({ accepted: true }));
const submit = vi.fn(async () => ({ accepted: true }));
const resolve = vi.fn(async () => ({ accepted: true }));
const assist = vi.fn(async () => ({ accepted: true }));
const services: BotAuthorizationService[] = [];
const secret: GhostSetupAllowedAction = {
  id: 'key',
  kind: 'inline_form',
  form: {
    fields: [
      {
        id: 'value',
        type: 'secret',
        label: 'API key',
        placeholder: 'API key',
        required: true,
        maxLength: 100,
      },
    ],
  },
};
const connection: GhostSetupAllowedAction = { id: 'connection', kind: 'manage_connection' };

beforeEach(() => {
  vi.clearAllMocks();
  remoteProjectsStore.clear();
  remoteProjectsStore.__resetPinnedOriginsForTest();
  __resetStickySessionOriginForTest();
  window.electronAPI = {
    maker: {
      resolveInteraction: resolve,
      submitPluginSetupInline: submit,
      assistPluginOauth: assist,
    },
    deviceLink: { invoke },
  } as unknown as typeof window.electronAPI;
});
afterEach(async () => {
  cleanup();
  for (const service of services.splice(0)) await service.dispose();
});

async function hostCard(action: GhostSetupAllowedAction, remote: boolean) {
  const stored = new Map<string, BotAuthorizationCard>();
  const adapter: BotAuthorizationAdapter = {
    identity: { id: 'plugin', name: 'Plugin' },
    assess: async () => ({
      state: 'required',
      revision: 1,
      groups: [
        {
          id: 'account',
          mode: 'any_of',
          items: [
            {
              ref: 'account',
              kind:
                action.kind === 'inline_form'
                  ? 'secret'
                  : action.kind === 'manage_connection'
                    ? 'connection'
                    : 'oauth',
              label: 'Account',
              state: 'missing',
              actions: [action],
            },
          ],
        },
      ],
    }),
    subscribe: () => () => {},
    execute: vi.fn(async () => ({ ok: true as const })),
  };
  const service = new BotAuthorizationService({
    adapter: async () => adapter,
    save: async (card) => {
      stored.set(card.snapshot.requestId, structuredClone(card));
    },
    load: async (id) => stored.get(id) ?? null,
    findPending: async () => null,
    resume: async () => {},
    warn: vi.fn(),
    openExternal: vi.fn(async () => {}),
  });
  services.push(service);
  await service.request('session', { kind: 'plugin', id: 'plugin' });
  const card = [...stored.values()][0]!;
  if (!remote) return card;
  remoteProjectsStore.pinSessionOrigin('owner-device', 'session');
  return readBotAuthorizationCard(
    sanitizeBotAuthorizationMetaForRemote({ botAuthorization: card }).botAuthorization,
  )!;
}

it.each([false, true])(
  'does not accept secret input on remote Bot cards (unexpected capability=%s)',
  async (extra) => {
    const card = await hostCard(secret, true);
    expect(card.snapshot).not.toHaveProperty('remoteSecret');
    const snapshot = { ...card.snapshot, ...(extra ? { remoteSecret: true } : {}) };
    render(<BotAuthorizationCardView sessionId="session" data={{ ...card, snapshot }} />);
    expect((screen.getByPlaceholderText('API key') as HTMLInputElement).disabled).toBe(true);
    const save = screen.getByRole('button', { name: 'newChat.pluginSetup.saveConfiguration' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('newChat.pluginSetup.completeOnDesktop')).toBeTruthy();
    fireEvent.click(save);
    expect(submit).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  'does not expose an unwired remote Bot connection form (unexpected capability=%s)',
  async (extra) => {
    const card = await hostCard(connection, true);
    expect(card.snapshot).not.toHaveProperty('remoteConnection');
    const snapshot = { ...card.snapshot, ...(extra ? { remoteConnection: true } : {}) };
    const { container } = render(
      <BotAuthorizationCardView sessionId="session" data={{ ...card, snapshot }} />,
    );
    expect(container.querySelector('input')).toBeNull();
    const configure = screen.getByRole('button', {
      name: 'newChat.pluginSetup.action.manage_connection',
    });
    expect((configure as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(configure);
    expect(invoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'newChat.pluginSetup.cancel' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('owner-device', 'maker:resolve-interaction', [
        card.snapshot.requestId,
        { kind: 'plugin_setup', action: 'cancel', expectedRevision: card.snapshot.revision },
      ]),
    );
  },
);

it('keeps local Bot secrets on the private local submit path', async () => {
  const card = await hostCard(secret, false);
  render(<BotAuthorizationCardView sessionId="session" data={{ ...card }} />);
  const input = screen.getByPlaceholderText('API key') as HTMLInputElement;
  expect(input.disabled).toBe(false);
  fireEvent.change(input, { target: { value: 'synthetic-key' } });
  fireEvent.click(screen.getByRole('button', { name: 'newChat.pluginSetup.saveConfiguration' }));
  await waitFor(() =>
    expect(submit).toHaveBeenCalledWith({
      requestId: card.snapshot.requestId,
      actionId: 'key',
      expectedRevision: card.snapshot.revision,
      value: 'synthetic-key',
    }),
  );
  expect(invoke).not.toHaveBeenCalled();
  expect(resolve).not.toHaveBeenCalled();
});

it('keeps the remote OAuth action on the dedicated bridge', async () => {
  const card = await hostCard({ id: 'connect', kind: 'oauth_connect' }, true);
  expect(card.snapshot.remoteOauth).toBe(true);
  render(<BotAuthorizationCardView sessionId="session" data={{ ...card }} />);
  fireEvent.click(screen.getByRole('button', { name: card.snapshot.steps[0].title }));
  await waitFor(() =>
    expect(assist).toHaveBeenCalledWith({
      deviceId: 'owner-device',
      ghostId: 'plugin',
      requestId: card.snapshot.requestId,
      actionId: 'connect',
      expectedRevision: card.snapshot.revision,
    }),
  );
  expect(invoke).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
});
