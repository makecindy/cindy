import { describe, expect, it, vi } from 'vitest';

import {
  fetchSingleHopWithSsrFGuard,
  fetchWithSsrFGuard,
} from '../shim/ssrf-runtime.js';
import {
  isBlockedHostnameOrIp,
  isPrivateIpAddress,
  resolvePinnedHostnameWithPolicy,
  type LookupFn,
} from '../_generated/leaf/src/infra/net/ssrf.js';

const FAKE_IP_POLICY = {
  allowRfc2544BenchmarkRange: true,
  allowIpv6UniqueLocalRange: true,
};

const lookupAddresses = (addresses: Array<{ address: string; family: 4 | 6 }>): LookupFn =>
  (async () => addresses) as unknown as LookupFn;

/**
 * These assert the REAL vendored SSRF decision logic (not our thin fetch shell)
 * still blocks the dangerous targets. If a future sync weakens these, the test
 * fails — which is exactly the regression guard we want around the security
 * teeth.
 */
describe('vendored SSRF decision primitives', () => {
  it('blocks cloud metadata IP', () => {
    expect(isBlockedHostnameOrIp('169.254.169.254')).toBe(true);
  });

  it('classifies RFC1918 / loopback as private', () => {
    expect(isPrivateIpAddress('127.0.0.1')).toBe(true);
    expect(isPrivateIpAddress('10.0.0.5')).toBe(true);
    expect(isPrivateIpAddress('192.168.1.10')).toBe(true);
  });

  it('does not flag a public IP as private', () => {
    expect(isPrivateIpAddress('8.8.8.8')).toBe(false);
  });

  it('allows an RFC 2544 proxy fake-IP DNS answer without enabling private networks', async () => {
    const resolved = await resolvePinnedHostnameWithPolicy('example.com', {
      policy: FAKE_IP_POLICY,
      lookupFn: lookupAddresses([{ address: '198.18.0.1', family: 4 }]),
    });

    expect(resolved.addresses).toEqual(['198.18.0.1']);
  });

  it('allows an IPv6 ULA proxy fake-IP DNS answer without enabling private networks', async () => {
    const resolved = await resolvePinnedHostnameWithPolicy('example.com', {
      policy: FAKE_IP_POLICY,
      lookupFn: lookupAddresses([{ address: 'fd00::1', family: 6 }]),
    });

    expect(resolved.addresses).toEqual(['fd00::1']);
  });

  it.each([
    ['cloud metadata', '169.254.169.254', 4],
    ['link-local', '169.254.1.1', 4],
    ['RFC1918', '10.0.0.5', 4],
  ] as const)(
    'still blocks %s DNS answers under the narrow fake-IP policy',
    async (_kind, address, family) => {
      await expect(
        resolvePinnedHostnameWithPolicy('example.com', {
          policy: FAKE_IP_POLICY,
          lookupFn: lookupAddresses([{ address, family }]),
        }),
      ).rejects.toThrow(/blocked/i);
    },
  );
});

describe('fetchWithSsrFGuard thin shell', () => {
  it('rejects non-http(s) schemes before any network access', async () => {
    await expect(
      fetchWithSsrFGuard({ url: 'file:///etc/passwd' }),
    ).rejects.toThrow(/non-http/i);
  });

  it('blocks cloud-metadata host via the vendored policy gate (default policy)', async () => {
    // Rejection comes from resolvePinnedHostnameWithPolicy (SsrFBlockedError),
    // not a separate pre-check.
    await expect(
      fetchWithSsrFGuard({ url: 'http://169.254.169.254/latest/meta-data/' }),
    ).rejects.toThrow(/blocked/i);
  });

  it('blocks a private IP when policy does not allow it', async () => {
    await expect(fetchWithSsrFGuard({ url: 'http://10.0.0.5/' })).rejects.toThrow(/blocked/i);
  });

  it('blocks a hostname whose pinned DNS answer is private before a single-hop fetch', async () => {
    await expect(
      fetchSingleHopWithSsrFGuard({
        url: 'https://public.example/data',
        lookupFn: lookupAddresses([{ address: '127.0.0.1', family: 4 }]),
      }),
    ).rejects.toThrow(/blocked/i);
  });

  it('revalidates only after DNS and dispatcher selection, then closes without dispatching', async () => {
    const events: string[] = [];
    const close = vi.fn(async () => undefined);
    await expect(
      fetchSingleHopWithSsrFGuard({
        url: 'https://public.example/data',
        lookupFn: (async () => {
          events.push('dns');
          return [{ address: '93.184.216.34', family: 4 }];
        }) as unknown as LookupFn,
        dispatcherFactory: async () => {
          events.push('dispatcher');
          return { close } as never;
        },
        beforeDispatch: () => {
          events.push('revalidate');
          throw new Error('authorization expired');
        },
      }),
    ).rejects.toThrow('authorization expired');

    expect(events).toEqual(['dns', 'dispatcher', 'revalidate']);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('does NOT block an allowlisted loopback host (regression: CDP control plane)', async () => {
    // With the host in allowedHostnames, the policy gate must pass it. We use a
    // port nothing listens on, so the only acceptable failure is a CONNECTION
    // error — never an SSRF block. This guards the bug the smoke test caught.
    await expect(
      fetchWithSsrFGuard({
        url: 'http://127.0.0.1:59999/',
        policy: { allowedHostnames: ['127.0.0.1'] },
        timeoutMs: 1500,
      }),
    ).rejects.not.toThrow(/blocked|not in allowlist/i);
  });
});
