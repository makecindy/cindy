// 桌面打包参数解析与产物架构命名的单测（apps/desktop/scripts/ci/package-lib.mjs）。
//
// 这层是「在哪台机器上能打出哪个包、包叫什么名字」的唯一判定点，错了会直接
// 顶着错误的架构后缀发出安装包。用 node 内置 test runner，不依赖 vitest。
// 被测逻辑以纯函数为主，版本占位契约包含少量仓库内文件 IO。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  PLATFORM_ARCHS,
  VERSIONLESS_VERSION,
  debianArch,
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
