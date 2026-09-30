// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAttachmentPayload } from '@/session/messagePayload';
import { svgAttachmentForDisplay } from '@/session/messageAttachments';
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
type Animation = { target: number; done?: (finished: boolean) => void };
type Value = { value: number; animation?: Animation };
const runtime = vi.hoisted(() => ({
  nodes: new Map<string, any>(),
  values: [] as Value[],
  immediate: false,
  dimensions: { width: 400, height: 800 },
  insets: { top: 40, bottom: 20, left: 0, right: 0 },
  gesture: null as GestureNode | null,
  alerts: [] as Array<[string, string, Array<{ text: string; style?: string; onPress?: () => void }>]>,
}));

vi.mock("expo-router", () => ({
  useNavigation: () => ({ setOptions: () => undefined }),
}));
vi.mock("react-i18next", async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/session/remoteMedia", () => ({
  isDesktopLocalMediaUrl: (uri: string) => uri.startsWith("cindy-media:"),
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
}));
vi.mock("react-native-svg", () => ({ default: () => null, Path: () => null }));
vi.mock("@/theme", async () => await import("@/theme/tokens"));
vi.mock("react-native", async () => {
  const { createElement, useImperativeHandle } = await import("react");
  const view = (name: string) => (props: any) => {
    runtime.nodes.set(props.testID ?? name, props);
    return createElement("div", null, props.children as ReactNode);
  };
  return {
    View: view("View"),
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
    useWindowDimensions: () => runtime.dimensions,
    FlatList: (props: any) => {
      runtime.nodes.set("FlatList", props);
      useImperativeHandle(
        props.ref,
        () => ({ scrollToOffset: () => undefined }),
        [],
      );
      return props.renderItem({ item: props.data[0], index: 0 });
    },
  };
});
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
  };
});

let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  runtime.nodes.clear();
  runtime.values = [];
  runtime.immediate = false;
  runtime.dimensions = { width: 400, height: 800 };
  runtime.insets = { top: 40, bottom: 20, left: 0, right: 0 };
  runtime.alerts = [];
  root = createRoot(document.createElement("div"));
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
  const render = () => act(() => root.render(<ImageLightbox {...props} />));
  render();
  return { props, render };
}

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
    const chromeBounds = () => Object.assign({}, ...runtime.nodes.get('message.imageLightboxChrome').style);
    const closeBounds = Object.assign({}, ...runtime.nodes.get('message.imageLightboxCloseButton').style);
    expect(chromeBounds().left + closeBounds.left).toBe(75);
    expect(chromeBounds().right).toBe(0);
    expect(transform().x).toBeCloseTo(0);
    expect(transform().y).toBe(-300);
    expect(transform().scale).toBe(2.5);
    doubleTapAtCorner(); finishAnimations();
    expect(transform()).toEqual({ x: 0, y: 0, scale: 1 });
    runtime.insets = { top: 0, bottom: 20, left: 0, right: 59 };
    harness.props.onClose = vi.fn();
    harness.render();
    expect(chromeBounds().left).toBe(0);
    expect(chromeBounds().right).toBe(59);
  });

  it('includes the visible unfinished stroke and ignores drawing delivered after submit', async () => {
    let complete!: () => void;
    const onSubmit = vi.fn(() => new Promise<void>((resolve) => { complete = resolve; }));
    mount({ annotation: { submitLabel: 'Send', onSubmit } });
    act(() => runtime.nodes.get('Image').onLoad({ source: { width: 400, height: 800 } }));
    press('message.imageLightboxAnnotateButton');
    const draw = gestures().find(g => g.kind === 'Pan' && g.options.minDistance === 0)!;
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
    const draw = () => gestures().find(g => g.kind === 'Pan' && g.options.minDistance === 0)!;
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
