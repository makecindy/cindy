/**
 * Interaction Prompt Portal — lift permission / askUser / plan cards out of
 * narrow chat rails into a wider host slot.
 *
 * Public API:
 *   - <InteractionPromptHost hasInteraction placeholder={...}>{cards}</>
 *     wraps the cards. Renders inline unless a slot is mounted.
 *   - <InteractionPromptSlot />
 *     drop in a layout where there's room. Single-slot policy.
 */

export { InteractionPromptHost } from './InteractionPromptHost';
export { InteractionPromptSlot } from './InteractionPromptSlot';
export {
  InteractionPromptCardShell,
  type InteractionPromptViewerState,
} from './InteractionPromptCardShell';
