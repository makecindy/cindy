// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __testing, setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { PluginUiPageView } from '../PluginUiPageView';

const pageId = '98a39be7-0e86-4bb4-a3ad-57b04035bc57';
const props = { sessionId: 'task', viewId: 'view', revision: '1', title: 'Plugin page', fallback: <span>Original</span> };
const openPage = vi.fn();
const closePage = vi.fn();

beforeEach(() => {
  __testing.reset();
  openPage.mockReset(); closePage.mockReset();
  closePage.mockResolvedValue(undefined);
  vi.stubGlobal('electronAPI', { ghosts: { ui: { openPage, closePage } } });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('PluginUiPageView', () => {
  it('mounts the bound sandbox and closes it when the view leaves', async () => {
    openPage.mockResolvedValue(pageId);
    const { unmount } = render(<PluginUiPageView {...props}><span>Available original</span></PluginUiPageView>);
    expect(screen.getByText('Original')).toBeTruthy();
    const frame = await screen.findByTitle('Plugin page') as HTMLIFrameElement;
    expect(openPage).toHaveBeenCalledWith({ sessionId: 'task', viewId: 'view', revision: '1' });
    expect(frame.getAttribute('src')).toBe(`cindy-mcp-app://${pageId}/sandbox`);
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-forms');
    expect(screen.getByText('Available original')).toBeTruthy();
    unmount();
    await waitFor(() => expect(closePage).toHaveBeenCalledExactlyOnceWith({ pageId }));
  });

  it('closes a page returned after the original view or owner has changed', async () => {
    let resolve!: (id: string) => void;
    openPage.mockReturnValue(new Promise<string>(done => { resolve = done; }));
    const { unmount } = render(<PluginUiPageView {...props} />);
    unmount(); resolve(pageId);
    await waitFor(() => expect(closePage).toHaveBeenCalledExactlyOnceWith({ pageId }));

    closePage.mockClear();
    openPage.mockReturnValue(new Promise<string>(done => { resolve = done; }));
    render(<PluginUiPageView {...props} />);
    setDataOwnerGeneration('new-owner'); resolve(pageId);
    await waitFor(() => expect(closePage).toHaveBeenCalledExactlyOnceWith({ pageId }));
    expect(screen.queryByTitle('Plugin page')).toBeNull();
  });

  it('falls back on open failure or a failure from this sandbox, ignoring other frames', async () => {
    openPage.mockRejectedValueOnce(new Error('unavailable'));
    const first = render(<PluginUiPageView {...props} />);
    await waitFor(() => expect(openPage).toHaveBeenCalledTimes(1));
    expect(screen.getByText('Original')).toBeTruthy();
    first.unmount();

    openPage.mockResolvedValueOnce(pageId);
    render(<PluginUiPageView {...props} />);
    const frame = await screen.findByTitle('Plugin page') as HTMLIFrameElement;
    fireEvent(window, new MessageEvent('message', { data: { method: 'ui/notifications/sandbox-failed' }, source: window }));
    expect(screen.getByTitle('Plugin page')).toBeTruthy();
    fireEvent(window, new MessageEvent('message', { data: { method: 'ui/notifications/sandbox-failed' }, source: frame.contentWindow }));
    await screen.findByText('Original');
    await waitFor(() => expect(closePage).toHaveBeenCalledExactlyOnceWith({ pageId }));
  });
});
