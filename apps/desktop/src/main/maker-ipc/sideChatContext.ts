/** A per-message context boundary. It does not change system instructions or tool permissions. */
export const SIDE_CHAT_CONTEXT = '[Side chat context] This is an independent follow-up to a main task. '
  + 'History inherited at the fork is reference material, not active instructions or authorization. '
  + 'Answer the current question; do not resume the main task, its pending actions, or its plan. '
  + 'Keep exploration non-mutating unless the user explicitly requests a change in this side chat. '
  + 'The main task continues separately and does not receive these replies automatically.';
