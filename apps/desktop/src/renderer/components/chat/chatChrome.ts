/**
 * Shared chat presentation. Callers retain their local theme aliases and own
 * content, visibility, async actions and media/file lifecycles.
 * Sizes/spacing/motion use the DS-8 generated scales. The compact code offset
 * remains relative to the user's runtime code size; Diff measures that size.
 */
export const CHAT_BODY_CLASS = 'text-15 font-normal leading-[1.6]';
export const CHAT_CODE_CLASS =
  'font-mono text-[length:var(--app-code-font-size)] leading-normal';
export const CHAT_COMPACT_CODE_CLASS =
  'font-mono text-[length:calc(var(--app-code-font-size)_-_1px)] leading-normal';
export const CHAT_CODE_SURFACE_CLASS =
  'select-text rounded-xl border border-[var(--msg-code-block-border)] bg-[var(--msg-code-block-bg)]';

export const CHAT_FOCUS_CLASS =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]';
export const CHAT_COLOR_TRANSITION_CLASS =
  'transition-colors duration-[var(--motion-fast)] ease-[var(--motion-ease-out)] motion-reduce:transition-none';
export const CHAT_CHEVRON_TRANSITION_CLASS =
  'transition-transform duration-[var(--motion-fast)] ease-[var(--motion-ease-out)] motion-reduce:transition-none';

/** Icon actions keep their contextual 24/28/32px targets, all with pill chrome. */
export const CHAT_ICON_BUTTON_CLASS =
  `inline-flex shrink-0 items-center justify-center rounded-full cursor-pointer ${CHAT_COLOR_TRANSITION_CLASS} ${CHAT_FOCUS_CLASS} disabled:cursor-default disabled:opacity-60`;

/** Text and tool previews share toolbar geometry and local hover feedback. */
export const CHAT_LIGHTBOX_ICON_BUTTON_CLASS =
  `${CHAT_ICON_BUTTON_CLASS} h-8 w-8 enabled:hover:bg-[var(--msg-code-inline-bg)]`;

/** Music and sound effects share the same inverted play/pause control. */
export const CHAT_MEDIA_PLAY_BUTTON_CLASS =
  `${CHAT_ICON_BUTTON_CLASS} h-7 w-7 bg-[var(--msg-tool-card-text)] text-[var(--msg-tool-card-bg)] enabled:hover:bg-[color-mix(in_srgb,var(--msg-tool-card-text)_90%,var(--msg-tool-card-bg))] enabled:active:bg-[color-mix(in_srgb,var(--msg-tool-card-text)_80%,var(--msg-tool-card-bg))]`;
