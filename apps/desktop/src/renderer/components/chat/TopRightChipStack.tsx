/**
 * TopRightChipStack
 * ---------------------------------------------------------------------------
 * 聊天会话视图右上角的"chip 栈"容器 —— 把所有需要落在 right-3 top-3
 * 这一坐标的浮动按钮(DiffPanelToggle / PrevMessageJumpChip 等)统一收拢
 * 到一个 flex-col 里,自然纵向排列,互不抢位。
 *
 * 设计动机:
 *   早先 DiffPanelToggle 与 PrevMessageJumpChip 各自写死 absolute right-3
 *   top-3,只能靠"chip 出现就把 diff 按钮 unmount"互斥共存,滚动期间 diff
 *   按钮反复 pop in/out。栈容器把定位上提一层,chip 自身只关心样式,栈用
 *   flex 处理排列,多 chip 并存自然落到不同行。
 *
 * 排列规则:
 *   - 静态 chip(常驻,如 DiffPanelToggle)直接作为 children 传入,占据栈
 *     顶第一行;
 *   - 异步出现的 chip(如 scroll 派生的 PrevMessageJumpChip)由后代组件
 *     通过 `useTopRightChipSlot()` 拿到栈 DOM 节点,createPortal 挂入,
 *     DOM append 在静态 children 之后,自然落在下一行。
 *   - 实际场景里 DiffPanelToggle 在 session 载入时挂载,PrevMessageJumpChip
 *     仅在用户上滑时 mount,源码顺序天然满足"谁先出现谁占顶"的语义,
 *     不需要做按 mount 时间排序的 registry。
 *
 * 命中性:
 *   栈容器自身 `pointer-events-none`,避免空白区拦截聊天区滚轮 / 文本选择;
 *   chip 自己加 `pointer-events-auto` 才能接收点击 —— 这一约束已写到
 *   PrevMessageJumpChip / DiffPanelToggle 的 className 里。
 */
import {
  createContext,
  useContext,
  useState,
  type ReactNode,
} from 'react';

import { cn } from '@/lib/utils';

const SlotContext = createContext<HTMLDivElement | null>(null);
const SetSlotContext = createContext<
  ((el: HTMLDivElement | null) => void) | null
>(null);

/**
 * 后代组件读取栈 DOM 节点 —— 拿到后用 `ReactDOM.createPortal` 把自己的
 * chip 渲染进栈。Provider 未挂载时返回 null,调用方需要 `if (!slot)
 * return null` 兜底。
 */
export function useTopRightChipSlot(): HTMLDivElement | null {
  return useContext(SlotContext);
}

interface TopRightChipStackProviderProps {
  children: ReactNode;
}

/**
 * 上下文 Provider —— 包裹同时包含「栈容器」和「会用 portal 挂入栈的后代
 * (如 MessageStream)」的祖先。两者必须在同一棵子树里,context 才能流到
 * 后代。
 *
 * 约束:一个 Provider 子树里只允许出现 **一个** `<TopRightChipStack>` 实例。
 * Provider 只持单一 slot state,后挂的 Stack 会用自己的 ref 静默覆盖前
 * 一个的 slot,后代的 portal 会被搬到新栈里 —— 没人想要这个行为。当前只
 * 有 CCAgentSessionView 一处用法,如需在多个区域分别有 chip 栈,应该开
 * 多组 Provider/Stack 配对(每组各自独立)。
 */
export function TopRightChipStackProvider({
  children,
}: TopRightChipStackProviderProps) {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  return (
    <SetSlotContext.Provider value={setNode}>
      <SlotContext.Provider value={node}>{children}</SlotContext.Provider>
    </SetSlotContext.Provider>
  );
}

interface TopRightChipStackProps {
  children?: ReactNode;
}

/**
 * 实际定位的栈容器。右缘固定 right-3,顶部固定 top-3,内部 flex-col + gap-2 让多个
 * chip 自然排列。children 写谁谁就落在最上一行;下方行交给 portal。
 *
 * (历史:右栏开关曾是 Windows 窗口角的顶层浮层,本栈需按右栏折叠态下移 top-10 给它
 *  让位。开关已下沉进本栈作为第一行 child、不再钉窗口角,让位逻辑随之删除,恒 top-3。)
 */
export function TopRightChipStack({ children }: TopRightChipStackProps) {
  const setNode = useContext(SetSlotContext);
  if (!setNode) {
    throw new Error(
      'TopRightChipStack must be rendered inside <TopRightChipStackProvider>',
    );
  }
  return (
    <div
      ref={setNode}
      className={cn(
        'pointer-events-none absolute right-3 top-3 z-page-float flex flex-col items-end gap-2',
      )}
    >
      {children}
    </div>
  );
}
