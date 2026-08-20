/**
 * Compact activity-row chrome shared by tool rows, work-group thinking rows,
 * and system interruption rows. Mixed lists must share one trailing-triangle
 * slot, one hover lift, and one radius — two languages in the same column
 * read as drift. Radius is DESIGN.md §5 inner-control 8px. Do not use the
 * lg radius utility: it compiles to an undefined theme variable and is dropped.
 */

/** Compact row surface radius. Pair with padding on the clickable row. */
export const ACTIVITY_ROW_RADIUS_CLASS = 'rounded-[8px]';

/** Row surface that lifts on hover. Pair with `group` on the clickable row. */
export const ACTIVITY_ROW_HOVER_SURFACE_CLASS = 'hover:bg-[var(--msg-code-inline-bg)]';

/** Color hover. DESIGN.md §14.4: new transitions must cite motion tokens;
 *  `transition-colors` alone uses Tailwind's hardcoded duration/easing. */
export const ACTIVITY_ROW_COLOR_TRANSITION_CLASS =
  'transition-colors duration-[var(--motion-fast,150ms)] ease-[var(--motion-ease-out)]';

/** Fixed 18×18 trailing chevron slot. Always reserve the column; hover paints
 *  the small rounded well behind the glyph (`group-hover` on the row). */
export const ACTIVITY_ROW_CHEVRON_SLOT_CLASS =
  `ml-auto flex h-[18px] w-[18px] shrink-0 items-center justify-center ${ACTIVITY_ROW_RADIUS_CLASS} ${ACTIVITY_ROW_COLOR_TRANSITION_CLASS} text-[var(--msg-tool-card-chevron)] group-hover:bg-[var(--cmd-palette-item-hover)]`;
