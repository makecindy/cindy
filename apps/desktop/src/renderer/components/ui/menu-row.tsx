import * as React from 'react';

import { cn } from '@/lib/utils';

import {
  MENU_CURRENT_ROW_ATTR,
  MENU_HIGHLIGHT_LAYER_ATTR,
  MENU_OWN_HIGHLIGHT_ATTR,
  MENU_PANEL_ATTR,
  MENU_ROW_ATTR,
  attachMenuHighlight,
  lockMenuWidth,
  type MenuHighlightOptions,
} from './dropdown-menu-highlight';

/**
 * Menu row look shared by the dropdown menu (dropdown-menu.tsx) and the composer panels
 * that keep their own shell and focus model (MorphPopover menus, / and @ lists).
 * DESIGN §4 Select & Dropdown: 14px option text on --cmd-palette-item-text with a unitless
 * line height (32px row), the same colour at rest and on hover, 400 → 500 on the
 * highlighted, active, checked or open row, one danger red (--error-fg).
 */
export const MENU_ROW_TEXT = 'text-14 leading-[1.43] text-[var(--cmd-palette-item-text)]';
// A caller that sets its own weight keeps it.
export const MENU_ROW_WEIGHT =
  'font-normal data-[menu-active]:font-medium data-[highlighted]:font-medium data-[state=checked]:font-medium data-[state=open]:font-medium';
export const MENU_ROW_OWN_WEIGHT = /(?:^|\s)font-(?:normal|medium|semibold|bold)(?=\s|$)/;
export const MENU_ROW_MOTION =
  'transition-[background-color,font-weight] duration-[var(--motion-instant)] ease-[var(--motion-ease-out)]';
export const MENU_DANGER_TEXT = 'text-[var(--error-fg)]';

/**
 * Row of a composer panel that keeps its own shell and focus model (MorphPopover menus,
 * / and @ lists): the shared text, weight and motion on the 8px inner tier, joined to the
 * panel's glide highlight with `menuRowAttrs`. Padding and height stay with each panel.
 */
export const COMPOSER_MENU_ROW = `relative select-none rounded-lg outline-none ${MENU_ROW_TEXT} ${MENU_ROW_WEIGHT} ${MENU_ROW_MOTION}`;

/** Panel attributes for a composer list hosting a MenuHighlightLayer. */
export const menuPanelAttrs = { [MENU_PANEL_ATTR]: '' } as const;

/**
 * Row attributes: `checked` turns the chosen row to 500 and starts the glide from it,
 * `current` marks the row the editor's arrow keys point at, `disabled` keeps the
 * highlight off it.
 */
export function menuRowAttrs({
  checked,
  current,
  disabled,
}: { checked?: boolean; current?: boolean; disabled?: boolean } = {}): Record<
  string,
  string | undefined
> {
  return {
    [MENU_ROW_ATTR]: '',
    'data-state': checked ? 'checked' : undefined,
    [MENU_CURRENT_ROW_ATTR]: current ? '' : undefined,
    'data-disabled': disabled ? '' : undefined,
  };
}

/**
 * Non-option blocks inside a glide panel (a toggle, a header card): the pointer over them
 * takes the highlight away instead of lighting the nearest option row. `data-menu-row="skip"`
 * keeps their icons out of the row icon-stroke rule (globals.css).
 */
export const menuSkipAttrs = { [MENU_ROW_ATTR]: 'skip', [MENU_OWN_HIGHLIGHT_ATTR]: '' } as const;

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

/** Wraps row text so its 500 width is reserved (see above). */
export function withMenuLabels(children: React.ReactNode, depth = 0): React.ReactNode {
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

/** The single glide highlight surface of a panel; render it as the panel's direct child. */
export function MenuHighlightLayer({ className }: { className?: string } = {}) {
  return (
    <span
      aria-hidden="true"
      {...{ [MENU_HIGHLIGHT_LAYER_ATTR]: '' }}
      className={cn(
        'pointer-events-none absolute left-0 top-0 rounded-lg bg-sidebar-item-hover opacity-0',
        className,
      )}
    />
  );
}

/**
 * Ref callback for a menu panel: optionally locks its laid-out width and attaches the
 * glide highlight to its direct-child MenuHighlightLayer.
 */
export function useMenuPanel<T extends HTMLElement>(
  forwarded: React.ForwardedRef<T> | undefined,
  {
    highlight = true,
    lockWidth = true,
    options,
  }: { highlight?: boolean; lockWidth?: boolean; options?: MenuHighlightOptions } = {},
) {
  const [panel, setPanel] = React.useState<T | null>(null);
  const ref = React.useCallback(
    (node: T | null) => {
      setPanel(node);
      if (typeof forwarded === 'function') forwarded(node);
      else if (forwarded) forwarded.current = node;
    },
    [forwarded],
  );
  // Width is locked once laid out, so a row turning 500 can never widen the panel.
  React.useEffect(
    () => (panel && lockWidth ? lockMenuWidth(panel) : undefined),
    [panel, lockWidth],
  );
  const optionsRef = React.useRef(options);
  optionsRef.current = options;
  React.useEffect(() => {
    if (!highlight || !panel) return;
    const layer = Array.from(
      panel.querySelectorAll<HTMLElement>(`[${MENU_HIGHLIGHT_LAYER_ATTR}]`),
    ).find((el) => el.parentElement === panel);
    return layer ? attachMenuHighlight(panel, layer, optionsRef.current) : undefined;
  }, [highlight, panel]);
  return ref;
}
