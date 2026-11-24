import { net } from 'electron';

/**
 * Electron `net.fetch` for Bearer-authenticated Cindy server APIs, without session cookies.
 *
 * TLS-inspecting gateways (e.g. Cisco Umbrella SWG) set a probe cookie and treat clients
 * that send it back as browsers, redirecting them to an identity page; JSON endpoints then
 * answer 200 text/html. These APIs never use cookies, so they must not send them.
 */
export const cookielessNetFetch: typeof fetch = (input, init) =>
  net.fetch(input instanceof URL ? input.href : input, { ...init, credentials: 'omit' });
