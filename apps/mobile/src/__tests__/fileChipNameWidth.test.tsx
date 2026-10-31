// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BotGroupAttachment } from '@cindy/maker-shared/botGroupChat';
import type { ResolveRemoteMediaFn } from '@/session/remoteMedia';

// This suite exercises attachment layout; keep the unrelated native App surface out of Node.
vi.mock('@/platform/gestureHandler', () => {
  const chain = (): any => new Proxy({}, { get: (_target, key) => key === 'then' ? undefined : () => chain() });
  return { GestureDetector: ({ children }: { children: unknown }) => children, Gesture: { LongPress: chain } };
});
vi.mock('@/session/McpAppCard', () => ({ McpAppCard: () => null }));
vi.mock('react-native-webview', () => ({ WebView: () => null }));
vi.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: () => null,
  requireNativeViewManager: () => () => null,
}));
vi.mock('@/session/NativeVideoPlayer', () => ({ NativeVideoPlayer: () => null }));

// Keeps the rendered React Native styles of the real file chip (#5875). Node has no Yoga, so the
// content-sized width below applies Yoga's own flex-basis rule to those styles instead of a layout pass.
vi.mock('react-native', async () => {
  const React = await import('react');
  const flatten = (style: unknown): Record<string, unknown> => Array.isArray(style)
    ? Object.assign({}, ...style.map(flatten))
    : style && typeof style === 'object' ? style as Record<string, unknown> : {};
  const view = ({ children, testID, style }: any) => React.createElement('div', {
    'data-testid': testID,
    'data-style': JSON.stringify(flatten(typeof style === 'function' ? style({ pressed: false }) : style)),
  }, children);
  class Value { constructor(public value: number) {} interpolate() { return 0; } setValue() {} stopAnimation() {} }
  return {
    View: view, Text: view, Pressable: view, ScrollView: view, Modal: () => null, ActivityIndicator: view,
    Image: Object.assign(view, { getSize() {} }), StatusBar: () => null,
    Animated: { Value, View: view, Text: view, createAnimatedComponent: (c: any) => c,
      timing: () => ({ start() {}, stop() {} }), loop: () => ({ start() {}, stop() {} }), sequence: () => ({ start() {}, stop() {} }) },
    Platform: { OS: 'android', select: (s: any) => s.android ?? s.default },
    StyleSheet: { create: (s: any) => s, flatten, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {} },
    Easing: { linear: (n: number) => n, bezier: () => (n: number) => n },
    AccessibilityInfo: {}, Alert: { alert: vi.fn() }, Linking: {},
    useWindowDimensions: () => ({ width: 393, height: 851, scale: 2.75, fontScale: 1 }),
  };
});
vi.mock('expo-web-browser', () => ({ openBrowserAsync: vi.fn() }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('lucide-react-native', () => Object.fromEntries([
  'Mail', 'CalendarDays', 'Folder', 'ChartColumn', 'Info', 'Clock', 'MapPin', 'Coffee', 'Image', 'Users', 'Star',
  'Database', 'FileArchive', 'FileAudio', 'FileChartColumn', 'FileCode', 'FileImage', 'FileSpreadsheet', 'FileText', 'FileVideo',
  'ArrowLeftRight', 'ArrowUp', 'Bot', 'Check', 'ChevronDown', 'ChevronRight', 'ChevronUp', 'Circle', 'CircleAlert', 'CircleCheck',
  'CircleDashed', 'CircleStop', 'Copy', 'Ellipsis', 'ExternalLink', 'File', 'Ghost', 'Layers', 'ListTodo', 'LoaderCircle',
  'PencilLine', 'RefreshCw', 'Send', 'Share', 'Sparkles', 'Split', 'Timer', 'Trash2', 'TriangleAlert', 'Undo2', 'X',
].map(name => [name, () => null])));
vi.mock('react-native-svg', () => ({ default: () => null, Circle: () => null, Path: () => null }));
vi.mock('react-native-uitextview', () => ({ UITextView: () => null }));
vi.mock('expo-image', () => ({ Image: () => null }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }), useFocusEffect: vi.fn(), useNavigation: () => ({ isFocused: () => true, addListener: () => () => {} }) }));
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
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ accountGeneration: 1 }) }));
vi.mock('@/session/usePluginResultCard', () => ({ usePluginResultCard: () => ({}), useSessionPluginResource: () => ({ title: 'Art' }) }));
vi.mock('@/session/remoteMediaDiskCacheExpo', () => ({ downloadRemoteMediaShareTemp: vi.fn() }));
vi.mock('@/hooks/useReduceMotion', () => ({ useReduceMotionEnabled: () => true }));
vi.mock('@/session/expandedBlockMemory', () => ({ useFoldableExpandedState: () => [false, vi.fn()] }));
vi.mock('@/platform/chrome', () => ({ NativePullDownMenu: () => null, showActionMenu: vi.fn(), usesNativePullDownMenu: () => false, usesSystemActionMenu: () => false }));
vi.mock('@/session/MobileComposerInputRow', () => ({ MobileComposerInputRow: () => null, MOBILE_COMPOSER_VOICE_ANCHOR_RIGHT: 0, MOBILE_COMPOSER_CONTROL_SIZE: 44 }));
vi.mock('@/session/ImageLightbox', () => ({ ImageLightbox: () => null }));
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

import { BotGroupMessageAttachments } from '@/session/BotGroupMessageAttachments';
import { AttachmentStrip } from '@/session/MessageRenderer';
import { buildMessageContentLayout } from '@/session/messageContentLayout';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; host?.remove(); host = undefined; });

type Style = Record<string, unknown>;
const styleOf = (element: Element): Style => JSON.parse(element.getAttribute('data-style') ?? '{}');
const px = (value: unknown) => (typeof value === 'number' ? value : 0);
/** Deterministic stand-in for measured text: caption glyphs at about 7pt each. */
const textWidth = (name: string) => name.length * 7;

/**
 * The chip's width when its row is content-sized (left-aligned strip, unstretched wrapper), with
 * Yoga's rule from `Node::processFlexBasis`: `flex > 0` without an explicit basis resolves to 0 points,
 * otherwise the basis is the content. Only a shrinkable name gives way to the chip's max width.
 */
function contentSizedChip(chip: Element) {
  const chipStyle = styleOf(chip);
  const [iconFrame, nameBox] = Array.from(chip.children);
  const nameStyle = styleOf(nameBox);
  const name = nameBox.textContent ?? '';
  const basis = typeof nameStyle.flexBasis === 'number' ? nameStyle.flexBasis
    : px(nameStyle.flex) > 0 ? 0 : textWidth(name);
  const fixed = px(chipStyle.paddingHorizontal) * 2 + px(styleOf(iconFrame).width) + px(chipStyle.gap);
  const maxWidth = px(chipStyle.maxWidth);
  const shrinks = px(nameStyle.flexShrink) > 0 || px(nameStyle.flex) > 0;
  const nameWidth = fixed + basis > maxWidth && shrinks ? Math.max(0, maxWidth - fixed) : basis;
  return { chip: Math.min(maxWidth, fixed + nameWidth), name: nameWidth, maxWidth };
}

const shortName = '1.png';
const longName = `${'quarterly-group-report-'.repeat(8)}.png`;

async function renderServerGroup(align: 'left' | 'right', name: string) {
  const attachment: BotGroupAttachment = { id: 'media-1', name, category: 'file', mimeType: '', size: 0, url: null, path: null };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(BotGroupMessageAttachments, {
    messageId: 'message-1', align, attachments: [attachment],
    onResolveRemoteMedia: vi.fn<ResolveRemoteMediaFn>(), resolveServerMedia: vi.fn(async () => attachment),
  })));
  return host.querySelector('[data-testid^="message.filePreviewButton"]')!;
}

async function renderSessionStrip(align: 'left' | 'right', name: string) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(AttachmentStrip, {
    attachments: [{ kind: 'file', name, previewable: false }], messageKey: 'message-1', align,
    layout: buildMessageContentLayout({ screenWidth: 393 }), usePreviewState: useState, onOpen: vi.fn(),
  })));
  return host.querySelector('[data-testid^="message.filePreviewButton"]')!;
}

describe('file chip names keep their width when the chip is content-sized (#5875)', () => {
  it.each([
    ['server group', 'right', 'short', shortName], ['server group', 'left', 'short', shortName],
    ['server group', 'right', 'long', longName], ['server group', 'left', 'long', longName],
    ['task message', 'left', 'short', shortName], ['task message', 'left', 'long', longName],
  ] as const)('%s, %s aligned, %s name', async (surface, align, _label, name) => {
    const chip = surface === 'server group' ? await renderServerGroup(align, name) : await renderSessionStrip(align, name);
    const width = contentSizedChip(chip);
    expect(width.maxWidth).toBe(228);
    expect(width.name).toBeGreaterThan(0);
    expect(width.chip).toBeLessThanOrEqual(228);
    if (name === longName) expect(width.chip).toBe(228);
  });

  it('stretches each server attachment like a task strip, so the user side keeps the task-message chip width', async () => {
    for (const align of ['left', 'right'] as const) {
      const chip = await renderServerGroup(align, shortName);
      const wrapper = chip.parentElement!.parentElement!.parentElement!;
      expect(styleOf(wrapper).alignSelf).toBe('stretch');
      act(() => root?.unmount()); root = undefined; host?.remove();
    }
  });
});
