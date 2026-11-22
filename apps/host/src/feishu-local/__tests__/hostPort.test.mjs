import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ownerScopedPath } from '../../../../desktop/src/main/dataOwnerPath.ts';
import { createFeishuLocalHostPort } from '../hostPort.ts';

function archive(text) {
  return JSON.stringify({ v: 1, files: [{ rel: 'auth.json', data: Buffer.from(text, 'utf8').toString('base64') }] });
}

function fakeSpawn() {
  return (_binary, argv, _options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    setImmediate(() => {
      const payload = argv.includes('--version')
        ? '1.0.57'
        : JSON.stringify({ identities: { user: {
          available: true,
          tokenStatus: 'valid',
          scope: 'sheets:spreadsheet drive:drive',
          userName: 'Recovered User',
        } } });
      child.stdout.emit('data', Buffer.from(payload));
      child.emit('close', 0);
    });
    return child;
  };
}

// 测试价值
// - 生产入口与可观察结果：createFeishuLocalHostPort 的 readAuth 在凭证库首次初始化失败后返回 SETUP_REQUIRED，OS 身份恢复后能读回账号且不重建已成功的凭证库。
// - Bug／规则依据：PR #11697 P2（Linux keyring 恢复后失败 Promise 仍被缓存）；docs/dev-rules/architecture-invariants.md §5、docs/dev-rules/credentials-and-local-storage.md §通用存储要求。
// - 现有覆盖缺口：setupAdapter 测试只覆盖 setup 卡，未覆盖 Host port 的凭证库生命周期；store 测试不覆盖缓存清理。
// - 最小失败输入：createStore 第一次 reject、第二次返回可读档案；修复前第二次仍复用失败 Promise。
// - tier：unit（注入凭证库和 CLI spawn，不接触真实 keyring、Electron 或用户目录）。
// - 实测耗时：2.11s（Host `node --test` 单独运行 `src/feishu-local/__tests__/hostPort.test.mjs`）。
test('retries a transient credential store failure and reuses a successful store', async (t) => {
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-feishu-local-host-port-'));
  t.after(() => fs.rm(profileDir, { recursive: true, force: true }));
  const binaryDir = path.join(profileDir, 'managed-tools', 'lark-cli', 'current');
  await fs.mkdir(binaryDir, { recursive: true });
  await fs.writeFile(path.join(binaryDir, process.platform === 'win32' ? 'lark-cli.exe' : 'lark-cli'), '', { mode: 0o755 });

  const profile = archive('fixture-archive');
  const calls = [];
  const store = { read: () => profile, write: () => {}, remove: () => {} };
  const port = createFeishuLocalHostPort({
    profileDir,
    ownerId: 'owner-a',
    current: () => true,
    ownerScope: () => 'owner-a:1',
    t: key => key,
    spawnFn: fakeSpawn(),
    createStore: (options) => {
      calls.push(options);
      return calls.length === 1
        ? Promise.reject(new Error('keyring temporarily unavailable'))
        : Promise.resolve(store);
    },
  });

  const failed = await port.readAuth();
  assert.equal(failed.reason_code, 'SETUP_REQUIRED');
  const recovered = await port.readAuth();
  assert.equal(recovered.state, 'ready');
  assert.equal(recovered.identity_alias, 'Recovered User');
  assert.deepEqual(recovered.scopes, ['sheets:spreadsheet', 'drive:drive']);
  assert.equal((await port.readAuth()).state, 'ready');
  assert.equal(calls.length, 2);
  for (const options of calls) {
    assert.equal(options.userDataDir, ownerScopedPath(profileDir, 'owner-a', 'feishu-local-cli'));
    assert.equal(options.identityUserDir, profileDir);
  }
});
