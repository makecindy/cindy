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

function reply(content = '`' + href + '`', deviceId = 'remote-a', workingDir = '/remote/project', origin?: SessionFileOrigin) {
  return <MemoryRouter><Tooltip.Provider>
    <ChatSessionFileProvider value={{ sessionId: 'session', workingDir, origin: origin ?? { kind: 'device', deviceId } }}>
      <MarkdownRenderer content={content} workingDir={workingDir} currentSessionId="session" />
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

  it('retries an authored link and keeps the remote HTML preview destination', async () => {
    invoke.mockRejectedValueOnce(new Error('offline'));
    const view = render(reply('[Read report](' + href + ')'));
    await act(async () => {});
    await act(async () => fireEvent.click(view.getByText('Read report')));
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(openHtmlFileByPreference).toHaveBeenCalledWith('session', resolved, expect.any(Function), expect.objectContaining({ origin: { kind: 'device', deviceId: 'remote-a' } }));
    expect(localResolve).not.toHaveBeenCalled();
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
