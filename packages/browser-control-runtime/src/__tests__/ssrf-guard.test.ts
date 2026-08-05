import { describe, expect, it } from 'vitest';

import { fetchWithSsrFGuard } from '../shim/ssrf-runtime.js';
import {
  isBlockedHostnameOrIp,
  isPrivateIpAddress,
} from '../_generated/leaf/src/infra/net/ssrf.js';

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

  it('does NOT block an allowlisted loopback host (regression: CDP control plane)', async () => {
    // With the host in allowedHostnames, the policy gate must pass it. We use a
    // port nothing listens on, so the only acceptable failure is a CONNECTION
    // error — never an SSRF block. This guards the bug the smoke test caught.
    await expect(
      fetchWithSsrFGuard({
        url: 'http://127.0.0.1:59999/',
        policy: { allowedHostnames: ['127.0.0.1'], dangerouslyAllowPrivateNetwork: true },
        timeoutMs: 1500,
      }),
    ).rejects.not.toThrow(/blocked|not in allowlist/i);
  });
});
