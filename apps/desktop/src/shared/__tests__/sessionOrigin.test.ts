import { describe, expect, it } from 'vitest';

import { parseSessionOrigin, serializeSessionOrigin, sessionOriginFromInputMeta } from '../sessionOrigin';

/**
 * 测试价值
 * - 生产入口与可观察结果：send_to_session 新建任务时用 sessionOriginFromInputMeta 从首条消息的宿主盖章来源
 *   推出 sessions.origin_session；mapper 用 parseSessionOrigin 读出。结果决定侧栏是否出「由哪个任务发起」标记。
 * - 规则依据：message-source.md「两个维度」——插件派发以插件为准；群话题 / 群请求没有来源任务；
 *   跨电脑来源记 deviceId::sessionId；名字按不可信文本清洗。
 * - 现有覆盖缺口：新增字段，消息级来源测试不覆盖任务级投影。
 * - 最小失败输入：带 sourcePlugin 的 session origin 被记成「由任务发起」；损坏 JSON 抛错让会话列表读取失败。
 * - tier：unit（纯函数）。
 */
describe('session origin recorded on the task row', () => {
  const sessionOrigin = { kind: 'session', senderSessionId: 'lead-1', senderSessionTitle: '整理访谈', displayText: 'x' };

  it.each([
    ['a task-sent first message', { origin: sessionOrigin }, { sessionId: 'lead-1', title: '整理访谈' }],
    ['a cross-computer sender keeps the stamped device prefix', { origin: { ...sessionOrigin, senderSessionId: 'dev-a::lead-1' } },
      { sessionId: 'dev-a::lead-1', title: '整理访谈' }],
    ['a sender title with line breaks is flattened', { origin: { ...sessionOrigin, senderSessionTitle: '第一行\n第二行' } },
      { sessionId: 'lead-1', title: '第一行 第二行' }],
    ['a plugin dispatch is attributed to the plugin, not the task', { origin: sessionOrigin, sourcePlugin: { pluginId: 'p', name: 'P' } }, null],
    ['a group-thread relay has no source task', {
      origin: { ...sessionOrigin, groupThread: { groupId: 'g', speakerId: 'u' } },
    }, null],
    ['a redacted session source has no id', { origin: { kind: 'session', displayText: 'x' } }, null],
    ['an automation run', { origin: { kind: 'scheduler', scheduleId: 's' } }, null],
    ['no source at all', undefined, null],
  ])('%s', (_name, meta, expected) => {
    expect(sessionOriginFromInputMeta(meta)).toEqual(expected);
  });

  it('round-trips stored JSON and treats corrupt values as an ordinary task', () => {
    const origin = { sessionId: 'lead-1', title: '整理访谈' };
    expect(parseSessionOrigin(serializeSessionOrigin(origin))).toEqual(origin);
    expect(parseSessionOrigin(null)).toBeNull();
    expect(parseSessionOrigin('{not json')).toBeNull();
    expect(parseSessionOrigin('[]')).toBeNull();
    expect(parseSessionOrigin({ title: 'no id' })).toBeNull();
  });
});
