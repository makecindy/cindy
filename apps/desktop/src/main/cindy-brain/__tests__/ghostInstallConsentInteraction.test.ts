import { describe, expect, it, vi } from 'vitest';

import type { GhostPermissionItem } from '../../../shared/ghost.js';
import type { GhostInstallConsentRequest } from '../../../shared/ghostInstallConsent.js';

vi.mock('../../i18n.js', () => ({ t: (key: string) => key }));

import {
  buildGhostInstallConsentInteraction,
  createTaskInstallConsentPrompt,
  renderGhostInstallConsentText,
} from '../ghostInstallConsentInteraction.js';

const HOST: GhostPermissionItem = {
  key: 'network:host:api.weather.test',
  kind: 'network',
  labelKey: 'networkHost',
  labelArgs: { host: 'api.weather.test' },
};

const OAUTH: GhostPermissionItem = {
  key: 'network:secret:github',
  kind: 'network',
  labelKey: 'networkSecretOauth',
  labelArgs: { name: 'GitHub', host: 'github.com' },
  detailKey: 'networkSecretOauthDetail',
  detail: 'repo\nread:user',
};

const STRINGS: Record<string, string> = {
  'settings.ghosts.installConsent.installTitle': 'Install {{name}}?',
  'settings.ghosts.installConsent.updateTitle': 'Update {{name}}?',
  'settings.ghosts.installConsent.installMeta': 'v{{version}} · {{source}}',
  'settings.ghosts.installConsent.updateMeta': 'v{{from}} → v{{to}} · {{source}}',
  'settings.ghosts.installConsent.installDescription': 'Confirm to install.',
  'settings.ghosts.installConsent.updateDescription': 'Needs more permissions.',
  'settings.ghosts.installConsent.grantsTitle': 'It will have:',
  'settings.ghosts.installConsent.addedTitle': 'Added:',
  'settings.ghosts.installConsent.unchangedCount': 'Unchanged: {{count}}',
  'settings.ghosts.installConsent.originMarket': 'From market',
  'settings.ghosts.installConsent.originForge': 'Local plugin',
  'settings.ghosts.installConsent.initiatedByAgent': 'Agent · {{origin}}',
  'settings.ghosts.perm.networkHost': 'Reach {{host}}',
  'settings.ghosts.perm.networkSecretOauth': 'Connect {{name}} ({{host}})',
  'settings.ghosts.perm.networkSecretOauthDetail': 'Requested scopes:',
};
const translate = (key: string) => STRINGS[key] ?? key;

const INSTALL: Omit<GhostInstallConsentRequest, 'requestId'> = {
  initiator: 'agent',
  origin: 'market',
  facts: { kind: 'install', ghostId: 'weather-chip', name: 'Weather', version: '1.0.0', permissions: [HOST] },
};

describe('plugin install confirmation card', () => {
  it('renders the source on the first line and the permission list below', () => {
    expect(renderGhostInstallConsentText(INSTALL, translate)).toEqual({
      title: 'Install Weather?',
      description: 'v1.0.0 · Agent · From market\nConfirm to install.\nIt will have:\n• Reach api.weather.test',
    });
  });

  it('shows only what changes for an update', () => {
    const text = renderGhostInstallConsentText(
      {
        initiator: 'agent',
        origin: 'forge',
        facts: {
          kind: 'update', ghostId: 'weather-chip', name: 'Weather', version: '2.0.0',
          previousVersion: '1.0.0', added: [HOST], removed: [], unchangedCount: 2,
          builtinOauthClientChanged: false,
        },
      },
      translate,
    );
    expect(text.title).toBe('Update Weather?');
    expect(text.description.split('\n')).toEqual([
      'v1.0.0 → v2.0.0 · Agent · Local plugin',
      'Needs more permissions.',
      'Added:',
      '• Reach api.weather.test',
      'Unchanged: 2',
    ]);
  });

  it('includes host detail keys and author detail such as OAuth scopes', () => {
    const text = renderGhostInstallConsentText(
      {
        initiator: 'agent',
        origin: 'market',
        facts: {
          kind: 'update',
          ghostId: 'weather-chip',
          name: 'Weather',
          version: '2.0.0',
          previousVersion: '1.0.0',
          added: [OAUTH],
          removed: [],
          unchangedCount: 0,
          builtinOauthClientChanged: false,
        },
      },
      translate,
    );
    expect(text.description.split('\n')).toEqual([
      'v1.0.0 → v2.0.0 · Agent · From market',
      'Needs more permissions.',
      'Added:',
      '• Connect GitHub (github.com)',
      '  Requested scopes:',
      '  repo',
      '  read:user',
    ]);
  });

  it('is a host-owned permission request without session-wide allow suggestions', () => {
    const request = buildGhostInstallConsentInteraction('req-1', INSTALL, translate);
    expect(request).toMatchObject({
      kind: 'permission',
      requestId: 'req-1',
      toolName: 'cindy.plugin.install',
      input: { ghost_id: 'weather-chip', version: '1.0.0' },
      metadata: { hostOwnedConfirmation: 'plugin_install' },
    });
    expect(request.suggestions).toBeUndefined();
  });
});

describe('createTaskInstallConsentPrompt', () => {
  const task = { sessionId: 'session-1', sessionInstanceId: 'instance-1' };

  it('maps allow and deny from the task card', async () => {
    const allow = createTaskInstallConsentPrompt(task, async () => ({ kind: 'permission', behavior: 'allow' }));
    await expect(allow(INSTALL)).resolves.toBe(true);
    const deny = createTaskInstallConsentPrompt(task, async () => ({
      kind: 'permission', behavior: 'deny', reason: 'User denied',
    }));
    await expect(deny(INSTALL)).resolves.toBe(false);
  });

  it('sends the confirmation card to the calling task', async () => {
    const requester = vi.fn(async () => ({ kind: 'permission' as const, behavior: 'allow' as const }));
    await createTaskInstallConsentPrompt(task, requester)(INSTALL);
    expect(requester).toHaveBeenCalledWith(
      'session-1',
      'instance-1',
      expect.objectContaining({ toolName: 'cindy.plugin.install' }),
      expect.any(AbortSignal),
    );
  });

  it('fails closed when the card never reached the user', async () => {
    await expect(createTaskInstallConsentPrompt(null, vi.fn())(INSTALL)).rejects.toThrow();
    await expect(createTaskInstallConsentPrompt(task, undefined)(INSTALL)).rejects.toThrow();
    await expect(createTaskInstallConsentPrompt(task, async () => null)(INSTALL)).rejects.toThrow();
    await expect(
      createTaskInstallConsentPrompt(task, async () => ({
        kind: 'permission', behavior: 'deny', reason: 'no_interaction_route',
      }))(INSTALL),
    ).rejects.toThrow();
  });
});
