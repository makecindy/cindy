import { describe, expect, it, vi } from 'vitest';
import { MobilePluginPages } from '../mobilePageService.js';
import type { InstalledGhost } from '../../../shared/ghost.js';
import { toGhostPluginDetail } from '../../../renderer/features/plugin/lib/ghostPluginViewModel.js';

function setup(
  projection: Pick<
    ConstructorParameters<typeof MobilePluginPages>[0],
    'setupAssessment' | 'runtimeState' | 'listOrder'
  > = {},
) {
  let owner = 'a',
    now = 1_000,
    revision = 'r1';
  const ghost = {
    manifest: {
      id: 'practice',
      name: 'Practice',
      version: '1',
      panel: { html: 'panel.html' },
      mobile: { channels: ['practice-ui'] },
    },
    enabled: true,
    approval: { state: 'approved', revision: 'r1' },
  } as InstalledGhost;
  const clearUnread = vi.fn(),
    post = vi.fn(),
    disconnect = vi.fn(async () => {}),
    fetch = vi.fn(),
    validateDirectory = vi.fn(async (input: string) =>
      input === '/alias' ? '/real/folder' : input,
    );
  let peerGeneration = 0;
  let unreadAt = 42;
  const service = new MobilePluginPages({
    ...projection,
    captureController: () => {
      const captured = peerGeneration;
      return () => captured === peerGeneration;
    },
    list: () => [ghost],
    revision: () => revision,
    captureOwner: () => {
      const expected = owner;
      return () => expected === owner;
    },
    unread: () => ({ at: unreadAt, summary: 'New course' }),
    clearUnread,
    setEnabled: async (_id, enabled) => {
      ghost.enabled = enabled;
    },
    bundle: async () => [{ path: 'panel.html', mime: 'text/html', size: 3 }],
    asset: async () => ({ mime: 'text/html', base64: 'YWJj' }),
    connect: async () => {},
    post,
    poll: async () => [],
    disconnect,
    fetch,
    validateDirectory,
    resolveMedia: async (_id, _url, current) =>
      current() ? { path: '/media/' + 'a'.repeat(64) + '.png', mediaKind: 'image' } : null,
    fetchPreview: async () => ({ status: 200, mime: 'text/html', bytes: new Uint8Array([65]) }),
    now: () => now,
  });
  const provider = service.provider();
  const invoke = (actionId: string, input = {}, controllerDeviceId = 'phone-a') =>
    provider.invoke!(
      { controllerDeviceId },
      {
        collectionId: 'plugins',
        resourceRef: { collectionId: 'plugins', kind: 'plugin', id: 'practice' },
        actionId,
        input,
        client: { protocolVersion: 1, primitives: ['plugin-page'] },
      },
    );
  const open = async (controller?: string) =>
    (await invoke('open:panel', {}, controller)).result as { pageId: string };
  return {
    service,
    provider,
    invoke,
    open,
    ghost,
    clearUnread,
    post,
    disconnect,
    fetch,
    validateDirectory,
    changePeer: () => {
      peerGeneration += 1;
    },
    markUnread: (at: number) => {
      unreadAt = at;
    },
    changeOwner: () => {
      owner = 'b';
    },
    changeRevision: () => {
      revision = 'r2';
    },
    expire: () => {
      now += 121_000;
    },
  };
}
describe('mobile plugin pages', () => {
  it('adds usage facts to the existing capabilities block and preserves unknown setup on a failed read', async () => {
    const h = setup({
      setupAssessment: () => {
        throw new Error('READ_FAILED');
      },
      runtimeState: () => 'crashed',
    });
    const detail = await h.provider.get!(
      { controllerDeviceId: 'phone-a' },
      {
        ref: { collectionId: 'plugins', kind: 'plugin', id: 'practice' },
        client: { protocolVersion: 1, primitives: ['plugin-capabilities'] },
      },
    );
    expect(detail.blocks?.find((block) => block.id === 'capabilities')?.data).toMatchObject({
      tasks: false,
      mobile: true,
      usage: { taskUsable: false, runtimeIssue: 'crashed', setup: { state: 'unknown' } },
    });
    h.ghost.enabled = false;
    h.ghost.approval = { state: 'invalid' };
    const list = await h.provider.list(
      { controllerDeviceId: 'phone-a' },
      {
        collectionId: 'plugins',
        client: { protocolVersion: 1, primitives: [] },
      },
    );
    expect(list.items[0].actions?.find((action) => action.id === 'enable')?.disabled).toBe(true);
  });
  it('keeps a covered native preview readable but rejects source writes, unread consumption and another controller', async () => {
    const h = setup(),
      page = await h.open();
    h.ghost.manifest.preview = { hosts: ['localhost'] };
    expect(
      h.service.present(page.pageId, 'practice', {
        kind: 'preview',
        url: 'http://localhost:1234/',
      }),
    ).toBe(true);
    const initial = (await h.invoke('poll', { pageId: page.pageId, after: 0 })).result as {
      intents: { id: string }[];
    };
    await h.invoke('cover', { pageId: page.pageId, hidden: true });
    await expect(h.invoke('seen', { pageId: page.pageId, seenAt: 42 })).rejects.toThrow();
    await expect(
      h.invoke('post', { pageId: page.pageId, channel: 'practice-ui', data: {} }),
    ).rejects.toThrow();
    await expect(
      h.invoke('fetch', { pageId: page.pageId, path: '/kv', method: 'PUT', body: '{}' }),
    ).rejects.toThrow();
    const input = {
      pageId: page.pageId,
      intentId: initial.intents[0].id,
      url: 'http://localhost:1234/',
      offset: 0,
    };
    await expect(h.invoke('preview:fetch', input, 'phone-b')).rejects.toThrow();
    expect((await h.invoke('preview:fetch', input)).result).toMatchObject({ base64: 'QQ==' });
    await h.invoke('intent:ack', { pageId: page.pageId, intentId: initial.intents[0].id });
    await expect(h.invoke('preview:fetch', input)).rejects.toThrow();
    expect(h.clearUnread).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it('projects owned media only to the initiating controller and revokes its native request with installation changes', async () => {
    const h = setup(),
      page = await h.open(),
      other = await h.open('phone-b');
    await h.invoke('media:open', {
      pageId: page.pageId,
      url: 'cindy-ghost://practice/preview/' + 'a'.repeat(64) + '.png',
    });
    expect((await h.invoke('poll', { pageId: page.pageId, after: 0 })).result).toMatchObject({
      intents: [{ kind: 'media', mediaKind: 'image' }],
    });
    expect(
      (await h.invoke('poll', { pageId: other.pageId, after: 0 }, 'phone-b')).result,
    ).toMatchObject({ intents: [] });
    h.changeRevision();
    await expect(h.invoke('poll', { pageId: page.pageId, after: 0 })).rejects.toThrow();
  });
  it('does not consume unread on list, details, opening, or polling; only the displayed panel snapshot can clear it', async () => {
    const h = setup();
    const page = await h.open();
    await h.invoke('poll', { pageId: page.pageId, after: 0 });
    expect(h.clearUnread).not.toHaveBeenCalled();
    await expect(h.invoke('seen', { pageId: page.pageId, seenAt: 100 })).rejects.toThrow();
    await h.invoke('seen', { pageId: page.pageId, seenAt: 42 });
    expect(h.clearUnread).toHaveBeenCalledWith('practice', 42);
    h.markUnread(99);
    const updated = (await h.invoke('poll', { pageId: page.pageId, after: 0 })).result as {
      unreadAt: number;
    };
    expect(updated.unreadAt).toBe(99);
    await expect(h.invoke('seen', { pageId: page.pageId, seenAt: 42 })).rejects.toThrow();
    await h.invoke('seen', { pageId: page.pageId, seenAt: 99 });
    expect(h.clearUnread).toHaveBeenLastCalledWith('practice', 99);
  });
  it('isolates two controllers and routes confirmations only to their originating page', async () => {
    const h = setup();
    const a = await h.open(),
      b = await h.open('phone-b');
    const answer = h.service.confirm(a.pageId, {
      ghostId: 'practice',
      ghostName: 'Practice',
      body: 'Delete?',
      danger: true,
      confirmText: null,
      cancelText: null,
    });
    const first = (await h.invoke('poll', { pageId: a.pageId, after: 0 })).result as {
      confirms: { id: string }[];
    };
    const second = (await h.invoke('poll', { pageId: b.pageId, after: 0 }, 'phone-b')).result as {
      confirms: unknown[];
    };
    expect(second.confirms).toEqual([]);
    await expect(
      h.invoke(
        'answer',
        { pageId: a.pageId, confirmId: first.confirms[0].id, confirmed: true },
        'phone-b',
      ),
    ).rejects.toThrow();
    await h.invoke('answer', {
      pageId: a.pageId,
      confirmId: first.confirms[0].id,
      confirmed: false,
    });
    expect(await answer).toBe(false);
    await h.invoke('close', { pageId: a.pageId });
    await expect(
      h.invoke('poll', { pageId: b.pageId, after: 0 }, 'phone-b'),
    ).resolves.toBeDefined();
  });
  it('acknowledges an identical confirm retry without applying an opposite late answer', async () => {
    const h = setup(),
      page = await h.open();
    const settled = h.service.confirm(page.pageId, {
      ghostId: 'practice',
      ghostName: 'Practice',
      body: 'Continue?',
      danger: false,
      confirmText: null,
      cancelText: null,
    });
    const poll = (await h.invoke('poll', { pageId: page.pageId, after: 0 })).result as {
      confirms: { id: string }[];
    };
    const input = { pageId: page.pageId, confirmId: poll.confirms[0].id, confirmed: true };
    await h.invoke('answer', input);
    await expect(h.invoke('answer', input)).resolves.toBeDefined();
    await expect(h.invoke('answer', { ...input, confirmed: false })).rejects.toThrow();
    expect(await settled).toBe(true);
  });
  it('sends a notice only to its originating page and never acknowledges unread', async () => {
    const h = setup(),
      a = await h.open(),
      b = await h.open('phone-b');
    expect(h.service.notify(a.pageId, 'other-plugin', 'Spoof')).toBe(false);
    expect(h.service.notify(a.pageId, 'practice', 'Saved')).toBe(true);
    const first = (await h.invoke('poll', { pageId: a.pageId, after: 0 })).result as {
      notifications: { text: string }[];
    };
    const other = (await h.invoke('poll', { pageId: b.pageId, after: 0 }, 'phone-b')).result as {
      notifications: unknown[];
    };
    expect(first.notifications.map((n) => n.text)).toEqual(['Saved']);
    expect(other.notifications).toEqual([]);
    expect(h.clearUnread).not.toHaveBeenCalled();
  });
  it('does not use a mobile override as a grant for an undeclared main view', async () => {
    const h = setup();
    h.ghost.manifest.mobile!.mainView = 'other.html';
    await expect(h.invoke('open:mainView')).rejects.toThrow();
  });
  it('suspends confirmations when the source is covered, while retaining the page lease', async () => {
    const h = setup(),
      page = await h.open();
    const pending = h.service.confirm(page.pageId, {
      ghostId: 'practice',
      ghostName: 'Practice',
      body: 'Continue?',
      danger: false,
      confirmText: null,
      cancelText: null,
    });
    await h.invoke('suspend', { pageId: page.pageId });
    expect(await pending).toBe(false);
    expect(h.service.notify(page.pageId, 'practice', 'Background toast')).toBe(false);
    await expect(
      h.service.confirm(page.pageId, {
        ghostId: 'practice',
        ghostName: 'Practice',
        body: 'Continue?',
        danger: false,
        confirmText: null,
        cancelText: null,
      }),
    ).rejects.toThrow();
    await h.invoke('poll', { pageId: page.pageId, after: 0 });
    expect(h.service.notify(page.pageId, 'practice', 'Foreground toast')).toBe(true);
  });
  it('drops native cover when suspending and resumes business requests without a lost uncover effect', async () => {
    const h = setup(),
      page = await h.open();
    h.service.present(page.pageId, 'practice', { kind: 'preview', url: 'https://example.invalid' });
    await h.invoke('cover', { pageId: page.pageId, hidden: true });
    await h.invoke('suspend', { pageId: page.pageId });
    await expect(h.invoke('cover', { pageId: page.pageId, hidden: false })).rejects.toThrow();
    await expect(
      h.invoke('post', { pageId: page.pageId, channel: 'practice-ui', data: {} }),
    ).rejects.toThrow();
    const resumed = await h.invoke('poll', { pageId: page.pageId, after: 0 });
    expect(resumed.result).toMatchObject({ intents: [] });
    await h.invoke('post', {
      pageId: page.pageId,
      channel: 'practice-ui',
      data: { resumed: true },
    });
    await h.invoke('seen', { pageId: page.pageId, seenAt: 42 });
    expect(h.post).toHaveBeenCalledOnce();
    expect(h.clearUnread).toHaveBeenCalledWith('practice', 42);
  });
  it.each(['changeOwner', 'changePeer', 'changeRevision', 'expire'] as const)(
    'rejects a stale page after %s before dispatching business data',
    async (change) => {
      const h = setup();
      const page = await h.open();
      h[change]();
      await expect(
        h.invoke('post', { pageId: page.pageId, channel: 'practice-ui', data: { save: true } }),
      ).rejects.toThrow();
      expect(h.post).not.toHaveBeenCalled();
    },
  );
  it('revokes pending confirmation on disable and keeps its answer false', async () => {
    const h = setup(),
      page = await h.open();
    const answer = h.service.confirm(page.pageId, {
      ghostId: 'practice',
      ghostName: 'Practice',
      body: 'Delete?',
      danger: true,
      confirmText: null,
      cancelText: null,
    });
    await h.invoke('disable');
    expect(await answer).toBe(false);
    await expect(
      h.invoke('post', { pageId: page.pageId, channel: 'practice-ui', data: {} }),
    ).rejects.toThrow();
  });
  it('denies unlisted channels, private endpoints and traversal; legacy plugins remain discoverable without acquiring a page', async () => {
    const h = setup(),
      page = await h.open();
    await expect(
      h.invoke('post', { pageId: page.pageId, channel: 'another-plugin', data: {} }),
    ).rejects.toThrow();
    for (const path of ['/secrets', '/oauth/connect', '/__boot__', '/library/../../secrets']) {
      await expect(h.invoke('fetch', { pageId: page.pageId, path })).rejects.toThrow();
    }
    expect(h.fetch).not.toHaveBeenCalled();
    delete h.ghost.manifest.mobile;
    const list = await h.provider.list(
      { controllerDeviceId: 'phone-a' },
      { collectionId: 'plugins', client: { protocolVersion: 1, primitives: [] } },
    );
    expect(list.items).toHaveLength(1);
    expect(list.items[0].actions?.some((action) => action.id.startsWith('open:'))).toBe(false);
    await expect(h.open()).rejects.toThrow();
  });
});

describe('native remote plugin directory consent', () => {
  it('returns only an explicitly selected and Host-validated directory to the originating page', async () => {
    const h = setup(),
      a = await h.open(),
      b = await h.open('phone-b');
    const result = h.service.chooseDirectory(a.pageId, 'practice', 'Choose project');
    const poll = (await h.invoke('poll', { pageId: a.pageId, after: 0 })).result as {
      directories: { id: string }[];
    };
    const other = (await h.invoke('poll', { pageId: b.pageId, after: 0 }, 'phone-b')).result as {
      directories: unknown[];
    };
    expect(other.directories).toEqual([]);
    const requestId = poll.directories[0].id;
    await expect(
      h.invoke('answer-directory', { pageId: a.pageId, requestId, path: '/alias' }, 'phone-b'),
    ).rejects.toThrow();
    await h.invoke('answer-directory', { pageId: a.pageId, requestId, path: '/alias' });
    expect(await result).toBe('/real/folder');
    expect(h.validateDirectory).toHaveBeenCalledTimes(1);
    await h.invoke('answer-directory', { pageId: a.pageId, requestId, path: '/alias' });
    expect(h.validateDirectory).toHaveBeenCalledTimes(1);
    await expect(
      h.invoke('answer-directory', { pageId: a.pageId, requestId, path: '/another' }),
    ).rejects.toThrow();
  });
  it('cancels waiting selection and rejects a late validation after suspension or account replacement', async () => {
    const h = setup(),
      a = await h.open();
    const result = h.service.chooseDirectory(a.pageId, 'practice', null);
    const poll = (await h.invoke('poll', { pageId: a.pageId, after: 0 })).result as {
      directories: { id: string }[];
    };
    let finish!: (path: string) => void;
    h.validateDirectory.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const answer = h.invoke('answer-directory', {
      pageId: a.pageId,
      requestId: poll.directories[0].id,
      path: '/alias',
    });
    await h.invoke('suspend', { pageId: a.pageId });
    finish('/real/folder');
    await expect(answer).rejects.toThrow();
    expect(await result).toBeNull();
    await h.invoke('poll', { pageId: a.pageId, after: 0 });
    const next = h.service.chooseDirectory(a.pageId, 'practice', null);
    h.changeOwner();
    h.service.invalidate();
    expect(await next).toBeNull();
  });
});

it('projects optional Host ordering facts without changing legacy lists on metadata failure', async () => {
  const h = setup({ listOrder: () => new Map([['practice', { addedAt: 1234, recentIndex: 0 }]]) });
  const request = { collectionId: 'plugins', client: { protocolVersion: 1, primitives: [] } };
  const result = await h.provider.list({ controllerDeviceId: 'phone-a' }, request);
  expect(result.items[0].pluginOrder).toEqual({ addedAt: 1234, recentIndex: 0 });
  const broken = setup({ listOrder: () => { throw new Error('READ_FAILED'); } });
  expect((await broken.provider.list({ controllerDeviceId: 'phone-a' }, request)).items[0].pluginOrder).toBeUndefined();
});


it('projects PC permission facts in the phone locale, excludes tools and keeps OAuth scopes', async () => {
  const h = setup();
  h.ghost.manifest.tools = [{name: 'calendar_events', description: 'Read events', parameters: {type: 'object'}}];
  h.ghost.manifest.network = {
    hosts: ['calendar.example'],
    secrets: [{key: 'account', label: 'Calendar account', source: 'oauth', inject: {header: 'Authorization', format: 'Bearer {value}'}, oauth: {
      clientId: 'public-client-id', authorizeUrl: 'https://accounts.example/authorize',
      tokenUrl: 'https://accounts.example/token', scopes: ['calendar.read'],
    }}],
  };
  const detail = await h.provider.get!({controllerDeviceId: 'phone-a'}, {
    ref: {collectionId: 'plugins', kind: 'plugin', id: 'practice'},
    client: {protocolVersion: 1, primitives: ['plugin-capabilities'], locale: 'zh-CN'},
  });
  const facts = detail.blocks?.find(block => block.id === 'capabilities')?.data as {tools: unknown[]; permissions: Array<{title: string; description: string}>};
  expect(facts.tools).toEqual([{name: 'calendar_events', description: 'Read events'}]);
  expect(facts.permissions.some(item => item.title.includes('calendar.example'))).toBe(true);
  expect(facts.permissions.some(item => item.description.includes('calendar.read'))).toBe(true);
  expect(JSON.stringify(facts.permissions)).not.toContain('calendar_events');
  expect(JSON.stringify(facts.permissions)).not.toContain('public-client-id');
  expect(JSON.stringify(facts.permissions)).not.toContain('settings.ghosts.perm');
  expect(JSON.stringify(facts.permissions)).not.toContain('{{');
  expect(facts.permissions.some(item => /[\u4e00-\u9fff]/.test(item.title))).toBe(true);
});


it('projects the same installed Details as PC, with factual unsigned trust and no invented panel status', async () => {
  const h = setup();
  h.ghost.manifest.author = 'Cindy';
  h.ghost.manifest.version = '1.3.13';
  h.ghost.manifest.settingsHtml = 'settings.html';
  h.ghost.dir = '/plugin-install/practice';
  delete h.ghost.manifest.panel;
  const read = async () => {
    const detail = await h.provider.get!({controllerDeviceId: 'phone-a'}, {
      ref: {collectionId: 'plugins', kind: 'plugin', id: 'practice'},
      client: {protocolVersion: 1, primitives: ['plugin-capabilities'], locale: 'en'},
    });
    return (detail.blocks?.find(block => block.id === 'capabilities')?.data as {details: Array<{key: string; title: string; value: string}>}).details;
  };
  const pc = toGhostPluginDetail(h.ghost);
  const facts = await read();
  const values = Object.fromEntries(facts.map(fact => [fact.key, fact.value]));
  expect(values).toMatchObject({version: 'v' + pc.version, author: pc.author, identifier: pc.id, location: pc.installDir, trust: 'Unverified / unsigned', panel: 'This plugin has no panel'});
  expect(facts.map(fact => fact.title)).toEqual(['Version', 'Author', 'Source & signature', 'Identifier', 'Contains', 'Panel', 'Install location']);
  expect(values.contents).toBe('Custom settings UI · Executable code');
  h.ghost.trust = {level: 'unverified', publisherSigned: true, publisherVerified: false, reviewed: false, publisherName: 'Independent publisher', publisherKeyId: 'not-a-display-field'};
  const signed = await read();
  expect(signed.find(fact => fact.key === 'trust')?.value).toBe('Signed, but publisher identity is unverified: Independent publisher');
  expect(JSON.stringify(signed)).not.toContain('not-a-display-field');
  h.ghost.manifest.panel = {html: 'panel.html', position: 'tab'};
  expect((await read()).find(fact => fact.key === 'panel')?.value).toBe('Panel');
});
