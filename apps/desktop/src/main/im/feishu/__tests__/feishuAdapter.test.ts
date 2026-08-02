/**
 * 飞书 adapter characterization test — 钉死共享编排层参数化后 feishu 渠道的
 * 关键外部契约, 防止重构 / 加渠道时静默漂移:
 *   - session id 格式 `feishu_{botAppId}_{openId}`(决定老用户能否续上历史会话)
 *   - sessions 表渠道专属列(feishuBotAppId / feishuOpenId)与 source='feishu'
 *   - vendorOptions { feishuChatId, source:'feishu' }(决定 cindy_feishu_bot
 *     MCP 注入, 见 lizi-mcps providers.ts isEnabled 门控)
 *   - 默认 title / ack emoji
 */
import { describe, expect, it, vi } from 'vitest';

import os from 'node:os';
import path from 'node:path';

const scopeMocks = vi.hoisted(() => ({
  owner: 'cloud-a',
  root: '',
  join: null as unknown as (...parts: string[]) => string,
  claimLegacy: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => path.join(os.tmpdir(), 'xdt-feishu-adapter-test')),
  },
}));

vi.mock('../../ownerScopedStorage', () => ({
  ownerScopedImUserDataPath: (...parts: string[]) =>
    scopeMocks.join(scopeMocks.root, 'owners', scopeMocks.owner, ...parts),
  claimLegacyImPath: scopeMocks.claimLegacy,
}));

import type { FeishuIM } from '@cindy/im';
import { buildFeishuAdapter } from '../adapter';

const getService = vi.fn<() => 'feishu' | 'lark'>(() => 'feishu');
const fakeIm = { getService } as unknown as FeishuIM;
const CONFIG = {
  agentKind: 'claude-code' as const,
  defaultModel: 'claude-opus-4-7',
  defaultPermissionMode: 'auto' as const,
  effortOverrides: { 'claude-opus-4-7': 'xhigh' as const },
};

describe('feishu ImChannelAdapter characterization', () => {
  const adapter = buildFeishuAdapter(fakeIm, CONFIG);
  scopeMocks.root = path.join(os.tmpdir(), 'xdt-feishu-adapter-test');
  scopeMocks.join = path.join;

  it('channel / source 恒为 feishu', () => {
    expect(adapter.channel).toBe('feishu');
    expect(adapter.sessions.source).toBe('feishu');
  });

  it('session id 格式 feishu_{botAppId}_{openId} — 跨重启稳定, 老用户续上历史', () => {
    expect(adapter.sessions.sessionIdFor('cli_abc', 'ou_xyz')).toBe('feishu_cli_abc_ou_xyz');
  });

  it('渠道专属插入列为 feishuBotAppId / feishuOpenId', () => {
    expect(adapter.sessions.extraInsertColumns('cli_abc', 'ou_xyz')).toEqual({
      feishuBotAppId: 'cli_abc',
      feishuOpenId: 'ou_xyz',
    });
  });

  it('vendorOptions 注入 feishuChatId + source=feishu(cindy_feishu_bot MCP 门控)', () => {
    expect(adapter.buildVendorOptions('ou_xyz')).toEqual({
      feishuChatId: 'ou_xyz',
      source: 'feishu',
    });
  });

  it('默认 title 为 [飞书·DM] {openId 后 6 位}; ack emoji 为 SMUG', () => {
    expect(adapter.sessions.defaultTitle('ou_1234567890')).toBe('[飞书·DM] 567890');
    expect(adapter.processingEmoji).toBe('SMUG');
  });

  it('会话落「对话」分组(workspaceKind=dialogue) + oneshot 起名前缀 [飞书·DM]', () => {
    expect(adapter.sessions.workspaceKind).toBe('dialogue');
    expect(adapter.sessions.generatedTitlePrefix).toBeTypeOf('function');
    expect((adapter.sessions.generatedTitlePrefix as () => string)()).toBe('[飞书·DM] ');
  });

  it('Lark 凭据使用独立的 Lark 会话标题', () => {
    getService.mockReturnValueOnce('lark');
    expect(adapter.sessions.defaultTitle('ou_1234567890')).toBe('[Lark·DM] 567890');
    getService.mockReturnValueOnce('lark');
    expect((adapter.sessions.generatedTitlePrefix as () => string)()).toBe('[Lark·DM] ');
  });

  it('workingDir = userData/im-working-dir/{botAppId}(同 bot 共享)', () => {
    const dir = adapter.sessions.ensureWorkingDir('cli_abc');
    expect(dir).toBe(
      path.join(
        os.tmpdir(),
        'xdt-feishu-adapter-test',
        'owners',
        'cloud-a',
        'im-working-dir',
        'cli_abc',
      ),
    );
    expect(scopeMocks.claimLegacy).toHaveBeenCalledWith(
      path.join(os.tmpdir(), 'xdt-feishu-adapter-test', 'im-working-dir', 'cli_abc'),
      dir,
    );
  });
});
