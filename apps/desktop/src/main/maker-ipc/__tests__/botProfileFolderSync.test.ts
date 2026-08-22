/**
 * 文件 → 冻结快照的对账。
 *
 * 最要紧的一条是**不能无限派生**:文件和快照在两边的形状不一样(用户画像在数据库
 * 里躺在 config 里,在磁盘上是独立的 USER.md),比对时没拉回同一个形状的话,每次
 * 对账都判成「变了」,伙伴的版本号会一路涨上去,每开一个任务就换一次版本。
 */

import { describe, expect, it, vi } from 'vitest';

import type { BotProfileFolderContent } from '../botProfileFolder';
import {
  botProfileFolderMatchesSnapshot,
  syncBotProfileFromFolder,
  type BotProfileSnapshot,
} from '../botProfileFolderSync';

function folder(overrides: Partial<BotProfileFolderContent> = {}): BotProfileFolderContent {
  return {
    identitySource: '你是纸老虎，一个爱做菜的厨子。',
    userContextSource: 'Chris 住在上海。',
    systemPromptOverride: '',
    config: { model: 'claude-sonnet-4-6', harness: 'claude' },
    todo: [],
    knowledge: [],
    preferences: [],
    ...overrides,
  };
}

function snapshot(overrides: Partial<BotProfileSnapshot> = {}): BotProfileSnapshot {
  return {
    identitySource: '你是纸老虎，一个爱做菜的厨子。',
    config: {
      model: 'claude-sonnet-4-6',
      harness: 'claude',
      userContextSource: 'Chris 住在上海。',
    },
    currentVersion: 3,
    ...overrides,
  };
}

function harness(over: { folder?: BotProfileFolderContent; snapshot?: BotProfileSnapshot | null } = {}) {
  const seedFolder = vi.fn(async () => {});
  const deriveVersion = vi.fn(async () => {});
  return {
    seedFolder,
    deriveVersion,
    deps: {
      readSnapshot: async () => (over.snapshot === undefined ? snapshot() : over.snapshot),
      readFolder: async () => over.folder ?? folder(),
      seedFolder,
      deriveVersion,
    },
  };
}

describe('文件与快照是不是同一份', () => {
  it('两边形状不同但内容相同时判为一致 —— 否则会无限派生新版本', () => {
    // 用户画像:数据库在 config 里,磁盘上是独立文件。
    expect(botProfileFolderMatchesSnapshot(folder(), snapshot())).toBe(true);
  });

  it('JSON 键顺序不算差异', () => {
    expect(
      botProfileFolderMatchesSnapshot(
        folder({ config: { harness: 'claude', model: 'claude-sonnet-4-6' } }),
        snapshot(),
      ),
    ).toBe(true);
  });

  it('灵魂、用户画像、能力位任一变了都算变了', () => {
    expect(botProfileFolderMatchesSnapshot(folder({ identitySource: '换了' }), snapshot())).toBe(
      false,
    );
    expect(botProfileFolderMatchesSnapshot(folder({ userContextSource: '换了' }), snapshot())).toBe(
      false,
    );
    expect(
      botProfileFolderMatchesSnapshot(folder({ config: { model: 'gpt-5.6' } }), snapshot()),
    ).toBe(false);
  });
});

describe('对账', () => {
  it('没改过就什么都不做', async () => {
    const h = harness();
    expect(await syncBotProfileFromFolder('bot-a', h.deps)).toBe('unchanged');
    expect(h.seedFolder).not.toHaveBeenCalled();
    expect(h.deriveVersion).not.toHaveBeenCalled();
  });

  it('用户改了 SOUL.md:派生新版本,带上乐观锁', async () => {
    const h = harness({ folder: folder({ identitySource: '我改成了别的' }) });
    expect(await syncBotProfileFromFolder('bot-a', h.deps)).toBe('derived');
    expect(h.deriveVersion).toHaveBeenCalledWith({
      botId: 'bot-a',
      identitySource: '我改成了别的',
      // 写回数据库时用户画像塞回 config —— 那是数据库这边的形状。
      config: {
        model: 'claude-sonnet-4-6',
        harness: 'claude',
        userContextSource: 'Chris 住在上海。',
      },
      expectedCurrentVersion: 3,
    });
  });

  it('家还没建起来:用数据库那份播种,不当成「身份被清空」', async () => {
    const h = harness({ folder: folder({ identitySource: '', userContextSource: '' }) });
    expect(await syncBotProfileFromFolder('bot-a', h.deps)).toBe('seeded');
    expect(h.seedFolder).toHaveBeenCalledWith('bot-a', {
      identitySource: '你是纸老虎，一个爱做菜的厨子。',
      userContextSource: 'Chris 住在上海。',
      config: { model: 'claude-sonnet-4-6', harness: 'claude' },
    });
    // 不能顺手派生版本:什么都没变,只是把文件补回去。
    expect(h.deriveVersion).not.toHaveBeenCalled();
  });

  it('用户把 SOUL.md 删了也走播种,而不是把人格抹成空', async () => {
    const h = harness({ folder: folder({ identitySource: '   ' }) });
    expect(await syncBotProfileFromFolder('bot-a', h.deps)).toBe('seeded');
    expect(h.deriveVersion).not.toHaveBeenCalled();
  });

  it('数据库里没有这个伙伴时不碰磁盘', async () => {
    const h = harness({ snapshot: null });
    expect(await syncBotProfileFromFolder('bot-a', h.deps)).toBe('missing');
    expect(h.seedFolder).not.toHaveBeenCalled();
    expect(h.deriveVersion).not.toHaveBeenCalled();
  });

  it('派生一次之后就稳定下来,不会每次对账都涨版本', async () => {
    // 派生完数据库会跟上文件;下一次对账两边一致。
    const changed = folder({ identitySource: '改过的' });
    const first = harness({ folder: changed });
    expect(await syncBotProfileFromFolder('bot-a', first.deps)).toBe('derived');

    const after = harness({
      folder: changed,
      snapshot: snapshot({ identitySource: '改过的', currentVersion: 4 }),
    });
    expect(await syncBotProfileFromFolder('bot-a', after.deps)).toBe('unchanged');
  });
});
