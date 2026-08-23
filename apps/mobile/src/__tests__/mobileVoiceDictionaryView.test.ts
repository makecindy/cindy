/**
 * 手机端词典展示模型。
 *
 * 手机上的词典是只读投影 —— 这里盯的是「别把不该显示的设备显示出来」和「顺序
 * 在两次打开之间保持稳定」,后者在设备同名或频次并列时最容易出问题。
 */

import { describe, expect, it } from 'vitest';
import type { DeviceView } from '@cindy/device-link';

import {
  buildMobileVoiceDictionaryEntryViews,
  collectMobileVoiceDictionaryHosts,
  isDesktopDevice,
} from '@/session/mobileVoiceDictionaryView';

function device(overrides: Partial<DeviceView>): DeviceView {
  return {
    deviceId: 'device-1',
    name: 'MacBook',
    platform: 'darwin',
    appVersion: '1.0.0',
    lastSeenAt: null,
    online: true,
    busy: false,
    remoteControlEnabled: true,
    isSelf: false,
    ...overrides,
  } as DeviceView;
}

describe('collectMobileVoiceDictionaryHosts', () => {
  it('只保留其它设备中的电脑', () => {
    const hosts = collectMobileVoiceDictionaryHosts([
      device({ deviceId: 'mac', platform: 'darwin' }),
      device({ deviceId: 'win', platform: 'win32' }),
      device({ deviceId: 'linux', platform: 'linux' }),
      // 手机不持有词典正本,不该出现在列表里。
      device({ deviceId: 'iphone', platform: 'ios' }),
      device({ deviceId: 'android', platform: 'android' }),
      // 自己更不该出现。
      device({ deviceId: 'self', platform: 'ios', isSelf: true }),
      device({ deviceId: 'unknown', platform: null }),
    ]);

    expect(hosts.map((host) => host.deviceId).sort()).toEqual(['linux', 'mac', 'win']);
  });

  it('在线的排前面,其余按名称稳定排序', () => {
    const hosts = collectMobileVoiceDictionaryHosts([
      device({ deviceId: 'b', name: 'Studio', online: false }),
      device({ deviceId: 'a', name: 'Air', online: false }),
      device({ deviceId: 'c', name: 'Pro', online: true }),
    ]);
    expect(hosts.map((host) => host.name)).toEqual(['Pro', 'Air', 'Studio']);
  });

  it('同名设备按 deviceId 兜底,顺序不会在两次打开之间抖动', () => {
    const input = [
      device({ deviceId: 'zzz', name: 'MacBook' }),
      device({ deviceId: 'aaa', name: 'MacBook' }),
    ];
    expect(collectMobileVoiceDictionaryHosts(input).map((host) => host.deviceId)).toEqual([
      'aaa',
      'zzz',
    ]);
    expect(collectMobileVoiceDictionaryHosts([...input].reverse()).map((host) => host.deviceId)).toEqual([
      'aaa',
      'zzz',
    ]);
  });

  it('设备没有名字时回退到 deviceId 前缀,不显示空标题', () => {
    const [host] = collectMobileVoiceDictionaryHosts([
      device({ deviceId: 'abcdef1234567890', name: '   ' }),
    ]);
    expect(host.name).toBe('abcdef12');
  });

  it('平台判定只认桌面三件套', () => {
    expect(isDesktopDevice('darwin')).toBe(true);
    expect(isDesktopDevice('ios')).toBe(false);
    expect(isDesktopDevice(null)).toBe(false);
  });
});

describe('buildMobileVoiceDictionaryEntryViews', () => {
  const snap = (
    entries: Array<{ text: string; frequency?: number; aliases?: Array<{ text: string; count?: number }> }>,
    fetchedAt = 1_000,
  ) => ({ entries, fetchedAt });

  it('按频次降序,并列时按文本稳定排序', () => {
    const views = buildMobileVoiceDictionaryEntryViews([snap([
      { text: 'Orca', frequency: 2 },
      { text: 'Cindy', frequency: 9 },
      { text: 'Alpha', frequency: 2 },
    ])]);
    expect(views.map((view) => view.text)).toEqual(['Cindy', 'Alpha', 'Orca']);
  });

  it('别名按观察次数降序并截断', () => {
    const [view] = buildMobileVoiceDictionaryEntryViews(
      [snap([
        {
          text: 'Vibe Coding',
          frequency: 3,
          aliases: [
            { text: 'rare', count: 1 },
            { text: 'common', count: 9 },
            { text: 'mid', count: 4 },
          ],
        },
      ])],
      { maxAliases: 2 },
    );
    expect(view.aliases).toEqual(['common', 'mid']);
  });

  it('丢弃空文本并按归一化主键去重', () => {
    const views = buildMobileVoiceDictionaryEntryViews([snap([
      { text: '  ' },
      { text: 'Cindy', frequency: 5 },
      { text: 'cindy', frequency: 1 },
    ])]);
    expect(views.map((view) => view.text)).toEqual(['Cindy']);
  });

  it('没有任何成功拉取过的快照时返回空列表', () => {
    expect(buildMobileVoiceDictionaryEntryViews([])).toEqual([]);
    // fetchedAt=0 表示从没拉到过,不能当成"词典是空的"来用。
    expect(buildMobileVoiceDictionaryEntryViews([{ entries: [{ text: 'X' }], fetchedAt: 0 }])).toEqual([]);
  });
});

describe('buildMobileVoiceDictionaryEntryViews — 多台电脑取最新那份', () => {
  it('用最新快照,不与旧快照取并集', () => {
    const views = buildMobileVoiceDictionaryEntryViews([
      { entries: [{ text: 'Cindy' }, { text: 'Orca' }], fetchedAt: 1_000 },
      { entries: [{ text: 'Cindy' }], fetchedAt: 5_000 },
    ]);
    expect(views.map((view) => view.text)).toEqual(['Cindy']);
  });

  it('在别处删掉的词不会被离线电脑的旧缓存复活', () => {
    // 这正是并集的致命处:用户在在线电脑上删了 Orca,离线电脑的三天前缓存还留着它,
    // 并集会让它在手机上永远删不掉。
    const stale = { entries: [{ text: 'Cindy', frequency: 9 }, { text: 'Orca', frequency: 4 }], fetchedAt: 1_000 };
    const fresh = { entries: [{ text: 'Cindy', frequency: 2 }], fetchedAt: 9_000 };
    const views = buildMobileVoiceDictionaryEntryViews([stale, fresh]);
    expect(views.map((view) => view.text)).toEqual(['Cindy']);
  });

  it('最新快照为空时就显示空 —— 那代表词典真的被清空了', () => {
    const views = buildMobileVoiceDictionaryEntryViews([
      { entries: [{ text: 'Cindy' }], fetchedAt: 1_000 },
      { entries: [], fetchedAt: 9_000 },
    ]);
    expect(views).toEqual([]);
  });

  it('只有一台拉到过时就用它,顺序与来源无关', () => {
    const never = { entries: [], fetchedAt: 0 };
    const ok = { entries: [{ text: 'Cindy' }, { text: 'Orca' }], fetchedAt: 3_000 };
    expect(buildMobileVoiceDictionaryEntryViews([never, ok]).map((v) => v.text).sort())
      .toEqual(['Cindy', 'Orca']);
    expect(buildMobileVoiceDictionaryEntryViews([ok, never]).map((v) => v.text).sort())
      .toEqual(['Cindy', 'Orca']);
  });
});

describe('新鲜度判定', () => {
  it('一方包含另一方时选包含者,不被响应到达顺序左右', () => {
    // B 已经合并过 A 的事件(向量逐节点 ≥),但它的响应更慢:按到达时间会挑错。
    const views = buildMobileVoiceDictionaryEntryViews([
      { entries: [{ text: '旧词' }], fetchedAt: 9_000, stateVector: { a: '0000000100.0000.a' } },
      {
        entries: [{ text: '新词' }, { text: '旧词' }],
        fetchedAt: 1_000,
        stateVector: { a: '0000000100.0000.a', b: '0000000200.0000.b' },
      },
    ]);
    expect(views.map((view) => view.text).sort()).toEqual(['新词', '旧词'].sort());
  });

  it('互不包含(真并发)时退回按拉取时间取较新的', () => {
    // A 加了 foo、B 加了 bar,谁都不包含谁 —— 没有正确答案,取较新的那份。
    const views = buildMobileVoiceDictionaryEntryViews([
      { entries: [{ text: 'foo' }], fetchedAt: 1_000, stateVector: { a: '0000000100.0000.a' } },
      { entries: [{ text: 'bar' }], fetchedAt: 9_000, stateVector: { b: '0000000101.0000.b' } },
    ]);
    expect(views.map((view) => view.text)).toEqual(['bar']);
  });

  it('跨桌面并列时不比各自主机的 emittedAt', () => {
    const views = buildMobileVoiceDictionaryEntryViews([
      {
        entries: [{ text: '旧且时钟快' }],
        fetchedAt: 1_000,
        stateVector: { a: '0000000100.0000.a' },
        emittedAt: 9_999_999,
      },
      {
        entries: [{ text: '新到达' }],
        fetchedAt: 9_000,
        stateVector: { b: '0000000101.0000.b' },
        emittedAt: 1,
      },
    ]);
    expect(views.map((view) => view.text)).toEqual(['新到达']);
  });

  it('最大 HLC 更大但并不包含对方时,不能因此被当成完整答案', () => {
    // 这正是只比最大时间戳会犯的错:B 的 HLC 更大,但它没有 A 的词。
    const views = buildMobileVoiceDictionaryEntryViews([
      {
        entries: [{ text: 'foo' }, { text: 'bar' }],
        fetchedAt: 9_000,
        stateVector: { a: '0000000100.0000.a', b: '0000000101.0000.b' },
      },
      { entries: [{ text: 'bar' }], fetchedAt: 1_000, stateVector: { b: '0000000101.0000.b' } },
    ]);
    expect(views.map((view) => view.text).sort()).toEqual(['bar', 'foo']);
  });

  it('对端不上报水位时退回按拉取时间比较', () => {
    const views = buildMobileVoiceDictionaryEntryViews([
      { entries: [{ text: '旧词' }], fetchedAt: 1_000 },
      { entries: [{ text: '新词' }], fetchedAt: 9_000 },
    ]);
    expect(views.map((view) => view.text)).toEqual(['新词']);
  });

  it('只有一台带版本向量时认它 —— 老版本不该压过能自证更完整的快照', () => {
    const views = buildMobileVoiceDictionaryEntryViews([
      { entries: [{ text: '老版本' }], fetchedAt: 9_999 },
      { entries: [{ text: '带向量' }], fetchedAt: 1_000, stateVector: { a: '0000000100.0000.a' } },
    ]);
    expect(views.map((view) => view.text)).toEqual(['带向量']);
  });
});

describe('词条主键', () => {
  it('与桌面 CRDT 主键同一套归一化 —— 只差空白的两条要合并成一行', () => {
    const views = buildMobileVoiceDictionaryEntryViews([
      {
        entries: [
          { text: 'Vibe  Coding', frequency: 3 },
          { text: 'vibe coding', frequency: 1 },
          { text: ' Vibe Coding ', frequency: 1 },
        ],
        fetchedAt: 1_000,
      },
    ]);
    expect(views).toHaveLength(1);
    expect(views[0].key).toBe('vibe coding');
  });

  it('归一化之后为空的词条被丢掉,不会产生空 key', () => {
    const views = buildMobileVoiceDictionaryEntryViews([
      { entries: [{ text: '   ' }, { text: 'Cindy' }], fetchedAt: 1_000 },
    ]);
    expect(views.map((view) => view.text)).toEqual(['Cindy']);
  });
});
