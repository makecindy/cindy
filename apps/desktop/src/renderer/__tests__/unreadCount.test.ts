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
  // 本端发送（会强制回底）不计。该规则需要基线（prevIds 非空）才生效。
  it('非本端发送的 user 消息计数，本端发送不计', () => {
    expect(
      countUnreadAdded({
        prevIds: new Set(['seen']),
        messages: [msg('seen', 'assistant'), msg('ext', 'user'), msg('local', 'user')],
        nearBottom: false,
        isLocalUserSend: (id) => id === 'local',
      }),
    ).toBe(1);
  });

  // Codex P2（第六轮）：会话重开 / 还原离底时首轮 diff 的 prevIds 为空，
  // 内存态登记对整批历史 user 行一律返回 false——计入会把历史误报成新消息。
  it('prevIds 为空（首渲染基线未建立）时 user 行不计数，assistant 行保持既有行为', () => {
    expect(
      countUnreadAdded({
        prevIds: new Set(),
        messages: [msg('u1', 'user'), msg('u2', 'user'), msg('a1', 'assistant')],
        nearBottom: false,
        isLocalUserSend: () => false,
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

  // Codex P1（第四轮）：合成指令行（手动「继续」/ Mivo 触发指令）渲染 null，
  // sendUiTrigger 也不登记本端发送——若计数会留下点对不掉的幻影未读。
  it('合成指令行（isSyntheticTrigger）不计数', () => {
    expect(
      countUnreadAdded({
        prevIds: new Set(['seen']),
        messages: [
          msg('seen', 'assistant'),
          { clientId: 'syn', role: 'user', isSyntheticTrigger: true },
          msg('ext', 'user'),
        ],
        nearBottom: false,
        isLocalUserSend: () => false,
      }),
    ).toBe(1);
  });

  // Codex P2（第五轮）：分页 loadOlderMessages prepend 的历史行不在 prevIds
  // 里，纯 clientId 差分会把视口上方的旧消息误计成「新消息」。
  it('分页 prepend 的历史行不计数，只有尾部追加才计', () => {
    // prevIds 非空：以最后一条已见消息为界。
    expect(
      countUnreadAdded({
        prevIds: new Set(['m3', 'm4']),
        messages: [
          msg('h1', 'assistant'),
          msg('h2', 'user'),
          msg('m3', 'assistant'),
          msg('m4', 'user'),
        ],
        nearBottom: false,
        isLocalUserSend: () => false,
      }),
    ).toBe(0);

    // 同一帧里既有 prepend 又有尾部追加：只数尾部。
    expect(
      countUnreadAdded({
        prevIds: new Set(['m3']),
        messages: [msg('h1', 'assistant'), msg('m3', 'assistant'), msg('new', 'assistant')],
        nearBottom: false,
      }),
    ).toBe(1);
  });

  it('prevIds 里的消息一条都不在列表中（窗口整体重置）时不计数', () => {
    expect(
      countUnreadAdded({
        prevIds: new Set(['gone1', 'gone2']),
        messages: [msg('a1', 'assistant'), msg('u1', 'user')],
        nearBottom: false,
        isLocalUserSend: () => false,
      }),
    ).toBe(0);
  });
});
