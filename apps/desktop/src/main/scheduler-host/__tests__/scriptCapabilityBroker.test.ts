import { describe, expect, it, vi, beforeEach } from 'vitest';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Schedule } from '@cindy/maker-scheduler';
import { GhostCardService } from '../../cindy-brain/cardService.js';
import { GhostFsSlot } from '../../cindy-brain/fsSlot.js';
import type { InstalledGhost } from '../../../shared/ghost.js';
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
      { method: 'jira.get', params: { issue_key: 'DING-1' } },
      new Set(['jira.read']),
      { schedule: schedule({ workingDir: absWorkdir }) },
    );
    // 登记形状:无会话、脚本通道标记、带 schedule.workingDir 作为落盘根。
    expect(registerCallMock).toHaveBeenCalledTimes(1);
    const [callId, info] = registerCallMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(info).toEqual({
      ghostId: 'xd-atlassian', toolUseId: null, sessionId: null, scriptWorkdir: absWorkdir, channel: 'script',
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
    registerCallMock.mockClear();
    await broker.call(
      { method: 'jira.get', params: { issue_key: 'DING-1' } },
      new Set(['jira.read']),
      { schedule: schedule({ workingDir: 'relative/dir' }) },
    );
    expect(registerCallMock.mock.calls[0][1]).toMatchObject({ scriptWorkdir: null, channel: 'script' });
  });

  it('端到端:脚本通道 out_file 经真实 cardService + fs 槽落进 schedule 工作目录', async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'broker-e2e-'));
    try {
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
      // 模拟意识行为(xd-atlassian 的 deliver 路径):收到 tool-call 后按 out_file
      // 经 fs 槽 root:'workdir' 泄洪写盘,回 saved_to 相对路径。
      callGhostToolMock.mockImplementation(async (request: unknown) => {
        const { callId, args } = request as { callId: string; args: Record<string, unknown> };
        const outFile = args.out_file as string;
        const w = await fsSlot.handleFsRequest('xd-atlassian', {
          op: 'write', root: 'workdir', callId, path: outFile, content: '{"issues":[1,2,3]}',
        });
        if (!w.ok) return { ok: false, errorCode: 'INTERNAL', message: w.message ?? 'write failed' };
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
});

// Compile-time fixture: legacy schedules may omit executionMode.
const _legacySchedule: Partial<Schedule> = { prompt: 'legacy' };
void _legacySchedule;

/** 端到端用例的已装意识(fixture):声明 fs 槽,好让 fs 槽资格审通过。 */
function makeInstalledGhost(id: string): InstalledGhost {
  return {
    manifest: {
      schemaVersion: 2,
      id,
      name: id,
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
      slots: ['fs'],
    } as InstalledGhost['manifest'],
    dir: '/tmp/fake-install-dir',
    enabled: true,
  };
}
