// Native bootstrap smoke: node --test apps/desktop/scripts/__tests__/install-omarchy.smoke.mjs
// Linux, non-root; requires the tools listed in docs/linux.md plus binutils.
// HTTP, distro identity, package ownership and desktop MIME writes are faked.
// DEB creation, extraction, verification, install transactions and desktop-file
// validation are real. No network, actual user profile or desktop is accessed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const resources = path.join(repo, 'apps/desktop/resources/linux');
const bootstrap = path.join(resources, 'install-omarchy.sh');

test('Arch / Omarchy bootstrap with verified native packages', { skip: process.platform !== 'linux' }, async (t) => {
  assert.notEqual(process.getuid(), 0, 'Run as an unprivileged test user.');
  for (const tool of ['bash', 'curl', 'jq', 'bsdtar', 'ar', 'desktop-file-validate', 'update-desktop-database', 'xdg-mime']) {
    execFileSync('sh', ['-c', 'command -v "$1"', 'probe', tool]);
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-bootstrap-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const writeTool = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/bash\nset -eu\n${body}\n`, { mode: 0o755 });
  writeTool('uname', 'case "$1" in -s) echo "${TEST_KERNEL:-Linux}" ;; -m) echo "${TEST_MACHINE:-x86_64}" ;; esac');
  writeTool('pgrep', 'exit "${TEST_RUNNING_STATUS:-1}"');
  writeTool('pacman', 'case "$1" in -T) exit "${TEST_RUNTIME_STATUS:-0}" ;; -Qo) exit "${TEST_PACMAN_STATUS:-1}" ;; *) exit 90 ;; esac');
  writeTool('dpkg-query', 'exit "${TEST_DPKG_STATUS:-1}"');
  writeTool('xdg-mime', `printf '%s\\n' "$*" >> "$TEST_HOME/mime.log"; exit "\${TEST_MIME_STATUS:-0}"`);
  writeTool('curl', `
output=''
for ((i=1; i<=$#; i++)); do
  if [[ "\${!i}" == --output ]]; then ((i+=1)); output=\${!i}; fi
done
url=\${!#}
printf '%s\n' "$url" >> "$TEST_HOME/downloads"
[[ "\${TEST_NETWORK_FAIL:-0}" == 0 ]] || exit 22
case "$url" in
  */manifest-linux-*.json\?t=*) cp -- "$TEST_HOME/manifest.json" "$output" ;;
  */app/linux-*/*.deb)
    if [[ -n "\${TEST_PAUSE_FILE:-}" ]]; then
      touch "$TEST_PAUSE_FILE.ready"
      while [[ -f $TEST_PAUSE_FILE ]]; do sleep 0.01; done
    fi
    cp -- "$TEST_PACKAGE" "$output" ;;
  *) exit 91 ;;
esac`);
  // Tests replace only /etc/os-release through Bash's normal startup hook.
  // No production bypass flag or alternate download endpoint is introduced.
  const bashEnv = path.join(root, 'bash-env');
  fs.writeFileSync(bashEnv, 'source() { if [[ $1 == /etc/os-release ]]; then builtin source "$TEST_HOME/os-release"; else builtin source "$@"; fi; }\n');
  const packages = new Map();
  function buildPackage(version, region = 'global', arch = 'x64', legacy = false) {
    const key = `${version}-${region}-${arch}-${legacy}`;
    if (packages.has(key)) return packages.get(key);
    const dir = path.join(root, key);
    const app = path.join(dir, 'usr/lib/cindy');
    fs.mkdirSync(path.join(app, 'resources/linux'), { recursive: true });
    fs.writeFileSync(path.join(app, 'Cindy'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(app, 'resources/app.asar'), 'synthetic app');
    fs.writeFileSync(path.join(app, 'resources/linux-build-info'), `cindy-linux-v1\n${version}\n${arch}\n${region}\nCindy\n`);
    if (!legacy) for (const name of ['install-user.sh', 'register-desktop.sh']) {
      fs.copyFileSync(path.join(resources, name), path.join(app, 'resources/linux', name));
    }
    execFileSync('bsdtar', ['-czf', 'data.tar.gz', './usr'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'debian-binary'), '2.0\n');
    execFileSync('ar', ['rc', 'package.deb', 'debian-binary', 'data.tar.gz'], { cwd: dir });
    const file = path.join(dir, 'package.deb');
    const bytes = fs.readFileSync(file);
    const pkg = { file, version, region, arch, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
    packages.set(key, pkg);
    return pkg;
  }
  const v1 = buildPackage('1.0.0');
  const v2 = buildPackage('1.0.1');
  const v3 = buildPackage('1.0.2');
  const cn = buildPackage('1.0.0', 'cn');
  function fixture(name) {
    const home = path.join(root, name);
    fs.mkdirSync(home);
    fs.mkdirSync(path.join(home, 'temp'));
    fs.writeFileSync(path.join(home, 'os-release'), 'ID=arch\n');
    return home;
  }
  const environment = (home, pkg, env = {}) => ({
    PATH: `${bin}:${process.env.PATH}`, HOME: home, TMPDIR: path.join(home, 'temp'),
    XDG_DATA_HOME: path.join(home, '.local/share'), XDG_CONFIG_HOME: path.join(home, '.config'),
    BASH_ENV: bashEnv, TEST_HOME: home, TEST_PACKAGE: pkg.file, ...env,
  });
  function run(home, pkg = v1, { args = [], env = {}, app, input } = {}) {
    const existingTemp = fs.readdirSync(path.join(home, 'temp'));
    fs.writeFileSync(path.join(home, 'manifest.json'), JSON.stringify({ app: app ?? { version: pkg.version, installer: { file: `app/linux-${pkg.arch}/cindy-${pkg.version}.deb`, sha256: pkg.sha256, size: pkg.size } } }));
    const result = spawnSync('bash', input === undefined ? [bootstrap, ...args] : ['-s', '--', ...args], {
      encoding: 'utf8', timeout: 20000, input,
      env: environment(home, pkg, env),
    });
    assert.ifError(result.error);
    assert.deepEqual(fs.readdirSync(path.join(home, 'temp')), existingTemp, "only this invocation's temporary downloads must be cleaned");
    return { ...result, output: result.stdout + result.stderr };
  }
  const prefixFor = (home) => path.join(home, '.local/opt/cindy');
  const pointer = (prefix) => fs.readlinkSync(path.join(prefix, 'current'));
  const ok = (result) => assert.equal(result.status, 0, result.output);
  const fails = (result, reason) => { assert.notEqual(result.status, 0, result.output); assert.match(result.output, reason); };

  await t.test('curl pipe, newest manifest on each invocation, two upgrades and idempotent repair', () => {
    const home = fixture('upgrade');
    const prefix = prefixFor(home);
    fs.mkdirSync(path.join(home, '.config/CindyGlobal'), { recursive: true });
    const data = path.join(home, '.config/CindyGlobal/fixture-data');
    fs.writeFileSync(data, 'keep existing data');
    ok(run(home, v1, { input: fs.readFileSync(bootstrap, 'utf8') }));
    const first = pointer(prefix);
    fs.unlinkSync(path.join(prefix, 'launch'));
    ok(run(home));
    assert.equal(pointer(prefix), first);
    assert.equal(fs.readdirSync(path.join(prefix, 'releases')).length, 1);
    assert.ok(fs.existsSync(path.join(prefix, 'launch')));
    ok(run(home, v2));
    assert.equal(fs.readlinkSync(path.join(prefix, 'previous')), first);
    const second = pointer(prefix);
    ok(run(home, v3));
    assert.equal(fs.readlinkSync(path.join(prefix, 'previous')), second);
    assert.equal(fs.readdirSync(path.join(prefix, 'releases')).length, 3);
    assert.equal(fs.readFileSync(data, 'utf8'), 'keep existing data');
    const downloads = fs.readFileSync(path.join(home, 'downloads'), 'utf8').trim().split('\n');
    assert.equal(downloads.filter((url) => url.includes('/manifest-linux-x64.json?t=')).length, 4);
    assert.ok(downloads.every((url) => url.startsWith('https://hotfix.cindy.app/cindy/')));
    assert.equal(fs.readdirSync(path.join(home, '.local/share/applications')).filter((f) => f.endsWith('.desktop')).length, 1);
    assert.ok(fs.readFileSync(path.join(home, 'mime.log'), 'utf8').includes('x-scheme-handler/cindy'));
    const active = pointer(prefix);
    fails(run(home, v1), /refusing to downgrade/);
    assert.equal(pointer(prefix), active);
  });
  await t.test('Omarchy / cn uses its own CDN and prefix; legacy cn prefix remains compatible', () => {
    const home = fixture('cn');
    fs.writeFileSync(path.join(home, 'os-release'), 'ID=omarchy\nID_LIKE=arch\n');
    ok(run(home, cn, { args: ['--region', 'cn'] }));
    const prefix = `${prefixFor(home)}-cn`;
    assert.equal(fs.readFileSync(path.join(prefix, '.cindy-user-install'), 'utf8').trim(), 'cindy-user-install-v1:cn');
    assert.ok(fs.readFileSync(path.join(home, 'downloads'), 'utf8').trim().split('\n').every((url) => url.startsWith('https://hotfix.cindy.com.cn/cindy/')));
    fs.renameSync(prefix, prefixFor(home));
    ok(run(home, cn, { args: ['--region', 'cn'] }));
    assert.ok(!fs.existsSync(prefix));
  });
  await t.test('unmarked directory is preserved; repeated runs reuse managed neighbor', () => {
    const home = fixture('manual');
    const prefix = prefixFor(home);
    fs.mkdirSync(prefix, { recursive: true });
    fs.writeFileSync(path.join(prefix, 'keep'), 'manual install');
    ok(run(home));
    const managed = `${prefix}-managed`;
    const first = pointer(managed);
    ok(run(home));
    assert.equal(pointer(managed), first);
    assert.equal(fs.readFileSync(path.join(prefix, 'keep'), 'utf8'), 'manual install');
    fails(run(home, v1, { args: ['--prefix', prefix] }), /not a managed/);
  });
  await t.test('custom prefix with spaces and shell characters; cross-region install is rejected', () => {
    const home = fixture('custom');
    const prefix = path.join(home, "Cindy's space $literal");
    ok(run(home, v1, { args: ['--prefix', prefix] }));
    const first = pointer(prefix);
    fails(run(home, cn, { args: ['--region', 'cn', '--prefix', prefix] }), /Do not mix release regions/);
    assert.equal(pointer(prefix), first);
  });
  await t.test('a symlinked default is preserved even when its target is managed', () => {
    const home = fixture('symlink');
    const actual = path.join(home, 'original');
    ok(run(home, v1, { args: ['--prefix', actual] }));
    const first = pointer(actual);
    const prefix = prefixFor(home);
    fs.mkdirSync(path.dirname(prefix), { recursive: true });
    fs.symlinkSync(actual, prefix);
    ok(run(home, v2));
    assert.equal(fs.readlinkSync(prefix), actual);
    assert.equal(pointer(actual), first);
    assert.match(pointer(`${prefix}-managed`), /^releases.1[.]0[.]1-/);
  });
  await t.test('desktop registration failure is explicit and a repeat invocation repairs it', () => {
    const home = fixture('registration');
    fails(run(home, v1, { env: { TEST_MIME_STATUS: '1' } }), /installed, but desktop registration failed/);
    const first = pointer(prefixFor(home));
    ok(run(home));
    assert.equal(pointer(prefixFor(home)), first);
  });
  await t.test('bad metadata, bytes, identity and missing helpers leave the current install intact', () => {
    const home = fixture('rejections');
    ok(run(home));
    const prefix = prefixFor(home);
    const first = pointer(prefix);
    const asset = { file: 'app/linux-x64/cindy-1.0.1.deb', sha256: v2.sha256, size: v2.size };
    for (const [installer, reason] of [
      [{ ...asset, sha256: '0'.repeat(64) }, /SHA-256 mismatch/],
      [{ ...asset, size: v2.size + 1 }, /size mismatch/],
      [{ ...asset, file: '../../payload.deb' }, /no valid stable/],
      [{ ...asset, file: 'https://other.example/payload.deb' }, /no valid stable/],
      [{ ...asset, file: 'app/%2e%2e/payload.deb' }, /no valid stable/],
      [{ ...asset, size: '10' }, /no valid stable/],
    ]) {
      fails(run(home, v2, { app: { version: v2.version, installer } }), reason);
      assert.equal(pointer(prefix), first);
    }
    fails(run(home, cn), /does not match the selected release/);
    fails(run(home, v2, { app: { version: '1.0.9', installer: asset } }), /does not match the selected release/);
    fails(run(home, buildPackage('1.0.1', 'global', 'arm64')), /does not match the selected release/);
    fails(run(home, buildPackage('1.0.1', 'global', 'x64', true)), /predates one-command/);
    fails(run(home, v2, { env: { TEST_NETWORK_FAIL: '1' } }), /Could not fetch/);
    assert.equal(pointer(prefix), first);
    assert.equal(fs.readdirSync(path.join(prefix, 'releases')).length, 1);
  });
  await t.test('arm64 selects the corresponding manifest and payload', () => {
    const home = fixture('arm');
    ok(run(home, buildPackage('1.0.0', 'global', 'arm64'), { env: { TEST_MACHINE: 'aarch64' } }));
    assert.match(fs.readFileSync(path.join(home, 'downloads'), 'utf8'), /manifest-linux-arm64.json/);
  });
  await t.test('Ubuntu, Debian, Mint and non-Arch distros exit without any download', () => {
    for (const [name, release] of [['ubuntu', 'ID=ubuntu\nID_LIKE=debian'], ['debian', 'ID=debian'], ['mint', 'ID=linuxmint\nID_LIKE="ubuntu debian"'], ['fedora', 'ID=fedora']]) {
      const home = fixture(name);
      fs.writeFileSync(path.join(home, 'os-release'), release + '\n');
      fails(run(home), /Ubuntu.*Debian|Arch Linux.*Omarchy only/);
      assert.ok(!fs.existsSync(path.join(home, 'downloads')));
      assert.ok(!fs.existsSync(prefixFor(home)));
    }
  });
  await t.test('system installs, running Cindy, missing libraries and invalid inputs exit before download', () => {
    const home = fixture('preflight');
    for (const [env, reason] of [
      [{ TEST_PACMAN_STATUS: '0' }, /pacman.AUR/],
      [{ TEST_DPKG_STATUS: '0' }, /system package/],
      [{ TEST_RUNNING_STATUS: '0' }, /Quit Cindy/],
      [{ TEST_RUNTIME_STATUS: '127' }, /Missing runtime libraries/],
      [{ TEST_MACHINE: 'riscv64' }, /architecture/],
      [{ TEST_KERNEL: 'Darwin' }, /requires Arch/],
    ]) fails(run(home, v1, { env }), reason);
    fails(run(home, v1, { args: ['--region', 'oops'] }), /Region must be/);
    fails(run(home, v1, { args: ['--prefix', '/usr/cindy'] }), /inside HOME/);
    fails(run(home, v1, { args: ['--prefix', path.join(home, 'bad%name')] }), /PREFIX must/);
    assert.ok(!fs.existsSync(path.join(home, 'downloads')));
  });
  await t.test('a truncated curl pipe never starts downloading or installing', () => {
    const home = fixture('truncated');
    const input = fs.readFileSync(bootstrap, 'utf8').replace('cindy_bootstrap "$@"\n', 'cindy_bootstrap "');
    fails(run(home, v1, { input }), /unexpected EOF/);
    assert.ok(!fs.existsSync(path.join(home, 'downloads')));
  });
  await t.test('parallel bootstraps report busy before download; retry upgrades without downgrade', async () => {
    for (const existing of [false, true]) {
      const home = fixture(`parallel-${existing}`);
      if (existing) ok(run(home));
      const gate = path.join(home, 'download-gate');
      fs.writeFileSync(gate, 'wait');
      fs.writeFileSync(path.join(home, 'manifest.json'), JSON.stringify({ app: {
        version: v2.version, installer: { file: 'app/linux-x64/cindy-1.0.1.deb', sha256: v2.sha256, size: v2.size },
      } }));
      const child = spawn('bash', [bootstrap], {
        timeout: 20000,
        env: environment(home, v2, { TEST_PAUSE_FILE: gate }),
      });
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.stderr.on('data', (chunk) => { output += chunk; });
      const completion = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      try {
        for (let i = 0; !fs.existsSync(`${gate}.ready`) && i < 1000; i++) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.ok(fs.existsSync(`${gate}.ready`), `older download is paused: ${output}`);
        const downloads = fs.readFileSync(path.join(home, 'downloads'), 'utf8');
        fails(run(home, v3), /Another Cindy bootstrap is in progress/);
        assert.equal(fs.readFileSync(path.join(home, 'downloads'), 'utf8'), downloads);
      } finally {
        fs.rmSync(gate, { force: true });
        assert.equal(await completion, 0, output);
      }
      const prefix = prefixFor(home);
      assert.match(pointer(prefix), /^releases\/1[.]0[.]1-/);
      assert.deepEqual(fs.readdirSync(path.join(home, 'temp')), []);
      const lockInode = fs.statSync(`${prefix}.bootstrap.lock`).ino;
      ok(run(home, v3));
      assert.match(pointer(prefix), /^releases\/1[.]0[.]2-/);
      fails(run(home, v2), /refusing to downgrade/);
      assert.match(pointer(prefix), /^releases\/1[.]0[.]2-/);
      assert.equal(fs.statSync(`${prefix}.bootstrap.lock`).ino, lockInode);
    }
  });
});
