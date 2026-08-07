/**
 * makerChatStoreAutoName.test.ts
 * ---------------------------------------------------------------------------
 * renderer 侧自动起名的职责边界(权威逻辑在 main 的 maker:auto-title):
 *   - 本机会话:把素材与 isUserText 透传给 main,**不写 DB**;标题仍是哨兵时额外在
 *     store 里做一次乐观预览(不等 IPC 往返 + 广播),与远程分支对称;
 *   - 远程会话:不发 IPC,只在投影层登记即时标题预览;
 *   - main 返回 done=true 才缓存「无需再起名」,瞬时失败必须可重试。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/messageService', () => ({
  list: vi.fn(async () => []),
  create: vi.fn(async () => ({}) as unknown),
  updateContent: vi.fn(async () => ({}) as unknown),
  dismissError: vi.fn(async () => ({}) as unknown),
}));

vi.mock('@/lib/sessionService', () => ({
  get: vi.fn(async () => ({ agentKind: 'cc', title: 'New Maker' })),
  update: vi.fn(async () => ({})),
  touchUserSend: vi.fn(async () => ({})),
}));

const emitAutoTitlePreview = vi.fn();
const emitAutoTitlePreviewCleared = vi.fn();
vi.mock('@/lib/sessionsBus', () => ({
  emitPatch: vi.fn(),
  emitAutoTitlePreview: (id: string, title: string) => emitAutoTitlePreview(id, title),
  emitAutoTitlePreviewCleared: (id: string) => emitAutoTitlePreviewCleared(id),
}));
vi.mock('@/lib/userPromptStore', () => ({ getUserPrompt: () => '' }));
vi.mock('@/lib/memorySettingsStore', () => ({ getMakerMemoryEnabled: () => true }));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('@/lib/composerDraftStore', () => ({
  saveDraft: vi.fn(),
  setRemoteOptimisticAttachmentUrls: vi.fn(),
  plainTextToTiptapDoc: (s: string) => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: s }] }],
  }),
}));

import { makerChatStore } from '@/lib/makerChatStore';
import * as sessionService from '@/lib/sessionService';
import type { Session } from '@/lib/ccAgent.types';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import {
  __resetStickySessionOriginForTest,
  getStickySessionDeviceId,
} from '@/features/device-link/stickySessionOrigin';

const SESSION_ID = 'auto-name-session';

const autoTitle = vi.fn(async () => ({ applied: true, done: true }));

const flushPromises = async () => {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
};

beforeEach(() => {
  vi.clearAllMocks();
  autoTitle.mockResolvedValue({ applied: true, done: true });
  makerChatStore.__resetAutoNameStateForTest();
  remoteProjectsStore.clear();
  remoteProjectsStore.__resetPinnedOriginsForTest();
  __resetStickySessionOriginForTest();
  remoteProjectsStore.__resetPendingTitlePreviewForTest();
  const w = globalThis as unknown as { window: Record<string, unknown> };
  w.window = { electronAPI: { maker: { autoTitle } } };
});

describe('makerChatStore auto-name — 本机会话', () => {
  it('把素材原样交给 main,不自己读写会话标题', async () => {
    makerChatStore.autoNameSession(SESSION_ID, '帮我排查登录失败', 'claude-code');
    await flushPromises();

    expect(autoTitle).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      text: '帮我排查登录失败',
      agentKind: 'claude-code',
      isUserText: true,
    });
    // 标题落库与广播都归 main —— renderer 不再直接写 DB。
    expect(sessionService.update).not.toHaveBeenCalled();
    expect(sessionService.get).not.toHaveBeenCalled();
  });

  it('发出即时标题预览:与 main 随后写入的占位是同一个串,且不碰 DB', async () => {
    makerChatStore.autoNameSession(SESSION_ID, '  帮我\n排查  登录失败 ', 'claude-code');
    await flushPromises();

    // 共用 normalizeAutoTitle → 权威标题回流时不跳变。
    expect(emitAutoTitlePreview).toHaveBeenCalledWith(SESSION_ID, '帮我 排查 登录失败');
    // 权威标题仍归 main:renderer 不写 DB。
    expect(sessionService.update).not.toHaveBeenCalled();
    // 「标题是否仍是哨兵」由 sessionsStore 在订阅处裁决,不在这里读会话行。
    expect(sessionService.get).not.toHaveBeenCalled();
  });

  it('预览抛错既不打断起名 IPC,也不冒泡出去打断发送主流程', async () => {
    // 预览纯属锦上添花:bus / 订阅方出任何问题都不能让 sendMessageCore 的入队被
    // 异常打断(与本函数其余副作用同一条契约)。
    emitAutoTitlePreview.mockImplementationOnce(() => {
      throw new Error('bus down');
    });

    expect(() =>
      makerChatStore.autoNameSession(SESSION_ID, '第一句话', 'claude-code'),
    ).not.toThrow();
    await flushPromises();

    expect(autoTitle).toHaveBeenCalled();
  });

  it('素材为空时既不发 IPC 也不发预览', async () => {
    makerChatStore.autoNameSession(SESSION_ID, '   ', 'claude-code');
    await flushPromises();

    expect(emitAutoTitlePreview).not.toHaveBeenCalled();
  });

  it('合成描述带上 isUserText=false,由 main 决定不调标题模型', async () => {
    makerChatStore.autoNameSession(SESSION_ID, '设计稿-v3.png', 'codex', false);
    await flushPromises();

    expect(autoTitle).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      text: '设计稿-v3.png',
      agentKind: 'codex',
      isUserText: false,
    });
  });

  it('连描述都合成不出来(空素材)时不发 IPC', async () => {
    makerChatStore.autoNameSession(SESSION_ID, '  \n  ', 'claude-code');
    await flushPromises();

    expect(autoTitle).not.toHaveBeenCalled();
  });

  it('main 返回 done=true 后不再为该会话发 IPC', async () => {
    makerChatStore.autoNameSession(SESSION_ID, '第一条', 'claude-code');
    await flushPromises();
    autoTitle.mockClear();

    makerChatStore.__autoNameUnnamedSessionForTest(
      SESSION_ID,
      { text: '第二条', isUserText: true },
      'claude-code',
    );
    await flushPromises();

    expect(autoTitle).not.toHaveBeenCalled();
  });

  it('done=false(还在等用户打字)时后续消息继续尝试', async () => {
    autoTitle.mockResolvedValue({ applied: true, done: false });

    makerChatStore.autoNameSession(SESSION_ID, '设计稿-v3.png', 'claude-code', false);
    await flushPromises();
    autoTitle.mockClear();

    makerChatStore.__autoNameUnnamedSessionForTest(
      SESSION_ID,
      { text: '这个报错怎么修', isUserText: true },
      'claude-code',
    );
    await flushPromises();

    expect(autoTitle).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      text: '这个报错怎么修',
      agentKind: 'claude-code',
      isUserText: true,
    });
  });

  it('IPC 抛错不把会话永久钉住 —— 下一条消息仍会重试', async () => {
    autoTitle.mockRejectedValueOnce(new Error('ipc failed'));

    makerChatStore.autoNameSession(SESSION_ID, '第一条', 'claude-code');
    await flushPromises();
    autoTitle.mockClear();
    autoTitle.mockResolvedValue({ applied: true, done: true });

    makerChatStore.__autoNameUnnamedSessionForTest(
      SESSION_ID,
      { text: '第二条', isUserText: true },
      'claude-code',
    );
    await flushPromises();

    expect(autoTitle).toHaveBeenCalledTimes(1);
  });

  it('起名失败 → 撤回预览,不让会话永久顶着库里不存在的标题', async () => {
    // 预览是「马上会有权威标题回流」的赌注;赌输了必须还原,否则叠加层永不失效。
    autoTitle.mockRejectedValueOnce(new Error('ipc failed'));

    makerChatStore.autoNameSession(SESSION_ID, '帮我排查登录失败', 'claude-code');
    await flushPromises();

    expect(emitAutoTitlePreview).toHaveBeenCalledWith(SESSION_ID, '帮我排查登录失败');
    expect(emitAutoTitlePreviewCleared).toHaveBeenCalledWith(SESSION_ID);
  });

  it('起名成功时不撤回(否则真实标题会被打回哨兵)', async () => {
    makerChatStore.autoNameSession(SESSION_ID, '帮我排查登录失败', 'claude-code');
    await flushPromises();

    expect(emitAutoTitlePreviewCleared).not.toHaveBeenCalled();
  });

  it('正常 resolve 但 applied=false(资格读失败 / 两段都没写进去)同样撤回', async () => {
    // runSessionAutoTitle 在这类瞬时失败下是**正常 resolve** 的,只挂 .catch 会整类漏掉。
    autoTitle.mockResolvedValue({ applied: false, done: false });

    makerChatStore.autoNameSession(SESSION_ID, '帮我排查登录失败', 'claude-code');
    await flushPromises();

    expect(emitAutoTitlePreviewCleared).toHaveBeenCalledWith(SESSION_ID);
  });

  it('applied=false + done=true(用户已手动改过名)也撤回,叠加层不许盖着用户标题', async () => {
    autoTitle.mockResolvedValue({ applied: false, done: true });

    makerChatStore.autoNameSession(SESSION_ID, '帮我排查登录失败', 'claude-code');
    await flushPromises();

    expect(emitAutoTitlePreviewCleared).toHaveBeenCalledWith(SESSION_ID);
  });

  it('applied=true + done=false(占位已落库、智能标题还在路上)不撤回', async () => {
    autoTitle.mockResolvedValue({ applied: true, done: false });

    makerChatStore.autoNameSession(SESSION_ID, '帮我排查登录失败', 'claude-code');
    await flushPromises();

    expect(emitAutoTitlePreviewCleared).not.toHaveBeenCalled();
  });

  it('IPC 同步抛错(桥接缺失)同样撤回预览', async () => {
    const w = globalThis as unknown as { window: Record<string, unknown> };
    w.window = {
      electronAPI: {
        maker: {
          autoTitle: () => {
            throw new Error('bridge missing');
          },
        },
      },
    };

    makerChatStore.autoNameSession(SESSION_ID, '帮我排查登录失败', 'claude-code');
    await flushPromises();

    expect(emitAutoTitlePreviewCleared).toHaveBeenCalledWith(SESSION_ID);
  });

  it('较早那次尝试失败时不撤回预览 —— 更晚的尝试仍在飞', async () => {
    // 用户在首次 auto-title 返回前连发两条:两次都通过 autoNameSettled 检查各起一次尝试。
    // 早的那次失败若按 sessionId 直接撤回,会把仍在飞的那次的预览一起revoke,标题白闪
    // 一次「未命名任务」。
    let failFirst: (v: { applied: boolean; done: boolean }) => void = () => {};
    autoTitle.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          failFirst = resolve;
        }),
    );
    autoTitle.mockImplementationOnce(
      () =>
        new Promise(() => {
          /* 第二次一直在飞 */
        }),
    );

    makerChatStore.autoNameSession(SESSION_ID, '第一句', 'claude-code');
    makerChatStore.autoNameSession(SESSION_ID, '第二句', 'claude-code');
    await flushPromises();

    // 早的那次失败(正常 resolve 但什么都没写)。
    failFirst({ applied: false, done: false });
    await flushPromises();

    expect(emitAutoTitlePreviewCleared).not.toHaveBeenCalled();
  });

  it('最后一次尝试失败时照常撤回', async () => {
    // 与上一条互为对照:轮次号相等 → 预览没有别的主人,该撤回。
    autoTitle.mockResolvedValue({ applied: false, done: false });

    makerChatStore.autoNameSession(SESSION_ID, '第一句', 'claude-code');
    await flushPromises();
    makerChatStore.autoNameSession(SESSION_ID, '第二句', 'claude-code');
    await flushPromises();

    expect(emitAutoTitlePreviewCleared).toHaveBeenCalledWith(SESSION_ID);
  });

  it('后续消息不是用户文字(纯附件 / 纯 @mention)时不补起名', async () => {
    // 合成描述不该把已有占位换成另一个文件名,更不该被送进标题模型。
    makerChatStore.__autoNameUnnamedSessionForTest(SESSION_ID, null, 'claude-code');
    makerChatStore.__autoNameUnnamedSessionForTest(
      SESSION_ID,
      { text: '设计稿-v3.png', isUserText: false },
      'claude-code',
    );
    await flushPromises();

    expect(autoTitle).not.toHaveBeenCalled();
  });

  it('用「插话」写下第一句话时同样补起名', async () => {
    // 首条是纯附件的会话标题此时是合成占位;用户完全可能趁这一轮还在跑就用
    // 插话写下第一句话。只认普通入队的话,标题会一直停在附件名上(review P1)。
    const steer = vi.fn(async () => true);
    const w = globalThis as unknown as { window: Record<string, unknown> };
    w.window = { electronAPI: { maker: { autoTitle, input: { steer } } } };

    await makerChatStore.steerMessage(
      SESSION_ID,
      '这个报错怎么修',
      'claude-opus-4-7',
      'medium',
      'default',
      '/tmp/wd',
    );
    await flushPromises();

    expect(steer).toHaveBeenCalled();
    expect(autoTitle).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      text: '这个报错怎么修',
      agentKind: 'claude-code',
      isUserText: true,
    });
  });

  it('插话只带附件时不补起名(不把已有占位换成另一个文件名)', async () => {
    const steer = vi.fn(async () => true);
    const w = globalThis as unknown as { window: Record<string, unknown> };
    w.window = { electronAPI: { maker: { autoTitle, input: { steer } } } };

    await makerChatStore.steerMessage(
      SESSION_ID,
      '',
      'claude-opus-4-7',
      'medium',
      'default',
      '/tmp/wd',
      [
        {
          id: 'f1',
          name: '设计稿-v3.png',
          path: '/tmp/设计稿-v3.png',
          ext: '.png',
          size: 1,
          category: 'image',
          mimeType: 'image/png',
        },
      ],
    );
    await flushPromises();

    expect(steer).toHaveBeenCalled();
    expect(autoTitle).not.toHaveBeenCalled();
  });

  it('插话被拒(在飞 steer / Stop 边界 / 输入锁)时不改名', async () => {
    // 被拒的文本从未被受理,拿它改掉默认名 / 合成占位 / fork 占位就是凭空改名。
    const steer = vi.fn(async () => false);
    const getProjection = vi.fn(async () => ({ pendingQueue: [] }));
    const w = globalThis as unknown as { window: Record<string, unknown> };
    w.window = { electronAPI: { maker: { autoTitle, input: { steer, getProjection } } } };

    await makerChatStore.steerMessage(
      SESSION_ID,
      '这个报错怎么修',
      'claude-opus-4-7',
      'medium',
      'default',
      '/tmp/wd',
    );
    await flushPromises();

    expect(steer).toHaveBeenCalled();
    expect(autoTitle).not.toHaveBeenCalled();
  });

  it('插话投递结果不确定但已物化进队列时,照常补起名', async () => {
    // steer 返回 false 但文本被 coordinator 物化进暂停队列 —— 这条输入已被主端接管、
    // 日后会派发,与受理同等。不起名的话,纯附件/fork 之后的第一句话恰好在这条
    // 不确定路径上不改名(review P1)。
    const steer = vi.fn(async () => false);
    const getProjection = vi.fn(async () => ({
      pendingQueue: [{ clientId: capturedClientId }],
    }));
    let capturedClientId = '';
    const w = globalThis as unknown as { window: Record<string, unknown> };
    w.window = {
      electronAPI: {
        maker: {
          autoTitle,
          input: {
            steer: vi.fn(async (_sid: string, queued: { clientId: string }) => {
              capturedClientId = queued.clientId;
              return steer();
            }),
            getProjection,
          },
        },
      },
    };

    await makerChatStore.steerMessage(
      SESSION_ID,
      '这个报错怎么修',
      'claude-opus-4-7',
      'medium',
      'default',
      '/tmp/wd',
    );
    await flushPromises();

    expect(autoTitle).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      text: '这个报错怎么修',
      agentKind: 'claude-code',
      isUserText: true,
    });
  });

  it('起名对发送主流程零副作用:桥接缺失或同步抛错都不得向上冒泡', () => {
    // 老版本 preload 没有 autoTitle 时,同步调用会 TypeError —— 起名是
    // fire-and-forget,异常若冒回 sendMessageCore 会打断消息入队。
    const w = globalThis as unknown as { window: Record<string, unknown> };
    w.window = { electronAPI: { maker: {} } };
    expect(() =>
      makerChatStore.autoNameSession(SESSION_ID, '帮我排查登录失败', 'claude-code'),
    ).not.toThrow();

    autoTitle.mockImplementationOnce(() => {
      throw new Error('bridge exploded');
    });
    w.window = { electronAPI: { maker: { autoTitle } } };
    expect(() =>
      makerChatStore.autoNameSession(SESSION_ID, '帮我排查登录失败', 'claude-code'),
    ).not.toThrow();
  });
});

describe('makerChatStore auto-name — device-link 远程会话', () => {
  beforeEach(() => {
    remoteProjectsStore.setDeviceSessions('dev-auto', 'Mac', [{ id: SESSION_ID } as Session]);
    expect(getStickySessionDeviceId(SESSION_ID)).toBe('dev-auto');
  });

  it('不发起名 IPC(权威标题由被控端写),只登记投影层预览', async () => {
    makerChatStore.autoNameSession(SESSION_ID, '帮我排查登录失败', 'claude-code');
    await flushPromises();

    expect(autoTitle).not.toHaveBeenCalled();
    // 远程会话的行不在本机 DB 里,读它只会抛错 —— 必须短路掉。
    expect(sessionService.get).not.toHaveBeenCalled();
  });

  it('预览串与 main 的归一化同款:折叠空白 + trim + 截断 40 字', async () => {
    const setPreview = vi.spyOn(remoteProjectsStore, 'setPendingTitlePreview');

    makerChatStore.autoNameSession(SESSION_ID, `\n\n${' '.repeat(50)}real message text`, 'codex');
    await flushPromises();

    expect(setPreview).toHaveBeenCalledWith(SESSION_ID, 'real message text', true);
    setPreview.mockRestore();
  });

  it('后续消息也走预览而不是本机 DB(补起名路径同样短路)', async () => {
    const setPreview = vi.spyOn(remoteProjectsStore, 'setPendingTitlePreview');

    makerChatStore.__autoNameUnnamedSessionForTest(
      SESSION_ID,
      { text: '这个报错怎么修', isUserText: true },
      'codex',
    );
    await flushPromises();

    expect(setPreview).toHaveBeenCalledWith(SESSION_ID, '这个报错怎么修', true);
    expect(autoTitle).not.toHaveBeenCalled();
    expect(sessionService.get).not.toHaveBeenCalled();
    setPreview.mockRestore();
  });

  it('mirror 清空后仍沿用最后已知设备,不回退本机起名 IPC', async () => {
    remoteProjectsStore.clear();
    const setPreview = vi.spyOn(remoteProjectsStore, 'setPendingTitlePreview');

    makerChatStore.autoNameSession(SESSION_ID, '断线期间的第一句话', 'codex');
    await flushPromises();

    expect(setPreview).toHaveBeenCalledWith(SESSION_ID, '断线期间的第一句话', true);
    expect(autoTitle).not.toHaveBeenCalled();
    setPreview.mockRestore();
  });
});
