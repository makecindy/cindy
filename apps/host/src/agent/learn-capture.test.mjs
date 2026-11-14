/*
 * 测试价值（放行表第 18 行，/learn 捕获）
 * - 可观察结果：Host 的捕获依赖（learn-capture.ts）对一条持久化的用户回合，按桌面同一个
 *   createCindyLearnInvocationCapture 的条件给出授权快照：桌面发布过、启用着的内置 learn，经真实的
 *   Host 引擎列出 Skill 后恰好一个候选时，Claude（/cindy:learn、/learn）与 Pi（/skill:learn、
 *   /cindy:learn）得到指向这份内置文件的快照；Codex 在 Skill 投影（第 25 行）之前拿不到：main 3b6a7dd883
 *   起未登录的 Codex 经自己起的引擎列 Skill，列出来没有 learn，捕获不给快照，那个引擎拿到的 CODEX_HOME
 *   是 profile 的 codex-home、HOME 是夹具里的目录。持久化与
 *   派发不一致、会话被换掉或不在 active、远程任务、机器人会话的无前缀 Claude /learn、learn 被禁用、
 *   出现两个候选、桌面从没发布过，一律不给。
 * - 规则依据：桌面 makerSendTransaction 的捕获与 register.ts 的依赖；评审批准的第 18 行清单。
 * - 最小失败输入：依赖读错了发布快照或启用偏好；列 Skill 时读到真实的 ~/.claude；无前缀 /learn
 *   绕过机器人会话检查；Codex 列 Skill 时用了真实的 ~/.codex。
 * - tier：integration（真实发布、真实 Host 引擎列 Skill；会话对象与机器人会话表是夹具；Claude、Pi 不起
 *   进程，Codex 起夹具里的假 app-server，只在 POSIX 上：Codex 的传输不经 shell 启动程序，Windows 上
 *   起不了脚本，那一条跳过）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { setCindySkillEnabled } from '../../../desktop/src/main/skillhub/activationPreferences.ts';
import { learnFixture as fixture, learnDescriptor, inside } from './learn-fixture.mjs';
import { lifoCleanup } from '../test-support/cleanup.mjs';

// node:test has no default timeout. These tests start subprocesses or use real temporary
// files; an explicit bound turns a stuck child or lock into a failure, not a stalled gate.
const TEST_TIMEOUT_MS = 120_000;

test('Claude and Pi get the published built-in learn', { timeout: TEST_TIMEOUT_MS }, async t => {
  t = lifoCleanup(t);
  const f = await fixture(t);
  const descriptor = learnDescriptor(f);
  assert.ok(descriptor, 'the bundled learn Skill was published into the fixture');

  // Every Skill the engines list comes from the fixture, never a real user directory.
  for (const [kind, list] of [
    ['claude-code', () => f.graph.maker.listAgentRuntimeSkills('claude-code', { workingDir: f.project, runtimeConfigDir: process.env.CLAUDE_CONFIG_DIR })],
    ['pi', () => f.graph.maker.listAgentSkills('pi', { workingDir: f.project })],
  ]) {
    const listed = await list();
    for (const skill of listed.skills) if (skill.path) assert.ok(inside(f.root, skill.path), `${kind}: root=${f.root}; file=${fs.realpathSync.native(skill.path)}`);
  }
  const expect = async (id, kind, text) => {
    const s = f.session(id, kind);
    return f.capture(s, text, text);
  };
  for (const [id, kind, text] of [
    ['claude-qualified', 'claude-code', '/cindy:learn how we deploy'],
    ['claude-plain', 'claude-code', '/learn how we deploy'],
    ['pi-native', 'pi', '/skill:learn how we deploy'],
    ['pi-qualified', 'pi', '/cindy:learn how we deploy'],
  ]) {
    const grant = await expect(id, kind, text);
    assert.ok(grant, `${kind} ${text}`);
    assert.equal(grant.version, 1);
    assert.equal(grant.sessionInstanceId, `instance-${id}`);
    assert.ok(inside(f.root, grant.resolvedSkillPath), `root=${f.root}; file=${fs.realpathSync.native(grant.resolvedSkillPath)}`);
    assert.ok(fs.realpathSync.native(grant.resolvedSkillPath).startsWith(fs.realpathSync.native(descriptor.absolutePath)),
      `${kind}: root=${fs.realpathSync.native(descriptor.absolutePath)}; file=${fs.realpathSync.native(grant.resolvedSkillPath)}`);
  }
  // Not a /learn turn at all.
  assert.equal(await expect('claude-other', 'claude-code', 'please learn how we deploy'), null);
});

test('Codex gets no snapshot: its own Skill listing has no learn', {
  timeout: TEST_TIMEOUT_MS,
  skip: process.platform === 'win32' && 'the Codex transport spawns its binary without a shell; the fixture\'s fake Codex is a script',
}, async t => {
  const f = await fixture(t);
  assert.ok(learnDescriptor(f), 'the bundled learn Skill was published into the fixture');
  // Without a Codex login, Codex lists Skills through a short-lived engine of its own (maker-core,
  // since main 3b6a7dd883); here that engine is the fixture's fake app-server, which lists none.
  // Codex sees Cindy's built-in Skills only through the Skill projection (release table row 25).
  const listed = await f.graph.maker.listAgentSkills('codex', { workingDir: f.project });
  assert.deepEqual(listed.skills, []);
  // A plain /learn would take the built-in learn if Codex listed it; /cindy:learn also needs the
  // runtime command name only the projection gives.
  for (const [id, text] of [['codex-plain', '/learn how we deploy'], ['codex-qualified', '/cindy:learn how we deploy']]) {
    assert.equal(await f.capture(f.session(id, 'codex'), text, text), null, text);
  }
  // The listing engine got the profile's codex-home and the fixture's HOME, never a real ~/.codex.
  const requests = f.readCodexRequests();
  assert.ok(requests.some(r => r.method === 'skills/list'), JSON.stringify(requests));
  for (const r of requests) {
    assert.equal(r.codexHome, path.join(f.profile, 'codex-home'));
    assert.equal(r.home, f.home);
  }
});

test('no snapshot when the turn, the session or the Skill does not qualify', { timeout: TEST_TIMEOUT_MS }, async t => {
  t = lifoCleanup(t);
  const f = await fixture(t);
  const descriptor = learnDescriptor(f);
  const qualified = '/cindy:learn how we deploy';
  // The persisted and dispatched turns name different requests.
  assert.equal(await f.capture(f.session('mismatch', 'claude-code'), qualified, '/cindy:learn something else'), null);
  // The session was replaced, is no longer active, or runs on a remote computer.
  const replaced = f.session('replaced', 'claude-code');
  f.session('replaced', 'claude-code');
  assert.equal(await f.capture(replaced, qualified, qualified), null);
  assert.equal(await f.capture(f.session('closed', 'claude-code', { getStatus: () => 'closed' }), qualified, qualified), null);
  assert.equal(await f.capture(f.session('remote', 'claude-code', { remoteHostId: 'ssh-fixture' }), qualified, qualified), null);
  // A bot session must name Cindy's learn explicitly.
  f.sqlite.prepare('INSERT INTO bot_session_links(id, session_id) VALUES (?, ?)').run('link-1', 'bot-task');
  assert.equal(await f.capture(f.session('bot-task', 'claude-code'), '/learn x', '/learn x'), null);
  assert.ok(await f.capture(f.session('bot-task', 'claude-code'), '/cindy:learn x', '/cindy:learn x'));
  // A user Skill also named learn: the plain /learn is ambiguous, the qualified one is not.
  const userLearn = path.join(process.env.CLAUDE_CONFIG_DIR, 'skills', 'learn');
  fs.mkdirSync(userLearn, { recursive: true });
  fs.writeFileSync(path.join(userLearn, 'SKILL.md'), '---\nname: learn\ndescription: A user Skill with the same name\n---\n\nUser body\n');
  assert.equal(await f.capture(f.session('two-candidates', 'claude-code'), '/learn x', '/learn x'), null);
  assert.ok(await f.capture(f.session('two-candidates', 'claude-code'), qualified, qualified));
  fs.rmSync(userLearn, { recursive: true, force: true });
  // Disabled in Cindy's Skill settings.
  await setCindySkillEnabled(descriptor.absolutePath, false);
  for (const kind of ['claude-code', 'pi']) assert.equal(await f.capture(f.session(`disabled-${kind}`, kind), qualified, qualified), null, kind);
  await setCindySkillEnabled(descriptor.absolutePath, true);
  assert.ok(await f.capture(f.session('enabled-again', 'claude-code'), qualified, qualified));
});

test('no snapshot when the desktop never published the built-in Skills', { timeout: TEST_TIMEOUT_MS }, async t => {
  t = lifoCleanup(t);
  const f = await fixture(t, { publish: false });
  assert.equal(learnDescriptor(f), undefined);
  for (const kind of ['claude-code', 'pi', 'codex']) {
    assert.equal(await f.capture(f.session(`unpublished-${kind}`, kind), '/cindy:learn x', '/cindy:learn x'), null, kind);
  }
});
