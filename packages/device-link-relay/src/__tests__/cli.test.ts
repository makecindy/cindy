/**
 * #10562: production CLI must separate public ACME from its loopback API.
 * The existing certificate tests do not execute CLI argument wiring. Stop at the
 * listener boundary so unit tests never contact a CA or bind a public socket.
 * Minimal input: serve --host 127.0.0.1 --acme-identifier relay.invalid.
 * Separate fixture: CLI has process side effects unlike CertificateManager tests.
 */
import { afterEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  listen: vi.fn(async (_options: unknown) => { throw new Error('test-stop-before-CA'); }),
  lookup: vi.fn(async (host: string) => ({ address: host === 'v6-only.invalid' ? '::1' : '127.0.0.1', family: host === 'v6-only.invalid' ? 6 : 4 })),
}));
vi.mock('../certificates', () => ({ CertificateManager: class { challenges = new Map(); }, startChallengeServer: h.listen }));
vi.mock('node:dns/promises', () => ({ lookup: h.lookup }));

afterEach(() => { vi.restoreAllMocks(); h.listen.mockClear(); h.lookup.mockClear(); });

it.each([
  ['127.0.0.1', 'relay.invalid', [], '0.0.0.0'],
  ['127.0.0.1', 'relay.invalid', ['--acme-http-host', '127.0.0.1'], '127.0.0.1'],
  ['127.0.0.1', 'relay.invalid', ['--acme-http-host', '::'], '::'],
  // Existing IPv6 CLI invocations omit the new flag; loopback APIs must still
  // allow public challenges in the address family of the host or identifier.
  ['::', 'relay.invalid', [], '::'],
  ['::1', 'relay.invalid', [], '::'],
  ['127.0.0.1', '2001:db8::1', [], '::'],
  ['::', 'relay.invalid', ['--acme-http-host', '0.0.0.0'], '0.0.0.0'],
  ['v6-only.invalid', 'relay.invalid', [], '::'],
  ['v4-only.invalid', 'relay.invalid', [], '0.0.0.0'],
  ['v6-only.invalid', 'relay.invalid', ['--acme-http-host', '127.0.0.1'], '127.0.0.1'],
])('uses an independent ACME bind address for API %s / identifier %s', async (host, identifier, extra, expected) => {
  const argv = process.argv, exitCode = process.exitCode;
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    process.argv = ['node', 'relay', 'serve', '--data', 'unused-cli-test', '--host', host,
      '--acme-identifier', identifier, ...extra];
    // reset-modules: each CLI invocation must parse a fresh argv, as a separate process would.
    vi.resetModules();
    await import('../cli');
    await vi.waitFor(() => expect(h.listen).toHaveBeenCalledWith(expect.objectContaining({ host: expected, port: 80 })));
    if (host.endsWith('.invalid') && extra.length === 0) expect(h.lookup).toHaveBeenCalledWith(host);
    else expect(h.lookup).not.toHaveBeenCalled();
  } finally { process.argv = argv; process.exitCode = exitCode; }
});

it('reports an unresolvable API hostname before opening a challenge listener', async () => {
  const argv = process.argv, exitCode = process.exitCode;
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  h.lookup.mockRejectedValueOnce(new Error('synthetic DNS failure'));
  try {
    process.argv = ['node', 'relay', 'serve', '--data', 'unused-cli-test', '--host', 'missing.invalid',
      '--acme-identifier', 'relay.invalid'];
    // reset-modules: exercise a separate CLI launch with failing DNS and fresh argv.
    vi.resetModules();
    await import('../cli');
    await vi.waitFor(() => expect(process.exitCode).toBe(1));
    expect(output).toHaveBeenCalledWith(expect.stringContaining('synthetic DNS failure'));
    expect(h.listen).not.toHaveBeenCalled();
  } finally { process.argv = argv; process.exitCode = exitCode; }
});
