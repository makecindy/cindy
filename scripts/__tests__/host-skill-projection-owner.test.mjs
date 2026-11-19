/*
 * 测试价值
 * - 规则依据：发布表第 25 行 25b，审核方定 (a)：Host 常驻进程（serve）不发布 Skill 投影的 owner，
 *   由窗口或 `cindy-host login` 发布。闸门 `configureProjectionBoundaryOwnerCommit` 默认允许（桌面不注入），
 *   所以拒绝完全靠 serve 入口的那一次注入。失效后果：注入丢了，serve 能在没有窗口的情况下改写边界，
 *   方案 A 被静默打破；login 不注入允许时则一样（默认允许），但改坏顺序或换文件就不再可见。
 * - 为什么是静态检查：注入发生在 main.ts 的 serve 分支顶层，加载 main.ts 就会启动整个服务；拒绝本身的
 *   行为由 apps/host/src/boundary.test.mjs“25b: serve refuses …”经生产函数覆盖。
 * - 最小失败输入：删掉 main.ts 里的 `refuseSkillProjectionOwnerCommit();`，或把它挪到监听之后；或别的
 *   Host 文件直接调用 `configureProjectionBoundaryOwnerCommit(`。
 * - tier：guard（登记在 check-test-hygiene.mjs 的 ROOT_SOURCE_CONTRACTS）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');

test('serve injects the owner-commit refusal before it listens, and only the owner module sets the gate', () => {
  const main = read('apps/host/src/main.ts');
  const serve = main.indexOf("const profileDir = resolveHostDataDir();\nconfigureUserDataDir(profileDir);");
  const refusal = main.indexOf('\nrefuseSkillProjectionOwnerCommit();\n');
  assert.ok(serve > -1 && refusal > serve, 'the serve branch calls refuseSkillProjectionOwnerCommit()');
  assert.equal(main.indexOf('\nrefuseSkillProjectionOwnerCommit();\n', refusal + 1), -1);
  assert.ok(refusal < main.indexOf('acquireHostServiceLease(profileDir)'), 'the refusal precedes the service lease and listening');

  const login = read('apps/host/src/login-cli.mjs');
  assert.ok(login.indexOf('allowSkillProjectionOwnerCommit();') > login.indexOf('await assertNoDesktopOnProfile('),
    'login allows the commit only after the coexistence check');

  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(ts|mts|mjs|cts)$/.test(entry.name) || /\.test\.mjs$/.test(entry.name)) continue;
      if (fs.readFileSync(full, 'utf8').includes('configureProjectionBoundaryOwnerCommit(')) {
        offenders.push(path.relative(root, full).split(path.sep).join('/'));
      }
    }
  };
  walk(path.join(root, 'apps/host/src'));
  assert.deepEqual(offenders, ['apps/host/src/agent/skill-projection-owner.ts']);
});
