/**
 * Windows-only NSIS integration check, outside the default unit tier.
 * Runs the production macro against a unique scratch registry subtree, never
 * real startup entries. Set CINDY_NSIS_BIN if makensis is not already cached.
 * Usage: node apps/desktop/scripts/test-login-item-uninstall.mjs
 */
import assert from 'node:assert/strict';
import console from 'node:console';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

assert.equal(process.platform, 'win32', 'This integration check requires Windows and NSIS.');
const cache = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'electron-builder', 'Cache', 'nsis');
const compiler = process.env.CINDY_NSIS_BIN || (fs.existsSync(cache)
  ? fs.readdirSync(cache).filter((name) => name.startsWith('nsis-')).sort().reverse()
    .map((name) => path.join(cache, name, 'Bin', 'makensis.exe')).find(fs.existsSync)
  : undefined);
assert.ok(compiler && fs.existsSync(compiler), 'Set CINDY_NSIS_BIN to makensis.exe.');
const installer = fs.readFileSync(fileURLToPath(new URL('../resources/installer.nsh', import.meta.url)), 'utf8');
const start = installer.indexOf('!macro cindyRemoveLoginItemOnUninstall');
assert.ok(start >= 0);
const macro = installer.slice(start, installer.indexOf('!macroend', start) + '!macroend'.length);
const uninstallStart = installer.indexOf('!macro customUnInstall');
const uninstall = installer.slice(uninstallStart, installer.indexOf('!macroend', uninstallStart));
assert.ok(uninstall.includes('!insertmacro cindyRemoveLoginItemOnUninstall'));
const registryRoot = path.win32.join('Software', 'CindyLoginItemUninstallTest', randomUUID());
const runKey = path.win32.join(registryRoot, 'Run');
const approvedKey = path.win32.join(registryRoot, 'StartupApproved');
const windowsKey = path.win32.join('Software', 'Microsoft', 'Windows', 'CurrentVersion');
const isolatedMacro = macro
  .replaceAll(path.win32.join(windowsKey, 'Run'), runKey)
  .replaceAll(path.win32.join(windowsKey, 'Explorer', 'StartupApproved', 'Run'), approvedKey);
assert.ok(!isolatedMacro.includes(windowsKey), 'All registry access must be isolated.');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-uninstall-check-'));
const script = path.join(root, 'check.nsi');
const binary = path.join(root, 'check.exe');
const result = path.join(root, 'result.txt');
const newline = String.fromCharCode(10);
const nsisNewline = '$' + String.fromCharCode(92) + 'r$' + String.fromCharCode(92) + 'n';
const ownBare = path.win32.join('$INSTDIR', '${APP_EXECUTABLE_FILENAME}');
const ownQuoted = '"' + ownBare + '"';
const other = '"' + path.win32.join('C:', 'Another Install', '${APP_EXECUTABLE_FILENAME}') + '"';
const cases = [
  { name: 'uninstall-enabled', command: ownQuoted, approval: '2', remove: true },
  { name: 'uninstall-disabled', command: ownQuoted, approval: '3', remove: true },
  { name: 'uninstall-unquoted', command: ownBare, approval: '2', remove: true },
  { name: 'upgrade-enabled', command: ownQuoted, approval: '2', updated: true },
  { name: 'upgrade-disabled', command: ownQuoted, approval: '3', updated: true },
  { name: 'other-install', command: other, approval: '2' },
  { name: 'different-arguments', command: `${ownQuoted} --other`, approval: '2' },
  { name: 'missing-entry', command: '', approval: '' },
];

try {
  const lines = [
    '!include "LogicLib.nsh"',
    '!define PRODUCT_FILENAME "CindyTest"',
    '!define APP_EXECUTABLE_FILENAME "${PRODUCT_FILENAME}.exe"',
    '!define isUpdated `$updating == 1`',
    'Name "Cindy login item uninstall check"',
    `OutFile "${binary}"`,
    'RequestExecutionLevel user', 'SilentInstall silent',
    'Var updating', 'Var failures', 'Var report',
    isolatedMacro,
    'Section', 'SetRegView 64', 'StrCpy $failures 0',
    `StrCpy $INSTDIR "${path.win32.join('C:', 'Program Files', 'Cindy Test')}"`,
    `FileOpen $report "${result}" w`,
    `WriteRegStr HKCU "${runKey}" "AnotherProduct" "keep"`,
    `WriteRegStr HKCU "${approvedKey}" "AnotherProduct" "keep"`,
  ];
  for (const scenario of cases) {
    lines.push(
      `DeleteRegValue HKCU "${runKey}" "CindyTest"`,
      `DeleteRegValue HKCU "${approvedKey}" "CindyTest"`,
      `StrCpy $updating ${scenario.updated ? 1 : 0}`,
      'StrCpy $R0 "caller-register"',
    );
    if (scenario.command) lines.push(`WriteRegStr HKCU "${runKey}" "CindyTest" '${scenario.command}'`);
    // Cleanup must preserve or delete the entire value regardless of type.
    // DWORD markers let NSIS assert both enabled/disabled states with ReadRegStr.
    if (scenario.approval) lines.push(`WriteRegDWORD HKCU "${approvedKey}" "CindyTest" ${scenario.approval}`);
    lines.push(
      '!insertmacro cindyRemoveLoginItemOnUninstall',
      '${If} $R0 != "caller-register"', 'IntOp $failures $failures + 1', '${EndIf}',
      `ReadRegStr $R1 HKCU "${runKey}" "CindyTest"`,
      `ReadRegStr $R2 HKCU "${approvedKey}" "CindyTest"`,
      `StrCpy $R3 '${scenario.remove ? '' : scenario.command}'`,
      `StrCpy $R4 '${scenario.remove ? '' : scenario.approval}'`,
      '${If} $R1 != $R3', 'IntOp $failures $failures + 1', '${EndIf}',
      '${If} $R2 != $R4', 'IntOp $failures $failures + 1', '${EndIf}',
      `FileWrite $report '${scenario.name}: failures=$failures${nsisNewline}'`,
    );
  }
  lines.push(
    `ReadRegStr $R1 HKCU "${runKey}" "AnotherProduct"`,
    `ReadRegStr $R2 HKCU "${approvedKey}" "AnotherProduct"`,
    '${If} $R1 != "keep"', '${OrIf} $R2 != "keep"',
    'IntOp $failures $failures + 1', '${EndIf}',
    `DeleteRegKey HKCU "${registryRoot}"`,
    'FileClose $report', 'SetErrorLevel $failures', 'SectionEnd',
  );
  fs.writeFileSync(script, lines.join(newline), 'utf8');
  const compiled = spawnSync(compiler, ['/V2', script], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  assert.ifError(compiled.error);
  assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout);
  const executed = spawnSync(binary, [], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  if (fs.existsSync(result)) process.stdout.write(fs.readFileSync(result, 'utf8'));
  assert.ifError(executed.error);
  assert.equal(executed.status, 0, 'NSIS cleanup assertions failed');
  console.log(`PASS ${cases.length} NSIS uninstall scenarios; scratch registry removed.`);
} finally {
  spawnSync('reg.exe', ['delete', `HKCU${String.fromCharCode(92)}${registryRoot}`, '/f', '/reg:64'], { windowsHide: true, stdio: 'ignore' });
  assert.ok(root.startsWith(path.join(os.tmpdir(), 'cindy-uninstall-check-')));
  fs.rmSync(root, { recursive: true, force: true });
}
