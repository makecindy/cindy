import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * iOS 左滑「选项」Sheet 的关闭时序(回归锚点)。
 *
 * 删除 / 重命名的后续弹窗都挂在 onClosed 上等 Sheet 真正卸载后再 present
 * (useSessionListActions 的 pendingSheetActionRef)。通用 `@expo/ui` BottomSheet 的
 * onDismiss 只由原生 onIsPresentedChange 派生,而原生只在**用户**下拉 / 点背板时派发它
 * (BottomSheetView.swift 的防回环 guard:props.isPresented == newIsPresented 就 return);
 * 点菜单项后由 JS 把 isPresented 置 false 属于程序化关闭,不会回调,存好的删除确认
 * 永远不弹 —— 用户看到「删除按钮没反应」。
 *
 * 因此 iOS 必须用 swift-ui BottomSheet,它把两个信号分开暴露:
 *   - onIsPresentedChange(false) = 用户主动关闭   → onClose
 *   - onDismiss(SwiftUI .sheet(onDismiss:)) = 已完全消失(两种关闭都触发) → onClosed
 *
 * 本测试直接调用组件函数、断言真实传给 BottomSheet 的 props 与回调行为
 * (不做源码文本匹配,等价重构不会误报)。mobile 无 react renderer 依赖,
 * 这里手动展开函数组件即可 —— 组件是纯函数,只用到被 mock 的 useTheme。
 */

const platform = vi.hoisted(() => ({ os: 'ios' }));

// 原生视图在 node 下 requireNativeView 会抛,全部替换成可识别的标记。
// 通用封装与 swift-ui 用不同标记,才能断言「没退回通用 BottomSheet」。
vi.mock('react-native', () => ({
  Platform: { get OS() { return platform.os; } },
}));
vi.mock('@expo/ui', () => ({
  BottomSheet: 'UniversalBottomSheet',
  Column: 'Column',
  Host: 'Host',
  List: 'List',
  ListItem: 'ListItem',
  Text: 'Text',
}));
vi.mock('@expo/ui/swift-ui', () => ({
  BottomSheet: 'SwiftUIBottomSheet',
  Group: 'Group',
}));
vi.mock('@expo/ui/swift-ui/modifiers', () => ({
  frame: (params: unknown) => ({ modifier: 'frame', params }),
  padding: (params: unknown) => ({ modifier: 'padding', params }),
  presentationDragIndicator: (visibility: unknown) => ({
    modifier: 'presentationDragIndicator',
    visibility,
  }),
}));
vi.mock('@/session/SessionActionSheet', () => ({
  SessionActionSheet: 'SessionActionSheet',
}));
vi.mock('@/theme', () => ({
  useTheme: () => ({ colors: { destructive: '#ff0000' } }),
}));

import { SessionOptionsPresenter } from '@/session/SessionOptionsExpoSheet';
import type { SessionSwipeAction } from '@/session/swipeRowRegistry';

interface Element {
  type: unknown;
  props: Record<string, unknown> & { children?: unknown };
}

/** 手动展开函数组件(组件是纯函数,useTheme 已 mock),得到宿主元素树。 */
function renderTree(element: unknown): unknown {
  let current = element;
  while (isElement(current) && typeof current.type === 'function') {
    current = (current.type as (p: unknown) => unknown)(current.props);
  }
  return current;
}

function isElement(value: unknown): value is Element {
  return typeof value === 'object' && value !== null && 'type' in value && 'props' in value;
}

/** 深度优先找第一个 type 命中的元素(children 可能是数组 / 嵌套数组)。 */
function findByType(node: unknown, type: string): Element | null {
  const expanded = renderTree(node);
  if (Array.isArray(expanded)) {
    for (const child of expanded) {
      const hit = findByType(child, type);
      if (hit) return hit;
    }
    return null;
  }
  if (!isElement(expanded)) return null;
  if (expanded.type === type) return expanded;
  return findByType(expanded.props.children, type);
}

function collectByType(node: unknown, type: string, out: Element[] = []): Element[] {
  const expanded = renderTree(node);
  if (Array.isArray(expanded)) {
    for (const child of expanded) collectByType(child, type, out);
    return out;
  }
  if (!isElement(expanded)) return out;
  if (expanded.type === type) out.push(expanded);
  collectByType(expanded.props.children, type, out);
  return out;
}

function makeProps(overrides: Record<string, unknown> = {}) {
  return {
    onAction: vi.fn(),
    onClose: vi.fn(),
    onClosed: vi.fn(),
    pinnedAt: null,
    status: 'active',
    visible: true,
    ...overrides,
  };
}

function renderSheet(overrides: Record<string, unknown> = {}) {
  const props = makeProps(overrides);
  const tree = SessionOptionsPresenter(props as never);
  return { props, tree };
}

beforeEach(() => {
  platform.os = 'ios';
});

describe('SessionOptionsExpoSheet 关闭生命周期', () => {
  it('用 swift-ui BottomSheet,而不是回调语义不同的通用 @expo/ui 封装', () => {
    const { tree } = renderSheet();
    expect(findByType(tree, 'SwiftUIBottomSheet')).not.toBeNull();
    expect(findByType(tree, 'UniversalBottomSheet')).toBeNull();
  });

  it('onDismiss(已完全消失)只触发 onClosed —— 延迟的删除确认据此才能弹出', () => {
    const { props, tree } = renderSheet();
    const sheet = findByType(tree, 'SwiftUIBottomSheet');
    expect(sheet).not.toBeNull();

    (sheet!.props.onDismiss as () => void)();

    expect(props.onClosed).toHaveBeenCalledTimes(1);
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('onIsPresentedChange(false)(用户下拉 / 点背板)只触发 onClose', () => {
    const { props, tree } = renderSheet();
    const sheet = findByType(tree, 'SwiftUIBottomSheet');

    (sheet!.props.onIsPresentedChange as (p: boolean) => void)(false);

    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(props.onClosed).not.toHaveBeenCalled();
  });

  it('onIsPresentedChange(true)(打开)不触发任何关闭回调', () => {
    const { props, tree } = renderSheet();
    const sheet = findByType(tree, 'SwiftUIBottomSheet');

    (sheet!.props.onIsPresentedChange as (p: boolean) => void)(true);

    expect(props.onClose).not.toHaveBeenCalled();
    expect(props.onClosed).not.toHaveBeenCalled();
  });

  it('程序化关闭(visible=false)后 onDismiss 仍然触发 onClosed', () => {
    // 点菜单项的真实序列:调用方先置 visible=false,再由原生报告已消失。
    const { props, tree } = renderSheet({ visible: false });
    const sheet = findByType(tree, 'SwiftUIBottomSheet');
    expect(sheet!.props.isPresented).toBe(false);

    (sheet!.props.onDismiss as () => void)();

    expect(props.onClosed).toHaveBeenCalledTimes(1);
  });

  it('visible 直接驱动 isPresented', () => {
    expect(
      findByType(renderSheet({ visible: true }).tree, 'SwiftUIBottomSheet')!.props.isPresented,
    ).toBe(true);
  });
});

describe('SessionOptionsExpoSheet 菜单接线', () => {
  it('每个菜单项把自己的 action 透传给 onAction(含删除)', () => {
    const { props, tree } = renderSheet();
    const items = collectByType(tree, 'ListItem');
    const actions = items.map((item) => String(item.props.testID).replace('home.sessionActions.', ''));

    expect(actions).toContain('delete');
    expect(actions).toContain('rename');

    const deleteItem = items.find((item) => item.props.testID === 'home.sessionActions.delete');
    (deleteItem!.props.onPress as () => void)();
    expect(props.onAction).toHaveBeenCalledWith<[SessionSwipeAction]>('delete');
  });
});

describe('SessionOptionsPresenter 平台分流', () => {
  it('非 iOS 走 Android 自绘 SessionActionSheet', () => {
    platform.os = 'android';
    const { tree } = renderSheet();
    expect(findByType(tree, 'SessionActionSheet')).not.toBeNull();
    expect(findByType(tree, 'SwiftUIBottomSheet')).toBeNull();
  });
});
