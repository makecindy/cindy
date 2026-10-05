/**
 * Shared dropdown-menu hover highlight (DESIGN §4 Select & Dropdown, §14.4).
 * ---------------------------------------------------------------------------
 * One highlight surface per menu panel glides between rows with `transform`
 * instead of every row fading its own background. It is a purely visual layer:
 * Radix still owns focus, roles, keyboard handling, typeahead and onSelect.
 *
 * - Anywhere inside the panel, the row nearest to the pointer wins, so gaps
 *   between rows, the panel padding and the strips around separators never
 *   flicker. Separators only group rows visually: the highlight keeps gliding
 *   across them.
 * - Each time the pointer enters, the highlight fades in from the checked row
 *   (or from the target row) and glides to the target; leaving fades it out.
 * - Keyboard input (arrows / Home / End / typeahead) follows Radix's
 *   `data-highlighted` item. An open SubTrigger keeps the highlight while the
 *   pointer is inside its submenu, which is its own panel.
 * - Only `transform` / `opacity` animate, on the motion tokens; size snaps.
 *   Reduced motion drops the slide (the global reduced-motion rule also zeroes
 *   the tokens, so the fade becomes a cut).
 * - Rows marked `data-menu-own-highlight` (callers that style their own
 *   focus / hover background) and disabled rows never receive the layer.
 * - The row under the layer carries `data-menu-active` (row weight / icon stroke key on
 *   it), so the row follows the layer even while the pointer is in a gap.
 * - Danger rows get the same grey layer as every other row; only their text is red.
 * - Pointer, key, focus and scroll input is coalesced into one update per animation
 *   frame; rows and their clipping ancestors are cached until the panel's children change.
 * - Panels that are not Radix menus (composer listboxes whose focus stays in the editor)
 *   pass `MenuHighlightOptions`: which row is current, which attributes mark it, and where
 *   their arrow keys are pressed. Without options the Radix behaviour above is unchanged.
 */

export const MENU_ROW_ATTR = 'data-menu-row';
export const MENU_OWN_HIGHLIGHT_ATTR = 'data-menu-own-highlight';
export const MENU_PANEL_ATTR = 'data-menu-panel';
export const MENU_HIGHLIGHT_LAYER_ATTR = 'data-menu-highlight-layer';
/** Set on the row under the highlight, so its weight / icon follow it (also between rows). */
export const MENU_ACTIVE_ROW_ATTR = 'data-menu-active';

/** A caller-supplied focus / hover / highlighted background keeps its own per-row effect. */
const OWN_HIGHLIGHT =
  /(?:^|\s)(?:[\w-]+:)*(?:focus|hover|focus-visible|data-\[highlighted\]|data-\[state=open\]):bg-/;
export function hasOwnHighlight(className: string | undefined): boolean {
  return !!className && OWN_HIGHLIGHT.test(className);
}

/** Row the keyboard points at, for panels whose current row is not Radix's highlighted item. */
export interface MenuHighlightOptions {
  /** Default: Radix's `data-highlighted` item, else an open SubTrigger. */
  current?: (rows: readonly HTMLElement[]) => HTMLElement | null | undefined;
  /** Row attributes whose changes re-read `current` (added to the Radix ones). */
  currentAttributes?: readonly string[];
  /** Key presses here also count as keyboard input (focus kept in an input outside the panel). */
  keyboardSource?: EventTarget;
}

/** Marks the current row of a composer list (its arrow keys stay in the editor). */
export const MENU_CURRENT_ROW_ATTR = 'data-menu-current';
/** `current` for lists that mark their current row with `data-menu-current`. */
export const currentMarkedRow: NonNullable<MenuHighlightOptions['current']> = (rows) =>
  rows.find((r) => r.hasAttribute(MENU_CURRENT_ROW_ATTR));
/** `current` for listboxes whose current option carries `aria-selected="true"`. */
export const currentSelectedOption: NonNullable<MenuHighlightOptions['current']> = (rows) =>
  rows.find((r) => r.getAttribute('aria-selected') === 'true');
/** `current` for lists that move real focus between rows (only keyboard-visible focus counts). */
export const currentFocusedRow: NonNullable<MenuHighlightOptions['current']> = (rows) => {
  const focused = document.activeElement;
  if (!(focused instanceof HTMLElement) || !focused.matches(':focus-visible')) return null;
  return rows.find((r) => r === focused || r.contains(focused));
};

const MOVE =
  'transform var(--motion-instant) var(--motion-ease-out), opacity var(--motion-instant) var(--motion-ease-out)';
const FADE_IN = 'opacity var(--motion-instant) var(--motion-ease-out)';
const FADE_OUT = 'opacity var(--motion-instant) var(--motion-ease-in)';

export function attachMenuHighlight(
  panel: HTMLElement,
  layer: HTMLElement,
  options: MenuHighlightOptions = {},
): () => void {
  let pointer: { x: number; y: number } | null = null;
  let input: 'pointer' | 'keyboard' = 'keyboard';
  let active: HTMLElement | null = null;
  const reduced = () =>
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Rows and each row's clipping ancestors are cached until the panel's children change.
  let rowCache: HTMLElement[] | null = null;
  let clipCache = new WeakMap<HTMLElement, HTMLElement[]>();
  const rows = () =>
    (rowCache ??= Array.from(panel.querySelectorAll<HTMLElement>(`[${MENU_ROW_ATTR}]`)).filter(
      (el) => el.closest(`[${MENU_PANEL_ATTR}]`) === panel,
    ));
  const clipAncestors = (el: HTMLElement) => {
    let list = clipCache.get(el);
    if (!list) {
      list = [];
      for (let a = el.parentElement; a && a !== panel; a = a.parentElement) {
        const o = getComputedStyle(a);
        if (o.overflowX !== 'visible' || o.overflowY !== 'visible') list.push(a);
      }
      clipCache.set(el, list);
    }
    return list;
  };
  const eligible = (el: HTMLElement | null | undefined): el is HTMLElement =>
    !!el &&
    el.isConnected &&
    !el.hasAttribute(MENU_OWN_HIGHLIGHT_ATTR) &&
    !el.hasAttribute('data-disabled');

  // Row box clipped by scroll containers inside the panel (e.g. a long project list), so
  // rows scrolled out of view neither win the pointer nor draw outside their list.
  const visibleBox = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    let { top, bottom, left, right } = r;
    for (const a of clipAncestors(el)) {
      const c = a.getBoundingClientRect();
      top = Math.max(top, c.top);
      bottom = Math.min(bottom, c.bottom);
      left = Math.max(left, c.left);
      right = Math.min(right, c.right);
    }
    return {
      top,
      bottom,
      left,
      right,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top),
    };
  };

  const place = (el: HTMLElement) => {
    const p = panel.getBoundingClientRect();
    const r = visibleBox(el);
    layer.style.width = `${r.width}px`;
    layer.style.height = `${r.height}px`;
    layer.style.transform = `translate(${r.left - p.left - panel.clientLeft + panel.scrollLeft}px, ${
      r.top - p.top - panel.clientTop + panel.scrollTop
    }px)`;
  };

  const show = (target: HTMLElement | null) => {
    if (target === active) return;
    active?.removeAttribute(MENU_ACTIVE_ROW_ATTR);
    target?.setAttribute(MENU_ACTIVE_ROW_ATTR, '');
    if (!target) {
      layer.style.transition = FADE_OUT;
      layer.style.opacity = '0';
      delete layer.dataset.row;
      delete layer.dataset.visible;
      active = null;
      return;
    }
    if (!active) {
      // Entering: start (invisibly) on the checked row, then glide to the target.
      const checked = rows().find((r) => r.getAttribute('data-state') === 'checked' && eligible(r));
      layer.style.transition = 'none';
      place(reduced() ? target : (checked ?? target));
      layer.style.opacity = '0';
      void layer.offsetWidth; // commit the start frame before transitioning
    }
    layer.style.transition = reduced() ? FADE_IN : MOVE;
    place(target);
    layer.style.opacity = '1';
    layer.dataset.row = String(rows().indexOf(target));
    layer.dataset.visible = 'true';
    active = target;
  };

  // Nearest row by vertical distance across the whole panel.
  const nearest = (x: number, y: number): HTMLElement | null => {
    const p = panel.getBoundingClientRect();
    if (x < p.left || x > p.right || y < p.top || y > p.bottom) return null;
    let best: HTMLElement | null = null;
    let dist = Infinity;
    for (const row of rows()) {
      const r = visibleBox(row);
      if (r.height <= 0) continue;
      const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
      if (d < dist) {
        dist = d;
        best = row;
      }
    }
    return best;
  };

  const update = () => {
    let target: HTMLElement | null;
    if (input === 'pointer' && pointer) target = nearest(pointer.x, pointer.y);
    else {
      const all = rows();
      target = options.current
        ? (options.current(all) ?? null)
        : (all.find((r) => r.hasAttribute('data-highlighted')) ??
          all.find((r) => r.getAttribute('data-state') === 'open') ??
          null);
    }
    show(eligible(target) ? target : null);
  };

  // Pointer moves, key presses, focus and scroll are coalesced into one update per frame.
  // Scrolling moves rows under a still layer, so that frame re-places it without a slide.
  let frame = 0;
  let replace = false;
  const flush = () => {
    frame = 0;
    if (replace && active) {
      layer.style.transition = 'none';
      place(active);
    }
    replace = false;
    update();
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(flush);
  };
  const onScroll = () => {
    replace = true;
    schedule();
  };
  const onMove = (e: PointerEvent) => {
    input = 'pointer';
    pointer = { x: e.clientX, y: e.clientY };
    schedule();
  };
  const onLeave = () => {
    pointer = null;
    input = 'keyboard';
    update();
  };
  const onKey = () => {
    input = 'keyboard';
    schedule();
  };
  const observer = new MutationObserver((records) => {
    if (records.some((r) => r.type === 'childList')) {
      rowCache = null;
      clipCache = new WeakMap();
    }
    if (input === 'keyboard' || !pointer || (active && !active.isConnected)) update();
  });
  observer.observe(panel, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['data-highlighted', 'data-state', 'data-disabled', ...(options.currentAttributes ?? [])],
  });
  panel.addEventListener('pointermove', onMove);
  panel.addEventListener('pointerleave', onLeave);
  panel.addEventListener('keydown', onKey, true);
  options.keyboardSource?.addEventListener('keydown', onKey, true);
  panel.addEventListener('focusin', schedule);
  // Capture: nested scroll containers do not bubble their scroll events.
  panel.addEventListener('scroll', onScroll, true);
  // A list that names its current row (focus kept in the editor) shows it from the start,
  // as its own row fill did; Radix menus have no highlighted item until the first input.
  if (options.current) schedule();
  return () => {
    active?.removeAttribute(MENU_ACTIVE_ROW_ATTR);
    cancelAnimationFrame(frame);
    observer.disconnect();
    panel.removeEventListener('pointermove', onMove);
    panel.removeEventListener('pointerleave', onLeave);
    panel.removeEventListener('keydown', onKey, true);
    options.keyboardSource?.removeEventListener('keydown', onKey, true);
    panel.removeEventListener('focusin', schedule);
    panel.removeEventListener('scroll', onScroll, true);
  };
}

/**
 * Locks a menu panel to its laid-out width so hover never widens it (a row turning 500,
 * or text the label reservation cannot reach, such as text inside caller components).
 * The width is the unscaled used width (getComputedStyle, not the open animation's
 * scaled box), so it satisfies the caller's own w-* / min-w-* / max-w-* rules and leaves
 * Radix positioning alone. It is re-measured when rows or text change (including search
 * filtering), when the window resizes and when late images or fonts load; reopening
 * mounts a new panel. A caller that
 * sets an inline width keeps full control.
 */
export function lockMenuWidth(panel: HTMLElement): () => void {
  if (panel.style.width) return () => {};
  let locked = false;
  const measure = () => {
    if (locked) panel.style.width = '';
    const width = getComputedStyle(panel).width;
    locked = /^\d/.test(width);
    if (locked) panel.style.width = width;
  };
  measure();
  let frame = 0;
  const schedule = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(measure);
  };
  const observer = new MutationObserver(schedule);
  observer.observe(panel, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['class'],
  });
  window.addEventListener('resize', schedule);
  // Late images (avatars, favicons) and web fonts change intrinsic widths too.
  panel.addEventListener('load', schedule, true);
  void document.fonts?.ready.then(schedule);
  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    window.removeEventListener('resize', schedule);
    panel.removeEventListener('load', schedule, true);
    if (locked) panel.style.width = '';
  };
}
