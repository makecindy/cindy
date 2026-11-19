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
