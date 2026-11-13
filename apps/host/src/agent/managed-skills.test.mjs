/*
 * 测试价值（放行表第 2b 行，3c 第一段）
 * - 可观察结果：在 Node 里用真实的 GhostManager 装一个带 Skill 的插件，共用的托管 Skill 清单
 *   （managedSkillsCore.ts）列出它的批准快照；快照被篡改后它不再出现，而批准记录（receipt）的
 *   文件字节在列清单前后完全不变；owner 正在切换时与桌面同样抛错，不返回空列表。
 * - 规则依据：桌面 managed-skills.ts（现经 managedSkillsCore.ts）；GhostManager.verifyApprovedSkillSnapshot
 *   只读（3c 审核：入口的中断恢复写入不新增，测试证明批准记录不被改）。
 * - 最小失败输入：不核对快照；列清单时改写批准记录；切换中返回空列表。
 * - tier：integration（真实安装、快照子进程与临时 profile，不调模型）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { configureHostOwner } from './claude-auth.mjs';
import { createSnapshotProcess } from '../snapshot-process.mjs';
import { createHostGhostManager } from '../plugins-installed.ts';
import { configureGhostSnapshotProcess } from '../../../desktop/src/main/cindy-brain/ghostSnapshotCapability.ts';
import { createManagedSkills } from '../../../desktop/src/main/maker-host/managedSkillsCore.ts';
import { configureAppDataDir } from '../../../desktop/src/main/userDataPath.ts';
import { beginAppSessionBoundary } from '../../../desktop/src/main/appSessionState.ts';
import { installedGhostStoragePart } from '../../../desktop/src/shared/pluginIdentity.ts';
import { lifoCleanup } from '../test-support/cleanup.mjs';

// node:test has no default timeout. These tests start subprocesses or use real temporary
// files; an explicit bound turns a stuck child or lock into a failure, not a stalled gate.
const TEST_TIMEOUT_MS = 120_000;

const require = createRequire(new URL('../../../desktop/package.json', import.meta.url));
const JSZip = require('jszip');

async function readTree(root) {
  const out = {};
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out[path.relative(root, full)] = (await fs.readFile(full)).toString('base64');
    }
  }
  await walk(root);
  return out;
}

async function installSkillPlugin(t, ownerId) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-host-managed-skills-'));
  t.after(() => fs.rm(profile, { recursive: true, force: true }));
  configureHostOwner({ userDataDir: profile, ownerId });
  configureAppDataDir(path.join(profile, 'app-data'));
  configureGhostSnapshotProcess(createSnapshotProcess);
  const manager = createHostGhostManager({ userDataDir: profile, ownerId });
  t.after(() => manager.disposeNotificationIndex());
  const zip = new JSZip();
  zip.file('ghost.json', JSON.stringify({ schemaVersion: 3, minCindyVersion: '0.1.61', id: 'skill-fixture',
    name: 'Skill fixture', kind: 'chip', version: '1.0.0', entry: 'main.js',
    tools: [{ name: 'noop', description: 'fixture tool', parameters: { type: 'object' } }],
    skill: { items: [{ dir: 'skills/demo', name: 'demo', description: 'Fixture skill' }] } }));
  zip.file('main.js', '// fixture');
  zip.file('skills/demo/SKILL.md', '---\nname: demo\ndescription: Fixture skill\n---\n\nApproved body\n');
  const archive = path.join(profile, 'skill-fixture.cindy');
  await fs.writeFile(archive, await zip.generateAsync({ type: 'nodebuffer' }));
  const result = await manager.install(archive, { namespace: null, uiCapabilityApproved: true });
  assert.ok(result.ghost, JSON.stringify(result));
  const catalog = createManagedSkills({
    listAvailableGhosts: () => manager.listAsync(),
    getGhostManager: () => manager,
    loadGhostFirstPartyFactsForGhost: () => ({ kind: 'missing' }),
  });
  const stateRoot = path.join(profile, 'owners');
  return { manager, catalog, ghost: result.ghost, stateRoot };
}

test('approved plugin Skills are listed from their snapshot; a tampered snapshot is not, and the approval record is untouched', { timeout: TEST_TIMEOUT_MS }, async t => {
  const { manager, catalog, ghost } = await installSkillPlugin(t, 'managed-skills-owner');
  const part = installedGhostStoragePart(ghost);
  const listed = await catalog.listCindyManagedSkills();
  const plugin = listed.filter(skill => skill.claudeCommandName === `cindy-plugin-${part}:demo`);
  assert.equal(plugin.length, 1);
  assert.equal(plugin[0].cindyOfficial, false);
  const [approved] = (await manager.listAsync()).filter(item => installedGhostStoragePart(item) === part);
  assert.ok(approved.approvedSkillRoot && plugin[0].path.startsWith(await fs.realpath(approved.approvedSkillRoot)));

  // The install receipts live under the owner's ghost-install-state directory.
  const stateDir = path.dirname(path.dirname(approved.approvedSkillRoot));
  const before = await readTree(stateDir);
  await fs.writeFile(plugin[0].path, '---\nname: demo\n---\n\nTampered body\n');
  const tamperedReceipts = await readTree(stateDir);
  const afterTamper = await catalog.listCindyManagedSkills();
  assert.equal(afterTamper.some(skill => skill.claudeCommandName === `cindy-plugin-${part}:demo`), false);
  // Listing never rewrote an approval record: every file other than the tampered
  // Skill itself has the same bytes as before.
  const after = await readTree(stateDir);
  assert.deepEqual(after, tamperedReceipts);
  for (const [file, bytes] of Object.entries(before)) {
    if (path.join(stateDir, file) !== plugin[0].path) assert.equal(after[file], bytes, file);
  }
});

test('listing managed Skills during an owner switch fails like the desktop instead of returning nothing', { timeout: TEST_TIMEOUT_MS }, async t => {
  t = lifoCleanup(t);
  const { catalog } = await installSkillPlugin(t, 'managed-skills-switch');
  t.after(beginAppSessionBoundary());
  await assert.rejects(catalog.listCindyManagedSkills(), { message: 'Skill owner is changing' });
});
