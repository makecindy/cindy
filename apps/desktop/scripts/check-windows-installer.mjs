// Compile the production NSIS hooks and exercise their Win32 preflight in an
// isolated native harness. Does not install Cindy, change registry keys, or open UAC.
// Run explicitly on Windows: node apps/desktop/scripts/check-windows-installer.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resources = path.join(desktop, 'resources');
const { build, Platform, Arch } = require('app-builder-lib');

if (process.platform !== 'win32')
  throw new Error('This check requires Windows and the NSIS toolchain.');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-installer-check-'));
console.log(`Installer check directory: ${root}`);
try {
  const payload = path.join(root, 'payload');
  await fs.mkdir(path.join(payload, 'resources'), { recursive: true });
  await fs.writeFile(
    path.join(payload, 'CindyInstallerProbe.exe'),
    'Compile fixture; never execute.',
  );
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'cindy-installer-probe',
      version: '0.0.1',
      description: 'Installer compile check',
      author: 'Test',
    }),
  );
  // Exercise the real electron-builder installer AND uninstaller templates, with
  // a tiny inert payload. The generated setup is deliberately never launched.
  await build({
    projectDir: root,
    prepackaged: payload,
    targets: Platform.WINDOWS.createTarget('nsis', Arch.x64),
    config: {
      appId: 'app.cindy.installer-test',
      productName: 'CindyInstallerProbe',
      electronVersion: '41.10.3',
      compression: 'store',
      directories: { output: path.join(root, 'out'), buildResources: resources },
      win: { signAndEditExecutable: false, sign: async () => {} },
      nsis: {
        oneClick: false,
        allowElevation: true,
        allowToChangeInstallationDirectory: false,
        include: path.join(resources, 'installer.nsh'),
        uninstallerIcon: path.join(resources, 'icon.ico'),
        artifactName: 'compile-only.exe',
      },
    },
  });
  console.log('PASS: production installer and uninstaller compile (warnings are errors)');

  const { NSIS_PATH, nsisTemplatesDir } = require('app-builder-lib/out/targets/nsis/nsisUtil');
  const nsis = await NSIS_PATH();
  const compile = spawnSync(
    path.join(nsis, 'Bin', 'makensis.exe'),
    [
      '/WX',
      '/V2',
      `/DTEST_ROOT=${root}`,
      `/X!addincludedir "${resources}"`,
      `/X!addincludedir "${path.join(nsisTemplatesDir, 'include')}"`,
      path.join(desktop, 'scripts', 'fixtures', 'installer-directory-check.nsi'),
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 30_000 },
  );
  assert.equal(compile.status, 0, compile.error?.message ?? compile.stdout + compile.stderr);

  const writable = path.join(root, '目录 with spaces', 'CindyInstallerProbe');
  await fs.mkdir(writable, { recursive: true });
  const icon = path.join(writable, 'uninstallerIcon.ico');
  const originalIcon = 'existing icon contents must not change';
  await fs.writeFile(icon, originalIcon);
  const fileAsDirectory = path.join(root, 'ordinary-file');
  await fs.writeFile(fileAsDirectory, 'not a directory');

  async function runCase(
    name,
    { directory = writable, admin = 0, elevationResult = 1223, childExit = 0 } = {},
  ) {
    const ini = `[input]\r\ncase=${name}\r\ndirectory=${directory}\r\nadmin=${admin}\r\nelevationResult=${elevationResult}\r\nchildExit=${childExit}\r\n`;
    await fs.writeFile(path.join(root, 'case.ini'), '\ufeff' + ini, 'utf16le');
    await fs.writeFile(path.join(root, 'result.ini'), '\ufeff', 'utf16le');
    const processResult = spawnSync(path.join(root, 'directory-check.exe'), [], {
      windowsHide: true,
      timeout: 15_000,
      encoding: 'utf8',
    });
    assert.ifError(processResult.error);
    const resultText = await fs.readFile(path.join(root, 'result.ini'), 'utf16le');
    const result = Object.fromEntries(
      resultText
        .split(/\r?\n/)
        .filter((line) => line.includes('='))
        .map((line) => {
          const split = line.indexOf('=');
          return [line.slice(0, split), line.slice(split + 1)];
        }),
    );
    console.log(`Native case: ${name} (exit ${processResult.status})`);
    return { ...result, exit: processResult.status };
  }

  const writableResult = await runCase('writable');
  assert.equal(writableResult.failed, '0');
  assert.equal(writableResult.elevations, '0');
  assert.equal(writableResult.directory, writable);
  assert.match(writableResult.sid, /^S-1-/);
  assert.deepEqual(await fs.readdir(writable), ['uninstallerIcon.ico']);
  assert.equal(await fs.readFile(icon, 'utf8'), originalIcon);

  // Deny writes only inside our unique fixture using the real current SID.
  // This reproduces protected directories without changing system ACLs.
  const protectedDirectory = path.join(root, 'protected');
  await fs.mkdir(protectedDirectory);
  const acl = (args) => {
    const result = spawnSync('icacls.exe', [protectedDirectory, ...args], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 15_000,
    });
    assert.equal(result.status, 0, result.error?.message ?? result.stdout + result.stderr);
  };
  acl(['/deny', `*${writableResult.sid}:(WD,AD)`]);
  try {
    for (const directory of [
      protectedDirectory,
      path.join(protectedDirectory, 'CindyInstallerProbe'),
    ]) {
      const denied = await runCase('protected-directory', { directory });
      assert.equal(denied.error, '5');
      assert.equal(denied.elevations, '1');
      assert.equal(denied.failed, '1');
      assert.equal(denied.prepare, '0');
    }
    assert.deepEqual(await fs.readdir(protectedDirectory), []);
  } finally {
    acl(['/remove:d', `*${writableResult.sid}`]);
  }

  const missing = path.join(writable, 'new', 'nested');
  assert.equal((await runCase('missing', { directory: missing })).failed, '0');
  await assert.rejects(fs.stat(missing), { code: 'ENOENT' });
  const invalid = await runCase('file-as-directory', { directory: fileAsDirectory });
  assert.equal(invalid.error, '267');
  assert.equal(invalid.failed, '1');
  assert.equal(invalid.elevations, '0');

  const locked = await runCase('locked');
  assert.equal(locked.error, '32');
  assert.equal(locked.elevations, '0');
  assert.equal(locked.failed, '1');

  await fs.chmod(icon, 0o444);
  try {
    const cancelled = await runCase('cancelled');
    assert.equal(cancelled.error, '5');
    assert.equal(cancelled.elevations, '1');
    assert.equal(cancelled.failed, '1');
    assert.equal(cancelled.directory, writable);
    assert.equal(cancelled.prepare, '0');

    const alreadyAdmin = await runCase('already-admin', { admin: 1 });
    assert.equal(alreadyAdmin.failed, '1');
    assert.equal(alreadyAdmin.elevations, '0');

    const differentUser = await runCase('different-user', { elevationResult: 0, childExit: 49617 });
    assert.equal(differentUser.failed, '1');
    assert.equal(differentUser.prepare, '0');
    assert.equal(differentUser.mode, 'CurrentUser');

    for (const childExit of [0, 5]) {
      const completed = await runCase('completed-child', { elevationResult: 0, childExit });
      assert.equal(completed.exit, childExit);
      assert.equal(
        completed.directory,
        undefined,
        'outer process must not continue after child exits',
      );
    }
  } finally {
    await fs.chmod(icon, 0o666);
  }

  const resumedUser = await runCase('resume-user', { admin: 1 });
  assert.equal(resumedUser.directory, writable);
  assert.equal(resumedUser.mode, 'CurrentUser');
  assert.equal(resumedUser.prepare, '1');
  const resumedOther = await runCase('resume-other', { admin: 1 });
  assert.equal(resumedOther.exit, 49617);
  assert.equal(resumedOther.prepare, undefined);
  const resumedAll = await runCase('resume-all', { admin: 1 });
  assert.equal(resumedAll.directory, writable);
  assert.equal(resumedAll.mode, 'all');
  assert.equal(resumedAll.prepare, '1');
  assert.equal(await fs.readFile(icon, 'utf8'), originalIcon);
  assert.deepEqual(await fs.readdir(writable), ['uninstallerIcon.ico']);
  console.log(
    'PASS: directory access, locked/read-only files, cancellation, child exit and identity/scope preservation',
  );
} finally {
  // Delete only the unique test root allocated above, never an inferred workspace.
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('cindy-installer-check-'));
  await fs.rm(root, { recursive: true, force: true });
}
