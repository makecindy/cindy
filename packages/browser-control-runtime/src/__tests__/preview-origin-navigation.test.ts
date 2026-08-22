import { describe, expect, it } from 'vitest';

import { assertBrowserNavigationAllowed } from '../_generated/extension/src/browser/navigation-guard.js';

/**
 * Exact-origin navigation allowance for the local HTML preview server.
 *
 * The preview server binds an ephemeral loopback port and the host puts that
 * ONE origin into `ssrfPolicy.allowedOrigins`. Loopback is otherwise blocked as
 * private network, so these assertions are what make the feature work at all —
 * and, just as importantly, what keeps it from turning into "trust every local
 * port". If a future sync drops the `resolveSsrFPolicyForUrl` call from the
 * navigation guard, the first test here fails and previews stop opening;
 * without the second test a regression could silently widen the allowance to
 * the whole loopback interface, which would expose the managed browser's own
 * CDP port to page-initiated navigation.
 */
describe('preview origin navigation allowance', () => {
  const PREVIEW_PORT = 54321;
  const PREVIEW_ORIGIN = `http://127.0.0.1:${PREVIEW_PORT}`;
  const TOKEN = 'a'.repeat(64);
  const previewUrl = `${PREVIEW_ORIGIN}/preview/${TOKEN}/index.html`;

  /** Mirrors what buildManagedConfig() installs while a preview is live. */
  const previewPolicy = {
    allowRfc2544BenchmarkRange: true,
    allowIpv6UniqueLocalRange: true,
    allowedOrigins: [PREVIEW_ORIGIN],
  };

  /** Same config with no preview running. */
  const basePolicy = {
    allowRfc2544BenchmarkRange: true,
    allowIpv6UniqueLocalRange: true,
  };

  it('allows navigation to the exact preview origin', async () => {
    await expect(
      assertBrowserNavigationAllowed({ url: previewUrl, ssrfPolicy: previewPolicy }),
    ).resolves.toBeUndefined();
  });

  it('blocks the same loopback host on a DIFFERENT port', async () => {
    // 18800 is the managed browser's own CDP port: reaching it from a page
    // would hand over control of the browser and every logged-in session in it.
    await expect(
      assertBrowserNavigationAllowed({
        url: 'http://127.0.0.1:18800/json/list',
        ssrfPolicy: previewPolicy,
      }),
    ).rejects.toThrow();
  });

  it('blocks a different loopback host on the preview port', async () => {
    await expect(
      assertBrowserNavigationAllowed({
        url: `http://127.0.0.2:${PREVIEW_PORT}/preview/${TOKEN}/index.html`,
        ssrfPolicy: previewPolicy,
      }),
    ).rejects.toThrow();
  });

  it('blocks the preview URL itself once the origin grant is gone', async () => {
    // Revocation path: dispose()/backend switch clears allowedOrigins, after
    // which the very same URL must go back to being blocked private network.
    await expect(
      assertBrowserNavigationAllowed({ url: previewUrl, ssrfPolicy: basePolicy }),
    ).rejects.toThrow();
  });

  it('does not widen the allowance to other private ranges', async () => {
    for (const url of [
      'http://10.0.0.1/',
      'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data/',
    ]) {
      await expect(
        assertBrowserNavigationAllowed({ url, ssrfPolicy: previewPolicy }),
      ).rejects.toThrow();
    }
  });
});
