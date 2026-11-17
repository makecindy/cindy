/**
 * Text an API client may receive for a failed request.
 *
 * An Error's message is part of the client contract: typed `[CODE] message`
 * errors reach the web client this way. Any other thrown value has no such
 * contract and may stringify to a stack or an internal path, so it is never
 * serialised.
 *
 * @param {unknown} error
 * @returns {string}
 */
export function clientErrorMessage(error) {
  return error instanceof Error ? error.message : 'Unexpected error';
}
