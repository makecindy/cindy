/**
 * #10562: production CLI must separate public ACME from its loopback API.
 * The existing certificate tests do not execute CLI argument wiring. Stop at the
 * listener boundary so unit tests never contact a CA or bind a public socket.
 * Minimal input: serve --host 127.0.0.1 --acme-identifier relay.invalid.
 * Separate fixture: CLI has process side effects unlike CertificateManager tests.
 */
import { afterEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ listen: vi.fn(async (_options: unknown) => { throw new Error('test-stop-before-CA'); }) }));
vi.mock('../certificates', () => ({ CertificateManager: class { challenges = new Map(); }, startChallengeServer: h.listen }));

afterEach(() => { vi.restoreAllMocks(); h.listen.mockClear(); });

it.each([
  [[], '0.0.0.0'],
  [['--acme-http-host', '127.0.0.1'], '127.0.0.1'],
  [['--acme-http-host', '::'], '::'],
])('uses an independent ACME bind address: %j', async (extra, expected) => {
  const argv = process.argv, exitCode = process.exitCode;
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    process.argv = ['node', 'relay', 'serve', '--data', 'unused-cli-test', '--host', '127.0.0.1',
      '--acme-identifier', 'relay.invalid', ...extra];
    // reset-modules: each CLI invocation must parse a fresh argv, as a separate process would.
    vi.resetModules();
    await import('../cli');
    expect(h.listen).toHaveBeenCalledWith(expect.objectContaining({ host: expected, port: 80 }));
  } finally { process.argv = argv; process.exitCode = exitCode; }
});
