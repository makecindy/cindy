import { useCallback, useMemo, useRef, useState, type Ref } from 'react';
import { Platform, type ScrollView, type ScrollViewProps, type View } from 'react-native';
import Animated, { measure, runOnJS, useAnimatedReaction, useAnimatedRef, useSharedValue, type AnimatedRef, type SharedValue } from 'react-native-reanimated';
import { Gesture, GestureDetector } from '@/platform/gestureHandler';

/**
 * 「从聊天记录拖进输入框」：手指在聊天记录里拖动时照常滚动；同一次拖动里手指往下
 * 越过展开输入框的顶边后，这次拖动交给输入框，等同于按住顶边往下拖。
 *
 * 列表与输入框分属不同组件，只经这座桥交换 UI 线程状态：
 * - 输入框写 armed（展开卡片态才可接手）并把顶边热区挂到 grabberRef；
 * - 列表侧追踪手指，接手后持续写 event，输入框用 useAnimatedReaction 驱动同一套调高逻辑。
 * event 每次都带完整位置（而非 begin / move / end 增量），同一帧内被合并也不会丢步。
 */
export interface ComposerPullEvent {
  /** 本次接手的编号；0 表示还没有发生过接手。 */
  id: number;
  /** 手指仍按着。false 即本次接手结束。 */
  active: boolean;
  /** 接手时输入框顶边的屏幕 y：调高位移从这里起算。 */
  startY: number;
  /** 手指当前屏幕 y。 */
  y: number;
  /** 正常抬手为 true；被系统取消为 false（恢复原高度）。 */
  successful: boolean;
}

export interface ComposerPullThroughBridge {
  armed: SharedValue<boolean>;
  event: SharedValue<ComposerPullEvent>;
  grabberRef: AnimatedRef<View>;
}

export function useComposerPullThroughBridge(): ComposerPullThroughBridge {
  const armed = useSharedValue(false);
  const event = useSharedValue<ComposerPullEvent>({ id: 0, active: false, startY: 0, y: 0, successful: false });
  const grabberRef = useAnimatedRef<View>();
  return useMemo(() => ({ armed, event, grabberRef }), [armed, event, grabberRef]);
}

/** 手指往下移动并到达（或越过）输入框顶边时接手。 */
export function shouldHandOffToComposer(input: { y: number; previousY: number; composerTop: number }): boolean {
  'worklet';
  return input.y > input.previousY && input.y >= input.composerTop;
}

/**
 * 接手后的调高位移：只认往下。手指推回去时输入框最多恢复到接手前的高度，
 * 不会被这次拖动撑得比原来更大。
 */
export function composerPullTranslation(input: { y: number; startY: number }): number {
  'worklet';
  return Math.max(0, input.y - input.startY);
}

/**
 * 手势是否应挂在列表上。RNGH 编排器一旦接管列表触摸流，Android 上正文 selectable
 * 文本一拖就进选区、列表不滚（2026-10-16 模拟器 A/B 实测）。因此 Android 只在
 * 真正可能接手时挂手势；iOS 触摸管线没有这个问题，保持常挂（#5946 行为不变）。
 */
export function resolvePullThroughAttach(input: { android: boolean; armed: boolean; busy: boolean }): boolean {
  'worklet';
  return !input.android || input.armed || input.busy;
}

const PHASE_IDLE = 0;
const PHASE_TRACKING = 1;
const PHASE_HANDED_OFF = 2;

type PullThroughScrollViewProps = ScrollViewProps & {
  bridge: ComposerPullThroughBridge;
  ref?: Ref<ScrollView>;
};

/**
 * 聊天记录列表的滚动容器（LegendList renderScrollComponent）。
 *
 * 原生滚动照常进行：Manual 追踪手势永不激活，只读触摸位置；接手时把列表滚动关掉
 * （输入框接管这次拖动，两边不同时动）；抬手后恢复。追踪不依赖 Native 手势存活——
 * 关掉滚动会让原生滚动手势取消。
 *
 * 但 RNGH 编排器接管触摸流本身有代价：Android 上正文 selectable 文本一拖就进选区、
 * 列表不滚（2026-10-16 模拟器 A/B 实测，详见 PR）。所以手势只在接手窗口内启用：
 * Android 限展开卡片态（armed）或接手进行中（busy——armed 会在拖动收起输入框时翻
 * false，半途摘手势会让 frozen 滚动没机会被 end() 恢复）；iOS 无此问题，保持常挂。
 * shortcut: armed 态下拖列表仍会触发 Android 选中问题，待 RNGH/上游修复后撤掉这层门；
 * 另外编排器只在起手（ACTION_DOWN）时认领手势，拖动中途 armed 才变 true 的那次拖动不会接手。
 */
export function ComposerPullThroughScrollView({ bridge, ref, ...props }: PullThroughScrollViewProps) {
  const scrollRef = useRef<ScrollView | null>(null);
  const scrollEnabledRef = useRef(props.scrollEnabled !== false);
  scrollEnabledRef.current = props.scrollEnabled !== false;
  const setRef = useCallback((node: ScrollView | null) => {
    scrollRef.current = node;
    if (typeof ref === 'function') ref(node);
    else if (ref) (ref as { current: ScrollView | null }).current = node;
  }, [ref]);
  const setFrozen = useCallback((frozen: boolean) => {
    scrollRef.current?.setNativeProps({ scrollEnabled: frozen ? false : scrollEnabledRef.current });
  }, []);

  const phase = useSharedValue(PHASE_IDLE);
  const previousY = useSharedValue(0);
  const composerTop = useSharedValue(0);
  const android = Platform.OS === 'android';
  // bridge.armed（展开卡片态）与 event.active（接手进行中）是 UI 线程真相；镜像成
  // 「手势是否启用」的 JS 态。reaction 的输入在接手期间每帧都被写，react 里必须用
  // previous 挡掉同值，否则每帧都跨线程回 JS。runOnJS(setAttach) 必须内联调用：
  // 它的返回值若存进变量再被 worklet 捕获，会序列化成不可直接调用的 RemoteFunction
  // 代理，UI 线程一调就报 Tried to synchronously call a Remote Function。
  // Read the initial snapshot once. Eager arguments read UI-thread values on
  // every render, blocking React during keyboard motion and flooding LogBox.
  const [attach, setAttach] = useState(() =>
    resolvePullThroughAttach({ android, armed: bridge.armed.value === true, busy: bridge.event.value.active === true }),
  );
  useAnimatedReaction(
    () => ({ armed: bridge.armed.value === true, busy: bridge.event.value.active === true }),
    (next, previous) => {
      if (previous && next.armed === previous.armed && next.busy === previous.busy) return;
      runOnJS(setAttach)(resolvePullThroughAttach({ android, armed: next.armed, busy: next.busy }));
    },
    [bridge, android],
  );
  const gesture = useMemo(() => {
    const { armed, event, grabberRef } = bridge;
    const end = (y: number, successful: boolean) => {
      'worklet';
      if (phase.value === PHASE_HANDED_OFF) {
        const current = event.value;
        event.value = { id: current.id, active: false, startY: current.startY, y: Number.isFinite(y) ? y : current.y, successful };
        runOnJS(setFrozen)(false);
      }
      phase.value = PHASE_IDLE;
    };
    // A manual-activation Pan still installs a UIPanGestureRecognizer. iOS's
    // interactive-pop recognizer waits for that pending pan, so even an unarmed
    // composer blocks edge-back. Manual observes touches without a competing pan.
    const tracker = Gesture.Manual()
      .enabled(attach)
      .onTouchesDown((touches, manager) => {
        'worklet';
        phase.value = PHASE_IDLE;
        // A passive Manual recognizer must still leave BEGAN. Keeping it pending
        // makes AVPlayer's native play/seek controls wait indefinitely on iOS.
        if (touches.numberOfTouches !== 1 || !armed.value) {
          manager.fail();
          return;
        }
        const frame = measure(grabberRef);
        const y = touches.allTouches[0]?.absoluteY;
        // 只从输入框上方的聊天记录起手；按在输入框上的触摸本就归输入框。
        if (!frame || y === undefined || y >= frame.pageY) {
          manager.fail();
          return;
        }
        composerTop.value = frame.pageY;
        previousY.value = y;
        phase.value = PHASE_TRACKING;
      })
      .onTouchesMove((touches) => {
        'worklet';
        if (phase.value === PHASE_IDLE) return;
        const y = touches.allTouches[0]?.absoluteY;
        if (touches.numberOfTouches !== 1 || y === undefined) {
          end(NaN, false);
          return;
        }
        if (phase.value === PHASE_TRACKING) {
          if (armed.value && shouldHandOffToComposer({ y, previousY: previousY.value, composerTop: composerTop.value })) {
            phase.value = PHASE_HANDED_OFF;
            event.value = { id: event.value.id + 1, active: true, startY: composerTop.value, y, successful: false };
            runOnJS(setFrozen)(true);
          }
          previousY.value = y;
          return;
        }
        const current = event.value;
        event.value = { id: current.id, active: true, startY: current.startY, y, successful: false };
      })
      .onTouchesUp((touches, manager) => {
        'worklet';
        end(touches.changedTouches[0]?.absoluteY ?? NaN, true);
        manager.fail();
      })
      .onTouchesCancelled(() => {
        'worklet';
        end(NaN, false);
      })
      .onFinalize(() => {
        'worklet';
        // 被其它手势挤掉时不会再收到抬手：按取消收尾，输入框回到原高度。
        end(NaN, false);
      });
    return Gesture.Simultaneous(Gesture.Native().enabled(attach), tracker);
  }, [attach, android, bridge, composerTop, phase, previousY, setFrozen]);

  return (
    <GestureDetector gesture={gesture}>
      <Animated.ScrollView {...props} ref={setRef} />
    </GestureDetector>
  );
}
