import * as SelectPrimitive from '@radix-ui/react-select';
import {
  forwardRef,
  createContext,
  useContext,
  useState,
  type ComponentPropsWithoutRef,
} from 'react';

import { cn } from '@/lib/utils';
import {
  MENU_OWN_HIGHLIGHT_ATTR,
  MENU_ROW_ATTR,
  hasOwnHighlight,
} from './dropdown-menu-highlight';
import { MenuHighlightLayer, menuPanelAttrs, useMenuPanel } from './menu-row';
import './select.css';

interface SelectFocusSource {
  pointer: boolean;
  setPointer(pointer: boolean): void;
}
const FocusSource = createContext<SelectFocusSource>({ pointer: false, setPointer: () => {} });

function Root(props: ComponentPropsWithoutRef<typeof SelectPrimitive.Root>) {
  const [pointer, setPointer] = useState(false);
  return (
    <FocusSource.Provider value={{ pointer, setPointer }}>
      <SelectPrimitive.Root {...props} />
    </FocusSource.Provider>
  );
}

const Trigger = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(({ className, asChild, onPointerDownCapture, onKeyDownCapture, onBlur, ...props }, ref) => {
  const focus = useContext(FocusSource);
  return (
    <SelectPrimitive.Trigger
      {...props}
      asChild={asChild}
      ref={ref}
      data-pointer-focus={focus.pointer || undefined}
      onPointerDownCapture={(event) => {
        focus.setPointer(true);
        onPointerDownCapture?.(event);
      }}
      onKeyDownCapture={(event) => {
        focus.setPointer(false);
        onKeyDownCapture?.(event);
      }}
      onBlur={(event) => {
        // Keep the source while focus visits the portal; clear it when leaving the closed field.
        if (event.currentTarget.dataset.state !== 'open') focus.setPointer(false);
        onBlur?.(event);
      }}
      className={cn(
        'cindy-select-trigger',
        // An asChild Button already owns its focus/error ring; do not override it.
        !asChild && 'outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]',
        className,
      )}
    />
  );
});
Trigger.displayName = 'SelectTrigger';

const Content = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(
  (
    {
      className,
      onPointerDownCapture,
      onKeyDownCapture,
      onPointerDownOutside,
      onEscapeKeyDown,
      ...props
    },
    ref,
  ) => {
    const focus = useContext(FocusSource);
    return (
      <SelectPrimitive.Content
        position="popper"
        sideOffset={4}
        collisionPadding={8}
        {...props}
        ref={ref}
        onPointerDownCapture={(event) => {
          focus.setPointer(true);
          onPointerDownCapture?.(event);
        }}
        onPointerDownOutside={(event) => {
          focus.setPointer(true);
          onPointerDownOutside?.(event);
        }}
        onKeyDownCapture={(event) => {
          focus.setPointer(false);
          onKeyDownCapture?.(event);
        }}
        onEscapeKeyDown={(event) => {
          focus.setPointer(false);
          onEscapeKeyDown?.(event);
        }}
        className={cn(
          'cindy-select-content z-[10010] w-[var(--radix-select-trigger-width)] max-h-[var(--radix-select-content-available-height)] overflow-hidden rounded-xl p-1.5',
          'data-[state=open]:animate-float-in data-[state=closed]:animate-float-out',
          className,
        )}
      />
    );
  },
);
Content.displayName = 'SelectContent';

// Radix highlights the focused option, including the saved one when the menu opens.
const highlightedOption = (rows: readonly HTMLElement[]) =>
  rows.find((row) => row.hasAttribute('data-highlighted'));

/** The scrolling viewport hosts the shared menu glide highlight (menu-row.tsx). */
const Viewport = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Viewport>
>(({ className, children, ...props }, forwardedRef) => {
  const ref = useMenuPanel(forwardedRef, {
    lockWidth: false,
    options: { current: highlightedOption },
  });
  return (
    <SelectPrimitive.Viewport
      {...props}
      {...menuPanelAttrs}
      ref={ref}
      className={className}
    >
      <MenuHighlightLayer />
      {children}
    </SelectPrimitive.Viewport>
  );
});
Viewport.displayName = 'SelectViewport';

const Item = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof SelectPrimitive.Item>>(
  ({ className, ...props }, ref) => (
    <SelectPrimitive.Item
      {...props}
      ref={ref}
      {...{ [MENU_ROW_ATTR]: '' }}
      {...(hasOwnHighlight(className) ? { [MENU_OWN_HIGHLIGHT_ATTR]: '' } : {})}
      className={cn('relative shrink-0', className)}
    />
  ),
);
Item.displayName = 'SelectItem';

/** Compound form of the same Select for grouped/rich legacy options.
 * Keep local theme aliases and business handlers; share focus, elevation, motion and the
 * menu glide highlight.
 */
export const SelectParts = {
  Root,
  Trigger,
  Value: SelectPrimitive.Value,
  Icon: SelectPrimitive.Icon,
  Portal: SelectPrimitive.Portal,
  Content,
  Viewport,
  Item,
  ItemText: SelectPrimitive.ItemText,
  ItemIndicator: SelectPrimitive.ItemIndicator,
  Group: SelectPrimitive.Group,
  Label: SelectPrimitive.Label,
  Separator: SelectPrimitive.Separator,
  ScrollUpButton: SelectPrimitive.ScrollUpButton,
  ScrollDownButton: SelectPrimitive.ScrollDownButton,
};
