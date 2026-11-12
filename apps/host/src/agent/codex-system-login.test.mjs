/*
 * 测试价值
 * - 生产入口与可观察结果：resolveHostSystemCodexAuthPath 在三种运行方式下给出的系统登录路径。
 * - 规则依据：只有安装版 Host 与系统 Codex 登录对账（与已打包桌面相同，读 ~/.codex/auth.json）；
 *   源码运行（开发、测试、沙箱）一律不对账，测试只能给一个指向隔离 HOME 的绝对路径，
 *   安装版忽略这个覆盖。与桌面的对照见 desktop hostCodexSystemLoginParity.test.ts。
 * - 最小失败输入：源码运行默认读 ~/.codex；安装版接受测试覆盖；相对路径被接受。
 * - tier：unit（纯函数，不读写文件）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { HOST_TEST_SYSTEM_CODEX_AUTH_ENV, resolveHostSystemCodexAuthPath } from './codex-system-login.ts';

test('only an installed Host reconciles with the system Codex login', () => {
  const fake = path.join(os.tmpdir(), 'isolated-home', '.codex', 'auth.json');
  // Installed: the desktop's packaged path; a test override is ignored.
  assert.equal(resolveHostSystemCodexAuthPath({ packaged: true }, {}), path.join(os.homedir(), '.codex', 'auth.json'));
  assert.equal(resolveHostSystemCodexAuthPath({ packaged: true }, { [HOST_TEST_SYSTEM_CODEX_AUTH_ENV]: fake }), path.join(os.homedir(), '.codex', 'auth.json'));
  // Source runs: off by default; only an absolute test path turns it on.
  assert.equal(resolveHostSystemCodexAuthPath({ packaged: false }, {}), null);
  assert.equal(resolveHostSystemCodexAuthPath({ packaged: false }, { [HOST_TEST_SYSTEM_CODEX_AUTH_ENV]: '  ' }), null);
  assert.equal(resolveHostSystemCodexAuthPath({ packaged: false }, { [HOST_TEST_SYSTEM_CODEX_AUTH_ENV]: 'relative/auth.json' }), null);
  assert.equal(resolveHostSystemCodexAuthPath({ packaged: false }, { [HOST_TEST_SYSTEM_CODEX_AUTH_ENV]: fake }), fake);
  // Anything not marked as installed is a source run.
  assert.equal(resolveHostSystemCodexAuthPath({}, {}), null);
  // This checkout is a source run.
  assert.equal(resolveHostSystemCodexAuthPath(undefined, {}), null);
});
