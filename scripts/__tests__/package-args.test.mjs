// 桌面打包参数解析与产物架构命名的单测（apps/desktop/scripts/ci/package-lib.mjs）。
//
// 这层是「在哪台机器上能打出哪个包、包叫什么名字」的唯一判定点，错了会直接
// 顶着错误的架构后缀发出安装包。用 node 内置 test runner，不依赖 vitest：
// 被测模块是纯函数、零 IO，可直接 `node --test scripts/__tests__/`。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PLATFORM_ARCHS,
  debianArch,
  parsePackageArgs,
} from '../../apps/desktop/scripts/ci/package-lib.mjs';

test('PLATFORM_ARCHS: linux 支持 x64 与 arm64', () => {
  assert.deepEqual([...PLATFORM_ARCHS.linux].sort(), ['arm64', 'x64']);
  // win32 仍只发 x64；darwin 保持双架构。
  assert.deepEqual([...PLATFORM_ARCHS.win32], ['x64']);
  assert.deepEqual([...PLATFORM_ARCHS.darwin].sort(), ['arm64', 'x64']);
});

test('parsePackageArgs: linux 显式 --arch 两种架构都放行', () => {
  for (const arch of ['x64', 'arm64']) {
    const out = parsePackageArgs(['--platform', 'linux', '--arch', arch]);
    assert.equal(out.platform, 'linux');
    assert.deepEqual(out.archs, [arch]);
  }
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
