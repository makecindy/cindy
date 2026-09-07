import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { findLinuxUserInstallation, isDebianManagedInstallation, missingLinuxUserInstallTools, linuxUserDesktopName } from '../linuxInstallation';
import { stageLinuxBuildInfo } from '../../../forge-linux';
import { buildLinuxUpdateScript } from '../updateScriptLinux';
import { allDeepLinkSchemes } from '@cindy/maker-shared/brand-identity';

describe('Linux install routing', () => {
  it('requires exact Debian package ownership, not the existence of dpkg', () => {
    expect(isDebianManagedInstallation('/usr/lib/cindy/Cindy', () => 'cindy: /usr/lib/cindy/Cindy\n')).toBe(true);
    expect(isDebianManagedInstallation('/usr/lib/cindy/Cindy', () => 'cindy:amd64: /usr/lib/cindy/Cindy\n')).toBe(true);
    expect(isDebianManagedInstallation('/home/test/Cindy', () => 'cindy: /usr/lib/cindy/Cindy\n')).toBe(false);
    expect(isDebianManagedInstallation('/usr/lib/cindy/Cindy', () => 'unrelated: /usr/lib/cindy/Cindy\n')).toBe(false);
    expect(isDebianManagedInstallation('/usr/lib/cindy/Cindy', () => { throw new Error('no dpkg'); })).toBe(false);
  });
  it('reports missing portable dependencies', () => {
    expect(missingLinuxUserInstallTools(() => true)).toEqual([]);
    expect(missingLinuxUserInstallTools((name) => name !== 'bsdtar')).toEqual(['bsdtar']);
  });
});

// One shared, isolated filesystem fixture. No real app, credentials, network,
// package-manager database or desktop settings are accessed.
describe.skipIf(process.platform !== 'linux')('user installer transaction smoke (Linux/libarchive)', () => {
  let root: string;
  let prefix: string;
  const installer = path.resolve(__dirname, '../../../resources/linux/install-user.sh');
  const packages = new Map<string, { file: string; digest: string; size: number }>();
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-install-test-'));
    prefix = path.join(root, 'home', "Cindy's space $literal");
    fs.mkdirSync(path.join(root, 'home'));
    for (const version of ['1.0.0', '1.0.1', '1.0.2', '1.0.3', '1.0.4', '1.0.5']) {
      const pkg = path.join(root, version);
      const appDir = path.join(pkg, 'usr', 'lib', 'cindy');
      fs.mkdirSync(path.join(appDir, 'resources'), { recursive: true });
      fs.writeFileSync(path.join(appDir, 'Cindy'), '#!/bin/sh\nprintf "%s\\n" "fixture"\n', { mode: 0o755 });
      if (version === '1.0.4' || version === '1.0.5') {
        fs.writeFileSync(path.join(appDir, 'Cindy'), [
          '#!/bin/sh', 'printf "%s\\n" "$$" "$@" > "$CINDY_TEST_LAUNCH_LOG"', 'exec sleep 10', '',
        ].join('\n'), { mode: 0o755 });
      }
      fs.writeFileSync(path.join(appDir, 'resources', 'app.asar'), 'fake archive');
      stageLinuxBuildInfo(appDir, 'linux', process.arch, version, 'global');
      if (version === '1.0.3') fs.symlinkSync('/etc/passwd', path.join(appDir, 'escape'));
      execFileSync('bsdtar', ['-czf', 'data.tar.gz', './usr'], { cwd: pkg });
      fs.writeFileSync(path.join(pkg, 'debian-binary'), '2.0\n');
      const file = path.join(pkg, 'package.deb');
      execFileSync('ar', ['rc', file, 'debian-binary', 'data.tar.gz'], { cwd: pkg });
      const bytes = fs.readFileSync(file);
      packages.set(version, { file, digest: createHash('sha256').update(bytes).digest('hex'), size: bytes.length });
    }
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
  function run(version: string, apply = false, overrides: { digest?: string; version?: string; region?: string; env?: NodeJS.ProcessEnv } = {}) {
    const pkg = packages.get(version)!;
    const args = apply
      ? ['--apply', pkg.file, overrides.digest ?? pkg.digest, String(pkg.size), prefix,
        overrides.version ?? version, overrides.region ?? 'global', fs.readlinkSync(path.join(prefix, 'current'))]
      : ['--install', pkg.file, overrides.digest ?? pkg.digest, prefix];
    return spawnSync('bash', [installer, ...args], {
      env: { ...process.env, HOME: path.join(root, 'home'), ...overrides.env }, encoding: 'utf8', timeout: 15_000,
    });
  }
  it('installs, rejects corrupt/wrong builds, applies two updates, and retains previous releases', () => {
    const first = run('1.0.0');
    expect(first.stderr).toBe('');
    expect(first.status).toBe(0);
    const before = fs.readlinkSync(path.join(prefix, 'current'));
    expect(execFileSync(path.join(prefix, 'launch'), { encoding: 'utf8' })).toBe('fixture\n');
    fs.rmSync(path.join(prefix, 'launch'));
    expect(run('1.0.0').status).toBe(0);
    expect(execFileSync(path.join(prefix, 'launch'), { encoding: 'utf8' })).toBe('fixture\n');
    const find = () => findLinuxUserInstallation(path.join(prefix, 'current', 'Cindy'), path.join(root, 'home'), process.getuid!());
    expect(find()).toEqual({ prefix, current: before, region: 'global' });
    expect(run('1.0.1', true, { digest: '0'.repeat(64) }).status).not.toBe(0);
    expect(run('1.0.1', true, { version: '9.9.9' }).status).not.toBe(0);
    expect(run('1.0.1', true, { region: 'cn' }).status).not.toBe(0);
    expect(run('1.0.3', true).status).not.toBe(0);
    expect(fs.readlinkSync(path.join(prefix, 'current'))).toBe(before);
    expect(run('1.0.1', true).status).toBe(0);
    const installed = fs.readlinkSync(path.join(prefix, 'current'));
    const previousBeforeFailure = fs.readlinkSync(path.join(prefix, 'previous'));
    const faultBin = path.join(root, 'fault-bin');
    fs.mkdirSync(faultBin);
    fs.writeFileSync(path.join(faultBin, 'mv'), [
      '#!/bin/bash', 'if [[ "${@: -1}" == "$CINDY_TEST_FAIL_DEST" ]]; then',
      '  /usr/bin/mv "$@"', '  exit 73', 'fi',
      'exec /usr/bin/mv "$@"', '',
    ].join('\n'), { mode: 0o755 });
    expect(run('1.0.2', true, { env: {
      PATH: faultBin + path.delimiter + process.env.PATH, CINDY_TEST_FAIL_DEST: path.join(prefix, 'current'),
    } }).status).toBe(73);
    expect(fs.readlinkSync(path.join(prefix, 'current'))).toBe(installed);
    expect(fs.readlinkSync(path.join(prefix, 'previous'))).toBe(previousBeforeFailure);
    expect(fs.existsSync(path.join(prefix, 'releases', '1.0.2-' + packages.get('1.0.2')!.digest))).toBe(false);
    expect(run('1.0.2', true, { env: {
      PATH: faultBin + path.delimiter + process.env.PATH, CINDY_TEST_FAIL_DEST: path.join(prefix, 'previous'),
    } }).status).toBe(73);
    expect(fs.readlinkSync(path.join(prefix, 'current'))).toBe(installed);
    expect(fs.readlinkSync(path.join(prefix, 'previous'))).toBe(previousBeforeFailure);
    expect(fs.existsSync(path.join(prefix, 'releases', '1.0.2-' + packages.get('1.0.2')!.digest))).toBe(false);
    // Retrying after a failure immediately before the atomic rename works.
    expect(run('1.0.2', true).status).toBe(0);
    expect(fs.readlinkSync(path.join(prefix, 'previous'))).toBe(installed);
    expect(fs.existsSync(path.join(prefix, before, 'Cindy'))).toBe(true);
    expect(fs.readdirSync(path.join(prefix, 'releases')).some((name) => name.startsWith('.stage.'))).toBe(false);
    expect(find()?.current).toContain('1.0.2');
    expect(findLinuxUserInstallation(path.join(prefix, before, 'Cindy'), path.join(root, 'home'), process.getuid!())).toBeNull();
    expect(findLinuxUserInstallation(path.join(prefix, 'current', 'Cindy'), prefix, process.getuid!())).toBeNull();
  });
  it('registers a valid stable desktop entry with no real desktop changes', () => {
    const bin = path.join(root, 'fake-bin');
    fs.mkdirSync(bin);
    const mimeLog = path.join(root, 'mime-args');
    fs.writeFileSync(path.join(bin, 'xdg-mime'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$CINDY_TEST_MIME_LOG"\n', { mode: 0o755 });
    const data = path.join(root, 'home', 'data');
    const result = spawnSync('bash', [
      path.resolve(__dirname, '../../../resources/linux/register-desktop.sh'), prefix,
    ], {
      env: { ...process.env, HOME: path.join(root, 'home'), XDG_DATA_HOME: data,
        XDG_CONFIG_HOME: path.join(root, 'home', 'config'), PATH: bin + path.delimiter + process.env.PATH,
        CINDY_TEST_MIME_LOG: mimeLog },
      encoding: 'utf8', timeout: 15_000,
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const entries = fs.readdirSync(path.join(data, 'applications')).filter((name) => name.endsWith('.desktop'));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toBe(linuxUserDesktopName(prefix));
    const desktop = fs.readFileSync(path.join(data, 'applications', entries[0]), 'utf8');
    expect(desktop).toContain('/launch" %U');
    expect(desktop).not.toContain('/releases/');
    expect(desktop).toContain('StartupWMClass=' + entries[0].replace(/\.desktop$/, ''));
    expect(desktop).toContain('space \\\\$literal');
    expect(fs.readFileSync(mimeLog, 'utf8').trim().split('\n')).toEqual([
      'default', entries[0], ...allDeepLinkSchemes().map((scheme) => 'x-scheme-handler/' + scheme),
    ]);
  });
  it('runs the detached updater and relaunches with the same backend on success and failure', () => {
    const launchLog = path.join(root, 'launch-args');
    const logPath = path.join(root, 'update.log');
    const lockFilePath = path.join(root, 'update.lock');
    for (const [version, valid] of [['1.0.4', true], ['1.0.5', false]] as const) {
      const pkg = packages.get(version)!;
      const before = fs.readlinkSync(path.join(prefix, 'current'));
      const script = buildLinuxUpdateScript({
        pid: 2147483647, // Outside Linux's pid_max: no real process may be killed.
        debPath: pkg.file, sha256: valid ? pkg.digest : 'f'.repeat(64), sizeBytes: pkg.size,
        exePath: path.join(prefix, before, 'Cindy'), lockFilePath, logPath,
        userInstallation: { prefix, current: before, region: 'global', version },
        relaunchArgs: ['--password-store=gnome-libsecret'],
        timings: { lockHeartbeatSeconds: 1, verifyTimeoutSeconds: 3, verifyRetryAtSeconds: 2 },
      });
      fs.rmSync(launchLog, { force: true });
      const result = spawnSync('setsid', ['bash', '-c', script], {
        env: { ...process.env, HOME: path.join(root, 'home'), CINDY_TEST_LAUNCH_LOG: launchLog },
        encoding: 'utf8', timeout: 15_000,
      });
      // The failed-install path launches asynchronously just before exiting.
      const wait = spawnSync('bash', ['-c', 'for i in {1..50}; do [[ -s "$1" ]] && exit 0; sleep 0.02; done; exit 1', 'wait', launchLog],
        { timeout: 3000 });
      expect(wait.status).toBe(0);
      const [pid, ...args] = fs.readFileSync(launchLog, 'utf8').trim().split('\n');
      try {
        expect(result.stderr).toBe('');
        expect(result.status).toBe(valid ? 0 : 1);
        expect(args).toEqual(['--password-store=gnome-libsecret']);
        expect(fs.readlinkSync(path.join(prefix, 'current'))).toBe(valid ? 'releases/' + version + '-' + pkg.digest : before);
        expect(fs.existsSync(lockFilePath)).toBe(false);
      } finally {
        process.kill(Number(pid), 'SIGTERM'); // Only the fake app this test launched.
      }
    }
  }, 30_000);
});
