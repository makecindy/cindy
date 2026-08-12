/**
 * slack-hook-protocol 多 workspace 绑定(multi-team)增量测试:
 *   1. 新帧 bind.state 构造 -> 序列化 -> 解析 round-trip 与形状约束
 *   2. bind.revoke 放宽: 空对象(老语义)与 { teamId }(按 team)都合法,
 *      多余键仍拒收
 *   3. hello.features / bind.start.teamId / bind.update.teamId /
 *      prefs.set.teamId / prefs.state 条目 teamId / tool.request.teamId /
 *      TaskSource.teamId+teamName 的可选字段校验
 *   4. 兼容回归: 不带任何新字段的老帧全部照常通过(老端行为不变)
 */

import { describe, it, expect } from 'vitest';

import {
  HOOK_FEATURE_MULTI_TEAM,
  makeBindRevoke,
  makeBindStart,
  makeBindState,
  makeBindUpdate,
  makeHello,
  makePrefsSet,
  makePrefsState,
  makeTaskDispatch,
  makeToolRequest,
  parseHookMessage,
  serializeHookMessage,
  type BindStatePayload,
  type HookMessage,
} from '../index';

function roundTrip(message: HookMessage): HookMessage {
  const parsed = parseHookMessage(serializeHookMessage(message));
  expect(parsed.ok, parsed.ok ? '' : parsed.error).toBe(true);
  if (!parsed.ok) throw new Error('unreachable');
  expect(parsed.message).toEqual(message);
  return parsed.message;
}

function expectReject(mutated: unknown, keyword: string): void {
  const parsed = parseHookMessage(mutated);
  expect(parsed.ok).toBe(false);
  if (parsed.ok) throw new Error('unreachable');
  expect(parsed.error).toContain(keyword);
}

const SNAPSHOT: BindStatePayload = {
  bindings: [
    { teamId: 'T0AAA', teamName: 'Acme Inc.', slackUserId: 'U0123', slackUserName: 'cindy' },
    { teamId: 'T0BBB', teamName: null, slackUserId: 'U0456', slackUserName: null },
  ],
};

describe('bind.state 快照帧', () => {
  it('构造 -> 序列化 -> 解析 round-trip(含空列表)', () => {
    roundTrip(makeBindState(SNAPSHOT));
    roundTrip(makeBindState({ bindings: [] }));
  });

  it('条目缺 teamId / slackUserId 拒收', () => {
    const msg = makeBindState(SNAPSHOT);
    expectReject(
      { ...msg, payload: { bindings: [{ ...SNAPSHOT.bindings[0], teamId: '' }] } },
      'bindings[0].teamId',
    );
    expectReject(
      { ...msg, payload: { bindings: [{ ...SNAPSHOT.bindings[0], slackUserId: null }] } },
      'bindings[0].slackUserId',
    );
  });

  it('bindings 非数组拒收', () => {
    const msg = makeBindState(SNAPSHOT);
    expectReject({ ...msg, payload: { bindings: {} } }, 'bindings must be an array');
  });
});

describe('bind.revoke 放宽', () => {
  it('空 payload(老语义: 全解)仍合法', () => {
    roundTrip(makeBindRevoke());
  });

  it('按 team 解绑与显式 null 都合法', () => {
    roundTrip(makeBindRevoke({ teamId: 'T0AAA' }));
    roundTrip(makeBindRevoke({ teamId: null }));
  });

  it('pendingOnly(取消在途授权)合法且校验形状', () => {
    roundTrip(makeBindRevoke({ pendingOnly: true }));
    const msg = makeBindRevoke();
    expectReject({ ...msg, payload: { pendingOnly: 'yes' } }, 'bind.revoke.pendingOnly');
  });

  it('多余键仍拒收(保留对端实现错误的暴露性)', () => {
    const msg = makeBindRevoke({ teamId: 'T0AAA' });
    expectReject(
      { ...msg, payload: { teamId: 'T0AAA', extra: 1 } },
      'bind.revoke.extra is not a known field',
    );
  });

  it('teamId 非字符串拒收', () => {
    const msg = makeBindRevoke();
    expectReject({ ...msg, payload: { teamId: 42 } }, 'bind.revoke.teamId');
  });
});

describe('可选 teamId 字段族', () => {
  it('hello.features 可选且校验形状', () => {
    roundTrip(
      makeHello({
        deviceId: 'd-1',
        deviceName: 'dev',
        workspaces: ['main'],
        agents: ['claude-code'],
        features: [HOOK_FEATURE_MULTI_TEAM],
      }),
    );
    // 缺省 = 老客户端, 照常通过
    roundTrip(
      makeHello({ deviceId: 'd-1', deviceName: 'dev', workspaces: [], agents: ['claude-code'] }),
    );
    const msg = makeHello({ deviceId: 'd-1', deviceName: 'dev', workspaces: [], agents: ['cc'] });
    expectReject({ ...msg, payload: { ...msg.payload, features: 'multi-team' } }, 'hello.features');
  });

  it('hello.defaultWorkspace 可选, 且必须是 workspaces 的成员', () => {
    roundTrip(
      makeHello({
        deviceId: 'd-1',
        deviceName: 'dev',
        workspaces: ['chat', 'cindy'],
        agents: ['claude-code'],
        defaultWorkspace: 'cindy',
      }),
    );
    // 缺省 / 显式 null = 无默认, 都照常通过(旧 desktop 不发本字段)
    roundTrip(
      makeHello({ deviceId: 'd-1', deviceName: 'dev', workspaces: ['chat'], agents: ['cc'] }),
    );
    roundTrip(
      makeHello({
        deviceId: 'd-1',
        deviceName: 'dev',
        workspaces: ['chat'],
        agents: ['cc'],
        defaultWorkspace: null,
      }),
    );
    const msg = makeHello({
      deviceId: 'd-1',
      deviceName: 'dev',
      workspaces: ['chat'],
      agents: ['cc'],
    });
    // 清单外的别名必须拒收: server 只能派发 workspaces 内的别名, 默认值若能
    // 指向清单外, 就绕过了该约束(server 侧派发校验的唯一依据)。
    expectReject(
      { ...msg, payload: { ...msg.payload, defaultWorkspace: 'not-registered' } },
      'hello.defaultWorkspace',
    );
    expectReject(
      { ...msg, payload: { ...msg.payload, defaultWorkspace: 42 } },
      'hello.defaultWorkspace',
    );
  });

  it('bind.start.teamId 可选(pin 重授权)', () => {
    roundTrip(makeBindStart({}));
    roundTrip(makeBindStart({ teamId: 'T0AAA' }));
    roundTrip(makeBindStart({ teamId: null }));
    const msg = makeBindStart({});
    expectReject({ ...msg, payload: { teamId: 5 } }, 'bind.start.teamId');
  });

  it('bind.update.teamId 可选(事件按 team 定位)', () => {
    roundTrip(
      makeBindUpdate({
        state: 'confirmed',
        slackUserId: 'U0123',
        slackUserName: 'cindy',
        message: null,
        teamId: 'T0AAA',
        teamName: 'Acme Inc.',
      }),
    );
    roundTrip(
      makeBindUpdate({
        state: 'revoked',
        slackUserId: null,
        slackUserName: null,
        message: 'superseded by another device',
        teamId: 'T0AAA',
        reason: 'superseded',
      }),
    );
    const msg = makeBindUpdate({
      state: 'none',
      slackUserId: null,
      slackUserName: null,
      message: null,
    });
    expectReject({ ...msg, payload: { ...msg.payload, teamId: 42 } }, 'bind.update.teamId');
  });

  it('prefs.set.teamId / prefs.state 条目 teamId 可选', () => {
    roundTrip(
      makePrefsSet({ requestId: 'r-1', workspace: 'main', model: 'opus', teamId: 'T0AAA' }),
    );
    roundTrip(
      makePrefsState({
        replyTo: null,
        bound: true,
        prefs: [
          {
            workspace: 'main',
            model: null,
            effort: null,
            agentKind: null,
            permissionMode: null,
            teamId: 'T0AAA',
          },
        ],
      }),
    );
    const set = makePrefsSet({ requestId: 'r-1', workspace: 'main' });
    expectReject({ ...set, payload: { ...set.payload, teamId: 42 } }, 'prefs.set.teamId');
  });

  it('tool.request.teamId 可选(网关工具身份消歧)', () => {
    roundTrip(makeToolRequest({ requestId: 'r-1', tool: 'status', teamId: 'T0AAA' }));
    roundTrip(makeToolRequest({ requestId: 'r-1', tool: 'status' }));
    const msg = makeToolRequest({ requestId: 'r-1', tool: 'status' });
    expectReject({ ...msg, payload: { ...msg.payload, teamId: 42 } }, 'tool.request.teamId');
  });

  it('TaskSource.teamId / teamName 可选', () => {
    roundTrip(
      makeTaskDispatch({
        requestId: 'r-1',
        externalKey: 'slack:T0AAA:dm:U1:1',
        workspace: 'main',
        prompt: 'hi',
        source: { im: 'slack', channelName: '#general', teamId: 'T0AAA', teamName: 'Acme Inc.' },
      }),
    );
    const msg = makeTaskDispatch({
      requestId: 'r-1',
      externalKey: 'k',
      workspace: 'main',
      prompt: 'hi',
      source: { im: 'slack' },
    });
    expectReject(
      { ...msg, payload: { ...msg.payload, source: { im: 'slack', teamId: 42 } } },
      'source.teamId',
    );
    expectReject(
      { ...msg, payload: { ...msg.payload, source: { im: 'slack', teamName: 42 } } },
      'source.teamName',
    );
  });
});

describe('兼容回归', () => {
  it('未知类型仍拒收丢帧(bind.state 之外的新类型不被误放行)', () => {
    const msg = makeBindState(SNAPSHOT);
    expectReject({ ...msg, type: 'bind.future' }, 'unknown message type');
  });
});
