/**
 * Process-local composer actions shared by distant message and input views.
 * The target session id keeps concurrent chat panes from consuming each
 * other's insert requests.
 */

const INSERT_SESSION_LINK_EVENT = 'cindy-composer-insert-session-link';

/** A request to insert one conversation/message deep link into a composer. */
export interface InsertSessionLinkDetail {
  targetSessionId: string;
  href: string;
}

export function insertSessionLinkIntoComposer(detail: InsertSessionLinkDetail): void {
  window.dispatchEvent(
    new CustomEvent<InsertSessionLinkDetail>(INSERT_SESSION_LINK_EVENT, { detail }),
  );
}

export function subscribeSessionLinkInsert(
  handler: (detail: InsertSessionLinkDetail) => void,
): () => void {
  const wrapped = (event: Event) => {
    handler((event as CustomEvent<InsertSessionLinkDetail>).detail);
  };
  window.addEventListener(INSERT_SESSION_LINK_EVENT, wrapped);
  return () => window.removeEventListener(INSERT_SESSION_LINK_EVENT, wrapped);
}

const INSERT_PROMPT_EVENT = 'cindy-composer-insert-prompt';

/**
 * A request to prefill plain prompt text into a composer. The composer only
 * inserts and focuses; the user still decides whether to send.
 */
export interface InsertPromptDetail {
  targetSessionId: string;
  text: string;
}

export function insertPromptIntoComposer(detail: InsertPromptDetail): void {
  window.dispatchEvent(new CustomEvent<InsertPromptDetail>(INSERT_PROMPT_EVENT, { detail }));
}

export function subscribePromptInsert(handler: (detail: InsertPromptDetail) => void): () => void {
  const wrapped = (event: Event) => {
    handler((event as CustomEvent<InsertPromptDetail>).detail);
  };
  window.addEventListener(INSERT_PROMPT_EVENT, wrapped);
  return () => window.removeEventListener(INSERT_PROMPT_EVENT, wrapped);
}
