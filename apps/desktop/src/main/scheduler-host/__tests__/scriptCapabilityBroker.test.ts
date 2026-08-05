import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { Schedule } from '@cindy/maker-scheduler';
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

vi.mock('../../cindy-brain/index.js', () => ({
  getGhostPipeDispatcher: () => ({ callGhostTool: callGhostToolMock }),
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
});

// Compile-time fixture: legacy schedules may omit executionMode.
const _legacySchedule: Partial<Schedule> = { prompt: 'legacy' };
void _legacySchedule;
