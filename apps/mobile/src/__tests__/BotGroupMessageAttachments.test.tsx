// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolveRemoteMediaFn } from '@/session/remoteMedia';
import { openBrowserAsync } from 'expo-web-browser';

// Keep the real group attachment, AttachmentStrip, MediaPreview and LegendList hooks.
// Only native surfaces and unrelated viewers are replaced for Node rendering.
const imageEvents = vi.hoisted(() => new Map<string, { onLoad: (event: unknown) => void; onError: () => void; onDisplay: () => void; transition: number }>());
vi.mock('expo-web-browser', () => ({ openBrowserAsync: vi.fn(async () => ({})) }));
vi.mock('react-native', async () => {
  const React = await import('react');
  const view = ({ children, testID, accessibilityLabel, onPress, style }: any) => React.createElement('div', { 'data-testid': testID, 'aria-label': accessibilityLabel, onClick: onPress, style: Object.assign({}, ...[style].flat(Infinity).filter(Boolean)) }, children);
  class Value { constructor(public value: number) {} interpolate() { return 0; } setValue() {} stopAnimation() {} }
  return {
    View: view, Text: view, Pressable: view, ScrollView: view, Modal: () => null,
    Image: Object.assign(view, { getSize() {} }), ActivityIndicator: view,
    Animated: { Value, View: view, Text: view, createAnimatedComponent: (c: any) => c,
      timing: () => ({ start() {}, stop() {} }), loop: () => ({ start() {}, stop() {} }), sequence: () => ({ start() {}, stop() {} }) },
    Platform: { OS: 'ios', select: (s: any) => s.ios ?? s.default },
    StyleSheet: { create: (s: any) => s, flatten: (s: any) => s, hairlineWidth: 1 },
    Easing: { linear: (n: number) => n, bezier: () => (n: number) => n },
    AccessibilityInfo: {}, Alert: {}, Linking: {}, StatusBar: {},
    useWindowDimensions: () => ({ width: 402, height: 874, scale: 3, fontScale: 1 }),
  };
});
vi.mock('lucide-react-native', () => ({
  Image: () => null, ImageOff: () => null, Database: () => null, FileArchive: () => null, FileAudio: () => null, FileChartColumn: () => null,
  FileCode: () => null, FileImage: () => null, FileSpreadsheet: () => null, FileText: () => null, FileVideo: () => null,
  ArrowLeftRight: () => null, ArrowUp: () => null, Bot: () => null, Check: () => null, ChevronDown: () => null, ChevronRight: () => null, ChevronUp: () => null, Circle: () => null, CircleAlert: () => null, CircleCheck: () => null, CircleDashed: () => null, CircleStop: () => null, Copy: () => null, Ellipsis: () => null, ExternalLink: () => null, File: () => null, Ghost: () => null, Layers: () => null, ListTodo: () => null, LoaderCircle: () => null, PencilLine: () => null, RefreshCw: () => null, Send: () => null, Share: () => null, Sparkles: () => null, Split: () => null, Timer: () => null, Trash2: () => null, TriangleAlert: () => null, Undo2: () => null, X: () => null,
}));
vi.mock('react-native-svg', () => ({ default: () => null, Circle: () => null }));
vi.mock('react-native-uitextview', () => ({ UITextView: () => null }));
vi.mock('expo-image', async () => {
  const { createElement } = await import('react');
  return { Image: ({ source, onLoad, onError, onDisplay, transition, style }: any) => {
    imageEvents.set(source.uri, { onLoad, onError, onDisplay, transition });
    const frame = Object.assign({}, ...[style].flat().filter(Boolean));
    return createElement('img', { src: source.uri, 'data-width': frame.width, 'data-height': frame.height });
  } };
});
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }), useFocusEffect: vi.fn(), useNavigation: () => ({ isFocused: () => true, addListener: () => () => {} }) }));
vi.mock('@/device-link/DeviceLinkContext', () => ({
  useDeviceLink: () => ({ status: 'offline', connectionEpoch: 0, getPresenceAvailability: () => false,
    invoke: vi.fn(), openLink: vi.fn() }),
  subscribeRemoteBotChanges: () => () => {},
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@/theme', async () => {
  const tokens = await import('@/theme/tokens');
  const colors = new Proxy({}, { get: () => '#777777' });
  return { ...tokens, monoFont: 'monospace', useTheme: () => ({ colors, mode: 'light' }), useThemedStyles: (make: any) => make(colors) };
});
vi.mock('@/components/AppText', async () => ({ Text: (await import('react-native')).Text, MAX_FONT_SIZE_MULTIPLIER: 2 }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ accountGeneration: 1 }) }));
vi.mock('@/session/usePluginResultCard', () => ({ usePluginResultCard: () => ({}), useSessionPluginResource: () => ({ title: 'Art' }) }));
vi.mock('@/session/remoteMediaDiskCacheExpo', () => ({ downloadRemoteMediaShareTemp: vi.fn() }));
vi.mock('@/hooks/useReduceMotion', () => ({ useReduceMotionEnabled: () => true }));
vi.mock('@/session/expandedBlockMemory', () => ({ useFoldableExpandedState: () => [false, vi.fn()] }));
vi.mock('@/platform/chrome', () => ({ NativePullDownMenu: () => null, showActionMenu: vi.fn(), usesNativePullDownMenu: () => false, usesSystemActionMenu: () => false }));
vi.mock('@/session/MobileComposerInputRow', () => ({ MobileComposerInputRow: () => null, MOBILE_COMPOSER_VOICE_ANCHOR_RIGHT: 0, MOBILE_COMPOSER_CONTROL_SIZE: 44 }));
vi.mock('@/session/ImageLightbox', async () => {
  const { createElement } = await import('react');
  return { ImageLightbox: ({ initialUrl }: { initialUrl: string }) => createElement('div', { 'data-testid': 'lightbox', 'data-url': initialUrl }) };
});
vi.mock('@/session/McpAppCard', () => ({ McpAppCard: () => null }));
vi.mock('@/session/mermaidWebView', () => ({ MermaidDiagram: () => null }));
vi.mock('@/session/mathWebView', () => ({ MathFormulaWebView: () => null }));
vi.mock('@/session/mediaPlayerWebView', () => ({ RemoteMediaPlayerWebView: () => null }));
vi.mock('@/session/MarkdownBlockContent', () => ({ MarkdownBlockContent: () => null }));
vi.mock('@/session/MessageActionSheet', () => ({ MessageActionSheet: () => null }));
vi.mock('@/session/AuthorizationMessageCard', () => ({ AuthorizationMessageCard: () => null }));
vi.mock('@/session/CompanionMessageActions', () => ({ CompanionMessageActions: () => null }));
vi.mock('@/session/CompanionMessageCard', () => ({ CompanionMessageCard: () => null }));
vi.mock('@/session/PendingSendBubble', () => ({ PendingSendBubble: () => null }));
vi.mock('@/session/messageActions', async (original) => ({ ...await original<object>(), copyMessageText: vi.fn(), writeClipboardText: vi.fn() }));

import { BotGroupMessageAttachments, botGroupAttachmentRuns } from '@/session/BotGroupMessageAttachments';
import { AttachmentStrip } from '@/session/MessageRenderer';
import { MessageLoadingImage } from '@/session/MessageLoadingImage';
import { buildMessageContentLayout } from '@/session/messageContentLayout';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; host?.remove(); host = undefined; });

const imageUrl = 'xdt-image://cache/group-picture.png';
const thumbnailUrl = 'https://example.invalid/group-thumbnail.png';
const resolveMedia = vi.fn<ResolveRemoteMediaFn>(async () => ({
  url: thumbnailUrl, previewable: true, mimeType: 'image/png',
  ossKey: 'thumbnail', size: 10, expiresAt: '',
}));

beforeEach(() => { resolveMedia.mockClear(); imageEvents.clear(); vi.mocked(openBrowserAsync).mockClear(); });

async function renderAttachment(messageId: string) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(BotGroupMessageAttachments, {
    messageId,
    align: 'right',
    attachments: [{ id: 'attachment', size: 10, path: null, category: 'image', name: 'group-picture.png', url: imageUrl, mimeType: 'image/png' }],
    onResolveRemoteMedia: resolveMedia,
  })));
  return host;
}

describe('group image attachments outside LegendList (#5278)', () => {
  it.each(['displayed', 'error'] as const)('resets the real loading image after %s and ignores late events from the previous image', async (previousState) => {
    host = document.createElement('div');
    root = createRoot(host);
    const firstUri = 'https://example.invalid/first.png';
    const nextUri = 'https://example.invalid/next.png';
    const onLoad = vi.fn();
    const renderImage = (uri: string) => act(() => root!.render(createElement(MessageLoadingImage, {
      source: { uri }, recyclingKey: uri, onLoad, style: { width: 280, height: 180 },
    })));
    const loading = () => host!.querySelector('[data-testid="message.mediaThumbLoading"]');

    renderImage(firstUri);
    const firstEvents = imageEvents.get(firstUri)!;
    act(() => previousState === 'displayed' ? firstEvents.onDisplay() : firstEvents.onError());
    expect(loading()).toBeNull();

    renderImage(nextUri);
    expect(loading()).not.toBeNull();
    expect(host.querySelector('img')?.getAttribute('src')).toBe(nextUri);
    act(() => { firstEvents.onDisplay(); firstEvents.onError(); });
    expect(loading()).not.toBeNull();
    expect(host.querySelector('img')?.getAttribute('src')).toBe(nextUri);

    const nextEvents = imageEvents.get(nextUri)!;
    const event = { source: { width: 100, height: 50 } };
    act(() => nextEvents.onLoad(event));
    expect(onLoad).toHaveBeenCalledWith(event);
    expect(loading()).not.toBeNull();
    act(() => nextEvents.onDisplay());
    expect(loading()).toBeNull();
  });

  it('renders the real image preview without a list provider and opens its gallery', async () => {
    const container = await renderAttachment('new-message');
    expect(container.querySelector('img')?.getAttribute('src')).toBe(thumbnailUrl);
    expect(container.querySelector('[data-testid="message.mediaThumbLoading"]')).not.toBeNull();
    act(() => imageEvents.get(thumbnailUrl)!.onLoad({ source: { width: 280, height: 180 } }));
    expect(container.querySelector('[data-testid="message.mediaThumbLoading"]')).not.toBeNull();
    expect(imageEvents.get(thumbnailUrl)!.transition).toBe(0);
    act(() => imageEvents.get(thumbnailUrl)!.onDisplay());
    expect(container.querySelector('[data-testid="message.mediaThumbLoading"]')).toBeNull();
    expect(resolveMedia).toHaveBeenCalledWith(
      expect.objectContaining({ url: imageUrl, thumbnail: true }), expect.anything(),
    );
    act(() => (container.querySelector('[data-testid="message.mediaPreviewButton"]') as HTMLElement).click());
    expect(container.querySelector('[data-testid="lightbox"]')?.getAttribute('data-url')).toBe(imageUrl);
  });

  it('keeps local thumbnail sizing state outside the list, including the nested image component', async () => {
    const uri = 'file:///group-local-thumbnail.png';
    const layout = buildMessageContentLayout({ screenWidth: 402 });
    host = document.createElement('div');
    root = createRoot(host);
    await act(async () => root!.render(createElement(AttachmentStrip, {
      attachments: [{ kind: 'image', name: 'local.png', uri: imageUrl, previewable: false }],
      messageKey: 'local-message', clientId: 'local-message', align: 'right', layout,
      usePreviewState: useState, onResolveRemoteMedia: resolveMedia,
      getImagePreview: () => ({ attachmentId: 'local', name: 'local.png', sourceRef: imageUrl, uri }),
    })));
    expect(host.querySelector('img')?.getAttribute('src')).toBe(uri);
    act(() => imageEvents.get(uri)!.onLoad({ source: { width: 100, height: 50 } }));
    expect(host.querySelector('img')?.parentElement?.style.width).toBe('100px');
    expect(host.querySelector('img')?.parentElement?.style.height).toBe('50px');
    await act(async () => imageEvents.get(uri)!.onError());
    expect(host.querySelector('img')?.getAttribute('src')).toBe(thumbnailUrl);
  });

  it('retries a failed remote thumbnail once, then shows the fallback and keeps the gallery action', async () => {
    const container = await renderAttachment('failed-thumbnail-message');
    await act(async () => imageEvents.get(thumbnailUrl)!.onError());
    expect(resolveMedia).toHaveBeenCalledTimes(2);
    expect(resolveMedia).toHaveBeenLastCalledWith(
      expect.objectContaining({ url: imageUrl, thumbnail: true }),
      expect.objectContaining({ forceRefresh: true }),
    );
    await act(async () => imageEvents.get(thumbnailUrl)!.onError());
    expect(resolveMedia).toHaveBeenCalledTimes(2);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[data-testid="message.mediaThumbFallback"]')).not.toBeNull();
    act(() => (container.querySelector('[data-testid="message.mediaPreviewButton"]') as HTMLElement).click());
    expect(container.querySelector('[data-testid="lightbox"]')?.getAttribute('data-url')).toBe(imageUrl);
  });

  it('can reopen a group whose loaded history already contains an image', async () => {
    await renderAttachment('historical-message');
    act(() => root!.unmount());
    root = undefined;
    host!.remove();
    const reopened = await renderAttachment('historical-message');
    expect(reopened.querySelector('img')?.getAttribute('src')).toBe(thumbnailUrl);
  });
});

describe('group attachments the computer has not fetched yet', () => {
  const ready = (id: string, name: string) => ({ id, name, category: 'file' as const, mimeType: 'text/plain', size: 1, url: null, path: null });
  const pending = (id: string, name: string, state: 'loading' | 'unavailable') => ({ ...ready(id, name), mimeType: '', size: 0, state });

  const picture = (id: string, name: string) => ({ id, name, category: 'image' as const, mimeType: 'image/png', size: 1, url: `xdt-image://cache/${id}.png`, path: null });
  const summary = (runs: ReturnType<typeof botGroupAttachmentRuns>) =>
    runs.map((run) => run.kind === 'pending' ? `${run.attachment.id}:${run.attachment.state}` : run.attachments.map((item) => item.id).join('+'));

  it.each(['left', 'right'] as const)('groups direct-server files while opening each same-named attachment by ID (%s)', async (align) => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const resolveServerMedia = vi.fn(async (id: string) => ({ ...ready(id, 'same.txt'),
      category: id === 'photo' ? 'image' as const : 'file' as const,
      url: `https://example.invalid/signed/${id}`, mimeType: id === 'photo' ? 'image/png' : 'text/plain' }));
    await act(async () => root!.render(createElement(BotGroupMessageAttachments, {
      messageId: 'direct', align, onResolveRemoteMedia: resolveMedia, resolveServerMedia,
      attachments: [ready('first', 'same.txt'), ready('second', 'same.txt'),
        pending('gone', 'gone.md', 'unavailable'), ready('photo', 'photo.png')],
    })));
    const chips = [...host.querySelectorAll<HTMLElement>('[data-testid^="message.filePreviewButton"]')];
    expect(chips).toHaveLength(4);
    expect(chips[0]!.parentElement).toBe(chips[1]!.parentElement);
    expect(chips[1]!.parentElement).not.toBe(chips[3]!.parentElement);
    expect(resolveServerMedia).not.toHaveBeenCalled();
    expect(resolveMedia).not.toHaveBeenCalled();
    await act(async () => chips[1]!.click());
    await act(async () => chips[0]!.click());
    expect(resolveServerMedia.mock.calls.map(([id]) => id)).toEqual(['second', 'first']);
    expect(vi.mocked(openBrowserAsync).mock.calls.map(([url]) => url)).toEqual([
      'https://example.invalid/signed/second', 'https://example.invalid/signed/first',
    ]);
    await act(async () => chips[3]!.click());
    expect(resolveServerMedia).toHaveBeenLastCalledWith('photo');
    expect(host.querySelector('[data-testid="lightbox"]')?.getAttribute('data-url')).toBe('https://example.invalid/signed/photo');
    expect(openBrowserAsync).toHaveBeenCalledTimes(2);
  });

  it('keeps the sent order: neighbours of one kind share a strip, each pending one stands alone', () => {
    const runs = botGroupAttachmentRuns([ready('a', 'a.txt'), pending('b', 'b.png', 'loading'), ready('c', 'c.txt'), ready('d', 'd.txt'), pending('e', 'e.md', 'unavailable')]);
    expect(summary(runs)).toEqual(['a', 'b:loading', 'c+d', 'e:unavailable']);
  });

  it('never hands a strip both a picture and a file, since a strip draws pictures first', () => {
    // [report.pdf, photo.png] must not become [photo.png, report.pdf].
    expect(summary(botGroupAttachmentRuns([ready('r', 'report.pdf'), picture('p', 'photo.png')]))).toEqual(['r', 'p']);
    expect(summary(botGroupAttachmentRuns([picture('p', 'a.png'), picture('q', 'b.png'), ready('r', 'r.pdf'), ready('s', 's.md'), picture('t', 't.png')])))
      .toEqual(['p+q', 'r+s', 't']);
  });

  it('shows the loading / unavailable state instead of an openable file', async () => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(createElement(BotGroupMessageAttachments, {
      messageId: 'm', align: 'left', onResolveRemoteMedia: resolveMedia,
      attachments: [pending('late', 'late.png', 'loading'), pending('gone', 'gone.md', 'unavailable')],
    })));
    // The real English copy: a status word under each name, never the "open it on your computer" file.
    expect(host.querySelector('[aria-label="late.png, Loading…"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="gone.md, Unavailable right now"]')).not.toBeNull();
    expect(host.textContent).toContain('Loading…');
    expect(host.textContent).toContain('Unavailable right now');
    expect(resolveMedia).not.toHaveBeenCalled();
  });
});
