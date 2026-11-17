/**
 * Coexistence plan A (reviewer, 2026-11-17): while a Cindy desktop app running on its own uses this
 * profile, the Host writes no credential the desktop shares. The Cindy account session renewal is
 * the one exception (the Host would sign itself out otherwise; release table, coexistence row).
 *
 * One place for the decision and the words, for the credentials whose renewal goes out through a
 * fetch the Host passes (custom provider OAuth, plugin OAuth): while held that request is answered
 * here, before it reaches the network, so no refresh token is spent or rotated, and the owner of the
 * fetch sees an ordinary refused renewal (it writes nothing and marks nothing expired). Credentials
 * with their own Host wrapper (Codex: codex-runtime.ts, xAI: xai-held-login.ts) use the same words.
 */
import { HOST_PROFILE_IN_USE_BY_DESKTOP } from './profile-coexistence.js';

/** `HOST_PROFILE_IN_USE_BY_DESKTOP: <what> while a Cindy desktop app … Quit that app, then try again.` */
export function heldCredentialMessage(what: string): string {
  return `${HOST_PROFILE_IN_USE_BY_DESKTOP}: ${what} while a Cindy desktop app running on its own uses this data `
    + '(both would renew the same sign-in). Quit that app, then try again.';
}

/** The refusal a held credential request gets, as an Error. */
export function heldCredentialError(what: string): Error {
  return new Error(heldCredentialMessage(what));
}

/**
 * A fetch that, while held, answers 503 with an OAuth error body naming the reason instead of
 * sending the request. Released, it is the fetch it wraps.
 */
export function holdCredentialFetch<F extends (input: any, init?: any) => Promise<Response>>(fetchImpl: F, isProfileHeld: () => boolean, what: string): F {
  return (async (input: unknown, init?: unknown) => {
    if (!isProfileHeld()) return fetchImpl(input, init);
    return new Response(JSON.stringify({ error: HOST_PROFILE_IN_USE_BY_DESKTOP, error_description: heldCredentialMessage(what) }),
      { status: 503, headers: { 'content-type': 'application/json' } });
  }) as F;
}
