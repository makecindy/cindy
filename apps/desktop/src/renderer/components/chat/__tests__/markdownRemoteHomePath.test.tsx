// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { Tooltip } from '@/components/ui/tooltip';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { ChatSessionFileProvider } from '../ChatSessionFileContext';
import { _clearRemotePathVerdictCache } from '@/lib/remoteFileOpen';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { openHtmlFileByPreference } from '../messageLinkActions';
import type { SessionFileOrigin } from '@/lib/sessionFileOrigin';
import { resolveRemoteHomePath } from '@/hooks/useRemoteHomePath';
import { openDirInSidebarFileBrowser } from '@/features/right-sidebar/lib/openInSidebarFileBrowser';
import { toast } from '@/lib/toast';
import { i18n } from '@/i18n';
import { InvokeScheduler } from '../../../../../../../packages/device-link/src/invokeScheduler';

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'home-path-test' } }) }));
vi.mock('react-i18next', async (original) => ({
  ...(await original<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../messageLinkActions', async (original) => ({
  ...(await original<typeof import('../messageLinkActions')>()),
  openHtmlFileByPreference: vi.fn(),
}));
vi.mock('@/features/right-sidebar/lib/openInSidebarFileBrowser', () => ({ openDirInSidebarFileBrowser: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));

const parsedMarkdownLengths = vi.hoisted(() => [] as number[]);
vi.mock('react-markdown', async (original) => {
  const module = await original<typeof import('react-markdown')>();
  return {
    ...module,
    default: (props: Parameters<typeof module.default>[0]) => {
      if (props.children) parsedMarkdownLengths.push(props.children.length);
      return module.default(props);
    },
  };
});

// #11145: real MarkdownRenderer entry, unlike the pure stat-cache tests, must
// turn an inline ~/ reference into an actionable file on its owning device.
// Minimal failing input: `~/Documents/report.html` in /remote/project.
// Unit/DOM tier: synthetic IPC only; this fixture also exercises mounted
// recovery and changing file origins, which static renderer guards cannot.
const href = '~/Documents/report.html';
const resolved = '/Users/remote/Documents/report.html'; // Remote POSIX wire path, not host OS.
const invoke = vi.fn();
const chatStat = vi.fn();
const localResolve = vi.fn();
const events = new Map<string, Set<(value: any) => void>>();
const eventNames = ['onPresenceChanged', 'onStatusChanged', 'onPeerLinkReopened', 'onResponsivenessChanged'];
const emit = (name: string, value: unknown) => events.get(name)?.forEach(listener => listener(value));

function reply(content = '`' + href + '`', deviceId = 'remote-a', workingDir = '/remote/project', origin?: SessionFileOrigin, isStreaming = false) {
  return <MemoryRouter><Tooltip.Provider>
    <ChatSessionFileProvider value={{ sessionId: 'session', workingDir, origin: origin ?? { kind: 'device', deviceId } }}>
      <MarkdownRenderer content={content} workingDir={workingDir} currentSessionId="session" isStreaming={isStreaming} />
    </ChatSessionFileProvider>
  </Tooltip.Provider></MemoryRouter>;
}

beforeEach(() => {
  setDataOwnerGeneration('home-path-test');
  events.clear();
  vi.mocked(openHtmlFileByPreference).mockClear();
  vi.mocked(openDirInSidebarFileBrowser).mockClear();
  vi.mocked(toast.error).mockClear();
  localResolve.mockReset().mockResolvedValue({});
  invoke.mockReset().mockResolvedValue({ status: 'unique', candidates: [resolved], kind: 'file' });
  chatStat.mockReset().mockImplementation(async ({ absPath }) => ({ verdict: absPath === resolved ? 'file' : 'nonfile' }));
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    deviceLink: { invoke, ...Object.fromEntries(eventNames.map(name => [name, (listener: (value: any) => void) => {
      const listeners = events.get(name) ?? new Set();
      events.set(name, listeners);
      listeners.add(listener);
      return () => listeners.delete(listener);
    }])) },
    fileBrowser: { chatStat }, resolvePath: localResolve, resolvePathBatch: localResolve,
  } });
});
afterEach(() => {
  cleanup();
  _clearRemotePathVerdictCache();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  document.documentElement.removeAttribute('data-app-hidden');
});

describe('remote home references', () => {
  it.each(['mount', 'recovery'])('drains many distinct references without starving the device on %s', async boundary => {
    // PR #11154 P2: 141 distinct paths exceed the real shared scheduler's
    // 12 active + 128 queued budget. DOM/unit: use that production scheduler,
    // hold the service reply, then verify every chip and an unrelated action.
    const scheduler = new InvokeScheduler();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const service = (device: string, _channel: string, [args]: [{ href: string }], scheduling?: { background?: boolean }) =>
      scheduler.run(device, scheduling?.background ?? false, 30_000, async () => {
        if (device === 'remote-a') await gate;
        return { status: 'unique', candidates: ['/Users/remote/' + args.href.slice(2)], kind: 'file' };
      });
    invoke.mockImplementation(boundary === 'recovery' ? () => Promise.reject(new Error('offline')) : service);
    chatStat.mockResolvedValue({ verdict: 'file' });
    const content = Array.from({ length: 141 }, (_, i) => '`~/report-' + i + '.html`').join(' ');
    const view = render(reply(content));
    await act(async () => {});
    if (boundary === 'recovery') {
      expect(view.container.querySelector('code[role="button"]')).toBeNull();
      invoke.mockClear().mockImplementation(service);
      await act(async () => emit('onResponsivenessChanged', { deviceId: 'remote-a', unresponsive: false, recovered: true }));
    }
    const dispatchedBeforeReply = invoke.mock.calls.length;
    const pressure = scheduler.snapshot('remote-a');
    let actionRan = false;
    const action = scheduler.run('remote-a', 'foreground', 30_000, async () => { actionRan = true; }).catch(() => {});
    const other = render(reply(undefined, 'remote-b'));
    await act(async () => {});
    const otherReady = !!other.container.querySelector('code[role="button"]');
    const actionRanBeforeReply = actionRan;
    await act(async () => { release(); await action; });
    expect(dispatchedBeforeReply).toBeLessThanOrEqual(2);
    expect(pressure.queued).toBe(0);
    expect(actionRanBeforeReply).toBe(true);
    expect(otherReady).toBe(true);
    expect(view.container.querySelectorAll('code[role="button"]')).toHaveLength(141);
    expect(invoke.mock.calls.filter(([device]) => device === 'remote-a')).toHaveLength(141);
    expect(localResolve).not.toHaveBeenCalled();
  });

  it.each(['hidden', 'unmounted', 'owner-changed'])('drops unsent lookups when %s', async boundary => {
    // Queuing must not move work past its view/account lifetime. Five mounted
    // references leave unsent work behind two held requests; no wall-clock wait.
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    invoke.mockImplementation(async () => { await gate; return { status: 'none', candidates: [] }; });
    const view = render(reply(Array.from({ length: 5 }, (_, i) => '`~/pending-' + i + '.html`').join(' ')));
    await act(async () => {});
    if (boundary === 'hidden') document.documentElement.setAttribute('data-app-hidden', '');
    else if (boundary === 'unmounted') view.unmount();
    else setDataOwnerGeneration('new-owner');
    await act(async () => release());
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(chatStat).not.toHaveBeenCalled();
  });

  it('keeps newly mounted duplicates recoverable when older lookups fill the cache', async () => {
    // Smallest pressure case: the 500-entry cap is occupied by pending lookups,
    // then a new mounted reference must remain registered for recovery.
    // Another device fills this owner-wide cache without occupying the new
    // reference's own bounded dispatch slots.
    let finishOlder!: (value: unknown) => void;
    const older = new Promise(resolve => { finishOlder = resolve; });
    invoke.mockImplementation((_device, _channel, [args]) => args.href === href
      ? Promise.reject(new Error('offline')) : older);
    const pending = Array.from({ length: 500 }, (_, index) =>
      resolveRemoteHomePath('remote-b', '/remote/project', `~/pending-${index}.html`));
    const view = render(reply('`' + href + '` and `' + href + '`'));
    await act(async () => {});
    const initialCalls = invoke.mock.calls.filter(([, , [args]]) => args.href === href).length;
    await act(async () => {
      finishOlder({ status: 'none', candidates: [] });
      await Promise.all(pending);
      invoke.mockResolvedValue({ status: 'unique', candidates: [resolved], kind: 'file' });
      fireEvent.focus(window);
    });
    expect(initialCalls).toBe(1);
    expect(view.container.querySelectorAll('code[role="button"]')).toHaveLength(2);
    expect(invoke.mock.calls.filter(([, , [args]]) => args.href === href)).toHaveLength(2);
  });

  it('resolves on the file owner before verifying and lighting duplicate references', async () => {
    const view = render(reply('`' + href + '` and `' + href + '`'));
    await act(async () => {});
    expect(view.container.querySelectorAll('code[role="button"]')).toHaveLength(2);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('remote-a', 'fs:resolve-path', [{ href, workingDir: '/remote/project' }], { background: true });
    expect(chatStat).toHaveBeenCalledTimes(1);
    expect(chatStat).toHaveBeenCalledWith({ origin: { kind: 'device', deviceId: 'remote-a' }, workdir: '/remote/project', absPath: resolved });
    await act(async () => fireEvent.click(view.container.querySelector('code[role="button"]')!));
    expect(openHtmlFileByPreference).toHaveBeenCalledWith('session', resolved, expect.any(Function), expect.objectContaining({ origin: { kind: 'device', deviceId: 'remote-a' } }));
    expect(localResolve).not.toHaveBeenCalled();
  });

  it.each(['focus', 'onPresenceChanged', 'onPeerLinkReopened', 'onStatusChanged'])('recovers mounted references on %s without local fallback or duplicate calls', async event => {
    invoke.mockRejectedValueOnce(new Error('offline'));
    const view = render(reply('`' + href + '` and `' + href + '`'));
    await act(async () => {});
    expect(view.container.querySelector('code[role="button"]')).toBeNull();
    expect(chatStat).not.toHaveBeenCalled();
    expect(localResolve).not.toHaveBeenCalled();
    await act(async () => {
      emit('onPresenceChanged', { deviceId: 'unrelated', online: true });
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    await act(async () => {
      if (event === 'focus') fireEvent.focus(window);
      else emit(event, { deviceId: 'remote-a', online: true, status: 'online' });
    });
    expect(view.container.querySelectorAll('code[role="button"]')).toHaveLength(2);
    expect(invoke).toHaveBeenCalledTimes(2);
    view.unmount();
    expect([...events.values()].every(listeners => listeners.size === 0)).toBe(true);
    await act(async () => fireEvent.focus(window));
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('discards a pre-reconnection result and leaves another peer untouched', async () => {
    let finish!: (value: unknown) => void;
    invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const a = render(reply());
    const b = render(reply(undefined, 'remote-b'));
    await act(async () => {});
    expect(b.container.querySelector('code[role="button"]')).not.toBeNull();
    await act(async () => {
      emit('onPresenceChanged', { deviceId: 'remote-a', online: true });
      emit('onPeerLinkReopened', { deviceId: 'remote-a' });
      finish({ status: 'unique', candidates: ['/old-owner/report.html'], kind: 'file' });
    });
    expect(a.container.querySelector('code[role="button"]')).not.toBeNull();
    expect(invoke.mock.calls.filter(([device]) => device === 'remote-a')).toHaveLength(2);
    expect(invoke.mock.calls.filter(([device]) => device === 'remote-b')).toHaveLength(1);
    expect(chatStat.mock.calls.some(([args]) => args.absPath === '/old-owner/report.html')).toBe(false);
  });

  it('recovers only the responsive device without a presence, link or focus change', async () => {
    // PR #11154: a circuit-open lookup fails while presence and relay stay online.
    // This production-renderer regression supplies only the recovery event;
    // existing reconnect cases cannot detect this missing event subscription.
    invoke.mockRejectedValue(new Error('DEVICE_UNRESPONSIVE'));
    const a = render(reply('`' + href + '` and `' + href + '`'));
    const b = render(reply(undefined, 'remote-b'));
    await act(async () => {});
    expect(a.container.querySelector('code[role="button"]')).toBeNull();
    expect(b.container.querySelector('code[role="button"]')).toBeNull();
    await act(async () => {
      emit('onResponsivenessChanged', { deviceId: 'remote-a', unresponsive: true, recovered: false });
      emit('onResponsivenessChanged', { deviceId: 'remote-a', unresponsive: false, recovered: false });
      emit('onResponsivenessChanged', { deviceId: 'unrelated', unresponsive: false, recovered: true });
    });
    expect(invoke).toHaveBeenCalledTimes(2);
    document.documentElement.setAttribute('data-app-hidden', '');
    await act(async () => {
      emit('onResponsivenessChanged', { deviceId: 'remote-a', unresponsive: false, recovered: true });
    });
    expect(invoke).toHaveBeenCalledTimes(2);
    document.documentElement.removeAttribute('data-app-hidden');
    invoke.mockResolvedValue({ status: 'unique', candidates: [resolved], kind: 'file' });
    await act(async () => {
      emit('onResponsivenessChanged', { deviceId: 'remote-a', unresponsive: false, recovered: true });
    });
    expect(a.container.querySelectorAll('code[role="button"]')).toHaveLength(2);
    expect(b.container.querySelector('code[role="button"]')).toBeNull();
    expect(invoke.mock.calls.filter(([device]) => device === 'remote-a')).toHaveLength(2);
    expect(invoke.mock.calls.filter(([device]) => device === 'remote-b')).toHaveLength(1);
    a.unmount();
    await act(async () => {
      emit('onResponsivenessChanged', { deviceId: 'remote-a', unresponsive: false, recovered: true });
    });
    expect(invoke).toHaveBeenCalledTimes(3);
    b.unmount();
    expect(events.get('onResponsivenessChanged')?.size).toBe(0);
  });

  it('does not carry a resolved href across device, workdir or owner changes', async () => {
    const view = render(reply());
    await act(async () => {});
    expect(view.container.querySelector('code[role="button"]')).not.toBeNull();
    invoke.mockRejectedValue(new Error('offline'));
    view.rerender(reply(undefined, 'remote-b'));
    expect(view.container.querySelector('code[role="button"]')).toBeNull();
    await act(async () => {});
    view.rerender(reply(undefined, 'remote-a', '/other/project'));
    expect(view.container.querySelector('code[role="button"]')).toBeNull();
    await act(async () => {});
    setDataOwnerGeneration('another-owner');
    view.rerender(reply());
    expect(view.container.querySelector('code[role="button"]')).toBeNull();
    await act(async () => {});
    expect(invoke).toHaveBeenCalledTimes(4);
  });

  it.each([
    { click: {}, browserTarget: undefined },
    { click: { metaKey: true }, browserTarget: 'external' },
  ])('keeps the remote HTML preview destination when retrying an authored link ($browserTarget)', async ({ click, browserTarget }) => {
    invoke.mockRejectedValueOnce(new Error('offline'));
    const view = render(reply('[Read report](' + href + ')'));
    await act(async () => {});
    await act(async () => fireEvent.click(view.getByRole('link', { name: 'Read report' }), click));
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(openHtmlFileByPreference).toHaveBeenCalledWith(
      'session', resolved, expect.any(Function),
      expect.objectContaining({ origin: { kind: 'device', deviceId: 'remote-a' } }), browserTarget,
    );
    expect(localResolve).not.toHaveBeenCalled();
  });

  // DESIGN §14.5: the resolved-chip tests miss links that only resolve after a click.
  // DOM/unit: the real MarkdownRenderer keeps Cmd-click's browser destination
  // when [demo.html](documents/demo.html) first becomes available during lookup.
  it('keeps Cmd-click on a local HTML link when its file is found on click', async () => {
    const view = render(reply('[demo.html](documents/demo.html)', 'unused', '/repo', { kind: 'local' }));
    await act(async () => {});
    localResolve.mockResolvedValueOnce({ status: 'unique', candidates: ['/repo/documents/demo.html'], kind: 'file' });

    await act(async () => fireEvent.click(view.getByRole('link', { name: 'demo.html' }), { metaKey: true }));

    expect(openHtmlFileByPreference).toHaveBeenCalledWith(
      'session', '/repo/documents/demo.html', expect.any(Function),
      expect.objectContaining({ origin: { kind: 'local' } }), 'external',
    );
  });

  it.each([false, true])('distinguishes same-name links across paragraphs without moving their targets (streaming=%s)', async isStreaming => {
    const local = { kind: 'local' } as const;
    const view = render(reply([
      '[guide.html](/workspace/A/docs/guide.html)',
      '[guide.html](/workspace/B/docs/guide.html)',
      '[intro.html](/workspace/A/docs/intro.html)',
    ].join('\n\n'), 'unused', '/workspace/A', local, isStreaming));
    await act(async () => {});
    const links = view.getAllByRole('link');
    expect(links.map(link => link.textContent)).toEqual(['A/docs/guide.html', 'B/docs/guide.html', 'intro.html']);
    localResolve.mockResolvedValueOnce({ status: 'unique', candidates: ['/workspace/B/docs/guide.html'], kind: 'file' });
    await act(async () => fireEvent.click(view.getByRole('link', { name: 'B/docs/guide.html' })));
    expect(openHtmlFileByPreference).toHaveBeenCalledWith(
      'session', '/workspace/B/docs/guide.html', expect.any(Function),
      expect.objectContaining({ origin: local }), undefined,
    );
  });

  // #11851: the real renderer should reuse completed blocks on tail updates.
  // The label tests do not detect reparses. DOM/unit tier, measured in characters.
  it.each([
    ['web links', '[first](https://example.com/a)', '[second](https://example.com/b)'],
    ['images', '![first](/A/guide.png)', '![second](/B/guide.png)'],
    ['fenced code', '~~~text\n[guide.html](/A/guide.html)\n~~~', '~~~text\n[guide.html](/B/guide.html)\n~~~'],
    ['prose', 'First paragraph', 'Second paragraph'],
    ['distinct files', '[a.html](/A/a.html)', '[b.html](/B/b.html)'],
  ])('only reparses the growing tail after completed %s', (_label, first, second) => {
    vi.useFakeTimers();
    try {
      const prefix = [first, 'Completed text. '.repeat(3_500), second, ''].join('\n\n');
      const frame = (tail: string) => reply(prefix + tail, 'unused', '/workspace', { kind: 'local' }, true);
      const view = render(frame('Tail'));
      parsedMarkdownLengths.length = 0;
      view.rerender(frame('Tail updated'));
      act(() => vi.advanceTimersByTime(500));
      expect(view.container.textContent?.endsWith('Tail updated')).toBe(true);
      expect(parsedMarkdownLengths).toEqual(['Tail updated'.length]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['local', 'device'] as const)('opens the authored destination when clicking its code label on %s', async kind => {
    const origin = kind === 'local' ? { kind } : { kind, deviceId: 'remote-a' };
    const authored = '/external/A/guide.html';
    const shadow = '/work/A/guide.html';
    localResolve.mockImplementation(async ({ href: target }) => ({
      status: 'unique', candidates: [target === 'A/guide.html' ? shadow : target], kind: 'file',
    }));
    chatStat.mockImplementation(async ({ absPath }) => ({ verdict: [authored, shadow].includes(absPath) ? 'file' : 'nonfile' }));
    const view = render(reply('[`guide.html`](/external/A/guide.html) [`guide.html`](/external/B/guide.html)', 'remote-a', '/work', origin));
    await act(async () => {});
    await act(async () => fireEvent.click(view.getByText('A/guide.html', { selector: 'code' })));
    expect(openHtmlFileByPreference).toHaveBeenCalledTimes(1);
    expect(vi.mocked(openHtmlFileByPreference).mock.calls[0]?.[1]).toBe(authored);
  });

  it.each([
    ['file URL', '[guide.html](file:///workspace/A/guide.html) [guide.html](file://localhost/workspace/B/guide.html)'],
    ['reference', '[guide.html][a] [guide.html][b]\n\n[a]: /workspace/A/guide.html\n[b]: /workspace/B/guide.html'],
  ])('distinguishes same-name %s links', async (_kind, content) => {
    const view = render(reply(content, 'unused', '/workspace', { kind: 'local' }));
    await act(async () => {});
    expect(view.getAllByRole('link').map(link => link.textContent)).toEqual(['A/guide.html', 'B/guide.html']);
  });

  it('keeps the original heading anchor when a file label is expanded', async () => {
    const view = render(reply('## [guide.html](/a/guide.html)\n\n[guide.html](/b/guide.html) [Jump](#guidehtml)'));
    await act(async () => {});
    const heading = view.getByRole('heading', { name: 'a/guide.html' });
    heading.scrollIntoView = vi.fn();
    await act(async () => fireEvent.click(view.getByRole('link', { name: 'Jump' })));
    expect(heading.scrollIntoView).toHaveBeenCalled();
  });

  it('avoids a label already used for a different file', async () => {
    const view = render(reply('[guide.html](/work/A/guide.html) [guide.html](/work/B/guide.html) [A/guide.html](/else/A/guide.html)'));
    await act(async () => {});
    expect(view.getAllByRole('link').map(link => link.textContent)).toEqual(['work/A/guide.html', 'B/guide.html', 'A/guide.html']);
  });

  it('explains multiple matches when an authored local link is clicked', async () => {
    const view = render(reply('[notes.html](docs/notes.html)', 'unused', '/workspace', { kind: 'local' }));
    await act(async () => {});
    localResolve.mockResolvedValueOnce({ status: 'multiple', candidates: ['/workspace/A/docs/notes.html', '/workspace/B/docs/notes.html'] });
    await act(async () => fireEvent.click(view.getByRole('link', { name: 'notes.html' })));
    expect(toast.error).toHaveBeenCalledWith('chat.markdownRenderer.duplicateFiles');
    expect(openHtmlFileByPreference).not.toHaveBeenCalled();
  });

  it.each(['~/.config', '~/report.html'])('preserves resolved directory kind outside the workdir for %s', async directoryHref => {
    // PR #11154: the owner knows this is a directory, but chatStat cannot inspect
    // paths outside the workdir. Existing file-only fixtures lose this boundary.
    // Unit/DOM: actual renderer click must explain the boundary, not fetch a file.
    invoke.mockResolvedValue({ status: 'unique', candidates: ['/Users/remote/' + directoryHref.slice(2)], kind: 'directory' });
    chatStat.mockResolvedValue({ verdict: 'unknown' });
    const view = render(reply('`' + directoryHref + '`'));
    await act(async () => {});
    await act(async () => fireEvent.click(view.container.querySelector('code[role="button"]')!));
    expect(toast.error).toHaveBeenCalledWith(i18n.t('chat.remoteFile.outsideWorkdir'));
    expect(openHtmlFileByPreference).not.toHaveBeenCalled();
    expect(openDirInSidebarFileBrowser).not.toHaveBeenCalled();
    expect(localResolve).not.toHaveBeenCalled();
  });

  it('keeps directory navigation on authored-link retry when stat is unknown', async () => {
    invoke.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({
      status: 'unique', candidates: ['/remote/project/archive.zip'], kind: 'directory',
    });
    chatStat.mockResolvedValue({ verdict: 'unknown' });
    const view = render(reply('[Open directory](~/archive.zip)'));
    await act(async () => {});
    await act(async () => fireEvent.click(view.getByText('Open directory')));
    expect(openDirInSidebarFileBrowser).toHaveBeenCalledWith('session', 'archive.zip');
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(openHtmlFileByPreference).not.toHaveBeenCalled();
  });

  it('does not override a definitive missing-file stat with an older resolved directory', async () => {
    invoke.mockResolvedValue({ status: 'unique', candidates: [resolved], kind: 'directory' });
    chatStat.mockResolvedValue({ verdict: 'nonfile' });
    const view = render(reply('`' + href + '` and [Open directory](' + href + ')'));
    await act(async () => {});
    expect(view.container.querySelector('code[role="button"]')).toBeNull();
    await act(async () => fireEvent.click(view.getByText('Open directory')));
    expect(toast.error).toHaveBeenCalledWith('chat.markdownRenderer.fileUnavailable');
    expect(openDirInSidebarFileBrowser).not.toHaveBeenCalled();
    expect(openHtmlFileByPreference).not.toHaveBeenCalled();
  });

  it('keeps hidden references idle and retries only when visible again', async () => {
    document.documentElement.setAttribute('data-app-hidden', '');
    const view = render(reply());
    await act(async () => fireEvent.focus(window));
    expect(invoke).not.toHaveBeenCalled();
    document.documentElement.removeAttribute('data-app-hidden');
    await act(async () => fireEvent.focus(window));
    expect(view.container.querySelector('code[role="button"]')).not.toBeNull();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it.each(['file', undefined] as const)('keeps a failed stat bounded after resolving home with kind %s', async kind => {
    // Older resolver replies omit the optional kind; retain their file fallback.
    invoke.mockResolvedValue({ status: 'unique', candidates: [resolved], kind });
    chatStat.mockRejectedValue(new Error('disconnected after home lookup'));
    const view = render(reply());
    await act(async () => {});
    expect(view.container.querySelector('code[role="button"]')).not.toBeNull();
    expect(chatStat).toHaveBeenCalledTimes(1);
    await act(async () => fireEvent.focus(window));
    expect(chatStat).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(localResolve).not.toHaveBeenCalled();
  });

  it.each([
    ['/reports/report.html', { kind: 'device', deviceId: 'remote-a' }, '/reports/report.html'],
    ['./report.html', { kind: 'device', deviceId: 'remote-a' }, '/remote/project/./report.html'],
    ['report.html', { kind: 'ssh', remoteHostId: 'ssh-a' }, '/remote/project/report.html'],
  ] as const)('preserves exact remote resolution for %s / %j', async (path, origin, expected) => {
    chatStat.mockResolvedValue({ verdict: 'file' });
    const view = render(reply('`' + path + '`', 'remote-a', '/remote/project', origin));
    await act(async () => {});
    expect(view.container.querySelector('code[role="button"]')).not.toBeNull();
    expect(chatStat).toHaveBeenCalledWith({ origin, workdir: '/remote/project', absPath: expected });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('keeps local home resolution on the local batch service', async () => {
    localResolve.mockResolvedValue({ [href]: { status: 'unique', candidates: ['/local/Documents/report.html'], kind: 'file' } });
    const view = render(reply(undefined, '', '/local/project', { kind: 'local' }));
    await act(async () => {});
    expect(view.container.querySelector('code[role="button"]')).not.toBeNull();
    expect(localResolve).toHaveBeenCalledWith({ hrefs: [href], workingDir: '/local/project' });
    expect(invoke).not.toHaveBeenCalled();
    expect(chatStat).not.toHaveBeenCalled();
  });
});
