// ensure-android-platform-tools 纯辅助函数的单测。
//
// 这些 helper 是 adb de-LFS 改动的正确性核心：版本必须从 source.properties 读
// （与许可清单同源，否则清单里的版本号会说谎），就位判定必须逐文件校验 sha256
// （否则半套二进制或被替换的上游包会被当成"已就位"直接打进安装包）。
// 用 node 内置 test runner，不碰网络、不依赖 vitest。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  currentPlatformKey,
  downloadUrlFor,
  expectedHashesFor,
  isSupportedPlatformKey,
  ossZipUrlFor,
  readPinnedVersion,
  resolveOssBaseUrl,
  verifyInstalled,
} from '../../apps/desktop/scripts/ensure-android-platform-tools.mjs';
// 哈希工具本身由 verify-sha256.test.mjs 覆盖，这里只借它做一致性比对。
import { sha256File } from '../../tools/shared/verify-sha256.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const REAL_BIN_ROOT = path.join(REPO_ROOT, 'apps', 'android-platform-tools-bin');

function tmpBinRoot(platformKey, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-pt-test-'));
  const dir = path.join(root, platformKey);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), contents);
  }
  return root;
}

test('isSupportedPlatformKey: 只有 win32-x64 需要预置', () => {
  assert.equal(isSupportedPlatformKey('win32-x64'), true);
  // 其他平台由运行时按需下载到 userData，不该被本脚本认领。
  assert.equal(isSupportedPlatformKey('darwin-arm64'), false);
  assert.equal(isSupportedPlatformKey('linux-x64'), false);
  assert.equal(isSupportedPlatformKey('nonsense'), false);
});

test('currentPlatformKey: 非 win32-x64 宿主返回 null', () => {
  const key = currentPlatformKey();
  if (process.platform === 'win32' && process.arch === 'x64') {
    assert.equal(key, 'win32-x64');
  } else {
    assert.equal(key, null);
  }
});

test('expectedHashesFor: win32-x64 三个文件都 pin 了合法 sha256', () => {
  const hashes = expectedHashesFor('win32-x64');
  assert.deepEqual(Object.keys(hashes).sort(), ['AdbWinApi.dll', 'AdbWinUsbApi.dll', 'adb.exe']);
  for (const [name, hash] of Object.entries(hashes)) {
    assert.match(hash, /^[0-9a-f]{64}$/, `${name} 的 pin 不是 64 位小写 hex sha256`);
  }
  assert.equal(expectedHashesFor('darwin-arm64'), null);
});

test('readPinnedVersion: 从 source.properties 的 Pkg.Revision 读版本', () => {
  const root = tmpBinRoot('win32-x64', {
    'source.properties': 'Pkg.UserSrc=false\nPkg.Revision=32.0.0',
  });
  assert.equal(readPinnedVersion('win32-x64', root), '32.0.0');
});

test('readPinnedVersion: 文件缺失或没有 Pkg.Revision 时报错，不猜 latest', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'android-pt-empty-'));
  assert.throws(() => readPinnedVersion('win32-x64', empty), /source\.properties/);

  const noRevision = tmpBinRoot('win32-x64', { 'source.properties': 'Pkg.UserSrc=false\n' });
  assert.throws(() => readPinnedVersion('win32-x64', noRevision), /Pkg\.Revision/);
});

test('readPinnedVersion: 仓库内真实 source.properties 可解析（与许可清单同源）', () => {
  const version = readPinnedVersion('win32-x64', REAL_BIN_ROOT);
  assert.match(version, /^\d+\.\d+\.\d+$/);
});

test('downloadUrlFor: 用版本化 URL 而不是 -latest-（否则 sha256 pin 无意义）', () => {
  assert.equal(
    downloadUrlFor('win32-x64', '32.0.0'),
    'https://dl.google.com/android/repository/platform-tools_r32.0.0-windows.zip',
  );
  assert.throws(() => downloadUrlFor('darwin-arm64', '32.0.0'), /unsupported platform key/);
});

test('ossZipUrlFor: 上传约定为「原始 zip 原名放在 <base>/android-platform-tools/<version>/」', () => {
  assert.equal(
    ossZipUrlFor('win32-x64', '32.0.0', 'https://hotfix.cindy.com.cn/cindy'),
    'https://hotfix.cindy.com.cn/cindy/android-platform-tools/32.0.0/platform-tools_r32.0.0-windows.zip',
  );
  // 海外 region 只换 base，路径结构不变。
  assert.equal(
    ossZipUrlFor('win32-x64', '32.0.0', 'https://hotfix.cindy.app/cindy'),
    'https://hotfix.cindy.app/cindy/android-platform-tools/32.0.0/platform-tools_r32.0.0-windows.zip',
  );
  assert.throws(() => ossZipUrlFor('darwin-arm64', '32.0.0', 'https://x.test'), /unsupported platform key/);
  assert.throws(() => ossZipUrlFor('win32-x64', '32.0.0', ''), /OSS base url unavailable/);
});

test('resolveOssBaseUrl: 优先 XDT_CDN_BASE_URL，否则回落端点清单的 cdnBaseUrl', (t) => {
  const original = process.env.XDT_CDN_BASE_URL;
  t.after(() => {
    if (original === undefined) delete process.env.XDT_CDN_BASE_URL;
    else process.env.XDT_CDN_BASE_URL = original;
  });

  process.env.XDT_CDN_BASE_URL = 'https://override.test/base/';
  // 尾部斜杠要被去掉，否则拼出来会是双斜杠。
  assert.equal(resolveOssBaseUrl(), 'https://override.test/base');

  delete process.env.XDT_CDN_BASE_URL;
  const fromManifest = resolveOssBaseUrl();
  assert.match(fromManifest, /^https:\/\//);
  assert.doesNotMatch(fromManifest, /\/$/);
});

test('verifyInstalled: 缺少 source.properties 时不算就位', () => {
  const root = tmpBinRoot('win32-x64', { 'adb.exe': 'not the real adb' });
  const r = verifyInstalled('win32-x64', root);
  assert.equal(r.ok, false);
  assert.match(r.reason, /source\.properties/);
});

test('verifyInstalled: source.properties 版本与 PINNED 不匹配时不算就位', () => {
  const root = tmpBinRoot('win32-x64', {
    'source.properties': 'Pkg.Revision=99.0.0',
    'adb.exe': 'fake',
  });
  const r = verifyInstalled('win32-x64', root);
  assert.equal(r.ok, false);
  assert.match(r.reason, /version mismatch/);
});

test('verifyInstalled: 文件缺失时不算就位', () => {
  // 只有 source.properties,三个二进制文件全部缺失 → 命中 "missing" 分支。
  const root = tmpBinRoot('win32-x64', {
    'source.properties': 'Pkg.Revision=32.0.0',
  });
  const r = verifyInstalled('win32-x64', root);
  assert.equal(r.ok, false);
  assert.match(r.reason, /missing/);
});

test('verifyInstalled: 文件内容被篡改时报 sha256 不匹配', () => {
  const root = tmpBinRoot('win32-x64', {
    'source.properties': 'Pkg.Revision=32.0.0',
    'adb.exe': 'not the real adb',
    'AdbWinApi.dll': 'fake dll',
    'AdbWinUsbApi.dll': 'fake dll',
  });
  const r = verifyInstalled('win32-x64', root);
  assert.equal(r.ok, false);
  assert.match(r.reason, /sha256 mismatch/);
});

test('verifyInstalled: 内容被换掉时报 sha256 不匹配', () => {
  const hashes = expectedHashesFor('win32-x64');
  // 三个文件都在，但内容是假的 —— 必须被逐个哈希拦下。
  const files = Object.fromEntries(Object.keys(hashes).map((name) => [name, `fake ${name}`]));
  files['source.properties'] = 'Pkg.Revision=32.0.0';
  const root = tmpBinRoot('win32-x64', files);
  const r = verifyInstalled('win32-x64', root);
  assert.equal(r.ok, false);
  assert.match(r.reason, /sha256 mismatch/);
});

test('verifyInstalled: 未支持的平台不被认为已就位', () => {
  const root = tmpBinRoot('darwin-arm64', { adb: 'x' });
  assert.equal(verifyInstalled('darwin-arm64', root).ok, false);
});

test('pin 的哈希与本机已就位文件一致（文件不在则跳过）', (t) => {
  const hashes = expectedHashesFor('win32-x64');
  const present = Object.keys(hashes).filter((name) =>
    fs.existsSync(path.join(REAL_BIN_ROOT, 'win32-x64', name)),
  );
  if (present.length === 0) {
    // CI / 干净 clone 上这些二进制尚未下载（已 gitignore），无从比对。
    t.skip('platform-tools 二进制未就位，跳过一致性比对');
    return;
  }
  for (const name of present) {
    assert.equal(
      sha256File(path.join(REAL_BIN_ROOT, 'win32-x64', name)),
      hashes[name],
      `${name} 的实际哈希与 pin 不一致 —— 要么本地文件被换过，要么 pin 该更新了`,
    );
  }
});
