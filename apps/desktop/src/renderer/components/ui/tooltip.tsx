/**
 * Tooltip — shadcn/ui new-york 风格封装，基于 @radix-ui/react-tooltip。
 *
 * 用途：F-PJ-7 — Project 名 / Session 标题 / Toggle 按钮 hover 后显示完整路径或标题。
 *
 * 规格（prod_spec ccagent-projects-sidebar V1.7 F-PJ-7）：
 *   - delayDuration 500ms
 *   - 圆角 12（项目"非交互容器"统一规格）
 *   - 字号 13 / JetBrains Mono（用于路径展示）
 *   - 跨平台一致：用 Radix 而非原生 title，避免浏览器/系统差异
 *
 * 用法：
 *   <Tooltip.Provider>            // 顶层包裹一次
 *     <Tooltip.Root>
 *       <Tooltip.Trigger asChild>...</Tooltip.Trigger>
 *       <Tooltip.Content>...</Tooltip.Content>
 *     </Tooltip.Root>
 *   </Tooltip.Provider>
 */

import * as React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';

import { cn } from '@/lib/utils';

// 全局默认 delayDuration（F-PJ-7 规格 500ms）—— 调用方可在 Provider 上覆盖
// disableHoverableContent=true:鼠标离开 trigger 立即关闭,不允许移到 tip 内容
// 上"接住"它继续保持打开。我们所有 Tip 用法都是纯文本 label,没有需要 hover
// 交互的内容(链接 / 按钮),关掉这个对可访问性零成本,而开着会让用户感觉
// "tip 在按钮已经移开后还赖在屏幕上" —— 多次验收反馈的视觉延迟根因。
const TooltipProvider = ({
  delayDuration = 500,
  skipDelayDuration = 200,
  disableHoverableContent = true,
  ...props
}: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Provider>) => (
  <TooltipPrimitive.Provider
    delayDuration={delayDuration}
    skipDelayDuration={skipDelayDuration}
    disableHoverableContent={disableHoverableContent}
    {...props}
  />
);

const TooltipRoot = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

const TooltipContent = React.forwardRef<
  React.ComponentRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content> & {
    /** 内容字体：mono 用于路径展示（F-PJ-7），sans 用于普通文本（默认） */
    variant?: 'sans' | 'mono';
  }
>(({ className, side = 'top', sideOffset = 6, variant = 'sans', ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      side={side}
      sideOffset={sideOffset}
      className={cn(
        // F-PJ-7 视觉规格：12px 圆角 / 13px 文本 / 8px×10px 内边距
        // select-none:tooltip 是 hover 提示 chrome,role="tooltip" 不在
        // globals.css 的全局禁选名单里,不加会让全 app 提示文字可被划选。
        'z-[60] select-none rounded-xl px-2.5 py-1.5 text-13 leading-snug shadow-lg',
        // Cindy tooltip 两模式都是深底白字；Board 浅描边叠在深底上会看成一圈白边。
        'border border-transparent bg-[var(--tooltip-bg)] text-[var(--tooltip-text)]',
        'max-w-[420px] break-all', // 长路径允许任意位置截断换行
        variant === 'mono' && 'font-mono',
        // 入场/出场动画:tooltip 是信息不是对象,入场纯 opacity 不缩放,
        // 退场走轻浮层统一的 float-out(--motion-instant)。
        // 注意 Radix Tooltip 的 data-state 是 delayed-open / instant-open /
        // closed(没有 "open"),所以入场直接挂 mount 动画,closed 态靠更高
        // 特异性的规则覆盖成退场动画。
        'animate-fade-in data-[state=closed]:animate-float-out',
        className,
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export const Tooltip = {
  Provider: TooltipProvider,
  Root: TooltipRoot,
  Trigger: TooltipTrigger,
  Content: TooltipContent,
};

// ── <Tip> ───────────────────────────────────────────────────────────────────
// 一行包装,替代浏览器原生 title 属性。内部自带 Provider,任何位置都能直接用。
//
// 用法:
//   <Tip text="提示文案"><button>...</button></Tip>
//   <Tip text={longPath} mono><span>...</span></Tip>          // 长路径用 mono 字体
//   <Tip text="..." side="bottom" delay={200}>...</Tip>      // 自定义方位/延迟
//   <Tip text={maybeNull}>...</Tip>                          // text 为空时直接渲染 children,不挂 tooltip
//   <Tip text="..." forceOpen>...</Tip>                       // 由调用方强制展示
//   <Tip text="..." controlledOpen={false}>...</Tip>          // 由调用方强制关闭
//
// children 必须是单个能接受 ref + onMouseEnter/Leave 等事件的元素(button / a / div / span / 自定义 forwardRef 组件)。
// 普通文本节点请先包一层 <span>。
//
// ── 复合 trigger 场景 ──
// 用在其他 asChild Trigger(Popover / Dropdown 等)内部时,把 Tip 当作 children 传入即可:
//   <PopoverTrigger asChild>
//     <Tip text="..."><button>...</button></Tip>
//   </PopoverTrigger>
// Tip 是 forwardRef + 透传 props,会把外层 Trigger 注入的 ref/事件正确合并给 button。

export interface TipProps {
  /** 提示文案;为 null/undefined/空字符串时直接渲染 children,不挂 tooltip */
  text: React.ReactNode | null | undefined;
  children: React.ReactElement;
  /** 字体:mono 用于路径/命令展示;sans 默认 */
  mono?: boolean;
  /** 弹出方位,默认 top */
  side?: 'top' | 'right' | 'bottom' | 'left';
  /** 延迟显示(ms),默认沿用 Provider 的 500 */
  delay?: number;
  /** 强制禁用,等价于 text 为空 */
  disabled?: boolean;
  /** 强制展示,用于按住、拖拽等不会触发默认 hover 的状态 */
  forceOpen?: boolean;
  /** 受控开关。提供时优先于 forceOpen,用于需要明确关闭 tooltip 的拖拽态。 */
  controlledOpen?: boolean;
  /** 自定义 Content 样式(覆盖默认宽度等) */
  contentClassName?: string;
}

// 注意:不写出 React.HTMLAttributes 的具体类型,因为外层 Trigger(Popover/Dropdown 等)
// 注入的 props 形态各异——用 ...rest 直接转发即可,Radix 的 Slot 会正确合并。
// ref 类型用 unknown:外层 Trigger 可能是任何元素(button/span/img 等),Tip 不该限定。
export const Tip = React.forwardRef<unknown, TipProps>(function Tip(props, forwardedRef) {
  const {
    text,
    children,
    mono,
    side = 'top',
    delay,
    disabled,
    forceOpen,
    controlledOpen,
    contentClassName,
    ...rest
  } = props;
  const isEmpty =
    disabled ||
    text === null ||
    text === undefined ||
    (typeof text === 'string' && text.length === 0);

  // Radix Tooltip 要求 open 在整个生命周期里要么一直受控、要么一直非受控,来回切换
  // 会抛 "changing from uncontrolled to controlled"。调用方常按状态临时受控(拖拽、
  // 录音精修中),之后又交回 hover 驱动 —— 只要调用方**声明了**受控意图(传了
  // controlledOpen / forceOpen 这两个 prop,哪怕当前值是 undefined),就从挂载起
  // 走受控路径,交回时用本地 hover 状态模拟非受控行为。
  const requestedOpen = controlledOpen ?? (forceOpen ? true : undefined);
  const [hoverOpen, setHoverOpen] = React.useState(false);
  const controlledRef = React.useRef(
    'controlledOpen' in props || 'forceOpen' in props || requestedOpen !== undefined,
  );
  if (requestedOpen !== undefined) controlledRef.current = true;
  const open = requestedOpen ?? (controlledRef.current ? hoverOpen : undefined);

  // 没有 tooltip 内容时,Tip 仍要保持"透明传递":把外层 props/ref 直接合并到 children,
  // 避免在复合 trigger 里成为 ref/事件断点。React 18 的 cloneElement 类型签名不接受 ref
  // 在 props 字面量里,需要用 ref 字段单独传。这里用类型断言把它当成附加属性透传。
  if (isEmpty) {
    return React.cloneElement(children, {
      ...rest,
      ref: forwardedRef,
    } as Partial<unknown>);
  }

  return (
    <TooltipProvider delayDuration={delay}>
      <TooltipRoot open={open} onOpenChange={setHoverOpen}>
        <TooltipTrigger
          asChild
          ref={forwardedRef as React.Ref<HTMLButtonElement>}
          {...rest}
        >
          {children}
        </TooltipTrigger>
        <TooltipContent
          side={side}
          variant={mono ? 'mono' : 'sans'}
          className={contentClassName}
        >
          {text}
        </TooltipContent>
      </TooltipRoot>
    </TooltipProvider>
  );
});
Tip.displayName = 'Tip';
