import { describe, expect, it, vi } from 'vitest';
import { MobilePluginPages } from '../mobilePageService.js';
import type { InstalledGhost } from '../../../shared/ghost.js';

function setup() {
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
    const h = setup(), page = await h.open();
    h.service.present(page.pageId, 'practice', { kind: 'preview', url: 'https://example.invalid' });
    await h.invoke('cover', { pageId: page.pageId, hidden: true });
    await h.invoke('suspend', { pageId: page.pageId });
    await expect(h.invoke('cover', { pageId: page.pageId, hidden: false })).rejects.toThrow();
    await expect(h.invoke('post', { pageId: page.pageId, channel: 'practice-ui', data: {} })).rejects.toThrow();
    const resumed = await h.invoke('poll', { pageId: page.pageId, after: 0 });
    expect(resumed.result).toMatchObject({ intents: [] });
    await h.invoke('post', { pageId: page.pageId, channel: 'practice-ui', data: { resumed: true } });
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
