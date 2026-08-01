import { describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
  prefsFileContent: '',
  warn: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/cindy-test-userdata',
  },
}));

vi.mock('node:fs', () => ({
  default: {
    existsSync: () => true,
    readFileSync: () => testState.prefsFileContent,
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    unlinkSync: vi.fn(),
  },
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: testState.warn,
    error: vi.fn(),
  }),
}));

describe('ssh-host-prefs-store proxy URL logging', () => {
  it('never copies rejected proxy credentials into the prefs-load warning', async () => {
    testState.prefsFileContent = JSON.stringify({
      host1: {
        autoConnect: false,
        agentProxy: {
          enabled: true,
          mode: 'env',
          proxyUrl:
            'http://sensitive-user:sensitive-password@proxy.example:8080/path?token=secret',
        },
      },
    });

    const { readSshHostPrefs } = await import('../ssh-host-prefs-store');
    expect(readSshHostPrefs().host1?.agentProxy).toBeUndefined();

    const warningContext = testState.warn.mock.calls.find(
      ([message]) => message === 'invalid agentProxy.proxyUrl in prefs — dropping (was it hand-edited?)',
    )?.[1];
    expect(warningContext).toEqual({ proxyUrl: 'http://proxy.example:8080' });
    expect(JSON.stringify(testState.warn.mock.calls)).not.toMatch(
      /sensitive-user|sensitive-password|token|secret/,
    );
  });

  it('does not copy a rejected tunnel target into the prefs-load warning', async () => {
    testState.prefsFileContent = JSON.stringify({
      host2: {
        autoConnect: false,
        agentProxy: {
          enabled: true,
          mode: 'tunnel',
          localHost: 'sensitive internal host',
          localPort: 7890,
          remotePort: 17893,
        },
      },
    });

    vi.resetModules();
    const { readSshHostPrefs } = await import('../ssh-host-prefs-store');
    expect(readSshHostPrefs().host2?.agentProxy).toBeUndefined();

    const warningContext = testState.warn.mock.calls.find(
      ([message]) => message === 'invalid agentProxy.localHost in prefs — dropping (was it hand-edited?)',
    )?.[1];
    expect(warningContext).toEqual({ localHost: '[redacted]' });
    expect(JSON.stringify(testState.warn.mock.calls)).not.toContain('sensitive internal host');
  });
});
