import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  owner: { userId: 'account-a' },
  title: '',
  generate: vi.fn<() => Promise<string | null>>(),
  renamed: (_id: string, _owner: { userId: string } | null) => {},
}));
vi.mock('../../localDb/client/current.js', () => ({ getCurrentDbClientSnapshot: () => h.owner }));
vi.mock('../../localDb/ipc/sessions.js', () => ({
  setOnUserSessionTitleWritten: (notify: typeof h.renamed) => { h.renamed = notify; },
  getOverwritableAutoTitle: async (_id: string, expected: string) =>
    h.title === expected ? { title: h.title, agentKind: 'pi', isDefaultDraftTitle: false } : null,
  persistSessionTitleIfStillDraft: async (_id: string, next: string, expected: string) => {
    if (h.title !== expected) return false;
    h.title = next;
    return true;
  },
}));
vi.mock('../../maker-ipc/title.js', () => ({ generateMakerSessionTitle: h.generate }));
vi.mock('../shared/sessionBroadcast.js', () => ({ broadcastSessionPatched: vi.fn() }));

import { __resetSessionAutoTitleStateForTest, refineCreatedTaskTitle, registerSessionAutoTitleHooks } from '../../maker-ipc/sessionAutoTitle.js';
import { generateAndPersistFbotTitle } from '../shared/fbotTitle.js';

beforeEach(() => {
  h.owner = { userId: 'account-a' };
  h.generate.mockReset();
  h.title = '飞书 · 新任务';
  __resetSessionAutoTitleStateForTest();
  registerSessionAutoTitleHooks();
});

// Unit. A fallback formatter used to request a second completion, and unconditional writes
// could override the user's rename. Exercise the IM entry with just the DB and model replaced.
describe('IM task titles', () => {
  it('uses one completion for the clean subject and keeps the channel when composition falls back', async () => {
    h.generate.mockResolvedValue('修复登录');
    await generateAndPersistFbotTitle('task', '请修复登录失败', '飞书 · ', h.title, async () => null);
    expect(h.title).toBe('飞书 · 修复登录');
    expect(h.generate).toHaveBeenCalledExactlyOnceWith('请修复登录失败', 'pi', 'task');
  });

  it('keeps the first words if the auxiliary model is unavailable', async () => {
    h.generate.mockResolvedValue(null);
    await generateAndPersistFbotTitle('task', '看看登录问题', '飞书 · ', h.title);
    expect(h.title).toBe('飞书 · 看看登录问题');
  });

  it('honors a manual save even when it matches the preview exactly', async () => {
    h.generate.mockImplementation(async () => {
      expect(h.title).toBe('飞书 · 看看登录问题');
      h.renamed('task', h.owner);
      return '修复登录';
    });
    await generateAndPersistFbotTitle('task', '看看登录问题', '飞书 · ', h.title);
    expect(h.title).toBe('飞书 · 看看登录问题');
  });

  it('discards a completion if the signed-in account changes while the model is running', async () => {
    h.generate.mockImplementation(async () => {
      h.owner = { userId: 'account-b' };
      h.title = '飞书 · 新账号的任务';
      return '旧账号的主题';
    });
    await generateAndPersistFbotTitle('task', '旧账号的消息', '飞书 · ', h.title);
    expect(h.title).toBe('飞书 · 新账号的任务');
  });

  it('honors each account’s manual choice for the same Feishu session ID', async () => {
    const id = 'feishu_test_app_test_user';
    const initial = h.title;
    const ownerA = h.owner;
    h.generate.mockResolvedValue('修复登录');
    h.owner = { userId: 'account-b' };
    h.renamed(id, ownerA);
    await generateAndPersistFbotTitle(id, '看看登录问题', '飞书 · ', initial);
    expect(h.title).toBe('飞书 · 修复登录');

    h.owner = { userId: 'account-a' };
    h.title = initial;
    await generateAndPersistFbotTitle(id, '另一个问题', '飞书 · ', initial);
    expect(h.title).toBe(initial);
    expect(h.generate).toHaveBeenCalledOnce();
  });

  it('uses the first actual text after an empty creation and leaves later messages alone', async () => {
    h.generate.mockResolvedValue('登录失败');
    await generateAndPersistFbotTitle('task', '', '飞书 · ', h.title);
    expect(h.generate).not.toHaveBeenCalled();
    await refineCreatedTaskTitle('task', '登录不了');
    await refineCreatedTaskTitle('task', '另一个问题');
    expect(h.title).toBe('飞书 · 登录失败');
    expect(h.generate).toHaveBeenCalledTimes(1);
  });
});
