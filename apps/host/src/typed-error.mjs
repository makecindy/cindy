/**
 * The HTTP status a typed error (createIpcError: `[CODE] message` with `error.code === CODE`) answers
 * with on the Host's request entries: the IPC route (ipc-route.mjs) and the server's catch for the
 * other /api, /sessions and /chat entries (server.mjs). One table and one decision for both.
 *
 * - The request itself was valid and the task's current state refuses it (its context window or
 *   usage, a turn running, a credential switch in progress, a route not usable now): 409, as
 *   PRECONDITION_FAILED. Clients handle it by its code; it is not a server failure.
 * - Anything else, or an error that is not typed exactly, is the caller's 500.
 */
export const STATUS_BY_CODE = Object.freeze({
  INVALID_PARAMS: 400,
  PERMISSION_DENIED: 403,
  NOT_FOUND: 404,
  PRECONDITION_FAILED: 409,
  OWNER_CHANGED: 409,
  UNSUPPORTED_CAPABILITY: 501,
  // A model change refused by the task's state (sessionRuntimeSelectionApply.ts).
  CREDENTIAL_SWITCH_BUSY: 409,
  MODEL_CONTEXT_USAGE_UNKNOWN: 409,
  MODEL_SELECTION_UNAVAILABLE: 409,
  MODEL_SWITCH_TASK_RUNNING: 409,
  MODEL_WINDOW_CURRENT_CONTEXT_UNKNOWN: 409,
  MODEL_WINDOW_PREPARATION_IN_PROGRESS: 409,
  MODEL_WINDOW_PROTECTION_UNAVAILABLE: 409,
  MODEL_WINDOW_REMOTE_REBUILD_UNSUPPORTED: 409,
  MODEL_WINDOW_TARGET_CONTEXT_UNKNOWN: 409,
});

const CODED_ERROR = /^\[([A-Z][A-Z0-9_]*)\] ([\s\S]*)$/;

/**
 * A typed error's code and message, or null. Typed means all of: `error.code` is a string, the message
 * is `[CODE] message`, and the two codes are the same. Nothing else is serialised to a client.
 *
 * @param {unknown} error
 * @returns {{ code: string, message: string } | null}
 */
export function parseTypedError(error) {
  const code = typeof error?.code === 'string' ? error.code : null;
  const match = error instanceof Error ? CODED_ERROR.exec(error.message) : null;
  if (!code || !match || match[1] !== code) return null;
  return { code, message: match[2] };
}

/**
 * The status of a typed error whose code is in the table, or null (the caller's 500).
 *
 * @param {string} code
 * @returns {number | null}
 */
export function typedErrorStatus(code) {
  return Object.hasOwn(STATUS_BY_CODE, code) ? STATUS_BY_CODE[code] : null;
}
