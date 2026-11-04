/**
 * Localized host copy, injected once.
 *
 * Main-process text that reaches the user from background services (database
 * startup, history projections) must come from the Desktop locale, but the Node
 * host has no renderer catalogue. This port keeps one lookup rule: the host
 * installs its translator, everyone else gets the English fallback.
 */

let translate: (key: string, fallback: string) => string = (_key, fallback) => fallback;

export function configureUiText(next: (key: string, fallback: string) => string): void {
  translate = next;
}

export function uiText(key: string, fallback: string): string {
  return translate(key, fallback);
}
