// @vitest-environment jsdom
import source from '../../../../preload/preload.ts?raw';
import ts from 'typescript';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { drainPendingDeepLinks } from '@/lib/pendingDeepLinks';
import { ChatInviteHost, requestChatInvite } from '../ChatInviteHost';
import { handleIncomingDeepLink, setDeepLinkMainWindow, takePendingDeepLink } from '../../../../main/deepLink';

vi.mock('electron', () => ({ app: { focus: vi.fn() }, BrowserWindow: class {} }));
vi.mock('../../../../main/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn() }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../botGroupStore', () => ({ refreshBotGroups: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn() } }));

// Execute the actual preload adapter, with its IPC subscription injected. This
// fixture substitutes OS protocol delivery, never registering a real handler.
const start = source.indexOf('  onDeepLinkNavigate: (');
const end = source.indexOf('  // 冷启动时', start);
const compiled = ts.transpileModule(`const bridge = {${source.slice(start, end)}};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

afterEach(() => { cleanup(); setDeepLinkMainWindow(null); });
it('does not pull invitations in a secondary window, leaving the intent for the main window', async () => {
  const take = vi.fn(async () => takePendingDeepLink());
  const receive = vi.fn();
  const token = 'secondary-window-fixture-'.padEnd(43, 'a');
  handleIncomingDeepLink(`cindy://chat-invite/${token}`, 'open-url');
  const previousUrl = window.location.href;
  try {
    window.history.replaceState(null, '', '?secondaryWindow=1');
    await drainPendingDeepLinks(take, receive);
    expect(take).not.toHaveBeenCalled();
    expect(receive).not.toHaveBeenCalled();
  } finally {
    window.history.replaceState(null, '', previousUrl);
  }
  await drainPendingDeepLinks(take, receive);
  expect(receive).toHaveBeenCalledExactlyOnceWith({ type: 'chat-invite', token });
  expect(takePendingDeepLink()).toBeNull();
});

it.each(['darwin', 'win32', 'linux'].flatMap(platform => [false, true].map(alreadyOpen => ({ platform, alreadyOpen }))))(
  'continues an offline browser anchor through preload and the pending queue ($platform, already open: $alreadyOpen)', async ({ platform, alreadyOpen }) => {
  let listener: ((payload: unknown) => void) | undefined;
  const bridge = new Function('fanOutDeepLinkNavigate', 'isDeepLinkProviderConnectId', `${compiled}; return bridge;`)(
    (callback: (payload: unknown) => void) => { listener = callback; return () => { listener = undefined; }; },
    () => false,
  );
  const acceptInvite = vi.fn();
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { maker: { chatServer: { acceptInvite } } } });
  const receive = (payload: { type: string; token?: string }) => {
    if (payload.type === 'chat-invite' && payload.token) requestChatInvite(payload.token);
  };
  const pull = () => drainPendingDeepLinks(async () => takePendingDeepLink(), receive);
  const connect = () => bridge.onDeepLinkNavigate(() => void pull());
  const win = { isDestroyed: () => false, isMinimized: () => false, isVisible: () => true,
    setAlwaysOnTop: vi.fn(), moveTop: vi.fn(), focus: vi.fn(),
    webContents: { isLoading: () => false, send: (_channel: string, payload: unknown) => listener?.(payload) },
  } as unknown as BrowserWindow;
  setDeepLinkMainWindow(alreadyOpen ? win : null);
  if (alreadyOpen) connect();
  const token = 'offline-browser-fixture-'.padEnd(43, 'a');
  const anchor = document.createElement('a');
  anchor.href = `cindy://chat-invite/${token}`;
  anchor.addEventListener('click', event => {
    event.preventDefault();
    // Exercise the platform-specific focus branch on every CI host. Restore
    // process.platform synchronously before any asynchronous renderer work.
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    try {
      Object.defineProperty(process, 'platform', { value: platform });
      handleIncomingDeepLink(anchor.href, 'open-url');
    } finally {
      Object.defineProperty(process, 'platform', descriptor);
    }
  });
  await act(async () => { anchor.click(); anchor.click(); });
  if (!alreadyOpen) {
    expect(listener).toBeUndefined(); // login has not mounted the authenticated consumer
    handleIncomingDeepLink('cindy://focus/desktop-login', 'open-url');
    setDeepLinkMainWindow(win); connect(); await pull();
  }
  render(<MemoryRouter><ChatInviteHost /></MemoryRouter>);
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe(anchor.href);
  expect(acceptInvite).not.toHaveBeenCalled();
  expect(takePendingDeepLink()).toBeNull();
  // Malformed events must not be forwarded by preload.
  listener?.({ type: 'chat-invite', token: '../bad-token' });
  fireEvent.click(screen.getByRole('button', { name: 'bots.close' }));
  expect(screen.queryByRole('dialog')).toBeNull();
});
