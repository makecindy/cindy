/**
 * Compact activity-row chrome shared by tool rows, work-group thinking rows,
 * and system interruption rows. Mixed lists must share one trailing-triangle
 * slot, one hover lift, and one radius — two languages in the same column
 * read as drift. Radius is DESIGN.md §5 inner-control 8px (`rounded-lg`):
 * these rows are not pills, and 4px / 6px are not on the scale.
 */

/** Compact row surface radius. Pair with padding on the clickable row. */
export const ACTIVITY_ROW_RADIUS_CLASS = 'rounded-lg';

/** Row surface that lifts on hover. Pair with `group` on the clickable row. */
export const ACTIVITY_ROW_HOVER_SURFACE_CLASS = 'hover:bg-[var(--msg-code-inline-bg)]';

/** Fixed 18×18 trailing chevron slot. Always reserve the column; hover paints
 *  the small rounded well behind the glyph (`group-hover` on the row). */
export const ACTIVITY_ROW_CHEVRON_SLOT_CLASS =
  'ml-auto flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-lg text-[var(--msg-tool-card-chevron)] transition-colors group-hover:bg-[var(--cmd-palette-item-hover)]';
