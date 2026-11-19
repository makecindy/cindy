import { describe, expect, it, vi } from 'vitest';
import type { RemoteForward } from '@cindy/maker-remote-ssh';

import { createPiRemoteProviderForwardLease, probePiRemoteProviderEndpoint } from '../pi-remote-provider-forward';

// #9148: unit coverage for the production SSH probe boundary. Previously no probe
// existed. Verify credential stripping, bounded/no-redirect execution and failure
// semantics here; a separate local integration executes this command against HTTP.
describe('Pi remote provider reachability', () => {
  it.each(['http://127.0.0.1:23425', 'https://[::1]:23425', 'http://localhost:23425'])(
    'probes only the configured execution-host origin: %s', async (origin) => {
      const exec = vi.fn(async () => ({ stdout: '401', stderr: '', exitCode: 0, signal: null }));
      expect(await probePiRemoteProviderEndpoint({ exec }, origin.replace('://', '://user:invalid-test-secret@') + '/private?token=invalid-test-secret#fragment')).toBe(true);
      const [command, options] = exec.mock.calls[0]! as unknown as [string, Record<string, unknown>];
      expect(command).toContain(`'${origin}/'`);
      expect(command).not.toMatch(/invalid-test-secret|private|fragment/);
      expect(command).toContain('curl --disable');
      expect(command).toContain('--noproxy');
      expect(command).not.toContain('--location');
      expect(options).toMatchObject({ timeoutMs: 5000, maxOutputBytes: 1024 });
    });

  it.each([
    { stdout: '000', exitCode: 7 }, { stdout: '200', exitCode: 28 },
    { stdout: '200\n200', exitCode: 0 }, { stdout: '200', exitCode: 0, truncated: true },
  ])('rejects failed or malformed probe responses: %j', async (result) => {
    const exec = vi.fn(async () => ({ stderr: '', signal: null, ...result }));
    expect(await probePiRemoteProviderEndpoint({ exec }, 'http://127.0.0.1:23425/v1')).toBe(false);
  });

  it.each(['http://example.test', 'http://127.example.test', 'file:///etc/passwd', 'http://0.0.0.0:1234', 'not a URL'])(
    'does not execute a probe for unsupported targets: %s', async (baseUrl) => {
      const exec = vi.fn();
      expect(await probePiRemoteProviderEndpoint({ exec }, baseUrl)).toBe(false);
      expect(exec).not.toHaveBeenCalled();
    });

  it('keeps SSH errors private and fail-closed', async () => {
    const exec = vi.fn(async () => { throw new Error('remote command failed'); });
    expect(await probePiRemoteProviderEndpoint({ exec }, 'http://127.0.0.1:23425')).toBe(false);
  });
});

describe('Pi remote provider forward lease', () => {
  it('gives overlapping transport wrappers independent handles for the same tunnel', async () => {
    const closeOld = vi.fn(async () => undefined);
    const closeReplacement = vi.fn(async () => undefined);
    const handles: RemoteForward[] = [
      { remotePort: 43121, close: closeOld },
      { remotePort: 43121, close: closeReplacement },
    ];
    const ensureRemoteForward = vi.fn(async () => handles.shift()!);
    const oldLease = createPiRemoteProviderForwardLease(ensureRemoteForward);
    const replacementLease = createPiRemoteProviderForwardLease(ensureRemoteForward);
    const spec = { localUrl: 'http://127.0.0.1:43120', remotePort: 43121 };

    await oldLease.ensure(spec);
    await replacementLease.ensure(spec);
    expect(ensureRemoteForward).toHaveBeenCalledTimes(2);

    await oldLease.releaseAll();
    expect(closeOld).toHaveBeenCalledTimes(1);
    expect(closeReplacement).not.toHaveBeenCalled();

    await replacementLease.ensure(spec);
    expect(ensureRemoteForward).toHaveBeenCalledTimes(2);
    await replacementLease.releaseAll();
    await replacementLease.releaseAll();
    expect(closeReplacement).toHaveBeenCalledTimes(1);
  });
});
