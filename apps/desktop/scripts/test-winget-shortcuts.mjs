// Explicit Windows-only NSIS regression check. The runnable fixture only touches
// its own unique temp directory; production installer/uninstaller are compiled,
// never executed. No actual installed app, registry or pinned item is modified.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

if (process.platform !== 'win32') throw new Error('Run this NSIS check on Windows.');
const require = createRequire(import.meta.url);
const { build, Platform, Arch } = require('app-builder-lib');
const { NSIS_PATH, NsisTargetOptions } = require('app-builder-lib/out/targets/nsis/nsisUtil');
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-winget-shortcuts-'));
try {
  NsisTargetOptions.resolve({});
  const nsisDir = await NSIS_PATH();
  const makensis = path.join(nsisDir, 'Bin', 'makensis.exe');
  const fixtureExe = path.join(root, 'fixture.exe');
  const source = [
    'Unicode true',
    'RequestExecutionLevel user',
    'SilentInstall silent',
    'OutFile "' + fixtureExe + '"',
    '!include "LogicLib.nsh"',
    '!include "' + path.join(desktop, 'resources/winget-shortcuts.nsh') + '"',
    'Section',
    '  InitPluginsDir',
    '  CreateDirectory "$PLUGINSDIR\\cindy-shortcuts"',
    '  !insertmacro cindyBackupLink "$EXEDIR\\desktop.lnk" "desktop"',
    '  !insertmacro cindyBackupLink "$EXEDIR\\menu\\start.lnk" "menu"',
    '  !insertmacro cindyBackupLink "$EXEDIR\\taskbar.lnk" "taskbar"',
    '  !insertmacro cindyBackupLink "$EXEDIR\\user-deleted.lnk" "deleted"',
    '  !insertmacro cindyBackupLink "$EXEDIR\\replacement.lnk" "replacement"',
    '  Delete "$EXEDIR\\desktop.lnk"',
    '  Delete "$EXEDIR\\menu\\start.lnk"',
    '  RMDir "$EXEDIR\\menu"',
    '  Delete "$EXEDIR\\taskbar.lnk"',
    '  FileOpen $0 "$EXEDIR\\replacement.lnk" w',
    '  FileWrite $0 "new link"',
    '  FileClose $0',
    '  !insertmacro cindyRestoreLink "$EXEDIR\\desktop.lnk" "desktop"',
    '  !insertmacro cindyRestoreLink "$EXEDIR\\menu\\start.lnk" "menu"',
    '  !insertmacro cindyRestoreLink "$EXEDIR\\taskbar.lnk" "taskbar"',
    '  !insertmacro cindyRestoreLink "$EXEDIR\\user-deleted.lnk" "deleted"',
    '  !insertmacro cindyRestoreLink "$EXEDIR\\replacement.lnk" "replacement"',
    'SectionEnd',
  ].join(String.fromCharCode(10));
  const nsi = path.join(root, 'fixture.nsi');
  await fs.writeFile(nsi, source);
  await fs.mkdir(path.join(root, 'menu'));
  // Byte preservation is intentional: .lnk property stores must survive intact.
  const bytes = Buffer.from([0x4c, 0, 0, 0, 0xff, 0x12, 0x80]);
  for (const name of ['desktop.lnk', 'menu/start.lnk', 'taskbar.lnk', 'replacement.lnk', 'unrelated.lnk']) {
    await fs.writeFile(path.join(root, name), bytes);
  }
  execFileSync(makensis, ['/V2', '/INPUTCHARSET', 'UTF8', nsi], { windowsHide: true, env: { ...process.env, NSISDIR: nsisDir } });
  execFileSync(fixtureExe, [], { windowsHide: true, timeout: 30000 });
  for (const name of ['desktop.lnk', 'menu/start.lnk', 'taskbar.lnk', 'unrelated.lnk']) {
    assert.deepEqual(await fs.readFile(path.join(root, name)), bytes, name);
  }
  assert.equal(await fs.readFile(path.join(root, 'replacement.lnk'), 'utf8'), 'new link');
  await assert.rejects(fs.access(path.join(root, 'user-deleted.lnk')), { code: 'ENOENT' });
  console.log('PASS: old-uninstaller deletion, byte-preserving restore, missing parent, user-deleted and unrelated links.');

  // Exercise real NSIS failures within this fixture only. A file blocks parent
  // creation; a scoped ACL permits the directory but denies adding its link.
  const denied = path.join(root, 'denied');
  await fs.mkdir(denied);
  await fs.writeFile(path.join(root, 'blocked-parent'), 'not a directory');
  const identity = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
  const sid = identity.match(/S-1-[0-9-]+/)?.[0];
  assert.ok(sid, 'current Windows SID');
  execFileSync('icacls.exe', [denied, '/deny', `*${sid}:(WD)`], { windowsHide: true });
  try {
    for (const parent of ['blocked-parent', 'denied']) {
      const failureExe = path.join(root, `${parent}.exe`);
      const failureNsi = path.join(root, `${parent}.nsi`);
      const failureSource = [
        'Unicode true',
        'RequestExecutionLevel user',
        'SilentInstall silent',
        'OutFile "' + failureExe + '"',
        '!include "LogicLib.nsh"',
        '!include "' + path.join(desktop, 'resources/winget-shortcuts.nsh') + '"',
        'Section',
        '  InitPluginsDir',
        '  CreateDirectory "$PLUGINSDIR\\cindy-shortcuts"',
        '  !insertmacro cindyBackupLink "$EXEDIR\\unrelated.lnk" "saved"',
        ...(parent === 'denied' ? [
          // Confirm this case reaches CopyFiles, not a CreateDirectory failure.
          '  ClearErrors',
          '  CreateDirectory "$EXEDIR\\denied"',
          '  ${If} ${Errors}',
          '    SetErrorLevel 22',
          '    Quit',
          '  ${EndIf}',
        ] : []),
        `  !insertmacro cindyRestoreLink "$EXEDIR\\${parent}\\link.lnk" "saved"`,
        '  FileOpen $0 "$EXEDIR\\unexpected-success" w',
        '  FileClose $0',
        'SectionEnd',
      ].join(String.fromCharCode(10));
      await fs.writeFile(failureNsi, failureSource);
      execFileSync(makensis, ['/V2', '/INPUTCHARSET', 'UTF8', failureNsi], { windowsHide: true, env: { ...process.env, NSISDIR: nsisDir } });
      const result = spawnSync(failureExe, [], { windowsHide: true, timeout: 30000 });
      assert.ifError(result.error);
      assert.equal(result.status, 1, `${parent}: restore failure must exit nonzero`);
      await assert.rejects(fs.access(path.join(root, 'unexpected-success')), { code: 'ENOENT' });
    }
  } finally {
    execFileSync('icacls.exe', [denied, '/remove:d', `*${sid}`], { windowsHide: true });
  }
  console.log('PASS: parent creation and link copy failures exit 1 without reaching the success path.');

  const app = path.join(root, 'app');
  await fs.mkdir(path.join(app, 'resources'), { recursive: true });
  await fs.writeFile(path.join(app, 'Cindy.exe'), 'compile-only fixture');
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'cindy-installer-fixture', version: '0.1.80', description: 'Compile-only fixture',
    author: 'Cindy tests',
  }));
  await build({
    projectDir: root,
    prepackaged: app,
    targets: Platform.WINDOWS.createTarget('nsis', Arch.x64),
    publish: 'never',
    config: {
      appId: 'com.xd.cindy', productName: 'Cindy', electronVersion: '40.0.0',
      directories: { output: path.join(root, 'out'), buildResources: path.join(desktop, 'resources') },
      win: { signAndEditExecutable: false },
      nsis: {
        // Match production: installer-directory.nsh supplies the directory page.
        oneClick: false, allowElevation: true, allowToChangeInstallationDirectory: false,
        createDesktopShortcut: 'always', createStartMenuShortcut: true,
        shortcutName: 'Cindy', runAfterFinish: false,
        include: path.join(desktop, 'resources/installer.nsh'),
      },
    },
  });
  console.log('PASS: production installer and uninstaller compile against pinned electron-builder.');
} finally {
  // Only this freshly allocated fixture directory is eligible for cleanup.
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('cindy-winget-shortcuts-'));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
