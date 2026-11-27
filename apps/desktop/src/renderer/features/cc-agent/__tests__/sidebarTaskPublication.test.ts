/**
 * 测试价值
 * - 生产入口与可观察结果：createSidebarTaskPublisher（侧栏上报给设备键位的纯逻辑入口），
 *   断言「真正发给主进程的任务行标题已按设备上限截断」与「同一份内容不会因为上一次
 *   发布失败而被反复重发」。
 * - Bug／规则依据：#9403 —— 从 Codex 导入的会话标题超过 512 字符时，
 *   `worklouder-codex:publish-tasks` 抛 `task title is too long`；失败后又把去重键清空，
 *   于是侧栏 DOM 每变一次就重发一次并再抛一遍，单日累计 2500+ 条错误。
 * - 现有覆盖缺口：侧栏上报此前没有任何用例，截断与重发两条行为都没被锁住。
 * - 最小失败输入：一个 600 字的标题；一个返回 rejected 的上报入口；一个迟迟不返回的
 *   重试 promise 加连续的同内容重发。
 * - tier：unit（纯函数，无 DOM、无 IPC、无计时等待）。
 */

import { describe, expect, it, vi } from 'vitest';

import type { WorkLouderCodexPublishedTask } from '../../../../shared/workLouderCodex';
import {
  SIDEBAR_TASK_RETRY_MS,
  createSidebarTaskPublisher,
} from '../lib/sidebarTaskPublication';

const task = (title: string | null): WorkLouderCodexPublishedTask => ({
  id: 'session-1',
  title,
  pinnedAt: null,
  userSendAt: null,
});

describe('createSidebarTaskPublisher', () => {
  it('caps the published title at the device limit', () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    const publisher = createSidebarTaskPublisher({ publish });

    publisher.publish([task('a'.repeat(600))]);

    expect(publish).toHaveBeenCalledTimes(1);
    const published = publish.mock.calls[0]![0] as WorkLouderCodexPublishedTask[];
    expect(published[0]!.title).toHaveLength(512);
  });

  it('does not resend the same content after a failed publish, and resends after the cooldown', async () => {
    const publish = vi.fn().mockRejectedValue(new Error('task title is too long'));
    let clock = 1_000;
    const publisher = createSidebarTaskPublisher({ publish, now: () => clock });

    publisher.publish([task('same')]);
    await Promise.resolve();
    await Promise.resolve();
    // 侧栏 DOM 又变了一次：内容没变，不该再抛一次同一个错。
    publisher.publish([task('same')]);
    expect(publish).toHaveBeenCalledTimes(1);

    clock += SIDEBAR_TASK_RETRY_MS;
    publisher.publish([task('same')]);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it('publishes again as soon as the content changes', async () => {
    const publish = vi.fn().mockRejectedValue(new Error('task title is too long'));
    const publisher = createSidebarTaskPublisher({ publish });

    publisher.publish([task('first')]);
    await Promise.resolve();
    await Promise.resolve();
    publisher.publish([task('second')]);

    expect(publish).toHaveBeenCalledTimes(2);
  });

  it('does not resend the same content while a retry is still in flight', async () => {
    let clock = 1_000;
    let rejectPending!: (error: Error) => void;
    const publish = vi.fn(
      () => new Promise((_resolve, reject) => { rejectPending = reject; }),
    );
    const publisher = createSidebarTaskPublisher({ publish, now: () => clock });

    // 第一次发布失败, 冷却从失败时刻起算。
    publisher.publish([task('same')]);
    rejectPending(new Error('task title is too long'));
    await Promise.resolve();
    await Promise.resolve();
    expect(publish).toHaveBeenCalledTimes(1);

    // 冷却结束后重试发出, 但主进程繁忙, IPC 一直没回。
    clock += SIDEBAR_TASK_RETRY_MS;
    publisher.publish([task('same')]);
    expect(publish).toHaveBeenCalledTimes(2);

    // 侧栏 DOM 每帧都在变: 内容没变就不发 —— 即使按上一次失败的旧时间戳,
    // 冷却早已过期(greptile P2 on #13310: 重试窗口里同内容被逐帧重发)。
    clock += SIDEBAR_TASK_RETRY_MS;
    publisher.publish([task('same')]);
    publisher.publish([task('same')]);
    expect(publish).toHaveBeenCalledTimes(2);

    // 重试失败回来了: 冷却锚在失败时刻, 立刻重发仍被挡住。
    rejectPending(new Error('task title is too long'));
    await Promise.resolve();
    await Promise.resolve();
    publisher.publish([task('same')]);
    expect(publish).toHaveBeenCalledTimes(2);

    // 冷却走完才重试。
    clock += SIDEBAR_TASK_RETRY_MS;
    publisher.publish([task('same')]);
    expect(publish).toHaveBeenCalledTimes(3);
  });
});
