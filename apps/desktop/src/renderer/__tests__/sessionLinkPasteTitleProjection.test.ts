/**
 * 粘贴会话深链时解析出来的标题,必须在**序列化进消息文本之前**过哨兵投影。
 *
 * 为什么这条洞比其它出口更硬:解析结果会被 serializeSessionChipText 写成
 * `[标题](href)` 进入消息正文,之后对消息侧 SessionLinkChip 来说它就是
 * `explicitLabel`(作者显式写的 label,渲染层理应原样尊重)。所以原始哨兵一旦被
 * 序列化进去就**永久**留在消息里,渲染时的投影救不回来(PR #1031 review P1)。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_DRAFT_SESSION_TITLE } from '@cindy/maker-shared/session-title';

const UNNAMED = '未命名对话';

const sessionGet = vi.fn();
vi.mock('@/lib/sessionService', () => ({
  get: (...args: unknown[]) => sessionGet(...args),
}));

const getMergedRemoteSessions = vi.fn(() => [] as Array<{ id: string; title: string }>);
vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  remoteProjectsStore: {
    getMergedRemoteSessions: () => getMergedRemoteSessions(),
  },
}));

vi.mock('@/i18n', () => ({
  i18n: {
    t: (key: string) => (key === 'ccAgent.common.unnamedSession' ? UNNAMED : key),
  },
}));

import { resolvePastedSessionTitle } from '../components/new-chat/sessionLinkPaste';

const SESSION_ID = 'ee59672a-5591-48a7-a44d-aa97e3808c64';

beforeEach(() => {
  vi.clearAllMocks();
  getMergedRemoteSessions.mockReturnValue([]);
});

describe('resolvePastedSessionTitle — 哨兵投影', () => {
  it('本地库返回哨兵 → 解析结果是本地化兜底文案,不是内部英文串', async () => {
    sessionGet.mockResolvedValue({ title: DEFAULT_DRAFT_SESSION_TITLE });

    await expect(resolvePastedSessionTitle(SESSION_ID)).resolves.toBe(UNNAMED);
  });

  it('普通标题原样返回', async () => {
    sessionGet.mockResolvedValue({ title: '修复白屏' });

    await expect(resolvePastedSessionTitle(SESSION_ID)).resolves.toBe('修复白屏');
  });

  it('本地库没有、走远程镜像降级时同样投影', async () => {
    // 两条降级分支都要过投影 —— 只改一条就会在另一条上继续泄漏哨兵。
    sessionGet.mockRejectedValue(new Error('NOT_FOUND'));
    getMergedRemoteSessions.mockReturnValue([
      { id: SESSION_ID, title: DEFAULT_DRAFT_SESSION_TITLE },
    ]);

    await expect(resolvePastedSessionTitle(SESSION_ID)).resolves.toBe(UNNAMED);
  });

  it('远程镜像也查不到 → 保持 null(chip 停在短 ID,序列化走裸 href)', async () => {
    sessionGet.mockRejectedValue(new Error('NOT_FOUND'));

    await expect(resolvePastedSessionTitle(SESSION_ID)).resolves.toBeNull();
  });
});
