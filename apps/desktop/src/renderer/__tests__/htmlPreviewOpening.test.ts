// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';
const mocks = vi.hoisted(() => ({
  sidebar: vi.fn(), preference: vi.fn(() => 'sidebar'), preview: vi.fn(), external: vi.fn(), error: vi.fn(), loading: vi.fn(() => 'loading'), dismiss: vi.fn(),
}));
vi.mock('@/features/right-sidebar/lib/openInSidebarBrowser', () => ({ openUrlInSidebarBrowser: mocks.sidebar }));
vi.mock('@/hooks/useLinkOpenPreference', () => ({ getLinkOpenPreference: mocks.preference, getLinkOpenPreferenceForUrl: mocks.preference }));
vi.mock('@/features/cc-agent/embeddedSessionNavigation', () => ({ useSidebarTargetSessionId: (id: string) => id }));
vi.mock('@/lib/toast', () => ({ toast: { error: mocks.error, loading: mocks.loading, dismiss: mocks.dismiss } }));
import { openHtmlFileByPreference } from '../components/chat/useOpenWithMenu';
const t = ((key: string) => key) as TFunction;
const context = { origin: { kind: 'device' as const, deviceId: 'remote-device' }, workingDir: '/remote' };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.preference.mockReturnValue('sidebar');
  mocks.preview.mockResolvedValue({ ok: true, url: 'http://127.0.0.1:12345/token/' });
  mocks.external.mockResolvedValue({ success: true });
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { fileBrowser: { previewHtml: mocks.preview }, openExternal: mocks.external } });
});
it('prepares the remote directory before opening the built-in browser', async () => {
  await openHtmlFileByPreference('session', '/remote/preview/index.html', t, context);
  expect(mocks.preview).toHaveBeenCalledWith({ origin: context.origin, workdir: '/remote', absPath: '/remote/preview/index.html' });
  expect(mocks.sidebar).toHaveBeenCalledWith('session', 'http://127.0.0.1:12345/token/');
  expect(mocks.external).not.toHaveBeenCalled();
});
it('uses the same preview mechanism for the system browser preference and explicit menu', async () => {
  mocks.preference.mockReturnValue('external');
  await openHtmlFileByPreference('session', '/remote/index.html', t, context);
  expect(mocks.external).toHaveBeenCalledWith('http://127.0.0.1:12345/token/');
  await openHtmlFileByPreference('session', '/remote/index.html', t, context, 'sidebar');
  expect(mocks.sidebar).toHaveBeenCalledTimes(1);
});
it('shows an actionable old-device error and does not open partial content', async () => {
  mocks.preview.mockRejectedValue(new Error('[HTML_PREVIEW_UNSUPPORTED] Unsupported'));
  await openHtmlFileByPreference('session', '/remote/index.html', t, context);
  expect(mocks.error).toHaveBeenCalledWith('chat.remoteFile.previewUnsupported');
  expect(mocks.sidebar).not.toHaveBeenCalled();
  expect(mocks.external).not.toHaveBeenCalled();
});

it.each([false, true])('dismisses neutral loading when preview settles (failure=%s)', async (fails) => {
  vi.useFakeTimers();
  try {
    let settle!: () => void;
    mocks.preview.mockImplementationOnce(() => new Promise((resolve, reject) => {
      settle = () => fails ? reject(new Error('failed')) : resolve({ url: 'http://127.0.0.1/preview/' });
    }));
    const opening = openHtmlFileByPreference('session', '/remote/index.html', t, context);
    await vi.advanceTimersByTimeAsync(600);
    expect(mocks.loading).toHaveBeenCalledWith('chat.remoteFile.previewFetching');
    expect(mocks.error).not.toHaveBeenCalled();
    settle();
    await opening;
    expect(mocks.dismiss).toHaveBeenCalledWith('loading');
    expect(mocks.error).toHaveBeenCalledTimes(fails ? 1 : 0);
  } finally { vi.useRealTimers(); }
});
