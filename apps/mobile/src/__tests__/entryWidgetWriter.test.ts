/**
 * 测试价值
 * - 生产入口与可观察结果：`createEntryWidgetWriter` 是 `useEntryWidgetSync` 真正交给原生的那份
 *   快照。用户看到的是桌面组件上的名单与头像 —— 同步期间的变化不能丢，退登后不能还显示上一个
 *   账号的伙伴名、头像和电脑名。
 * - Bug／规则依据：PR #12217 review 的两条 P1 —— 等头像时再来一次名单变化会被丢弃；退登只停止
 *   同步，组件仍从磁盘读旧快照。也锁住「换账号重新取图」与「内容没变不重复写原生」。
 * - 覆盖缺口：Kotlin 侧的 SharedPreferences / RemoteViews 没有 JS 单测宿主，这里只锁 JS 交出去
 *   的那份快照与写入次数，图标文件的落盘顺序由原生实现保证。
 * - 最小失败输入：`resolveIcon` 挂起时再 `update` 一次；`resolveIcon` 挂起时退登或切号。
 * - tier：unit（注入 write / resolveIcon，无 native / React / 网络）。
 */
import { describe, expect, it, vi } from 'vitest';

import { createEntryWidgetWriter, type EntryWidgetInput } from '@/device-link/entryWidgetWriter';
import type { DesktopEntryRow } from '@/device-link/useDesktopEntryRows';
import type { EntryWidgetTarget } from '../../modules/cindy-entry-widget/src';

// 深链 scheme 在真机上来自 expo-linking（会拖进 react-native 的 Flow 源码）。
vi.mock('expo-linking', () => ({ createURL: (path: string) => `cindycn://${path}` }));

function row(title: string, extra: Partial<DesktopEntryRow> = {}): DesktopEntryRow {
  return {
    deviceId: 'device-1',
    deviceName: '家里笔记本',
    collectionId: 'teammates',
    companionId: `bot-${title}`,
    sessionId: `session-${title}`,
    title,
    online: true,
    avatar: null,
    ...extra,
  };
}

function input(rows: DesktopEntryRow[], extra: Partial<EntryWidgetInput> = {}): EntryWidgetInput {
  return {
    accountKey: '1:user-a',
    authenticated: true,
    ready: true,
    rows,
    cindyTaskTitle: 'Cindy 任务',
    ...extra,
  };
}

/** 记录每次交给原生的快照，并给「头像要等一等」这类时序留一个闸门。 */
function harness(options: { gate?: Promise<void> } = {}) {
  const written: EntryWidgetTarget[][] = [];
  const write = async (targets: readonly EntryWidgetTarget[]) => {
    written.push(targets.map((target) => ({ ...target })));
    return true;
  };
  const resolveIcon = vi.fn(async (target: { title: string }) => {
    await options.gate;
    return { kind: 'glyph' as const, text: target.title.slice(0, 1) };
  });
  return { written, write, resolveIcon, titles: () => written.at(-1)?.map((target) => target.title) };
}

function gate() {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => { release = resolve; });
  return { opened, release };
}

describe('桌面入口写入队列', () => {
  it('等头像期间来的名单变化会补写，最后一次不会丢', async () => {
    const pending = gate();
    const { write, resolveIcon, titles } = harness({ gate: pending.opened });
    const writer = createEntryWidgetWriter({ write, resolveIcon });
    const first = writer.update(input([row('阿明')]));
    const second = writer.update(input([row('阿明'), row('贝拉')]));
    pending.release();
    await Promise.all([first, second]);
    expect(titles()).toEqual(['Cindy 任务', '阿明', '贝拉']);
  });

  it('退登后清空原生快照，重新登录再写回来', async () => {
    const { written, write, resolveIcon } = harness();
    const writer = createEntryWidgetWriter({ write, resolveIcon });
    await writer.update(input([row('阿明')]));
    expect(written).toHaveLength(1);
    await writer.update(input([], { authenticated: false }));
    expect(written.at(-1)).toEqual([]);
    await writer.update(input([row('阿明')]));
    expect(written.at(-1)?.map((target) => target.title)).toEqual(['Cindy 任务', '阿明']);
  });

  it('退登时还没回来的头像结果不会写回旧账号', async () => {
    const pending = gate();
    const { written, write, resolveIcon } = harness({ gate: pending.opened });
    const writer = createEntryWidgetWriter({ write, resolveIcon });
    const signedIn = writer.update(input([row('阿明')]));
    const signedOut = writer.update(input([], { authenticated: false }));
    pending.release();
    await Promise.all([signedIn, signedOut]);
    // 旧账号的名单一次都没写出去，桌面直接从有列表切到空态。
    expect(written).toEqual([[]]);
  });

  it('切账号后重新取图，不会复用上一个账号的图标缓存', async () => {
    const { written, write, resolveIcon } = harness();
    const writer = createEntryWidgetWriter({ write, resolveIcon });
    const companion = row('阿明', { avatar: { kind: 'media', value: 'cindy-media://a' } });
    await writer.update(input([companion]));
    await writer.update(input([companion], { accountKey: '2:user-b' }));
    expect(resolveIcon).toHaveBeenCalledTimes(2);
    expect(written).toHaveLength(2);
  });

  it('内容没变时不重复写原生、也不重新取图', async () => {
    const { written, write, resolveIcon } = harness();
    const writer = createEntryWidgetWriter({ write, resolveIcon });
    await writer.update(input([row('阿明')]));
    await writer.update(input([row('阿明')]));
    expect(written).toHaveLength(1);
    expect(resolveIcon).toHaveBeenCalledTimes(1);
  });

  it('登录未就绪时不动原生快照', async () => {
    const { written, write, resolveIcon } = harness();
    const writer = createEntryWidgetWriter({ write, resolveIcon });
    await writer.update(input([row('阿明')], { ready: false }));
    expect(written).toEqual([]);
  });

  it('清空失败时会再试一次', async () => {
    const written: EntryWidgetTarget[][] = [];
    let clears = 0;
    const write = async (targets: readonly EntryWidgetTarget[]) => {
      if (targets.length === 0 && clears++ === 0) return false;
      written.push([...targets]);
      return true;
    };
    const writer = createEntryWidgetWriter({ write, resolveIcon: async () => ({ kind: 'brand' }) });
    await writer.update(input([row('阿明')]));
    await writer.update(input([], { authenticated: false }));
    expect(written.map((targets) => targets.length)).toEqual([2]);
    await writer.update(input([], { authenticated: false, accountKey: '1:user-a' }));
    expect(written.at(-1)).toEqual([]);
  });
});
