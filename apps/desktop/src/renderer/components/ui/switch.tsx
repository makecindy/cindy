/**
 * Switch — shadcn/ui new-york 风格的 Radix Switch 包装。
 *
 * 与 dropdown-menu / popover 同 Radix 包装风格：直接 forwardRef + cn() 拼样式。
 * 颜色全走 token：开启态走 --switch-track-on（默认 primary，皮肤可覆盖为主题色）；
 * 关闭态使用 Switch 专用 track/thumb token，避免复用 input 边框色后在设置卡片上
 * 失去非文字组件所需的轮廓对比度。滑块无投影（DESIGN.md §6 零阴影哲学，试过可见
 * 投影后被显式否决）；禁用态 = 整体 × 滑块两级不透明度 token 叠加，让「不可用」靠
 * 失去立体感区别于「关」。定值与依据见 colors.ts 注册处（用户裁决 2026-08-05）。
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
      'disabled:cursor-not-allowed disabled:opacity-[var(--switch-disabled-opacity)]',
      'data-[state=checked]:bg-[var(--switch-track-on)] data-[state=unchecked]:bg-[var(--switch-track-off)]',
      className,
    )}
    {...props}
    ref={ref}
  >
    <SwitchPrimitives.Thumb
      className={cn(
        'pointer-events-none block h-4 w-4 rounded-full ring-0 transition-transform',
        'data-[disabled]:opacity-[var(--switch-disabled-thumb-opacity)]',
        'data-[state=checked]:bg-background data-[state=unchecked]:bg-[var(--switch-thumb-off)]',
        'data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0',
      )}
    />
  </SwitchPrimitives.Root>
));
Switch.displayName = SwitchPrimitives.Root.displayName;

export { Switch };
