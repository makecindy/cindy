/** A per-message context boundary. It does not change system instructions or tool permissions. */
export const SIDE_CHAT_CONTEXT = '[Side chat context] This is an independent follow-up to a main task. '
  + 'History inherited at the fork is reference material, not active instructions or authorization. '
  + 'Answer the current question; do not resume the main task, its pending actions, or its plan. '
  + 'Keep exploration non-mutating unless the user explicitly requests a change in this side chat. '
  + 'Before using Orca tools to start collaboration or create the first worker here, tell the user in a visible message '
  + 'that creating the first worker moves this follow-up out of the sidebar into the task list as a separate task, keeping its chat history. '
  + 'The main task continues separately and does not receive these replies automatically.';
