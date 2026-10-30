// Read-only provenance check before any provider E2E UI or IPC mutation.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);

export async function assertProviderE2EProfile(browser, dbFile, {
  readFile = fs.readFile, realpath = fs.realpath, run = execFileAsync, platform = process.platform,
} = {}) {
  assert.ok(dbFile && path.basename(dbFile) === 'cindy-local-v1.db'
    && /^CindyGlobal-dev2-provider-auto-detection-.+$/.test(path.basename(path.dirname(dbFile))), 'E2E_DB must identify the isolated provider test database');
  const db = await realpath(dbFile);
  assert.equal(db, path.resolve(dbFile), 'E2E database must not redirect through a symlink');
  const session = await browser.newBrowserCDPSession();
  try {
    const { processInfo } = await session.send('SystemInfo.getProcessInfo');
    const main = processInfo.filter(p => p.type === 'browser');
    assert.equal(main.length, 1, 'Cannot identify the connected Desktop main process');
    const pid = main[0].id;
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    const profile = path.dirname(db);
    const record = JSON.parse(await readFile(path.join(profile, '.dev-instances', `${pid}.json`), 'utf8'));
    assert.equal(record.pid, pid);
    assert.equal(record.isolated, true, 'Connected Desktop is not isolated');
    assert.equal(record.profileKind, 'isolated-sandbox');
    assert.equal(record.state, 'ready');
    assert.equal(await realpath(record.userDataDir), profile, 'Connected Desktop uses another profile');
    // Reject stale registrations after PID reuse. These scripts currently target macOS.
    assert.equal(platform, 'darwin', 'Profile identity verification requires macOS');
    const { stdout } = await run('ps', ['-ww', '-p', String(pid), '-o', 'lstart=', '-o', 'comm='], {
      encoding: 'utf8', timeout: 5000, maxBuffer: 16384, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC0' },
    });
    const match = /^(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(stdout.trim());
    assert.ok(match && record.processIdentity, 'Desktop process identity is unavailable');
    assert.equal(Date.parse(`${match[1]} UTC`), record.processIdentity.startedAtMs, 'Stale Desktop registration');
    assert.equal(match[2], record.processIdentity.executablePath, 'Desktop executable changed');
  } finally {
    await session.detach();
  }
}
