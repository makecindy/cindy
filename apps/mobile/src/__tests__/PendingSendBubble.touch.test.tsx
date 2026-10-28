// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { GestureResponderEvent } from 'react-native';
import type { MenuAction } from '@react-native-menu/menu';
import { PendingSendBubble, type PendingSendBubbleActions } from '@/session/PendingSendBubble';
import { MessageBodyText } from '@/session/ShareMessageCheckbox';
import { buildQueueRowPresentation, EMPTY_INPUT_PROJECTION } from '@/session/inputProjection';
import type { MobilePendingSendItem } from '@/session/pendingSendItems';
import { collectMobileMessageGalleryImages, lightboxImagesForPayload } from '@/session/messageGallery';
import { usePendingOutboxActions, usePendingSendActions } from '@/session/usePendingSendActions';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import type { DurableOutboxRecord } from '@/session/durableOutbox';
import type { TFunction } from 'i18next';

const outbox = vi.hoisted(() => ({ records: [] as DurableOutboxRecord[], update: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/session/mobileDurableOutbox', () => ({
  getCurrentMobileOutboxRecords: () => outbox.records,
  mobileDurableOutbox: { update: outbox.update },
}));

const { handlers, frames, durableThumbs } = vi.hoisted(() => ({
  handlers: new Map<string, Record<string, unknown>>(),
  frames: new Map<number, FrameRequestCallback>(),
  durableThumbs: new Map<string, string>(),
}));
vi.mock('react-native', async () => {
  const { createElement } = await import('react');
  const view = (tag: string) => (props: Record<string, unknown> & { children?: ReactNode }) => {
    if (props.testID) handlers.set(String(props.testID), props);
    return createElement(tag, { 'data-testid': props.testID, onClick: props.disabled ? undefined : props.onPress }, props.children);
  };
  class AnimatedValue { setValue() {} interpolate() { return 0; } }
  return { View: view('div'), Text: view('span'), Pressable: view('button'), ActivityIndicator: () => null,
    Platform: { OS: 'ios' }, NativeModules: {}, UIManager: { getViewManagerConfig: () => ({}) },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Animated: { View: view('div'), Value: AnimatedValue, timing: () => ({ start() {}, stop() {} }) },
    Easing: { bezier: () => (value: number) => value },
    AccessibilityInfo: { isReduceMotionEnabled: () => Promise.resolve(true), addEventListener: () => ({ remove() {} }) } };
});
vi.mock('@react-native-menu/menu', async () => {
  const { createElement } = await import('react');
  return { MenuView: (props: Record<string, unknown> & { children?: ReactNode }) => {
    handlers.set(String(props.testID), props);
    return createElement('div', { 'data-testid': props.testID }, props.children);
  } };
});
vi.mock('@/platform/chrome/AnchoredPullDownMenu', () => ({ AnchoredPullDownMenu: () => null }));
vi.mock('@/components/AppText', async () => ({ Text: (await import('react-native')).Text }));
vi.mock('lucide-react-native', () => ({ Check: () => null, AlertCircle: () => null, ArrowUp: () => null, ArrowDown: () => null,
  ListEnd: () => null, Paperclip: () => null, Pencil: () => null, RotateCcw: () => null, Trash2: () => null,
  Bot: () => null, Ghost: () => null, Send: () => null, Timer: () => null,
  Monitor: () => null, Smartphone: () => null, Clock: () => null, ChevronDown: () => null }));
vi.mock('@/session/SentInlineAtomBody', () => ({ SentInlineAtomBody: () => null }));
vi.mock('@/session/sentAttachmentThumbStore', () => ({ getSentAttachmentThumbUri: (ref: string) => durableThumbs.get(ref) ?? null,
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
const openImage = vi.fn();
const removeOutbox = vi.fn();
const retryOutbox = vi.fn();
const remove = vi.fn();
const edit = vi.fn();
const steer = vi.fn();
const move = vi.fn();
const item: MobilePendingSendItem = {
  type: 'pending_send', key: 'message-a', clientId: 'a', phase: 'queued', text: 'hello',
  queueIndex: 1, sentInlineTokens: [], thumbs: [], fileCount: 0, attachmentCount: 0, uploadedCount: 0,
  errorText: null, hint: null, actions: {
    remove: { disabled: false, disabledReason: null }, edit: { disabled: false, disabledReason: null },
    steer: { disabled: false, disabledReason: null },
    moveUp: { disabled: true, disabledReason: null, targetIndex: null },
    moveDown: { disabled: true, disabledReason: null, targetIndex: null },
  },
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  handlers.clear(); frames.clear();
  durableThumbs.clear();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.set(++frameId, cb); return frameId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  host = document.createElement('div'); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });
function show(
  overrides: Partial<MobilePendingSendItem> = {},
  selectedClientId: string | null = null,
  viewerDeviceId: string | null = null,
  busy = false,
) {
  handlers.clear();
  const actions: PendingSendBubbleActions = { selectedClientId, onSelect: select, onRemove: remove,
    onBeginEdit: edit, onSteer: steer, onMove: move, onRetryOutbox: retryOutbox, onRemoveOutbox: removeOutbox, busy };
  act(() => root.render(<PendingSendBubble item={{ ...item, ...overrides }} actions={actions} viewerDeviceId={viewerDeviceId}
    onOpenImage={openImage}
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
it('lets an in-flight local outbox message open its cancel action', () => {
  show({ actions: null, phase: 'sending', queueIndex: null });
  touch('Start'); touch('End'); flush();
  expect(select).toHaveBeenCalledWith('a');

  show({ actions: null, phase: 'sending', queueIndex: null }, 'a');
  act(() => host.querySelector<HTMLElement>('[data-testid="pendingSend.outboxRemove.a"]')!.click());
  expect(removeOutbox).toHaveBeenCalledWith('a');
});
it('offers retry and delete on a failed send without opening it first, and re-uploads only the failed image', () => {
  show({ actions: null, phase: 'failed', queueIndex: null, attachmentCount: 2, thumbs: [
    { key: 'a-slot-0', uri: 'file:///ok.jpg', ossRef: 'cindy-oss-attach://ok', uploading: false },
    { key: 'a-slot-1', uri: 'file:///bad.jpg', ossRef: null, uploading: false, failed: true },
  ] });
  expect(host.querySelector('[data-testid="pendingSend.imageRetry.a-slot-0"]')).toBeNull();
  act(() => host.querySelector<HTMLElement>('[data-testid="pendingSend.imageRetry.a-slot-1"]')!.click());
  act(() => host.querySelector<HTMLElement>('[data-testid="pendingSend.outboxRetry.a"]')!.click());
  expect(retryOutbox.mock.calls).toEqual([['a'], ['a']]);
  act(() => host.querySelector<HTMLElement>('[data-testid="pendingSend.outboxRemove.a"]')!.click());
  expect(removeOutbox).toHaveBeenCalledWith('a');
  expect(select).not.toHaveBeenCalled();
});
it('lets a real body link consume the pending tap before the frame commits', () => {
  show(); touch('Start'); touch('End');
  act(() => host.querySelector<HTMLElement>('[data-testid="link"]')!.click());
  flush(); expect(openLink).toHaveBeenCalledOnce(); expect(select).not.toHaveBeenCalled();
});

// #7083 unit regression: the production hooks feed the real bubble. Existing
// touch tests inject static callbacks, so they cannot catch callback churn or
// a retry/edit routed to the previous task after a task switch. Minimal input:
// two tasks with the same client ID, plus an unrelated parent render.
it('keeps pending actions stable and routes bubble actions to the current task', async () => {
  outbox.records = ['task-a', 'task-b'].map((sessionId): DurableOutboxRecord => ({
    version: 1, accountId: 'test', deviceId: 'pc', createdAt: 1, state: 'failed', uploads: [],
    item: { clientId: 'a', sessionId, text: sessionId, quotesEncoded: false,
      agentReferences: [], pastedTextRanges: [], slashCommandRanges: [], permissionModeAtSend: 'plan',
      attachmentSlots: [], slotMeta: [], slotByLocalId: {}, waitingIds: [], failedIds: [],
      enqueueError: null, phase: 'uploading' },
  }));
  const bindings = {
    deviceId: 'pc', deviceName: 'Computer', router: { push: vi.fn() },
    outboxSessionAliveRef: { current: 'task-a' }, setError: vi.fn(),
    setQueueSelectedClientId: select, t: ((key: string) => key) as TFunction,
  };
  const renderText = vi.fn(() => <span>pending message</span>);
  const renderMedia = () => null;
  const failedItem: MobilePendingSendItem = { ...item, phase: 'failed', actions: null };
  let actions!: PendingSendBubbleActions;
  function Screen({ sessionId, queueBusy = false, queued = false }: {
    sessionId: string; queueBusy?: boolean; queued?: boolean;
  }) {
    const { retryOutboxItem, removeOutboxItem } = usePendingOutboxActions({ ...bindings, sessionId });
    actions = usePendingSendActions({
      retryOutboxItem, removeOutboxItem, sessionId, queueBusy, queueSelectedClientId: null,
      setQueueSelectedClientId: select, beginQueueEdit: edit, steerQueueItem: steer,
      removeQueueItem: remove, moveQueueItem: move,
    });
    return <PendingSendBubble item={queued ? item : failedItem} actions={actions}
      renderText={renderText} renderFile={renderMedia} renderImage={renderMedia} />;
  }
  const showScreen = (sessionId = 'task-a', queueBusy = false, queued = false) =>
    act(() => root.render(<Screen {...{ sessionId, queueBusy, queued }} />));
  try {
    showScreen();
    const initial = actions;
    for (let n = 0; n < 30; n++) showScreen();
    expect(actions).toBe(initial);
    await act(async () => host.querySelector<HTMLElement>('[data-testid="pendingSend.outboxRetry.a"]')!.click());
    expect(outbox.update).toHaveBeenLastCalledWith(outbox.records[0], expect.objectContaining({ state: 'queued' }));
    showScreen('task-b');
    await act(async () => host.querySelector<HTMLElement>('[data-testid="pendingSend.outboxRetry.a"]')!.click());
    expect(outbox.update).toHaveBeenLastCalledWith(outbox.records[1], expect.objectContaining({ state: 'queued' }));
    const queued = { clientId: 'a', text: 'new task message', persistedContent: 'new task message',
      model: 'model', workingDir: '/synthetic', createOpts: {}, chatMessage: { role: 'user' as const } };
    remoteSessionStore.setInputProjection('task-b', { ...EMPTY_INPUT_PROJECTION, pendingQueue: [queued] });
    showScreen('task-b', false, true);
    const menu = handlers.get('pendingSend.queueMenu.a')!;
    act(() => (menu.onPressAction as (e: { nativeEvent: { event: string } }) => void)({ nativeEvent: { event: 'edit' } }));
    expect(edit).toHaveBeenLastCalledWith(queued);
    showScreen('task-b', true, true);
    expect(actions.busy).toBe(true);
  } finally {
    outbox.records = [];
    remoteSessionStore.clear();
  }
});
it.each(['queued', 'uploading', 'sending', 'settling', 'editing', 'failed'] as const)(
  'previews a %s image without changing queue selection or cancelling the send', (phase) => {
    show({ phase, thumbs: [{ key: 'a-slot-0', uri: 'file:///photo.jpg', ossRef: null,
      uploading: phase === 'uploading' }], attachmentCount: 1 });
    act(() => host.querySelector<HTMLElement>('[data-testid="pendingSend.image.a-slot-0"]')!.click());
    flush();
    expect(openImage).toHaveBeenCalledOnce();
    expect(openImage.mock.calls[0][0]).toMatchObject({ kind: 'media', media: {
      kind: 'image', url: 'file:///photo.jpg', previewable: true,
    } });
    expect(select).not.toHaveBeenCalled();
    expect(removeOutbox).not.toHaveBeenCalled();
  },
);
it('opens the host original rather than its local thumbnail and preserves the queue menu', () => {
  show({ thumbs: [{ key: 'a-slot-0', uri: 'file:///photo.jpg', ossRef: 'cindy-media://blobs/photo.jpg',
    uploading: false }], attachmentCount: 1 }, 'a');
  act(() => host.querySelector<HTMLElement>('[data-testid="pendingSend.image.a-slot-0"]')!.click());
  expect(openImage.mock.calls[0][0].media).toMatchObject({
    url: 'cindy-media://blobs/photo.jpg', previewable: false,
  });
  expect(select).not.toHaveBeenCalled();
  expect(host.querySelector('[data-testid="pendingSend.queueStatus.a"]')).not.toBeNull();
});
it('keeps an unavailable upload reference disabled until a local image becomes available', () => {
  const thumb = { key: 'a-slot-0', uri: null, ossRef: 'cindy-oss-attach://photo', uploading: false };
  show({ thumbs: [thumb] });
  expect(handlers.get('pendingSend.image.a-slot-0')?.disabled).toBe(true);
  act(() => host.querySelector<HTMLElement>('[data-testid="pendingSend.image.a-slot-0"]')!.click());
  expect(openImage).not.toHaveBeenCalled();
  show({ thumbs: [{ ...thumb, uri: 'file:///photo.jpg' }] });
  expect(handlers.get('pendingSend.image.a-slot-0')?.disabled).toBe(false);
  act(() => host.querySelector<HTMLElement>('[data-testid="pendingSend.image.a-slot-0"]')!.click());
  expect(openImage).toHaveBeenCalledOnce();
});
it('opens the full gallery when a durable copy arrives after the thumbnail locks its temporary URI', () => {
  const thumbs = [0, 1].map((index) => ({ key: `a-slot-${index}`, uri: `file:///temporary-${index}.jpg`,
    ossRef: `cindy-oss-attach://photo-${index}`, uploading: false }));
  show({ thumbs, attachmentCount: 2 });
  durableThumbs.set(thumbs[1].ossRef, 'file:///durable-1.jpg');
  show({ thumbs, attachmentCount: 2 });
  act(() => host.querySelector<HTMLElement>('[data-testid="pendingSend.image.a-slot-1"]')!.click());
  const payload = openImage.mock.calls[0][0];
  const gallery = collectMobileMessageGalleryImages([{ ...item, thumbs, attachmentCount: 2 }]);
  expect(lightboxImagesForPayload(gallery, payload, item.key)).toHaveLength(2);
  expect(payload.galleryImageSlot).toBe(1);
  expect(payload.media.url).toBe('file:///temporary-1.jpg');
  expect(gallery[1].url).toBe('file:///durable-1.jpg');
  expect(select).not.toHaveBeenCalled();
});
it('captures the clicked slot without skipping an earlier unreadable thumbnail', () => {
  const thumbs = [
    { key: 'a-slot-0', uri: null, ossRef: null, uploading: true },
    { key: 'a-slot-1', uri: 'file:///clicked.jpg', ossRef: null, uploading: false },
  ];
  show({ thumbs, attachmentCount: 2 });
  expect(handlers.get('pendingSend.image.a-slot-0')?.disabled).toBe(true);
  act(() => host.querySelector<HTMLElement>('[data-testid="pendingSend.image.a-slot-1"]')!.click());
  expect(openImage.mock.calls[0][0]).toMatchObject({ galleryImageKey: 'a-slot-1', galleryImageSlot: 1 });
  expect(select).not.toHaveBeenCalled();
});
it('shows the source label above the bubble and announces it with the queued message', () => {
  show({ source: { kind: 'automation', label: '由自动化「巡检」发送' } });
  const label = host.querySelector('[data-testid="pendingSend.source.a"]');
  expect(label?.textContent).toBe('由自动化「巡检」发送');
  expect(handlers.get('pendingSend.source.a')?.accessibilityLabel).toBe('由自动化「巡检」发送');
  expect(handlers.get('pendingSend.queueStatus.a')?.accessibilityLabel).toBe('message.queue.withSource');
  show();
  expect(host.querySelector('[data-testid="pendingSend.source.a"]')).toBeNull();
  expect(handlers.get('pendingSend.queueStatus.a')?.accessibilityLabel).toBe('message.queue.queuedMessageLabel');
});

// 用户 2026-10-23 要求排队操作收进带图标的原生菜单。现有触摸用例未覆盖菜单桥接：
// unit 直接渲染 PendingSendBubble,以一条 queued 消息验证原生 action 协议与目标消息,
// 并验证不可用操作不会因从行内按钮移进菜单而绕过限制。
it('keeps queue actions inside the native tap menu and routes each choice to its message', () => {
  show();
  expect(host.textContent).toContain('message.queue.queued');
  expect(host.textContent).not.toContain('message.queue.steer');
  expect(host.querySelector('[data-testid="pendingSend.badge.queued"]')).toBeNull();
  const menu = handlers.get('pendingSend.queueMenu.a')!;
  expect(menu.shouldOpenOnLongPress).toBe(false);
  expect((menu.actions as MenuAction[]).map(({ id, image }) => ({ id, image }))).toEqual([
    { id: 'steer', image: 'arrow.up' }, { id: 'edit', image: 'pencil' }, { id: 'remove', image: 'trash' },
  ]);
  const choose = menu.onPressAction as (event: { nativeEvent: { event: string } }) => void;
  act(() => { for (const event of ['steer', 'edit', 'remove']) choose({ nativeEvent: { event } }); });
  expect(steer.mock.calls).toEqual([['a']]);
  expect(edit.mock.calls).toEqual([['a']]);
  expect(remove.mock.calls).toEqual([['a']]);
  expect(select).not.toHaveBeenCalled();
});
// 使用生产队列规则覆盖首尾、中间、单条和锁定；验证显示与点击都遵守同一可用性。
it.each([
  { length: 1, index: 0, locked: false, expected: [] },
  { length: 2, index: 0, locked: false, expected: ['moveDown'] },
  { length: 2, index: 1, locked: false, expected: ['moveUp'] },
  { length: 3, index: 1, locked: false, expected: ['moveUp', 'moveDown'] },
  { length: 3, index: 1, locked: true, expected: [] },
])('shows available move directions for $index of $length, locked=$locked', ({ length, index, locked, expected }) => {
  const presentation = buildQueueRowPresentation({
    item: { clientId: 'a', text: 'hello' }, originalIndex: index, queueLength: length,
    projection: { ...EMPTY_INPUT_PROJECTION, queueEditLocks: locked ? ['a'] : [] },
  });
  show({ actions: presentation.actions, queueIndex: index + 1 });
  const menu = handlers.get('pendingSend.queueMenu.a');
  const moves = ((menu?.actions ?? []) as MenuAction[]).filter(({ id }) => id === 'moveUp' || id === 'moveDown');
  expect(moves.map(({ id }) => id)).toEqual(expected);
  expect(moves.map(({ image }) => image)).toEqual(expected.map((id) => id === 'moveUp' ? 'arrow.up' : 'arrow.down'));
  if (menu) {
    const choose = menu.onPressAction as (event: { nativeEvent: { event: string } }) => void;
    act(() => { for (const event of ['moveUp', 'moveDown']) choose({ nativeEvent: { event } }); });
  }
  expect(move.mock.calls).toEqual(expected.map((id) => ['a', id === 'moveUp' ? 'up' : 'down']));
});
it('hides unavailable choices and removes the menu while busy or dispatched', () => {
  show({ actions: { ...item.actions!, steer: { disabled: true, disabledReason: 'Not available' } } });
  const menu = handlers.get('pendingSend.queueMenu.a')!;
  expect((menu.actions as MenuAction[]).map(({ id }) => id)).toEqual(['edit', 'remove']);
  const choose = menu.onPressAction as (event: { nativeEvent: { event: string } }) => void;
  act(() => choose({ nativeEvent: { event: 'steer' } }));
  expect(steer).not.toHaveBeenCalled();
  show({}, null, null, true);
  expect(handlers.has('pendingSend.queueMenu.a')).toBe(false);
  expect(handlers.get('pendingSend.queueStatus.a')?.disabled).toBe(true);
  show({ phase: 'settling', actions: null });
  expect(host.querySelector('[data-testid="pendingSend.queueStatus.a"]')).toBeNull();
});

it('labels queued input from another device, hides it on the sending device, and keeps it editable', () => {
  const sourceDevice = { deviceId: 'phone-a', name: 'iPhone', platform: 'mobile' as const };
  show({ sourceDevice }, null, 'mac-1');
  expect(host.querySelector('[data-testid="pendingSend.sourceDevice.a"]')?.textContent).toContain('iPhone');
  // 测试里 t 原样返回 key:读屏提示是设备 ID 文案。
  expect(handlers.get('pendingSend.sourceDevice.a')?.accessibilityHint).toBe('message.renderer.sourceDeviceId');
  show({ sourceDevice }, null, 'phone-a');
  expect(host.querySelector('[data-testid="pendingSend.sourceDevice.a"]')).toBeNull();
});
