import { describe, expect, it, vi } from 'vitest';

import type { GhostPermissionItem } from '../../../shared/ghost.js';
import type { GhostInstallConsentRequest } from '../../../shared/ghostInstallConsent.js';

vi.mock('../../i18n.desktop.js', () => ({ t: (key: string) => key }));

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
  'settings.ghosts.installConsent.originCustomMarket': 'From custom market {{name}}',
  'settings.ghosts.installConsent.originRepository': 'Repository {{repository}}',
  'settings.ghosts.installConsent.originRepositoryRef': 'Repository {{repository}} ({{ref}})',
  'settings.ghosts.installConsent.originLocalFolder': 'Local folder',
  'settings.ghosts.perm.networkHost': 'Reach {{host}}',
  'settings.ghosts.perm.networkSecretOauth': 'Connect {{name}} ({{host}})',
  'settings.ghosts.perm.networkSecretOauthDetail': 'Requested scopes:',
};
const translate = (key: string) => STRINGS[key] ?? key;
const SOURCE_ID = 'AbCdEfGhIjKlMnOpQrStUv';

const INSTALL: Omit<GhostInstallConsentRequest, 'requestId'> = {
  initiator: 'agent',
  origin: 'market',
  facts: { kind: 'install', ghostId: 'weather-chip', name: 'Weather', version: '1.0.0', permissions: [HOST] },
};

describe('plugin install confirmation card', () => {
  // #9496: task/IM installation confirmation uses a separate text presenter.
  // Unit: one Host capability must be readable without changing its projection.
  it('renders host permissions as readable text in task installation confirmation', () => {
    const permission: GhostPermissionItem = { key: 'ui:host:capability:draft', kind: 'panel', labelKey: 'uiHost',
      detailKey: 'uiHostAccess', detailArgs: { subject: 'capability:draft', access: 'draft' } };
    const before = JSON.stringify(permission);
    const text = renderGhostInstallConsentText({ ...INSTALL, facts: { ...INSTALL.facts,
      kind: 'install', permissions: [permission] } }, key => key === 'settings.ghosts.perm.hostUi.capabilities.draft'
      ? 'Read and edit the message draft' : translate(key));
    expect(text.description).toContain('Read and edit the message draft');
    expect(text.description).not.toContain('capability:draft');
    expect(JSON.stringify(permission)).toBe(before);
  });
  it('renders the source on the first line and the permission list below', () => {
    expect(renderGhostInstallConsentText(INSTALL, translate)).toEqual({
      title: 'Install Weather?',
      description: 'v1.0.0 · Agent · From market\nConfirm to install.\nIt will have:\n• Reach api.weather.test',
    });
  });

  // PR #12684 maintainer review (2026-11-25): task and IM cards name the repository a custom-market
  // package comes from. Before this change the line only had the market name. A malformed identity
  // never prints partial values; the line falls back to the market name.
  it.each([
    [{ kind: 'git', repository: 'github.com/acme/plugins', sourceId: SOURCE_ID }, 'From custom market Acme · Repository github.com/acme/plugins'],
    [{ kind: 'git', repository: 'github.com/acme/plugins', ref: 'main', sourceId: SOURCE_ID }, 'From custom market Acme · Repository github.com/acme/plugins (main)'],
    [{ kind: 'local', sourceId: SOURCE_ID }, 'From custom market Acme · Local folder'],
    [undefined, 'From custom market Acme'],
    [{ kind: 'git', repository: 'https://ghp_SECRET@github.com/acme/plugins', sourceId: SOURCE_ID }, 'From custom market Acme'],
    [{ kind: 'git', repository: 'github.com/acme/plugins' }, 'From custom market Acme'],
  ] as const)('names the custom-market repository on the source line (%o)', (originSource, line) => {
    const request = { ...INSTALL, origin: 'custom-market' as const, originLabel: 'Acme',
      ...(originSource ? { originSource: originSource as GhostInstallConsentRequest['originSource'] } : {}) };
    expect(renderGhostInstallConsentText({ ...request, initiator: 'user' }, translate).description.split('\n')[0])
      .toBe(`v1.0.0 · ${line}`);
    expect(renderGhostInstallConsentText(request, translate).description.split('\n')[0]).toBe(`v1.0.0 · Agent · ${line}`);
  });

  it.each([
    ['custom-market', undefined, 'settings.ghosts.installConsent.customMarketSourceNotice'],
    ['local-file', undefined, 'settings.ghosts.installConsent.localFileSourceNotice'],
    ['market', true, 'settings.ghosts.market.communityDisclaimer'],
  ] as const)('puts the %s source notice before the permission list', (origin, communityMarket, key) => {
    const notice = 'Review the source before installing.';
    const text = renderGhostInstallConsentText({ ...INSTALL, origin, communityMarket }, name =>
      name === key ? notice : translate(name),
    );
    expect(text.description.split('\n').slice(1)).toEqual([
      'Confirm to install.', notice, 'It will have:', '• Reach api.weather.test',
    ]);
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
      input: { ghost_id: 'weather-chip', version: '1.0.0', operation: 'install', origin: 'market' },
      metadata: { hostOwnedConfirmation: 'plugin_install' },
    });
    expect(request.input).not.toHaveProperty('source');
    expect(request.suggestions).toBeUndefined();
  });

  // PR #12684 maintainer review (2026-11-25, item 2): an Agent-started custom-market install reaches the
  // phone as this task card; its input must carry the Host's structured source identity so the controller
  // can show the repository and refuse approval when it is missing. Before this change the input held only
  // ghost_id / version / operation.
  it('carries the origin and the custom-market source identity in the task card input', () => {
    const source = { kind: 'git' as const, repository: 'github.com/acme/plugins', ref: 'main', sourceId: SOURCE_ID };
    const custom = buildGhostInstallConsentInteraction('req-2',
      { ...INSTALL, origin: 'custom-market', originLabel: 'Acme', originSource: source }, translate);
    expect(custom.input).toEqual({ ghost_id: 'weather-chip', version: '1.0.0', operation: 'install', origin: 'custom-market', source });
    // Without a verifiable identity the card says so by omission; a malformed one never passes through.
    const missing = buildGhostInstallConsentInteraction('req-3', { ...INSTALL, origin: 'custom-market', originLabel: 'Acme' }, translate);
    expect(missing.input).toEqual({ ghost_id: 'weather-chip', version: '1.0.0', operation: 'install', origin: 'custom-market' });
    const malformed = buildGhostInstallConsentInteraction('req-4', { ...INSTALL, origin: 'custom-market',
      originSource: { kind: 'git', repository: 'github.com/acme/plugins' } as unknown as GhostInstallConsentRequest['originSource'] }, translate);
    expect(malformed.input).not.toHaveProperty('source');
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
