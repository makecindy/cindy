import * as React from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';

import { cn } from '@/lib/utils';

const Popover = PopoverPrimitive.Root;

const PopoverTrigger = PopoverPrimitive.Trigger;

const PopoverAnchor = PopoverPrimitive.Anchor;

const PopoverContent = React.forwardRef<
  React.ComponentRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content> & {
    /**
     * 浮层要挂到哪个节点（缺省 = body 末尾）。
     *
     * 底栏卡片必须传：portal 到 body 时它的 DOM 位置在文档最末，文档内它后面再没有
     * 下一个可 Tab 节点，焦点一旦进卡就**再也回不到底栏**（用户实测：Tab 到用量卡后
     * 翻多少次都到不了右边的窗口卡）。挂到触发器紧跟其后的宿主里，DOM 顺序 = 视觉顺序，
     * Tab 就能从卡片继续走到右边下一枚 chip。
     */
    portalContainer?: HTMLElement | null;
  }
>(({ className, align = 'center', sideOffset = 4, portalContainer, ...props }, ref) => (
  <PopoverPrimitive.Portal container={portalContainer ?? undefined}>
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      className={cn(
        'z-50 w-72 rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-none',
        'origin-[var(--radix-popover-content-transform-origin)]',
        'data-[state=open]:animate-float-in data-[state=closed]:animate-float-out',
        className,
      )}
      {...props}
    />
  </PopoverPrimitive.Portal>
));
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor };
