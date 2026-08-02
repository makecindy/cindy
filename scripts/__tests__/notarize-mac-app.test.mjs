// macOS 公证编排回归测试。所有命令与文件操作都通过依赖注入模拟，
// 不连接 Apple 服务、不读取真实凭证，也不创建打包产物。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { notarizeMacApp } from '../../apps/desktop/scripts/ci/lib.mjs';

const APP_PATH = '/tmp/Cindy.app';
const ZIP_PATH = `${APP_PATH}.zip`;
const IDENTITY = Object.freeze({
  appleId: 'ci@example.invalid',
  teamId: 'TEAM123456',
  applePassword: 'test-app-password',
});

function createHarness(results) {
  const queue = [...results];
  const execCommands = [];
  const spawnCalls = [];
  const deletedFiles = [];
  const output = [];
  const logger = {
    log(...args) {
      output.push(args.join(' '));
    },
    error(...args) {
      output.push(args.join(' '));
    },
  };
  const dependencies = {
    execCommand(command) {
      execCommands.push(command);
    },
    spawnCommand(command, args, options) {
      spawnCalls.push({ command, args, options });
      assert.ok(queue.length > 0, `unexpected spawn: ${command} ${args.join(' ')}`);
      const result = queue.shift();
      if (result instanceof Error) throw result;
      return result;
    },
    unlinkFile(filePath) {
      deletedFiles.push(filePath);
    },
    logger,
  };
  return {
    dependencies,
    execCommands,
    spawnCalls,
    deletedFiles,
    output,
    assertQueueDrained() {
      assert.equal(queue.length, 0, 'all mocked command results should be consumed');
    },
  };
}

test('notarizeMacApp: Accepted 后才删除 zip 并 staple', () => {
  const harness = createHarness([{
    status: 0,
    signal: null,
    stdout: JSON.stringify({ id: 'accepted-id', status: 'Accepted' }),
    stderr: '',
  }]);

  notarizeMacApp(APP_PATH, IDENTITY, harness.dependencies);

  assert.deepEqual(harness.deletedFiles, [ZIP_PATH]);
  assert.deepEqual(harness.execCommands, [
    `/usr/bin/ditto -c -k --keepParent "${APP_PATH}" "${ZIP_PATH}"`,
    `/usr/bin/xcrun stapler staple "${APP_PATH}"`,
  ]);
  assert.equal(harness.spawnCalls.length, 1);
  assert.deepEqual(harness.spawnCalls[0], {
    command: '/usr/bin/xcrun',
    args: [
      'notarytool',
      'submit',
      ZIP_PATH,
      '--apple-id',
      IDENTITY.appleId,
      '--password',
      IDENTITY.applePassword,
      '--team-id',
      IDENTITY.teamId,
      '--wait',
      '--output-format',
      'json',
    ],
    options: { encoding: 'utf8', timeout: 1800000 },
  });
  assert.match(harness.output.join('\n'), /Apple notarization status: Accepted/);
  assert.doesNotMatch(harness.output.join('\n'), new RegExp(IDENTITY.applePassword));
  harness.assertQueueDrained();
});

test('notarizeMacApp: Invalid 时拉取详细日志且不删除或 staple', () => {
  const harness = createHarness([
    {
      status: 0,
      signal: null,
      stdout: JSON.stringify({ id: 'invalid-id', status: 'Invalid' }),
      stderr: '',
    },
    {
      status: 0,
      signal: null,
      stdout: JSON.stringify({
        statusCode: 4000,
        issues: [{ path: 'Cindy.app/Contents/MacOS/pi', message: IDENTITY.applePassword }],
      }),
      stderr: '',
    },
  ]);

  assert.throws(
    () => notarizeMacApp(APP_PATH, IDENTITY, harness.dependencies),
    /Apple 公证未通过: status=Invalid, submission=invalid-id/,
  );

  assert.deepEqual(harness.deletedFiles, []);
  assert.deepEqual(harness.execCommands, [
    `/usr/bin/ditto -c -k --keepParent "${APP_PATH}" "${ZIP_PATH}"`,
  ]);
  assert.equal(harness.spawnCalls.length, 2);
  assert.deepEqual(harness.spawnCalls[1].args, [
    'notarytool',
    'log',
    'invalid-id',
    '--apple-id',
    IDENTITY.appleId,
    '--password',
    IDENTITY.applePassword,
    '--team-id',
    IDENTITY.teamId,
  ]);
  const output = harness.output.join('\n');
  assert.match(output, /Apple notarization log:/);
  assert.match(output, /Cindy\.app\/Contents\/MacOS\/pi/);
  assert.match(output, /\*\*\*\*/);
  assert.doesNotMatch(output, new RegExp(IDENTITY.applePassword));
  harness.assertQueueDrained();
});

test('notarizeMacApp: submit 命令失败时保留 zip 且输出脱敏诊断', () => {
  const harness = createHarness([{
    status: 1,
    signal: null,
    stdout: '',
    stderr: `authentication rejected: ${IDENTITY.applePassword}`,
  }]);

  assert.throws(
    () => notarizeMacApp(APP_PATH, IDENTITY, harness.dependencies),
    /notarytool submit 失败\(exit 1\);公证未通过/,
  );

  assert.deepEqual(harness.deletedFiles, []);
  assert.equal(harness.execCommands.length, 1);
  assert.equal(harness.spawnCalls.length, 1);
  const output = harness.output.join('\n');
  assert.match(output, /authentication rejected: \*\*\*\*/);
  assert.doesNotMatch(output, new RegExp(IDENTITY.applePassword));
  harness.assertQueueDrained();
});

// notarytool 对 Invalid 提交的 exit code 随 Xcode 版本变化；非 0 退出这条路径同样
// 必须从 stdout 里救出 submission id 去拉 Apple 的详细原因，否则发布失败无从定位。
test('notarizeMacApp: submit 非 0 退出但 stdout 带 Invalid 时仍拉取详细日志', () => {
  const harness = createHarness([
    {
      status: 2,
      signal: null,
      stdout: JSON.stringify({ id: 'nonzero-invalid-id', status: 'Invalid' }),
      stderr: '',
    },
    {
      status: 0,
      signal: null,
      stdout: JSON.stringify({
        statusCode: 4000,
        issues: [{ path: 'Cindy.app/Contents/MacOS/cindy', message: 'not signed' }],
      }),
      stderr: '',
    },
  ]);

  assert.throws(
    () => notarizeMacApp(APP_PATH, IDENTITY, harness.dependencies),
    /notarytool submit 失败\(exit 2\);公证未通过/,
  );

  assert.deepEqual(harness.deletedFiles, []);
  assert.deepEqual(harness.execCommands, [
    `/usr/bin/ditto -c -k --keepParent "${APP_PATH}" "${ZIP_PATH}"`,
  ]);
  assert.equal(harness.spawnCalls.length, 2);
  assert.deepEqual(harness.spawnCalls[1].args, [
    'notarytool',
    'log',
    'nonzero-invalid-id',
    '--apple-id',
    IDENTITY.appleId,
    '--password',
    IDENTITY.applePassword,
    '--team-id',
    IDENTITY.teamId,
  ]);
  const output = harness.output.join('\n');
  assert.match(output, /Apple notarization log:/);
  assert.match(output, /not signed/);
  assert.doesNotMatch(output, new RegExp(IDENTITY.applePassword));
  harness.assertQueueDrained();
});

test('notarizeMacApp: Invalid 的日志命令失败仍直接报告公证失败', () => {
  const harness = createHarness([
    {
      status: 0,
      signal: null,
      stdout: JSON.stringify({ id: 'invalid-log-failure', status: 'Invalid' }),
      stderr: '',
    },
    {
      status: 69,
      signal: null,
      stdout: '',
      stderr: `log authentication failed: ${IDENTITY.applePassword}`,
    },
  ]);

  assert.throws(
    () => notarizeMacApp(APP_PATH, IDENTITY, harness.dependencies),
    /Apple 公证未通过: status=Invalid, submission=invalid-log-failure/,
  );

  assert.deepEqual(harness.deletedFiles, []);
  assert.equal(harness.execCommands.length, 1);
  const output = harness.output.join('\n');
  assert.match(output, /WARN: 无法获取 Apple notarization log/);
  assert.match(output, /log authentication failed: \*\*\*\*/);
  assert.doesNotMatch(output, new RegExp(IDENTITY.applePassword));
  harness.assertQueueDrained();
});
