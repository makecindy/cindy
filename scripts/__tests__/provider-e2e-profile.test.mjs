import test from 'node:test';
import path from 'node:path';
import assert from 'node:assert/strict';
import { assertProviderE2EProfile } from '../../apps/desktop/scripts/provider-e2e-profile.mjs';
const profile = path.resolve('isolated', 'CindyGlobal-dev2-provider-auto-detection-fixture');
const db = path.join(profile, 'cindy-local-v1.db');
function fixture() {
  const record = { pid: 123, isolated: true, profileKind: 'isolated-sandbox', state: 'ready', userDataDir: profile,
    processIdentity: { startedAtMs: Date.parse('2026-10-23T12:00:00Z'), executablePath: '/Electron' } };
  let detached = 0;
  const session = { send: async () => ({ processInfo: [{ type: 'browser', id: 123 }] }), detach: async () => { detached++; } };
  const browser = { newBrowserCDPSession: async () => session };
  const options = { platform: 'darwin', realpath: async p => p,
    readFile: async p => { assert.equal(p, path.join(profile, '.dev-instances', '123.json')); return JSON.stringify(record); },
    run: async () => ({ stdout: 'Fri Oct 23 12:00:00 2026 /Electron\n' }) };
  return { record, session, browser, options, detached: () => detached };
}
test('accepts the actual CDP main process registered in the isolated database profile', async () => {
  const f = fixture(); await assertProviderE2EProfile(f.browser, db, f.options); assert.equal(f.detached(), 1);
});
for (const scenario of ['daily-client', 'other-profile', 'not-isolated', 'stale-pid', 'missing-identity', 'symlink', 'unavailable-cdp', 'unsupported-platform']) {
  test(`refuses ${scenario} before any UI/write callback`, async () => {
    const f = fixture(); let writes = 0;
    if (scenario === 'daily-client') f.options.readFile = async () => { throw new Error('No registration for this CDP process in isolated profile'); };
    if (scenario === 'other-profile') f.record.userDataDir = '/daily';
    if (scenario === 'not-isolated') f.record.isolated = false;
    if (scenario === 'stale-pid') f.record.processIdentity.startedAtMs--;
    if (scenario === 'missing-identity') delete f.record.processIdentity;
    if (scenario === 'symlink') f.options.realpath = async () => '/daily/cindy-local-v1.db';
    if (scenario === 'unavailable-cdp') f.session.send = async () => { throw new Error('unsupported'); };
    if (scenario === 'unsupported-platform') f.options.platform = 'win32';
    await assert.rejects(async () => { await assertProviderE2EProfile(f.browser, db, f.options); writes++; });
    assert.equal(writes, 0);
    assert.equal(f.detached(), scenario === 'symlink' ? 0 : 1);
  });
}
