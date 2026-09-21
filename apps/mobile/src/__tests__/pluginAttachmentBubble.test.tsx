import { createElement, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Keep the production list, bubble gate, invocation header, and message model.
// Only native surfaces and unrelated heavy viewers are replaced for Node rendering.
vi.mock('react-native', async () => {
  const React = await import('react');
  const view = ({ children, testID, accessibilityLabel }: any) => React.createElement('div', { 'data-testid': testID, 'aria-label': accessibilityLabel }, children);
  class Value { constructor(public value: number) {} interpolate() { return 0; } setValue() {} }
  return {
    View: view, Text: view, Pressable: view, ScrollView: view, Modal: () => null,
    Image: Object.assign(view, { getSize() {} }), ActivityIndicator: view,
    Animated: { Value, View: view, Text: view, createAnimatedComponent: (c: any) => c },
    Platform: { OS: 'ios', select: (s: any) => s.ios ?? s.default },
    StyleSheet: { create: (s: any) => s, flatten: (s: any) => s, hairlineWidth: 1 },
    Easing: { linear: (n: number) => n, bezier: () => (n: number) => n },
    AccessibilityInfo: {}, Alert: {}, Linking: {}, StatusBar: {},
    useWindowDimensions: () => ({ width: 402, height: 874, scale: 3, fontScale: 1 }),
  };
});
vi.mock('@legendapp/list/react-native', () => ({
  LegendList: ({ data, renderItem }: any) => data.map((item: any, index: number) => createElement('section', { key: item.key }, renderItem({ item, index }))),
  useRecyclingState: (initial: any) => useState(initial), useViewability: () => {},
}));
vi.mock('lucide-react-native', () => ({
  ArrowLeftRight: () => null, ArrowUp: () => null, Bot: () => null, Check: () => null, ChevronDown: () => null, ChevronRight: () => null, ChevronUp: () => null, Circle: () => null, CircleAlert: () => null, CircleCheck: () => null, CircleDashed: () => null, CircleStop: () => null, Copy: () => null, Ellipsis: () => null, ExternalLink: () => null, File: () => null, Ghost: () => null, Layers: () => null, ListTodo: () => null, LoaderCircle: () => null, PencilLine: () => null, RefreshCw: () => null, Send: () => null, Share: () => null, Sparkles: () => null, Split: () => null, Timer: () => null, Trash2: () => null, TriangleAlert: () => null, Undo2: () => null, X: () => null,
}));
vi.mock('react-native-svg', () => ({ default: () => null, Circle: () => null }));
vi.mock('react-native-uitextview', () => ({ UITextView: () => null }));
vi.mock('expo-image', () => ({ Image: () => null }));
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
vi.mock('@/platform/chrome', () => ({ NativePullDownMenu: () => null, showActionMenu: vi.fn(), usesNativePullDownMenu: () => false, usesSystemActionMenu: () => false }));
vi.mock('@/session/MobileComposerInputRow', () => ({ MobileComposerInputRow: () => null, MOBILE_COMPOSER_VOICE_ANCHOR_RIGHT: 0, MOBILE_COMPOSER_CONTROL_SIZE: 44 }));
vi.mock('@/session/ImageLightbox', () => ({ ImageLightbox: () => null }));
vi.mock('@/session/mermaidWebView', () => ({ MermaidDiagram: () => null }));
vi.mock('@/session/mathWebView', () => ({ MathFormulaWebView: () => null }));
vi.mock('@/session/mediaPlayerWebView', () => ({ RemoteMediaPlayerWebView: () => null }));
vi.mock('@/session/MarkdownBlockContent', () => ({ MarkdownBlockContent: () => null }));
vi.mock('@/session/MessageActionSheet', () => ({ MessageActionSheet: () => null }));
vi.mock('@/session/AuthorizationMessageCard', () => ({ AuthorizationMessageCard: () => null }));
vi.mock('@/session/CompanionMessageCard', () => ({ CompanionMessageCard: () => null }));
vi.mock('@/session/PendingSendBubble', () => ({ PendingSendBubble: () => null }));
vi.mock('@/session/messageActions', async (original) => ({ ...await original<object>(), copyMessageText: vi.fn(), writeClipboardText: vi.fn() }));

import { MessageRenderer } from '@/session/MessageRenderer';
import { buildMobileMessageRenderItems } from '@/session/messageRenderModel';
import type { RemoteMessage } from '@/session/types';
const msg = (id: string, role: RemoteMessage['role'], content: unknown, extra: Partial<RemoteMessage> = {}): RemoteMessage => ({ id, clientId: id, sessionId: 's', role, content, toolUseId: null, agentMeta: null, createdAt: '2026-01-01T00:00:00Z', ...extra });

function render(showPluginInvocations = true, settled = false, withCall = true, kind: 'file' | 'image' = 'file') {
  const messages = [msg('u', 'user', JSON.stringify(kind === 'file' ? { text: '', files: [{ name: 'sample.txt', path: '/tmp/sample.txt' }] } : { text: '', images: [{ url: 'https://example.com/sample.png', originalName: 'sample.png', mimeType: 'image/png' }] }))];
  if (withCall) messages.push(msg('c', 'tool_use', { toolName: 'mcp__cindy__ghost_call', toolUseId: 'c', input: { ghost_id: 'art', tool: 'generate' } }, { toolUseId: 'c' }));
  if (settled) messages.push(msg('r', 'tool_result', 'done', { toolUseId: 'c' }));
  const items = buildMobileMessageRenderItems(messages, { isSessionStreaming: true }).filter((item) => item.type === 'message');
  expect(items[0]).toMatchObject({ message: { body: '', attachments: [{ kind }] } });
  return renderToStaticMarkup(<MessageRenderer items={items} isSessionStreaming showPluginInvocations={showPluginInvocations} />);
}

describe('attachment-only user plugin bubble', () => {
  it.each(['file', 'image'] as const)('renders a %s-only plugin header through completion', (kind) => {
    for (const settled of [false, true]) {
      const html = render(true, settled, true, kind);
      expect(html).toContain('message.userBubble');
      expect(html).toContain('Art');
      expect(html).toContain(settled ? 'Called' : 'Calling…');
    }
  });
  it('keeps partner attachment messages free of plugin shells', () => {
    expect(render(false)).not.toContain('message.userBubble');
  });
  it('does not add an empty bubble to ordinary attachments', () => {
    expect(render(true, false, false)).not.toContain('message.userBubble');
  });
});
