// Guard tier: engineering-conventions section 3.2. The failure this pins is a
// registration-time evaluation in register.ts, so the wiring itself is the
// contract: the behavioural regression lives in scheduledSessionBootstrap.test.ts.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Start before the automation preference holder: the buggy snapshot lived just
// above the bootstrap holder assignment, so a block anchored on that assignment
// would have skipped the exact line the guard is meant to catch.
const WIRING_START = 'prepareScheduledModelPreferencesHolder = async';
const WIRING_ANCHOR = 'scheduledSessionBootstrapHolder = createScheduledSessionBootstrap(';
const WIRING_END = 'let recoverRenamedSessionModelOnSend';

describe('scheduled session bootstrap wiring', () => {
  const registerSource = readFileSync(
    resolve(process.cwd(), 'src/main/maker-ipc/register.ts'),
    'utf8',
  ).replace(/\r\n/g, '\n');

  function wiringBlock(): string {
    const start = registerSource.indexOf(WIRING_START);
    expect(start).toBeGreaterThan(-1);
    const end = registerSource.indexOf(WIRING_END, start);
    expect(end).toBeGreaterThan(start);
    return registerSource.slice(start, end);
  }

  it('builds the automation bootstrap holder from the per-fire factory', () => {
    expect(wiringBlock()).toContain(WIRING_ANCHOR);
  });

  it('forwards the owner assertion into the startup funnel', () => {
    // Losing this forwarder would silently downgrade the guard to the single
    // entry check, so an account switch inside the funnel could create the task
    // under the new owner instead of aborting.
    expect(wiringBlock()).toContain(
      'bootstrapSession(options as MakerSessionCreateOpts, assertAccess)',
    );
  });

  it('never snapshots the data owner for automations at registration time', () => {
    // A snapshot evaluated once while the handlers register is the bug: the app
    // session commit that restores the account can land later, so it stays stale
    // and every automation fails until the app restarts. Assert on the wiring
    // block, not on a variable name: any `const`/`let` shape that captures the
    // scope here reintroduces the same failure.
    expect(wiringBlock()).not.toContain('captureDataOwnerBroadcastScope');
  });
});
