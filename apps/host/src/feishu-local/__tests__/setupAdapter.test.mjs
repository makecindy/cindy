import assert from 'node:assert/strict';
import test from 'node:test';
import { createFeishuLocalHostSetupAdapter } from '../setupAdapter.ts';

function fakePort(overrides = {}) {
  return {
    readAuth: async () => ({ state: 'missing', identity_alias: null, scopes: [], reason_code: 'NOT_AUTHORIZED' }),
    connect: async () => ({ ok: true }),
    ...overrides,
  };
}

// 测试价值
// - 生产入口与可观察结果：真实 Host setup adapter 的两张确认卡都从注入的翻译函数取文案；登录卡把已验证 URL 交给可选中复制的授权交互面，非法 URL 不弹卡。
// - Bug／规则依据：PR #11697 P1（授权链接不可打开/复制、Node Host 确认正文硬编码英文）；docs/dev-rules/engineering-conventions.md §5、DESIGN.md §4 Dialog & Modal。
// - 现有覆盖缺口：旧用例只检查英文正文含关键词和 URL，未覆盖多语言 key、可选中标记及非法 URL 不弹卡。
// - 最小失败输入：import/login 两段文案经 `t()` 返回本地化 key；修复前仍是硬编码英文，登录卡也没有 `contentSelectable`。
// - tier：unit（注入确认桥与翻译函数，无真实窗口、浏览器或授权流程）。
// - 实测耗时：1.64s（Host `node --test` 单独运行 `src/feishu-local/__tests__/setupAdapter.test.mjs`）。
function setup(options = {}) {
  const bodies = [];
  const payloads = [];
  const confirmations = {
    confirm: async payload => { bodies.push(payload.body); payloads.push(payload); return true; },
  };
  const state = { owner: 'owner-a:1', current: true, connectCalls: [] };
  const adapter = createFeishuLocalHostSetupAdapter({
    port: fakePort({
      connect: async input => { state.connectCalls.push(input); return { ok: true }; },
    }),
    confirmations,
    current: () => state.current,
    ownerScope: () => state.owner,
    t: key => key === 'feishuLocalCli.setup.login' ? `${key} {{url}}` : key,
    ...options,
  });
  return { adapter, bodies, payloads, state };
}

test('imports an existing terminal login through one owner-bound confirmation', async () => {
  const { adapter, bodies, payloads, state } = setup({
    port: fakePort({
      readAuth: async () => ({ state: 'missing', identity_alias: null, scopes: [], reason_code: 'SETUP_REQUIRED' }),
      connect: async input => { state.connectCalls.push(input); return { ok: true }; },
    }),
  });
  const result = await adapter({});
  assert.equal(result.ok, true);
  assert.equal(state.connectCalls.length, 1);
  assert.equal(state.connectCalls[0].mode, 'import-terminal');
  assert.equal(bodies[0], 'feishuLocalCli.setup.importTerminal');
  assert.equal(payloads[0].contentSelectable, undefined);
  assert.equal(bodies[0].includes('Import an existing terminal'), false);
  assert.equal(JSON.stringify(result).includes('device_code'), false);
});

test('waits for native login completion and returns the final result', async () => {
  const url = 'https://open.feishu.cn/verify?user_code=ABC';
  const { adapter, bodies, payloads, state } = setup({
    port: fakePort({
      connect: async input => {
        state.connectCalls.push(input);
        await input.onAuthorizationUrl(url);
        return { ok: true };
      },
    }),
  });
  const result = await adapter({});
  assert.equal(result.ok, true);
  assert.equal(state.connectCalls.length, 1);
  assert.equal(state.connectCalls[0].mode, 'login');
  assert.equal(bodies[0], `feishuLocalCli.setup.login ${url}`);
  assert.equal(payloads[0].contentSelectable, true);
  assert.equal(JSON.stringify(result).includes(url), false);
  assert.equal(JSON.stringify(result).includes('device_code'), false);
});

test('returns the final login failure reason instead of leaving setup pending', async () => {
  const { adapter, state } = setup({
    port: fakePort({
      connect: async input => {
        state.connectCalls.push(input);
        await input.onAuthorizationUrl('https://open.feishu.cn/verify?user_code=ABC');
        return { ok: false, reasonCode: 'NOT_AUTHORIZED', message: 'Authorization failed.' };
      },
    }),
  });
  const result = await adapter({});
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'NOT_AUTHORIZED');
  assert.equal(state.connectCalls.length, 1);
});

test('rejects unsafe verification URLs before showing a card', async () => {
  const { adapter, bodies, state } = setup({
    port: fakePort({
      connect: async input => {
        state.connectCalls.push(input);
        await input.onAuthorizationUrl('https://example.com/verify?device_code=fixture-secret');
        return { ok: true };
      },
    }),
  });
  const result = await adapter({});
  assert.equal(result.reasonCode, 'SETUP_UNAVAILABLE');
  assert.equal(bodies.length, 0);
});

test('rejects off-origin verification URLs with a clean query before showing a card', async () => {
  const { adapter, bodies, state } = setup({
    port: fakePort({
      connect: async input => {
        state.connectCalls.push(input);
        await input.onAuthorizationUrl('https://attacker.example/verify?user_code=ABC');
        return { ok: true };
      },
    }),
  });
  const result = await adapter({});
  assert.equal(result.reasonCode, 'SETUP_UNAVAILABLE');
  assert.equal(bodies.length, 0);
});

test('aborts setup when the owner changes during confirmation', async () => {
  const { adapter, state } = setup({
    confirmations: {
      confirm: async () => { state.owner = 'owner-b:2'; return true; },
    },
    port: fakePort({
      readAuth: async () => ({ state: 'missing', identity_alias: null, scopes: [], reason_code: 'SETUP_REQUIRED' }),
      connect: async input => { state.connectCalls.push(input); return { ok: true }; },
    }),
  });
  const result = await adapter({});
  assert.equal(result.reasonCode, 'SETUP_UNAVAILABLE');
  assert.equal(state.connectCalls.length, 0);
});
