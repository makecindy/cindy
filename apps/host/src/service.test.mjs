/*
 * 测试价值
 * - 生产入口：service.mjs 的 createHostService（HTTP 的 /api/* 与 device-link 的契约通道都经它），
 *   main.ts 给它的 profileHold 在闸门关着时返回带原因标记的文案。
 * - 规则：并存方案 A 后续（审核方 2026-11-17 定）。闸门关着时，Host 一切会写库或改运行时的入口默认拒绝；只放行
 *   读取、停止正在跑的回合、回答它的权限询问与提问（以及插件确认）。新建任务、改任务设置、改模型、排队消息的
 *   编辑删除移动、设置写入都拒绝；以后新加的路径没登记也拒绝。
 * - 现有覆盖缺口：input-queue 的 "profile hold" 用例只覆盖输入队列；任务、设置、插件等写入口之前照常执行。
 * - 最小失败输入：闸门关着时调用任一写入路径。tier：unit（处理函数全是记录调用的桩，没有 IO）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createHostService, HOST_PATHS_ALLOWED_WHILE_HELD } from './service.mjs';

const HELD = 'HOST_PROFILE_IN_USE_BY_DESKTOP: held for this test';

/** Every dependency the service reaches is a stub that records the call and answers `{}`. */
function stubbedService(held) {
  const calls = [];
  const stub = (name) => new Proxy(async (...args) => { calls.push(name); return {}; }, {
    get: (target, key) => (key === 'then' ? undefined : stub(`${name}.${String(key)}`)),
  });
  const deps = new Proxy({ profileHold: () => held() }, {
    get: (target, key) => (key in target ? target[key] : stub(String(key))),
  });
  return { invoke: createHostService(deps), calls };
}

const isHeldRefusal = error => error?.code === 'PRECONDITION_FAILED' && error.message === `[PRECONDITION_FAILED] ${HELD}`;

test('while held, reads, stops and answers to the running turn still reach their handlers', async () => {
  const { invoke, calls } = stubbedService(() => HELD);
  for (const [kind, paths] of Object.entries(HOST_PATHS_ALLOWED_WHILE_HELD)) {
    for (const path of paths) {
      const before = calls.length;
      // `confirmed: false`: an install consent is answered only with a refusal while held (test below).
      const result = await invoke(path, { sessionId: 'task', callId: 'call', agentKind: 'claude-code', request: {},
        requestId: 'request', confirmed: false }, { caller: 'device:test' });
      assert.equal(result.status, 200, `${kind} ${path} is answered`);
      assert.ok(calls.length > before, `${kind} ${path} reaches its handler`);
    }
  }
});

// What a running turn needs to end, named here rather than read from the production list: if any of
// these were refused, the turn could not end and the profile could never be released. And the account
// renewal, the one shared credential written while held.
test('while held, stopping the running turn, answering it and renewing the account are never refused', async () => {
  const { invoke, calls } = stubbedService(() => HELD);
  for (const path of ['/api/input/stop', '/api/interactions/respond', '/api/ghosts/confirm/resolve',
    '/api/ghosts/install-consent/resolve',
    // The account renewal (reviewer, 2026-11-17): a client-mode window asks the Host to renew here.
    '/api/auth/refresh']) {
    const before = calls.length;
    const result = await invoke(path, { sessionId: 'task', requestId: 'request', confirmed: false }, { caller: 'device:test' });
    assert.equal(result.status, 200, path);
    assert.ok(calls.length > before, `${path} reaches its handler`);
  }
});

// Rule (reviewer, 2026-11-17): accepting a plugin install consent installs into the profile the
// desktop shares, so while held only a refusal is answered; a plugin confirmation is answered either way.
test('while held, an install consent can be declined but not accepted; a plugin confirmation either way', async () => {
  const { invoke, calls } = stubbedService(() => HELD);
  const answer = (path, confirmed) => invoke(path, { requestId: 'request', confirmed }, { caller: 'device:test' });
  await assert.rejects(answer('/api/ghosts/install-consent/resolve', true), isHeldRefusal);
  assert.deepEqual(calls, [], 'the acceptance reached no handler');
  assert.equal((await answer('/api/ghosts/install-consent/resolve', false)).status, 200);
  assert.equal((await answer('/api/ghosts/confirm/resolve', true)).status, 200);
  assert.equal((await answer('/api/ghosts/confirm/resolve', false)).status, 200);
  assert.equal(calls.length, 3);
});

// Each category of write, one path or more each; the last one is a path no handler knows yet.
const REFUSED = {
  sends: ['/api/input/enqueue', '/api/input/steer', '/api/input/resume', '/api/input/retry-last-error'],
  'queue edits': ['/api/input/remove', '/api/input/update-text', '/api/input/update-content', '/api/input/move',
    '/api/input/clear-session', '/api/input/clear-error', '/api/input/set-interaction-lock', '/api/input/set-edit-lock',
    '/api/input/set-expanded'],
  'tasks': ['/api/sessions/create', '/api/sessions/update', '/api/sessions/delete', '/api/sessions/discard',
    '/api/sessions/commit', '/api/sessions/auto-title', '/api/messages/create'],
  'task settings and models': ['/api/sessions/set-model', '/api/sessions/set-effort', '/api/sessions/set-fast-mode',
    '/api/sessions/set-thinking-enabled', '/api/sessions/set-permission-mode', '/api/sessions/set-plan-mode',
    '/api/sessions/switch-agent'],
  'settings and profile files': ['/api/settings/appearance/set', '/api/settings/appearance/reset', '/api/settings/layout/set',
    '/api/settings/layout/reset', '/api/settings/sidebar/set', '/api/settings/shortcuts/set', '/api/project-info/set',
    '/api/project-info/auto-icon', '/api/project-aliases/set', '/api/project-aliases/delete', '/api/right-sidebar-tabs/upsert',
    '/api/browser-backend/set-kind', '/api/task-tags/execute', '/api/model-groups/set', '/api/model-groups/commit',
    '/api/model-groups/bind-session', '/api/model-groups/unbind-session', '/api/model-groups/route-note'],
  // Reads that change something: a failed embedded-browser probe recovers the backend (health-service.ts).
  'reads that write': ['/api/browser-backend/get-health'],
  'plugins and accounts': ['/api/ghosts/set-enabled', '/api/agents/logout', '/api/model-visibility/claim',
    '/api/model-access/retry'],
  'a path added later': ['/api/some-later-write'],
};

test('while held, every other path is refused, typed, before its handler runs; open, they run', async () => {
  let held = HELD;
  const { invoke, calls } = stubbedService(() => held);
  for (const [category, paths] of Object.entries(REFUSED)) {
    for (const path of paths) {
      await assert.rejects(invoke(path, { sessionId: 'task' }), isHeldRefusal, `${category}: ${path}`);
    }
  }
  assert.deepEqual(calls, [], 'no handler ran');
  held = null;
  await invoke('/api/sessions/set-model', { sessionId: 'task' });
  assert.ok(calls.length > 0, 'the same path runs once the profile is released');
});
