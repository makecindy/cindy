// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { HOST_UI_POSITIONS, type GhostHostUi, type GhostHostUiSetting } from '@cindy/plugin-protocol';

import type { GhostInstallConsentRequest } from '../../../shared/ghostInstallConsent';
import { GhostInstallConsentContent, GhostInstallConsentHost } from '../GhostInstallConsentHost';
import { GhostConfirmDialogHost } from '../GhostConfirmDialogHost';
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

// Use the real manifest projection so new supported fields cannot disappear in copy.
function hostPermissionText(host: GhostHostUi, subject: string): string {
  const manifest: GhostManifest = { schemaVersion: 3, id: 'board', name: 'Board', version: '1', kind: 'chip', entry: 'main.js',
    tools: [{ name: 'refresh', description: 'Refresh items' }],
    mcpApps: { ui: { resources: [{ uri: 'ui://board', file: 'page.html' }], tools: {} },
      host: { views: [{ id: 'board', title: 'Board', resourceUri: 'ui://board', scope: 'global' }], ...host } } };
  const tokens = ghostHostUiApprovalTokens(manifest);
  const item = ghostHostUiPermissionItems(manifest).find(permission => permission.detailArgs?.subject === subject);
  expect(item).toBeDefined();
  const before = JSON.stringify(item);
  const view = render(<GhostInstallConsentContent facts={{ kind: 'install', ghostId: 'board', name: 'Board', version: '1', permissions: [item!] }} />);
  const text = view.container.textContent ?? '';
  expect(text).not.toContain(subject);
  expect(text).not.toMatch(/\{"|perm\.hostUi\./);
  expect(JSON.stringify(item)).toBe(before);
  expect(ghostHostUiApprovalTokens(manifest)).toEqual(tokens);
  view.unmount();
  return text;
}

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

  // Node Host can retract a dialog when its controller disconnects or plugin
  // stops. A late UI promise must answer false, even after it yielded true.
  it('retracts a pending Host tool dialog and rejects a late affirmative UI result', async () => {
    let request: Parameters<typeof window.electronAPI.ghosts.onConfirmRequest>[0] | undefined;
    let dismiss: ((payload: { requestId: string }) => void) | undefined;
    let finish: ((value: boolean) => void) | undefined;
    const resolveConfirm = vi.fn(async () => ({ handled: false }));
    const unsubscribeDismiss = vi.fn();
    const subscribeDismiss = vi.fn((callback: typeof dismiss) => { dismiss = callback; return unsubscribeDismiss; });
    const subscribeConnection = vi.fn();
    Object.assign(window.electronAPI, { hostConnection: { client: 'desktop', onStateChanged: subscribeConnection, retry() {} } });
    Object.assign(window.electronAPI.ghosts, {
      onConfirmRequest: (callback: typeof request) => { request = callback; return () => {}; },
      onConfirmDismissed: subscribeDismiss,
      resolveConfirm,
    });
    mocks.confirm.mockImplementation(() => new Promise<boolean>(resolve => { finish = resolve; }));
    render(<GhostConfirmDialogHost />);
    // Performance regression: mounting the app without any dialog must not add
    // the new dismissal subscription. Keep it only for an actual pending answer.
    expect(subscribeDismiss).not.toHaveBeenCalled();
    await act(async () => request?.({ requestId: 'command', ghostId: 'demo', ghostName: 'Demo',
      body: 'Run terminal_start', confirmText: null, cancelText: null, danger: false }));
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(subscribeDismiss).toHaveBeenCalledOnce();
    expect(subscribeConnection).not.toHaveBeenCalled();
    const signal = mocks.confirm.mock.calls[0][1] as AbortSignal;
    await act(async () => { dismiss?.({ requestId: 'command' }); finish?.(true); });
    expect(signal.aborted).toBe(true);
    await waitFor(() => expect(resolveConfirm).toHaveBeenCalledWith('command', false));
    expect(unsubscribeDismiss).toHaveBeenCalledOnce();
  });

  // #9825 / 4560074079: a disconnected browser cannot receive the Host's
  // dismissal. Existing dismissal tests miss this. Unit: real dialog hosts,
  // two pending requests (visible/queued), late answers and a fresh connection.
  it.each(['operation', 'permission'] as const)('cancels browser %s dialogs on disconnect without retaining idle observers', async kind => {
    type ConnectionListener = Parameters<NonNullable<typeof window.electronAPI.hostConnection>['onStateChanged']>[0];
    let connection: ConnectionListener | undefined;
    const unsubscribe = vi.fn(() => { connection = undefined; });
    const subscribe = vi.fn((listener: ConnectionListener) => {
      connection = listener;
      listener({ status: 'connected', connection: 1, recovery: 0 });
      return unsubscribe;
    });
    Object.assign(window.electronAPI, { hostConnection: { client: 'browser', onStateChanged: subscribe, retry() {} } });
    let operation: Parameters<typeof window.electronAPI.ghosts.onConfirmRequest>[0] | undefined;
    const resolveConfirm = vi.fn(async () => ({ handled: false }));
    Object.assign(window.electronAPI.ghosts, {
      onConfirmRequest: (listener: typeof operation) => { operation = listener; return () => {}; },
      onConfirmDismissed: () => () => {}, resolveConfirm,
    });
    const finishes: Array<(answer: boolean) => void> = [];
    mocks.confirm.mockImplementation(() => new Promise<boolean>(resolve => { finishes.push(resolve); }));
    render(kind === 'operation' ? <GhostConfirmDialogHost /> : <GhostInstallConsentHost />);
    expect(subscribe).not.toHaveBeenCalled();
    const request = (requestId: string) => kind === 'operation'
      ? operation?.({ requestId, ghostId: 'demo', ghostName: 'Demo', body: 'Run', confirmText: null, cancelText: null, danger: false })
      : push?.({ requestId, initiator: 'user', origin: 'local-file',
        facts: { kind: 'install', ghostId: 'demo', name: 'Demo', version: '1', permissions: [] } });
    await act(async () => { request('visible'); request('queued'); });
    const signals = mocks.confirm.mock.calls.map(call => call[1] as AbortSignal);
    expect(signals).toHaveLength(2);
    expect(signals.every(signal => !signal.aborted)).toBe(true);
    await act(async () => { connection?.({ status: 'disconnected', connection: 1, recovery: 0 }); });
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(subscribe).toHaveBeenCalledOnce();
    await act(async () => { for (const finish of finishes) finish(true); });
    const resolve = kind === 'operation' ? resolveConfirm : resolveInstallConsent;
    expect(resolve.mock.calls).toEqual([['visible', false], ['queued', false]]);
    expect(unsubscribe).toHaveBeenCalledOnce();
    await act(async () => { request('fresh'); finishes.at(-1)?.(true); });
    expect(resolve).toHaveBeenLastCalledWith('fresh', true);
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(unsubscribe).toHaveBeenCalledTimes(2);
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
      expect(view.container.textContent).toContain('Parameters: Fields (“filter”: Fields (“done”: No))');
      expect(view.container.textContent).toContain('Shortcut: Mod+R');
    }
    if (subject === 'contribution:choose') {
      for (const text of ['Assistant', 'refresh', 'board', 'List [“all”, “open”]', 'Open beside the entry']) expect(view.container.textContent).toContain(text);
    }
  });

  // Tool arguments with different types must not look identical when approved.
  it('preserves parameter types and grouping in the readable permission text', () => {
    const values: unknown[] = [
      ['a', 'b'], ['a, b'], 'a, b', { a: { b: 'c' } }, { 'a: b': 'c' }, null, '—',
      [], {}, '', 1, '1', false, 'No', 'No value', 'List []', 'Fields ()',
      ['a”, “b'], ['a\\”, “b'], ['a\n', 'b'], ['a\\n', 'b'], { 'a”; “b': 'c' },
    ];
    const texts = values.map(tags => {
      const permissions = [{ key: 'ui:host:command:refresh', kind: 'panel' as const, labelKey: 'uiHost', detailKey: 'uiHostAccess',
        detailArgs: { subject: 'command:refresh', access: JSON.stringify({ tool: 'refresh', arguments: { tags } }) } }];
      const before = JSON.stringify(permissions);
      const view = render(<GhostInstallConsentContent facts={{ kind: 'install', ghostId: 'board', name: 'Board', version: '1', permissions }} />);
      const text = view.container.textContent;
      expect(JSON.stringify(permissions)).toBe(before);
      view.unmount();
      return text;
    });
    expect(new Set(texts).size).toBe(values.length);
  });

  it('explains every currently supported position without exposing translation keys', () => {
    const texts = HOST_UI_POSITIONS.map(position => hostPermissionText({ contributions: [{ id: 'entry', title: 'Entry', position,
      ...(position === 'composer.completion' ? { tool: 'refresh', trigger: '/' as const } :
        position === 'composer.attachment' ? { tool: 'refresh', accept: { extensions: ['.pdf'] } } : { view: 'board' }),
    }] }, 'contribution:entry'));
    expect(new Set(texts).size).toBe(HOST_UI_POSITIONS.length);
  });

  it('distinguishes setting identities, types, bounds and available values', () => {
    const common = { id: 'limit', title: 'Limit' };
    const settings: GhostHostUiSetting[] = [
      { ...common, type: 'number', default: 0, min: 0, max: 10 },
      { ...common, type: 'number', default: 1, min: 1, max: 10 },
      { ...common, type: 'number', default: 0, min: 0, max: 20 },
      { ...common, id: 'other-limit', type: 'number', default: 0, min: 0, max: 10 },
      { ...common, type: 'boolean', default: false },
      { ...common, type: 'string', default: 'a', maxLength: 2 },
      { ...common, type: 'string', default: 'a', maxLength: 3 },
      { ...common, type: 'string', default: 'a', maxLength: 2, options: [{ label: 'A', value: 'a' }] },
      { ...common, type: 'string', default: 'b', maxLength: 2, options: [{ label: 'B', value: 'b' }] },
    ];
    const texts = settings.map(field => hostPermissionText({ settings: [field] }, `setting:${field.id}`));
    for (const text of texts) { expect(text).toContain('setting'); expect(text).not.toContain('command'); }
    expect(texts[0]).toContain('Minimum: 0');
    expect(texts[0]).toContain('Maximum: 10');
    expect(texts[5]).toContain('Maximum characters: 2');
    expect(new Set(texts).size).toBe(settings.length);
  });

  it('distinguishes attachment filters and completion prefixes', () => {
    const filters = [{ extensions: ['.pdf'] }, { extensions: ['.txt'] },
      { mimeTypes: ['application/pdf'] }, { mimeTypes: ['*/*'] },
      { extensions: ['.pdf'], mimeTypes: ['application/pdf'] }, { extensions: ['.txt'], mimeTypes: ['application/pdf'] }];
    const texts = filters.map(accept => hostPermissionText({ contributions: [{ id: 'attach', title: 'Attach',
      position: 'composer.attachment', tool: 'refresh', accept }] }, 'contribution:attach'));
    expect(new Set(texts).size).toBe(filters.length);
    const prefixes = (['/', '@'] as const).map(trigger => hostPermissionText({ contributions: [{ id: 'complete', title: 'Complete',
      position: 'composer.completion', tool: 'refresh', trigger }] }, 'contribution:complete'));
    expect(prefixes[0]).not.toBe(prefixes[1]);
    expect(prefixes[0]).toContain('Completion prefix: “/”');
  });

  it('keeps named approval subjects distinguishable when their targets are unchanged', () => {
    for (const kind of ['view', 'command', 'contribution', 'appearance-resource']) {
      const texts = ['first', 'second'].map(id => {
        const host: GhostHostUi = kind === 'view' ? { views: [{ id, title: 'Same', resourceUri: 'ui://board', scope: 'global' }] } :
          kind === 'command' ? { commands: [{ id, title: 'Same', tool: 'refresh' }] } :
          kind === 'contribution' ? { contributions: [{ id, title: 'Same', position: 'message.actions', view: 'board' }] } :
          { appearance: { fields: ['uiFont'], resources: [{ id, kind: 'font', path: 'font.ttf' }] } };
        return hostPermissionText(host, `${kind}:${id}`);
      });
      expect(texts[0]).not.toBe(texts[1]);
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
