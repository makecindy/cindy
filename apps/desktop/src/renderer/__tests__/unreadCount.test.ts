/**
 * unreadCount 单测 — 「N 条新消息」未读计数纯函数。
 *
 * #2194 之后外部入口注入的 user 消息不再抢视口，必须计入未读，否则离底
 * 阅读时新到内容在屏幕外无声无息（Codex review P2）。
 */
import { describe, expect, it } from 'vitest';

import { collectUnreadKeys } from '../components/chat/unreadCount';

const msg = (clientId: string, role: string) => ({ clientId, role });
const countUnreadAdded = (args: Parameters<typeof collectUnreadKeys>[0]) =>
  collectUnreadKeys(args).keys.length;

describe('countUnreadAdded', () => {
  // 一次回复执行中会写出几十段中间正文，最终折进同一段工作过程；逐条计数曾把
  // 一次回复报成「59 条新消息」。同一回合跨多次 diff 返回同一个键，由调用方去重。
  // Cindy Make / review 系统卡是 MessageStream 里独立的可见命令回合：不并入前一回复。
  it('assistant 系统卡开启新回合，各自成键', () => {
    const { keys } = collectUnreadKeys({
      prevIds: new Set(['u1', 'a1']),
      messages: [
        msg('u1', 'user'),
        msg('a1', 'assistant'),
        msg('a2', 'assistant'),
        { clientId: 'card', role: 'assistant', systemCardType: 'review' },
        msg('a3', 'assistant'),
      ],
      nearBottom: false,
    });
    expect(keys).toEqual(['turn:u1', 'turn:card']);
  });

  // 重开仍在执行的长回复：尾页没有起始 user，新正文先记「起点未知」键；向上翻页补回
  // 起始 user 后，续接正文改记 turn:<id>，调用方必须撤掉旧键，否则同一回复占两个未读。
  it('补载出回合起点后，续接的回复撤销「起点未知」键而不是多算一条', () => {
    const tail = [msg('a1', 'assistant'), msg('a2', 'assistant')];
    const first = collectUnreadKeys({
      prevIds: new Set(['a1']),
      messages: tail,
      nearBottom: false,
    });
    expect(first).toEqual({ keys: ['turn:'], supersedes: [] });
    const loaded = [msg('u0', 'user'), ...tail, msg('a3', 'assistant')];
    expect(
      collectUnreadKeys({ prevIds: new Set(['a1', 'a2']), messages: loaded, nearBottom: false }),
    ).toEqual({ keys: ['turn:u0'], supersedes: ['turn:'] });
    // 起点早已见过的回合（外部 user 之后的又一批回复）续接时，不得撤销更早回复的未知键。
    expect(
      collectUnreadKeys({
        prevIds: new Set(['a1', 'u9', 'a9']),
        messages: [
          msg('a1', 'assistant'),
          msg('u9', 'user'),
          msg('a9', 'assistant'),
          msg('a10', 'assistant'),
        ],
        nearBottom: false,
      }),
    ).toEqual({ keys: ['turn:u9'], supersedes: [] });
    // 新到的外部 user 开启的新回复在本轮行内，不得撤销旧键。
    expect(
      collectUnreadKeys({
        prevIds: new Set(['a1']),
        messages: [msg('a1', 'assistant'), msg('u9', 'user'), msg('a9', 'assistant')],
        nearBottom: false,
      }).supersedes,
    ).toEqual([]);
  });

  it('同一回合的多段 assistant 输出只算一条，steer 不开启新回合', () => {
    const first = [msg('u1', 'user'), msg('a1', 'assistant'), msg('a2', 'assistant')];
    expect(
      collectUnreadKeys({ prevIds: new Set(['u1']), messages: first, nearBottom: false }).keys,
    ).toEqual(['turn:u1']);
    const second = [
      ...first,
      { clientId: 's1', role: 'user', delivery: 'steer' },
      msg('a3', 'assistant'),
      msg('q1', 'ask_user'),
      msg('u2', 'user'),
      msg('a4', 'assistant'),
    ];
    expect(
      collectUnreadKeys({
        prevIds: new Set(first.map((m) => m.clientId)),
        messages: second,
        nearBottom: false,
        isLocalUserSend: () => true,
      }).keys,
    ).toEqual(['turn:u1', 'q1', 'turn:u2']);
  });

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

it('counts new result receipts in history, but not replayed receipts or paginated old cards', () => {
  const messages = [
    { clientId: 'older-result', role: 'assistant' },
    { clientId: 'anchor', role: 'assistant' },
    { clientId: 'user-input', role: 'user' },
    { clientId: 'result-1', role: 'assistant' },
    { clientId: 'hidden-wake', role: 'user', isSyntheticTrigger: true },
    { clientId: 'result-2', role: 'assistant' },
  ];
  expect(countUnreadAdded({ prevIds: new Set(['anchor']), messages, nearBottom: false })).toBe(2);
  expect(
    countUnreadAdded({
      prevIds: new Set(messages.map((message) => message.clientId)),
      messages,
      nearBottom: false,
    }),
  ).toBe(0);
});
