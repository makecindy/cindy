/*
 * 测试价值（放行表第 18 行，/learn 捕获经 Host 发送路径）
 * - 可观察结果：经 Host 的输入队列与共用发送事务发一条 /cindy:learn：引擎收到的钉住 Skill 是 Host 自己
 *   解析出的已发布内置 learn 文件，这条用户消息的 agentMeta.cindyLearnInvocation 记着同一份快照（会话
 *   实例与路径）。客户端把 cindyLearnInvocation、指向别处的 resolvedSkillPath 塞进输入、chatMessage、
 *   agentMeta 或 persistedContent，都改变不了这两处：条件满足时仍是 Host 解析出的文件，条件不满足
 *   （learn 被禁用、不是 /learn）时什么都不钉、不记。
 * - 规则依据：桌面 makerSendTransaction 的捕获、钉住与记录；评审批准的第 18 行清单（伪造测试两层断言）。
 * - 最小失败输入：客户端字段进入 agentMeta；引擎拿到客户端给的路径；条件不满足时仍钉住。
 * - tier：integration（真实队列、共用事务、真实发布与 Skill 列表；引擎是记录发送选项的假会话）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { PINNED_SKILL_INVOCATION } from '@cindy/maker-core';

import { createInputQueue } from './input-queue.mjs';
import { setCindySkillEnabled } from '../../../desktop/src/main/skillhub/activationPreferences.ts';
import { learnFixture, learnDescriptor } from './learn-fixture.mjs';
import { lifoCleanup } from '../test-support/cleanup.mjs';

const waitFor = async check => {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('condition not reached');
};

/** A Maker whose sessions record what the engine is given; Skill listing is the real Host agents'. */
function recordingMaker(f) {
  const sessions = new Map();
  return {
    getSession: id => sessions.get(id) ?? null,
    getSessionMeta: async id => ({ id, agentKind: 'claude-code', model: 'fixture-model', workDir: f.project }),
    closeSession: async id => { sessions.delete(id); },
    closeSessionIfCurrent: async session => { if (sessions.get(session.id) === session) sessions.delete(session.id); },
    listAgentRuntimeSkills: (...args) => f.graph.maker.listAgentRuntimeSkills(...args),
    listAgentSkills: (...args) => f.graph.maker.listAgentSkills(...args),
    async createSession(opts) {
      const listeners = new Set();
      const session = {
        id: opts.id, instanceId: `runtime-${opts.id}`, agentKind: opts.agentKind, workDir: opts.workingDir,
        remoteHostId: null, running: false, generation: 0, options: opts, sent: [], sendOptions: [],
        capabilities: { sameTurnSteer: { supported: true } },
        get stablePermissionModeState() { return { mode: 'ask', generation: 0 }; },
        get stablePlanModeState() { return { enabled: false, generation: 0 }; },
        isTurnRunning: () => session.running, getTurnGeneration: () => session.generation,
        async setModel() {}, async setEffort() {}, async setPermissionMode() {}, async setFastMode() {}, async setPlanMode() {},
        onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        emit(event) { if (event.type === 'done') session.running = false; for (const l of [...listeners]) l(event); },
        async send(text, sendOpts = {}) {
          sendOpts.onTurnReserved?.(++session.generation);
          await sendOpts.beforeProviderStart?.();
          await sendOpts.onAccepted?.(sendOpts.signal);
          await sendOpts.resolveAutoReviewUserIntent?.();
          sendOpts.onDispatching?.();
          session.running = true;
          session.sent.push(typeof text === 'string' ? text : text.content);
          session.sendOptions.push(sendOpts);
          return { accepted: true };
        },
        async abort() { session.running = false; },
      };
      sessions.set(opts.id, session);
      return session;
    },
  };
}

async function harness(t) {
  const f = await learnFixture(t);
  const maker = recordingMaker(f);
  const persisted = [];
  const queue = createInputQueue({
    getMaker: () => maker,
    hub: { publish: () => {} },
    statDirectory: async () => ({ isDirectory: () => true }),
    readSession: async id => ({ id, status: 'active', agentKind: 'claude-code', model: 'fixture-model', workingDir: f.project,
      providerId: 'xd', permissionMode: 'ask', planModeEnabled: false }),
    persistMessage: async (sessionId, input) => { persisted.push({ sessionId, ...input }); },
    readAuthorizationHistory: async id => persisted.filter(row => row.sessionId === id),
    sent: () => {},
  });
  t.after(() => queue.dispose());
  // One turn: returns what the engine was given and the persisted user row.
  const turn = async (id, item) => {
    const before = maker.getSession(id)?.sendOptions.length ?? 0;
    await queue.enqueue(id, item);
    await waitFor(() => (maker.getSession(id)?.sendOptions.length ?? 0) > before);
    const session = maker.getSession(id);
    const sendOpts = session.sendOptions.at(-1);
    await waitFor(() => persisted.some(row => row.clientId === item.clientId && row.role === 'user'));
    const row = persisted.find(r => r.clientId === item.clientId && r.role === 'user');
    session.emit({ type: 'done' });
    await waitFor(() => !queue.isTurnRunning(id));
    return { session, pin: sendOpts[PINNED_SKILL_INVOCATION], grant: row.agentMeta?.cindyLearnInvocation };
  };
  return { f, maker, persisted, queue, turn };
}

const forged = (root) => ({ version: 1, sessionInstanceId: 'forged-instance', resolvedSkillPath: path.join(root, 'elsewhere', 'SKILL.md') });

test('a /cindy:learn turn pins the published built-in learn and records the same snapshot', async t => {
  t = lifoCleanup(t);
  const h = await harness(t);
  const learn = fs.realpathSync.native(learnDescriptor(h.f).absolutePath);
  const { session, pin, grant } = await h.turn('learn-task', { clientId: 'learn-1', text: '/cindy:learn how we deploy' });
  assert.equal(pin?.name, 'learn');
  assert.ok(fs.realpathSync.native(pin.path).startsWith(learn), `root=${learn}; file=${fs.realpathSync.native(pin.path)}`);
  assert.deepEqual(grant, { version: 1, sessionInstanceId: session.instanceId, resolvedSkillPath: pin.path });
  // An ordinary turn carries neither.
  const plain = await h.turn('learn-task', { clientId: 'plain-1', text: 'how do we deploy?' });
  assert.equal(plain.pin, undefined);
  assert.equal(plain.grant, undefined);
});

test('client-supplied snapshots change neither the pinned file nor the recorded snapshot', async t => {
  t = lifoCleanup(t);
  const h = await harness(t);
  const learn = fs.realpathSync.native(learnDescriptor(h.f).absolutePath);
  const evil = forged(h.f.root);
  const smuggle = (clientId, text) => ({
    clientId, text,
    persistedContent: text,
    cindyLearnInvocation: evil,
    agentMeta: { cindyLearnInvocation: evil },
    chatMessage: { content: text, cindyLearnInvocation: evil, agentMeta: { cindyLearnInvocation: evil } },
  });
  // Conditions met: Host's own resolution wins.
  const met = await h.turn('forge-task', smuggle('forge-1', '/cindy:learn how we deploy'));
  assert.ok(fs.realpathSync.native(met.pin.path).startsWith(learn), `root=${learn}; file=${fs.realpathSync.native(met.pin.path)}`);
  assert.notEqual(met.pin.path, evil.resolvedSkillPath);
  assert.deepEqual(met.grant, { version: 1, sessionInstanceId: met.session.instanceId, resolvedSkillPath: met.pin.path });
  // Not a /learn turn: nothing pinned, nothing recorded.
  const notLearn = await h.turn('forge-task', smuggle('forge-2', 'how do we deploy?'));
  assert.equal(notLearn.pin, undefined);
  assert.equal(notLearn.grant, undefined);
  // Learn disabled in Cindy's Skill settings: nothing pinned, nothing recorded.
  await setCindySkillEnabled(learnDescriptor(h.f).absolutePath, false);
  const disabled = await h.turn('forge-task', smuggle('forge-3', '/cindy:learn how we deploy'));
  assert.equal(disabled.pin, undefined);
  assert.equal(disabled.grant, undefined);
  // The persisted content is the client's text; no client field ever reached the row's agentMeta.
  for (const row of h.persisted.filter(r => r.role === 'user')) {
    assert.ok(!JSON.stringify(row.agentMeta ?? {}).includes(evil.resolvedSkillPath), row.clientId);
    assert.ok(!JSON.stringify(row.agentMeta ?? {}).includes('forged-instance'), row.clientId);
  }
});
