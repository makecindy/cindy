// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAttachmentPayload } from '@/session/messagePayload';
import { svgAttachmentForDisplay } from '@/session/messageAttachments';
import { collectMobileMessageGalleryImages, galleryImageIndexForPayload, lightboxImagesForPayload } from '@/session/messageGallery';
import { buildMobileMessageRenderItems, type MobileMessageRenderItem } from '@/session/messageRenderModel';
import { buildOutboxItem, outboxDisplayItem, outboxItemAttachments, outboxItemWithUpload,
  type MobileOutboxThumb } from '@/session/sessionOutbox';
import { buildPendingSendItems, pendingSendItemKey } from '@/session/pendingSendItems';
import { computeVanishedQueueItems } from '@/session/queueSettling';
import { getSentMessageImagePreview, rememberOutboxImagePreviews, rememberSentMessageImagePreviews, type GetSentMessageImagePreview, type SentMessageImagePreviews } from '@/session/sentMessageImagePreviews';
import { createDurableOutbox, observeDurableOutboxSending, type DurableOutboxRecord } from '@/session/durableOutbox';
import type { QueuedRemoteMessage, RemoteSerializedAttachment } from '@/session/types';
import { createRemoteMediaResolveQueue } from '@/session/remoteMediaResolveQueue';
import type { MobileResolvedRemoteMedia } from '@/session/remoteMedia';
import {
  ImageLightbox,
  type ImageLightboxProps,
} from "@/session/ImageLightbox";

type Handler = (...args: any[]) => void;
type GestureNode = {
  kind: string;
  options: Record<string, any>;
  handlers: Record<string, Handler>;
  children?: GestureNode[];
};
type Animation = {
  target: number;
  done?: (finished: boolean) => void;
  decay?: { velocity: number; clamp: [number, number]; rubberBandEffect?: boolean;
  };
};
type Value = { value: number; animation?: Animation };
const runtime = vi.hoisted(() => ({
  nodes: new Map<string, any>(),
  values: [] as Value[],
  immediate: false,
  dimensions: { width: 400, height: 800 },
  insets: { top: 40, bottom: 20, left: 0, right: 0 },
  gesture: null as GestureNode | null,
  alerts: [] as Array<[string, string, Array<{ text: string; style?: string; onPress?: () => void }>]>,
  scrollToOffset: vi.fn(),
  renderPageIndex: 0,
  collectionSize: 2,
}));

vi.mock("@/session/SheetModal", () => ({
  SheetModal: ({ visible, children }: any) => (visible ? children : null),
}));

vi.mock("expo-router", () => ({
  useNavigation: () => ({ setOptions: () => undefined }),
}));
vi.mock('@/session/VideoDownloadButton', () => ({ VideoDownloadButton: (props: any) => {
  runtime.nodes.set('message.videoDownload', props); return null;
} }));
vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => runtime.insets,
}));
vi.mock("lucide-react-native", () => ({
  MessageSquarePlus: () => null,
  Pen: () => null,
  Share: () => null,
  Undo2: () => null,
  X: () => null,
  CircleAlert: () => null,
  ChevronLeft: () => null,
  ChevronRight: () => null,
  Ellipsis: () => null,
  Minus: () => null,
  Plus: () => null,
  Maximize: () => null,
  Redo2: () => null,
}));
vi.mock("react-native-svg", () => ({ default: () => null, Path: () => null }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/theme/tokens");
  return { ...tokens, useTheme: () => ({ colors: tokens.lightColors }),
    useThemedStyles: (make: (colors: typeof tokens.lightColors) => unknown) => make(tokens.lightColors) };
});
vi.mock("react-native", async () => {
  const { createElement, useImperativeHandle } = await import("react");
  const view = (name: string) => (props: any) => {
    runtime.nodes.set(props.testID ?? name, props);
    return createElement("div", { 'data-testid': props.testID, 'data-native-name': name }, props.children as ReactNode);
  };
  return {
    View: view("View"),
    ScrollView: view("ScrollView"),
    Pressable: view("Pressable"),
    Modal: view("Modal"),
    Text: view("Text"),
    ActivityIndicator: view("ActivityIndicator"),
    StatusBar: () => null,
    Alert: { alert: (...args: any[]) => runtime.alerts.push(args as any) },
    Image: view("Image"),
    Platform: { OS: "android" },
    StyleSheet: {
      create: (s: unknown) => s,
      absoluteFill: {},
      hairlineWidth: 1,
    },
    // Gesture scenarios use a fixed canvas; add the shared chrome outside it.
    useWindowDimensions: () => ({
      ...runtime.dimensions,
      height:
        runtime.dimensions.height +
        runtime.insets.top +
        runtime.insets.bottom +
        64 +
        (runtime.collectionSize > 1 ? 112 : 56),
    }),
    FlatList: (props: any) => {
      runtime.nodes.set("FlatList", props);
      useImperativeHandle(
        props.ref,
        () => ({ scrollToOffset: runtime.scrollToOffset }),
        [],
      );
      const index = runtime.renderPageIndex;
      return props.data.length ? props.renderItem({ item: props.data[index], index }) : null;
    },
  };
});
vi.mock("@/session/NativeVideoPlayer", async () => ({
  NativeVideoPlayer: (props: any) => {
    runtime.nodes.set(props.testID ?? "NativeVideoPlayer", props);
    return null;
  },
}));
vi.mock("@/session/mediaPlayerWebView", async () => ({
  RemoteMediaPlayerWebView: (props: any) => {
    runtime.nodes.set(props.testID ?? "RemoteMediaPlayerWebView", props);
    return null;
  },
}));
vi.mock("@/components/AppText", async () => ({
  Text: (await import("react-native")).Text,
}));
vi.mock("expo-image", async () => ({
  Image: (await import("react-native")).Image,
}));
vi.mock("@/platform/gestureHandler", async () => {
  const { View } = await import("react-native");
  const make = (kind: string) => {
    const node: GestureNode = { kind, handlers: {}, options: {} };
    const chain: any = new Proxy(node, {
      get(target, key: string) {
        if (key === "children") return target.children;
        if (key in target) return target[key as keyof GestureNode];
        return (value: any) => {
          if (key.startsWith("on")) node.handlers[key] = value;
          else node.options[key] = value;
          return chain;
        };
      },
    });
    return chain;
  };
  return {
    GestureHandlerRootView: View,
    GestureDetector: ({
      gesture,
      children,
    }: {
      gesture: GestureNode;
      children: ReactNode;
    }) => {
      runtime.gesture = gesture;
      return children;
    },
    Gesture: {
      Pan: () => make("Pan"),
      Pinch: () => make("Pinch"),
      Tap: () => make("Tap"),
      Exclusive: (...children: GestureNode[]) => ({
        kind: "Exclusive",
        children,
      }),
      Simultaneous: (...children: GestureNode[]) => ({
        kind: "Simultaneous",
        children,
      }),
    },
  };
});
// Execute the production handlers with real React hooks. Animations stay pending
// until the test advances a frame, including cancellation callbacks and zero-motion completion.
vi.mock("react-native-reanimated", async () => {
  const { useRef } = await import("react");
  const native = await import("react-native");
  const cancel = (cell: Pick<Value, "animation">) => {
    const old = cell.animation;
    cell.animation = undefined;
    old?.done?.(false);
  };
  const timing = (
    target: number,
    _config?: unknown,
    done?: Animation["done"],
  ) => ({ target, done });
  return {
    default: { View: native.View, createAnimatedComponent: (component: unknown) => component },
    useSharedValue: (initial: number) => {
      const ref = useRef<Value | null>(null);
      if (!ref.current) {
        let current = initial;
        const cell = {
          get value() {
            return current;
          },
          set value(next: number | Animation) {
            cancel(cell);
            if (typeof next === "number") current = next;
            else if (runtime.immediate) {
              current = next.target;
              next.done?.(true);
            } else cell.animation = next;
          },
          animation: undefined as Animation | undefined,
        };
        ref.current = cell as Value;
        runtime.values.push(ref.current);
      }
      return ref.current;
    },
    useAnimatedStyle: (calculate: () => unknown) => ({
      get current() {
        return calculate();
      },
    }),
    runOnJS: (fn: Handler) => fn,
    cancelAnimation: cancel,
    withTiming: timing,
    withSpring: timing,
    // 惯性滑行:测试里按速度方向直接落到 clamp 端点。
    withDecay: (decay: NonNullable<Animation["decay"]>, done?: Animation["done"]) => ({
      target: decay.velocity > 0 ? decay.clamp[1] : decay.clamp[0],
      done,
      decay,
    }),
  };
});

let root: Root;
let container: HTMLDivElement;
const isMounted = (id: string) => !!container.querySelector(`[data-testid="${id}"]`);
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  runtime.nodes.clear();
  runtime.values = [];
  runtime.immediate = false;
  runtime.dimensions = { width: 400, height: 800 };
  runtime.insets = { top: 40, bottom: 20, left: 0, right: 0 };
  runtime.alerts = [];
  runtime.scrollToOffset.mockClear();
  runtime.renderPageIndex = 0;
  root = createRoot((container = document.createElement("div")));
});
afterEach(() => act(() => root.unmount()));

function mount(overrides: Partial<ImageLightboxProps> = {}) {
  const image = {
    key: "one",
    url: "https://example.invalid/image.png",
    title: "Image",
    subtitle: "",
    payload: {
      kind: "media",
      media: {
        kind: "image",
        url: "https://example.invalid/image.png",
        previewable: true,
      },
    },
  } as ImageLightboxProps["images"][number];
  const props: ImageLightboxProps = {
    images: [image, { ...image, key: "two" }],
    initialUrl: image.url,
    onClose: vi.fn(),
    ...overrides,
  };
  const render = () => {
    runtime.collectionSize = props.images.length;
    act(() => root.render(<ImageLightbox {...props} />));
  };
  render();
  return { props, render };
}

describe('pending image gallery updates', () => {
  const collect = (thumbs: MobileOutboxThumb[]) => collectMobileMessageGalleryImages([{
    type: 'pending_send', key: 'pending', clientId: 'pending', phase: 'queued', text: '',
    thumbs, attachmentCount: thumbs.length, uploadedCount: 0, fileCount: 0, queueIndex: 1,
    sentInlineTokens: [], errorText: null, actions: null, hint: null,
  }]);
  const thumbs = [0, 1].map((index) => ({ key: `pending-slot-${index}`, uri: `file:///temporary-${index}.jpg`,
    ossRef: null, uploading: true }));

  it.each([false, true])('closes and cannot submit an old image after its source row loses all images (annotating: %s)', async (annotating) => {
    const initial = collect(thumbs);
    const onClose = vi.fn();
    const onShareImage = vi.fn();
    const onSubmit = vi.fn();
    const { props, render } = mount({ images: initial, initialUrl: initial[0].url, onClose, onShareImage,
      annotation: { submitLabel: 'Send', onSubmit } });
    if (annotating) {
      act(() => runtime.nodes.get('Image').onLoad({ source: { width: 400, height: 800 } }));
      press('message.imageLightboxAnnotateButton');
      const draw = gestures().find((gesture) => gesture.kind === 'Pan' && gesture.options.minDistance === 0)!;
      fire(draw, 'onStart', { x: 100, y: 200 });
      fire(draw, 'onFinalize', {}, true);
    }
    props.images = lightboxImagesForPayload(collect([]), initial[0].payload, 'pending', props.images, true);
    render();
    expect(props.images).toEqual([]);
    expect(onClose).toHaveBeenCalledOnce();
    if (annotating) press('message.imageLightboxAnnotationSubmit');
    await act(async () => { await Promise.resolve(); });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onShareImage).not.toHaveBeenCalled();
  });

  it.each(['remote middle removal', 'local cancellation', 'settling expiry', 'outbox cancellation']
    .flatMap((reason) => [false, true].map((annotating) => ({ reason, annotating }))))(
    'closes the removed pending image after $reason (annotating: $annotating)', async ({ reason, annotating }) => {
      const file: RemoteSerializedAttachment = { id: 'photo', name: 'photo.jpg', category: 'image',
        path: 'https://example.invalid/photo.jpg', mimeType: 'image/jpeg', ext: 'jpg', size: 100 };
      const target = { clientId: 'target', text: '', chatMessage: {}, files: [file] } as unknown as QueuedRemoteMessage;
      const head = { ...target, clientId: 'head', files: [] };
      const before = reason === 'remote middle removal' ? [head, target] : [target];
      const after = reason === 'remote middle removal' ? [head] : [];
      const input = { outbox: [], hiddenClientIds: new Set<string>(), sendingClientIds: new Set<string>(),
        editingClientId: null, steeringClientIds: new Set<string>(), presentationByClientId: new Map() };
      const sourceKey = pendingSendItemKey(target.clientId);
      const initial = reason === 'outbox cancellation'
        ? collectMobileMessageGalleryImages(buildPendingSendItems({ ...input, queue: [], settling: [],
          outbox: [outboxDisplayItem(buildOutboxItem({ sessionId: 's', clientId: target.clientId, text: '',
            permissionModeAtSend: 'ask', readyAttachments: [file], readyPreviews: ['file:///preview.jpg'], claimedUploads: [] }))] }))
        : collectMobileMessageGalleryImages(buildPendingSendItems({ ...input, queue: before, settling: [] }));
      const clicked = initial[0].payload;
      const onClose = vi.fn();
      const onShareImage = vi.fn();
      const onSubmit = vi.fn();
      const { props, render } = mount({ images: initial, initialUrl: initial[0].url, onClose, onShareImage,
        annotation: { submitLabel: 'Send', onSubmit } });
      if (annotating) {
        act(() => runtime.nodes.get('Image').onLoad({ source: { width: 400, height: 800 } }));
        press('message.imageLightboxAnnotateButton');
        const draw = gestures().find((gesture) => gesture.kind === 'Pan' && gesture.options.minDistance === 0)!;
        fire(draw, 'onStart', { x: 100, y: 200 });
        fire(draw, 'onFinalize', {}, true);
      } else {
        expect(runtime.nodes.has('message.imageLightboxShareButton')).toBe(true);
      }
      const settling = reason === 'outbox cancellation' ? [] : computeVanishedQueueItems({ previous: before, current: after,
        previousSteeringClientIds: new Set(), currentSteeringClientIds: new Set(), hiddenClientIds: new Set(),
        locallyRemovedClientIds: new Set(reason === 'local cancellation' ? [target.clientId] : []) });
      expect(settling.map((item) => item.clientId)).toEqual(reason === 'settling expiry' ? [target.clientId] : []);
      if (reason === 'settling expiry') {
        // Head departure is ambiguous: preserve the open viewer while the existing settling window is live.
        props.images = lightboxImagesForPayload([], clicked, sourceKey, props.images, false, true);
        render();
        expect(onClose).not.toHaveBeenCalled();
      }
      const current = collectMobileMessageGalleryImages(buildPendingSendItems({ ...input, queue: after, settling: [] }));
      props.images = lightboxImagesForPayload(current, clicked, sourceKey, props.images, false, false);
      // The fixture's node registry also contains unmounted controls unless cleared before rendering.
      runtime.nodes.clear();
      render();
      expect(props.images).toEqual([]);
      expect(onClose).toHaveBeenCalledOnce();
      expect(runtime.nodes.has('message.imageLightboxShareButton')).toBe(false);
      if (runtime.nodes.has('message.imageLightboxAnnotationSubmit')) press('message.imageLightboxAnnotationSubmit');
      await act(async () => { await Promise.resolve(); });
      expect(onShareImage).not.toHaveBeenCalled();
      expect(onSubmit).not.toHaveBeenCalled();
    },
  );

  it.each(['ready', 'uploading', 'remote-only'])('preserves annotations through the real %s outbox-to-queue handoff', (phase) => {
    const file: RemoteSerializedAttachment = { id: 'photo', name: 'same.jpg', category: 'image',
      path: 'cindy-oss-attach://photo', url: phase === 'remote-only' ? 'https://example.invalid/original.jpg' : 'cindy-oss-attach://photo',
      mimeType: 'image/jpeg', ext: 'jpg', size: 100 };
    const pdf = { ...file, id: 'pdf', category: 'pdf' as const, name: 'doc.pdf' };
    let item = buildOutboxItem({ sessionId: 's', clientId: 'pending', text: '', permissionModeAtSend: 'ask',
      readyAttachments: phase === 'uploading' ? [pdf] : [pdf, file],
      readyPreviews: [null, phase === 'remote-only' ? null : 'file:///temporary.jpg'],
      claimedUploads: phase !== 'uploading' ? [] : [
        { localId: 'upload', failed: false, kind: 'image', previewUri: 'file:///temporary.jpg' },
      ] });
    const previews: SentMessageImagePreviews = new Map();
    const input = { settling: [], hiddenClientIds: new Set<string>(), sendingClientIds: new Set<string>(),
      editingClientId: null, steeringClientIds: new Set<string>(), presentationByClientId: new Map() };
    const initial = collectMobileMessageGalleryImages(buildPendingSendItems({ ...input,
      queue: [], outbox: [outboxDisplayItem(item)] }));
    const clicked = initial[0].payload;
    const onSubmit = vi.fn(() => new Promise<void>(() => undefined));
    const { props, render } = mount({ images: initial, initialUrl: initial[0].url,
      annotation: { submitLabel: 'Send', onSubmit } });
    act(() => runtime.nodes.get('Image').onLoad({ source: { width: 400, height: 800 } }));
    press('message.imageLightboxAnnotateButton');
    const draw = () => gestures().find((gesture) => gesture.kind === 'Pan' && gesture.options.minDistance === 0)!;
    fire(draw(), 'onStart', { x: 100, y: 200 });
    fire(draw(), 'onFinalize', {}, true);
    fire(draw(), 'onStart', { x: 200, y: 400 });
    if (phase === 'uploading') item = outboxItemWithUpload(item, 'upload', file);
    props.images = collectMobileMessageGalleryImages(buildPendingSendItems({ ...input,
      queue: [], outbox: [outboxDisplayItem(item)] }));
    render();
    // Production's synchronous dispatch observer captures the slot identity before queue materialization.
    rememberSentMessageImagePreviews(previews, 's', item.clientId, outboxItemAttachments(item),
      () => (phase === 'remote-only' ? null : 'file:///durable.jpg'), (attachment) => {
        const slot = item.attachmentSlots.findIndex((entry) => entry?.id === attachment.id);
        return `${item.clientId}-slot-${slot}`;
      });
    const collectQueued = (attachment: RemoteSerializedAttachment) => collectMobileMessageGalleryImages(buildPendingSendItems({
      ...input, outbox: [], queue: [{ clientId: 'pending', text: '', chatMessage: {}, files: [pdf, attachment] } as unknown as QueuedRemoteMessage],
      getImagePreview: (clientId, index, name, id) => getSentMessageImagePreview(previews, 's', clientId, index, name, id),
    }));
    const queued = collectQueued({ ...file, url: 'https://example.invalid/materialized.jpg' });
    props.images = lightboxImagesForPayload(queued, clicked, 'message-pending', props.images, true);
    render();
    const page = () => runtime.nodes.get('FlatList').renderItem({ item: props.images[0], index: 0 }).props;
    expect(queued[0].key).toBe(initial[0].key);
    expect(queued[0].previewUri).toBe(phase === 'remote-only' ? undefined : 'file:///durable.jpg');
    expect(page().annotationStrokes).toEqual([{ points: [{ x: 0.25, y: 0.25 }] }]);
    expect(page().annotationDraftStroke).toEqual({ points: [{ x: 0.5, y: 0.5 }] });
    expect(page().naturalSize).toEqual({ width: 400, height: 800 });
    // Keeping a slot/URL while changing the actual attachment must still discard the old image's state.
    const replaced = collectQueued({ ...file, id: 'replacement', url: queued[0].url });
    props.images = lightboxImagesForPayload(replaced, clicked, 'message-pending', props.images, true);
    render();
    expect(replaced[0].key).not.toBe(initial[0].key);
    expect(page().annotationStrokes).toEqual([]);
    expect(page().annotationDraftStroke).toBeNull();
    expect(page().naturalSize).toBeNull();
  });

  it.each([
    ['failed', true], ['failed', false], ['sending', true], ['sending', false],
  ] as const)('keeps a rehydrated %s outbox image and its strokes through queue/formal handoff (local preview: %s)', async (state, localPreview) => {
    const files: RemoteSerializedAttachment[] = [0, 1].map((index) => ({ id: `photo-${index}`, name: `photo-${index}.jpg`,
      category: 'image', path: `cindy-oss-attach://photo-${index}`, mimeType: 'image/jpeg', ext: 'jpg', size: 100,
      sha256: String(index).repeat(64), ...(index === 1 ? { url: 'https://example.invalid/restored-1.jpg' } : {}) }));
    const pdf = { ...files[0], id: 'pdf', name: 'document.pdf', category: 'pdf' as const };
    const item = buildOutboxItem({ sessionId: 's', clientId: 'pending', text: '', permissionModeAtSend: 'ask',
      readyAttachments: [files[0], pdf, files[1]], claimedUploads: [],
      readyPreviews: [null, null, localPreview ? 'file:///durable-1.jpg' : null] });
    const disk = new Map<string, string>();
    const storage = { getAllKeys: async () => [...disk.keys()], getItem: async (key: string) => disk.get(key) ?? null,
      setItem: async (key: string, value: string) => { disk.set(key, value); }, removeItem: async (key: string) => { disk.delete(key); } };
    const initialStore = createDurableOutbox(storage);
    await initialStore.activate('account');
    await initialStore.add({ version: 1, accountId: 'account', deviceId: 'desktop', item, state,
      sendAtMs: 1, createdAt: 1, uploads: [] } satisfies DurableOutboxRecord);
    const restored = createDurableOutbox(storage);
    await restored.activate('account');
    const row = restored.getSnapshot()[0];
    const onSending = vi.fn();
    const unsubscribe = observeDurableOutboxSending(restored, 'desktop', 's', onSending, vi.fn());
    try {
      const previews: SentMessageImagePreviews = new Map();
      // Capture on first render; the dispatch observer does not replay restored sends.
      rememberOutboxImagePreviews(previews, 's', row.item, new Set([item.clientId]));
      const getPreview: GetSentMessageImagePreview = (...args) => getSentMessageImagePreview(previews, 's', ...args);
      const input = { settling: [], hiddenClientIds: new Set<string>(), sendingClientIds: new Set<string>(),
        editingClientId: null, steeringClientIds: new Set<string>(), presentationByClientId: new Map(), getImagePreview: getPreview };
      const initial = collectMobileMessageGalleryImages(buildPendingSendItems({ ...input, queue: [], outbox: [outboxDisplayItem(row.item)] }));
      expect(initial).toHaveLength(1);
      expect(initial[0].key).toBe('pending-slot-2');
      const clicked = initial[0].payload;
      const { props, render } = mount({ images: initial, initialUrl: initial[0].url, initialImageKey: initial[0].key,
        annotation: { submitLabel: 'Send', onSubmit: vi.fn() } });
      act(() => runtime.nodes.get('Image').onLoad({ source: { width: 400, height: 800 } }));
      press('message.imageLightboxAnnotateButton');
      const draw = () => gestures().find((gesture) => gesture.kind === 'Pan' && gesture.options.minDistance === 0)!;
      fire(draw(), 'onStart', { x: 100, y: 200 });
      fire(draw(), 'onFinalize', {}, true);
      fire(draw(), 'onStart', { x: 200, y: 400 });
      // Even a retry cannot be used to bootstrap identity: the observer already saw this clientId.
      const queuedFiles = [files[0], pdf, files[1]].map((file, index) => ({ ...file, url: `https://example.invalid/queued-${index}.jpg` }));
      const queued = { clientId: item.clientId, text: '', chatMessage: {}, files: queuedFiles } as unknown as QueuedRemoteMessage;
      await restored.update(row, { state: 'queued' });
      await restored.update(restored.getSnapshot()[0], { state: 'sending', prepared: queued });
      expect(onSending).not.toHaveBeenCalled();
      rememberSentMessageImagePreviews(previews, 's', item.clientId, queuedFiles, () => null);
      const queueGallery = collectMobileMessageGalleryImages(buildPendingSendItems({ ...input, queue: [queued], outbox: [] }));
      const formal = collectMobileMessageGalleryImages(buildMobileMessageRenderItems([{
        id: 'server', clientId: item.clientId, sessionId: 's', role: 'user', toolUseId: null, agentMeta: null,
        createdAt: '2026-10-16T00:00:00.000Z', content: { images: files.map((file, index) => ({
          name: file.name, sha256: file.sha256, url: `https://example.invalid/formal-${index}.jpg`,
        })) },
      }]), undefined, undefined, 's', getPreview);
      for (const gallery of [queueGallery, formal]) {
        props.images = lightboxImagesForPayload(gallery, clicked, 'message-pending', props.images, true);
        render();
        expect(props.images).toHaveLength(2);
        expect(props.images[1].key).toBe(initial[0].key);
        const page = runtime.nodes.get('FlatList').renderItem({ item: props.images[1], index: 1 }).props;
        expect(page.active).toBe(true);
        expect(page.annotationStrokes).toEqual([{ points: [{ x: 0.25, y: 0.25 }] }]);
        expect(page.annotationDraftStroke).toEqual({ points: [{ x: 0.5, y: 0.5 }] });
        expect(page.naturalSize).toEqual({ width: 400, height: 800 });
      }
    } finally {
      unsubscribe();
    }
  });

  it('keeps the current page, paging and sharing after URLs settle and the pending row leaves', async () => {
    const initial = collect(thumbs);
    const clicked = initial[1].payload;
    const onShareImage = vi.fn();
    const { props, render } = mount({ images: initial, initialUrl: clicked.media.url, onShareImage });
    expect(runtime.nodes.get('FlatList').initialScrollIndex).toBe(1);
    const updated = collect(thumbs.map((thumb, index) => ({
      ...thumb, uploading: false, ossRef: `https://example.invalid/settled-${index}.jpg`,
    })));
    props.images = lightboxImagesForPayload(updated, clicked, 'pending', props.images);
    render();
    expect(runtime.nodes.get("preview.collectionCount").children).toBe('2 / 2');
    await act(async () => runtime.nodes.get('message.imageLightboxShareButton').onPress());
    expect(onShareImage.mock.lastCall?.[0].url).toBe(updated[1].url);
    // Paging away from the originally clicked page must also survive a row handoff.
    act(() => runtime.nodes.get('FlatList').onMomentumScrollEnd({ nativeEvent: { contentOffset: { x: 0 } } }));
    props.images = lightboxImagesForPayload([], clicked, 'pending', props.images, false, true);
    render();
    expect(runtime.nodes.get('FlatList').data).toHaveLength(2);
    expect(runtime.nodes.get("preview.collectionCount").children).toBe('1 / 2');
    await act(async () => runtime.nodes.get('message.imageLightboxShareButton').onPress());
    expect(onShareImage.mock.lastCall?.[0].url).toBe(updated[0].url);
  });

  it.each([
    ['hash', false], ['hash', true], ['materialized queue', false], ['materialized queue', true],
  ] as const)('keeps the second image and its strokes through formal history (%s, gap: %s)', async (proof, gap) => {
    const files: RemoteSerializedAttachment[] = [0, 1].map((index) => ({ id: `photo-${index}`, name: `photo-${index}.jpg`,
      category: 'image', path: `cindy-oss-attach://photo-${index}`, mimeType: 'image/jpeg', ext: 'jpg', size: 100,
      ...(proof === 'hash' ? { sha256: String(index).repeat(64) } : {}) }));
    let item = buildOutboxItem({ sessionId: 's', clientId: 'pending', text: '', permissionModeAtSend: 'ask',
      readyAttachments: [], claimedUploads: files.map((file, index) => ({ localId: file.id, failed: false,
        kind: 'image', ...(index === 1 ? { previewUri: 'file:///temporary-1.jpg' } : {}) })) });
    const input = { settling: [], hiddenClientIds: new Set<string>(), sendingClientIds: new Set<string>(),
      editingClientId: null, steeringClientIds: new Set<string>(), presentationByClientId: new Map() };
    const initial = collectMobileMessageGalleryImages(buildPendingSendItems({ ...input, queue: [], outbox: [outboxDisplayItem(item)] }));
    expect(initial).toHaveLength(1);
    const clicked = initial[0].payload;
    const onSubmit = vi.fn(() => new Promise<void>(() => undefined));
    const { props, render } = mount({ images: initial, initialUrl: initial[0].url, initialImageKey: initial[0].key,
      annotation: { submitLabel: 'Send', onSubmit },
      onResolveRemoteMedia: async (media) => ({ url: `file:///${media.url.split('/').at(-1)}`, ossKey: '',
        mimeType: 'image/jpeg', size: 100, expiresAt: '9999-01-01', previewable: true }) });
    act(() => runtime.nodes.get('Image').onLoad({ source: { width: 400, height: 800 } }));
    press('message.imageLightboxAnnotateButton');
    const draw = () => gestures().find((gesture) => gesture.kind === 'Pan' && gesture.options.minDistance === 0)!;
    fire(draw(), 'onStart', { x: 100, y: 200 });
    fire(draw(), 'onFinalize', {}, true);
    fire(draw(), 'onStart', { x: 200, y: 400 });
    for (const file of files) item = outboxItemWithUpload(item, file.id, file);
    const previews: SentMessageImagePreviews = new Map();
    rememberSentMessageImagePreviews(previews, 's', item.clientId, outboxItemAttachments(item),
      (file) => (file.id === files[1].id ? 'file:///durable-1.jpg' : null),
      (file) => `${item.clientId}-slot-${item.attachmentSlots.findIndex((entry) => entry?.id === file.id)}`);
    const getPreview: GetSentMessageImagePreview = (...args) => getSentMessageImagePreview(previews, 's', ...args);
    if (proof === 'materialized queue') {
      const queuedFiles = files.map((file, index) => ({ ...file, url: `cindy-media://blobs/formal-${index}.jpg` }));
      // The session observes Desktop's new URL under the same attachment ID, without new local pixels.
      rememberSentMessageImagePreviews(previews, 's', item.clientId, queuedFiles, () => null);
      const queued = collectMobileMessageGalleryImages(buildPendingSendItems({ ...input, outbox: [],
        queue: [{ clientId: item.clientId, text: '', chatMessage: {}, files: queuedFiles } as unknown as QueuedRemoteMessage],
        getImagePreview: getPreview }));
      props.images = lightboxImagesForPayload(queued, clicked, 'message-pending', props.images, true);
      await act(async () => { render(); });
      expect(props.images[1].key).toBe(initial[0].key);
    }
    if (gap) {
      props.images = lightboxImagesForPayload([], clicked, 'message-pending', props.images, false, true);
      render();
    }
    const formal = collectMobileMessageGalleryImages(buildMobileMessageRenderItems([{
      id: 'server-id', clientId: item.clientId, sessionId: 's', role: 'user', toolUseId: null,
      agentMeta: null, createdAt: '2026-01-01T00:00:00.000Z', content: { images: files.map((file, index) => ({
        name: file.name, sha256: file.sha256, url: `cindy-media://blobs/formal-${index}.jpg`,
      })) },
    }]), undefined, undefined, 's', getPreview);
    props.images = lightboxImagesForPayload(formal, clicked, 'message-pending', props.images, true);
    await act(async () => { render(); });
    expect(props.images[1].key).toBe(initial[0].key);
    const page = runtime.nodes.get('FlatList').renderItem({ item: props.images[1], index: 1 }).props;
    expect(page.active).toBe(true);
    expect(page.annotationStrokes).toEqual([{ points: [{ x: 0.25, y: 0.25 }] }]);
    expect(page.annotationDraftStroke).toEqual({ points: [{ x: 0.5, y: 0.5 }] });
    expect(page.naturalSize).toEqual({ width: 400, height: 800 });
    press('message.imageLightboxAnnotationSubmit');
    await act(async () => { await Promise.resolve(); });
    expect(onSubmit.mock.calls[0]).toEqual([props.images[1], 'file:///formal-1.jpg',
      [{ points: [{ x: 0.25, y: 0.25 }] }, { points: [{ x: 0.5, y: 0.5 }] }],
      { mimeType: 'image/jpeg', naturalWidth: 400, naturalHeight: 800 }]);
  });

  it.each([
    ['hash', false, 1], ['hash', true, 1], ['url', false, 1], ['url', true, 1],
    ['hash', false, 65], ['hash', true, 65],
  ] as const)('keeps a remote queued image through formal history without a local preview (%s, gap: %s, live messages: %s)', async (proof, gap, liveCount) => {
    const files: RemoteSerializedAttachment[] = [0, 1].map((index) => ({ id: `photo-${index}`, name: `photo-${index}.jpg`,
      category: 'image', path: index === 0 ? 'cindy-oss-attach://unreadable' : 'cindy-media://blobs/queued-1.jpg',
      mimeType: 'image/jpeg', ext: 'jpg', size: 100, ...(proof === 'hash' ? { sha256: String(index).repeat(64) } : {}) }));
    const previews: SentMessageImagePreviews = new Map();
    const getPreview: GetSentMessageImagePreview = (...args) => getSentMessageImagePreview(previews, 's', ...args);
    // The session observes a remote/reopened queue, with no local outbox or preview URI.
    const liveClientIds = new Set(['pending', ...Array.from({ length: liveCount - 1 }, (_, index) => `other-${index}`)]);
    for (const clientId of liveClientIds) {
      rememberSentMessageImagePreviews(previews, 's', clientId, files, () => null, undefined, liveClientIds);
    }
    const initial = collectMobileMessageGalleryImages(buildPendingSendItems({
      queue: [{ clientId: 'pending', text: '', chatMessage: {}, files } as unknown as QueuedRemoteMessage],
      settling: [], outbox: [], hiddenClientIds: new Set(), sendingClientIds: new Set(), editingClientId: null,
      steeringClientIds: new Set(), presentationByClientId: new Map(), getImagePreview: getPreview,
    }));
    expect(initial).toHaveLength(1);
    expect(initial[0].previewUri).toBeUndefined();
    const clicked = initial[0].payload;
    const onSubmit = vi.fn(() => new Promise<void>(() => undefined));
    const { props, render } = mount({ images: initial, initialUrl: initial[0].url, initialImageKey: initial[0].key,
      annotation: { submitLabel: 'Send', onSubmit },
      onResolveRemoteMedia: async (media) => ({ url: `file:///${media.url.split('/').at(-1)}`, ossKey: '',
        mimeType: 'image/jpeg', size: 100, expiresAt: '9999-01-01', previewable: true }) });
    await act(async () => { await Promise.resolve(); });
    act(() => runtime.nodes.get('Image').onLoad({ source: { width: 400, height: 800 } }));
    press('message.imageLightboxAnnotateButton');
    const draw = () => gestures().find((gesture) => gesture.kind === 'Pan' && gesture.options.minDistance === 0)!;
    fire(draw(), 'onStart', { x: 100, y: 200 });
    fire(draw(), 'onFinalize', {}, true);
    fire(draw(), 'onStart', { x: 200, y: 400 });
    if (gap) {
      props.images = lightboxImagesForPayload([], clicked, 'message-pending', props.images, false, true);
      render();
    }
    const formalUrls = ['cindy-media://blobs/formal-0.jpg', proof === 'hash'
      ? 'cindy-media://blobs/formal-1.jpg' : files[1].path];
    const formal = collectMobileMessageGalleryImages(buildMobileMessageRenderItems([{
      id: 'server-id', clientId: 'pending', sessionId: 's', role: 'user', toolUseId: null,
      agentMeta: null, createdAt: '2026-01-01T00:00:00.000Z', content: { images: files.map((file, index) => ({
        name: file.name, sha256: file.sha256, url: formalUrls[index],
      })) },
    }]), undefined, undefined, 's', getPreview);
    props.images = lightboxImagesForPayload(formal, clicked, 'message-pending', props.images, true);
    await act(async () => { render(); });
    expect(props.images[1].key).toBe(initial[0].key);
    const page = runtime.nodes.get('FlatList').renderItem({ item: props.images[1], index: 1 }).props;
    expect(page.active).toBe(true);
    expect(page.annotationStrokes).toEqual([{ points: [{ x: 0.25, y: 0.25 }] }]);
    expect(page.annotationDraftStroke).toEqual({ points: [{ x: 0.5, y: 0.5 }] });
    expect(page.naturalSize).toEqual({ width: 400, height: 800 });
    press('message.imageLightboxAnnotationSubmit');
    await act(async () => { await Promise.resolve(); });
    expect(onSubmit.mock.calls[0]).toEqual([props.images[1], `file:///${formalUrls[1].split('/').at(-1)}`,
      [{ points: [{ x: 0.25, y: 0.25 }] }, { points: [{ x: 0.5, y: 0.5 }] }],
      { mimeType: 'image/jpeg', naturalWidth: 400, naturalHeight: 800 }]);
  });

  it.each(['ph://photo', 'content://media/1', 'assets-library://photo'])('previews %s but waits for a materialized file before enabling actions', async (uri) => {
    const thumb = { key: 'pending-slot-0', uri, ossRef: null, uploading: true };
    const initial = collect([thumb]);
    const onShareImage = vi.fn();
    const onSubmit = vi.fn<NonNullable<ImageLightboxProps['annotation']>['onSubmit']>(() => new Promise<void>(() => undefined));
    const onResolveRemoteMedia = vi.fn();
    const { props, render } = mount({ images: initial, initialUrl: uri,
      onShareImage, onResolveRemoteMedia, annotation: { submitLabel: 'Send', allowDirectSubmit: true, onSubmit } });
    const preview = runtime.nodes.get('message.imageLightboxPreviewLayer') ?? runtime.nodes.get('Image');
    act(() => preview.onLoad({ source: { width: 400, height: 800 } }));
    expect(preview.source.uri).toBe(uri);
    doubleTapAtCorner();
    finishAnimations();
    expect(runtime.nodes.get('Image').style[1].current.transform[4].scale).toBe(2.5);
    doubleTapAtCorner();
    finishAnimations();
    expect(runtime.nodes.get('message.imageLightboxAnnotateButton').disabled).toBe(true);
    expect(runtime.nodes.has('message.imageLightboxShareButton')).toBe(false);
    expect(runtime.nodes.get('message.imageLightboxSendToChatButton').disabled).toBe(true);
    press('message.imageLightboxAnnotateButton');
    press('message.imageLightboxSendToChatButton');
    await act(async () => { await Promise.resolve(); });
    expect(onShareImage).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onResolveRemoteMedia).not.toHaveBeenCalled();
    props.images = collect([{ ...thumb, uri: 'file:///materialized.jpg', uploading: false }]);
    render();
    expect(props.images[0].key).toBe(initial[0].key);
    expect(runtime.nodes.get('message.imageLightboxAnnotateButton').disabled).toBe(false);
    expect(runtime.nodes.get('message.imageLightboxShareButton').disabled).toBe(false);
    await act(async () => { press('message.imageLightboxShareButton'); });
    expect(onShareImage.mock.calls[0]?.[1]).toBe('file:///materialized.jpg');
    press('message.imageLightboxAnnotateButton');
    const draw = gestures().find((gesture) => gesture.kind === 'Pan' && gesture.options.minDistance === 0)!;
    fire(draw, 'onStart', { x: 100, y: 200 });
    fire(draw, 'onFinalize', {}, true);
    press('message.imageLightboxAnnotationSubmit');
    await act(async () => { await Promise.resolve(); });
    expect(onSubmit.mock.calls[0]?.[1]).toBe('file:///materialized.jpg');
    expect(onSubmit.mock.calls[0]?.[2]).toEqual([{ points: [{ x: 0.25, y: 0.25 }] }]);
  });

  it.each([
    ['image', false], ['image', true], ['pdf', false], ['pdf', true],
  ] as const)('keeps an unchanged image when an earlier %s is removed (local preview: %s)', (category, local) => {
    const first: RemoteSerializedAttachment = { id: 'first', name: 'first', category,
      path: 'cindy-oss-attach://first', size: 100, ext: 'jpg', mimeType: 'image/jpeg' };
    const target: RemoteSerializedAttachment = { ...first, id: 'target', name: 'target.jpg', category: 'image',
      path: 'https://example.invalid/target.jpg' };
    const previews: SentMessageImagePreviews = new Map();
    if (local) rememberSentMessageImagePreviews(previews, 's', 'pending', [first, target],
      (file) => (file.id === target.id ? 'file:///target.jpg' : null),
      (file) => `pending-slot-${file.id === target.id ? 1 : 0}`);
    const getPreview: GetSentMessageImagePreview = (...args) => getSentMessageImagePreview(previews, 's', ...args);
    const queued = (files: RemoteSerializedAttachment[]) => collectMobileMessageGalleryImages(buildPendingSendItems({
      queue: [{ clientId: 'pending', text: '', chatMessage: {}, files } as unknown as QueuedRemoteMessage],
      settling: [], outbox: [], hiddenClientIds: new Set(), sendingClientIds: new Set(), editingClientId: null,
      steeringClientIds: new Set(), presentationByClientId: new Map(), getImagePreview: local ? getPreview : undefined,
    }));
    const initial = queued([first, target]);
    expect(initial).toHaveLength(1);
    const clicked = initial[0].payload;
    const { props, render } = mount({ images: initial, initialUrl: initial[0].url,
      annotation: { submitLabel: 'Send', onSubmit: vi.fn() } });
    act(() => runtime.nodes.get('Image').onLoad({ source: { width: 400, height: 800 } }));
    press('message.imageLightboxAnnotateButton');
    const draw = () => gestures().find((gesture) => gesture.kind === 'Pan' && gesture.options.minDistance === 0)!;
    fire(draw(), 'onStart', { x: 100, y: 200 });
    fire(draw(), 'onFinalize', {}, true);
    fire(draw(), 'onStart', { x: 200, y: 400 });
    const current = queued([{ ...target, path: 'https://example.invalid/settled.jpg' }]);
    props.images = lightboxImagesForPayload(current, clicked, 'message-pending', props.images, true);
    render();
    expect(current[0].key).toBe(initial[0].key);
    const page = () => runtime.nodes.get('FlatList').renderItem({ item: props.images[0], index: 0 }).props;
    expect(page().annotationStrokes).toEqual([{ points: [{ x: 0.25, y: 0.25 }] }]);
    expect(page().annotationDraftStroke).toEqual({ points: [{ x: 0.5, y: 0.5 }] });
    expect(page().naturalSize).toEqual({ width: 400, height: 800 });
    props.images = lightboxImagesForPayload(queued([{ ...target, id: 'replacement' }]), clicked, 'message-pending', props.images, true);
    render();
    expect(page().annotationStrokes).toEqual([]);
    expect(page().annotationDraftStroke).toBeNull();
    expect(page().naturalSize).toBeNull();
  });

  it('anchors the current image when an earlier pending placeholder becomes readable', () => {
    const initial = collect([{ ...thumbs[0], uri: null }, thumbs[1]]);
    const { props, render } = mount({ images: initial, initialUrl: initial[0].url });
    props.images = collect(thumbs);
    render();
    expect(runtime.nodes.get("preview.collectionCount").children).toBe('2 / 2');
    expect(runtime.scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 400 });
  });

  it.each([false, true])('keeps the selected queue image after a readable earlier image is removed and the rest reorder (local: %s)', async (local) => {
    const files: RemoteSerializedAttachment[] = ['first', 'target', 'tail'].map((id) => ({
      id, name: `${id}.jpg`, category: 'image', path: `https://example.invalid/${id}.jpg`,
      size: 100, mimeType: 'image/jpeg', ext: 'jpg',
    }));
    const previews: SentMessageImagePreviews = new Map();
    if (local) rememberSentMessageImagePreviews(previews, 's', 'pending', files, (file) => `file:///${file.id}.jpg`,
      (file) => `pending-slot-${files.indexOf(file)}`);
    const getPreview: GetSentMessageImagePreview = (...args) => getSentMessageImagePreview(previews, 's', ...args);
    const queued = (attachments: RemoteSerializedAttachment[]) => collectMobileMessageGalleryImages(buildPendingSendItems({
      queue: [{ clientId: 'pending', text: '', chatMessage: {}, files: attachments } as unknown as QueuedRemoteMessage],
      settling: [], outbox: [], hiddenClientIds: new Set(), sendingClientIds: new Set(), editingClientId: null,
      steeringClientIds: new Set(), presentationByClientId: new Map(), getImagePreview: local ? getPreview : undefined,
    }));
    const initial = queued(files);
    const clicked = initial[1].payload;
    const onShareImage = vi.fn();
    const { props, render } = mount({ images: initial, initialUrl: initial[1].url, initialImageKey: initial[1].key, onShareImage });
    for (const attachments of [files.slice(1), [files[2], files[1]]]) {
      props.images = lightboxImagesForPayload(queued(attachments), clicked, 'message-pending', props.images, true);
      render();
      const index = props.images.findIndex((image) => image.key === initial[1].key);
      expect(index).toBe(attachments.indexOf(files[1]));
      expect(runtime.nodes.get("preview.collectionCount").children).toBe(`${index + 1} / 2`);
      await act(async () => runtime.nodes.get('message.imageLightboxShareButton').onPress());
      expect(onShareImage.mock.lastCall?.[0].url).toBe(files[1].path);
    }
  });

  it.each([0, 1])('follows the replacement of pending slot %i instead of a neighbor with the same old URL', async (index) => {
    const original = thumbs.map((thumb) => ({ ...thumb, uri: 'https://example.invalid/duplicate.jpg' }));
    const initial = collect(original);
    const onShareImage = vi.fn();
    const { props, render } = mount({ images: initial, initialUrl: initial[0].url, onShareImage });
    act(() => runtime.nodes.get('FlatList').onMomentumScrollEnd({ nativeEvent: { contentOffset: { x: index * 400 } } }));
    const replacement = { ...original[index], key: `${original[index].key}:replaced`, uri: 'https://example.invalid/replacement.jpg' };
    props.images = collect(original.map((thumb, slot) => (slot === index ? replacement : thumb)));
    render();
    expect(runtime.nodes.get("preview.collectionCount").children).toBe(`${index + 1} / 2`);
    await act(async () => runtime.nodes.get('message.imageLightboxShareButton').onPress());
    expect(onShareImage.mock.lastCall?.[0].url).toBe(replacement.uri);
  });

  it.each([0, 1])('opens the clicked pending slot %i when multiple attachments have the same URL', (index) => {
    const images = collect(thumbs.map((thumb) => ({ ...thumb, uri: 'https://example.invalid/duplicate.jpg' })));
    mount({ images, initialUrl: images[index].url, initialImageKey: images[index].key });
    const list = runtime.nodes.get('FlatList');
    expect(list.initialScrollIndex).toBe(index);
    expect(list.renderItem({ item: images[index], index }).props.active).toBe(true);
    expect(runtime.nodes.get("preview.collectionCount").children).toBe(`${index + 1} / 2`);
  });

  it('keeps the replacement and its annotation when an earlier image becomes readable', async () => {
    const initial = collect([thumbs[1]]);
    const replacement = { ...thumbs[1], key: `${thumbs[1].key}:replacement`, uri: 'file:///replacement.jpg' };
    const onSubmit = vi.fn(() => new Promise<void>(() => undefined));
    const { props, render } = mount({ images: initial, initialUrl: initial[0].url,
      annotation: { submitLabel: 'Send', onSubmit } });
    props.images = collect([replacement]);
    render();
    act(() => runtime.nodes.get('Image').onLoad({ source: { width: 400, height: 800 } }));
    press('message.imageLightboxAnnotateButton');
    const draw = () => gestures().find((gesture) => gesture.kind === 'Pan' && gesture.options.minDistance === 0)!;
    fire(draw(), 'onStart', { x: 100, y: 200 });
    fire(draw(), 'onFinalize', {}, true);
    fire(draw(), 'onStart', { x: 200, y: 400 });
    props.images = collect([thumbs[0], replacement]);
    render();
    const page = runtime.nodes.get('FlatList').renderItem({ item: props.images[1], index: 1 }).props;
    expect(page.active).toBe(true);
    expect(page.annotationStrokes).toEqual([{ points: [{ x: 0.25, y: 0.25 }] }]);
    expect(page.annotationDraftStroke).toEqual({ points: [{ x: 0.5, y: 0.5 }] });
    press('message.imageLightboxAnnotationSubmit');
    await act(async () => { await Promise.resolve(); });
    expect(onSubmit.mock.calls[0]).toEqual([
      props.images[1], replacement.uri,
      [{ points: [{ x: 0.25, y: 0.25 }] }, { points: [{ x: 0.5, y: 0.5 }] }],
      { mimeType: undefined, naturalWidth: 400, naturalHeight: 800 },
    ]);
  });

  it.each([false, true])('follows the pending slot when replacement and an earlier upload settle together (paged: %s)', async (paged) => {
    const waiting = [{ ...thumbs[0], uri: null }, thumbs[1]];
    const initial = collect(paged ? thumbs : waiting);
    const onShareImage = vi.fn();
    const { props, render } = mount({ images: initial, initialUrl: initial[0].url, onShareImage });
    if (paged) {
      act(() => runtime.nodes.get('FlatList').onMomentumScrollEnd({ nativeEvent: { contentOffset: { x: 400 } } }));
      props.images = collect(waiting);
      render();
    }
    const replacement = { ...thumbs[1], key: 'replacement', uri: thumbs[0].uri };
    // One update inserts an earlier readable page and replaces the active identity.
    props.images = collect([thumbs[0], replacement]);
    render();
    const page = runtime.nodes.get('FlatList').renderItem({ item: props.images[1], index: 1 }).props;
    expect(page.active).toBe(true);
    expect(runtime.nodes.get("preview.collectionCount").children).toBe('2 / 2');
    expect(runtime.scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 400 });
    await act(async () => runtime.nodes.get('message.imageLightboxShareButton').onPress());
    expect(onShareImage.mock.lastCall?.[0]).toBe(props.images[1].payload.media);
  });

  it('clears old strokes and dimensions on a replacement that arrives with an earlier readable page', async () => {
    const initial = collect([{ ...thumbs[0], uri: null }, thumbs[1]]);
    const onSubmit = vi.fn(() => new Promise<void>(() => undefined));
    const { props, render } = mount({ images: initial, initialUrl: initial[0].url,
      annotation: { submitLabel: 'Send', onSubmit } });
    act(() => runtime.nodes.get('Image').onLoad({ source: { width: 400, height: 800 } }));
    press('message.imageLightboxAnnotateButton');
    const draw = () => gestures().find((gesture) => gesture.kind === 'Pan' && gesture.options.minDistance === 0)!;
    fire(draw(), 'onStart', { x: 100, y: 200 });
    fire(draw(), 'onFinalize', {}, true);
    fire(draw(), 'onStart', { x: 200, y: 400 });
    const replacement = { ...thumbs[1], key: 'replacement', uri: 'file:///replacement.jpg' };
    props.images = collect([thumbs[0], replacement]);
    render();
    const page = runtime.nodes.get('FlatList').renderItem({ item: props.images[1], index: 1 }).props;
    expect(page.active).toBe(true);
    expect(page.annotating).toBe(true);
    expect(page.annotationStrokes).toEqual([]);
    expect(page.annotationDraftStroke).toBeNull();
    expect(page.naturalSize).toBeNull();
    // The FlatList mock mounts page zero only; deliver the active page's decoder/draw callbacks.
    const activePage = () => runtime.nodes.get('FlatList').renderItem({ item: props.images[1], index: 1 }).props;
    act(() => activePage().onNaturalSize(props.images[1].key, { width: 800, height: 400 }));
    act(() => activePage().onDrawPoint('start', 200, 400, 0, 0, 1));
    act(() => activePage().onDrawPoint('end', 200, 400, 0, 0, 1));
    press('message.imageLightboxAnnotationSubmit');
    await act(async () => { await Promise.resolve(); });
    expect(onSubmit.mock.calls[0]).toEqual([
      props.images[1], replacement.uri, [{ points: [{ x: 0.5, y: 0.5 }] }],
      { mimeType: undefined, naturalWidth: 800, naturalHeight: 400 },
    ]);
  });

  it('refreshes the pending slot when removing an unreadable thumbnail leaves the readable page unchanged', async () => {
    const waiting = [{ ...thumbs[0], uri: null },
      { ...thumbs[0], key: 'another-waiting', uri: null }, thumbs[1]];
    const initial = collect(waiting);
    const onShareImage = vi.fn();
    const { props, render } = mount({ images: initial, initialUrl: initial[0].url, onShareImage });
    // Same key, URL and readable index, but the active thumbnail's slot changes from 2 to 1.
    props.images = collect(waiting.slice(1));
    render();
    const replacement = { ...thumbs[1], key: 'replacement', uri: 'file:///replacement.jpg' };
    props.images = collect([{ ...waiting[1], uri: 'file:///earlier.jpg' }, replacement]);
    render();
    expect(runtime.nodes.get("preview.collectionCount").children).toBe('2 / 2');
    await act(async () => runtime.nodes.get('message.imageLightboxShareButton').onPress());
    expect(onShareImage.mock.lastCall?.[0]).toBe(props.images[1].payload.media);
  });

  it('keeps sharing the replacement when the original page later reappears', async () => {
    const initial = collect(thumbs);
    const replacement = { ...thumbs[0], key: `${thumbs[0].key}:replacement`, uri: 'file:///replacement.jpg' };
    const onShareImage = vi.fn();
    const { props, render } = mount({ images: initial, initialUrl: initial[0].url, onShareImage });
    props.images = collect([replacement, thumbs[1]]);
    render();
    props.images = collect([replacement, thumbs[1], thumbs[0]]);
    render();
    expect(runtime.nodes.get("preview.collectionCount").children).toBe('1 / 3');
    await act(async () => runtime.nodes.get('message.imageLightboxShareButton').onPress());
    expect(onShareImage.mock.lastCall?.[0].url).toBe(replacement.uri);
  });

  it('uses the latest page position when an already shifted active attachment is replaced', async () => {
    const last = { ...thumbs[1], key: 'last', uri: 'file:///last.jpg' };
    const replacement = { ...last, key: 'last:replacement', uri: 'file:///replacement.jpg' };
    const initial = collect([...thumbs, last]);
    const onShareImage = vi.fn();
    const { props, render } = mount({ images: initial, initialUrl: last.uri, onShareImage });
    props.images = collect([thumbs[1], last]);
    render();
    expect(runtime.nodes.get("preview.collectionCount").children).toBe('2 / 2');
    props.images = collect([thumbs[1], replacement, thumbs[0]]);
    render();
    expect(runtime.nodes.get("preview.collectionCount").children).toBe('2 / 3');
    await act(async () => runtime.nodes.get('message.imageLightboxShareButton').onPress());
    expect(onShareImage.mock.lastCall?.[0].url).toBe(replacement.uri);
  });

  it('preserves completed and in-progress annotation strokes when the same pending image shifts pages', async () => {
    const initial = collect([{ ...thumbs[0], uri: null }, thumbs[1]]);
    const onSubmit = vi.fn(() => new Promise<void>(() => undefined));
    const { props, render } = mount({ images: initial, initialUrl: initial[0].url,
      annotation: { submitLabel: 'Send', onSubmit } });
    act(() => runtime.nodes.get('Image').onLoad({ source: { width: 400, height: 800 } }));
    press('message.imageLightboxAnnotateButton');
    const draw = () => gestures().find((gesture) => gesture.kind === 'Pan' && gesture.options.minDistance === 0)!;
    fire(draw(), 'onStart', { x: 100, y: 200 });
    fire(draw(), 'onFinalize', {}, true);
    fire(draw(), 'onStart', { x: 200, y: 400 });
    fire(draw(), 'onUpdate', { x: 240, y: 440 });
    const completed = [{ points: [{ x: 0.25, y: 0.25 }] }];
    const draft = { points: [{ x: 0.5, y: 0.5 }, { x: 0.6, y: 0.55 }] };
    // Inserting/removing an earlier page changes only this image's index, not its identity.
    for (const images of [collect(thumbs), initial]) {
      props.images = images;
      render();
      const list = runtime.nodes.get('FlatList');
      const index = images.findIndex((image) => image.key === initial[0].key);
      const page = list.renderItem({ item: images[index], index }).props;
      expect(page.active).toBe(true);
      expect(page.annotating).toBe(true);
      expect(page.annotationStrokes).toEqual(completed);
      expect(page.annotationDraftStroke).toEqual(draft);
    }
    press('message.imageLightboxAnnotationSubmit');
    await act(async () => { await Promise.resolve(); });
    expect(onSubmit.mock.calls[0]).toEqual([
      initial[0], initial[0].url, [...completed, draft],
      { mimeType: undefined, naturalWidth: 400, naturalHeight: 800 },
    ]);
  });

  it('loads the replacement image strokes when the active image changes without changing index', () => {
    const initial = collect([thumbs[1]]);
    const replacement = collect([thumbs[0]]);
    const existing = [{ points: [{ x: 0.1, y: 0.2 }] }];
    const { props, render } = mount({ images: initial, initialUrl: initial[0].url, autoAnnotate: true,
      annotation: { submitLabel: 'Save', onSubmit: vi.fn(),
        initialStrokesFor: (image) => image.key === replacement[0].key ? existing : [] } });
    act(() => runtime.nodes.get('Image').onLoad({ source: { width: 400, height: 800 } }));
    const draw = () => gestures().find((gesture) => gesture.kind === 'Pan' && gesture.options.minDistance === 0)!;
    fire(draw(), 'onStart', { x: 100, y: 200 });
    props.images = replacement;
    render();
    const page = runtime.nodes.get('FlatList').renderItem({ item: replacement[0], index: 0 }).props;
    expect(page.annotationStrokes).toEqual(existing);
    expect(page.annotationDraftStroke).toBeNull();
  });

  it('opens the clicked second slot even if its preview URL changed before the viewer mounted', () => {
    const clicked = collect(thumbs)[1].payload;
    const updated = collect(thumbs.map((thumb) => ({ ...thumb, uri: thumb.uri.replace('temporary', 'durable') })));
    const images = lightboxImagesForPayload(updated, clicked, 'pending');
    mount({ images, initialUrl: images[galleryImageIndexForPayload(images, clicked)]?.url ?? clicked.media.url });
    expect(runtime.nodes.get('FlatList').initialScrollIndex).toBe(1);
    expect(runtime.nodes.get("preview.collectionCount").children).toBe('2 / 2');
  });

  it.each([false, true])('opens the clicked second slot after replacement before mounting (duplicate URL: %s)', async (duplicate) => {
    const original = thumbs.map((thumb) => ({ ...thumb, uri: 'https://example.invalid/old.jpg' }));
    const clicked = collect(original)[1].payload;
    const updated = collect([original[0], { ...original[1], key: 'replacement',
      uri: duplicate ? original[0].uri : 'https://example.invalid/replacement.jpg' }]);
    const images = lightboxImagesForPayload(updated, clicked, 'pending');
    const initialImage = images[galleryImageIndexForPayload(images, clicked)];
    const onShareImage = vi.fn();
    // Mirror the renderer's selected-image props; identity must disambiguate equal URLs.
    const { props, render } = mount({ images,
      initialImageKey: initialImage?.key ?? clicked.galleryImageKey,
      initialUrl: initialImage?.url ?? clicked.media.url, onShareImage });
    expect(runtime.nodes.get('FlatList').initialScrollIndex).toBe(1);
    expect(runtime.nodes.get("preview.collectionCount").children).toBe('2 / 2');
    await act(async () => runtime.nodes.get('message.imageLightboxShareButton').onPress());
    expect(onShareImage.mock.lastCall?.[0]).toBe(images[1].payload.media);

    // Adopt the replacement on the very first render, so later shifts still follow its identity.
    props.images = [{ ...images[0], key: 'inserted',
      payload: { ...images[0].payload, galleryImageKey: 'inserted' } }, ...images];
    render();
    expect(runtime.nodes.get("preview.collectionCount").children).toBe('3 / 3');
    await act(async () => runtime.nodes.get('message.imageLightboxShareButton').onPress());
    expect(onShareImage.mock.lastCall?.[0]).toBe(images[1].payload.media);
  });

  it.each(['neighbor', 'replaced image'])('resets annotation and dimensions when a queued edit replaces the active attachment (opened from %s)', async (openedFrom) => {
    const collectQueued = (id: string, url: string) => collectMobileMessageGalleryImages(buildPendingSendItems({
      queue: [{ clientId: 'pending', text: '', chatMessage: {}, files: [
        { id, name: 'same.jpg', category: 'image', path: url, url },
        { id: 'neighbor', name: 'neighbor.jpg', category: 'image', path: 'https://example.invalid/neighbor.jpg' },
      ] } as unknown as QueuedRemoteMessage],
      settling: [], outbox: [], hiddenClientIds: new Set(), sendingClientIds: new Set(),
      editingClientId: null, steeringClientIds: new Set(), presentationByClientId: new Map(),
    }));
    const initial = collectQueued('original', 'https://example.invalid/original.jpg');
    // Cover both the original click and paging from an unchanged neighbor before a remote edit.
    const clicked = initial[openedFrom === 'neighbor' ? 1 : 0].payload;
    const onSubmit = vi.fn(() => new Promise<void>(() => undefined));
    const { props, render } = mount({ images: initial, initialUrl: clicked.media.url,
      annotation: { submitLabel: 'Send', onSubmit } });
    act(() => runtime.nodes.get('FlatList').onMomentumScrollEnd({ nativeEvent: { contentOffset: { x: 0 } } }));
    act(() => runtime.nodes.get('Image').onLoad({ source: { width: 400, height: 800 } }));
    press('message.imageLightboxAnnotateButton');
    const draw = () => gestures().find((gesture) => gesture.kind === 'Pan' && gesture.options.minDistance === 0)!;
    fire(draw(), 'onStart', { x: 100, y: 200 });
    fire(draw(), 'onFinalize', {}, true);
    fire(draw(), 'onStart', { x: 200, y: 400 });
    const page = () => runtime.nodes.get('FlatList').renderItem({ item: props.images[0], index: 0 }).props;

    // A new URL for the same attachment must retain both strokes and known dimensions.
    const settled = collectQueued('original', 'https://example.invalid/settled.jpg');
    props.images = lightboxImagesForPayload(settled, clicked, 'message-pending', props.images);
    render();
    expect(page().annotationStrokes).toEqual([{ points: [{ x: 0.25, y: 0.25 }] }]);
    expect(page().annotationDraftStroke).toEqual({ points: [{ x: 0.5, y: 0.5 }] });
    expect(page().naturalSize).toEqual({ width: 400, height: 800 });

    const replaced = collectQueued('replacement', 'https://example.invalid/replacement.jpg');
    props.images = lightboxImagesForPayload(replaced, clicked, 'message-pending', props.images);
    render();
    expect(page().annotationStrokes).toEqual([]);
    expect(page().annotationDraftStroke).toBeNull();
    expect(page().naturalSize).toBeNull();
    expect(runtime.nodes.get("preview.collectionCount").children).toBe('1 / 2');
    act(() => runtime.nodes.get('Image').onLoad({ source: { width: 800, height: 400 } }));
    fire(draw(), 'onStart', { x: 200, y: 400 });
    fire(draw(), 'onFinalize', {}, true);
    press('message.imageLightboxAnnotationSubmit');
    await act(async () => { await Promise.resolve(); });
    expect(onSubmit.mock.calls[0]).toEqual([
      replaced[0], replaced[0].url, [{ points: [{ x: 0.5, y: 0.5 }] }],
      { mimeType: undefined, naturalWidth: 800, naturalHeight: 400 },
    ]);
  });

  it('keeps ordinary message pages selected when a completed work group rebuilds its keys', async () => {
    // Ordinary message pages have no stable pending attachment identity.
    const initial = collect(thumbs).map((image) => ({ ...image, payload: { ...image.payload, galleryImageKey: undefined } }));
    const onShareImage = vi.fn();
    const { props, render } = mount({ images: initial, initialUrl: initial[1].url, onShareImage });
    props.images = initial.map((image) => ({ ...image, key: `completed:${image.key}` }));
    render();
    expect(runtime.nodes.get("preview.collectionCount").children).toBe('2 / 2');
    await act(async () => runtime.nodes.get('message.imageLightboxShareButton').onPress());
    expect(onShareImage.mock.lastCall?.[0].url).toBe(initial[1].url);
    // After rebuilding the keys, moving this page must follow its adopted key.
    const updated = collect([{ ...thumbs[1], uri: 'https://example.invalid/current.jpg' }])[0];
    props.images = [{ ...updated, key: props.images[1].key }, props.images[0]];
    render();
    expect(runtime.nodes.get("preview.collectionCount").children).toBe('1 / 2');
    await act(async () => runtime.nodes.get('message.imageLightboxShareButton').onPress());
    expect(onShareImage.mock.lastCall?.[0].url).toBe('https://example.invalid/current.jpg');
  });
});

describe('gallery prefetch boundaries', () => {
  // #6517 review P1, unit: real viewer + production queue, with both slots occupied
  // and a background thumbnail ahead of a prefetched neighbor. Queue-only tests
  // cannot detect the viewer dropping the promotion when the user pages to it.
  // Single-file validation: 117 tests, 3.39s (vitest run imageLightboxInteraction.test.tsx --maxWorkers=1).
  it.each([0, 1])('promotes the last selected image %i ahead of background work without downloading it twice', async (selected) => {
    const images = ['a', 'b', 'c'].map<ImageLightboxProps['images'][number]>((key) => ({ key, title: key, url: `xdt-image://cache/${key}.png`,
      payload: { kind: 'media', title: key, body: '', media: { kind: 'image', url: `xdt-image://cache/${key}.png`, previewable: false } },
    }));
    const pending = new Map<string, (media: MobileResolvedRemoteMedia) => void>();
    const download = vi.fn((media: { url: string }) => new Promise<MobileResolvedRemoteMedia>((resolve) => {
      pending.set(media.url, resolve);
    }));
    const queue = createRemoteMediaResolveQueue({ resolve: download });
    const resolver = vi.fn<NonNullable<ImageLightboxProps['onResolveRemoteMedia']>>((media, opts) => queue.request(media, opts));
    const result = (key: string): MobileResolvedRemoteMedia => ({ url: `file:///${key}.png`,
      ossKey: '', mimeType: 'image/png', size: 1, expiresAt: '2099-01-01T00:00:00Z', previewable: true });
    const onShareImage = vi.fn();
    const page = (index: number) => act(() => {
      runtime.renderPageIndex = index;
      runtime.nodes.get('FlatList').onMomentumScrollEnd({ nativeEvent: { contentOffset: { x: index * 400 } } });
    });
    try {
      for (const url of ['block-1', 'block-2', 'background']) {
        void queue.request({ kind: 'image', url, thumbnail: true }).catch(() => undefined);
      }
      await act(async () => { mount({ images, initialUrl: images[0].url, onResolveRemoteMedia: resolver, onShareImage }); });
      page(1);
      page(0);
      if (selected === 1) page(1);
      const image = images[selected];
      expect(isMounted('message.imageLightboxLoadingBar')).toBe(true);
      await act(async () => { pending.get('block-1')!(result('block-1')); });
      expect(download.mock.calls.map(([media]) => media.url)).toEqual(['block-1', 'block-2', image.url]);
      await act(async () => { pending.get(image.url)!(result(image.key)); });
      expect(runtime.nodes.get('Image').source.uri).toBe(`file:///${image.key}.png`);
      expect(
          runtime.nodes.get("message.imageLightboxShareButton").disabled,
        ).toBe(true);
      act(() => runtime.nodes.get('Image').onLoad({ source: { width: 1600, height: 900 } }));
      await act(async () => { press('message.imageLightboxShareButton'); });
      expect(onShareImage).toHaveBeenCalledWith(image.payload.media, `file:///${image.key}.png`, 'image/png', 1);
      expect(download.mock.calls.filter(([media]) => media.url === image.url)).toHaveLength(1);
    } finally {
      await act(async () => {
        queue.releaseAll();
        for (const [url, finish] of pending) finish(result(url));
      });
    }
  });

  it('does not fetch a titled outside-workdir image when a neighboring image is opened', async () => {
    const items = [{
      type: 'message', key: 'm1',
      message: {
        key: 'm1', kind: 'assistant', role: 'assistant', align: 'agent', label: 'assistant',
        source: { clientId: 'm1', role: 'assistant', content: '', createdAt: '2026-10-01T00:00:00Z' },
        body: '![ok](https://example.invalid/ok.png)\n\n![private](xdt-file://open?path=%2Fprivate%2Fphoto.png "title")',
      },
    }] as MobileMessageRenderItem[];
    const gallery = collectMobileMessageGalleryImages(items, '/repo');
    const images = lightboxImagesForPayload(gallery, gallery[0].payload);
    const resolver = vi.fn(async () => ({
      url: 'file:///download.png', previewable: true, ossKey: 'download.png',
      mimeType: 'image/png', size: 1, expiresAt: '2099-01-01T00:00:00Z',
    }));
    await act(async () => { mount({ images, initialUrl: images[0].url, onResolveRemoteMedia: resolver }); });
    expect(resolver).not.toHaveBeenCalled();
    expect(images.map((image) => image.url)).toEqual(['https://example.invalid/ok.png']);
  });

  it('prefetches an inside-workdir neighbor with the Host realpath constraint', async () => {
    const items = [{
      type: 'message', key: 'm1',
      message: {
        key: 'm1', kind: 'assistant', role: 'assistant', align: 'agent', label: 'assistant',
        source: { clientId: 'm1', role: 'assistant', content: '', createdAt: '2026-10-01T00:00:00Z' },
        body: '![ok](https://example.invalid/ok.png)\n\n![local](xdt-file://open?path=%2Frepo%2Fphoto.png&baseDir=%2F "title")',
      },
    }] as MobileMessageRenderItem[];
    const gallery = collectMobileMessageGalleryImages(items, '/repo');
    const images = lightboxImagesForPayload(gallery, gallery[0].payload);
    const resolver = vi.fn(async (_media: { url: string }) => ({
      url: 'file:///download.png', previewable: true, ossKey: 'download.png',
      mimeType: 'image/png', size: 1, expiresAt: '2099-01-01T00:00:00Z',
    }));
    await act(async () => { mount({ images, initialUrl: images[0].url, onResolveRemoteMedia: resolver }); });
    expect(images).toHaveLength(2);
    expect(resolver).toHaveBeenCalledTimes(2);
    for (const [media] of resolver.mock.calls) {
      expect(new URL(media.url).searchParams.get('path')).toBe('/repo/photo.png');
      expect(new URL(media.url).searchParams.getAll('baseDir')).toEqual(['/repo']);
    }
  });
});

describe('SVG images in the shared lightbox', () => {
  it.each([
    { name: 'diagram', mimeType: 'image/svg+xml; charset=utf-8' },
    { name: 'diagram.svg' },
  ])('keeps opaque SVG attachment URLs unannotatable: %j', async (metadata) => {
    const url = 'https://example.invalid/download?id=1';
    const attachment = svgAttachmentForDisplay({
      kind: 'file', path: url, previewable: false, ...metadata,
    });
    const payload = buildAttachmentPayload(attachment);
    if (payload.kind !== 'media') throw new Error('Expected an image payload');
    const onShareImage = vi.fn();
    mount({
      images: [{ key: 'svg', title: attachment.name, url, payload }], initialUrl: url,
      annotation: { submitLabel: 'Send', onSubmit: vi.fn() }, onShareImage,
    });
    expect(runtime.nodes.has('message.imageLightboxAnnotateButton')).toBe(false);
    await act(async () => runtime.nodes.get('message.imageLightboxShareButton').onPress());
    expect(onShareImage).toHaveBeenCalledWith(payload.media, url, 'image/svg+xml', undefined);
  });

  it.each([
    'https://example.invalid/diagram.svg?version=2',
    'data:image/svg+xml;base64,PHN2Zy8+',
    'file:///cache/diagram.svg',
  ])('loads %s with image gestures and without raster annotation', (url) => {
    const image = {
      key: 'svg', title: 'Diagram', url,
      payload: { kind: 'media', media: { kind: 'image', url, previewable: true } },
    } as ImageLightboxProps['images'][number];
    mount({ images: [image], initialUrl: url, annotation: { submitLabel: 'Send', onSubmit: vi.fn() } });
    const props = runtime.nodes.get('Image');
    expect(props.source.uri).toBe(url);
    expect(props.contentFit).toBe('contain');
    act(() => props.onLoad({ source: { width: 1600, height: 900 } }));
    doubleTapAtCorner();
    finishAnimations();
    expect(transform().scale).toBe(2.5);
    expect(transform().y).toBe(0);
    expect(runtime.nodes.has('message.imageLightboxAnnotateButton')).toBe(false);
  });
});

function gestures(node = runtime.gesture!): GestureNode[] {
  return node.children ? node.children.flatMap(gestures) : [node];
}
const doubleTap = () =>
  gestures().find((g) => g.kind === "Tap" && g.options.numberOfTaps === 2)!;
const pan = () =>
  gestures().find((g) => g.kind === "Pan" && "minPointers" in g.options)!;
const pinch = () => gestures().find((g) => g.kind === "Pinch")!;
function fire(gesture: GestureNode, name: string, event = {}, success = true) {
  act(() => gesture.handlers[name]?.(event, success));
}
function finishAnimations() {
  act(() => {
    for (const cell of runtime.values) {
      const animation = cell.animation;
      if (!animation) continue;
      cell.animation = undefined;
      cell.value = animation.target;
      animation.done?.(true);
    }
  });
}
function transform() {
  const style = runtime.nodes.get("Image").style[1].current;
  return {
    x: style.transform[0].translateX,
    y: style.transform[1].translateY,
    scale: style.transform[4].scale,
  };
}
/** 画面位移(origin 折进 translate 后):捏合中途重新锚定会改 raw translate,画面不变。 */
function visual() {
  const t = runtime.nodes.get("Image").style[1].current.transform;
  const scale = t[4].scale;
  return {
    x: t[0].translateX + t[2].translateX * (1 - scale),
    y: t[1].translateY + t[3].translateY * (1 - scale),
    scale,
  };
}
const press = (id: string) =>
  act(() => runtime.nodes.get(id).onPress({ stopPropagation: vi.fn() }));
const doubleTapAtCorner = () => fire(doubleTap(), "onEnd", { x: 330, y: 650 });

describe("image viewer gesture lifecycle", () => {
  it.each(["before", "after"])(
    "recenters when an unactivated pan finalizes %s the second double tap",
    (order) => {
      mount();
      doubleTapAtCorner();
      finishAnimations();
      expect(transform()).toEqual({ x: -195, y: -375, scale: 2.5 });
      if (order === "before") fire(pan(), "onFinalize", {}, false);
      doubleTapAtCorner();
      if (order === "after") fire(pan(), "onFinalize", {}, false);
      expect(runtime.nodes.get("FlatList").scrollEnabled).toBe(false);
      finishAnimations();
      expect(transform()).toEqual({ x: 0, y: 0, scale: 1 });
      expect(runtime.nodes.get("FlatList").scrollEnabled).toBe(true);
    },
  );

  it("rapid double taps toggle the animation destination even before the first frame", () => {
    mount();
    doubleTapAtCorner();
    doubleTapAtCorner();
    finishAnimations();
    expect(transform()).toEqual({ x: 0, y: 0, scale: 1 });
  });

  it.each(["pan", "pinch"])(
    "%s takes over all transform animations at the visible frame",
    (kind) => {
      mount();
      doubleTapAtCorner();
      finishAnimations();
      doubleTapAtCorner();
      // Move halfway through the pending zoom-out without completing its callbacks.
      const moving = runtime.values.filter((v) => v.animation);
      for (const cell of moving) {
        const animation = cell.animation!;
        cell.animation = undefined;
        const half = (cell.value + animation.target) / 2;
        cell.value = half;
        cell.animation = animation;
      }
      const gesture = kind === "pan" ? pan() : pinch();
      fire(gesture, "onStart", { focalX: 200, focalY: 400 });
      if (kind === "pan")
        fire(gesture, "onChange", { changeX: 20, changeY: 10 });
      else fire(gesture, "onChange", { focalX: 200, focalY: 400, scale: 1.2 });
      fire(gesture, "onFinalize");
      const takenOver = transform();
      finishAnimations();
      expect(transform()).toEqual(takenOver);
      expect(transform().scale).toBeGreaterThan(1);
      expect(runtime.nodes.get("FlatList").scrollEnabled).toBe(false);
    },
  );

  it("supports immediate animation completion for reduced motion", () => {
    runtime.immediate = true;
    mount();
    doubleTapAtCorner();
    expect(transform()).toEqual({ x: -195, y: -375, scale: 2.5 });
    doubleTapAtCorner();
    expect(transform()).toEqual({ x: 0, y: 0, scale: 1 });
  });

  it("reclamps an in-flight zoom when a landscape image finishes loading", () => {
    mount();
    doubleTapAtCorner();
    act(() =>
      runtime.nodes
        .get("Image")
        .onLoad({ source: { width: 1600, height: 900 } }),
    );
    finishAnimations();
    expect(transform().y).toBe(0);
    expect(transform().x).toBe(-195);
  });

  // 双击右下角后:2.5x,T=(-195,-375);未知尺寸按 400×800 铺满,溢出 x=300、y=600。
  it("keeps following a zoomed pan past the image edge and springs back on release", () => {
    mount();
    doubleTapAtCorner();
    finishAnimations();
    fire(pan(), "onStart");
    fire(pan(), "onChange", { changeX: -200, changeY: 0 });
    const stretched = transform().x;
    expect(stretched).toBeLessThan(-300);
    expect(stretched).toBeGreaterThan(-395);
    // 往回拖同样的距离回到原处,越界段不吞位移
    fire(pan(), "onChange", { changeX: 200, changeY: 0 });
    expect(transform().x).toBeCloseTo(-195, 6);
    fire(pan(), "onChange", { changeX: -200, changeY: 0 });
    fire(pan(), "onFinalize", { velocityX: 0, velocityY: 0 });
    finishAnimations();
    expect(transform()).toEqual({ x: -300, y: -375, scale: 2.5 });
  });

  it("flings with inertia inside the bounds and a touch catches it in place", () => {
    mount();
    doubleTapAtCorner();
    finishAnimations();
    fire(pan(), "onStart");
    fire(pan(), "onChange", { changeX: 10, changeY: 0 });
    fire(pan(), "onFinalize", { velocityX: 1500, velocityY: 0 });
    const fling = runtime.values.find((v) => v.animation?.decay)?.animation?.decay;
    expect(fling).toEqual({ velocity: 1500, clamp: [-300, 300], rubberBandEffect: true });
    const fail = vi.fn();
    act(() => pan().handlers.onTouchesDown({}, { fail }));
    expect(fail).not.toHaveBeenCalled();
    expect(runtime.values.some((v) => v.animation?.decay)).toBe(false);
    // 接住后没拖就抬手:在边界内原地停住,不再滑也不回弹
    const caught = transform();
    fire(pan(), "onFinalize", {}, false);
    finishAnimations();
    expect(transform()).toEqual(caught);
  });

  it("lets a pinch overshoot the max zoom and settles back around the fingers", () => {
    mount();
    doubleTapAtCorner();
    finishAnimations();
    // 焦点相对中心 (50,-100),其下图片点 p = (F - T) / 2.5 = (98, 110)
    fire(pinch(), "onStart", { focalX: 250, focalY: 300 });
    fire(pinch(), "onChange", { focalX: 250, focalY: 300, scale: 2.4 });
    expect(transform().scale).toBeGreaterThan(4);
    expect(transform().scale).toBeLessThan(6);
    fire(pinch(), "onFinalize");
    expect(runtime.nodes.get("FlatList").scrollEnabled).toBe(false);
    finishAnimations();
    const settled = transform();
    expect(settled.scale).toBe(4);
    expect(settled.x + 98 * settled.scale).toBeCloseTo(50, 6);
    expect(settled.y + 110 * settled.scale).toBeCloseTo(-100, 6);
  });

  it("zooms a second pinch around the fingers, not the stale screen focal", () => {
    mount();
    doubleTapAtCorner();
    finishAnimations();
    fire(pinch(), "onStart", { focalX: 250, focalY: 300 });
    fire(pinch(), "onChange", { focalX: 250, focalY: 300, scale: 1.2 });
    fire(pinch(), "onFinalize");
    finishAnimations();
    const after = transform();
    expect(after.scale).toBe(3);
    expect(after.x + 98 * after.scale).toBeCloseTo(50, 6);
    expect(after.y + 110 * after.scale).toBeCloseTo(-100, 6);
  });

  it("does not jump when the fingers lift one at a time", () => {
    mount();
    doubleTapAtCorner();
    finishAnimations();
    fire(pinch(), "onStart", { focalX: 250, focalY: 300, numberOfPointers: 2 });
    fire(pinch(), "onChange", { focalX: 250, focalY: 300, scale: 1.2, numberOfPointers: 2 });
    const pinched = visual();
    // 先抬一指:焦点跳到余下那根手指上(半个指距),倍率不变,画面不能跟着跳。
    fire(pinch(), "onChange", { focalX: 330, focalY: 300, scale: 1.2, numberOfPointers: 1 });
    expect(visual().x).toBeCloseTo(pinched.x, 6);
    expect(visual().y).toBeCloseTo(pinched.y, 6);
    expect(visual().scale).toBeCloseTo(pinched.scale, 6);
    // 余下那根手指激活的单指平移不能叠加位移,松手也不另起惯性滑行。
    fire(pan(), "onStart");
    fire(pan(), "onChange", { changeX: 40, changeY: 0 });
    expect(visual().x).toBeCloseTo(pinched.x, 6);
    fire(pinch(), "onFinalize");
    fire(pan(), "onFinalize", { velocityX: 2000, velocityY: 0 });
    expect(runtime.values.some((v) => v.animation?.decay)).toBe(false);
    finishAnimations();
    const after = transform();
    expect(after.scale).toBe(3);
    expect(after.x + 98 * after.scale).toBeCloseTo(50, 6);
    expect(after.y + 110 * after.scale).toBeCloseTo(-100, 6);
  });

  it("keeps the pinch in charge when a pan that started first ends mid-pinch", () => {
    mount();
    doubleTapAtCorner();
    finishAnimations();
    // 单指先拖,第二根手指落下开始捏合
    fire(pan(), "onStart");
    fire(pan(), "onChange", { changeX: 10, changeY: 0 });
    fire(pinch(), "onStart", { focalX: 250, focalY: 300, numberOfPointers: 2 });
    fire(pinch(), "onChange", { focalX: 250, focalY: 300, scale: 1.2, numberOfPointers: 2 });
    const pinched = visual();
    // 平移在捏合进行中收到位移并结束:不叠加、不滑行,也不改写捏合起点
    fire(pan(), "onChange", { changeX: 40, changeY: 0 });
    fire(pan(), "onFinalize", { velocityX: 2000, velocityY: 0 });
    expect(runtime.values.some((v) => v.animation?.decay)).toBe(false);
    expect(visual().x).toBeCloseTo(pinched.x, 6);
    fire(pinch(), "onChange", { focalX: 250, focalY: 300, scale: 1.2, numberOfPointers: 2 });
    expect(visual().x).toBeCloseTo(pinched.x, 6);
    expect(visual().y).toBeCloseTo(pinched.y, 6);
    fire(pinch(), "onFinalize");
    finishAnimations();
    // 平移后画面位移 (-185,-375),焦点 (50,-100) 下的图片点 p = (F - T) / 2.5 = (94, 110)
    const after = transform();
    expect(after.scale).toBe(3);
    expect(after.x + 94 * after.scale).toBeCloseTo(50, 6);
    expect(after.y + 110 * after.scale).toBeCloseTo(-100, 6);
  });

  it("lets the remaining finger keep dragging after the first one lifts", () => {
    mount();
    doubleTapAtCorner();
    finishAnimations();
    fire(pinch(), "onStart", { focalX: 250, focalY: 300, numberOfPointers: 2 });
    fire(pinch(), "onChange", { focalX: 250, focalY: 300, scale: 1.2, numberOfPointers: 2 });
    fire(pinch(), "onChange", { focalX: 330, focalY: 300, scale: 1.2, numberOfPointers: 1 });
    const lifted = visual();
    fire(pinch(), "onChange", { focalX: 330, focalY: 290, scale: 1.2, numberOfPointers: 1 });
    expect(visual().y).toBeCloseTo(lifted.y - 10, 6);
    expect(visual().x).toBeCloseTo(lifted.x, 6);
  });

  it("settles an over-zoom around the two-finger focal, not the last remaining finger", () => {
    mount();
    doubleTapAtCorner();
    finishAnimations();
    fire(pinch(), "onStart", { focalX: 250, focalY: 300, numberOfPointers: 2 });
    fire(pinch(), "onChange", { focalX: 250, focalY: 300, scale: 2.4, numberOfPointers: 2 });
    fire(pinch(), "onChange", { focalX: 330, focalY: 300, scale: 2.4, numberOfPointers: 1 });
    fire(pinch(), "onFinalize");
    finishAnimations();
    const settled = transform();
    expect(settled.scale).toBe(4);
    expect(settled.x + 98 * settled.scale).toBeCloseTo(50, 6);
    expect(settled.y + 110 * settled.scale).toBeCloseTo(-100, 6);
  });

  it("re-anchors when the gesture's own scale baseline resets with the pointer count", () => {
    mount();
    doubleTapAtCorner();
    finishAnimations();
    fire(pinch(), "onStart", { focalX: 250, focalY: 300, numberOfPointers: 2 });
    fire(pinch(), "onChange", { focalX: 250, focalY: 300, scale: 1.2, numberOfPointers: 2 });
    const before = visual();
    // 指数变化那一帧手势倍率回到 1:画面倍率不能跟着掉回 2.5x。
    fire(pinch(), "onChange", { focalX: 330, focalY: 300, scale: 1, numberOfPointers: 1 });
    expect(visual().scale).toBeCloseTo(before.scale, 6);
    expect(visual().x).toBeCloseTo(before.x, 6);
  });

  it("keeps the point under the fingers when pinching during an edge rebound", () => {
    mount();
    doubleTapAtCorner();
    finishAnimations();
    // 拖过左边缘松手:回弹尚未落定
    fire(pan(), "onStart");
    fire(pan(), "onChange", { changeX: -200, changeY: 0 });
    fire(pan(), "onFinalize", { velocityX: 0, velocityY: 0 });
    const start = transform();
    expect(start.x).toBeLessThan(-300);
    // 回弹途中在屏幕中心捏到 4x:中心下的图片点 p = (0 - T) / 2.5
    const pointX = -start.x / 2.5;
    fire(pinch(), "onStart", { focalX: 200, focalY: 400 });
    fire(pinch(), "onChange", { focalX: 200, focalY: 400, scale: 1.6 });
    fire(pinch(), "onFinalize");
    finishAnimations();
    const settled = transform();
    expect(settled.scale).toBe(4);
    expect(settled.x + pointX * settled.scale).toBeCloseTo(0, 6);
  });

  it("lets a pinch shrink below 1x and springs back to the fitted image", () => {
    mount();
    fire(pinch(), "onStart", { focalX: 200, focalY: 400 });
    fire(pinch(), "onChange", { focalX: 220, focalY: 420, scale: 0.5 });
    expect(transform().scale).toBeLessThan(1);
    expect(transform().scale).toBeGreaterThan(0.5);
    fire(pinch(), "onFinalize");
    // 回弹到 1x 落定前不放开翻页:快速横划不能在回弹中途切走当前图。
    expect(runtime.nodes.get("FlatList").scrollEnabled).toBe(false);
    finishAnimations();
    expect(transform()).toEqual({ x: 0, y: 0, scale: 1 });
    expect(runtime.nodes.get("FlatList").scrollEnabled).toBe(true);
  });

  it("unlocks paging after a synchronous settle under reduced motion", () => {
    runtime.immediate = true;
    mount();
    fire(pinch(), "onStart", { focalX: 200, focalY: 400 });
    fire(pinch(), "onChange", { focalX: 220, focalY: 420, scale: 0.5 });
    fire(pinch(), "onFinalize");
    expect(transform()).toEqual({ x: 0, y: 0, scale: 1 });
    expect(runtime.nodes.get("FlatList").scrollEnabled).toBe(true);
  });

  it("keeps settling into the new bounds when the image size arrives mid-spring", () => {
    mount();
    doubleTapAtCorner();
    finishAnimations();
    fire(pinch(), "onStart", { focalX: 250, focalY: 300 });
    fire(pinch(), "onChange", { focalX: 250, focalY: 300, scale: 2.4 });
    fire(pinch(), "onFinalize");
    // 横图 1600×900 contain 后 400×225:4x 时纵向溢出只剩 (900-800)/2 = 50
    act(() => runtime.nodes.get("Image").onLoad({ source: { width: 1600, height: 900 } }));
    finishAnimations();
    const settled = transform();
    expect(settled.scale).toBe(4);
    expect(Math.abs(settled.y)).toBeLessThanOrEqual(50);
    expect(runtime.nodes.get("FlatList").scrollEnabled).toBe(false);
  });

  it("unlocks paging when the image size arrives during a translation-only settle at 1x", () => {
    mount();
    // 倍率未变、只有焦点漂移:松手只回弹位移
    fire(pinch(), "onStart", { focalX: 200, focalY: 400 });
    fire(pinch(), "onChange", { focalX: 260, focalY: 400, scale: 1 });
    fire(pinch(), "onFinalize");
    expect(runtime.nodes.get("FlatList").scrollEnabled).toBe(false);
    act(() => runtime.nodes.get("Image").onLoad({ source: { width: 1600, height: 900 } }));
    finishAnimations();
    expect(transform()).toEqual({ x: 0, y: 0, scale: 1 });
    expect(runtime.nodes.get("FlatList").scrollEnabled).toBe(true);
  });

  it("keeps the native edge bounce available for a single image at 1x", () => {
    const url = "https://example.invalid/solo.png";
    mount({
      images: [{
        key: "solo", url, title: "Solo", subtitle: "",
        payload: { kind: "media", media: { kind: "image", url, previewable: true } },
      } as ImageLightboxProps["images"][number]],
      initialUrl: url,
    });
    expect(runtime.nodes.get("FlatList").scrollEnabled).toBe(true);
  });

  it("does not accept dragging as the second tap", () => {
    mount();
    expect(doubleTap().options.maxDistance).toBe(12);
    fire(doubleTap(), "onEnd", { x: 330, y: 650 }, false);
    finishAnimations();
    expect(transform()).toEqual({ x: 0, y: 0, scale: 1 });
  });
});

describe("image viewer actions", () => {
  it('keeps gestures stable when a parent replaces only its close callback', () => {
    const harness = mount();
    const originalGesture = runtime.gesture;
    harness.props.onClose = vi.fn();
    harness.render();
    expect(runtime.gesture).toBe(originalGesture);
    press('message.imageLightboxCloseButton');
    expect(harness.props.onClose).toHaveBeenCalledTimes(1);
  });

  it('reclamps zoom after rotation and still returns to the centered image', () => {
    const harness = mount();
    act(() => runtime.nodes.get('Image').onLoad({ source: { width: 400, height: 800 } }));
    doubleTapAtCorner(); finishAnimations();
    runtime.dimensions = { width: 800, height: 400 };
    runtime.insets = { top: 0, bottom: 20, left: 59, right: 0 };
    // The native dimensions hook schedules its own render; this mock uses a changed prop.
    harness.props.onClose = vi.fn();
    harness.render();
    const chromeBounds = () => Object.assign({}, ...runtime.nodes.get("preview.header").style);
    expect(chromeBounds().paddingLeft).toBeGreaterThanOrEqual(59);
    expect(chromeBounds().paddingRight).toBeLessThan(59);
    expect(transform().x).toBeCloseTo(0);
    expect(transform().y).toBe(-300);
    expect(transform().scale).toBe(2.5);
    doubleTapAtCorner(); finishAnimations();
    expect(transform()).toEqual({ x: 0, y: 0, scale: 1 });
    runtime.insets = { top: 0, bottom: 20, left: 0, right: 59 };
    harness.props.onClose = vi.fn();
    harness.render();
    expect(chromeBounds().paddingLeft).toBeLessThan(59);
    expect(chromeBounds().paddingRight).toBeGreaterThanOrEqual(59);
  });

  it('includes the visible unfinished stroke and ignores drawing delivered after submit', async () => {
    let complete!: () => void;
    const onSubmit = vi.fn(() => new Promise<void>((resolve) => { complete = resolve; }));
    mount({ annotation: { submitLabel: 'Send', onSubmit } });
    act(() => runtime.nodes.get('Image').onLoad({ source: { width: 400, height: 800 } }));
    press('message.imageLightboxAnnotateButton');
    const draw = gestures().find(
      (g) => g.kind === 'Pan' && g.options.minDistance === 0)!;
    fire(draw, 'onStart', { x: 100, y: 200 });
    press('message.imageLightboxAnnotationSubmit');
    fire(draw, 'onUpdate', { x: 300, y: 600 });
    fire(draw, 'onFinalize');
    await act(async () => { await Promise.resolve(); });
    expect(onSubmit.mock.calls[0]).toEqual(expect.arrayContaining([
      [{ points: [{ x: 0.25, y: 0.25 }] }],
    ]));
    await act(async () => { complete(); });
  });

  it('preserves the unfinished stroke when submission fails and drawing resumes', async () => {
    let reject!: (error: Error) => void;
    const onSubmit = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    mount({ annotation: { submitLabel: 'Send', onSubmit } });
    act(() => runtime.nodes.get('Image').onLoad({ source: { width: 400, height: 800 } }));
    press('message.imageLightboxAnnotateButton');
    const draw = () => gestures().find((g) => g.kind === 'Pan' && g.options.minDistance === 0)!;
    fire(draw(), 'onStart', { x: 100, y: 200 });
    press('message.imageLightboxAnnotationSubmit');
    fire(draw(), 'onFinalize');
    await act(async () => { await Promise.resolve(); });
    await act(async () => { reject(new Error('offline')); });
    fire(draw(), 'onStart', { x: 300, y: 600 });
    fire(draw(), 'onFinalize');
    press('message.imageLightboxAnnotationSubmit');
    await act(async () => { await Promise.resolve(); });
    expect(onSubmit.mock.calls[1]).toEqual(expect.arrayContaining([
      [{ points: [{ x: 0.25, y: 0.25 }] }, { points: [{ x: 0.75, y: 0.75 }] }],
    ]));
    await act(async () => { reject(new Error('offline')); });
  });

  it("offers an accessible close while zoomed and handles accessibility escape", () => {
    const { props } = mount();
    doubleTapAtCorner();
    finishAnimations();
    expect(
      runtime.nodes.get("message.imageLightboxCloseButton").accessibilityRole,
    ).toBe("button");
    press("message.imageLightboxCloseButton");
    act(() =>
      runtime.nodes.get("message.imageLightbox").onAccessibilityEscape(),
    );
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });

  it("retries a direct image in place after a native load failure", () => {
    const { props } = mount();
    act(() => runtime.nodes.get("Image").onError());
    expect(runtime.nodes.has("message.imageLightboxRetryButton")).toBe(true);
    press("message.imageLightboxRetryButton");
    act(() =>
      runtime.nodes
        .get("Image")
        .onLoad({ source: { width: 400, height: 800 } }),
    );
    expect(props.onClose).not.toHaveBeenCalled();
    expect(runtime.nodes.get("Image").source.uri).toBe(props.initialUrl);
  });

  it("deduplicates sharing and restores its button after rejection", async () => {
    let reject!: (error: Error) => void;
    const onShareImage = vi.fn(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    );
    mount({ onShareImage });
    press("message.imageLightboxShareButton");
    press("message.imageLightboxShareButton");
    await act(async () => {
      await Promise.resolve();
    });
    expect(onShareImage).toHaveBeenCalledTimes(1);
    expect(runtime.nodes.get("message.imageLightboxShareButton").disabled).toBe(
      true,
    );
    await act(async () => {
      reject(new Error("offline"));
    });
    expect(runtime.nodes.get("message.imageLightboxShareButton").disabled).toBe(
      false,
    );
  });

  it.each([false, true])(
    "freezes gestures and closing during submission (annotating=%s)",
    async (annotating) => {
      let complete!: () => void;
      const onSubmit = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            complete = resolve;
          }),
      );
      const { props } = mount({
        annotation: { allowDirectSubmit: true, submitLabel: "Send", onSubmit },
      });
      if (annotating) {
        // 画笔要等自然尺寸就位才可用(坐标换算基准)。
        act(() => runtime.nodes.get("Image").onLoad({ source: { width: 400, height: 800 } }));
        press("message.imageLightboxAnnotateButton");
      }
      const submitId = annotating
        ? "message.imageLightboxAnnotationSubmit"
        : "message.imageLightboxSendToChatButton";
      press(submitId);
      press(submitId);
      await act(async () => {
        await Promise.resolve();
      });
      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(gestures().every((g) => g.options.enabled === false)).toBe(true);
      expect(runtime.nodes.get("FlatList").scrollEnabled).toBe(false);
      act(() => runtime.nodes.get("Modal").onRequestClose());
      expect(props.onClose).not.toHaveBeenCalled();
      await act(async () => {
        complete();
      });
      expect(props.onClose).toHaveBeenCalledTimes(1);
    },
  );

  it("recovers from a synchronously throwing submit callback", async () => {
    mount({
      annotation: {
        allowDirectSubmit: true,
        submitLabel: "Send",
        onSubmit: () => {
          throw new Error("offline");
        },
      },
    });
    press("message.imageLightboxSendToChatButton");
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      runtime.nodes.get("message.imageLightboxSendToChatButton").disabled,
    ).toBe(false);
    expect(runtime.nodes.get("FlatList").scrollEnabled).toBe(true);
  });
});

describe("annotation drawing", () => {
  const drawGesture = () => gestures().find((g) => g.kind === "Pan" && g.options.minDistance === 0)!;
  const load = () => act(() => runtime.nodes.get("Image").onLoad({ source: { width: 400, height: 800 } }));
  // 标注模式锁翻页:FlatList 每次渲染都会重新登记,比「节点是否存在」更可靠(卸载节点不会从登记表移除)。
  const annotating = () => runtime.nodes.get("FlatList").scrollEnabled === false;
  const submittedStrokes = async (onSubmit: ReturnType<typeof vi.fn>) => {
    press("message.imageLightboxAnnotationSubmit");
    await act(async () => { await Promise.resolve(); });
    return onSubmit.mock.calls.at(-1)?.[2];
  };

  it("disables the pen until the image size is known, then enters annotate mode", () => {
    mount({ annotation: { submitLabel: "Send", onSubmit: vi.fn() } });
    expect(runtime.nodes.get("message.imageLightboxAnnotateButton").disabled).toBe(true);
    press("message.imageLightboxAnnotateButton");
    expect(annotating()).toBe(false);
    load();
    expect(runtime.nodes.get("message.imageLightboxAnnotateButton").disabled).toBe(false);
    press("message.imageLightboxAnnotateButton");
    expect(annotating()).toBe(true);
  });

  it("explains why the pen is unavailable when the host blocks annotation (pending replacement)", () => {
    let reason: string | undefined = "Still uploading";
    mount({ annotation: { submitLabel: "Save", onSubmit: vi.fn(), annotationBlockedReason: () => reason } });
    load();
    const pen = () => runtime.nodes.get("message.imageLightboxAnnotateButton");
    // 置灰但可点:点按说明原因,不进入标注。
    expect(pen().disabled).toBe(false);
    expect(pen().accessibilityLabel).toBe("message.lightbox.annotateImageUnavailable");
    expect(pen().accessibilityHint).toBe("Still uploading");
    press("message.imageLightboxAnnotateButton");
    expect(runtime.alerts).toEqual([["message.lightbox.annotateUnavailableTitle", "Still uploading"]]);
    expect(annotating()).toBe(false);
    // 阻塞解除后(下次渲染)恢复正常。
    reason = undefined;
    act(() => runtime.nodes.get("Image").onLoad({ source: { width: 401, height: 800 } }));
    expect(pen().accessibilityLabel).toBe("message.lightbox.annotateImage");
    press("message.imageLightboxAnnotateButton");
    expect(annotating()).toBe(true);
  });

  it("drops the stray dot left when a second finger starts a pinch, but keeps taps and real strokes", async () => {
    const onSubmit = vi.fn(() => new Promise<void>(() => undefined));
    mount({ annotation: { submitLabel: "Send", onSubmit } });
    load();
    press("message.imageLightboxAnnotateButton");
    // 捏合起手:第一根手指落下开始一笔,第二根手指落下让画笔手势被取消。
    fire(drawGesture(), "onStart", { x: 100, y: 200 });
    fire(drawGesture(), "onUpdate", { x: 104, y: 203 });
    fire(drawGesture(), "onFinalize", {}, false);
    expect(runtime.nodes.get("message.imageLightboxAnnotationUndo").disabled).toBe(true);
    // 单指点按(正常结束)= 圆点,保留。
    fire(drawGesture(), "onStart", { x: 200, y: 400 });
    fire(drawGesture(), "onFinalize", {}, true);
    // 画了一段后第二根手指落下:保留已画的半笔。
    fire(drawGesture(), "onStart", { x: 100, y: 100 });
    fire(drawGesture(), "onUpdate", { x: 140, y: 100 });
    fire(drawGesture(), "onFinalize", {}, false);
    const strokes = await submittedStrokes(onSubmit);
    expect(strokes).toEqual([
      { points: [{ x: 0.5, y: 0.5 }] },
      { points: [{ x: 0.25, y: 0.125 }, { x: 0.35, y: 0.125 }] },
    ]);
  });

  it("ignores drawing before the image size is known", async () => {
    const onSubmit = vi.fn(() => new Promise<void>(() => undefined));
    mount({ annotation: { submitLabel: "Send", onSubmit }, autoAnnotate: true });
    fire(drawGesture(), "onStart", { x: 100, y: 200 });
    fire(drawGesture(), "onFinalize", {}, true);
    expect(await submittedStrokes(onSubmit)).toEqual([]);
  });

  it("samples points by screen distance so zoomed drawing keeps precision", async () => {
    const onSubmit = vi.fn(() => new Promise<void>(() => undefined));
    mount({ annotation: { submitLabel: "Send", onSubmit } });
    load();
    press("message.imageLightboxAnnotateButton");
    fire(drawGesture(), "onStart", { x: 100, y: 200 });
    // 显示矩形 400×800:阈值 = 1.5 / 800(长边),纵向 1px 不记录、2px 记录。
    fire(drawGesture(), "onUpdate", { x: 100, y: 201 });
    fire(drawGesture(), "onUpdate", { x: 100, y: 202 });
    fire(drawGesture(), "onFinalize", {}, true);
    expect(await submittedStrokes(onSubmit)).toEqual([
      { points: [{ x: 0.25, y: 0.25 }, { x: 0.25, y: 0.2525 }] },
    ]);
  });

  it("asks before discarding changed strokes and exits immediately when unchanged", () => {
    mount({ annotation: { submitLabel: "Send", onSubmit: vi.fn() } });
    load();
    press("message.imageLightboxAnnotateButton");
    press("message.imageLightboxAnnotationCancel");
    expect(runtime.alerts).toHaveLength(0);
    expect(annotating()).toBe(false);

    press("message.imageLightboxAnnotateButton");
    fire(drawGesture(), "onStart", { x: 100, y: 200 });
    fire(drawGesture(), "onFinalize", {}, true);
    press("message.imageLightboxAnnotationCancel");
    expect(runtime.alerts).toHaveLength(1);
    const [title, , buttons] = runtime.alerts[0];
    expect(title).toBe("message.lightbox.discardAnnotationTitle");
    expect(buttons.map((b) => b.style)).toEqual(["cancel", "destructive"]);
    act(() => buttons[0].onPress?.()); // 继续标注
    expect(annotating()).toBe(true);
    // Android 返回键走同一确认。
    act(() => runtime.nodes.get("Modal").onRequestClose());
    expect(runtime.alerts).toHaveLength(2);
    act(() => runtime.alerts[1][2][1].onPress?.()); // 放弃
    expect(annotating()).toBe(false);
    // 笔迹已恢复:再次进入标注时没有可撤销的笔迹。
    press("message.imageLightboxAnnotateButton");
    expect(runtime.nodes.get("message.imageLightboxAnnotationUndo").disabled).toBe(true);
  });

  it("does not ask when the only change was undone back to the existing strokes", () => {
    const existing = [{ points: [{ x: 0.1, y: 0.1 }] }];
    mount({ annotation: { submitLabel: "Save", onSubmit: vi.fn(), initialStrokesFor: () => existing } });
    load();
    press("message.imageLightboxAnnotateButton");
    fire(drawGesture(), "onStart", { x: 100, y: 200 });
    fire(drawGesture(), "onFinalize", {}, true);
    press("message.imageLightboxAnnotationUndo");
    press("message.imageLightboxAnnotationCancel");
    expect(runtime.alerts).toHaveLength(0);
    expect(annotating()).toBe(false);
  });

  it("autoAnnotate opens in annotate mode and discarding closes the viewer", () => {
    const { props } = mount({ annotation: { submitLabel: "Send", onSubmit: vi.fn() }, autoAnnotate: true });
    expect(runtime.nodes.has("message.imageLightboxAnnotationCancel")).toBe(true);
    press("message.imageLightboxAnnotationCancel");
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("autoAnnotate confirms before closing when strokes were drawn", () => {
    const { props } = mount({ annotation: { submitLabel: "Send", onSubmit: vi.fn() }, autoAnnotate: true });
    load();
    fire(drawGesture(), "onStart", { x: 100, y: 200 });
    fire(drawGesture(), "onFinalize", {}, true);
    act(() => runtime.nodes.get("message.imageLightbox").onAccessibilityEscape());
    expect(props.onClose).not.toHaveBeenCalled();
    act(() => runtime.alerts[0][2][1].onPress?.());
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("prewarms the host while annotating and releases it on exit", () => {
    const release = vi.fn();
    const prewarm = vi.fn(() => release);
    mount({ annotation: { submitLabel: "Send", onSubmit: vi.fn(), prewarm } });
    load();
    expect(prewarm).not.toHaveBeenCalled();
    press("message.imageLightboxAnnotateButton");
    expect(prewarm).toHaveBeenCalledTimes(1);
    press("message.imageLightboxAnnotationCancel");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("passes the decoded image size with the submission", async () => {
    const onSubmit = vi.fn((..._args: unknown[]) => new Promise<void>(() => undefined));
    mount({ annotation: { submitLabel: "Send", allowDirectSubmit: true, onSubmit } });
    load();
    press("message.imageLightboxSendToChatButton");
    await act(async () => { await Promise.resolve(); });
    expect(onSubmit.mock.calls[0][3]).toMatchObject({ naturalWidth: 400, naturalHeight: 800 });
  });
});

describe("chrome toggle, loading and video pages", () => {
  const singleTap = () =>
    gestures().find((g) => g.kind === "Tap" && g.options.numberOfTaps === 1)!;
  const chrome = () => runtime.nodes.get("message.imageLightboxChrome");
  const chromeOpacity = () => chrome().style[1].current.opacity;

  it("toggles the chrome on single tap instead of closing, at any zoom", () => {
    const { props } = mount();
    fire(singleTap(), "onEnd", {}, true);
    finishAnimations();
    expect(props.onClose).not.toHaveBeenCalled();
    expect(isMounted("message.imageLightboxCloseButton")).toBe(true);
    expect(isMounted("preview.collectionCount")).toBe(false);

    doubleTapAtCorner();
    finishAnimations();
    fire(singleTap(), "onEnd", {}, true);
    finishAnimations();
    expect(props.onClose).not.toHaveBeenCalled();
    expect(isMounted("message.imageLightboxCloseButton")).toBe(true);
    expect(isMounted("preview.collectionCount")).toBe(true);
  });

  it("lets the placeholder zoom and shows a loading bar instead of the tools while the original is loading", async () => {
    const url = "xdt-image://cache/photo.png";
    const image = {
      key: "remote", title: "Photo", url,
      payload: { kind: "media", media: { kind: "image", url, previewable: false } },
    } as ImageLightboxProps["images"][number];
    let finish!: (media: unknown) => void;
    const resolver = vi.fn((media: { thumbnail?: boolean }) =>
      media.thumbnail
      ? Promise.resolve({ url: "file:///thumb.png", previewable: true })
      : new Promise((resolve) => { finish = resolve; }));
    runtime.gesture = null;
    await act(async () => {
      mount({
        images: [image], initialUrl: url, onResolveRemoteMedia: resolver as never, onShareImage: vi.fn(),
        annotation: { submitLabel: "Send", allowDirectSubmit: true, onSubmit: vi.fn() },
      });
    });

    expect(runtime.gesture).not.toBeNull();
    const preview = () => runtime.nodes.get("message.imageLightboxPreviewLayer");
    expect(preview().source.uri).toBe("file:///thumb.png");
    expect(isMounted("message.imageLightboxLoadingBar")).toBe(true);
    expect(
      runtime.nodes.get("message.imageLightboxLoadingBar").accessibilityLabel,
    ).toBe("message.lightbox.loadingOriginal");
    expect(runtime.nodes.get("message.imageLightboxShareButton").disabled).toBe(
      true,
    );
    expect(
      runtime.nodes.get("message.imageLightboxSendToChatButton").disabled,
    ).toBe(true);
    expect(
      runtime.nodes.get("message.imageLightboxAnnotateButton").disabled,
    ).toBe(true);

    act(() => preview().onLoad({ source: { width: 160, height: 90 } }));
    doubleTapAtCorner();
    finishAnimations();
    expect(preview().style[1].current.transform[4].scale).toBe(2.5);

    await act(async () => {
      finish({ url: "file:///full.png", previewable: true, mimeType: "image/png" });
    });
    // 取件完成但原图还在解码:仍是载入提示。
    expect(isMounted("message.imageLightboxLoadingBar")).toBe(true);
    act(() => runtime.nodes.get("Image").onLoad({ source: { width: 1600, height: 900 } }));
    expect(isMounted("message.imageLightboxLoadingBar")).toBe(false);
    expect(runtime.nodes.get("message.imageLightboxShareButton").disabled).toBe(false);
    expect(runtime.nodes.get("message.imageLightboxSendToChatButton").disabled).toBe(false);
    expect(runtime.nodes.get("message.imageLightboxAnnotateButton").disabled).toBe(false);
  });

  it("backs a sent image with its local copy from the first frame when no remote thumbnail is cached", async () => {
    const url = "xdt-image://cache/sent.png";
    const image = {
      key: "sent", title: "Sent", url, previewUri: "file:///sent-local.jpg",
      payload: { kind: "media", media: { kind: "image", url, previewable: false } },
    } as ImageLightboxProps["images"][number];
    // 气泡用的是本地图,从没取过远程缩略图:缓存查询必然落空,原图仍在路上。
    const resolver = vi.fn((media: { thumbnail?: boolean }) =>
      media.thumbnail
      ? Promise.reject(new Error("not cached"))
      : new Promise(() => undefined));
    await act(async () => {
      mount({ images: [image], initialUrl: url, onResolveRemoteMedia: resolver as never });
    });
    expect(runtime.nodes.get("message.imageLightboxPreviewLayer").source.uri).toBe("file:///sent-local.jpg");
    expect(runtime.nodes.has("message.imageLightboxRetryButton")).toBe(false);
  });

  // #6517, unit: mount the real viewer with a decoded preview, then reject the original.
  // Existing coverage checked paging reset, allowing the visible image to be discarded.
  // Also cover loss of the last readable layer and native decode/refresh failure at the same URI.
  // Single-file validation: 117 tests, 3.39s (vitest run imageLightboxInteraction.test.tsx --maxWorkers=1).
  it("keeps the zoomed preview through original failures and retries until the original paints", async () => {
    const url = "xdt-image://cache/broken.png";
    const image = {
      key: "broken", title: "Broken", url,
      payload: { kind: "media", media: { kind: "image", url, previewable: false } },
    } as ImageLightboxProps["images"][number];
    const failures = new Map<string, (error: Error) => void>();
    let finish!: (media: unknown) => void;
    const resolver = vi.fn((media: { url: string; thumbnail?: boolean }) =>
      media.thumbnail
      ? Promise.resolve({ url: "file:///thumb.png", previewable: true })
      : new Promise((resolve, reject) => { finish = resolve; failures.set(media.url, reject); }));
    const fail = (error: Error) => failures.get(url)!(error);
    await act(async () => {
      const nextUrl = "xdt-image://cache/next.png";
      const next = {
        key: "next", title: "Next", url: nextUrl,
        payload: { kind: "media", media: { kind: "image", url: nextUrl, previewable: false } },
      } as ImageLightboxProps["images"][number];
      mount({ images: [image, next], initialUrl: url, onResolveRemoteMedia: resolver as never,
        onShareImage: vi.fn(), annotation: { submitLabel: 'Send', allowDirectSubmit: true, onSubmit: vi.fn() } });
    });
    act(() => runtime.nodes.get("message.imageLightboxPreviewLayer").onLoad({ source: { width: 160, height: 90 } }));
    doubleTapAtCorner();
    finishAnimations();
    expect(runtime.nodes.get("FlatList").scrollEnabled).toBe(false);

    await act(async () => { fail(Object.assign(new Error('offline'), { code: 'NOT_CONNECTED' })); });
    const preview = () => runtime.nodes.get('message.imageLightboxPreviewLayer');
    expect(isMounted('message.imageLightboxPreviewLayer')).toBe(true);
    expect(preview().source.uri).toBe('file:///thumb.png');
    expect(preview().style[1].current.transform[4].scale).toBe(2.5);
    expect(container.textContent).toContain('message.lightbox.originalUnavailable');
    expect(container.textContent).toContain('message.lightbox.deviceOffline');
    expect(runtime.nodes.has("message.imageLightboxRetryButton")).toBe(true);
    expect(runtime.nodes.get("FlatList").scrollEnabled).toBe(false);
    // 失败不算载入:不留永远转圈的提示,按钮置灰、由页内重试接手。
    expect(isMounted('message.imageLightboxLoadingBar')).toBe(false);
    expect(runtime.nodes.get('message.imageLightboxShareButton').disabled).toBe(true);
    expect(runtime.nodes.get('message.imageLightboxSendToChatButton').disabled).toBe(true);

    fire(singleTap(), 'onEnd', {}, true);
    finishAnimations();
    expect(isMounted('message.imageLightboxOriginalNotice')).toBe(false);
    fire(singleTap(), 'onEnd', {}, true);
    finishAnimations();
    press('message.imageLightboxRetryButton');
    const callsWhileLoading = resolver.mock.calls.length;
    press('message.imageLightboxRetryButton');
    expect(resolver.mock.calls).toHaveLength(callsWhileLoading);
    expect(runtime.nodes.get('message.imageLightboxRetryButton').disabled).toBe(true);
    expect(preview().style[1].current.transform[4].scale).toBe(2.5);
    expect(resolver).toHaveBeenLastCalledWith(expect.objectContaining({ url }), { front: true, forceRefresh: true });
    await act(async () => { fail(new Error('still offline')); });
    expect(preview().source.uri).toBe('file:///thumb.png');
    expect(runtime.nodes.get('message.imageLightboxRetryButton').disabled).toBe(false);
    press('message.imageLightboxRetryButton');
    await act(async () => { finish({ url: 'file:///full.png', previewable: true, mimeType: 'image/png' }); });
    expect(preview()).toBeDefined();
    expect(runtime.nodes.get('message.imageLightboxRetryButton').disabled).toBe(true);
    expect(isMounted('message.imageLightboxLoadingBar')).toBe(true);
    act(() => runtime.nodes.get('Image').onLoad({ source: { width: 1600, height: 900 } }));
    expect(isMounted('message.imageLightboxPreviewLayer')).toBe(false);
    expect(isMounted('message.imageLightboxOriginalNotice')).toBe(false);
    expect(runtime.nodes.get('Image').style[1].current.transform[4].scale).toBe(2.5);
    expect(runtime.nodes.get('message.imageLightboxShareButton').disabled).toBe(false);
    expect(runtime.nodes.get('message.imageLightboxAnnotateButton').disabled).toBe(false);
  });

  it('shows a terminal error when both the original request and its preview fail', async () => {
    const url = 'xdt-image://cache/missing.png';
    let fail!: (error: Error) => void;
    const resolver = vi.fn((media: { thumbnail?: boolean }) => media.thumbnail
      ? Promise.resolve({ url: 'file:///thumb.png', previewable: true })
      : new Promise((_resolve, reject) => { fail = reject; }));
    await act(async () => { mount({ images: [{ key: 'missing', url,
      payload: { kind: 'media', media: { kind: 'image', url, previewable: false } } } as never],
      initialUrl: url, onResolveRemoteMedia: resolver as never }); });
    await act(async () => { fail(new Error('offline')); });
    act(() => runtime.nodes.get('message.imageLightboxPreviewLayer').onError());
    expect(isMounted('message.imageLightboxPreviewLayer')).toBe(false);
    expect(isMounted('message.imageLightboxLoading')).toBe(false);
    expect(isMounted('message.imageLightboxOriginalNotice')).toBe(false);
    expect(runtime.nodes.has('message.imageLightboxRetryButton')).toBe(true);
    expect(runtime.nodes.get('FlatList').scrollEnabled).toBe(true);
  });

  it('retains the preview after native decode and refresh fail, and can reload the same repaired path', async () => {
    const url = 'xdt-image://cache/repair.png';
    const full = { url: 'file:///full.png', previewable: true, mimeType: 'image/png' };
    let fail!: (error: Error) => void;
    const resolver = vi.fn((media: { thumbnail?: boolean }) => media.thumbnail
      ? Promise.resolve({ url: 'file:///thumb.png', previewable: true })
      : Promise.resolve(full));
    await act(async () => { mount({ images: [{ key: 'repair', url,
      payload: { kind: 'media', media: { kind: 'image', url, previewable: false } } } as never],
      initialUrl: url, onResolveRemoteMedia: resolver as never, onShareImage: vi.fn() }); });
    act(() => runtime.nodes.get('Image').onLoad({ source: { width: 1600, height: 900 } }));
    expect(isMounted('message.imageLightboxPreviewLayer')).toBe(false);
    resolver.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
    await act(async () => { runtime.nodes.get('Image').onError(); });
    await act(async () => { fail(new Error('offline')); });
    expect(isMounted('message.imageLightboxPreviewLayer')).toBe(true);
    expect(isMounted('message.imageLightboxOriginalNotice')).toBe(true);
    expect(container.querySelector('[data-native-name="Image"]:not([data-testid])')).toBeNull();
    expect(runtime.nodes.get('message.imageLightboxShareButton').disabled).toBe(true);

    resolver.mockResolvedValue({ ...full });
    await act(async () => { press('message.imageLightboxRetryButton'); });
    expect(container.querySelector('[data-native-name="Image"]:not([data-testid])')).not.toBeNull();
    act(() => runtime.nodes.get('Image').onLoad({ source: { width: 1600, height: 900 } }));
    expect(isMounted('message.imageLightboxPreviewLayer')).toBe(false);
    expect(isMounted('message.imageLightboxOriginalNotice')).toBe(false);
    expect(runtime.nodes.get('message.imageLightboxShareButton').disabled).toBe(false);
  });

  it("plays video pages with the native player, falls back to the web player and releases on close", async () => {
    const url = "xdt-video://cache/clip.mp4";
    const video = {
      key: "video", title: "clip.mp4", url,
      payload: { kind: "media", media: { kind: "video", url, previewable: false } },
    } as ImageLightboxProps["images"][number];
    const resolved = { url: "https://cdn.invalid/clip.mp4", previewable: true, mimeType: "video/mp4" };
    const resolver = vi.fn(async (media: { thumbnail?: boolean }) => {
      if (media.thumbnail) throw new Error("no thumb");
      return resolved;
    });
    const onReleaseRemoteMedia = vi.fn();
    const onShareImage = vi.fn();
    await act(async () => {
      mount({
        images: [video], initialUrl: url, onResolveRemoteMedia: resolver as never,
        onReleaseRemoteMedia, onShareImage,
      });
    });
    const player = runtime.nodes.get("message.imageLightboxVideoPlayer");
    expect(runtime.nodes.get('message.videoDownload')).toMatchObject({ source: resolved.url, mimeType: 'video/mp4',
    });
    // The common footer is outside the media viewport; native playback retains its own controls.
    expect(runtime.nodes.get('message.imageLightboxVideoPage').style.height,
    ).toBe(runtime.dimensions.height);
    expect(player.url).toBe(resolved.url);
    expect(player.visible).toBe(true);
    expect(runtime.nodes.has("message.imageLightboxShareButton")).toBe(false);
    expect(runtime.nodes.get("message.imageLightboxCloseButton")).toBeTruthy();

    act(() => player.onError("decode failed"));
    const web = runtime.nodes.get("message.imageLightboxVideoWebPlayer");
    expect(web.url).toBe(resolved.url);

    // WebView 兜底也播不了:落失败态给重试,重试经 forceRefresh 重新取件后回到原生播放器。
    runtime.nodes.delete("message.imageLightboxVideoPlayer");
    act(() => web.onStatusChange({ type: "xdt-media-player/status", state: "error", error: "decode" }));
    expect(runtime.nodes.has("message.imageLightboxRetryButton")).toBe(true);
    await act(async () => press("message.imageLightboxRetryButton"));
    expect(resolver).toHaveBeenLastCalledWith(
      expect.objectContaining({ url }),
      expect.objectContaining({ forceRefresh: true }),
    );
    expect(runtime.nodes.get("message.imageLightboxVideoPlayer").url).toBe(resolved.url);

    act(() => root.unmount());
    expect(onReleaseRemoteMedia).toHaveBeenCalledWith(url, resolved);
    root = createRoot(document.createElement("div"));
  });
});
