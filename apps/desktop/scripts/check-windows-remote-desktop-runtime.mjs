// Explicit Windows x64 integration acceptance for #8571; not a unit test.
// Production entry/result: real Cargo artifacts, Windows loader, Electron,
// and the production NSIS hooks must work without a usable VC++ runtime.
// Coverage gap: mocked setup diagnostics and the directory preflight check do
// not load the helpers or run a replacement installation.
// Minimal failure: a dynamically linked host beside an unusable VCRUNTIME140.dll.
// Resource tier: explicit native integration (compilers, processes, isolated
// per-user installer identity). Does not change system DLLs or install services.
// This is a loader-fault test, not a clean-VM or registered-service acceptance.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

assert.equal(process.platform, 'win32', 'Requires Windows');
assert.equal(process.arch, 'x64', 'This acceptance check covers Windows x64');
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(desktop, '..', '..');
const native = path.join(desktop, 'native', 'remote-desktop');
const require = createRequire(path.join(desktop, 'package.json'));
const { build, Platform, Arch } = require('app-builder-lib');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-crt-check-'));
const product = `CindyCRTProbe-${randomUUID().slice(0, 8)}`;
const installation = path.join(root, 'install');
const started = performance.now();
console.log(`Runtime acceptance directory: ${root}`);

function run(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    cwd: repo,
    windowsHide: true,
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}

function cargo(crate, directory, target, dynamic = false) {
  const env = { ...process.env };
  delete env.CARGO_ENCODED_RUSTFLAGS;
  delete env.RUSTFLAGS;
  if (dynamic) env.RUSTFLAGS = '-C target-feature=-crt-static';
  console.log(`Building ${directory} (${dynamic ? 'dynamic control' : 'static CRT'})`);
  run(
    'cargo',
    [
      'build',
      '--release',
      '--locked',
      '--target',
      'x86_64-pc-windows-msvc',
      '--config',
      path.join(native, '.cargo', 'config.toml'),
      '--manifest-path',
      path.join(native, crate, 'Cargo.toml'),
      '--target-dir',
      path.join(root, directory),
      ...(target === '--lib'
        ? ['--lib']
        : ['--bin', `cindy-${crate.replace('windows-', 'windows-desktop-')}`]),
    ],
    { env },
  );
  return path.join(root, directory, 'x86_64-pc-windows-msvc', 'release');
}

// Windows command-line quoting, including a path ending in a backslash.
function quote(value) {
  if (!/[\s"]/.test(value)) return value;
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
}

const launcher = path.join(root, 'launch.ps1');
const request = path.join(root, 'launch.json');
await fs.writeFile(
  launcher,
  `
$ErrorActionPreference = 'Stop'
Add-Type 'using System.Runtime.InteropServices; public static class CRTProbeErrorMode { [DllImport("kernel32.dll")] public static extern uint SetErrorMode(uint mode); }'
[CRTProbeErrorMode]::SetErrorMode(0x8003) | Out-Null
$req = Get-Content -LiteralPath $args[0] -Raw | ConvertFrom-Json
$info = New-Object System.Diagnostics.ProcessStartInfo
$info.FileName = $req.binary
$info.Arguments = $req.arguments
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
$process = New-Object System.Diagnostics.Process
$process.StartInfo = $info
$process.Start() | Out-Null
$stdout = $process.StandardOutput.ReadToEndAsync()
$stderr = $process.StandardError.ReadToEndAsync()
if (-not $process.WaitForExit(30000)) { $process.Kill(); throw 'Fixture process timed out' }
@{ code = $process.ExitCode; stdout = $stdout.Result; stderr = $stderr.Result } | ConvertTo-Json -Compress
$process.Dispose()
`,
);

async function launch(binary, args) {
  // NSIS consumes the remainder of the command line for /D= and _?=. These
  // directory switches must be last and unquoted, even if the path has spaces.
  const commandLine = args
    .map((value, index) => {
      if (/^(\/D=|_\?=)/.test(value)) {
        assert.equal(index, args.length - 1);
        return value;
      }
      return quote(value);
    })
    .join(' ');
  await fs.writeFile(request, JSON.stringify({ binary, arguments: commandLine }));
  return JSON.parse(
    run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', launcher, request],
      { timeout: 45_000 },
    ).trim(),
  );
}

async function install(setup) {
  const result = await launch(setup, ['/S', '/currentuser', `/D=${installation}`]);
  assert.equal(result.code, 0, JSON.stringify(result));
}

let installed = false;
let completed = false;
try {
  const baseline = cargo('windows-host', 'baseline', '--bin', true);
  const host = cargo('windows-host', 'host-bin', '--bin');
  const addon = cargo('windows-host', 'host-addon', '--lib');
  const input = cargo('windows-input', 'input', '--bin');
  const vswhere = path.join(
    process.env['ProgramFiles(x86)'],
    'Microsoft Visual Studio',
    'Installer',
    'vswhere.exe',
  );
  const dumpbin = run(vswhere, [
    '-latest',
    '-products',
    '*',
    '-requires',
    'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '-find',
    'VC\\Tools\\MSVC\\**\\bin\\Hostx64\\x64\\dumpbin.exe',
  ])
    .trim()
    .split(/\r?\n/)[0];
  assert.ok(dumpbin, 'MSVC dumpbin is required');
  const hostName = 'cindy-windows-desktop-host.exe';
  const inputName = 'cindy-windows-desktop-input.exe';
  const addonName = 'cindy-windows-desktop-host.node';
  const artifacts = [
    [path.join(host, hostName), hostName],
    [path.join(input, inputName), inputName],
    [path.join(addon, 'cindy_windows_desktop_host.dll'), addonName],
  ];
  assert.match(run(dumpbin, ['/DEPENDENTS', path.join(baseline, hostName)]), /VCRUNTIME140\.dll/i);
  for (const [file, name] of artifacts) {
    assert.doesNotMatch(
      run(dumpbin, ['/DEPENDENTS', file]),
      /VCRUNTIME\d|MSVCP\d|ucrtbase\.dll|api-ms-win-crt-/i,
    );
    console.log(`PASS: no dynamic CRT imports in ${name}`);
  }

  const payload = path.join(root, 'payload');
  const helpers = path.join(payload, 'resources', 'tools', 'remote-desktop');
  await fs.mkdir(helpers, { recursive: true });
  for (const [source, name] of artifacts) await fs.copyFile(source, path.join(helpers, name));
  // Deliberately unusable app-local DLL. The dynamic baseline must fail at the
  // loader, while the unchanged static artifacts must ignore it. System DLLs
  // and their ACLs are never touched, and loader dialogs are suppressed only
  // in the isolated launcher process and its children.
  const poison = Buffer.from('Intentionally unusable VC runtime fixture for issue 8571');
  await fs.writeFile(path.join(helpers, 'VCRUNTIME140.dll'), poison);
  const negative = path.join(root, 'negative');
  await fs.mkdir(negative);
  await fs.copyFile(path.join(baseline, hostName), path.join(negative, hostName));
  await fs.writeFile(path.join(negative, 'VCRUNTIME140.dll'), poison);
  const failed = await launch(path.join(negative, hostName), ['--status']);
  // Windows can report invalid-image-format or invalid-image-not-MZ for the
  // intentionally malformed DLL, depending on the loader version.
  const loaderCode = failed.code >>> 0;
  assert.ok([0xc000007b, 0xc000012f].includes(loaderCode), JSON.stringify(failed));
  console.log(
    `PASS: dynamic baseline fails with loader error 0x${loaderCode.toString(16).toUpperCase()}`,
  );
  const status = await launch(path.join(helpers, hostName), ['--status']);
  assert.equal(status.code, 0, JSON.stringify(status));
  assert.equal(status.stdout.trim(), 'missing');
  console.log('PASS: static host starts with unusable app-local runtime');
  run(
    require('electron'),
    [
      '-e',
      `
    const assert = require('node:assert/strict');
    const addon = require(process.argv[1]);
    assert.equal(typeof addon.DesktopConnection.open, 'function');
    addon.DesktopConnection.open('missing-fixture.exe', '{}').then(
      () => { throw new Error('Missing fixture unexpectedly connected'); },
      error => { assert.match(error.message, /DESKTOP_SYSTEM_SERVICE_UNAVAILABLE/); },
    );
  `,
      path.join(helpers, addonName),
    ],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
  );
  console.log('PASS: Electron loads static addon and executes its async error path');

  // Valid inert payload, never launched; the unique product/appId prevents the
  // installer, shortcuts and context-menu hooks from addressing an existing app.
  await fs.copyFile(path.join(host, hostName), path.join(payload, `${product}.exe`));
  for (const version of ['0.0.1', '0.0.2']) {
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: product.toLowerCase(),
        version,
        description: 'Isolated CRT acceptance',
        author: 'Test',
      }),
    );
    await fs.writeFile(path.join(payload, 'build-marker.txt'), version);
    await build({
      projectDir: root,
      prepackaged: payload,
      targets: Platform.WINDOWS.createTarget('nsis', Arch.x64),
      config: {
        appId: `app.cindy.crt-test.${product}`,
        productName: product,
        electronVersion: require('electron/package.json').version,
        compression: 'store',
        directories: {
          output: path.join(root, 'out'),
          buildResources: path.join(desktop, 'resources'),
        },
        win: { signAndEditExecutable: false, sign: async () => {} },
        nsis: {
          oneClick: false,
          allowElevation: true,
          allowToChangeInstallationDirectory: false,
          createDesktopShortcut: false,
          createStartMenuShortcut: false,
          runAfterFinish: false,
          include: path.join(desktop, 'resources', 'installer.nsh'),
          artifactName: `setup-${version}.exe`,
        },
      },
    });
    await install(path.join(root, 'out', `setup-${version}.exe`));
    installed = true;
    assert.equal(await fs.readFile(path.join(installation, 'build-marker.txt'), 'utf8'), version);
    const installedStatus = await launch(
      path.join(installation, 'resources', 'tools', 'remote-desktop', hostName),
      ['--status'],
    );
    assert.equal(installedStatus.code, 0, JSON.stringify(installedStatus));
    assert.equal(installedStatus.stdout.trim(), 'missing');
    console.log(
      `PASS: ${version === '0.0.1' ? 'fresh install' : 'replacement install'} exits 0 with unusable runtime`,
    );
  }
  const uninstaller = path.join(root, 'uninstall-probe.exe');
  await fs.copyFile(path.join(installation, `Uninstall ${product}.exe`), uninstaller);
  const removed = await launch(uninstaller, ['/S', '/currentuser', `_?=${installation}`]);
  assert.equal(removed.code, 0, JSON.stringify(removed));
  installed = false;
  await assert.rejects(fs.access(path.join(installation, 'build-marker.txt')), { code: 'ENOENT' });
  await assert.rejects(
    fs.access(path.join(installation, 'resources', 'tools', 'remote-desktop', hostName)),
    { code: 'ENOENT' },
  );
  const registration = spawnSync(
    'reg.exe',
    ['query', `HKCU\\Software\\Classes\\Directory\\shell\\${product}`],
    { windowsHide: true },
  );
  assert.equal(registration.status, 1, 'Fixture context-menu registration must be removed');
  console.log('PASS: direct uninstall exits 0 and removes fixture payload and context menu');
  console.log(
    `PASS: runtime acceptance completed in ${((performance.now() - started) / 1000).toFixed(1)}s`,
  );
  completed = true;
} finally {
  const uninstaller = path.join(installation, `Uninstall ${product}.exe`);
  const hasUninstaller = await fs.access(uninstaller).then(
    () => true,
    () => false,
  );
  if (installed || hasUninstaller) {
    try {
      const cleanup = path.join(root, 'cleanup-uninstaller.exe');
      await fs.copyFile(uninstaller, cleanup);
      const result = await launch(cleanup, ['/S', '/currentuser', `_?=${installation}`]);
      installed = result.code !== 0;
      if (installed) console.warn(`Fixture uninstall failed: ${JSON.stringify(result)}`);
    } catch (error) {
      console.warn(`Fixture cleanup failed: ${error.message}`);
    }
  }
  // A failed install is preserved for diagnosis and explicit fixture cleanup.
  // Successful cleanup is restricted to the unique temporary root allocated here.
  if (completed && !installed) {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('cindy-crt-check-'));
    await fs.rm(root, { recursive: true, force: true });
  } else {
    console.log(`Incomplete fixture retained for diagnosis: ${root}`);
  }
}
