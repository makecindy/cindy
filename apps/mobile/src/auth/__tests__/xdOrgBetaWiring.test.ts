import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const source = readFileSync(
  resolve(process.cwd(), 'src/auth/AuthContext.tsx'),
  'utf8',
);

describe('AuthContext xd org beta wiring', () => {
  it('shares beta migration before cold start or login uses a device id', () => {
    const preparation = source.indexOf(
      'const prepareBetaChannelForCurrentDevice',
    );
    const hasDevice = source.indexOf('await hasStoredDeviceId()', preparation);
    const ensureDevice = source.indexOf('await ensureDeviceId()', hasDevice);
    const prepareBeta = source.indexOf(
      'await prepareBetaChannelForDevice(',
      ensureDevice,
    );
    const coldStart = source.indexOf(
      'const did = await prepareBetaChannelForCurrentDevice();',
    );
    const login = source.indexOf(
      'await prepareBetaChannelForCurrentDevice()',
      coldStart + 1,
    );
    const readSession = source.indexOf(
      'let storedSession = signedOutTombstone',
    );

    expect(preparation).toBeGreaterThan(-1);
    expect(hasDevice).toBeGreaterThan(-1);
    expect(ensureDevice).toBeGreaterThan(hasDevice);
    expect(prepareBeta).toBeGreaterThan(ensureDevice);
    expect(coldStart).toBeGreaterThan(preparation);
    expect(login).toBeGreaterThan(coldStart);
    expect(readSession).toBeGreaterThan(coldStart);
  });

  it('waits for device migration before trying the xd default', () => {
    const schedule = source.indexOf(
      'const scheduleXdOrgBetaDefault = useCallback',
    );
    const waitForPreparation = source.indexOf(
      'await prepareBetaChannelForCurrentDevice();',
      schedule,
    );
    const applyDefault = source.indexOf(
      'await maybeEnableXdOrgBetaDefault(',
      schedule,
    );

    expect(waitForPreparation).toBeGreaterThan(schedule);
    expect(applyDefault).toBeGreaterThan(waitForPreparation);
  });

  it('schedules the xd default after both login and refresh identity are applied', () => {
    expect(
      source.match(/scheduleCanaryChannelSync\([^)]*generation\);/g),
    ).toHaveLength(3);
    expect(
      source.match(/scheduleXdOrgBetaDefault\([^)]*generation\);/g),
    ).toHaveLength(3);

    const loginApply = source.indexOf(
      'mergeMembershipWithExisting(outcome.membership',
    );
    const loginSchedule = source.indexOf(
      'scheduleCanaryChannelSync(outcome.accessToken, generation);',
    );
    expect(loginSchedule).toBeGreaterThan(loginApply);

    const refreshApply = source.indexOf(
      'mergeMembershipWithExisting(pair.membership',
    );
    const refreshSchedule = source.indexOf(
      'scheduleCanaryChannelSync(pair.accessToken, generation);',
    );
    expect(refreshSchedule).toBeGreaterThan(refreshApply);
    const canarySync = source.indexOf('syncCanaryChannelAfterAuth(');
    const canaryThen = source.indexOf(
      'scheduleNonXdOrgBetaDefault(',
      canarySync,
    );
    expect(canaryThen).toBeGreaterThan(canarySync);
  });

  it('rechecks generation and user id before the automatic write', () => {
    expect(source).toContain(
      'authGenerationRef.current === expectedAuthGeneration &&',
    );
    expect(source).toContain('userRef.current?.id === expectedUserId');
  });

  it('invalidates auth before logout performs asynchronous cleanup', () => {
    const clearLocalSession = source.indexOf(
      'const clearLocalSession = useCallback(async (',
    );
    const invalidateAuth = source.indexOf(
      'authGenerationRef.current += 1;',
      clearLocalSession,
    );
    const unregisterPush = source.indexOf(
      'await unregisterPushTokenBestEffort(',
      clearLocalSession,
    );

    expect(clearLocalSession).toBeGreaterThan(-1);
    expect(invalidateAuth).toBeGreaterThan(clearLocalSession);
    expect(unregisterPush).toBeGreaterThan(invalidateAuth);
  });
});
