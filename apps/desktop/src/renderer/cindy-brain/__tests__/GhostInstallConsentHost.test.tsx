// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

import type { GhostInstallConsentRequest } from '../../../shared/ghostInstallConsent';
import { GhostInstallConsentContent, GhostInstallConsentHost } from '../GhostInstallConsentHost';
import { ghostHostUiApprovalTokens, ghostHostUiPermissionItems, type GhostManifest } from '../../../shared/ghost';

const mocks = vi.hoisted(() => ({ confirm: vi.fn() }));

vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: mocks.confirm }),
}));

vi.mock('react-i18next', async () => {
  const { createInstance } = await import('i18next');
  const { default: common } = await import('../../i18n/locales/en/common.json');
  const localized = createInstance();
  await localized.init({ lng: 'en', interpolation: { escapeValue: false }, resources: { en: { translation: common } } });
  return ({
  useTranslation: () => ({
    t: (key: string, args?: Record<string, unknown>) =>
      key.startsWith('settings.ghosts.perm.hostUi.') ? localized.t(key, args) :
        args && Object.keys(args).length > 0 ? `${key}:${JSON.stringify(args)}` : key,
  }),
  });
});

type Push = (payload: GhostInstallConsentRequest, ownerStamp?: unknown) => void;

const HOST = {
  key: 'network:host:upload.weather.test',
  kind: 'network' as const,
  labelKey: 'networkHost',
  labelArgs: { host: 'upload.weather.test' },
};

describe('GhostInstallConsentHost', () => {
  let push: Push | undefined;
  let dismiss: ((payload: { requestId: string }) => void) | undefined;
  const resolveInstallConsent = vi.fn();

  beforeEach(() => {
    mocks.confirm.mockReset().mockResolvedValue(true);
    resolveInstallConsent.mockReset().mockResolvedValue({ handled: true });
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      ghosts: {
        onInstallConsentRequest: (callback: Push) => {
          push = callback;
          return () => {};
        },
        onInstallConsentDismissed: (callback: typeof dismiss) => {
          dismiss = callback;
          return () => {};
        },
        resolveInstallConsent,
      },
    };
  });

  afterEach(() => {
    cleanup();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  // #9496 exposed protocol subjects/JSON in consent. Existing tests only cover
  // ordinary permissions. Unit: render real consent with one host declaration;
  // presentation must change without mutating the exact approval projection.
  it('explains host permissions without exposing or changing approval subjects', () => {
    const manifest: GhostManifest = { schemaVersion: 3, id: 'board', name: 'Board', version: '1', kind: 'chip', entry: 'main.js',
      tools: [], mcpApps: { ui: { resources: [{ uri: 'ui://board', file: 'page.html' }], tools: {} },
        host: { views: [{ id: 'board', title: 'Board', resourceUri: 'ui://board', scope: 'task' }],
          contributions: [{ id: 'review', title: 'Review', position: 'message.actions', view: 'board' }],
          capabilities: ['draft'] } } };
    const before = ghostHostUiApprovalTokens(manifest);
    expect(before).toContain(JSON.stringify(['ui:host:capability:draft', 'panel', 'uiHost', [], null,
      'uiHostAccess', [['access', 'draft'], ['subject', 'capability:draft']]]));
    const view = render(<GhostInstallConsentContent facts={{ kind: 'install', ghostId: 'board', name: 'Board',
      version: '1', permissions: ghostHostUiPermissionItems(manifest) }} />);
    expect(screen.getByText('Read and edit the message draft')).toBeTruthy();
    expect(view.container.textContent).toContain('message action bar');
    expect(view.container.textContent).not.toMatch(/capability:|contribution:|\{"|"position"/);
    expect(ghostHostUiApprovalTokens(manifest)).toEqual(before);
  });

  it.each([
    ['capability:context', 'context', 'Read the current task and selected text'],
    ['capability:appearance', 'appearance', 'Change the declared appearance settings'],
    ['capability:visibility', 'visibility', 'Show or hide the window and declared interface regions'],
    ['appearance:bodyFont', 'bodyFont', 'Change the message font'],
    ['appearance-resource:mono', '{"kind":"font","path":"assets/mono.ttf"}', 'Use the font resource “assets/mono.ttf”'],
    ['command:refresh', '{"tool":"refresh","arguments":{"filter":{"done":false}},"shortcut":"Mod+R"}', 'Run tool “refresh”'],
    ['contribution:choose', '{"position":"composer.toolbar","kind":"select","tool":"refresh","match":{"roles":["assistant"],"tools":["refresh"],"plugins":["board"]},"options":["all","open"],"presentation":"popover"}', 'Show a selection list in the input toolbar'],
    ['view:broken', 'not-json', 'Permission details are unavailable'],
  ])('keeps the meaning of %s readable in permission consent', (subject, access, expected) => {
    const view = render(<GhostInstallConsentContent facts={{ kind: 'install', ghostId: 'board', name: 'Board', version: '1',
      permissions: [{ key: `ui:host:${subject}`, kind: 'panel', labelKey: 'uiHost', detailKey: 'uiHostAccess', detailArgs: { subject, access } }] }} />);
    expect(view.container.textContent).toContain(expected);
    expect(view.container.textContent).not.toContain(subject);
    expect(view.container.textContent).not.toMatch(/\{"|"position"|perm\.hostUi\./);
    if (subject === 'command:refresh') {
      expect(view.container.textContent).toContain('Parameters: filter: done: No');
      expect(view.container.textContent).toContain('Shortcut: Mod+R');
    }
    if (subject === 'contribution:choose') {
      for (const text of ['Assistant', 'refresh', 'board', 'all, open', 'Open beside the entry']) expect(view.container.textContent).toContain(text);
    }
  });

  it('shows the added permissions of an update and returns the answer to Main', async () => {
    render(<GhostInstallConsentHost />);
    await act(async () => {
      push?.({
        requestId: 'consent-1',
        initiator: 'user',
        origin: 'custom-market',
        originLabel: 'Team market',
        facts: {
          kind: 'update', ghostId: 'weather-chip', name: 'Weather', version: '2.0.0',
          previousVersion: '1.0.0', added: [HOST], removed: [], unchangedCount: 1,
          builtinOauthClientChanged: false,
        },
      });
    });

    await waitFor(() => expect(resolveInstallConsent).toHaveBeenCalledWith('consent-1', true));
    const options = mocks.confirm.mock.calls[0][0] as {
      title: string;
      description: string;
      confirmText: string;
      content: ReactNode;
    };
    expect(options.title).toBe('settings.ghosts.installConsent.updateTitle:{"name":"Weather"}');
    expect(options.description).toContain('"from":"1.0.0"');
    expect(options.description).toContain('originCustomMarket');
    expect(options.confirmText).toBe('settings.ghosts.installConsent.confirmUpdate');
    render(<>{options.content}</>);
    expect(screen.getByText('settings.ghosts.perm.networkHost:{"host":"upload.weather.test"}')).toBeTruthy();
    expect(screen.getByText('settings.ghosts.installConsent.addedBadge')).toBeTruthy();
  });

  it('shows first-use capability consent without claiming a package update or source', async () => {
    render(<GhostInstallConsentHost />);
    await act(async () => push?.({
      requestId:'tasks', purpose:'task-capability', initiator:'user', origin:'local-file',
      facts:{kind:'update',ghostId:'p',name:'Plugin',version:'1',previousVersion:'1',
        added:[{key:'agent:tasks',kind:'agent',labelKey:'agentTasks',detailKey:'agentTasksDetail'}],
        removed:[],unchangedCount:2,builtinOauthClientChanged:false},
    }));
    const options = mocks.confirm.mock.calls[0][0];
    expect(options.title).toBe('Plugin');
    expect(options.description).toBe('settings.ghosts.installConsent.addedTitle');
    expect(options.confirmText).toBe('settings.ghosts.connections.confirmAllow');
    render(<>{options.content}</>);
    expect(screen.getByText('settings.ghosts.perm.agentTasksDetail')).toBeTruthy();
    expect(screen.queryByText('settings.ghosts.installConsent.updateDescription')).toBeNull();
    await waitFor(()=>expect(resolveInstallConsent).toHaveBeenCalledWith('tasks',true));
  });

  // Shared same-ID packages need a distinct replacement action and accurate
  // state impact even with no added permissions (unit: real Host, fake Main).
  it.each([false, true])('explains shared replacement without changing source rules (sourceChanged=%s)', async sourceChanged => {
    render(<GhostInstallConsentHost />);
    await act(async () => push?.({
      requestId: 'share-replace', purpose: 'share-replace', initiator: 'user', origin: 'local-file',
      target: { namespace: null, sourceChanged, otherCopies: 0 },
      facts: { kind: 'update', ghostId: 'weather-chip', name: 'Weather', version: '1.0.0',
        previousVersion: '1.0.0', added: [], removed: [], unchangedCount: 1, builtinOauthClientChanged: false },
    }));
    const options = mocks.confirm.mock.calls[0][0];
    expect(options.title).toBe('sharing.localReplaceTitle:{"name":"Weather"}');
    expect(options.confirmText).toBe('sharing.localReplaceButton');
    render(<>{options.content}</>);
    expect(screen.getByText('sharing.localReplaceNotice')).toBeTruthy();
    expect(screen.queryByText('sharing.localReplaceRetainsState') !== null).toBe(!sourceChanged);
    expect(screen.queryByText('settings.ghosts.installConsent.sourceChanged') !== null).toBe(sourceChanged);
    await waitFor(() => expect(resolveInstallConsent).toHaveBeenCalledWith('share-replace', true));
  });

  it('answers cancel when Main dismisses the pending dialog', async () => {
    let seenSignal: AbortSignal | undefined;
    mocks.confirm.mockImplementation(
      (_options: unknown, signal: AbortSignal) =>
        new Promise<boolean>((resolve) => {
          seenSignal = signal;
          signal.addEventListener('abort', () => resolve(false));
        }),
    );
    render(<GhostInstallConsentHost />);
    await act(async () => {
      push?.({
        requestId: 'consent-2',
        initiator: 'user',
        origin: 'local-file',
        facts: { kind: 'install', ghostId: 'weather-chip', name: 'Weather', version: '1.0.0', permissions: [] },
      });
    });
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    await act(async () => {
      dismiss?.({ requestId: 'consent-2' });
    });
    expect(seenSignal?.aborted).toBe(true);
    await waitFor(() => expect(resolveInstallConsent).toHaveBeenCalledWith('consent-2', false));
  });
});
