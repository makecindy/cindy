/**
 * editLastUserMessage.test.ts
 * ---------------------------------------------------------------------------
 * edit-last-message 提交编排(commitEditAndResend)的契约测试。
 *
 * 编辑最后一条 user 消息 = rewindCommit(后端软删 + 文件回滚)→ sidebar patch
 * → 内存裁剪 → 立即重发。步骤顺序与参数透传是这里唯一的业务逻辑,全部经
 * DI 假件断言;真实 IPC / store 行为分别由 rewind IPC 测试与 store 测试覆盖。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

// commitEditAndResend 的默认 deps 会拉起 sessionService / makerChatStore 的
// 模块链(window.electronAPI 依赖)。测试全部走显式 deps,模块 mock 只为让
// import 不炸。
vi.mock('@/lib/sessionService', () => ({
  rewindCommit: vi.fn(),
}));
vi.mock('@/lib/makerTransport', () => ({
  listMessagesFor: vi.fn(async () => []),
}));
vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: { sendMessage: vi.fn(), dropMessagesFromClientId: vi.fn() },
}));
vi.mock('@/lib/sessionsBus', () => ({
  emitPatch: vi.fn(),
}));
vi.mock('@/lib/composerDraftStore', () => ({
  saveDraft: vi.fn(),
  plainTextToTiptapDoc: vi.fn((s: string) => ({ type: 'doc', text: s })),
}));
// httpClient 顶层 import '@/i18n'(初始化重、依赖 window),mock 成等价的
// ApiError 壳 —— lib 与本测试拿到同一个 class,instanceof 判定保持成立。
vi.mock('@/lib/httpClient', () => ({
  ApiError: class ApiError extends Error {
    code: string;
    status: number;
    constructor(code: string, status: number, message: string) {
      super(message);
      this.code = code;
      this.status = status;
    }
  },
}));

import {
  commitEditAndResend,
  commitEditAndResendWithRunningRetry,
  fetchLatestUserMessageClientIdViaDb,
  RUNNING_RETRY_DEFAULTS,
  type CommitEditAndResendDeps,
} from '@/lib/editLastUserMessage';
import { listMessagesFor as listMessagesMock } from '@/lib/makerTransport';
import { ApiError } from '@/lib/httpClient';
import { formatQuoteForSend } from '@/lib/chatQuotes';
import type { Session } from '@/lib/ccAgent.types';

const SESSION_ID = 'sess-1';
const CLIENT_ID = 'msg-42';

function fakeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: SESSION_ID,
    model: 'claude-sonnet-4-6',
    effort: 'high',
    permissionMode: 'default',
    workingDir: '/repo/from-session',
    sdkSessionId: 'sdk-new',
    updatedAt: '2026-07-03T00:00:00.000Z',
    userSendAt: '2026-07-03T00:00:00.000Z',
    ...overrides,
  } as Session;
}

function makeDeps(
  session: Session = fakeSession(),
  { dispatchResult = true }: { dispatchResult?: boolean } = {},
): {
  deps: CommitEditAndResendDeps;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      rewindCommit: vi.fn(async () => {
        calls.push('rewindCommit');
        return session;
      }),
      emitPatch: vi.fn(() => {
        calls.push('emitPatch');
      }) as unknown as CommitEditAndResendDeps['emitPatch'],
      dropMessagesFromClientId: vi.fn(() => {
        calls.push('drop');
      }),
      sendMessage: vi.fn(async () => {
        calls.push('send');
        return dispatchResult;
      }) as unknown as CommitEditAndResendDeps['sendMessage'],
      saveDraftFallback: vi.fn(() => {
        calls.push('saveDraftFallback');
      }),
      hasPendingQueue: vi.fn(() => false),
      fetchLatestUserMessageClientId: vi.fn(async () => CLIENT_ID),
    },
  };
}

describe('commitEditAndResend', () => {
  it('空文本 + 无附件:拒绝执行,rewindCommit 不被调用(避免"只回退没重发")', async () => {
    const { deps } = makeDeps();
    await expect(
      commitEditAndResend(
        { sessionId: SESSION_ID, clientId: CLIENT_ID, text: '   ', fallbackWorkingDir: '/repo' },
        deps,
      ),
    ).rejects.toThrow();
    expect(deps.rewindCommit).not.toHaveBeenCalled();
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it('happy path:rewindCommit → emitPatch → drop → send 顺序执行,send 用 session 行的设置', async () => {
    const { deps, calls } = makeDeps();
    await expect(
      commitEditAndResend(
        { sessionId: SESSION_ID, clientId: CLIENT_ID, text: 'edited text', fallbackWorkingDir: '/repo-fallback' },
        deps,
      ),
    ).resolves.toBe(true);

    expect(calls).toEqual(['rewindCommit', 'emitPatch', 'drop', 'send']);
    expect(deps.rewindCommit).toHaveBeenCalledWith(SESSION_ID, CLIENT_ID);
    expect(deps.dropMessagesFromClientId).toHaveBeenCalledWith(SESSION_ID, CLIENT_ID);

    const sendArgs = (deps.sendMessage as unknown as Mock).mock.calls[0];
    expect(sendArgs[0]).toBe(SESSION_ID);
    expect(sendArgs[1]).toBe('edited text');
    expect(sendArgs[2]).toBe('claude-sonnet-4-6'); // model
    expect(sendArgs[3]).toBe('high'); // effort
    expect(sendArgs[4]).toBe('default'); // permissionMode
    expect(sendArgs[5]).toBe('/repo/from-session'); // workingDir 来自 session 行
    expect(sendArgs[6]).toBeUndefined(); // 无附件

    // sidebar patch:token 归零 + sdkSessionId 透传
    const patchArgs = (deps.emitPatch as unknown as Mock).mock.calls[0];
    expect(patchArgs[0]).toBe(SESSION_ID);
    expect(patchArgs[1]).toMatchObject({
      sdkSessionId: 'sdk-new',
      contextTokens: 0,
      contextWindow: 0,
    });
  });

  it('原消息 quotesEncoded 时重发透传标志(opts 第 9 参);未带时不注入', async () => {
    const { deps } = makeDeps();
    await commitEditAndResend(
      {
        sessionId: SESSION_ID,
        clientId: CLIENT_ID,
        text: '> quoted\n\nbody',
        fallbackWorkingDir: '/repo',
        quotesEncoded: true,
      },
      deps,
    );
    let sendArgs = (deps.sendMessage as unknown as Mock).mock.calls[0];
    expect(sendArgs[8]).toEqual({ quotesEncoded: true });

    const { deps: deps2 } = makeDeps();
    await commitEditAndResend(
      { sessionId: SESSION_ID, clientId: CLIENT_ID, text: 'plain', fallbackWorkingDir: '/repo' },
      deps2,
    );
    sendArgs = (deps2.sendMessage as unknown as Mock).mock.calls[0];
    expect(sendArgs[8]).toBeUndefined();
  });

  it('原消息语义引用与 chip ranges 由编辑框确认未修改后透传到重发 opts', async () => {
    const { deps } = makeDeps();
    const agentReferences = [{
      kind: 'session' as const,
      start: 0,
      end: 11,
      href: 'cindy://session/source',
      sessionId: 'source',
    }];
    const pastedTextRanges = [{ start: 0, end: 11, display: 'Pasted text (1 line)' }];
    await commitEditAndResend(
      {
        sessionId: SESSION_ID,
        clientId: CLIENT_ID,
        text: 'pasted body',
        fallbackWorkingDir: '/repo',
        agentReferences,
        pastedTextRanges,
        slashCommandRanges: [],
      },
      deps,
    );
    const sendArgs = (deps.sendMessage as unknown as Mock).mock.calls[0];
    expect(sendArgs[8]).toEqual({ agentReferences, pastedTextRanges, slashCommandRanges: [] });
  });

  it('session 行 workingDir 为 null 时回落到 fallbackWorkingDir', async () => {
    const { deps } = makeDeps(fakeSession({ workingDir: null }));
    await commitEditAndResend(
      { sessionId: SESSION_ID, clientId: CLIENT_ID, text: 'hi', fallbackWorkingDir: '/repo-fallback' },
      deps,
    );
    const sendArgs = (deps.sendMessage as unknown as Mock).mock.calls[0];
    expect(sendArgs[5]).toBe('/repo-fallback');
  });

  it('原消息附件被原样重建重发(图片 url + 文件路径保留);纯附件无文本也允许发送', async () => {
    const { deps } = makeDeps();
    await commitEditAndResend(
      {
        sessionId: SESSION_ID,
        clientId: CLIENT_ID,
        text: '',
        images: [{ url: 'xdt-image://cache/a.png', mimeType: 'image/png', originalName: 'a.png' }],
        files: [{ name: 'notes.md', path: '/repo/notes.md' }],
        fallbackWorkingDir: '/repo',
      },
      deps,
    );
    const sendArgs = (deps.sendMessage as unknown as Mock).mock.calls[0];
    const attachments = sendArgs[6] as Array<Record<string, unknown>>;
    expect(attachments).toHaveLength(2);
    expect(attachments[0]).toMatchObject({
      category: 'image',
      url: 'xdt-image://cache/a.png',
      mimeType: 'image/png',
    });
    expect(attachments[1]).toMatchObject({ name: 'notes.md', path: '/repo/notes.md' });
  });

  it('重发入队成功:不落草稿兜底', async () => {
    const { deps } = makeDeps(fakeSession(), { dispatchResult: true });
    await commitEditAndResend(
      { sessionId: SESSION_ID, clientId: CLIENT_ID, text: 'ok', fallbackWorkingDir: '/repo' },
      deps,
    );
    expect(deps.saveDraftFallback).not.toHaveBeenCalled();
  });

  it('重发入队失败:rewind 已 commit,编辑文本 + 附件落 composer 草稿兜底', async () => {
    const { deps, calls } = makeDeps(fakeSession(), { dispatchResult: false });
    await commitEditAndResend(
      {
        sessionId: SESSION_ID,
        clientId: CLIENT_ID,
        text: 'precious edit',
        files: [{ name: 'notes.md', path: '/repo/notes.md' }],
        fallbackWorkingDir: '/repo',
      },
      deps,
    );
    expect(calls).toEqual(['rewindCommit', 'emitPatch', 'drop', 'send', 'saveDraftFallback']);
    const [sid, document, attachments] = (deps.saveDraftFallback as unknown as Mock).mock.calls[0] as [
      string,
      Record<string, unknown>,
      Array<Record<string, unknown>>,
    ];
    expect(sid).toBe(SESSION_ID);
    expect(document).toEqual({ type: 'doc', text: 'precious edit' });
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ name: 'notes.md', path: '/repo/notes.md' });
  });

  it('quoted 消息重发失败:兜底草稿按正文顺序还原 inline quote chip', async () => {
    const { deps } = makeDeps(fakeSession(), { dispatchResult: false });
    await commitEditAndResend(
      {
        sessionId: SESSION_ID,
        clientId: CLIENT_ID,
        text: [
          formatQuoteForSend({ text: 'quoted line', sourcePath: 'src/a.ts' }),
          'edited body',
          formatQuoteForSend({ text: 'second' }),
          'second reply',
        ].join('\n\n'),
        fallbackWorkingDir: '/repo',
        quotesEncoded: true,
      },
      deps,
    );
    const [, document] = (deps.saveDraftFallback as unknown as Mock).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(document).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'composerQuote',
              attrs: {
                text: 'quoted line',
                sourcePath: 'src/a.ts',
                startLine: null,
                endLine: null,
              },
            },
            { type: 'text', text: 'edited body' },
            {
              type: 'composerQuote',
              attrs: { text: 'second', sourcePath: null, startLine: null, endLine: null },
            },
            { type: 'text', text: 'second reply' },
          ],
        },
      ],
    });
  });

  it('旧版 markerless quoted 消息重发失败:只还原前置引用并保留正文 blockquote', async () => {
    const { deps } = makeDeps(fakeSession(), { dispatchResult: false });
    await commitEditAndResend(
      {
        sessionId: SESSION_ID,
        clientId: CLIENT_ID,
        text: '> first quote\n\nfirst reply\n\n> second quote\n\nsecond reply',
        fallbackWorkingDir: '/repo',
        quotesEncoded: true,
      },
      deps,
    );
    const [, document] = (deps.saveDraftFallback as unknown as Mock).mock.calls[0] as [
      string,
      {
        content?: Array<{
          content?: Array<{ type?: string; text?: string; attrs?: { text?: string } }>;
        }>;
      },
    ];
    const nodes = document.content?.flatMap((paragraph) => paragraph.content ?? []) ?? [];
    expect(nodes.filter((node) => node.type === 'composerQuote')).toEqual([
      expect.objectContaining({ attrs: expect.objectContaining({ text: 'first quote' }) }),
    ]);
    expect(nodes.filter((node) => node.type === 'text').map((node) => node.text).join('\n')).toContain(
      '> second quote',
    );
  });

  it('非 quoted 消息重发失败:兜底不注入 quotes(第 4 参 undefined)', async () => {
    const { deps } = makeDeps(fakeSession(), { dispatchResult: false });
    await expect(
      commitEditAndResend(
        { sessionId: SESSION_ID, clientId: CLIENT_ID, text: '> manual md\n\nbody', fallbackWorkingDir: '/repo' },
        deps,
      ),
    ).resolves.toBe(false);
    const args = (deps.saveDraftFallback as unknown as Mock).mock.calls[0];
    expect(args[1]).toEqual({ type: 'doc', text: '> manual md\n\nbody' });
    expect(args).toHaveLength(3);
  });

  it('排队消息非空:在 rewindCommit 之前拦下(EDIT_QUEUE_NOT_EMPTY),整体未发生', async () => {
    // 回归 P1:paused 队列非空时重发会追加到陈旧消息之后,Continue 后重放
    // 顺序反转;必须在回退历史之前整体拒绝,而不是裁完历史再把编辑内容
    // 塞进队尾。
    const { deps } = makeDeps();
    (deps.hasPendingQueue as unknown as Mock).mockReturnValue(true);
    await expect(
      commitEditAndResend(
        { sessionId: SESSION_ID, clientId: CLIENT_ID, text: 'edited', fallbackWorkingDir: '/repo' },
        deps,
      ),
    ).rejects.toMatchObject({ code: 'EDIT_QUEUE_NOT_EMPTY' });
    expect(deps.rewindCommit).not.toHaveBeenCalled();
    expect(deps.dropMessagesFromClientId).not.toHaveBeenCalled();
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it('DB 真值校验:目标不是最新 user 消息时拦下(EDIT_NOT_LAST_MESSAGE),不 rewind', async () => {
    // 回归 bot review(实为数据丢弃级):搜索/深链的中间窗口期,切片最后一条
    // 可能不是会话真实最后一条,若不拦,rewind 会把窗口外更新的轮次一并软删。
    const { deps } = makeDeps();
    (deps.fetchLatestUserMessageClientId as unknown as Mock).mockResolvedValue('msg-newer-99');
    await expect(
      commitEditAndResend(
        { sessionId: SESSION_ID, clientId: CLIENT_ID, text: 'edited', fallbackWorkingDir: '/repo' },
        deps,
      ),
    ).rejects.toMatchObject({ code: 'EDIT_NOT_LAST_MESSAGE' });
    expect(deps.rewindCommit).not.toHaveBeenCalled();
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it('rewindCommit 失败:不裁内存、不重发(整体未发生,调用方保持编辑态)', async () => {
    const { deps } = makeDeps();
    (deps.rewindCommit as unknown as Mock).mockRejectedValueOnce(new Error('SESSION_RUNNING'));
    await expect(
      commitEditAndResend(
        { sessionId: SESSION_ID, clientId: CLIENT_ID, text: 'x', fallbackWorkingDir: '/repo' },
        deps,
      ),
    ).rejects.toThrow('SESSION_RUNNING');
    expect(deps.dropMessagesFromClientId).not.toHaveBeenCalled();
    expect(deps.sendMessage).not.toHaveBeenCalled();
    expect(deps.emitPatch).not.toHaveBeenCalled();
    expect(deps.saveDraftFallback).not.toHaveBeenCalled();
  });
});


describe('fetchLatestUserMessageClientIdViaDb', () => {
  beforeEach(() => { (listMessagesMock as unknown as Mock).mockReset(); (listMessagesMock as unknown as Mock).mockResolvedValue([]); });
  const listMock = listMessagesMock as unknown as Mock;
  const user = (id: string, ts: number) => ({ id: `row-${id}`, clientId: id, role: 'user', createdAt: ts });
  const tool = (id: string, ts: number) => ({ id: `row-${id}`, clientId: id, role: 'tool_use', createdAt: ts });

  it('最新页里有 user 行:取 (createdAt, id) 最大者', async () => {
    listMock.mockResolvedValueOnce([tool('t1', 300), user('u2', 200), user('u3', 250)]);
    await expect(fetchLatestUserMessageClientIdViaDb('s')).resolves.toBe('u3');
  });

  it('工具密集长 turn:最新一页全是非 user 行时向老页翻页,不误判(bot review 回归)', async () => {
    // 第一页:50 行 tool(工具密集 turn 的尾部);第二页才出现真实最后一条 user。
    const page1 = Array.from({ length: 50 }, (_, i) => tool(`t${i}`, 1000 - i));
    const page2 = [tool('t99', 900), user('u-latest', 890), user('u-old', 880)];
    listMock.mockResolvedValueOnce(page1).mockResolvedValueOnce(page2);
    await expect(fetchLatestUserMessageClientIdViaDb('s')).resolves.toBe('u-latest');
    // 第二次调用带 before 游标(第一页最旧行的 id)
    expect(listMock.mock.calls[1][1]).toMatchObject({ before: 'row-t49' });
  });

  it('翻尽所有页都没有 user 行 → null(调用方 fail-closed)', async () => {
    listMock.mockResolvedValueOnce(Array.from({ length: 50 }, (_, i) => tool(`a${i}`, 500 - i)));
    listMock.mockResolvedValueOnce([tool('b1', 10)]); // 不足一页 → 到底了
    await expect(fetchLatestUserMessageClientIdViaDb('s')).resolves.toBeNull();
  });
});

describe('commitEditAndResendWithRunningRetry', () => {
  const OPTS = { sessionId: SESSION_ID, clientId: CLIENT_ID, text: 'x', fallbackWorkingDir: '/repo' };
  const running = () => new ApiError('SESSION_RUNNING', 0, 'turn in flight');

  it('SESSION_RUNNING 重试后成功(stop 尾差场景),sleep 走注入假时钟', async () => {
    const { deps } = makeDeps();
    (deps.rewindCommit as unknown as Mock)
      .mockRejectedValueOnce(running())
      .mockRejectedValueOnce(running());
    const sleeps: number[] = [];
    await commitEditAndResendWithRunningRetry(OPTS, deps, {
      attempts: 4,
      delayMs: 250,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(deps.rewindCommit).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([250, 250]);
    expect(deps.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('重试耗尽仍 SESSION_RUNNING → 抛出,未发生重发', async () => {
    const { deps } = makeDeps();
    (deps.rewindCommit as unknown as Mock).mockRejectedValue(running());
    await expect(
      commitEditAndResendWithRunningRetry(OPTS, deps, { attempts: 2, sleep: async () => {} }),
    ).rejects.toMatchObject({ code: 'SESSION_RUNNING' });
    expect(deps.rewindCommit).toHaveBeenCalledTimes(3); // 首次 + 2 次重试
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it('默认重试预算 ≈ 15s,与 EditBox 停止等待兜底同量级(stopSession 乐观清 isStreaming,慢停止全靠这里扛)', () => {
    const span = RUNNING_RETRY_DEFAULTS.attempts * RUNNING_RETRY_DEFAULTS.delayMs;
    expect(span).toBeGreaterThanOrEqual(14_000);
    expect(span).toBeLessThanOrEqual(16_000);
  });

  it('非 SESSION_RUNNING 错误不重试,原样抛出', async () => {
    const { deps } = makeDeps();
    (deps.rewindCommit as unknown as Mock).mockRejectedValue(
      new ApiError('NO_LIVE_QUERY', 0, 'not active'),
    );
    await expect(
      commitEditAndResendWithRunningRetry(OPTS, deps, { attempts: 4, sleep: async () => {} }),
    ).rejects.toMatchObject({ code: 'NO_LIVE_QUERY' });
    expect(deps.rewindCommit).toHaveBeenCalledTimes(1);
  });
});

describe('意识发送期展开(ghost-summon-card:编辑重发不叠双份指令)', () => {
  it('expandForSend 只作用于发出去的文本;fallback 草稿存用户编辑原文', async () => {
    const { deps } = makeDeps(fakeSession(), { dispatchResult: false });
    deps.expandForSend = vi.fn((text: string) => `${text}\n\n[意识指令] fake-directive`);
    await commitEditAndResend(
      { sessionId: SESSION_ID, clientId: CLIENT_ID, text: '$画图 一只猫', fallbackWorkingDir: '/repo' },
      deps,
    );

    const sendArgs = (deps.sendMessage as unknown as Mock).mock.calls[0];
    expect(sendArgs[1]).toBe('$画图 一只猫\n\n[意识指令] fake-directive');
    // 派发失败 → 草稿兜底必须是未展开原文(草稿重发经 ChatInput 再展开)
    const draftArgs = (deps.saveDraftFallback as unknown as Mock).mock.calls[0];
    expect(draftArgs[1]).toEqual({ type: 'doc', text: '$画图 一只猫' });
  });

  it('未注入 expandForSend(默认实现)在无 electronAPI 环境安全退化为原文', async () => {
    const { deps } = makeDeps();
    await commitEditAndResend(
      { sessionId: SESSION_ID, clientId: CLIENT_ID, text: '$画图 x', fallbackWorkingDir: '/repo' },
      deps,
    );
    const sendArgs = (deps.sendMessage as unknown as Mock).mock.calls[0];
    expect(sendArgs[1]).toBe('$画图 x');
  });
});
