import { describe, expect, it, vi, beforeEach } from 'vitest';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Schedule } from '@cindy/maker-scheduler';
import { GhostCardService } from '../../cindy-brain/cardService.js';
import { GhostFsSlot } from '../../cindy-brain/fsSlot.js';
import { GhostPipeDispatcher } from '../../cindy-brain/pipeDispatcher.js';
import type { GhostPipeToolCall, InstalledGhost } from '../../../shared/ghost.js';
import { SchedulerScriptCapabilityBroker } from '../script-capability-broker';

const sendToSessionMock = vi.hoisted(() => vi.fn());
// ghost pipe 统一入口:缺省回显请求(jira/feishu 用例断言请求形状),
// 单个用例可 mockResolvedValueOnce 覆盖返回(断言 data 解包 / 错误映射)。
const callGhostToolMock = vi.hoisted(() =>
  vi.fn(
    async (
      request: unknown,
    ): Promise<{ ok: boolean; result?: unknown; errorCode?: string; message?: string }> => ({
      ok: true,
      result: request,
    }),
  ),
);
// cardService 账本:缺省 void spy(生命周期断言用);端到端用例转发到真实实例。
const registerCallMock = vi.hoisted(() => vi.fn());
const finalizeCallMock = vi.hoisted(() => vi.fn());

vi.mock('../../cindy-brain/index.js', () => ({
  getGhostPipeDispatcher: () => ({ callGhostTool: callGhostToolMock }),
  getGhostCardService: () => ({ registerCall: registerCallMock, finalizeCall: finalizeCallMock }),
}));

vi.mock('../../maker-ipc/register.js', () => ({
  tryGetOrcaCollabService: () => ({ sendToSession: sendToSessionMock }),
}));

function schedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'script-schedule',
    name: 'script schedule',
    prompt: '',
    executionMode: 'script',
    scriptConfig: {
      command: 'python auto.py',
      capabilities: ['jira.read', 'sessions.dispatch'],
    },
    kind: 'cron',
    cronExpr: '0 9 * * *',
    timezone: 'Asia/Shanghai',
    recurring: true,
    manual: false,
    agentKind: 'codex',
    model: 'gpt-5.5',
    providerId: 'provider-1',
    effort: 'high',
    fastMode: true,
    workspaceKind: 'project',
    workingDir: 'C:\\project',
    useWorktree: false,
    persistentSession: false,
    silentWhenIdle: false,
    notify: { desktop: true, feishu: false },
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('SchedulerScriptCapabilityBroker', () => {
  beforeEach(() => {
    sendToSessionMock.mockReset();
    callGhostToolMock.mockReset();
    callGhostToolMock.mockImplementation(async (request: unknown) => ({ ok: true, result: request }));
    registerCallMock.mockReset();
    finalizeCallMock.mockReset();
  });

  it('maps Jira reads to the current xd-atlassian argument contract', async () => {
    const result = await new SchedulerScriptCapabilityBroker().call(
      { method: 'jira.get', params: { issue_key: 'DING-1' } },
      new Set(['jira.read']),
      { schedule: schedule() },
    );
    expect(result).toMatchObject({
      ghostId: 'xd-atlassian',
      tool: 'jira_issues',
      args: { action: 'get', issue_key: 'DING-1' },
    });
  });

  it('forwards search_jql paging params to the ghost and rejects bad tokens', async () => {
    const broker = new SchedulerScriptCapabilityBroker();
    const result = await broker.call(
      {
        method: 'jira.search_jql',
        params: { jql: 'assignee = currentUser()', max_results: 8, next_page_token: 'tok-2' },
      },
      new Set(['jira.read']),
      { schedule: schedule() },
    );
    expect(result).toMatchObject({
      ghostId: 'xd-atlassian',
      tool: 'jira_issues',
      args: { action: 'search_jql', max_results: 8, next_page_token: 'tok-2' },
    });
    await expect(
      broker.call(
        { method: 'jira.search_jql', params: { jql: 'x', next_page_token: '  ' } },
        new Set(['jira.read']),
        { schedule: schedule() },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  });

  it('adds Jira comments with plain text exactly as before', async () => {
    const result = await new SchedulerScriptCapabilityBroker().call(
      { method: 'jira.add_comment', params: { issue_key: 'DING-1', body_text: 'done' } },
      new Set(['jira.comment']),
      { schedule: schedule() },
    );
    expect(result).toMatchObject({
      ghostId: 'xd-atlassian',
      tool: 'jira_issues',
      args: { action: 'add_comment', issue_key: 'DING-1', body_text: 'done' },
    });
    // 生命周期同样锁住:add_comment 也走 callGhostForScript——登记形状、同一
    // callId 下行、交卷 finalize,与 jira.get 同一本账(review:只断回显形状
    // 会让「漏走登记包装」的回归照样绿)。纯写方法不挂写盘授权(review P1
    // 第三轮):scriptWorkdir 恒 null。
    expect(registerCallMock).toHaveBeenCalledTimes(1);
    const [callId, info] = registerCallMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(info).toMatchObject({ ghostId: 'xd-atlassian', sessionId: null, channel: 'script', scriptWorkdir: null });
    expect(callGhostToolMock).toHaveBeenCalledWith(expect.objectContaining({ callId }));
    expect(finalizeCallMock).toHaveBeenCalledWith(callId);
  });

  it('write-method grantless: add_comment 在途也不持 workdir 写窗(review P1 第三轮)', async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'broker-grantless-'));
    const { fsSlot } = wireRealChannel(tmp);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    callGhostToolMock.mockImplementationOnce(async () => { await gate; return { ok: true, result: {} }; });
    const p = new SchedulerScriptCapabilityBroker()
      .call(
        { method: 'jira.add_comment', params: { issue_key: 'DING-1', body_text: 'done' } },
        new Set(['jira.comment']),
        { schedule: schedule({ workingDir: tmp }), runId: 'run-w' },
      )
      .catch((err: unknown) => err);
    try {
      // 调用在途:插件此时调 fs 槽 root:'workdir' 必须被拒——add_comment 是
      // 纯写方法,结果体小不可能泄洪,给写窗只是白白扩大在途暴露面。
      const callId = registerCallMock.mock.calls[0][0] as string;
      const w = await fsSlot.handleFsRequest('xd-atlassian', {
        op: 'write', root: 'workdir', callId, path: 'poison.json', content: 'x',
      });
      expect(w).toMatchObject({ ok: false });
      expect(fs.existsSync(path.join(tmp, 'poison.json'))).toBe(false);
    } finally {
      release();
      await p;
      await fs.promises.rm(tmp, { recursive: true, force: true });
    }
  });

  it('read-method without out_file: jira.search_jql 在途同样不持写窗(review P1 第四轮)', async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'broker-read-grantless-'));
    const { fsSlot } = wireRealChannel(tmp);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    callGhostToolMock.mockImplementationOnce(async () => { await gate; return { ok: true, result: {} }; });
    const p = new SchedulerScriptCapabilityBroker()
      .call(
        { method: 'jira.search_jql', params: { jql: 'project = DING' } },
        new Set(['jira.read']),
        { schedule: schedule({ workingDir: tmp }), runId: 'run-r' },
      )
      .catch((err: unknown) => err);
    try {
      // 读方法不带 out_file:写窗不挂——只授 jira.read 的 schedule 不能让插件
      // 在调用在途期间写项目目录;插件若自动泄洪只是回落 truncated(与收窄前
      // 一致,无回归)。
      const callId = registerCallMock.mock.calls[0][0] as string;
      expect(await fsSlot.handleFsRequest('xd-atlassian', {
        op: 'write', root: 'workdir', callId, path: 'poison.json', content: 'x',
      })).toMatchObject({ ok: false });
      expect(fs.existsSync(path.join(tmp, 'poison.json'))).toBe(false);
    } finally {
      release();
      await p;
      await fs.promises.rm(tmp, { recursive: true, force: true });
    }
  });

  it('forwards ADF comment bodies untouched for real @mentions', async () => {
    // 2026-08-04 DING-179498:决策评论带 mention 的 ADF 曾被白名单拒收导致丢单。
    // fixture 用真实 mention 形态(text/accessLevel 等 attrs 全带),防「只透传
    // 了简化形态、真 payload 被剥字段」的回归(review)。
    const adf = {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '请 ' },
            { type: 'mention', attrs: { id: 'acc-1', text: '@张三', accessLevel: '' } },
            { type: 'text', text: ' 确认方案' },
          ],
        },
      ],
    };
    await new SchedulerScriptCapabilityBroker().call(
      { method: 'jira.add_comment', params: { issue_key: 'DING-2', body_adf: adf } },
      new Set(['jira.comment']),
      { schedule: schedule() },
    );
    expect(callGhostToolMock).toHaveBeenCalledWith({
      ghostId: 'xd-atlassian',
      tool: 'jira_issues',
      args: { action: 'add_comment', issue_key: 'DING-2', body_adf: adf },
      callId: expect.any(String),
    });
    // 互斥的负向断言:body_adf 分支不得夹带 body_text(review)。
    const dispatched = callGhostToolMock.mock.calls[0][0] as { args: Record<string, unknown> };
    expect(dispatched.args).not.toHaveProperty('body_text');
  });

  it('passes through an empty ADF object (shallow validation defers structure to Jira)', async () => {
    // body_adf {} 是浅校验放行的合法形态:结构深校验留给 Jira 侧,broker 不自作主张拒。
    await new SchedulerScriptCapabilityBroker().call(
      { method: 'jira.add_comment', params: { issue_key: 'DING-4', body_adf: {} } },
      new Set(['jira.comment']),
      { schedule: schedule() },
    );
    expect(callGhostToolMock).toHaveBeenCalledWith(expect.objectContaining({
      args: { action: 'add_comment', issue_key: 'DING-4', body_adf: {} },
    }));
  });

  it('requires exactly one of body_text and body_adf, and body_adf must be an object', async () => {
    const broker = new SchedulerScriptCapabilityBroker();
    const call = (params: Record<string, unknown>) =>
      broker.call(
        { method: 'jira.add_comment', params: { issue_key: 'DING-3', ...params } },
        new Set(['jira.comment']),
        { schedule: schedule() },
      );
    // 逐个坏输入断言(不合并批处理,哪个回归一眼可见;review):
    const badInputs: Array<[string, Record<string, unknown>]> = [
      ['两传', { body_text: 'x', body_adf: { type: 'doc' } }],
      ['都不传', {}],
      ['body_adf 为字符串', { body_adf: '{"type":"doc"}' }],
      ['body_adf 为数组', { body_adf: [{ type: 'doc' }] }],
      ['body_adf 为 null', { body_adf: null }],
      // 非 plain object 的 body_adf 全部拒收(结构深校验留给 Jira 侧);
      // body_text 空串/空白串走 requireString 同样拒。
      ['body_text 为空串', { body_text: '' }],
      ['body_text 为空白串', { body_text: '   ' }],
    ];
    for (const [label, params] of badInputs) {
      await expect(call(params), label).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    }
    // 账本无污染:全部坏输入必须在 registerCall 之前被拒——触达 ghost 或在
    // 账本留孤儿条目(未 finalize 永驻)都算事故(review)。
    expect(callGhostToolMock).not.toHaveBeenCalled();
    expect(registerCallMock).not.toHaveBeenCalled();
    expect(finalizeCallMock).not.toHaveBeenCalled();
  });

  it('lists recently-active feishu chats and forwards incremental start_time', async () => {
    const broker = new SchedulerScriptCapabilityBroker();
    await broker.call(
      { method: 'feishu.recent_chats', params: { count: 15 } },
      new Set(['feishu.read']),
      { schedule: schedule() },
    );
    expect(callGhostToolMock).toHaveBeenCalledWith({
      ghostId: 'xd-feishu',
      tool: 'call_tool',
      args: { name: 'im_list_chats', args: { sort_type: 'ByActiveTimeDesc', page_size: 15 } },
      callId: expect.any(String),
    });

    callGhostToolMock.mockClear();
    await broker.call(
      { method: 'feishu.recent_messages', params: { chat_id: 'oc_1', start_time: 1710000000 } },
      new Set(['feishu.read']),
      { schedule: schedule() },
    );
    expect(callGhostToolMock).toHaveBeenCalledWith({
      ghostId: 'xd-feishu',
      tool: 'call_tool',
      args: { name: 'im_read_messages', args: { container_id: 'oc_1', start_time: '1710000000' } },
      callId: expect.any(String),
    });

    await expect(
      broker.call(
        { method: 'feishu.recent_chats', params: {} },
        new Set(['jira.read']),
        { schedule: schedule() },
      ),
    ).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  });

  it('reads recent feishu messages through the xd-feishu ghost pipe', async () => {
    // 意识 call_tool 的交付是 { data } 包裹:broker 解开 data,脚本可见形状
    // 与老 registry 直调保持一致。
    callGhostToolMock.mockResolvedValueOnce({
      ok: true,
      result: { data: { ok: true, messages: [{ message_id: 'om_1' }] } },
    });
    const broker = new SchedulerScriptCapabilityBroker();
    const result = await broker.call(
      { method: 'feishu.recent_messages', params: { chat_id: 'oc_123', count: 10 } },
      new Set(['feishu.read']),
      { schedule: schedule() },
    );
    expect(callGhostToolMock).toHaveBeenCalledWith({
      ghostId: 'xd-feishu',
      tool: 'call_tool',
      args: { name: 'im_read_messages', args: { container_id: 'oc_123', page_size: 10 } },
      callId: expect.any(String),
    });
    expect(result).toMatchObject({ ok: true, messages: [{ message_id: 'om_1' }] });

    // pipe 层真实错误码形态(GHOST_ASLEEP/GHOST_NOT_FOUND/INTERNAL 等)原样透传。
    callGhostToolMock.mockResolvedValueOnce({
      ok: false,
      errorCode: 'GHOST_ASLEEP',
      message: 'xd-feishu 沉睡中',
    });
    await expect(
      broker.call(
        { method: 'feishu.recent_messages', params: { chat_id: 'oc_123' } },
        new Set(['feishu.read']),
        { schedule: schedule() },
      ),
    ).rejects.toMatchObject({ code: 'GHOST_ASLEEP' });

    await expect(
      broker.call(
        { method: 'feishu.recent_messages', params: { chat_id: 'oc_123', count: 51 } },
        new Set(['feishu.read']),
        { schedule: schedule() },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(
      broker.call(
        { method: 'feishu.recent_messages', params: { chat_id: 'oc_123' } },
        new Set(['jira.read']),
        { schedule: schedule() },
      ),
    ).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  });

  it('host.capabilities is grant-free introspection listing all methods with availability', async () => {
    const result = (await new SchedulerScriptCapabilityBroker().call(
      { method: 'host.capabilities', params: {} },
      new Set(['jira.read']),
      { schedule: schedule() },
    )) as { protocol: string; granted: string[]; methods: Array<{ method: string; available: boolean }> };
    expect(result.protocol).toBe('cindy-script/1');
    expect(result.granted).toEqual(['jira.read']);
    const byMethod = new Map(result.methods.map((m) => [m.method, m.available]));
    // 目录覆盖 broker 的全部方法;可用性按 granted 计算,自省自身恒可用
    expect(byMethod.get('host.capabilities')).toBe(true);
    expect(byMethod.get('jira.get')).toBe(true);
    expect(byMethod.get('jira.add_comment')).toBe(false);
    expect(byMethod.get('feishu.recent_chats')).toBe(false);
    expect(byMethod.get('feishu.recent_messages')).toBe(false);
    expect(byMethod.get('sessions.dispatch')).toBe(false);
    expect(byMethod.get('jira.search_jql')).toBe(true);
    expect(result.methods).toHaveLength(7);
  });

  it('rejects missing task grants and unknown methods', async () => {
    const broker = new SchedulerScriptCapabilityBroker();
    await expect(
      broker.call({ method: 'jira.get', params: { issue_key: 'DING-1' } }, new Set(), { schedule: schedule() }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    await expect(
      broker.call({ method: 'jira.transition', params: {} }, new Set(['jira.read']), { schedule: schedule() }),
    ).rejects.toMatchObject({ code: 'METHOD_NOT_FOUND' });
  });

  it('dispatches sessions with host-owned create defaults from the schedule', async () => {
    sendToSessionMock.mockResolvedValue({
      ok: true,
      targetSessionId: 'session-1',
      agentKind: 'codex',
      wakeKind: 'created',
      targetTitle: 'Triage DING-1',
      targetLastUserSendAt: null,
    });

    const result = await new SchedulerScriptCapabilityBroker().call(
      {
        method: 'sessions.dispatch',
        params: {
          message: 'please investigate',
          title: 'Triage DING-1',
        },
      },
      new Set(['sessions.dispatch']),
      { schedule: schedule() },
    );

    expect(sendToSessionMock).toHaveBeenCalledWith({
      targetSessionId: undefined,
      message: 'please investigate',
      title: 'Triage DING-1',
      useWorktree: false,
      createDefaults: {
        agentKind: 'codex',
        model: 'gpt-5.5',
        providerId: 'provider-1',
        effort: 'high',
        fastMode: true,
        workingDir: 'C:\\project',
        workspaceKind: 'project',
        permissionMode: 'bypassPermissions',
      },
    });
    expect(result).toMatchObject({ target_session_id: 'session-1', wake_kind: 'created' });
  });

  it('resolves blank Pi script-dispatch defaults as one model/provider route', async () => {
    sendToSessionMock.mockResolvedValue({
      ok: true,
      targetSessionId: 'session-pi',
      agentKind: 'pi',
      wakeKind: 'created',
      targetTitle: 'Pi task',
      targetLastUserSendAt: null,
    });
    const resolveDefaultModelRoute = vi.fn(async () => ({
      model: 'byom/qwen3-coder',
      providerId: 'local-byom',
    }));
    const broker = new SchedulerScriptCapabilityBroker({ resolveDefaultModelRoute });

    await broker.call(
      { method: 'sessions.dispatch', params: { message: 'run Pi task' } },
      new Set(['sessions.dispatch']),
      { schedule: schedule({ agentKind: 'pi', model: undefined, providerId: 'local-byom' }) },
    );

    expect(resolveDefaultModelRoute).toHaveBeenCalledWith('pi', 'local-byom');
    expect(sendToSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      createDefaults: expect.objectContaining({
        agentKind: 'pi',
        model: 'byom/qwen3-coder',
        providerId: 'local-byom',
      }),
    }));
  });

  it('rejects blank Pi script-dispatch defaults before opening a session when no source is connected', async () => {
    const broker = new SchedulerScriptCapabilityBroker({
      resolveDefaultModelRoute: vi.fn(async () => null),
    });

    await expect(broker.call(
      { method: 'sessions.dispatch', params: { message: 'run Pi task' } },
      new Set(['sessions.dispatch']),
      { schedule: schedule({ agentKind: 'pi', model: undefined, providerId: undefined }) },
    )).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(sendToSessionMock).not.toHaveBeenCalled();
  });

  it('rejects host-owned session dispatch fields from scripts', async () => {
    const broker = new SchedulerScriptCapabilityBroker();
    await expect(
      broker.call(
        {
          method: 'sessions.dispatch',
          params: { message: 'x', dispatcher_session_id: 'spoofed' },
        },
        new Set(['sessions.dispatch']),
        { schedule: schedule() },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    expect(sendToSessionMock).not.toHaveBeenCalled();
  });

  it('forwards out_file to xd-atlassian and rejects unsafe paths', async () => {
    const broker = new SchedulerScriptCapabilityBroker();
    const searched = await broker.call(
      { method: 'jira.search_jql', params: { jql: 'project = DING', out_file: 'reports/r.json' } },
      new Set(['jira.read']),
      { schedule: schedule() },
    );
    expect(searched).toMatchObject({ args: { action: 'search_jql', out_file: 'reports/r.json' } });
    const got = await broker.call(
      { method: 'jira.get', params: { issue_key: 'DING-1', out_file: 'issue.json' } },
      new Set(['jira.read']),
      { schedule: schedule() },
    );
    expect(got).toMatchObject({ args: { action: 'get', out_file: 'issue.json' } });
    // 与 fs 槽同一口径(validateFsRelPath):穿越/绝对/反斜杠/空白一律 INVALID_ARGS。
    for (const bad of ['../escape.json', '/abs/x.json', 'a\\b.json', '', '   ']) {
      await expect(
        broker.call(
          { method: 'jira.search_jql', params: { jql: 'x', out_file: bad } },
          new Set(['jira.read']),
          { schedule: schedule() },
        ),
      ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    }
  });

  it('registers script-channel callId before dispatch and finalizes it on success and failure', async () => {
    const broker = new SchedulerScriptCapabilityBroker();
    // 跨平台绝对路径(isAbsolute 校验在 broker 登记侧,Windows 盘符路径在
    // POSIX 上不算绝对,会拿到不同的登记形状)。
    const absWorkdir = path.resolve(path.sep);
    await broker.call(
      { method: 'jira.get', params: { issue_key: 'DING-1', out_file: 'r.json' } },
      new Set(['jira.read']),
      { schedule: schedule({ workingDir: absWorkdir }) },
    );
    // 登记形状:无会话、脚本通道标记、带 schedule.workingDir 作为落盘根
    // (仅显式带 out_file 的调用才挂写窗,review P1 第四轮)。
    expect(registerCallMock).toHaveBeenCalledTimes(1);
    const [callId, info] = registerCallMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(info).toEqual({
      ghostId: 'xd-atlassian', toolUseId: null, sessionId: null, scriptWorkdir: absWorkdir, scriptWritePath: 'r.json', channel: 'script',
    });
    // 同一 callId 下行给意识;顺序:register → dispatch → finalize。
    expect(callGhostToolMock).toHaveBeenCalledWith(expect.objectContaining({ callId }));
    expect(finalizeCallMock).toHaveBeenCalledWith(callId);
    expect(registerCallMock.mock.invocationCallOrder[0]).toBeLessThan(
      callGhostToolMock.mock.invocationCallOrder[0],
    );
    expect(finalizeCallMock.mock.invocationCallOrder[0]).toBeGreaterThan(
      callGhostToolMock.mock.invocationCallOrder[0],
    );

    // 不带 out_file 的读调用不挂写窗(review P1 第四轮):scriptWorkdir null,
    // 登记/下发/finalize 生命周期不变。
    registerCallMock.mockClear();
    await broker.call(
      { method: 'jira.get', params: { issue_key: 'DING-1' } },
      new Set(['jira.read']),
      { schedule: schedule({ workingDir: absWorkdir }) },
    );
    expect(registerCallMock.mock.calls[0][1]).toMatchObject({ scriptWorkdir: null, channel: 'script' });

    // 失败路径同样 finalize——不 finalize 条目永驻,callId 永久有效(破"用完即废")。
    registerCallMock.mockClear();
    finalizeCallMock.mockClear();
    callGhostToolMock.mockResolvedValueOnce({ ok: false, errorCode: 'GHOST_ASLEEP', message: 'x' });
    await expect(
      broker.call(
        { method: 'jira.get', params: { issue_key: 'DING-1' } },
        new Set(['jira.read']),
        { schedule: schedule() },
      ),
    ).rejects.toMatchObject({ code: 'GHOST_ASLEEP' });
    expect(finalizeCallMock).toHaveBeenCalledTimes(1);

    // 畸形 workingDir(相对路径/首尾空白)按 null 登记:fs 槽拒写但查询
    // 不受影响;条目的 channel:'script' 标记不受影响(review m2/m3/n2)。
    // 带 out_file 调用才挂写窗,否则畸形校验根本不执行(第四轮收窄)。
    registerCallMock.mockClear();
    await broker.call(
      { method: 'jira.get', params: { issue_key: 'DING-1', out_file: 'x.json' } },
      new Set(['jira.read']),
      { schedule: schedule({ workingDir: 'relative/dir' }) },
    );
    expect(registerCallMock.mock.calls[0][1]).toMatchObject({ scriptWorkdir: null, channel: 'script' });

    // 首尾空白的绝对路径按原值登记(trim 只判空不改写)——与 script-runner
    // 的 spawn cwd 严格同源,POSIX 上带尾空格的目录名不会让授权根分叉(review)。
    registerCallMock.mockClear();
    const padded = `${absWorkdir}${path.sep}padded `;
    await broker.call(
      { method: 'jira.get', params: { issue_key: 'DING-1', out_file: 'x.json' } },
      new Set(['jira.read']),
      { schedule: schedule({ workingDir: padded }) },
    );
    expect(registerCallMock.mock.calls[0][1]).toMatchObject({ scriptWorkdir: padded, channel: 'script' });
  });

  it('端到端:脚本通道 out_file 经真实 cardService + fs 槽落进 schedule 工作目录', async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'broker-e2e-'));
    try {
      const { fsSlot } = wireRealChannel(tmp);
      // 模拟意识行为(xd-atlassian 的 deliver 路径):收到 tool-call 后按 out_file
      // 经 fs 槽 root:'workdir' 泄洪写盘,回 saved_to 相对路径。在途期间顺带
      // 试探写根内其它路径——白名单必须拒(断言在下方)。
      let offPathResult: { ok: boolean } | null = null;
      callGhostToolMock.mockImplementation(async (request: unknown) => {
        const { callId, args } = request as { callId: string; args: Record<string, unknown> };
        const outFile = args.out_file as string;
        const w = await fsSlot.handleFsRequest('xd-atlassian', {
          op: 'write', root: 'workdir', callId, path: outFile, content: '{"issues":[1,2,3]}',
        });
        if (!w.ok) return { ok: false, errorCode: 'INTERNAL', message: w.message ?? 'write failed' };
        offPathResult = await fsSlot.handleFsRequest('xd-atlassian', {
          op: 'write', root: 'workdir', callId, path: 'src/evil.ts', content: 'x',
        });
        return { ok: true, result: { saved_to: outFile } };
      });

      const result = await new SchedulerScriptCapabilityBroker().call(
        { method: 'jira.search_jql', params: { jql: 'project = DING', out_file: 'reports/jira.json' } },
        new Set(['jira.read']),
        { schedule: schedule({ workingDir: tmp }) },
      );
      expect(result).toMatchObject({ saved_to: 'reports/jira.json' });
      // 字节真身落在 schedule 工作目录内,脚本可按相对路径从自己 cwd 读回。
      expect(await fs.promises.readFile(path.join(tmp, 'reports', 'jira.json'), 'utf8')).toBe('{"issues":[1,2,3]}');
      // 路径白名单(review P1 第五轮):在途期间写 out_file 之外的根内路径被拒。
      expect(offPathResult).toMatchObject({ ok: false });
      expect(fs.existsSync(path.join(tmp, 'src', 'evil.ts'))).toBe(false);
      // 用完即废(review M1 真断言):broker 已 finalize,同一 callId 再经 fs 槽
      // 写盘必须被拒——插件在交卷后(含 TIMEOUT 后仍在后台跑的场景)持有的
      // 旧 callId 不再授权任何写入。
      const usedCallId = registerCallMock.mock.calls[0][0] as string;
      const late = await fsSlot.handleFsRequest('xd-atlassian', {
        op: 'write', root: 'workdir', callId: usedCallId, path: 'reports/late.json', content: 'x',
      });
      expect(late).toMatchObject({ ok: false });
      expect(fs.existsSync(path.join(tmp, 'reports', 'late.json'))).toBe(false);
    } finally {
      await fs.promises.rm(tmp, { recursive: true, force: true });
    }
  });

  it('端到端(穿真实 pipeDispatcher):callId 下行配对、错误折叠、交卷后写拒', async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'broker-e2e-pipe-'));
    try {
      const { fsSlot } = wireRealChannel(tmp);
      // 真实 dispatcher:资格审 + callId 配对 + 错误折叠全真,只有「意识进程」
      // 本身由 sendToGhost 内联模拟(先经 fs 槽写盘,再 handleToolResult 交卷)。
      let dispatcher!: GhostPipeDispatcher;
      dispatcher = new GhostPipeDispatcher({
        getGhost: (id) => (id === 'xd-atlassian' ? makeInstalledGhost(id) : null),
        runtimeStateOf: () => 'running',
        spawn: async () => ({ ok: true }),
        sendToGhost: (ghostId: string, payload: GhostPipeToolCall) => {
          void (async () => {
            const outFile = (payload.args as Record<string, unknown>).out_file as string;
            const w = await fsSlot.handleFsRequest(ghostId, {
              op: 'write', root: 'workdir', callId: payload.callId, path: outFile, content: '{"via":"pipe"}',
            });
            dispatcher.handleToolResult(ghostId, w.ok
              ? { callId: payload.callId, ok: true, result: { saved_to: outFile } }
              : { callId: payload.callId, ok: false, errorCode: 'INTERNAL', message: w.message });
          })();
          return true;
        },
        timeoutMs: 5_000,
      });
      callGhostToolMock.mockImplementation((request: unknown) =>
        dispatcher.callGhostTool(request as { ghostId: string; tool: string; args: Record<string, unknown> }),
      );

      const broker = new SchedulerScriptCapabilityBroker();
      const ok = await broker.call(
        { method: 'jira.search_jql', params: { jql: 'x', out_file: 'r/pipe.json' } },
        new Set(['jira.read']),
        { schedule: schedule({ workingDir: tmp }) },
      );
      expect(ok).toMatchObject({ saved_to: 'r/pipe.json' });
      expect(await fs.promises.readFile(path.join(tmp, 'r', 'pipe.json'), 'utf8')).toBe('{"via":"pipe"}');
      // 已交卷:真实 dispatcher 配对的 callId 同样立即失去写盘授权。
      const usedCallId = registerCallMock.mock.calls[0][0] as string;
      expect(await fsSlot.handleFsRequest('xd-atlassian', {
        op: 'write', root: 'workdir', callId: usedCallId, path: 'r/late.json', content: 'x',
      })).toMatchObject({ ok: false });
    } finally {
      await fs.promises.rm(tmp, { recursive: true, force: true });
    }
  });

  it('传输层异常(callGhostTool reject)同样 finalize,旧 callId 立即失在途资格', async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'broker-reject-'));
    try {
      const { cardService } = wireRealChannel(tmp);
      // 生产契约上 callGhostTool 永不 reject(pipeDispatcher 折叠),但 finally
      // 必须对传输层炸裂同样成立——锁死防御语义。
      callGhostToolMock.mockRejectedValueOnce(new Error('transport blew up'));
      await expect(
        new SchedulerScriptCapabilityBroker().call(
          { method: 'jira.get', params: { issue_key: 'DING-1' } },
          new Set(['jira.read']),
          { schedule: schedule({ workingDir: tmp }) },
        ),
      ).rejects.toThrow('transport blew up');
      const callId = registerCallMock.mock.calls[0][0] as string;
      expect(finalizeCallMock).toHaveBeenCalledWith(callId);
      expect(cardService.inFlightCallInfoOf(callId)).toBeNull();
    } finally {
      await fs.promises.rm(tmp, { recursive: true, force: true });
    }
  });

  it('finalizeActiveCalls(runId):终结本 run 的在途写权,并发 run 不误伤(两个 review P1)', async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'broker-finalize-'));
    const { cardService, fsSlot } = wireRealChannel(tmp);
    // 两个不同 run 的调用都挂闸门保持在途。
    const gates: Array<() => void> = [];
    callGhostToolMock.mockImplementation(async () => {
      await new Promise<void>((resolve) => gates.push(resolve));
      return { ok: true, result: {} };
    });
    const broker = new SchedulerScriptCapabilityBroker();
    const granted = new Set(['jira.read'] as const);
    // 带 out_file 才挂写窗(第四轮收窄),本用例测的是 run 粒度收口。
    const pA = broker
      .call({ method: 'jira.get', params: { issue_key: 'DING-1', out_file: 'a.json' } }, granted, { schedule: schedule({ workingDir: tmp }), runId: 'run-A' })
      .catch((err: unknown) => err);
    const pB = broker
      .call({ method: 'jira.get', params: { issue_key: 'DING-2', out_file: 'b.json' } }, granted, { schedule: schedule({ workingDir: tmp }), runId: 'run-B' })
      .catch((err: unknown) => err);
    try {
      const callIdA = registerCallMock.mock.calls[0][0] as string;
      const callIdB = registerCallMock.mock.calls[1][0] as string;
      // 两个 run 都在途:写盘都放行。
      expect(await fsSlot.handleFsRequest('xd-atlassian', {
        op: 'write', root: 'workdir', callId: callIdA, path: 'a.json', content: 'x',
      })).toMatchObject({ ok: true });
      expect(await fsSlot.handleFsRequest('xd-atlassian', {
        op: 'write', root: 'workdir', callId: callIdB, path: 'b.json', content: 'x',
      })).toMatchObject({ ok: true });
      // run-A 终结(drain 30s 截止/abort):它的在途授权立即失效,不等
      // pipeDispatcher 超时(上限 30min);并发的 run-B 不受影响(broker 单例、
      // scheduler 并发上限 8,误清别家桶会把合法写盘拒成「已过期」)。
      broker.finalizeActiveCalls('run-A');
      expect(cardService.inFlightCallInfoOf(callIdA)).toBeNull();
      expect(await fsSlot.handleFsRequest('xd-atlassian', {
        op: 'write', root: 'workdir', callId: callIdA, path: 'a-late.json', content: 'x',
      })).toMatchObject({ ok: false });
      expect(await fsSlot.handleFsRequest('xd-atlassian', {
        op: 'write', root: 'workdir', callId: callIdB, path: 'b.json', content: 'x',
      })).toMatchObject({ ok: true });
      // run-B 终结后同样失效。
      broker.finalizeActiveCalls('run-B');
      expect(await fsSlot.handleFsRequest('xd-atlassian', {
        op: 'write', root: 'workdir', callId: callIdB, path: 'b-late.json', content: 'x',
      })).toMatchObject({ ok: false });
    } finally {
      // 调用之后正常交卷:finalize 幂等(dispatcher 配对账本独立),不炸。
      for (const release of gates) release();
      await Promise.all([pA, pB]);
      await fs.promises.rm(tmp, { recursive: true, force: true });
    }
  });

  it('并发调用:两个 callId 各自独立,一个 finalize 不误伤另一个的在途写权', async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'broker-conc-'));
    try {
      const { fsSlot } = wireRealChannel(tmp);
      // 第一个调用挂闸门(保持在途),第二个立即完成并 finalize。
      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
      callGhostToolMock
        .mockImplementationOnce(async () => { await firstGate; return { ok: true, result: {} }; })
        .mockImplementationOnce(async () => ({ ok: true, result: {} }));
      const broker = new SchedulerScriptCapabilityBroker();
      const granted = new Set(['jira.read'] as const);
      // 带 out_file 才挂写窗(第四轮收窄),本用例测的是并发 callId 隔离。
      const p1 = broker.call({ method: 'jira.get', params: { issue_key: 'DING-1', out_file: 'a.json' } }, granted, { schedule: schedule({ workingDir: tmp }) });
      const p2 = broker.call({ method: 'jira.get', params: { issue_key: 'DING-2', out_file: 'b.json' } }, granted, { schedule: schedule({ workingDir: tmp }) });
      await p2;
      const firstCallId = registerCallMock.mock.calls[0][0] as string;
      const secondCallId = registerCallMock.mock.calls[1][0] as string;
      // 第二个已交卷:写拒;第一个仍在途:写通——两本授权互不串。
      expect(await fsSlot.handleFsRequest('xd-atlassian', {
        op: 'write', root: 'workdir', callId: secondCallId, path: 'second.json', content: 'x',
      })).toMatchObject({ ok: false });
      expect(await fsSlot.handleFsRequest('xd-atlassian', {
        op: 'write', root: 'workdir', callId: firstCallId, path: 'a.json', content: 'x',
      })).toMatchObject({ ok: true });
      releaseFirst();
      await p1;
      // 第一个交卷后同样失效。
      expect(await fsSlot.handleFsRequest('xd-atlassian', {
        op: 'write', root: 'workdir', callId: firstCallId, path: 'first-late.json', content: 'x',
      })).toMatchObject({ ok: false });
    } finally {
      await fs.promises.rm(tmp, { recursive: true, force: true });
    }
  });
});

// Compile-time fixture: legacy schedules may omit executionMode.
const _legacySchedule: Partial<Schedule> = { prompt: 'legacy' };
void _legacySchedule;

/** 端到端用例的已装意识(fixture):声明 fs 槽(fs 槽资格审)+ jira_issues 工具
 *  (pipeDispatcher 资格审)。 */
function makeInstalledGhost(id: string): InstalledGhost {
  return {
    manifest: {
      schemaVersion: 2,
      id,
      name: id,
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
      fs: true,
      tools: [{ name: 'jira_issues', description: 'jira' }],
    } as InstalledGhost['manifest'],
    dir: '/tmp/fake-install-dir',
    enabled: true,
    approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
  };
}

/**
 * 端到端 harness:真实 GhostCardService + 真实 GhostFsSlot,把 broker 的
 * mock 边界(register/finalize)接到真实账本——用例只需替换意识行为
 * (callGhostToolMock 的实现),其余链路全真。
 */
function wireRealChannel(tmp: string): { cardService: GhostCardService; fsSlot: GhostFsSlot } {
  const cardService = new GhostCardService({
    hasCardSlot: () => false,
    sanitize: (html: string) => ({ ok: true, html }),
    persist: async () => {},
    broadcast: () => {},
  });
  const fsSlot = new GhostFsSlot({
    getGhost: (id) => (id === 'xd-atlassian' ? makeInstalledGhost(id) : null),
    dataRootDir: () => path.join(tmp, 'ghost-fs'),
    callInfo: (callId) => cardService.callInfoOf(callId),
    inFlightCallInfo: (callId) => cardService.inFlightCallInfoOf(callId),
    getSessionSnapshot: async () => null,
    requestWriteConfirm: async () => ({ confirmed: false, reason: 'cancelled' as const }),
    writeSaveDeposit: async () => null,
  });
  registerCallMock.mockImplementation((callId: string, info: never) =>
    cardService.registerCall(callId, info),
  );
  finalizeCallMock.mockImplementation((callId: string) => cardService.finalizeCall(callId));
  return { cardService, fsSlot };
}
