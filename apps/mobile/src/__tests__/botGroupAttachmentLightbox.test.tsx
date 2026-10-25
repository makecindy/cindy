// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotGroupAttachment } from '@cindy/maker-shared/botGroupChat';
import type { ResolveRemoteMediaFn } from '@/session/remoteMedia';

// This suite exercises attachments; MCP App's native WebView is covered by mcpAppCard.test.tsx.
// Adapt only the native animation/list surfaces. These suites keep the real
// attachment/message gates; native motion has separate hook and device coverage.
vi.mock('@legendapp/list/reanimated', async () => ({ AnimatedLegendList: (await import('@legendapp/list/react-native')).LegendList }));
vi.mock('@/session/AnimatedContentHeight', () => ({ AnimatedContentHeight: ({ open = true, children }: any) => open ? children : null }));
vi.mock('@/session/ComposerDockKeyboardFollow', () => ({ DockKeyboardLift: ({ children }: any) => children }));
vi.mock('@/session/useSmoothMessageFollow', async () => {
  const { useRef, useCallback } = await import('react');
  return { useSmoothMessageFollow: () => ({ scrollRef: useRef(null), move: useCallback(() => {}, []), cancel: useCallback(() => {}, []) }) };
});
vi.mock('@/session/McpAppCard', () => ({ McpAppCard: () => null }));
// The shared message renderer also imports the site-video native surface.
vi.mock('react-native-webview', () => ({ WebView: () => null }));
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule: () => null }));

// Group attachments open the real shared ImageLightbox here (#5875): the timeline strip, the payload
// conversion and the viewer are production code; only native surfaces and unrelated views are replaced.
const runtime = vi.hoisted(() => ({
  alerts: [] as unknown[][],
  accountGeneration: 1,
  imageEvents: new Map<string, { onLoad?: (event: unknown) => void; onError?: () => void }>(),
}));
const openBrowserAsync = vi.hoisted(() => vi.fn(async (_url: string) => ({})));
vi.mock('expo-web-browser', () => ({ openBrowserAsync }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('react-native', async () => {
  const React = await import('react');
  const view = ({ children, testID, accessibilityLabel, onPress }: any) => React.createElement('div', {
    'data-testid': testID, 'aria-label': accessibilityLabel,
    onClick: onPress ? (event: any) => onPress({ stopPropagation: () => event.stopPropagation() }) : undefined,
  }, children);
  class Value { constructor(public value: number) {} interpolate() { return 0; } setValue() {} stopAnimation() {} }
  return {
    View: view, Text: view, Pressable: view, ScrollView: view, Modal: view, ActivityIndicator: view,
    Image: Object.assign(view, { getSize() {} }), StatusBar: () => null,
    FlatList: ({ data, renderItem }: any) => React.createElement('div', null,
      data.map((item: unknown, index: number) => React.createElement(React.Fragment, { key: index }, renderItem({ item, index })))),
    Animated: { Value, View: view, Text: view, createAnimatedComponent: (c: any) => c,
      timing: () => ({ start() {}, stop() {} }), loop: () => ({ start() {}, stop() {} }), sequence: () => ({ start() {}, stop() {} }) },
    Platform: { OS: 'android', select: (s: any) => s.android ?? s.default },
    StyleSheet: { create: (s: any) => s, flatten: (s: any) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {} },
    Easing: { linear: (n: number) => n, bezier: () => (n: number) => n },
    AccessibilityInfo: {}, Linking: {},
    Alert: { alert: (...args: unknown[]) => runtime.alerts.push(args) },
    useWindowDimensions: () => ({ width: 393, height: 851, scale: 2.75, fontScale: 1 }),
  };
});
vi.mock('lucide-react-native', () => Object.fromEntries([
  'Mail', 'CalendarDays', 'Folder', 'ChartColumn', 'Info', 'Clock', 'MapPin', 'Coffee', 'Image', 'Users', 'Star',
  'Database', 'FileArchive', 'FileAudio', 'FileChartColumn', 'FileCode', 'FileImage', 'FileSpreadsheet', 'FileText', 'FileVideo',
  'ArrowLeftRight', 'ArrowUp', 'Bot', 'Check', 'ChevronDown', 'ChevronRight', 'ChevronUp', 'Circle', 'CircleAlert', 'CircleCheck',
  'CircleDashed', 'CircleStop', 'Copy', 'Ellipsis', 'ExternalLink', 'File', 'Ghost', 'Layers', 'ListTodo', 'LoaderCircle',
  'MessageSquarePlus', 'Pen', 'PencilLine', 'RefreshCw', 'Send', 'Share', 'Sparkles', 'Split', 'Timer', 'Trash2', 'TriangleAlert',
  'Undo2', 'X',
].map(name => [name, () => null])));
vi.mock('react-native-svg', () => ({ default: () => null, Circle: () => null, Path: () => null }));
vi.mock('react-native-uitextview', () => ({ UITextView: () => null }));
vi.mock('expo-image', async () => {
  const { createElement } = await import('react');
  return { Image: ({ source, onLoad, onError }: any) => {
    runtime.imageEvents.set(source.uri, { onLoad, onError });
    return createElement('img', { src: source.uri });
  } };
});
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn() }), useFocusEffect: vi.fn(),
  useNavigation: () => ({ isFocused: () => true, addListener: () => () => {}, setOptions: () => undefined }),
}));
vi.mock('@/device-link/DeviceLinkContext', () => ({
  useDeviceLink: () => ({ status: 'offline', connectionEpoch: 0, getPresenceAvailability: () => false, invoke: vi.fn(), openLink: vi.fn() }),
  subscribeRemoteBotChanges: () => () => {},
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@/theme', async () => {
  const tokens = await import('@/theme/tokens');
  const colors = new Proxy({}, { get: () => '#777777' });
  return { ...tokens, monoFont: 'monospace', useTheme: () => ({ colors, mode: 'light' }), useThemedStyles: (make: any) => make(colors) };
});
vi.mock('@/components/AppText', async () => ({ Text: (await import('react-native')).Text, MAX_FONT_SIZE_MULTIPLIER: 2 }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ accountGeneration: runtime.accountGeneration }) }));
vi.mock('@/session/usePluginResultCard', () => ({ usePluginResultCard: () => ({}), useSessionPluginResource: () => ({ title: 'Art' }) }));
vi.mock('@/session/remoteMediaDiskCacheExpo', () => ({ downloadRemoteMediaShareTemp: vi.fn() }));
vi.mock('@/hooks/useReduceMotion', () => ({ useReduceMotionEnabled: () => true }));
vi.mock('@/session/expandedBlockMemory', () => ({ useFoldableExpandedState: () => [false, vi.fn()] }));
vi.mock('@/platform/chrome', () => ({ NativePullDownMenu: () => null, showActionMenu: vi.fn(), usesNativePullDownMenu: () => false, usesSystemActionMenu: () => false }));
vi.mock('@/session/MobileComposerInputRow', () => ({ MobileComposerInputRow: () => null, MOBILE_COMPOSER_VOICE_ANCHOR_RIGHT: 0, MOBILE_COMPOSER_CONTROL_SIZE: 44 }));
vi.mock('@/session/NativeVideoPlayer', () => ({ NativeVideoPlayer: () => null }));
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
vi.mock('@/platform/gestureHandler', async () => {
  const { View } = await import('react-native');
  const make = (): any => new Proxy({}, { get: (_target, key) => key === 'then' ? undefined : () => make() });
  return {
    GestureHandlerRootView: View,
    GestureDetector: ({ children }: { children: unknown }) => children,
    Gesture: { Pan: make, Pinch: make, Tap: make, Exclusive: make, Simultaneous: make },
  };
});
vi.mock('react-native-reanimated', async () => {
  const { useRef } = await import('react');
  const native = await import('react-native');
  return {
    default: { View: native.View, createAnimatedComponent: (component: unknown) => component },
    useSharedValue: (initial: number) => useRef({ value: initial }).current,
    useAnimatedStyle: (calculate: () => unknown) => ({ get current() { return calculate(); } }),
    runOnJS: (fn: (...args: unknown[]) => unknown) => fn,
    cancelAnimation: () => undefined,
    withTiming: (target: number) => target,
    withSpring: (target: number) => target,
    withDecay: () => 0,
  };
});

import { BotGroupMessageAttachments } from '@/session/BotGroupMessageAttachments';
import { MessageListVisibility, MessageListVisibilityContext } from '@/session/messageListVisibility';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; host?.remove(); host = undefined; });
beforeEach(() => { runtime.accountGeneration = 1; runtime.alerts = []; runtime.imageEvents.clear(); openBrowserAsync.mockClear(); });

// Placeholder for a short-lived authorized address; never a real signed URL.
const signedImageUrl = 'https://chat.example.invalid/media/group-picture.png?signature=placeholder';
const serverAttachment: BotGroupAttachment = { id: 'media-1', name: '1.png', category: 'file', mimeType: '', size: 0, url: null, path: null };

async function render(props: Partial<Parameters<typeof BotGroupMessageAttachments>[0]>, visibility?: MessageListVisibility) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(MessageListVisibilityContext.Provider, { value: visibility ?? null }, createElement(BotGroupMessageAttachments, {
    messageId: 'message-1', align: 'right', attachments: [serverAttachment],
    onResolveRemoteMedia: vi.fn<ResolveRemoteMediaFn>(), ...props,
  }))));
  return host;
}

const click = (element: Element | null | undefined) => act(async () => { (element as HTMLElement).click(); });
const loadFailedKey = 'message.lightbox.loadFailed';

describe('Chat Server group image attachments (#5875)', () => {
  // PR #7145: ScrollView mounts offscreen history too. Existing tests had no viewport.
  // The real strip must not mount an image (or request its URL) until its row is visible.
  it('loads only visible messages and preserves loaded previews when scrolling back', async () => {
    const visibility = new MessageListVisibility();
    const resolveServerMedia = vi.fn(async () => ({ ...serverAttachment, category: 'image' as const, url: signedImageUrl }));
    const container = await render({ resolveServerMedia }, visibility);
    expect(resolveServerMedia).not.toHaveBeenCalled();
    expect(container.querySelector('img')).toBeNull();
    await act(async () => visibility.update([{ key: 'message-1', isViewable: true }]));
    expect(resolveServerMedia).toHaveBeenCalledTimes(1);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(signedImageUrl);
    await act(async () => visibility.update([]));
    await act(async () => visibility.update([{ key: 'message-1', isViewable: true }]));
    expect(resolveServerMedia).toHaveBeenCalledTimes(1);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(signedImageUrl);
  });

  it('keeps a multi-image history offscreen while loading the latest row, then authorizes again on tap', async () => {
    const visibility = new MessageListVisibility();
    const resolveServerMedia = vi.fn(async (id: string) => ({ ...serverAttachment, id, category: 'image' as const, url: `${signedImageUrl}#${id}` }));
    const container = await render({}, visibility);
    await act(async () => root!.render(createElement(MessageListVisibilityContext.Provider, { value: visibility },
      ...['history', 'latest'].map(messageId => createElement(BotGroupMessageAttachments, {
        key: messageId, messageId, align: 'right', resolveServerMedia, onResolveRemoteMedia: vi.fn(),
        attachments: (messageId === 'history' ? ['old-1', 'old-2'] : ['latest']).map(id => ({ ...serverAttachment, id })),
      })),
    )));
    expect(resolveServerMedia).not.toHaveBeenCalled();
    await act(async () => visibility.update([{ key: 'latest', isViewable: true }]));
    expect(resolveServerMedia.mock.calls.map(([id]) => id)).toEqual(['latest']);
    expect(container.querySelectorAll('img')).toHaveLength(1);
    await act(async () => visibility.update([{ key: 'history', isViewable: true }]));
    expect(resolveServerMedia.mock.calls.map(([id]) => id)).toEqual(['latest', 'old-1', 'old-2']);
    expect(container.querySelectorAll('img')).toHaveLength(3);
    await click(container.querySelector(`img[src="${signedImageUrl}#old-2"]`)?.closest('[data-testid="message.mediaPreviewButton"]'));
    expect(resolveServerMedia.mock.calls.map(([id]) => id)).toEqual(['latest', 'old-1', 'old-2', 'old-2']);
    expect(container.querySelector('[data-testid="message.imageLightbox"] img')?.getAttribute('src')).toBe(`${signedImageUrl}#old-2`);
  });

  it('shows an authorized HTTPS image in the real lightbox, re-authorizing on every tap', async () => {
    const resolveServerMedia = vi.fn(async (id: string): Promise<BotGroupAttachment> => ({
      id, name: '1.png', category: 'image', mimeType: 'image/png', size: 10, url: signedImageUrl, path: null,
    }));
    const container = await render({ resolveServerMedia });
    // Unknown media becomes a real thumbnail after authorization, without a tap.
    expect(container.querySelector('img')?.getAttribute('src')).toBe(signedImageUrl);
    expect(container.querySelector('[data-testid="message.imageLightbox"]')).toBeNull();
    expect(resolveServerMedia).toHaveBeenCalledTimes(1);

    await click(container.querySelector('[data-testid="message.mediaPreviewButton"]'));
    expect(resolveServerMedia).toHaveBeenCalledWith('media-1');
    const viewer = container.querySelector('[data-testid="message.imageLightbox"]');
    expect(viewer?.querySelector('img')?.getAttribute('src')).toBe(signedImageUrl);
    expect(container.textContent).not.toContain(loadFailedKey);
    act(() => runtime.imageEvents.get(signedImageUrl)!.onLoad?.({ source: { width: 1200, height: 900 } }));
    expect(container.textContent).not.toContain(loadFailedKey);

    await click(container.querySelector('[data-testid="message.imageLightboxCloseButton"]'));
    expect(container.querySelector('[data-testid="message.imageLightbox"]')).toBeNull();
    expect(container.querySelector('img')?.getAttribute('src')).toBe(signedImageUrl);

    await click(container.querySelector('[data-testid="message.mediaPreviewButton"]'));
    expect(resolveServerMedia).toHaveBeenCalledTimes(3);
    expect(container.querySelector('[data-testid="message.imageLightbox"] img')?.getAttribute('src')).toBe(signedImageUrl);
  });

  // PR #7145 review r4371267451 / media-storage-and-protocols: a native image
  // failure after successful authorization was not covered by authorization errors.
  // Unit: one signed image + onError must refresh once, then allow manual recovery.
  it('refreshes a failed native preview once, then repairs the list on an explicit tap', async () => {
    const refreshedUrl = `${signedImageUrl}&refreshed=1`;
    const tappedUrl = `${signedImageUrl}&refreshed=2`;
    const resolveServerMedia = vi.fn<() => Promise<BotGroupAttachment>>()
      .mockResolvedValueOnce({ ...serverAttachment, category: 'image', url: signedImageUrl })
      .mockResolvedValueOnce({ ...serverAttachment, category: 'image', url: refreshedUrl })
      .mockResolvedValue({ ...serverAttachment, category: 'image', url: tappedUrl });
    const container = await render({ resolveServerMedia });
    await act(async () => runtime.imageEvents.get(signedImageUrl)!.onError?.());
    expect(resolveServerMedia).toHaveBeenCalledTimes(2);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(refreshedUrl);
    await act(async () => runtime.imageEvents.get(refreshedUrl)!.onError?.());
    expect(resolveServerMedia).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-testid="message.mediaThumbFallback"]')).not.toBeNull();
    await click(container.querySelector('[data-testid="message.mediaPreviewButton"]'));
    expect(resolveServerMedia).toHaveBeenCalledTimes(3);
    await click(container.querySelector('[data-testid="message.imageLightboxCloseButton"]'));
    expect(container.querySelector('img')?.getAttribute('src')).toBe(tappedUrl);
    expect(runtime.alerts).toEqual([]);
  });

  it('retries the same signed URL after a transient native failure', async () => {
    const resolveServerMedia = vi.fn(async () => ({ ...serverAttachment, category: 'image' as const, url: signedImageUrl }));
    const container = await render({ resolveServerMedia });
    await act(async () => runtime.imageEvents.get(signedImageUrl)!.onError?.());
    expect(resolveServerMedia).toHaveBeenCalledTimes(2);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(signedImageUrl);
    await act(async () => runtime.imageEvents.get(signedImageUrl)!.onError?.());
    expect(resolveServerMedia).toHaveBeenCalledTimes(2);
    expect(container.querySelector('img')).toBeNull();
  });

  it('defers native-error refresh offscreen and ignores its late result after leaving', async () => {
    const visibility = new MessageListVisibility();
    visibility.update([{ key: 'message-1', isViewable: true }]);
    let finishRefresh!: (value: BotGroupAttachment) => void;
    const resolveServerMedia = vi.fn<() => Promise<BotGroupAttachment>>()
      .mockResolvedValueOnce({ ...serverAttachment, category: 'image', url: signedImageUrl })
      .mockImplementationOnce(() => new Promise(resolve => { finishRefresh = resolve; }));
    const container = await render({ resolveServerMedia }, visibility);
    await act(async () => visibility.update([]));
    await act(async () => runtime.imageEvents.get(signedImageUrl)!.onError?.());
    expect(resolveServerMedia).toHaveBeenCalledTimes(1);
    await act(async () => visibility.update([{ key: 'message-1', isViewable: true }]));
    expect(resolveServerMedia).toHaveBeenCalledTimes(2);
    await act(async () => visibility.update([]));
    await act(async () => finishRefresh({ ...serverAttachment, category: 'image', url: `${signedImageUrl}&late=1` }));
    expect(container.querySelector('img')).toBeNull();
  });

  // PR #7145 r4371557412: the first automatic request has no cached preview.
  // A successful tap must populate the group list even if that request fails or hangs.
  it.each(['late-success', 'late-failure', 'already-failed'])('keeps the tapped preview before initial authorization completes (%s)', async outcome => {
    let finishInitial!: (value: BotGroupAttachment) => void;
    let failInitial!: (error: Error) => void;
    const tappedUrl = `${signedImageUrl}&tap=initial`;
    const resolveServerMedia = vi.fn<() => Promise<BotGroupAttachment>>()
      .mockImplementationOnce(() => new Promise((resolve, reject) => { finishInitial = resolve; failInitial = reject; }))
      .mockResolvedValueOnce({ ...serverAttachment, category: 'image', url: tappedUrl });
    const container = await render({ resolveServerMedia });
    try {
      if (outcome === 'already-failed') await act(async () => failInitial(new Error('initial failed')));
      await click(container.querySelector('[data-testid="message.filePreviewButton"]'));
      await click(container.querySelector('[data-testid="message.imageLightboxCloseButton"]'));
      expect(container.querySelector('img')?.getAttribute('src')).toBe(tappedUrl);
    } finally {
      await act(async () => {
        if (outcome === 'late-success') finishInitial({ ...serverAttachment, category: 'image', url: `${signedImageUrl}&older=1` });
        else failInitial(new Error('initial failed'));
      });
    }
    expect(container.querySelector('img')?.getAttribute('src')).toBe(tappedUrl);
    expect(resolveServerMedia).toHaveBeenCalledTimes(2);
  });

  it('keeps a newer tapped image retry queued when its initial authorization fails late', async () => {
    let failInitial!: (error: Error) => void;
    const finishNeighbours: Array<(value: BotGroupAttachment) => void> = [];
    const tappedUrl = `${signedImageUrl}&tap=initial`;
    const refreshedUrl = `${signedImageUrl}&retry=initial`;
    let targetCalls = 0;
    const resolveServerMedia = vi.fn((id: string): Promise<BotGroupAttachment> => {
      if (id !== serverAttachment.id) return new Promise(resolve => finishNeighbours.push(resolve));
      targetCalls++;
      if (targetCalls === 1) return new Promise((_resolve, reject) => { failInitial = reject; });
      return Promise.resolve({ ...serverAttachment, category: 'image', url: targetCalls === 2 ? tappedUrl : refreshedUrl });
    });
    const container = await render({ resolveServerMedia,
      attachments: [serverAttachment, ...['neighbour-1', 'neighbour-2'].map(id => ({ ...serverAttachment, id }))] });
    try {
      await click(container.querySelector('[data-testid="message.filePreviewButton"]'));
      await click(container.querySelector('[data-testid="message.imageLightboxCloseButton"]'));
      await act(async () => runtime.imageEvents.get(tappedUrl)!.onError?.());
      expect(targetCalls).toBe(2); // retry waits behind the three original authorizations
      await act(async () => failInitial(new Error('older request failed')));
      expect(targetCalls).toBe(3);
      expect(container.querySelector('img')?.getAttribute('src')).toBe(refreshedUrl);
    } finally {
      failInitial(new Error('cleanup'));
      await act(async () => finishNeighbours.forEach((finish, index) => finish({ ...serverAttachment, id: `neighbour-${index + 1}` })));
    }
  });

  it('does not let a late automatic refresh replace a newer explicit authorization', async () => {
    let finishRefresh!: (value: BotGroupAttachment) => void;
    const tappedUrl = `${signedImageUrl}&tap=1`;
    const resolveServerMedia = vi.fn<() => Promise<BotGroupAttachment>>()
      .mockResolvedValueOnce({ ...serverAttachment, category: 'image', url: signedImageUrl })
      .mockImplementationOnce(() => new Promise(resolve => { finishRefresh = resolve; }))
      .mockResolvedValueOnce({ ...serverAttachment, category: 'image', url: tappedUrl });
    const container = await render({ resolveServerMedia });
    await act(async () => runtime.imageEvents.get(signedImageUrl)!.onError?.());
    await click(container.querySelector('[data-testid="message.mediaPreviewButton"]'));
    await act(async () => finishRefresh({ ...serverAttachment, category: 'image', url: `${signedImageUrl}&late=1` }));
    await click(container.querySelector('[data-testid="message.imageLightboxCloseButton"]'));
    expect(container.querySelector('img')?.getAttribute('src')).toBe(tappedUrl);
    expect(resolveServerMedia).toHaveBeenCalledTimes(3);
  });

  it('reloads only the failed image and preserves its loaded neighbour', async () => {
    const neighbour = { ...serverAttachment, id: 'media-2', name: '2.png' };
    const neighbourUrl = `${signedImageUrl}&neighbour=1`;
    const resolveServerMedia = vi.fn(async (id: string) => ({
      ...serverAttachment, id, category: 'image' as const,
      url: id === neighbour.id ? neighbourUrl : signedImageUrl,
    }));
    const container = await render({ resolveServerMedia, attachments: [serverAttachment, neighbour] });
    const loadedNeighbour = container.querySelector(`img[src="${neighbourUrl}"]`);
    await act(async () => runtime.imageEvents.get(signedImageUrl)!.onError?.());
    expect(resolveServerMedia.mock.calls.map(([id]) => id)).toEqual(['media-1', 'media-2', 'media-1']);
    expect(container.querySelector(`img[src="${signedImageUrl}"]`)).not.toBeNull();
    expect(container.querySelector(`img[src="${neighbourUrl}"]`)).toBe(loadedNeighbour);
  });

  it('does not abort a neighbouring pending authorization when retrying one failed image', async () => {
    let finishNeighbour!: (value: BotGroupAttachment) => void;
    let neighbourSignal: AbortSignal | undefined;
    const resolveServerMedia = vi.fn(async (id: string, signal?: AbortSignal) => {
      if (id === 'neighbour') {
        neighbourSignal = signal;
        return new Promise<BotGroupAttachment>(resolve => { finishNeighbour = resolve; });
      }
      return { ...serverAttachment, category: 'image' as const, url: signedImageUrl };
    });
    const container = await render({ resolveServerMedia, attachments: [serverAttachment, { ...serverAttachment, id: 'neighbour' }] });
    try {
      await act(async () => runtime.imageEvents.get(signedImageUrl)!.onError?.());
      expect(neighbourSignal?.aborted).toBe(false);
      expect(resolveServerMedia.mock.calls.map(([id]) => id)).toEqual(['media-1', 'neighbour', 'media-1']);
      expect(container.querySelector('img')?.getAttribute('src')).toBe(signedImageUrl);
    } finally {
      await act(async () => finishNeighbour({ ...serverAttachment, id: 'neighbour', category: 'image', url: `${signedImageUrl}&neighbour=1` }));
    }
  });

  // CloudCompanionScreen selects this policy even if its row is visible.
  it('keeps cloud transcript media tap-only, including after returning from the viewer', async () => {
    const resolveServerMedia = vi.fn(async () => ({ ...serverAttachment, category: 'image' as const, url: signedImageUrl }));
    const container = await render({ resolveServerMedia, previewServerImages: false });
    expect(resolveServerMedia).not.toHaveBeenCalled();
    expect(container.querySelector('img')).toBeNull();
    await click(container.querySelector('[data-testid="message.filePreviewButton"]'));
    expect(resolveServerMedia).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="message.imageLightbox"] img')?.getAttribute('src')).toBe(signedImageUrl);
    await click(container.querySelector('[data-testid="message.imageLightboxCloseButton"]'));
    expect(container.querySelector('img')).toBeNull();
    await click(container.querySelector('[data-testid="message.filePreviewButton"]'));
    expect(resolveServerMedia).toHaveBeenCalledTimes(2);
  });

  it('opens a non-image server file through its short-lived download address, not the viewer', async () => {
    const fileUrl = 'https://chat.example.invalid/media/report.pdf?signature=placeholder';
    const resolveServerMedia = vi.fn(async (id: string): Promise<BotGroupAttachment> => ({
      id, name: 'report.pdf', category: 'file', mimeType: 'application/pdf', size: 10, url: fileUrl, path: null,
    }));
    const container = await render({ resolveServerMedia, attachments: [{ ...serverAttachment, name: 'report.pdf' }] });
    await click(container.querySelector('[data-testid^="message.filePreviewButton"]'));
    expect(openBrowserAsync).toHaveBeenCalledWith(fileUrl);
    expect(container.querySelector('[data-testid="message.imageLightbox"]')).toBeNull();
  });

  it('keeps failed preview authorization retryable on tap without showing a background alert', async () => {
    const resolveServerMedia = vi.fn<() => Promise<BotGroupAttachment>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ ...serverAttachment, category: 'image', mimeType: 'image/png', url: signedImageUrl });
    const container = await render({ resolveServerMedia });
    expect(runtime.alerts).toEqual([]);
    expect(container.querySelector('img')).toBeNull();
    await click(container.querySelector('[data-testid="message.filePreviewButton"]'));
    expect(container.querySelector('[data-testid="message.imageLightbox"] img')?.getAttribute('src')).toBe(signedImageUrl);
  });

  it('cancels queued offscreen previews and does not mount late image results', async () => {
    const visibility = new MessageListVisibility();
    visibility.update([{ key: 'message-1', isViewable: true }]);
    const pending: Array<(value: BotGroupAttachment) => void> = [];
    const resolveServerMedia = vi.fn(() => new Promise<BotGroupAttachment>(resolve => pending.push(resolve)));
    const attachments = Array.from({ length: 4 }, (_, index) => ({ ...serverAttachment, id: `media-${index}` }));
    const container = await render({ resolveServerMedia, attachments }, visibility);
    expect(resolveServerMedia).toHaveBeenCalledTimes(3);
    await act(async () => visibility.update([]));
    await act(async () => pending.forEach(resolve => resolve({ ...serverAttachment, category: 'image', url: signedImageUrl })));
    expect(resolveServerMedia).toHaveBeenCalledTimes(3);
    expect(container.querySelector('img')).toBeNull();
  });

  // PR #7145 r4371434693: three stalled requests must not block another page
  // until their 20s timeout. Unit through the real strip; old tests settled them first.
  it.each(['message', 'account'])('aborts old preview jobs and frees slots before stale requests settle (%s)', async change => {
    const signals: Array<AbortSignal | undefined> = [];
    const finishes: Array<(value: BotGroupAttachment) => void> = [];
    const oldResolver = vi.fn((_id: string, signal?: AbortSignal) => {
      signals.push(signal); return new Promise<BotGroupAttachment>(resolve => finishes.push(resolve));
    });
    const container = await render({ resolveServerMedia: oldResolver,
      attachments: Array.from({ length: 4 }, (_, n) => ({ ...serverAttachment, id: `old-${n}` })) });
    expect(oldResolver).toHaveBeenCalledTimes(3);
    const nextUrl = `${signedImageUrl}&next=1`;
    const nextResolver = vi.fn(async () => ({ ...serverAttachment, category: 'image' as const, url: nextUrl }));
    if (change === 'account') runtime.accountGeneration++;
    await act(async () => root!.render(createElement(BotGroupMessageAttachments, {
      messageId: change === 'message' ? 'next-message' : 'message-1', align: 'right',
      attachments: [serverAttachment], onResolveRemoteMedia: vi.fn(), resolveServerMedia: nextResolver,
    })));
    try {
      expect(signals.every(signal => signal?.aborted)).toBe(true);
      expect(nextResolver).toHaveBeenCalledTimes(1);
      expect(container.querySelector('img')?.getAttribute('src')).toBe(nextUrl);
    } finally {
      await act(async () => finishes.forEach(finish => finish({ ...serverAttachment, category: 'image', url: signedImageUrl })));
    }
    expect(oldResolver).toHaveBeenCalledTimes(3);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(nextUrl);
  });

  it('bounds preview authorization and ignores late results when the message changes', async () => {
    const pending: Array<(value: BotGroupAttachment) => void> = [];
    const resolveServerMedia = vi.fn((id: string) => new Promise<BotGroupAttachment>(resolve => {
      pending.push(value => resolve({ ...value, id }));
    }));
    const attachments = Array.from({ length: 8 }, (_, index) => ({ ...serverAttachment, id: `media-${index}` }));
    const container = await render({ resolveServerMedia, attachments });
    expect(resolveServerMedia).toHaveBeenCalledTimes(3);
    await act(async () => root!.render(createElement(BotGroupMessageAttachments, {
      messageId: 'replacement', align: 'right', attachments: [], onResolveRemoteMedia: vi.fn(), resolveServerMedia,
    })));
    await act(async () => pending.forEach(resolve => resolve({ ...serverAttachment, category: 'image', url: signedImageUrl })));
    expect(resolveServerMedia).toHaveBeenCalledTimes(3);
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('computer-hosted group image attachments', () => {
  it.each(['cindy-media://blobs/aa11bb22.png', 'xdt-image://cache/group-picture.png'])(
    'still fetches %s from the computer for the real lightbox',
    async (mediaUrl) => {
      const originalUrl = 'file:///cache/group-picture-original.png';
      const resolveMedia = vi.fn<ResolveRemoteMediaFn>(async (media) => ({
        url: media.thumbnail ? 'https://example.invalid/thumbnail.png' : originalUrl,
        previewable: true, mimeType: 'image/png', ossKey: 'group-picture', size: 10, expiresAt: '',
      }));
      const container = await render({
        onResolveRemoteMedia: resolveMedia,
        attachments: [{ id: 'local', name: 'group-picture.png', category: 'image', mimeType: 'image/png', size: 10, url: mediaUrl, path: null }],
      });
      await click(container.querySelector('[data-testid="message.mediaPreviewButton"]'));
      expect(resolveMedia).toHaveBeenCalledWith(expect.objectContaining({ url: mediaUrl, previewable: false }), expect.anything());
      expect(resolveMedia).toHaveBeenCalledWith(expect.not.objectContaining({ thumbnail: true }), expect.anything());
      const viewer = container.querySelector('[data-testid="message.imageLightbox"]');
      expect(viewer?.querySelector(`img[src="${originalUrl}"]`)).not.toBeNull();
      expect(container.textContent).not.toContain(loadFailedKey);
    },
  );
});
