import { hostOutbound } from './outbound.mjs';

/**
 * The fetch the Cindy auth client uses for login and session refresh (main.ts, login-cli.mjs): the
 * Host's outbound transport, so a proxy from the environment applies to these requests as to every
 * other Host request. Without a proxy it calls globalThis.fetch unchanged (outbound-fetch.ts).
 */
export const hostAuthFetch = (input, init) => hostOutbound.outboundFetch(input, init);
