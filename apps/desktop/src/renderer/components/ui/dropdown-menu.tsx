import * as React from 'react';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';

import { cn } from '@/lib/utils';

import {
  MENU_HIGHLIGHT_LAYER_ATTR,
  MENU_OWN_HIGHLIGHT_ATTR,
  MENU_PANEL_ATTR,
  MENU_ROW_ATTR,
  attachMenuHighlight,
  lockMenuWidth,
  hasOwnHighlight,
} from './dropdown-menu-highlight';

// Menu text defaults (DESIGN §4 Select & Dropdown): 14px option text on
// --cmd-palette-item-text with a unitless line height (32px row), 12px meta and group
// labels on --cmd-palette-item-meta, one danger red (--error-fg). The text colour is the
// same at rest and on hover; only the weight changes.
const ROW_TEXT = 'text-14 leading-[1.43] text-[var(--cmd-palette-item-text)]';
// Weight: 400 at rest, 500 on the highlighted, active, checked or open row
// (DESIGN §3 ladder). A caller that sets its own weight keeps it.
const ROW_WEIGHT =
  'font-normal data-[menu-active]:font-medium data-[highlighted]:font-medium data-[state=checked]:font-medium data-[state=open]:font-medium';
const OWN_WEIGHT = /(?:^|\s)font-(?:normal|medium|semibold|bold)(?=\s|$)/;
const ROW_BASE = `relative flex select-none items-center rounded-lg py-1.5 outline-none ${ROW_TEXT} transition-[background-color,font-weight] duration-[var(--motion-instant)] ease-[var(--motion-ease-out)] data-[disabled]:pointer-events-none data-[disabled]:opacity-50`;
// Per-row focus fill (the transitioned background-color above), used only when the
// panel's glide highlight is off or the caller styles its own highlight.
const ROW_FOCUS_FILL = 'focus:bg-sidebar-item-hover';
const DANGER_TEXT = 'text-[var(--error-fg)]';

// Row text is wrapped so its width is reserved at 500: an invisible, zero-height
// ::after copy (generated content, so textContent, typeahead and the accessible name
// are unchanged) keeps the label, the row and a trailing shortcut from shifting when
// the weight changes. Lucide icons given an explicit strokeWidth are marked so the
// row icon stroke rule (globals.css, [data-menu-row]) leaves them alone.
const RESERVE_AFTER =
  'after:pointer-events-none after:invisible after:h-0 after:select-none after:overflow-hidden after:font-medium after:content-[attr(data-menu-label)_/_""]';
const LABEL_CLASS = `inline-flex flex-col ${RESERVE_AFTER}`;
const LABEL_HOSTS = new Set(['span', 'div', 'p', 'strong', 'em', 'b', 'i', 'small', 'label']);
const NO_LABEL_WRAP = /(?:^|\s)(?:truncate|line-clamp-\S+|overflow-hidden|sr-only)(?=\s|$)/;
// A truncating span keeps its ellipsis: its text stays inline and the 500-width copy is a
// zero-height block ::after inside it (hidden by the span's own overflow).
const TRUNCATE = /(?:^|\s)truncate(?=\s|$)/;
const TRUNCATE_RESERVE = `after:block ${RESERVE_AFTER}`;
const MENU_ICON_STROKE_ATTR = 'data-menu-icon-stroke';

function withMenuLabels(children: React.ReactNode, depth = 0): React.ReactNode {
  // Adjacent strings and numbers form one label, so spaces between them survive.
  const out: React.ReactNode[] = [];
  let text = '';
  const flush = () => {
    if (!text) return;
    out.push(
      text.trim() ? (
        <span key={`menu-label-${out.length}`} data-menu-label={text} className={LABEL_CLASS}>
          {text}
        </span>
      ) : (
        text
      ),
    );
    text = '';
  };
  for (const child of React.Children.toArray(children)) {
    if (typeof child === 'string' || typeof child === 'number') {
      text += String(child);
      continue;
    }
    flush();
    if (
      !React.isValidElement<{
        children?: React.ReactNode;
        className?: string;
        strokeWidth?: unknown;
      }>(child)
    ) {
      out.push(child);
      continue;
    }
    const { children: nested, className, strokeWidth } = child.props;
    if (strokeWidth !== undefined)
      out.push(
        React.cloneElement(child, { [MENU_ICON_STROKE_ATTR]: '' } as Record<string, string>),
      );
    else if (child.type === React.Fragment)
      out.push(React.cloneElement(child, undefined, withMenuLabels(nested, depth)));
    else if (
      typeof child.type === 'string' &&
      LABEL_HOSTS.has(child.type) &&
      TRUNCATE.test(className ?? '') &&
      (typeof nested === 'string' || typeof nested === 'number')
    )
      out.push(
        React.cloneElement(child, {
          'data-menu-label': String(nested),
          className: cn(className, TRUNCATE_RESERVE),
        } as Record<string, string>),
      );
    else if (
      typeof child.type === 'string' &&
      LABEL_HOSTS.has(child.type) &&
      depth < 3 &&
      nested != null &&
      !NO_LABEL_WRAP.test(className ?? '')
    )
      out.push(React.cloneElement(child, undefined, withMenuLabels(nested, depth + 1)));
    else out.push(child);
  }
  flush();
  return out;
}

/** True inside a panel whose single glide highlight replaces per-row focus fills. */
const MenuHighlightContext = React.createContext(false);

function useRowHighlight(className: string | undefined) {
  const glide = React.useContext(MenuHighlightContext);
  const ownHighlight = hasOwnHighlight(className);
  return {
    fill: glide && !ownHighlight ? '' : ROW_FOCUS_FILL,
    weight: OWN_WEIGHT.test(className ?? '') ? '' : ROW_WEIGHT,
    attrs: { [MENU_ROW_ATTR]: '', ...(ownHighlight ? { [MENU_OWN_HIGHLIGHT_ATTR]: '' } : {}) },
  };
}

function useMenuPanel(forwarded: React.ForwardedRef<HTMLDivElement>, enabled: boolean) {
  const [panel, setPanel] = React.useState<HTMLDivElement | null>(null);
  const ref = React.useCallback(
    (node: HTMLDivElement | null) => {
      setPanel(node);
      if (typeof forwarded === 'function') forwarded(node);
      else if (forwarded) forwarded.current = node;
    },
    [forwarded],
  );
  // Width is locked once laid out, so a row turning 500 can never widen the panel.
  React.useEffect(() => (panel ? lockMenuWidth(panel) : undefined), [panel]);
  React.useEffect(() => {
    if (!enabled || !panel) return;
    const layer = Array.from(
      panel.querySelectorAll<HTMLElement>(`[${MENU_HIGHLIGHT_LAYER_ATTR}]`),
    ).find((el) => el.parentElement === panel);
    return layer ? attachMenuHighlight(panel, layer) : undefined;
  }, [enabled, panel]);
  return ref;
}

function HighlightLayer() {
  return (
    <span
      aria-hidden="true"
      {...{ [MENU_HIGHLIGHT_LAYER_ATTR]: '' }}
      className="pointer-events-none absolute left-0 top-0 rounded-lg bg-sidebar-item-hover opacity-0"
    />
  );
}

type PanelHighlightProps = {
  /** Shared glide highlight between rows (default on). Turn off to keep per-row focus fills. */
  hoverHighlight?: boolean;
};

const DropdownMenu = DropdownMenuPrimitive.Root;

const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;

const DropdownMenuGroup = DropdownMenuPrimitive.Group;

const DropdownMenuPortal = DropdownMenuPrimitive.Portal;

const DropdownMenuSub = DropdownMenuPrimitive.Sub;

const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;

const DropdownMenuSubTrigger = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubTrigger> & {
    inset?: boolean;
  }
>(({ className, inset, children, ...props }, ref) => {
  const row = useRowHighlight(className);
  return (
    <DropdownMenuPrimitive.SubTrigger
      ref={ref}
      {...row.attrs}
      className={cn(
        ROW_BASE,
        row.weight,
        'cursor-default px-2',
        row.fill && `${row.fill} data-[state=open]:bg-sidebar-item-hover`,
        inset && 'pl-8',
        className,
      )}
      {...props}
    >
      {withMenuLabels(children)}
    </DropdownMenuPrimitive.SubTrigger>
  );
});
DropdownMenuSubTrigger.displayName = DropdownMenuPrimitive.SubTrigger.displayName;

// SubContent 必须走 Portal 挂到 body,不能作为父 Content 的 DOM 后代原地渲染。
// Radix 默认不给 SubContent 套 Portal,但我们的菜单 surface(共享默认与 MENU_CONTENT_CLASS
// 都是 bg-[var(--cmd-palette-bg)])在 CINDY 毛玻璃主题下会拿到 `backdrop-filter: blur`
// (globals.css 的 E4D 毛玻璃规则)。`backdrop-filter` 非 none 会让父 Content 成为
// fixed 定位后代的 containing block,于是子菜单的 Popper wrapper(position:fixed)不再
// 逃逸到外层 popper wrapper,而是被父 Content 的 `overflow-hidden` 裁掉 —— 表现为
// 「点了移动到项目/子菜单没反应」。Portal 到 body(无 filter、无 overflow 裁剪)可根治,
// 与 DropdownMenuContent 自身已 Portal 的做法一致。删除此 Portal 会让子菜单在毛玻璃
// 主题下重新消失。
const DropdownMenuSubContent = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubContent> & PanelHighlightProps
>(({ className, hoverHighlight = true, children, ...props }, ref) => (
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.SubContent
      ref={useMenuPanel(ref, hoverHighlight)}
      {...{ [MENU_PANEL_ATTR]: '' }}
      className={cn(
        'relative z-50 min-w-[8rem] overflow-hidden rounded-xl border border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)] p-1 text-[var(--cmd-palette-item-text)] shadow-[shadow:var(--shadow-menu)] origin-[var(--radix-dropdown-menu-content-transform-origin)] data-[state=open]:animate-float-in data-[state=closed]:animate-float-out',
        className,
      )}
      {...props}
    >
      <MenuHighlightContext.Provider value={hoverHighlight}>
        {hoverHighlight && <HighlightLayer />}
        {children}
      </MenuHighlightContext.Provider>
    </DropdownMenuPrimitive.SubContent>
  </DropdownMenuPrimitive.Portal>
));
DropdownMenuSubContent.displayName = DropdownMenuPrimitive.SubContent.displayName;

const DropdownMenuContent = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content> & PanelHighlightProps
>(({ className, sideOffset = 4, hoverHighlight = true, children, ...props }, ref) => (
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.Content
      ref={useMenuPanel(ref, hoverHighlight)}
      {...{ [MENU_PANEL_ATTR]: '' }}
      sideOffset={sideOffset}
      className={cn(
        'relative z-50 min-w-[8rem] overflow-hidden rounded-xl border border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)] p-1 text-[var(--cmd-palette-item-text)] shadow-[shadow:var(--shadow-menu)]',
        'origin-[var(--radix-dropdown-menu-content-transform-origin)] data-[state=open]:animate-float-in data-[state=closed]:animate-float-out',
        className,
      )}
      {...props}
    >
      <MenuHighlightContext.Provider value={hoverHighlight}>
        {hoverHighlight && <HighlightLayer />}
        {children}
      </MenuHighlightContext.Provider>
    </DropdownMenuPrimitive.Content>
  </DropdownMenuPrimitive.Portal>
));
DropdownMenuContent.displayName = DropdownMenuPrimitive.Content.displayName;

const DropdownMenuItem = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & {
    inset?: boolean;
    /** Destructive action: the single menu danger red. */
    variant?: 'default' | 'danger';
  }
>(({ className, inset, variant = 'default', asChild, children, ...props }, ref) => {
  const row = useRowHighlight(className);
  return (
    <DropdownMenuPrimitive.Item
      ref={ref}
      {...row.attrs}
      className={cn(
        ROW_BASE,
        row.weight,
        'cursor-pointer px-2',
        row.fill,
        variant === 'danger' && DANGER_TEXT,
        inset && 'pl-8',
        className,
      )}
      asChild={asChild}
      {...props}
    >
      {asChild ? children : withMenuLabels(children)}
    </DropdownMenuPrimitive.Item>
  );
});
DropdownMenuItem.displayName = DropdownMenuPrimitive.Item.displayName;

const DropdownMenuCheckboxItem = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem>
>(({ className, children, checked, ...props }, ref) => {
  const row = useRowHighlight(className);
  return (
    <DropdownMenuPrimitive.CheckboxItem
      ref={ref}
      {...row.attrs}
      className={cn(ROW_BASE, row.weight, 'cursor-default pl-8 pr-2', row.fill, className)}
      checked={checked}
      {...props}
    >
      <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <svg
            width="15"
            height="15"
            viewBox="0 0 15 15"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M11.4669 3.72684C11.7558 3.91574 11.8369 4.30308 11.648 4.59198L7.39799 11.092C7.29783 11.2452 7.13556 11.3467 6.95402 11.3699C6.77247 11.3931 6.58989 11.3354 6.45446 11.2124L3.70446 8.71241C3.44905 8.48022 3.43023 8.08494 3.66242 7.82953C3.89461 7.57412 4.28989 7.5553 4.5453 7.78749L6.75292 9.79441L10.6018 3.90792C10.7907 3.61902 11.178 3.53795 11.4669 3.72684Z"
              fill="currentColor"
              fillRule="evenodd"
              clipRule="evenodd"
            />
          </svg>
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {withMenuLabels(children)}
    </DropdownMenuPrimitive.CheckboxItem>
  );
});
DropdownMenuCheckboxItem.displayName = DropdownMenuPrimitive.CheckboxItem.displayName;

const DropdownMenuRadioItem = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.RadioItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.RadioItem>
>(({ className, children, ...props }, ref) => {
  const row = useRowHighlight(className);
  return (
    <DropdownMenuPrimitive.RadioItem
      ref={ref}
      {...row.attrs}
      className={cn(ROW_BASE, row.weight, 'cursor-default pl-8 pr-2', row.fill, className)}
      {...props}
    >
      <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <svg
            width="15"
            height="15"
            viewBox="0 0 15 15"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M7.49991 0.876953C3.84222 0.876953 0.877075 3.8421 0.877075 7.49979C0.877075 11.1575 3.84222 14.123 7.49991 14.123C11.1576 14.123 14.1227 11.1575 14.1227 7.49979C14.1227 3.8421 11.1576 0.876953 7.49991 0.876953ZM7.49991 1.82695C10.6329 1.82695 13.1727 4.3668 13.1727 7.49979C13.1727 10.6328 10.6329 13.173 7.49991 13.173C4.36692 13.173 1.82708 10.6328 1.82708 7.49979C1.82708 4.3668 4.36692 1.82695 7.49991 1.82695ZM7.49991 4.37695C5.77492 4.37695 4.37708 5.77479 4.37708 7.49979C4.37708 9.22479 5.77492 10.623 7.49991 10.623C9.22491 10.623 10.6227 9.22479 10.6227 7.49979C10.6227 5.77479 9.22491 4.37695 7.49991 4.37695Z"
              fill="currentColor"
              fillRule="evenodd"
              clipRule="evenodd"
            />
          </svg>
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {withMenuLabels(children)}
    </DropdownMenuPrimitive.RadioItem>
  );
});
DropdownMenuRadioItem.displayName = DropdownMenuPrimitive.RadioItem.displayName;

const DropdownMenuLabel = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label> & {
    inset?: boolean;
  }
>(({ className, inset, ...props }, ref) => (
  <DropdownMenuPrimitive.Label
    ref={ref}
    className={cn(
      'px-2 py-1.5 text-12 font-medium leading-[1.33] text-[var(--cmd-palette-item-meta)]',
      inset && 'pl-8',
      className,
    )}
    {...props}
  />
));
DropdownMenuLabel.displayName = DropdownMenuPrimitive.Label.displayName;

// Separators use the Board divider --cmd-palette-border, the panel border colour.
const DropdownMenuSeparator = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Separator
    ref={ref}
    className={cn('-mx-1 my-1 h-px bg-[var(--cmd-palette-border)]', className)}
    {...props}
  />
));
DropdownMenuSeparator.displayName = DropdownMenuPrimitive.Separator.displayName;

// Shortcuts stay at 400 while their row turns 500, so the key hint never shifts.
function DropdownMenuShortcut({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'ml-auto pl-4 text-12 font-normal leading-[1.33] tracking-widest text-[var(--cmd-palette-item-meta)]',
        className,
      )}
      {...props}
    />
  );
}
DropdownMenuShortcut.displayName = 'DropdownMenuShortcut';

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuGroup,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuRadioGroup,
};
