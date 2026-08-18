/**
 * Shared types for the help-assistant IPC contract.
 *
 * Both main (maker-ipc/help.ts) and renderer (helpThreadStore, preload,
 * vite-env.d.ts) import from this shared file to keep main ↔ renderer contracts
 * in one place. The help assistant is a single multi-turn chat thread: the
 * renderer owns the thread and sends the full message history with each ask;
 * main turns that history into a prompt and returns one assistant answer.
 */

export type HelpLocale = 'zh-CN' | 'zh-TW' | 'en' | 'ja' | 'ko';

export type HelpRole = 'user' | 'assistant';

/** Settings tabs the assistant is allowed to deep-link to. Inlined here (not
 *  imported from renderer/lib/tabLabels) so the shared contract has no renderer
 *  dependency. main validates LLM-emitted tab ids against this same set. */
export type HelpTabId =
  | 'general'
  | 'personalization'
  | 'api-keys'
  | 'providers'
  | 'voice-input'
  | 'import'
  | 'connections'
  | 'im-bot'
  | 'about'
  // 'ghosts' (Plugins settings tab) and 'remote-control' (Remote & device control)
  // are real deep-link targets. 'api-keys' / 'connections' remain aliases that
  // SettingsView rewrites to the Plugins tab.
  | 'ghosts'
  | 'remote-control';

export type HelpAction = { kind: 'settings-tab'; tab: HelpTabId } | { kind: 'none' };

export interface HelpMessage {
  /** Stable identifier for this message within the thread. Renderer-only
   *  invariant: the renderer-side store generates ids on append and backfills
   *  on hydrate; main-side IPC handlers don't read this field. Used as
   *  React key and as the feedback-draft target (instead of the array index
   *  which is unsafe across truncation). Optional in the type for backward
   *  compat with persisted threads that pre-date this field. */
  id?: string;
  role: HelpRole;
  content: string;
  /** Only assistant messages may carry one, used to render the jump button. */
  action?: HelpAction;
  /** If the user reported this assistant answer as unhelpful, the id of the
   *  locally-saved feedback draft. Persisted with the thread so the "feedback
   *  recorded" indicator survives reopens / restarts. Assistant messages only. */
  feedbackDraftId?: string;
}

export interface HelpAskRequest {
  /** At least 1 message; the last one must be a user message. */
  messages: HelpMessage[];
  locale: HelpLocale;
}

export type HelpAnswerResult =
  { kind: 'ai'; answer: string; action?: HelpAction } | { kind: 'no-answer' };

/**
 * User-flagged "this answer didn't help" draft.
 *
 * Phase 1 (current): drafts live in `<userData>/help-feedback-drafts.json` only.
 * Phase 2 (planned): a "submit to GitHub" action turns drafts into real issues
 * (with dedup against existing open issues). Schema is shaped so adding a
 * `submittedIssueUrl?: string` later is non-breaking.
 */
export interface HelpFeedbackDraftInput {
  /** The question the user asked (the assistant message's preceding user turn). */
  question: string;
  /** The assistant's answer (may be empty string for the no-answer fallback). */
  answer: string;
  /** User-editable title (form default: "doc gap: <truncated question>"). */
  title: string;
  /** User-editable body — typically the structured template with question /
   *  answer / what's wrong sections. */
  body: string;
  locale: HelpLocale;
}

export interface HelpFeedbackDraft extends HelpFeedbackDraftInput {
  id: string;
  /** ISO timestamp set by main on create. */
  createdAt: string;
}

/** Hard cap on how many messages we keep / send. Beyond this we drop the
 *  oldest turns, keeping the tail aligned so each assistant in the result
 *  still has its paired user message as its immediate predecessor. */
export const MAX_HELP_MESSAGES = 12;

/**
 * Shared truncation so persistence (renderer), UI render (renderer) and prompt
 * assembly (main) all see the exact same history window — otherwise the model
 * could answer against a different history than what the user sees.
 *
 * Behavior: keep the last MAX_HELP_MESSAGES entries, but drop any leading
 * assistant rows from that tail so the first row is always a user message.
 * That preserves user/assistant pairing — important because the UI looks up
 * "the paired question for this assistant turn" by `messages[index - 1]` when
 * prefilling the feedback draft. If we kept a stray opening user message
 * (the previous design did) but the tail itself started with an assistant,
 * that assistant would silently get the OLD opening question as its "prior",
 * which is wrong.
 *
 * Trade-off: very long help threads (>12 messages) lose the very first
 * question. That's fine for help-assistant context — recent turns carry
 * the user's current intent, and help queries are typically self-contained.
 */
export function truncateHelpHistory(messages: HelpMessage[]): HelpMessage[] {
  if (messages.length <= MAX_HELP_MESSAGES) return messages;
  const tail = messages.slice(-MAX_HELP_MESSAGES);
  const firstUserInTail = tail.findIndex((m) => m.role === 'user');
  return firstUserInTail >= 0 ? tail.slice(firstUserInTail) : tail;
}
