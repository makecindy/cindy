# UI, UX, and Copy Rules

Use this template only for products with interfaces. Delete sections that do not apply;
do not keep empty rules.

## Design Source of Truth

- Keep one authoritative design document at DESIGN_RULES.
- Root-level design entry files may navigate, but must not duplicate values.
- Every visual value uses a semantic token instead of a raw color, duration, curve, radius,
  or spacing constant.
- New token requests require a named use case and coverage across supported themes.

## Delivery Gate

- Implement every supported theme mode in the same change.
- Cover touched states: default, hover, pressed, focus, selected, disabled, loading, empty,
  error, overlay, and reduced-motion variants.
- Reusing themed styles is not evidence that both modes were visually verified.
- Report exactly which modes and platforms were checked; leave the rest marked unverified.

## Interaction Baseline

- Focus enters the primary input or primary action when a dialog opens, not Cancel.
- Content users may copy remains selectable; controls and chrome remain non-selectable.
- Enter submits send-type fields, Shift+Enter inserts a newline, and IME composition does
  not submit accidentally.
- Motion explains state; decorative flying, bouncing, looping, and attention-seeking motion
  require a recorded exception.
- Destructive or hard-to-reverse actions identify the object and require confirmation.

## Copy Rules

- Buttons and menus use verb plus object; avoid bare OK, Confirm, or Submit.
- Errors state what happened and what to do next.
- Loading states use present continuous plus ellipsis.
- Results name the changed object; avoid filler such as success.
- Empty states point to the next action.
- All user-visible copy goes through i18n; terminology follows the project glossary.
- Keep punctuation, casing, politeness, pluralization, units, and ellipses language-specific.

## Review Evidence

Interface changes should include screenshots or recordings for affected states and note
platform, theme mode, locale, and reduced-motion setting where relevant. When visual
verification was not possible, say so instead of claiming token reuse as verification.
