import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { StyleSheet, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import Reanimated, { Easing, withTiming, type LayoutAnimationsValues } from 'react-native-reanimated';

import { getCachedReduceMotionEnabled } from '@/hooks/useReduceMotion';
import { listDisclosureMotion } from '@/theme/tokens';
import {
  commitRegisteredLevel,
  createDisclosureController,
  detachDisclosureScope,
  openDisclosureWindow,
  runDisclosure,
  type DisclosureController,
  type DisclosureLevel,
} from './listDisclosureController';

/**
 * 列表分组展开 / 收起的过渡(DESIGN.md §14.4 移动端列表节奏)。
 *
 * 不能用 RN 的 LayoutAnimation:Reanimated 在每个 Fabric surface 上接管了挂载层的
 * override delegate,LayoutAnimation.configureNext 在本 App 里是静默 no-op(实录
 * 验证:分组在一帧内跳变)。这里改用 Reanimated 自己的布局动画:
 *  - 列表每一行(SectionList 的 cell 与分组块内的行)的位置与高度按
 *    listDisclosureMotion 缓出变化;cell 裁剪内容,分组像 iOS 一样从标题下拉开;
 *  - 新行不做入场动画,直接落在最终位置,由变高的块逐步露出;
 *  - 收起时被移除的内容块带 exiting,保持可见直到被合上 / 被下方上移的行盖住,临近
 *    结束才淡掉。
 *
 * 布局动画只在过渡窗口内挂上:常驻会接管页面初始化、滚动位置恢复、虚拟化补渲染等
 * 无关的布局变化(实测滚动恢复后置顶行被画在旧位置)。起动延迟的处理(实测数据见
 * 2026-09-30 设计决策记录):
 *  - 开关状态放在只包住列表的 ListDisclosureScope 里,打开时只重渲染挂动画的行,
 *    不重渲染整个页面;行登记好动画后在同一次提交里执行展开 / 收起,不额外等一帧;
 *  - 分组块内部的逐行包裹(nested)只在展开 / 收起嵌在项目里的自动化组时才挂动画,
 *    平时的分组切换只登记 cell 与分组块;
 *  - 标题在手指按下时就调用 prepare 提前打开开关,松手时动画已登记好,直接执行。
 */
const DURATION = listDisclosureMotion.duration;
const moveEasing = Easing.out(Easing.quad);
const fadeEasing = Easing.in(Easing.cubic);

// 常量 worklet(而非每次 build 的 builder):登记时序列化结果可复用,开关时成本低。
function disclosureLayout(values: LayoutAnimationsValues) {
  'worklet';
  const config = { duration: DURATION, easing: moveEasing };
  return {
    initialValues: {
      originX: values.currentOriginX,
      originY: values.currentOriginY,
      width: values.currentWidth,
      height: values.currentHeight,
    },
    animations: {
      originX: withTiming(values.targetOriginX, config),
      originY: withTiming(values.targetOriginY, config),
      width: withTiming(values.targetWidth, config),
      height: withTiming(values.targetHeight, config),
    },
  };
}

function disclosureExit() {
  'worklet';
  return {
    initialValues: { opacity: 1 },
    animations: { opacity: withTiming(0, { duration: DURATION, easing: fadeEasing }) },
  };
}

const DisclosureLevelContext = createContext<DisclosureLevel>(0);
const DisclosurePrepareContext = createContext<(nested?: boolean) => void>(() => {});

/** 系统「减弱动态效果」的约定:只有明确为 false 才播放(偏好未查到的 null 也不播)。 */
const motionAllowed = () => getCachedReduceMotionEnabled() === false;

/**
 * 页面持有的控制器。run(apply):请求列表挂上布局动画,行登记完成后(同一次提交的
 * layout effect 里)立刻执行 apply;窗口在动画结束后自动收回。系统「减弱动态效果」
 * 开启、或列表不在屏上时直接执行。窗口逻辑见 listDisclosureController.ts。
 */
export function useListDisclosureTransition({
  motionEnabled = true,
}: { motionEnabled?: boolean } = {}) {
  const controller = useRef<DisclosureController>(createDisclosureController()).current;
  /** nested:要切换的分组嵌在另一个分组块里(项目里的自动化组),块内的行也要让位。 */
  const run = useCallback((apply: () => void, options?: { nested?: boolean }) => {
    runDisclosure(controller, apply, options?.nested ? 2 : 1, motionEnabled && motionAllowed());
  }, [controller, motionEnabled]);
  /** 分组标题的 onPressIn:手指按下即提前挂上动画,松手时直接执行。 */
  const prepare = useCallback(() => {
    openDisclosureWindow(controller, 1, motionEnabled && motionAllowed());
  }, [controller, motionEnabled]);
  useEffect(() => () => {
    if (controller.timer) clearTimeout(controller.timer);
  }, [controller]);
  return { controller, prepare, run };
}

/** 包住列表:持有开关状态,开关变化只重渲染挂动画的行。 */
export function ListDisclosureScope({
  children,
  controller,
  motionEnabled = true,
}: {
  children: ReactNode;
  controller: DisclosureController;
  motionEnabled?: boolean;
}) {
  const [level, setLevel] = useState<DisclosureLevel>(0);
  useLayoutEffect(() => {
    controller.setLevel = setLevel;
    return () => detachDisclosureScope(controller);
  }, [controller]);
  // 子行的 componentDidUpdate(登记布局动画)先于这里执行,此时再改折叠状态。
  useLayoutEffect(() => {
    commitRegisteredLevel(controller, level);
  }, [level, controller]);
  const prepare = useCallback((nested?: boolean) => {
    openDisclosureWindow(controller, nested ? 2 : 1, motionEnabled && motionAllowed());
  }, [controller, motionEnabled]);
  return (
    <DisclosurePrepareContext.Provider value={prepare}>
      <DisclosureLevelContext.Provider value={level}>{children}</DisclosureLevelContext.Provider>
    </DisclosurePrepareContext.Provider>
  );
}

/** 分组标题的 onPressIn:手指按下即提前挂上动画。nested 同 run 的选项。 */
export function useDisclosurePrepare() {
  return useContext(DisclosurePrepareContext);
}

/**
 * SectionList / FlatList 的 CellRendererComponent:过渡窗口内位置与高度连续变化并裁剪内容
 * (裁剪只在窗口内生效,平时不改变 cell 的溢出行为);
 * 被移除的行(收起置顶组、归档、置顶移位)保持可见,被下方上移的行盖住后淡掉。
 */
export function createDisclosureListCell() {
  return function DisclosureListCell({
    children,
    onFocusCapture,
    onLayout,
    style,
  }: {
    children?: ReactNode;
    onFocusCapture?: ((event: FocusEvent) => void) | undefined;
    onLayout?: ((event: LayoutChangeEvent) => void) | undefined;
    style?: StyleProp<ViewStyle>;
  }) {
    const active = useContext(DisclosureLevelContext) > 0;
    // VirtualizedList 靠 onFocusCapture 追踪焦点所在的 cell;Reanimated.View 的类型没声明它,
    // 但会原样透传给原生 View。
    const focusProps = { onFocusCapture } as Record<string, unknown>;
    return (
      <Reanimated.View
        {...focusProps}
        exiting={active ? disclosureExit : undefined}
        layout={active ? disclosureLayout : undefined}
        onLayout={onLayout}
        style={active ? [style, styles.clip] : style}
      >
        {children}
      </Reanimated.View>
    );
  };
}

/**
 * 分组块内部的行 / 可收起的内容块:过渡窗口内随布局平滑移动;clip 时裁剪自身内容
 * (嵌套的自动化组在项目块里展开);exit 的块在收起被移除时保持可见、最后淡出。
 * nested 的包裹(分组块内的逐行)只在嵌套分组切换时挂动画。
 */
export function DisclosureItem({
  children,
  clip = false,
  exit = false,
  nested = false,
  style,
  testID,
}: {
  children?: ReactNode;
  clip?: boolean;
  exit?: boolean;
  nested?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const active = useContext(DisclosureLevelContext) >= (nested ? 2 : 1);
  return (
    <Reanimated.View
      exiting={active && exit ? disclosureExit : undefined}
      layout={active ? disclosureLayout : undefined}
      style={active && clip ? [style, styles.clip] : style}
      testID={testID}
    >
      {children}
    </Reanimated.View>
  );
}

/**
 * 分组块自身(项目组):高度与底边随过渡变化。单独做成组件,开关变化只重渲染这一层,
 * 不重渲染整个分组组件。
 */
export function DisclosureGroupView(props: ComponentProps<typeof Reanimated.View>) {
  const active = useContext(DisclosureLevelContext) > 0;
  return <Reanimated.View {...props} layout={active ? disclosureLayout : undefined} />;
}

const styles = StyleSheet.create({
  clip: { overflow: 'hidden' },
});
