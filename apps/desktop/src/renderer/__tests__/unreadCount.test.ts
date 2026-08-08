/**
 * unreadCount 单测 — 「N 条新消息」未读计数纯函数。
 *
 * #2194 之后外部入口注入的 user 消息不再抢视口，必须计入未读，否则离底
 * 阅读时新到内容在屏幕外无声无息（Codex review P2）。
 */
import { describe, expect, it } from 'vitest';

import { countUnreadAdded } from '../components/chat/unreadCount';

const msg = (clientId: string, role: string) => ({ clientId, role });

describe('countUnreadAdded', () => {
  it('assistant / ask_user / plan_review 在离底时计数', () => {
    expect(
      countUnreadAdded({
        prevIds: new Set(),
        messages: [msg('a1', 'assistant'), msg('a2', 'ask_user'), msg('a3', 'plan_review')],
        nearBottom: false,
      }),
    ).toBe(3);
  });

  it('已见 clientId（流式 token 追加）不重复计数', () => {
    expect(
      countUnreadAdded({
        prevIds: new Set(['a1']),
        messages: [msg('a1', 'assistant'), msg('a2', 'assistant')],
        nearBottom: false,
      }),
    ).toBe(1);
  });

  it('贴底时不计数（auto-follow 接管）', () => {
    expect(
      countUnreadAdded({
        prevIds: new Set(),
        messages: [msg('a1', 'assistant'), msg('u1', 'user')],
        nearBottom: true,
        isLocalUserSend: () => false,
      }),
    ).toBe(0);
  });

  it('tool_use / tool_result 不计数', () => {
    expect(
      countUnreadAdded({
        prevIds: new Set(),
        messages: [msg('t1', 'tool_use'), msg('t2', 'tool_result')],
        nearBottom: false,
      }),
    ).toBe(0);
  });

  // #2194 / Codex P2：外部注入的 user 消息不再抢视口 → 计入未读；
  // 本端发送（会强制回底）不计。
  it('非本端发送的 user 消息计数，本端发送不计', () => {
    expect(
      countUnreadAdded({
        prevIds: new Set(),
        messages: [msg('ext', 'user'), msg('local', 'user')],
        nearBottom: false,
        isLocalUserSend: (id) => id === 'local',
      }),
    ).toBe(1);
  });

  it('isLocalUserSend 缺省时 user 不计数（既有行为）', () => {
    expect(
      countUnreadAdded({
        prevIds: new Set(),
        messages: [msg('u1', 'user')],
        nearBottom: false,
      }),
    ).toBe(0);
  });
});
