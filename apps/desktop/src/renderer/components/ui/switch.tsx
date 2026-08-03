/**
 * Switch — shadcn/ui new-york 风格的 Radix Switch 包装。
 *
 * 与 dropdown-menu / popover 同 Radix 包装风格：直接 forwardRef + cn() 拼样式。
 * 颜色全走 token：开启 bg-primary；关闭态使用 Switch 专用 track/thumb token，
 * 避免复用 input 边框色后在设置卡片上失去非文字组件所需的轮廓对比度。
 */

import * as React from 'react';
import * as SwitchPrimitives from '@radix-ui/react-switch';

import { cn } from '@/lib/utils';

const Switch = React.forwardRef<
  React.ComponentRef<typeof SwitchPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitives.Root
    className={cn(
      'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
      'disabled:cursor-not-allowed disabled:opacity-50',
      'data-[state=checked]:bg-primary data-[state=unchecked]:bg-[var(--switch-track-off)]',
      className,
    )}
    {...props}
    ref={ref}
  >
    <SwitchPrimitives.Thumb
      className={cn(
        'pointer-events-none block h-4 w-4 rounded-full shadow-lg ring-0 transition-transform',
        'data-[state=checked]:bg-background data-[state=unchecked]:bg-[var(--switch-thumb-off)]',
        'data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0',
      )}
    />
  </SwitchPrimitives.Root>
));
Switch.displayName = SwitchPrimitives.Root.displayName;

export { Switch };
