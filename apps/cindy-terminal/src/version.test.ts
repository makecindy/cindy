// Unit: untagged PR builds must remain eligible for peer capability discovery.
// The existing host tests use the checkout's tags and missed the untagged CI case.
import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readCindyBuildVersion, readCindyBuildRegion } from '../scripts/build-version.mjs';
import { createPeerUsageRuntime } from '@cindy/app-runtime/peerUsageSync';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

it('selects only a supported build region and defaults to Global', () => {
  vi.stubEnv('CINDY_AUTH_REGION', '');
  expect(readCindyBuildRegion()).toBe('global');
  vi.stubEnv('CINDY_AUTH_REGION', 'cn');
  expect(readCindyBuildRegion()).toBe('cn');
  expect(readCindyBuildRegion('global')).toBe('global');
  expect(() => readCindyBuildRegion('dev')).toThrow('CINDY_BUILD_REGION_INVALID');
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

it('allows an untagged source host to reach remote capability discovery', () => {
  vi.stubEnv('APP_VERSION', '');
  vi.mocked(execFileSync).mockImplementation(() => { throw new Error('No tags'); });
  const peers = createPeerUsageRuntime({
    createLogger: () => ({ debug() {} }),
    compareAppUpdateVersions: () => 'older',
  });
  expect(peers.mayServeBackgroundRead(readCindyBuildVersion())).toBe(true);
});

it('keeps the nearest ancestral release identity for tagged source builds', () => {
  vi.stubEnv('APP_VERSION', '');
  vi.mocked(execFileSync).mockReturnValue('v0.1.115\n');
  expect(readCindyBuildVersion()).toBe('0.1.115');
});

it('preserves an explicit release identity without consulting Git', () => {
  vi.stubEnv('APP_VERSION', '0.1.120');
  expect(readCindyBuildVersion()).toBe('0.1.120');
  expect(execFileSync).not.toHaveBeenCalled();
});

it('rejects an invalid explicit release identity', () => {
  vi.stubEnv('APP_VERSION', 'not-a-version');
  expect(readCindyBuildVersion).toThrow('CINDY_BUILD_VERSION_INVALID');
});
