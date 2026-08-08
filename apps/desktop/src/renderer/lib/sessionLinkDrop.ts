/**
 * Task deep-link drag payload shared by sidebar drag sources and composers.
 * The split-pane MIME remains feature-local; this payload is intentionally
 * generic so ChatInput does not depend on the cc-agent feature module.
 */
export const SESSION_LINK_DROP_MIME = 'application/x-cindy-session-link';
export const SESSION_LINK_DROP_TARGET_SELECTOR =
  '[data-split-group-composer-drop-target]';

export function isSessionLinkDropTarget(target: EventTarget | null): boolean {
  const element = typeof Element !== 'undefined' && target instanceof Element ? target : null;
  return Boolean(element?.closest(SESSION_LINK_DROP_TARGET_SELECTOR));
}
