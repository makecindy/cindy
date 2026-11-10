// @vitest-environment jsdom
import { act, createElement, useImperativeHandle, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const viewportHarness = vi.hoisted(() => ({ list: null as any, finishReveal: null as any, renders: 0, expanded: false }));

// Keep site-video's native surface out of this Node message-rendering test.
vi.mock('@/platform/gestureHandler', () => {
  const chain = (): any => new Proxy({}, { get: (_target, key) => key === 'then' ? undefined : () => chain() });
  return { GestureDetector: ({ children }: { children: unknown }) => children, Gesture: { LongPress: chain } };
});
vi.mock('react-native-webview', () => ({ WebView: () => null }));
vi.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: () => null,
  requireNativeViewManager: () => () => null,
}));
vi.mock('@/session/NativeVideoPlayer', () => ({ NativeVideoPlayer: () => null }));

// Keep the production list, bubble gate, invocation header, and message model.
// Only native surfaces and unrelated heavy viewers are replaced for Node rendering.
vi.mock('react-native', async () => {
  const React = await import('react');
  const window = { width: 402, height: 874, scale: 3, fontScale: 1 };
  const view = ({ children, testID, accessibilityLabel, onPress }: any) => React.createElement('div', { 'data-testid': testID, 'aria-label': accessibilityLabel, onClick: onPress }, children);
  class Value { constructor(public value: number) {} interpolate() { return 0; } setValue() {} stopAnimation() {} }
  return {
    View: view, Text: view, Pressable: view, ScrollView: view, Modal: () => null,
    Image: Object.assign(view, { getSize() {} }), ActivityIndicator: view,
    Animated: { Value, View: view, Text: view, createAnimatedComponent: (c: any) => c,
      timing: () => ({ start(callback: any) { viewportHarness.finishReveal = callback; }, stop() {} }), loop: () => ({ start() {}, stop() {} }), sequence: () => ({ start() {}, stop() {} }) },
    Platform: { OS: 'ios', select: (s: any) => s.ios ?? s.default },
    StyleSheet: { create: (s: any) => s, flatten: (s: any) => s, hairlineWidth: 1 },
    Easing: { linear: (n: number) => n, bezier: () => (n: number) => n },
    AccessibilityInfo: { isReduceMotionEnabled: () => Promise.resolve(true), addEventListener: () => ({ remove() {} }) }, Alert: {}, Linking: {}, StatusBar: {},
    Dimensions: { get: () => window, addEventListener: () => ({ remove() {} }) },
    useWindowDimensions: () => ({ width: 402, height: 874, scale: 3, fontScale: 1 }),
  };
});
vi.mock('@legendapp/list/react-native', () => ({
  LegendList: ({ data, renderItem, ref, ...props }: any) => {
    viewportHarness.renders += 1;
    viewportHarness.list = { ...props, data };
    useImperativeHandle(ref, () => ({ scrollToEnd() {}, scrollToOffset() {}, getState() { return undefined; } }));
    return data.map((item: any, index: number) => createElement('section', { key: item.key }, renderItem({ item, index })));
  },
  useRecyclingState: (initial: any) => useState(initial), useViewability: () => {},
}));
vi.mock('lucide-react-native', () => ({
  Mail: () => null, CalendarDays: () => null, Folder: () => null, ChartColumn: () => null, Info: () => null, Clock: () => null, MapPin: () => null, Coffee: () => null, Image: () => null, Users: () => null, Star: () => null,
  Database: () => null, FileArchive: () => null, FileAudio: () => null, FileChartColumn: () => null,
  FileCode: () => null, FileImage: () => null, FileSpreadsheet: () => null, FileText: () => null, FileVideo: () => null,
  ArrowLeftRight: () => null, ArrowUp: () => null, Bot: () => null, Check: () => null, ChevronDown: () => null, ChevronRight: () => null, ChevronUp: () => null, Circle: () => null, CircleAlert: () => null, CircleCheck: () => null, CircleDashed: () => null, CircleMinus: () => null, CircleStop: () => null, CircleX: () => null, Copy: () => null, Ellipsis: () => null, ExternalLink: () => null, File: () => null, Ghost: () => null, Layers: () => null, ListTodo: () => null, LoaderCircle: () => null, PencilLine: () => null, RefreshCw: () => null, Send: () => null, Share: () => null, Sparkles: () => null, Split: () => null, Timer: () => null, Trash2: () => null, TriangleAlert: () => null, Undo2: () => null, X: () => null,
}));
vi.mock('react-native-svg', () => ({ default: () => null, Circle: () => null }));
vi.mock('react-native-uitextview', () => ({ UITextView: () => null }));
vi.mock('expo-image', () => ({ Image: () => null }));
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
vi.mock('@/session/expandedBlockMemory', () => ({ useFoldableExpandedState: () => [viewportHarness.expanded, vi.fn()] }));
vi.mock('@/platform/chrome', () => ({ NativePullDownMenu: () => null, showActionMenu: vi.fn(), usesNativePullDownMenu: () => false, usesSystemActionMenu: () => false }));
vi.mock('@/session/MobileComposerInputRow', () => ({ MobileComposerInputRow: () => null, MOBILE_COMPOSER_VOICE_ANCHOR_RIGHT: 0, MOBILE_COMPOSER_CONTROL_SIZE: 44 }));
vi.mock('@/session/ImageLightbox', () => ({ ImageLightbox: () => null }));
vi.mock('@/session/McpAppCard', () => ({ McpAppCard: () => null }));
vi.mock('@/session/mermaidWebView', () => ({ MermaidDiagram: () => null }));
vi.mock('@/session/mathWebView', () => ({ MathFormulaWebView: () => null }));
vi.mock('@/session/mediaPlayerWebView', () => ({ RemoteMediaPlayerWebView: () => null }));
vi.mock('@/session/MarkdownBlockContent', () => ({ MarkdownBlockContent: () => null }));
vi.mock('@/session/MessageActionSheet', () => ({ MessageActionSheet: () => null }));
vi.mock('@/session/AuthorizationMessageCard', () => ({ AuthorizationMessageCard: () => null }));
vi.mock('@/session/CompanionMessageActions', () => ({ CompanionMessageActions: () => <div data-testid="companion.messageActions" /> }));
vi.mock('@/session/CompanionMessageCard', () => ({ CompanionMessageCard: () => null }));
vi.mock('@/session/PendingSendBubble', () => ({ PendingSendBubble: () => null }));
vi.mock('@/session/messageActions', async (original) => ({ ...await original<object>(), copyMessageText: vi.fn(), writeClipboardText: vi.fn() }));

import { MessageRenderer } from '@/session/MessageRenderer';
import { buildMobileMessageRenderItems } from '@/session/messageRenderModel';
import { companionConversationItems } from '@/session/companionConversationPresentation';
import type { RemoteMessage } from '@/session/types';
const msg = (id: string, role: RemoteMessage['role'], content: unknown, extra: Partial<RemoteMessage> = {}): RemoteMessage => ({ id, clientId: id, sessionId: 's', role, content, toolUseId: null, agentMeta: null, createdAt: '2026-01-01T00:00:00Z', ...extra });

function render(companion = false, settled = false, withCall = true, kind: 'file' | 'image' = 'file') {
  const messages = [msg('u', 'user', JSON.stringify(kind === 'file' ? { text: '', files: [{ name: 'sample.txt', path: '/tmp/sample.txt' }] } : { text: '', images: [{ url: 'https://example.com/sample.png', originalName: 'sample.png', mimeType: 'image/png' }] }))];
  if (withCall) messages.push(msg('c', 'tool_use', { toolName: 'mcp__cindy__ghost_call', toolUseId: 'c', input: { ghost_id: 'art', tool: 'generate' } }, { toolUseId: 'c' }));
  if (settled) messages.push(msg('r', 'tool_result', 'done', { toolUseId: 'c' }));
  const items = buildMobileMessageRenderItems(messages, { isSessionStreaming: true }).filter((item) => item.type === 'message');
  expect(items[0]).toMatchObject({ message: { body: '', attachments: [{ kind }] } });
  return renderToStaticMarkup(<MessageRenderer items={items} isSessionStreaming companion={companion} />);
}

// Unit regression, 2026-11-07: real normalizer/model/renderer; a plugin call
// must not create a header or an empty user bubble around attachment-only input.
// Existing expectations incorrectly required the whole-turn calling label.
describe('attachment-only user plugin bubble', () => {
  it.each(['file', 'image'] as const)('does not turn a %s-only user message into a plugin execution bubble', (kind) => {
    for (const settled of [false, true]) {
      const html = render(false, settled, true, kind);
      expect(html).not.toContain('message.userBubble');
      expect(html).not.toContain('Art');
      expect(html).not.toContain(settled ? 'Called' : 'Calling…');
    }
  });
  it('keeps partner attachment messages free of plugin shells', () => {
    expect(render(true)).not.toContain('message.userBubble');
  });
  it('does not add an empty bubble to ordinary attachments', () => {
    expect(render(false, false, false)).not.toContain('message.userBubble');
  });
});

describe('partner work feedback', () => {
  // unit regression: run the real normalizer, message model, and renderer. The existing
  // failed-reply test checked the notice text but not the stray copy/reply/more bar.
  it.each([false, true])('keeps error notices action-free without hiding ordinary messages (companion=%s)', (companion) => {
    const host = document.createElement('div');
    const errorItems = buildMobileMessageRenderItems([
      msg('error', 'error', 'Connection interrupted'),
    ], { isSessionStreaming: false });
    host.innerHTML = renderClient(<MessageRenderer items={errorItems} companion={companion} />);
    expect(host.textContent).toContain('Could not complete the reply');
    expect(host.textContent).toContain('Error Details');
    expect(host.querySelectorAll('[data-testid="message.actionBar"], [data-testid="companion.messageActions"], [data-testid="message.actionSlot"]')).toHaveLength(0);

    const messages = buildMobileMessageRenderItems([
      msg('user', 'user', 'Please continue'),
      msg('answer', 'assistant', 'Completed answer', { agentMeta: { turnCompleted: true } }),
    ], { isSessionStreaming: false });
    host.innerHTML = renderClient(<MessageRenderer items={messages} companion={companion} />);
    expect(host.querySelectorAll(companion
      ? '[data-testid="companion.messageActions"]'
      : '[data-testid="message.actionBar"]')).toHaveLength(2);
  });

  it('retains failed reply warnings inside expanded work and the upstream error notice', () => {
    const items = buildMobileMessageRenderItems([
      msg('failed', 'assistant', 'Incomplete opening', { agentMeta: { failedSamplingAttempt: {
        threadId: 'thread', turnId: 'turn', attempt: 1, itemId: 'item',
      } } }),
      msg('error', 'error', 'Connection interrupted'),
      msg('answer', 'assistant', 'Accepted answer', { agentMeta: { turnCompleted: true } }),
    ], { isSessionStreaming: false });
    viewportHarness.expanded = true;
    try {
      const host = document.createElement('div');
      host.innerHTML = renderClient(<MessageRenderer items={items} />);
      expect(host.textContent).toContain('This reply did not complete. Its content is for reference only.');
      expect(host.textContent).toContain('Could not complete the reply');
      expect(host.textContent).toContain('Error Details');
      expect(host.querySelectorAll('[data-testid="message.agentBubble"]')).toHaveLength(2);
    } finally {
      viewportHarness.expanded = false;
    }
  });

  it('uses the short hint in the existing live work row and preserves the completed record', () => {
    const messages = [msg('u', 'user', 'Remember this'), msg('c', 'tool_use', {
      toolName: 'bot_memory', toolUseId: 'c', input: { action: 'write' },
    }, { toolUseId: 'c' })];
    const items = buildMobileMessageRenderItems(messages, { isSessionStreaming: true }).filter(item => item.type === 'work_group');
    expect(items).toHaveLength(1);
    const live = renderToStaticMarkup(<MessageRenderer items={items} companion isSessionStreaming companionWorkingLabel="Saving memory…" />);
    expect(live).toContain('Expand Saving memory…');
    expect(live).not.toContain('Expand Working…');
    const ordinary = renderToStaticMarkup(<MessageRenderer items={items} isSessionStreaming companionWorkingLabel="Saving memory…" />);
    expect(ordinary).not.toContain('Saving memory…');
    const done = items.map(item => ({ ...item, isStreaming: false }));
    const completed = renderToStaticMarkup(<MessageRenderer items={done} companion companionWorkingLabel="Saving memory…" />);
    expect(completed).not.toContain('Saving memory…');
    expect(completed).toContain('message.workGroupToggle');
  });
});

describe('running work group expansion', () => {
  // Missing preview regression: actual MessageRenderer must expose raw/old-Host
  // activity while folded, not just Host-projected lines. Native views are adapters.
  it('shows the latest thinking without Host lines in ordinary and companion tasks', () => {
    const messages = [msg('u', 'user', 'Check this'), ...Array.from({ length: 6 }, (_, n) =>
      msg(`thought-${n}`, 'thinking', { text: `Thinking step ${n}`, durationMs: 1 }))];
    const items = buildMobileMessageRenderItems(messages, { isSessionStreaming: true }).filter(item => item.type === 'work_group');
    for (const companion of [false, true]) {
      const html = renderToStaticMarkup(<MessageRenderer
        items={companion ? companionConversationItems(items) : items} companion={companion} isSessionStreaming />);
      expect(html).toContain('Thinking step 5');
      expect(html).not.toContain('Thinking step 0');
    }
  });
  it.each([undefined, []])('shows cached old-Host activity only when running lines are absent: %j', (lines) => {
    const setVisible = vi.fn();
    const items = buildMobileMessageRenderItems([
      msg('thought', 'thinking', { text: 'Cached thinking', durationMs: 1 }),
    ], { isSessionStreaming: true }).filter(item => item.type === 'work_group')
      .map(item => ({ ...item, deferred: { owner: {}, key: item.key, expanded: false,
        loading: false, failed: false, lines, setVisible, toggle() {}, retry() {} } }));
    const html = renderClient(<MessageRenderer items={companionConversationItems(items)} companion isSessionStreaming />);
    // The controller, not this regrouped row, decides from the Host lines whether a tail is read.
    expect(setVisible).toHaveBeenCalledWith(false, true);
    expect(html.includes('Cached thinking')).toBe(lines === undefined);
  });
  const render = (awaitingDetails: boolean) => {
    const messages = [msg('u', 'user', 'Fix it'), msg('c', 'tool_use', {
      toolName: 'Bash', toolUseId: 'c', input: { command: 'pnpm test' },
    }, { toolUseId: 'c' })];
    const items = buildMobileMessageRenderItems(messages, { isSessionStreaming: true })
      .filter((item) => item.type === 'work_group')
      .map((item) => ({ ...item, deferred: {
        owner: {}, key: 'work-c', expanded: false, loading: awaitingDetails, failed: false, awaitingDetails,
        lines: [{ kind: 'thinking' as const, key: 'line', text: 'Checking the failing case' }],
        setVisible: vi.fn(), toggle: vi.fn(), retry: vi.fn(),
      } }));
    expect(items).toHaveLength(1);
    viewportHarness.expanded = true;
    try {
      return renderToStaticMarkup(<MessageRenderer items={items} isSessionStreaming />);
    } finally {
      viewportHarness.expanded = false;
    }
  };

  it('keeps the Host lines visible after expanding until detail rows arrive', () => {
    const waiting = render(true);
    expect(waiting).toContain('message.workLine');
    expect(waiting).toContain('Collapse ');
    expect(waiting).not.toContain('pnpm test');
    const loaded = render(false);
    expect(loaded).not.toContain('message.workLine');
    expect(loaded).toContain('pnpm test');
  });
});

function renderClient(element: ReturnType<typeof createElement>): string {
  const { act } = require('react') as typeof import('react');
  const { createRoot } = require('react-dom/client') as typeof import('react-dom/client');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  const root = createRoot(host);
  act(() => root.render(element));
  const html = host.innerHTML;
  act(() => root.unmount());
  return html;
}

describe('partner conversation presentation', () => {
  const result = (delegationId: string) => ({
    v: 1, role: 'delegation-result', delegationId, fromBotId: 'bot', fromBotName: 'Cindy',
    toBotId: null, toBotName: '', parentSessionId: 's', childSessionId: 'child', objective: 'Report',
    result: { runSequence: 1, status: 'completed', title: `Result ${delegationId}`, text: 'Frozen result', artifacts: [] },
  });
  const resultItems = (body = 'Final summary', turnCompleted = true) => buildMobileMessageRenderItems([
    msg('final', 'assistant', body, { agentMeta: { turnCompleted, botTaskResults: [result('one'), result('two')] } }),
  ], { isSessionStreaming: false });

  it('renders multiple real result cards after the final bubble inside the same partner reply', () => {
    const host = document.createElement('div');
    host.innerHTML = renderClient(<MessageRenderer items={resultItems()} companion companionAvatar={<i />} />);
    const reply = host.querySelector('[data-testid="companion.replyRow"]');
    const bubble = reply?.querySelector('[data-testid="message.agentBubble"]');
    const cards = reply?.querySelectorAll('[data-testid="companion.taskResult"]');
    expect(bubble).toBeTruthy();
    expect(cards).toHaveLength(2);
    expect(cards?.[0].textContent).toContain('Result one');
    expect(cards?.[1].textContent).toContain('Result two');
    for (const card of cards!) {
      expect(bubble!.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(card.parentElement).toBe(bubble!.parentElement);
    }
  });

  it('keeps result attachments out of ordinary tasks, unfinished prose and empty replies', () => {
    const cases = [
      <MessageRenderer items={resultItems()} />,
      <MessageRenderer items={resultItems('Progress', false)} companion />,
      <MessageRenderer items={resultItems('')} companion />,
    ];
    for (const element of cases) expect(renderClient(element)).not.toContain('companion.taskResult');
  });

  // Regression: the process and final reply each own one portrait; nested details do not.
  // Exercise the production projection and renderer, including nested work groups.
  it('shows one process portrait and one reply portrait without repeating them in expanded details', () => {
    const items = companionConversationItems(buildMobileMessageRenderItems([
      msg('u', 'user', 'Check it'),
      msg('p', 'assistant', 'Checking the details', { agentMeta: { assistantPhase: 'commentary' } }),
      msg('t', 'tool_use', { toolName: 'Bash', toolUseId: 't', input: { command: 'pwd' } }, { toolUseId: 't' }),
      msg('f', 'assistant', 'Here is the result', { agentMeta: { assistantPhase: 'final_answer' } }),
    ], { isSessionStreaming: false }));
    viewportHarness.expanded = true;
    try {
      const html = renderClient(<MessageRenderer items={items} companion companionAvatar={<i data-testid="partner-portrait" />} />);
      expect(html.match(/message\.agentBubble/g)).toHaveLength(2);
      expect(html).toContain('message.toolRow');
      expect(html.match(/companion\.replyRow/g)).toHaveLength(1);
      expect(html.match(/companion\.processRow/g)).toHaveLength(1);
      expect(html.match(/partner-portrait/g)).toHaveLength(2);
    } finally {
      viewportHarness.expanded = false;
    }
  });

  // PR #8864: an Agent's nested tool work must not inherit the main partner's
  // portrait. Existing process expansion coverage did not cross SubagentCard.
  // Production projection + renderer, unit tier; Agent -> tool -> child answer
  // is the smallest input that exposes the extra process portrait.
  it('keeps the main partner portrait out of expanded subagent work', () => {
    const items = companionConversationItems(buildMobileMessageRenderItems([
      msg('u', 'user', 'Research it'),
      msg('agent', 'tool_use', { toolName: 'Agent', toolUseId: 'agent', input: { description: 'Research' } }, { toolUseId: 'agent' }),
      msg('tool', 'tool_use', { toolName: 'Bash', toolUseId: 'tool', input: { command: 'pwd' } }, { toolUseId: 'tool', agentMeta: { parentUuid: 'agent' } }),
      msg('tool-result', 'tool_result', '/repo', { toolUseId: 'tool', agentMeta: { parentUuid: 'agent' } }),
      msg('child-answer', 'assistant', 'Child research complete', { agentMeta: { parentUuid: 'agent', assistantPhase: 'final_answer' } }),
      msg('agent-result', 'tool_result', 'Research summary', { toolUseId: 'agent' }),
      msg('answer', 'assistant', 'Main partner answer', { agentMeta: { assistantPhase: 'final_answer' } }),
    ], { isSessionStreaming: false }));
    viewportHarness.expanded = true;
    try {
      const html = renderClient(<MessageRenderer items={items} companion companionAvatar={<i data-testid="partner-portrait" />} />);
      const host = document.createElement('div');
      host.innerHTML = html;
      expect(host.querySelector('[data-testid="message.subagentToggle"]')).toBeTruthy();
      expect(host.querySelector('[data-testid="message.toolRow"]')).toBeTruthy();
      expect(host.textContent).toContain('Research summary');
      expect(host.querySelectorAll('[data-testid="companion.processRow"]')).toHaveLength(0);
      expect(host.querySelectorAll('[data-testid="partner-portrait"]')).toHaveLength(1);
    } finally {
      viewportHarness.expanded = false;
    }
  });

  it('hangs replies from the partner portrait and stamps five-minute groups like Desktop', () => {
    const messages = [
      msg('u1', 'user', 'Hi', { createdAt: '2026-01-01T09:00:00Z' }),
      msg('a1', 'assistant', 'Hello', { createdAt: '2026-01-01T09:01:00Z' }),
      msg('u2', 'user', 'Later', { createdAt: '2026-01-01T09:10:00Z' }),
    ];
    const items = buildMobileMessageRenderItems(messages, { isSessionStreaming: false });
    const portrait = <i data-testid="partner-portrait" />;
    const html = renderClient(<MessageRenderer items={items} companion companionAvatar={portrait} />);
    // 09:00 opens a group, 09:01 joins it, 09:10 opens the next one.
    expect(html.match(/companion\.timeGroup/g)).toHaveLength(2);
    expect(html.match(/companion\.replyRow/g)).toHaveLength(1);
    expect(html.match(/partner-portrait/g)).toHaveLength(1);
    const ordinary = renderClient(<MessageRenderer items={items} companionAvatar={portrait} />);
    expect(ordinary).not.toContain('companion.timeGroup');
    expect(ordinary).not.toContain('companion.replyRow');
  });
});

// Regression (#8379 review): LegendList redraws a kept row only when its item or `extraData` changes.
// Cross-row companion state (which reply is the last for its message, five-minute stamps) must
// therefore reach `extraData`, now that the plugin-work map no longer changes on every flush.
it.each([
  ['a later reply to the same message moves the reply target', (messages: RemoteMessage[]) => [...messages,
    msg('a2', 'assistant', 'Also', { createdAt: '2026-01-01T09:02:00Z', agentMeta: { replyToClientId: 'u1' } })]],
  ['a corrected earlier time regroups the following rows', (messages: RemoteMessage[]) => [
    msg('u1', 'user', 'Hi', { createdAt: '2026-01-01T08:00:00Z' }), ...messages.slice(1)]],
])('refreshes kept companion rows when %s', async (_name, change) => {
  const { createRoot } = await import('react-dom/client');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const messages = [
    msg('u1', 'user', 'Hi', { createdAt: '2026-01-01T09:00:00Z' }),
    msg('a1', 'assistant', 'Hello', { createdAt: '2026-01-01T09:01:00Z', agentMeta: { replyToClientId: 'u1' } }),
  ];
  const quote = { names: { owner: 'Me', companion: 'Cindy' }, showReplyTargets: true, onQuote: vi.fn(), onLocate: vi.fn() };
  const view = (rows: RemoteMessage[]) => <MessageRenderer
    items={buildMobileMessageRenderItems(rows, { isSessionStreaming: false })} companion companionQuote={quote} />;
  const root = createRoot(document.createElement('div'));
  act(() => root.render(view(messages)));
  const before = viewportHarness.list.extraData;
  act(() => root.render(view(change(messages))));
  expect(viewportHarness.list.extraData).not.toBe(before);
  act(() => root.unmount());
});

// Regression (#8379 review): copy text is memoized per row, but its attachment prefix is localized.
// A kept row must copy in the language the UI shows now, not the one it first rendered in.
it('copies a kept row with the attachment prefix of the current UI language', async () => {
  const [{ createRoot }, { i18n }, { copyMessageText }] = await Promise.all([
    import('react-dom/client'), import('@/i18n'), import('@/session/messageActions')]);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.mocked(copyMessageText).mockResolvedValue('copied' as never);
  const previous = i18n.language;
  const host = document.createElement('div');
  const root = createRoot(host);
  const items = buildMobileMessageRenderItems([msg('u', 'user', JSON.stringify({
    text: 'Look', files: [{ name: 'sample.txt', path: '/tmp/sample.txt' }] }))], { isSessionStreaming: false });
  const copy = async () => {
    // The copy control is labelled by its state (Copy / Copied / Failed) in the current language.
    const labels = ['copyStateCopy', 'copyStateCopied', 'copyStateFailed'].map((key) => i18n.t(`message.renderer.${key}`));
    const button = [...host.querySelectorAll('[aria-label]')].find((node) => labels.includes(node.getAttribute('aria-label') ?? ''));
    expect(button).toBeTruthy();
    await act(async () => { button!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    return vi.mocked(copyMessageText).mock.calls.at(-1)?.[0];
  };
  try {
    await act(async () => { await i18n.changeLanguage('en'); });
    act(() => root.render(<MessageRenderer items={items} />));
    expect(await copy()).toContain('Attachments: sample.txt');
    await act(async () => { await i18n.changeLanguage('de'); });
    expect(await copy()).toContain('Anhänge: sample.txt');
  } finally {
    act(() => root.unmount());
    await i18n.changeLanguage(previous);
    vi.mocked(copyMessageText).mockReset();
  }
});

describe('companion native read position', () => {
  it('leaves ordinary task lists without the companion viewability observer', () => {
    const acknowledge = vi.fn();
    const items = buildMobileMessageRenderItems([msg('a', 'assistant', 'Task reply')], { isSessionStreaming: false });
    renderClient(<MessageRenderer items={items} onCompanionReadThrough={acknowledge} />);
    expect(viewportHarness.list.onViewableItemsChanged).toBeTypeOf('function');
    viewportHarness.list.onViewableItemsChanged({ viewableItems: items.map(item => ({
      item, key: item.key, isViewable: true,
    })) });
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it('keeps unseen replies unread until reveal, measured tail and row visibility agree', async () => {
    const { createRoot } = await import('react-dom/client');
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.useFakeTimers();
    const root = createRoot(document.createElement('div'));
    const acknowledge = vi.fn();
    let active = true;
    const isActive = () => active;
    const messages = [msg('a1', 'assistant', 'First reply', { agentMeta: { turnCompleted: true } }),
      msg('a2', 'assistant', 'Latest reply', { agentMeta: { turnCompleted: true }, createdAt: '2026-01-01T00:01:00Z' })];
    const items = companionConversationItems(buildMobileMessageRenderItems(messages, { isSessionStreaming: false }));
    const visible = (rows = items) => viewportHarness.list.onViewableItemsChanged({ viewableItems: rows.map((item, index) => ({
      item, key: item.key, index, containerId: index, isViewable: true,
    })), changed: [], start: 0, end: rows.length, startBuffered: 0, endBuffered: rows.length });
    const scroll = (offsetY: number) => viewportHarness.list.onScroll({ nativeEvent: {
      contentSize: { height: 2000 }, layoutMeasurement: { height: 500 }, contentOffset: { y: offsetY },
    } });
    try {
      await act(async () => root.render(<MessageRenderer items={items} companion onCompanionReadThrough={acknowledge} isReadingPositionActive={isActive} />));
      await act(async () => { await vi.advanceTimersByTimeAsync(32); });
      expect(acknowledge).not.toHaveBeenCalled();
      await act(async () => { visible(); scroll(0); });
      expect(acknowledge).not.toHaveBeenCalled();
      // Even the native opacity fallback completing is not proof of reaching the tail.
      await act(async () => { viewportHarness.finishReveal?.({ finished: true }); });
      await act(async () => { await vi.advanceTimersByTimeAsync(32); });
      expect(acknowledge).not.toHaveBeenCalled();
      const first = items.filter(item => item.type === 'message' && item.message.source.clientId === 'a1');
      expect(first).toHaveLength(1);
      await act(async () => { visible(first); scroll(1500); });
      expect(acknowledge).toHaveBeenLastCalledWith(Date.parse(messages[0].createdAt));
      acknowledge.mockClear();
      active = false;
      await act(async () => visible());
      expect(acknowledge).not.toHaveBeenCalled();
      active = true;
      const rendersBeforeVisibility = viewportHarness.renders;
      await act(async () => visible());
      expect(acknowledge).toHaveBeenLastCalledWith(Date.parse(messages[1].createdAt));
      // A receipt must not broadcast visible keys and rerender the mounted message window.
      expect(viewportHarness.renders).toBe(rendersBeforeVisibility);
      acknowledge.mockClear();
      await act(async () => root.render(<MessageRenderer items={items} companion scrollResetKey="another-chat"
        onCompanionReadThrough={acknowledge} isReadingPositionActive={isActive} />));
      await act(async () => { await vi.advanceTimersByTimeAsync(32); });
      expect(acknowledge).not.toHaveBeenCalled();
      await act(async () => {
        visible();
        viewportHarness.list.onLayout({ nativeEvent: { layout: { height: 500 } } });
        viewportHarness.list.onContentSizeChange(400, 300);
      });
      expect(acknowledge).not.toHaveBeenCalled();
      await act(async () => { viewportHarness.finishReveal?.({ finished: true }); });
      await act(async () => { await vi.advanceTimersByTimeAsync(32); });
      expect(acknowledge).toHaveBeenLastCalledWith(Date.parse(messages[1].createdAt));
    } finally {
      await act(async () => root.unmount());
      vi.useRealTimers();
    }
  });
});

vi.mock('@/session/RemoteAttachmentPreview', () => ({ RemoteAttachmentPreview: () => null }));

// Native blur rendering is outside the attachment layout contract.
vi.mock('expo-blur', () => ({ BlurView: () => null }));
