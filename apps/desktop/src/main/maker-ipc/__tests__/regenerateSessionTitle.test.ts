/**
 * regenerateMakerSessionTitle 单测——重命名输入框 Magic 按钮的 main 侧业务体。
 * 通过 RegenerateTitleDeps 注入内存实现,不触电 electron / DB / LLM。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: vi.fn() }));
vi.mock('../../localDb/latestMessageText.js', () => ({
  latestMessage: vi.fn(),
  latestMessageText: vi.fn(),
  regenerateTitleMaterial: vi.fn(),
}));
vi.mock('../../maker-host/createDesktopProviderService.js', () => ({
  getDesktopProviderService: vi.fn(),
}));
vi.mock('../../maker-host/title-one-shot.js', () => ({
  generateTitleViaProvider: vi.fn(),
}));

import {
  generateMakerSessionTitle,
  regenerateMakerSessionTitle,
  type RegenerateTitleDeps,
} from '../title.js';
import { generateTitleViaProvider } from '../../maker-host/title-one-shot.js';
import type { RegenerateTitleMaterial } from '../../localDb/latestMessageText.js';

/** 默认素材:短会话——最近窗口已覆盖会话开头(开场消息就是窗口第一条)。 */
function makeDeps(overrides: Partial<RegenerateTitleDeps> = {}): RegenerateTitleDeps {
  const material: RegenerateTitleMaterial = {
    opening: { text: '帮我排查登录失败', createdAt: 1000, rowid: 1 },
    recent: [
      { role: 'user', text: '帮我排查登录失败', createdAt: 1000, rowid: 1 },
      { role: 'assistant', text: '已定位到 token 过期问题', createdAt: 2000, rowid: 2 },
    ],
  };
  return {
    readSessionAgentKind: vi.fn(async () => 'claude-code' as const),
    collectMaterial: vi.fn(async () => material),
    generateTitle: vi.fn(async () => '登录失败排查'),
    ...overrides,
  };
}

function promptOf(deps: RegenerateTitleDeps): string {
  return (deps.generateTitle as ReturnType<typeof vi.fn>).mock.calls[0][2] as string;
}

describe('regenerateMakerSessionTitle', () => {
  it('短会话:transcript 按时间正序包含全部素材,开场已在窗口内不重复给出', async () => {
    const deps = makeDeps();

    const title = await regenerateMakerSessionTitle('s1', deps);

    expect(title).toBe('登录失败排查');
    expect(deps.collectMaterial).toHaveBeenCalledWith('s1', expect.any(Number));
    const [sessionId, agentKind] = (deps.generateTitle as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, string, string];
    expect(sessionId).toBe('s1');
    expect(agentKind).toBe('claude-code');
    const prompt = promptOf(deps);
    expect(prompt).toContain('用户: 帮我排查登录失败');
    expect(prompt).toContain('助手: 已定位到 token 过期问题');
    // 开场消息 createdAt(1000) 已在窗口内 → 不出现单独的"对话开场"段
    expect(prompt).not.toContain('对话开场');
    // transcript 时间正序:用户消息在助手回复之前
    expect(prompt.indexOf('用户: 帮我排查登录失败')).toBeLessThan(
      prompt.indexOf('助手: 已定位到 token 过期问题'),
    );
  });

  it('长会话:开场消息早于最近窗口 → prompt 单独给出"对话开场"段', async () => {
    const deps = makeDeps({
      collectMaterial: vi.fn(async () => ({
        opening: { text: '帮我做一个跨平台的登录模块', createdAt: 1000, rowid: 1 },
        recent: [
          { role: 'user' as const, text: '继续', createdAt: 9000, rowid: 41 },
          { role: 'assistant' as const, text: '已完成 Windows 侧适配', createdAt: 9500, rowid: 42 },
        ],
      })),
    });

    await regenerateMakerSessionTitle('s1', deps);

    const prompt = promptOf(deps);
    expect(prompt).toContain('对话开场: 帮我做一个跨平台的登录模块');
    expect(prompt).toContain('用户: 继续');
    expect(prompt).toContain('助手: 已完成 Windows 侧适配');
    // 短追问兜底指令始终存在
    expect(prompt).toContain('简短确认');
  });

  it('createdAt 全为 null 时仍按 rowid 判定:开场行在窗口内 → 不重复给出', async () => {
    const deps = makeDeps({
      collectMaterial: vi.fn(async () => ({
        opening: { text: '帮我排查登录失败', createdAt: null, rowid: 1 },
        recent: [
          { role: 'user' as const, text: '帮我排查登录失败', createdAt: null, rowid: 1 },
          { role: 'assistant' as const, text: '已定位到 token 过期问题', createdAt: null, rowid: 2 },
        ],
      })),
    });

    await regenerateMakerSessionTitle('s1', deps);

    expect(promptOf(deps)).not.toContain('对话开场');
  });

  it('同毫秒批量落库把开场行挤出窗口(时间戳与窗口首条相同但 rowid 不在窗口)→ 开场段仍单独给出', async () => {
    const deps = makeDeps({
      collectMaterial: vi.fn(async () => ({
        opening: { text: '帮我梳理导入的聊天记录', createdAt: 1000, rowid: 1 },
        recent: [
          { role: 'user' as const, text: '第 9 条同毫秒消息', createdAt: 1000, rowid: 9 },
          { role: 'assistant' as const, text: '第 10 条同毫秒消息', createdAt: 1000, rowid: 10 },
        ],
      })),
    });

    await regenerateMakerSessionTitle('s1', deps);

    expect(promptOf(deps)).toContain('对话开场: 帮我梳理导入的聊天记录');
  });

  it('超长消息按角色截断:用户 300 字符、助手 400 字符、开场 300 字符', async () => {
    const deps = makeDeps({
      collectMaterial: vi.fn(async () => ({
        opening: { text: 'o'.repeat(500), createdAt: 1000, rowid: 1 },
        recent: [
          { role: 'user' as const, text: 'u'.repeat(500), createdAt: 9000, rowid: 41 },
          { role: 'assistant' as const, text: 'a'.repeat(700), createdAt: 9500, rowid: 42 },
        ],
      })),
    });

    await regenerateMakerSessionTitle('s1', deps);

    const prompt = promptOf(deps);
    expect(prompt).toContain(`对话开场: ${'o'.repeat(300)}\n`);
    expect(prompt).not.toContain('o'.repeat(301));
    expect(prompt).toContain(`用户: ${'u'.repeat(300)}\n`);
    expect(prompt).not.toContain('u'.repeat(301));
    expect(prompt).toContain(`助手: ${'a'.repeat(400)}`);
    expect(prompt).not.toContain('a'.repeat(401));
  });

  it('只有助手消息(用户消息被过滤/缺失)→ 仍能用窗口素材生成', async () => {
    const deps = makeDeps({
      collectMaterial: vi.fn(async () => ({
        opening: { text: '', createdAt: null, rowid: null },
        recent: [{ role: 'assistant' as const, text: '定时任务已执行完成', createdAt: 2000, rowid: 2 }],
      })),
    });

    expect(await regenerateMakerSessionTitle('s1', deps)).toBe('登录失败排查');
    const prompt = promptOf(deps);
    expect(prompt).toContain('助手: 定时任务已执行完成');
    expect(prompt).not.toContain('对话开场');
  });

  it('空 sessionId / 会话不存在 → null 且不发起生成', async () => {
    const deps = makeDeps({ readSessionAgentKind: vi.fn(async () => null) });

    expect(await regenerateMakerSessionTitle('', deps)).toBeNull();
    expect(await regenerateMakerSessionTitle('missing', deps)).toBeNull();
    expect(deps.generateTitle).not.toHaveBeenCalled();
  });

  it('会话没有任何对话素材(空草稿)→ null 且不发起生成', async () => {
    const deps = makeDeps({
      collectMaterial: vi.fn(async () => ({
        opening: { text: '', createdAt: null, rowid: null },
        recent: [],
      })),
    });

    expect(await regenerateMakerSessionTitle('s1', deps)).toBeNull();
    expect(deps.generateTitle).not.toHaveBeenCalled();
  });

  it('生成结果为空 / 全空白 → null;两侧空白被 trim', async () => {
    expect(
      await regenerateMakerSessionTitle('s1', makeDeps({ generateTitle: vi.fn(async () => null) })),
    ).toBeNull();
    expect(
      await regenerateMakerSessionTitle('s1', makeDeps({ generateTitle: vi.fn(async () => '   ') })),
    ).toBeNull();
    expect(
      await regenerateMakerSessionTitle(
        's1',
        makeDeps({ generateTitle: vi.fn(async () => '  登录失败排查  ') }),
      ),
    ).toBe('登录失败排查');
  });

  it('依赖抛错被吞并返回 null(与 generate-title 同一失败口径)', async () => {
    const deps = makeDeps({
      collectMaterial: vi.fn(async () => {
        throw new Error('db not ready');
      }),
    });

    expect(await regenerateMakerSessionTitle('s1', deps)).toBeNull();
  });
});

describe('generateMakerSessionTitle', () => {
  it('空/全空白消息(如仅图片附件的首条输入)→ null 且不发标题请求', async () => {
    vi.mocked(generateTitleViaProvider).mockClear();

    expect(await generateMakerSessionTitle('', 'claude-code', 's1')).toBeNull();
    expect(await generateMakerSessionTitle('   \n  ', 'codex', 's1')).toBeNull();
    expect(generateTitleViaProvider).not.toHaveBeenCalled();
  });

  it('非空消息走 provider oneShot,prompt 使用 trim 后的消息', async () => {
    vi.mocked(generateTitleViaProvider).mockClear();
    vi.mocked(generateTitleViaProvider).mockResolvedValueOnce('登录失败排查');

    expect(await generateMakerSessionTitle('  帮我排查登录失败  ', 'claude-code', 's1')).toBe(
      '登录失败排查',
    );
    const [request] = vi.mocked(generateTitleViaProvider).mock.calls[0] as [
      { sessionId: string; agentKind: string; prompt: string },
    ];
    expect(request.sessionId).toBe('s1');
    expect(request.agentKind).toBe('claude-code');
    expect(request.prompt).toContain('帮我排查登录失败');
    expect(request.prompt).not.toContain('  帮我排查登录失败');
  });
});
