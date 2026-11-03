import { fileURLToPath } from 'node:url';
// 桌面打包参数解析与产物架构命名的单测（apps/desktop/scripts/ci/package-lib.mjs）。
//
// 这层是「在哪台机器上能打出哪个包、包叫什么名字」的唯一判定点，错了会直接
// 顶着错误的架构后缀发出安装包。用 node 内置 test runner，不依赖 vitest。
// 被测逻辑以纯函数为主，版本占位契约包含少量仓库内文件 IO。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  PLATFORM_ARCHS,
  VERSIONLESS_VERSION,
  assertPageManualCommitted,
  buildBuildInfo,
  debianArch,
  pageManualBuildInfo,
  parsePackageArgs,
  packageNodeOptions,
} from '../../apps/desktop/scripts/ci/package-lib.mjs';

test('package Node options add headroom and preserve explicit limits and unrelated options', () => {
  const clean = { NODE_OPTIONS: '--trace-warnings' };
  assert.equal(packageNodeOptions({}), '--max-old-space-size=8192');
  assert.equal(packageNodeOptions({ NODE_OPTIONS: '  ' }), '--max-old-space-size=8192');
  assert.equal(packageNodeOptions(clean), '--trace-warnings --max-old-space-size=8192');
  assert.equal(clean.NODE_OPTIONS, '--trace-warnings');
  for (const value of [
    '--max-old-space-size=4096',
    '--max_old_space_size=6144',
    '--max-old-space-size 12288',
    '"--max-old-space-size=4096"',
    '"--max-old-space-size" 4096',
    '--trace-warnings --max-old-space-size="4096"',
  ]) {
    assert.equal(packageNodeOptions({ NODE_OPTIONS: value }), value);
  }
  const preload = '--require "./preload --max-old-space-size=4096.cjs"';
  assert.equal(packageNodeOptions({ NODE_OPTIONS: preload }), preload + ' --max-old-space-size=8192');
});

test('Desktop package and build launch Node with the expected heap, arguments and exit status', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-forge-heap-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  // Exercise the actual launcher against a local fake Forge CLI; do not package
  // the app or access developer data from a default unit test.
  const desktop = path.join(temp, 'desktop with spaces');
  for (const rel of ['scripts/forge-cli.mjs', 'scripts/ci/package-lib.mjs']) {
    const dest = path.join(desktop, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(new URL('../../apps/desktop/' + rel, import.meta.url), dest);
  }
  const fakeCli = path.join(desktop, 'node_modules', '@electron-forge', 'cli', 'dist', 'electron-forge.js');
  fs.mkdirSync(path.dirname(fakeCli), { recursive: true });
  fs.writeFileSync(fakeCli, [
    'console.log(JSON.stringify({',
    '  heap: require("node:v8").getHeapStatistics().heap_size_limit,',
    '  options: process.env.NODE_OPTIONS,',
    '  argv: process.argv.slice(2),',
    '  cwd: process.cwd(),',
    '  inherited: process.env.FORGE_HEAP_TEST_ENV,',
    '}));',
    'if (process.argv.includes("--fixture-fail")) process.exitCode = 7;',
  ].join('\n'));
  const desktopPackageJson = JSON.parse(fs.readFileSync(
    new URL('../../apps/desktop/package.json', import.meta.url),
    'utf8',
  ));
  const run = (script, nodeOptions, args = []) => {
    const [runtime, ...command] = desktopPackageJson.scripts[script].split(' ');
    assert.equal(runtime, 'node');
    return spawnSync(process.execPath, [...command, ...args], {
      cwd: desktop,
      env: { ...process.env, NODE_OPTIONS: nodeOptions, FORGE_HEAP_TEST_ENV: 'kept' },
      encoding: 'utf8',
    });
  };
  for (const [script, command] of [['package', 'package'], ['build', 'make']]) {
    for (const [options, limitMiB] of [['--trace-warnings', 8192], ['"--max-old-space-size=4096"', 4096]]) {
      const args = ['--arch', 'x64', '--out', 'path with spaces & symbols'];
      const result = run(script, options, args);
      assert.equal(result.status, 0, result.stderr);
      const child = JSON.parse(result.stdout);
      assert.ok(child.heap >= limitMiB * 1024 * 1024 && child.heap < (limitMiB + 1024) * 1024 * 1024);
      assert.equal(child.options, limitMiB === 8192 ? options + ' --max-old-space-size=8192' : options);
      assert.deepEqual(child.argv, [command, ...args]);
      assert.equal(fs.realpathSync(child.cwd), fs.realpathSync(desktop));
      assert.equal(child.inherited, 'kept');
    }
  }
  const failed = run('build', '', ['--fixture-fail']);
  assert.equal(failed.status, 7, failed.stderr);
});

test('Desktop 默认版本与 versionless 打包哨兵一致', () => {
  const desktopPackageJson = JSON.parse(fs.readFileSync(
    new URL('../../apps/desktop/package.json', import.meta.url),
    'utf8',
  ));
  assert.equal(desktopPackageJson.version, VERSIONLESS_VERSION);
});

test('PLATFORM_ARCHS: linux 支持 x64 与 arm64', () => {
  assert.deepEqual([...PLATFORM_ARCHS.linux].sort(), ['arm64', 'x64']);
  // win32 仍只发 x64；darwin 保持双架构。
  assert.deepEqual([...PLATFORM_ARCHS.win32], ['x64']);
  assert.deepEqual([...PLATFORM_ARCHS.darwin].sort(), ['arm64', 'x64']);
});

test('parsePackageArgs: 版本无关本地包默认 global', () => {
  const out = parsePackageArgs([], { platform: 'linux', arch: 'x64' });
  assert.equal(out.region, 'global');
  assert.equal(out.versionSpec, null);
});

test('parsePackageArgs: 版本化打包必须显式指定 region', () => {
  assert.throws(
    () => parsePackageArgs(['--version', '1.2.3'], {
      platform: 'linux',
      arch: 'x64',
    }),
    /必须显式传 --region/,
  );
  assert.equal(
    parsePackageArgs(['--version', '1.2.3', '--region', 'global'], {
      platform: 'linux',
      arch: 'x64',
    }).region,
    'global',
  );
  assert.equal(
    parsePackageArgs(['--version', '1.2.3', '--region', 'cn'], {
      platform: 'linux',
      arch: 'x64',
    }).region,
    'cn',
  );
});

test('parsePackageArgs: linux 显式 --arch 指向宿主架构时放行', () => {
  // defaults 注入宿主身份,让断言不依赖跑测试的机器。
  for (const arch of ['x64', 'arm64']) {
    const out = parsePackageArgs(['--platform', 'linux', '--arch', arch], {
      platform: 'linux',
      arch,
    });
    assert.equal(out.platform, 'linux');
    assert.deepEqual(out.archs, [arch]);
  }
});

// 这是本层最该守住的约束:linux 原生模块要按目标 arch 重编,vec0.so 也是预编译
// 平台件。放行跨架构只会把失败推到 forge rebuild(烧掉整个 package 阶段),带
// --skip-smoke 时更会静默产出跑不起来的 deb。必须在参数解析就拒。
test('parsePackageArgs: linux 拒绝跨架构打包(两个方向)', () => {
  assert.throws(
    () => parsePackageArgs(['--platform', 'linux', '--arch', 'arm64'], {
      platform: 'linux',
      arch: 'x64',
    }),
    /linux 不支持交叉打包\(当前 x64,目标 arm64\)/,
  );
  assert.throws(
    () => parsePackageArgs(['--platform', 'linux', '--arch', 'x64'], {
      platform: 'linux',
      arch: 'arm64',
    }),
    /linux 不支持交叉打包\(当前 arm64,目标 x64\)/,
  );
});

// darwin 不受上面的约束:Rosetta 2 让 Apple Silicon 主机能打并 smoke darwin-x64,
// 这是发布侧一直在用的路径,别被 linux 的收紧顺手掐掉。
test('parsePackageArgs: darwin 仍允许显式跨架构', () => {
  assert.deepEqual(
    parsePackageArgs(['--platform', 'darwin', '--arch', 'x64'], {
      platform: 'darwin',
      arch: 'arm64',
    }).archs,
    ['x64'],
  );
});

test('parsePackageArgs: linux 缺省取宿主 arch，不连打双架构', () => {
  // defaults 注入宿主身份，让断言不依赖跑测试的机器。
  assert.deepEqual(
    parsePackageArgs([], { platform: 'linux', arch: 'arm64' }).archs,
    ['arm64'],
  );
  assert.deepEqual(
    parsePackageArgs([], { platform: 'linux', arch: 'x64' }).archs,
    ['x64'],
  );
  // 对比：darwin 缺省仍双架构连打。
  assert.deepEqual(
    parsePackageArgs([], { platform: 'darwin', arch: 'arm64' }).archs.sort(),
    ['arm64', 'x64'],
  );
});

test('parsePackageArgs: 拒绝 linux 不支持的 arch', () => {
  assert.throws(
    () => parsePackageArgs(['--platform', 'linux', '--arch', 'ia32']),
    /不支持 arch: ia32/,
  );
  // 宿主 arch 不在支持列表时同样拒绝（缺省路径也要 fail closed）。
  assert.throws(
    () => parsePackageArgs([], { platform: 'linux', arch: 'armv7l' }),
    /不支持 arch: armv7l/,
  );
  // win32 未扩到 arm64，别顺手放行。
  assert.throws(
    () => parsePackageArgs(['--platform', 'win32', '--arch', 'arm64']),
    /不支持 arch: arm64/,
  );
});

test('debianArch: deb 架构名与 maker-deb 一致', () => {
  // 这两条决定归集产物的文件名后缀。
  assert.equal(debianArch('x64'), 'amd64');
  assert.equal(debianArch('arm64'), 'arm64');
  // 与 @electron-forge/maker-deb 的 debianArch 同构（当前不打这些目标，
  // 保持一致是为了将来扩架构时不用回头改映射）。
  assert.equal(debianArch('ia32'), 'i386');
  assert.equal(debianArch('armv7l'), 'armhf');
  assert.equal(debianArch('arm'), 'armel');
});

// build-info.mcpAppsManual 是发布侧(publish-page-manual.mjs)核对上传字节的依据:
// 记的必须是安装包里实际打进去的手册;版本无关包与没有内置手册的构建记 null。
// 有版本打包时手册有未提交改动必须拒绝,否则安装包内置的手册和发版提交对不上。
test('build-info 记录安装包内手册,打包拒绝未提交的手册', () => {
  const bytes = new TextEncoder().encode('# manual\n');
  const manual = pageManualBuildInfo(bytes);
  assert.deepEqual(manual, {
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
  });
  assert.equal(pageManualBuildInfo(null), null);
  const base = { version: '1.2.3', region: 'global', platform: 'darwin', arch: 'arm64', files: [], signing: {} };
  assert.deepEqual(buildBuildInfo({ ...base, versionless: false, mcpAppsManual: manual }).mcpAppsManual, manual);
  assert.equal(buildBuildInfo({ ...base, versionless: false, mcpAppsManual: null }).mcpAppsManual, null);
  assert.equal(buildBuildInfo({ ...base, versionless: true, mcpAppsManual: manual }).mcpAppsManual, null);

  const manualPath = 'apps/desktop/resources/system-skills/x/PAGE-GENERATION.md';
  assert.doesNotThrow(() => assertPageManualCommitted({ porcelain: '', versionless: false, manualPath }));
  assert.throws(() => assertPageManualCommitted({ porcelain: ' M x/PAGE-GENERATION.md\n', versionless: false, manualPath }), /未提交改动/);
  assert.doesNotThrow(() => assertPageManualCommitted({ porcelain: ' M x/PAGE-GENERATION.md\n', versionless: true, manualPath }));
});

// Production entry: actual smoke-packaged.mjs, child_process adapter only.
// Regression: environment-setup sandbox contract. Existing brand tests do not
// observe Electron's environment. No Electron/App/network runs.
// Tier: existing scripts node:test launcher contract.
test('packaged smoke removes inherited sandbox disable and retains successful DB validation', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-smoke-env-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const out = path.join(temp, 'packaged');
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'Cindy'), 'not an Electron executable');
  const preload = path.join(temp, 'capture-spawn.cjs');
  fs.writeFileSync(preload, [
    "const cp = require('node:child_process');",
    "const { EventEmitter } = require('node:events');",
    "const { PassThrough } = require('node:stream');",
    "cp.spawn = (exe, argv, options) => {",
    "  console.log('CAPTURE:' + JSON.stringify({",
    "    keys: Object.keys(options.env).filter(k => k.toLowerCase() === 'electron_disable_sandbox'),",
    "    marker: options.env.SMOKE_ENV_TEST_MARKER,",
    "    parent: process.env.ELECTRON_DISABLE_SANDBOX ?? null,",
    "    parentMixedCase: process.env.Electron_Disable_Sandbox ?? null,",
    "    userData: argv.find(a => a.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length),",
    "    smoke: argv.includes('--smoke-test'),",
    "  }));",
    "  const child = new EventEmitter();",
    "  child.stdout = new PassThrough(); child.stderr = new PassThrough();",
    "  child.kill = () => { throw new Error('unexpected timeout'); };",
    "  process.nextTick(() => {",
    "    child.stdout.end(JSON.stringify({ ok: true, schema_version: 0, tables: { sessions: 0, messages: 0, migration_meta: 0 } }) + String.fromCharCode(10));",
    "    child.emit('exit', 0, null);",
    "  });",
    "  return child;",
    "};",
    "require('node:module').syncBuiltinESMExports();",
  ].join('\n'));
  for (const inherited of [undefined, '1']) {
    const env = { ...process.env, SMOKE_ENV_TEST_MARKER: 'kept' };
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === 'electron_disable_sandbox') delete env[key];
    }
    if (inherited !== undefined) {
      env.ELECTRON_DISABLE_SANDBOX = inherited;
      env.Electron_Disable_Sandbox = inherited;
    }
    const result = spawnSync(process.execPath, [
      '--require', preload,
      fileURLToPath(new URL('../../apps/desktop/scripts/smoke-packaged.mjs', import.meta.url)),
      '--platform=linux', '--arch=arm64', '--out-dir=' + out,
    ], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const observed = JSON.parse(result.stdout.split(/\r?\n/).find(l => l.startsWith('CAPTURE:')).slice(8));
    assert.deepEqual(observed.keys, []);
    assert.equal(observed.marker, 'kept');
    assert.equal(observed.parent, inherited ?? null);
    assert.equal(observed.parentMixedCase, inherited ?? null);
    assert.equal(observed.smoke, true);
    assert.equal(fs.existsSync(observed.userData), false);
    assert.match(result.stdout, /smoke test passed/);
  }
});

// Production parser/checkpoint and actual Node entries; environment-setup's
// sandbox contract. Existing launcher tests do not cover permission handoff.
// Unit launcher contract: synthetic process identity is never OS/root proof.
test('Linux sandbox checkpoint is explicit and cannot accompany skipped smoke', () => {
  const defaults = { platform: 'linux', arch: 'arm64' };
  assert.equal(parsePackageArgs([], defaults).prepareLinuxSandbox, undefined);
  assert.equal(parsePackageArgs(['--prepare-linux-sandbox'], defaults).prepareLinuxSandbox, true);
  assert.throws(() => parsePackageArgs(['--prepare-linux-sandbox', '--skip-smoke'], defaults), /mandatory smoke/);
  for (const platform of ['darwin', 'win32']) {
    assert.throws(() => parsePackageArgs(['--prepare-linux-sandbox'], { platform, arch: 'x64' }), /requires Linux/);
  }
});

test('Linux sandbox preparation rejects changed bytes, directories, permissions and shared inode', async () => {
  const { assertPreparedLinuxSandbox } = await import('../../apps/desktop/scripts/ci/linux-sandbox-checkpoint.mjs');
  const before = { dirs: [{ dev: 1, ino: 10 }], helper: {
    dev: 1, ino: 20, uid: 501, gid: 501, mode: 0o755, nlink: 2, sha256: 'original',
  } };
  const ready = structuredClone(before);
  Object.assign(ready.helper, { ino: 21, uid: 0, gid: 0, mode: 0o4755, nlink: 1 });
  assert.doesNotThrow(() => assertPreparedLinuxSandbox(before, ready));
  assert.doesNotThrow(() => assertPreparedLinuxSandbox(ready, ready));
  for (const [field, value, error] of [
    ['sha256', 'different', /identity or bytes/], ['dev', 2, /identity or bytes/],
    ['uid', 501, /root:root/], ['gid', 501, /root:root/],
    ['mode', 0o755, /4755/], ['nlink', 2, /hard link/], ['ino', 20, /private copy/],
  ]) {
    const changed = structuredClone(ready);
    changed.helper[field] = value;
    assert.throws(() => assertPreparedLinuxSandbox(before, changed), error);
  }
  const changedDirectory = structuredClone(ready);
  changedDirectory.dirs[0].ino++;
  assert.throws(() => assertPreparedLinuxSandbox(before, changedDirectory), /identity or bytes/);
});

test('actual packaging and checkpoint Node entries reject unsafe preparation before any child launch', (t) => {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-checkpoint-')));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const preload = path.join(temp, 'isolate.cjs');
  fs.writeFileSync(preload, [
    "const fs = require('node:fs'); const cp = require('node:child_process');",
    "const exists = fs.existsSync; const read = fs.readFileSync;",
    "const privateFile = p => /(?:^|[\\\\/])(?:[.]env|release-regions[.]json|log-upload[.]json)$/.test(String(p));",
    "fs.existsSync = p => privateFile(p) ? false : exists(p);",
    "fs.readFileSync = (p, ...a) => { if (privateFile(p)) throw new Error('PRIVATE_FILE_READ'); return read(p, ...a); };",
    "for (const name of ['spawn', 'spawnSync', 'execSync', 'execFileSync']) cp[name] = () => { console.error('UNEXPECTED_CHILD'); throw new Error('UNEXPECTED_CHILD'); };",
    "global.fetch = () => { throw new Error('UNEXPECTED_NETWORK'); };",
    "Object.defineProperty(process, 'platform', { value: process.env.CHECKPOINT_PLATFORM });",
    "process.getuid = () => Number(process.env.CHECKPOINT_UID);",
    "Object.defineProperty(process.stdin, 'isTTY', { value: process.env.CHECKPOINT_TTY === '1' });",
    "Object.defineProperty(process.stdout, 'isTTY', { value: process.env.CHECKPOINT_TTY === '1' });",
    "require('node:module').syncBuiltinESMExports();",
  ].join('\n'));
  const run = (script, args, identity, input = '') => spawnSync(process.execPath, [
    '--require', preload, script, ...args,
  ], { encoding: 'utf8', input, env: {
    PATH: process.env.PATH, HOME: temp, TMPDIR: temp,
    CHECKPOINT_PLATFORM: identity.platform, CHECKPOINT_UID: String(identity.uid),
    CHECKPOINT_TTY: identity.tty ? '1' : '0',
  } });
  const checkFailure = (result, error) => {
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, error);
    assert.doesNotMatch(result.stdout + result.stderr, /UNEXPECTED_CHILD|PRIVATE_FILE_READ|UNEXPECTED_NETWORK|SMOKE_STARTED/);
  };
  const packaging = fileURLToPath(new URL('../../apps/desktop/scripts/package-desktop.mjs', import.meta.url));
  for (const identity of [
    { platform: 'darwin', uid: 501, tty: true },
    { platform: 'linux', uid: 0, tty: true },
    { platform: 'linux', uid: 501, tty: false },
  ]) {
    checkFailure(run(packaging, ['--platform', 'linux', '--arch', process.arch, '--prepare-linux-sandbox'], identity), /ordinary user foreground terminal/);
  }
  const out = path.join(temp, 'out'); const app = path.join(out, 'Cindy-linux-' + process.arch);
  fs.mkdirSync(app, { recursive: true, mode: 0o700 }); fs.chmodSync(out, 0o700);
  const helper = path.join(app, 'chrome-sandbox'); fs.writeFileSync(helper, 'synthetic helper', { mode: 0o755 });
  const runner = path.join(temp, 'checkpoint.mjs');
  const checkpointUrl = new URL('../../apps/desktop/scripts/ci/linux-sandbox-checkpoint.mjs', import.meta.url).href;
  const smokeUrl = new URL('../../apps/desktop/scripts/smoke-packaged.mjs', import.meta.url).href;
  fs.writeFileSync(runner, [
    'import { prepareLinuxSandboxCheckpoint } from ' + JSON.stringify(checkpointUrl) + ';',
    'await prepareLinuxSandboxCheckpoint(process.argv[2], process.argv[3]);',
    "console.log('SMOKE_STARTED');",
    'await import(' + JSON.stringify(smokeUrl) + ');',
  ].join('\n'));
  // Real temp metadata is used here. A synthetic root identity never grants
  // filesystem privileges; uid matches only the ordinary test user's files.
  const uid = fs.statSync(app).uid;
  const identity = { platform: 'linux', uid, tty: true };
  checkFailure(run(runner, [out, app], { ...identity, tty: false }), /foreground terminal|ordinary Linux/);
  if (uid !== 0) {
    checkFailure(run(runner, [out, app], identity), /preparation aborted/);
    checkFailure(run(runner, [out, app], identity, 'continue\n'), /root:root/);
    fs.renameSync(helper, helper + '.original'); fs.symlinkSync(helper + '.original', helper);
    checkFailure(run(runner, [out, app], identity, 'continue\n'), /regular file/);
    assert.equal(fs.readFileSync(helper + '.original', 'utf8'), 'synthetic helper');
  }
});
