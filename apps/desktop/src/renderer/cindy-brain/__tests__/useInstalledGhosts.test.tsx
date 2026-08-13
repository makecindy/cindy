// @vitest-environment jsdom
/**
 * useInstalledGhosts.test.tsx — 已装意识清单的窗口级共享缓存契约。
 *
 * 背景(2026-07 卡顿修复):hook 旧版每个组件实例挂载各自 listSync(sendSync
 * 阻塞 renderer + main 全量扫盘),AgentActionRow 等聊天行无条件消费,大会话
 * 一帧上百行 = 上百次同步扫描。本文件锁死新契约:
 * 1. 任意多个消费者,整个窗口 listSync 只发生一次;
 * 2. 所有消费者读到同一引用(getSnapshot 引用稳定);
 * 3. ghosts:changed 推送后全体刷新,仍不重扫(payload 自带全量清单)。
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InstalledGhost } from '../../../shared/ghost';
import {
  __resetInstalledGhostsStoreForTest,
  useInstalledGhosts,
} from '../useInstalledGhosts';

const ghost = (id: string, name = id): InstalledGhost => ({
  manifest: {
    schemaVersion: 2,
    id,
    name,
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    slots: ['tool'],
  },
  dir: `/brain/${id}`,
  enabled: true,
  approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
});

type ChangedCb = (payload: { ghosts: InstalledGhost[] }) => void;

const listSync = vi.fn<() => { ghosts: InstalledGhost[] }>();
const changedCbs: ChangedCb[] = [];
const unsubscribeChanged = vi.fn();
const onChanged = vi.fn((cb: ChangedCb) => {
  changedCbs.push(cb);
  return unsubscribeChanged;
});

beforeEach(() => {
  __resetInstalledGhostsStoreForTest();
  listSync.mockReset();
  listSync.mockReturnValue({ ghosts: [ghost('cindy-art')] });
  changedCbs.length = 0;
  unsubscribeChanged.mockReset();
  onChanged.mockClear();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    ghosts: {
      listSync,
      onChanged,
    },
  };
});

afterEach(() => {
  cleanup();
  __resetInstalledGhostsStoreForTest();
});

function Probe({ label }: { label: string }) {
  const ghosts = useInstalledGhosts();
  return <div data-testid={label}>{ghosts.map((g) => g.manifest.id).join(',')}</div>;
}

describe('useInstalledGhosts(窗口级共享缓存)', () => {
  it('多个消费者只触发一次 listSync,清单一致', () => {
    render(
      <>
        <Probe label="a" />
        <Probe label="b" />
        <Probe label="c" />
      </>,
    );
    expect(listSync).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('a').textContent).toBe('cindy-art');
    expect(screen.getByTestId('b').textContent).toBe('cindy-art');
    expect(screen.getByTestId('c').textContent).toBe('cindy-art');
  });

  it('后挂载的消费者复用缓存,不再 listSync', () => {
    const first = render(<Probe label="a" />);
    expect(listSync).toHaveBeenCalledTimes(1);
    first.rerender(
      <>
        <Probe label="a" />
        <Probe label="b" />
      </>,
    );
    expect(listSync).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('b').textContent).toBe('cindy-art');
  });

  it('ghosts:changed 推送后全体消费者刷新,且不重扫', () => {
    render(
      <>
        <Probe label="a" />
        <Probe label="b" />
      </>,
    );
    expect(changedCbs.length).toBeGreaterThan(0);
    act(() => {
      changedCbs.forEach((cb) =>
        cb({ ghosts: [ghost('cindy-art'), ghost('cindy-mermaid')] }),
      );
    });
    expect(screen.getByTestId('a').textContent).toBe('cindy-art,cindy-mermaid');
    expect(screen.getByTestId('b').textContent).toBe('cindy-art,cindy-mermaid');
    expect(listSync).toHaveBeenCalledTimes(1);
  });

  it('模块重置时退订旧 changed 回调,重新挂载只注册一个新回调', () => {
    const first = render(<Probe label="a" />);
    expect(onChanged).toHaveBeenCalledTimes(1);
    first.unmount();

    __resetInstalledGhostsStoreForTest();
    expect(unsubscribeChanged).toHaveBeenCalledTimes(1);

    render(<Probe label="b" />);
    expect(onChanged).toHaveBeenCalledTimes(2);
    expect(listSync).toHaveBeenCalledTimes(2);
  });

  it('桥缺席(精简 harness)时空清单兜底,不抛错', () => {
    (window as unknown as { electronAPI: unknown }).electronAPI = {};
    render(<Probe label="a" />);
    expect(screen.getByTestId('a').textContent).toBe('');
  });
});
