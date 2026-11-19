// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { InlineHtmlPreview } from '../InlineHtmlPreview';

const chat = vi.hoisted(() => ({ getSnapshot: vi.fn(), subscribe: vi.fn(() => () => {}) }));
const closeTab = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@/lib/makerChatStore', () => ({ makerChatStore: chat }));
vi.mock('@/features/right-sidebar/store', () => ({ closeTab }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
const tab = { sessionId: 'session', tabId: 'files', active: true };

// #11392: remote snapshots must receive paths in the source filesystem's format.
// Exercise the public component and the outgoing preview request in both directions.
it.each([
  ['win32', '/home/docs', '/home/docs/out/index.html'],
  ['darwin', 'D:\\docs', 'D:\\docs\\out\\index.html'],
  ['darwin', '//server/share', '\\\\server\\share\\out\\index.html'],
])('requests HTML in %s with workdir %s', async (platform, workdir, expected) => {
  const previewHtml = vi.fn().mockResolvedValue({ url: 'http://localhost/preview/index.html' });
  vi.stubGlobal('electronAPI', {
    platform, fileBrowser: { previewHtml, cancelHtmlPreview: vi.fn().mockResolvedValue({ ok: true }) },
    onRsbBrowserCommand: () => () => {},
  });
  const preview = { ...tab, workdir, relPath: 'out/index.html' };
  const view = render(<InlineHtmlPreview {...preview} />);
  expect(view.container.querySelector('webview')).toBeNull();
  expect(previewHtml).not.toHaveBeenCalled();
  const ssh = platform === 'win32';
  const source = ssh ? { remoteHostId: 'ssh-source' } : { deviceId: 'source' };
  view.rerender(<InlineHtmlPreview {...preview} {...source} />);
  await waitFor(() => expect(previewHtml).toHaveBeenCalledWith(expect.objectContaining({
    origin: { kind: ssh ? 'ssh' : 'device', ...source }, absPath: expected, workdir,
  })));
  expect(view.container.querySelector('webview')?.getAttribute('src')).toBe('http://localhost/preview/index.html');
});

// A completed turn can change the document while its guest has keyboard focus.
// Verify a real turn transition and ensure a shortcut cannot close another pane.
it('reloads the edited local page and closes only its focused file tab', async () => {
  let turnChanged = () => {};
  chat.subscribe.mockImplementation((_id?: string, cb?: () => void) => {
    turnChanged = cb!;
    return () => {};
  });
  chat.getSnapshot.mockReturnValue({ agentStatus: { isRunning: false }, messages: [] });
  let command = (_event: { command: 'close-tab' }) => {};
  vi.stubGlobal('electronAPI', { platform: 'darwin', onRsbBrowserCommand: (cb: typeof command) => {
    command = cb;
    return () => {};
  } });
  const view = render(<InlineHtmlPreview {...tab} workdir="/docs" relPath="index.html" deviceId={null} />);
  const guest = view.container.querySelector<HTMLElement>('webview')!;
  const reload = vi.fn();
  Object.assign(guest, { reload });
  fireEvent(guest, new Event('dom-ready'));
  fireEvent(guest, new Event('did-finish-load'));
  chat.getSnapshot.mockReturnValue({ agentStatus: { isRunning: true }, messages: [] });
  act(() => turnChanged());
  chat.getSnapshot.mockReturnValue({ agentStatus: { isRunning: false }, messages: [
    { clientId: 'edit', role: 'tool_use', toolName: 'Write', toolInput: { file_path: '/docs/index.html' } },
  ] });
  act(() => turnChanged());
  expect(reload).toHaveBeenCalledTimes(1);
  act(() => command({ command: 'close-tab' }));
  expect(closeTab).not.toHaveBeenCalled();
  guest.tabIndex = 0;
  guest.focus();
  act(() => command({ command: 'close-tab' }));
  expect(closeTab).toHaveBeenCalledExactlyOnceWith('session', 'files');
});

// A retained page can miss several completed turns. Only its own edits should
// replace the live document, once, when the user comes back (PR #11392, unit).
it('defers edits to a hidden local preview and leaves an unchanged page alone', () => {
  const listeners = new Set<() => void>();
  chat.subscribe.mockImplementation((_id?: string, cb?: () => void) => {
    listeners.add(cb!);
    return () => { listeners.delete(cb!); };
  });
  chat.getSnapshot.mockReturnValue({ agentStatus: { isRunning: false }, messages: [] });
  vi.stubGlobal('electronAPI', { onRsbBrowserCommand: () => () => {} });
  const preview = { ...tab, workdir: '/notes', relPath: 'draft.html', deviceId: null };
  const view = render(<InlineHtmlPreview {...preview} />);
  const guest = view.container.querySelector('webview')!;
  const reload = vi.fn();
  Object.assign(guest, { reload });
  fireEvent(guest, new Event('did-finish-load'));
  const messages: { clientId: string; role: string; toolName: string; toolInput: { file_path: string } }[] = [];
  function edit(name: string) {
    for (const running of [true, false]) {
      if (!running) messages.push({ clientId: String(messages.length), role: 'tool_use', toolName: 'Write', toolInput: { file_path: `/notes/${name}` } });
      chat.getSnapshot.mockReturnValue({ agentStatus: { isRunning: running }, messages: [...messages] });
      act(() => { for (const notify of listeners) notify(); });
    }
  }
  view.rerender(<InlineHtmlPreview {...preview} active={false} />);
  edit('other.html');
  view.rerender(<InlineHtmlPreview {...preview} />);
  expect(reload).not.toHaveBeenCalled();
  view.rerender(<InlineHtmlPreview {...preview} active={false} />);
  edit('draft.html');
  edit('draft.html');
  expect(reload).not.toHaveBeenCalled();
  view.rerender(<InlineHtmlPreview {...preview} />);
  expect(view.container.querySelector('webview')).toBe(guest);
  expect(reload).toHaveBeenCalledTimes(1);
});

// #11392, unit: the host intercepts these keys even for the inline webview.
it('sends reload and available history navigation only to the focused preview', () => {
  const onCommand = vi.fn<typeof window.electronAPI.onRsbBrowserCommand>(() => () => {});
  vi.stubGlobal('electronAPI', { onRsbBrowserCommand: onCommand });
  const view = render(<InlineHtmlPreview {...tab} workdir="/docs" relPath="index.html" deviceId={null} />);
  const guest = view.container.querySelector<HTMLElement>('webview')!;
  const history = {
    reload: vi.fn(), canGoBack: vi.fn(() => true), goBack: vi.fn(),
    canGoForward: vi.fn(() => false), goForward: vi.fn(),
  };
  Object.assign(guest, history);
  fireEvent(guest, new Event('dom-ready'));
  fireEvent(guest, new Event('did-finish-load'));
  const command = onCommand.mock.lastCall![0];
  act(() => command({ command: 'reload' }));
  expect(history.reload).not.toHaveBeenCalled();
  guest.tabIndex = 0;
  guest.focus();
  act(() => command({ command: 'reload' }));
  act(() => command({ command: 'go-back' }));
  act(() => command({ command: 'go-forward' }));
  expect(history.reload).toHaveBeenCalledTimes(1);
  expect(history.goBack).toHaveBeenCalledTimes(1);
  expect(history.goForward).not.toHaveBeenCalled();
  history.canGoForward.mockReturnValue(true);
  act(() => command({ command: 'go-forward' }));
  expect(history.goForward).toHaveBeenCalledTimes(1);
});

// #11392, unit: a hidden inline preview used to keep playing into another tab.
it('mutes the same page while hidden and restores its previous audio state', () => {
  const visibility = vi.fn<typeof window.electronAPI.onWindowHiddenChange>(() => () => {});
  vi.stubGlobal('electronAPI', { onRsbBrowserCommand: () => () => {}, onWindowHiddenChange: visibility });
  const preview = { ...tab, workdir: '/docs', relPath: 'index.html', deviceId: null };
  const view = render(<InlineHtmlPreview {...preview} />);
  const guest = view.container.querySelector<HTMLElement>('webview')!;
  let muted = false;
  Object.assign(guest, { isAudioMuted: () => muted, setAudioMuted: (value: boolean) => { muted = value; } });
  fireEvent(guest, new Event('dom-ready'));
  view.rerender(<InlineHtmlPreview {...preview} active={false} />);
  expect(muted).toBe(true);
  view.rerender(<InlineHtmlPreview {...preview} />);
  expect(muted).toBe(false);
  const windowHidden = visibility.mock.lastCall![0];
  act(() => windowHidden(true));
  expect(muted).toBe(true);
  act(() => windowHidden(false));
  expect(muted).toBe(false);
  muted = true;
  act(() => windowHidden(true));
  act(() => windowHidden(false));
  expect(muted).toBe(true);
  expect(view.container.querySelector('webview')).toBe(guest);
});

// #11392, unit: file previews use the same recoverable resource/crash surface
// as browser tabs. Drive the actual guest event and click the displayed action.
it('reopens the selected HTML after its renderer is terminated', async () => {
  vi.stubGlobal('electronAPI', { onRsbBrowserCommand: () => () => {} });
  const view = render(<InlineHtmlPreview {...tab} workdir="/docs" relPath="index.html" deviceId={null} />);
  const guest = view.container.querySelector<HTMLElement>('webview')!;
  const loadURL = vi.fn();
  Object.assign(guest, { loadURL });
  await waitFor(() => expect(guest.getAttribute('src')).toContain('index.html'));
  fireEvent(guest, Object.assign(new Event('render-process-gone'), { details: { reason: 'killed' } }));
  const retry = view.getByRole('button', { name: 'rightSidebar.browser.crash.reload' });
  fireEvent.click(retry);
  expect(loadURL).toHaveBeenCalledExactlyOnceWith(guest.getAttribute('src'));
});
