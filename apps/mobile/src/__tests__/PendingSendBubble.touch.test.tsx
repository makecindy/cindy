// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { GestureResponderEvent } from 'react-native';
import { PendingSendBubble, type PendingSendBubbleActions } from '@/session/PendingSendBubble';
import { MessageBodyText } from '@/session/ShareMessageCheckbox';
import type { MobilePendingSendItem } from '@/session/pendingSendItems';

const { handlers, frames } = vi.hoisted(() => ({
  handlers: new Map<string, Record<string, unknown>>(),
  frames: new Map<number, FrameRequestCallback>(),
}));
vi.mock('react-native', async () => {
  const { createElement } = await import('react');
  const view = (tag: string) => (props: Record<string, unknown> & { children?: ReactNode }) => {
    if (props.testID) handlers.set(String(props.testID), props);
    return createElement(tag, { 'data-testid': props.testID, onClick: props.disabled ? undefined : props.onPress }, props.children);
  };
  return { View: view('div'), Text: view('span'), Pressable: view('button'), ActivityIndicator: () => null,
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 } };
});
vi.mock('@/components/AppText', async () => ({ Text: (await import('react-native')).Text }));
vi.mock('lucide-react-native', () => ({ Check: () => null, AlertCircle: () => null, ArrowUp: () => null,
  ListEnd: () => null, Paperclip: () => null, Pencil: () => null, RotateCcw: () => null, Trash2: () => null }));
vi.mock('@/session/SentInlineAtomBody', () => ({ SentInlineAtomBody: () => null }));
vi.mock('@/session/sentAttachmentThumbStore', () => ({ getSentAttachmentThumbUri: () => null,
  useSentAttachmentThumbsVersion: () => 0 }));
vi.mock('react-i18next', () => ({ initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/theme', async () => {
  const tokens = await import('@/theme/tokens');
  return { ...tokens, useTheme: () => ({ colors: tokens.lightColors }),
    useThemedStyles: (make: (colors: typeof tokens.lightColors) => unknown) => make(tokens.lightColors) };
});

let root: Root;
let host: HTMLDivElement;
let frameId = 0;
const select = vi.fn();
const openLink = vi.fn();
const item: MobilePendingSendItem = {
  type: 'pending_send', key: 'message-a', clientId: 'a', phase: 'queued', text: 'hello',
  queueIndex: 1, sentInlineTokens: [], thumbs: [], fileCount: 0, attachmentCount: 0, uploadedCount: 0,
  errorText: null, hint: null, actions: {
    remove: { disabled: false, disabledReason: null }, edit: { disabled: false, disabledReason: null },
    steer: { disabled: false, disabledReason: null },
  },
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  handlers.clear(); frames.clear();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.set(++frameId, cb); return frameId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  host = document.createElement('div'); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });
function show(overrides: Partial<MobilePendingSendItem> = {}, selectedClientId: string | null = null) {
  handlers.clear();
  const actions: PendingSendBubbleActions = { selectedClientId, onSelect: select, onRemove: vi.fn(),
    onBeginEdit: vi.fn(), onSteer: vi.fn(), onRetryOutbox: vi.fn(), onRemoveOutbox: vi.fn() };
  act(() => root.render(<PendingSendBubble item={{ ...item, ...overrides }} actions={actions}
    renderImage={() => null} renderFile={() => null}
    renderText={() => <MessageBodyText testID="link" onPress={openLink}>link</MessageBodyText>} />));
}
function touch(type: 'Start' | 'Move' | 'End' | 'Cancel', x = 0, y = 0, count = type === 'End' ? 0 : 1) {
  const handler = handlers.get('pendingSend.body.a')?.[`onTouch${type}`] as ((e: GestureResponderEvent) => void) | undefined;
  act(() => handler?.({ nativeEvent: { pageX: x, pageY: y, touches: Array(count).fill({}) } } as GestureResponderEvent));
}
function flush() {
  act(() => { for (const [id, callback] of [...frames]) { frames.delete(id); callback(0); } });
}
it.each([null, 'a'])('toggles the same message for selection %s, allowing finger jitter', (selected) => {
  show({}, selected); touch('Start'); touch('Move', 3, 2); touch('End', 3, 2);
  expect(select).not.toHaveBeenCalled(); flush(); flush();
  expect(select.mock.calls).toEqual([[selected ? null : 'a']]);
});
it.each(['move', 'end', 'cancel', 'long', 'multi', 'disabled', 'unmount', 'recycle', 'deselect'])(
  'does not commit a %s gesture', (kind) => {
    show(); touch('Start');
    if (kind === 'move') touch('Move', 30);
    if (kind === 'cancel') touch('Cancel');
    if (kind === 'long') vi.advanceTimersByTime(500);
    if (kind === 'multi') touch('Start', 0, 0, 2);
    if (kind === 'disabled') show({ actions: null, phase: 'sending' });
    touch('End', kind === 'end' ? 30 : 0);
    if (kind === 'unmount') act(() => root.render(null));
    if (kind === 'recycle') show({ clientId: 'b' });
    if (kind === 'deselect') show({}, 'a');
    flush(); expect(select).not.toHaveBeenCalled();
  },
);
it('lets a real body link consume the pending tap before the frame commits', () => {
  show(); touch('Start'); touch('End');
  act(() => host.querySelector<HTMLElement>('[data-testid="link"]')!.click());
  flush(); expect(openLink).toHaveBeenCalledOnce(); expect(select).not.toHaveBeenCalled();
});
