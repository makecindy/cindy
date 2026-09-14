/**
 * ghostCardRenderItems.test.ts — 卡槽③在 buildRenderItems 里的配对/锚定/抑制。
 * 纯函数直测(与 buildRenderItemsKeyStability 同 pattern):
 * - settled:tool_result 顶层 xdt_card_id + store ready → ghost_card item +
 *   该调用的媒体贡献被抑制(同段其它工具不受影响);missing → 不抑制走 generic;
 *   loading/未知 → 抑制但不出卡(等取件落定);
 * - in-flight:claude 精确 toolUseId 锚 / codex 同 ghostId 启发式按序认领;
 *   已 settled 的卡不被活卡锚定重复认领;
 * - key 稳定性:`ghostcard-${clientId}`。
 */

import { describe, it, expect } from 'vitest';
import { buildRenderItems, type RenderItem } from '../components/chat/MessageStream';
import type { ChatMessage } from '@/lib/makerChatStore';
import { makerChatStore } from '@/lib/makerChatStore';
import type { GhostCardSnapshot, GhostCardEntry, GhostLiveCard } from '@/cindy-brain/ghostCardStore';

const GHOST_TOOL = 'mcp__cindy__ghost_call';
const HASH = 'a'.repeat(64);
const IMG = `cindy-media://blobs/${HASH}.png`;

const mkGhostCall = (id: string, ghostId = 'cindy-art', tool = 'gen_image'): ChatMessage => ({
  clientId: id,
  role: 'tool_use',
  content: '',
  toolUseId: `tu-${id}`,
  toolName: GHOST_TOOL,
  toolInput: { ghost_id: ghostId, tool },
});

const mkResult = (id: string, toolUseId: string, body: Record<string, unknown>): ChatMessage => ({
  clientId: id,
  role: 'tool_result',
  content: JSON.stringify(body),
  toolUseId,
});

function snapshot(
  cards: Record<string, GhostCardEntry>,
  liveCards: GhostLiveCard[] = [],
): GhostCardSnapshot {
  return { version: 1, byCallId: new Map(Object.entries(cards)), liveCards };
}

const readyEntry = (ghostId = 'cindy-art'): GhostCardEntry => ({
  status: 'ready',
  ghostId,
  html: '<p>card</p>',
  height: 240,
});

function itemsOf(messages: ChatMessage[], snap?: GhostCardSnapshot): RenderItem[] {
  return buildRenderItems(messages, undefined, snap).items;
}

describe('ghost_card · settled 配对', () => {
  it('xdt_card_id + ready → ghost_card item,自身媒体被抑制', () => {
    const items = itemsOf(
      [
        mkGhostCall('g1'),
        mkResult('r1', 'tu-g1', { ok: true, xdt_card_id: 'call-1', xdt_image_urls: [IMG] }),
      ],
      snapshot({ 'call-1': readyEntry() }),
    );
    const card = items.find((it) => it.type === 'ghost_card');
    expect(card).toMatchObject({
      key: 'ghostcard-g1',
      callId: 'call-1',
      ghostId: 'cindy-art',
      tool: 'gen_image',
      settled: true,
    });
    expect(items.some((it) => it.type === 'tool_media')).toBe(false);
  });

  it('missing → 不出卡不抑制,走今日 generic 图卡', () => {
    const items = itemsOf(
      [
        mkGhostCall('g1'),
        mkResult('r1', 'tu-g1', { ok: true, xdt_card_id: 'call-1', xdt_image_urls: [IMG] }),
      ],
      snapshot({ 'call-1': { status: 'missing' } }),
    );
    expect(items.some((it) => it.type === 'ghost_card')).toBe(false);
    expect(items.some((it) => it.type === 'tool_media')).toBe(true);
  });

  it('loading/未知 → 抑制媒体但不出卡(等取件落定,无跳变)', () => {
    for (const snap of [snapshot({ 'call-1': { status: 'loading' } }), snapshot({})]) {
      const items = itemsOf(
        [
          mkGhostCall('g1'),
          mkResult('r1', 'tu-g1', { ok: true, xdt_card_id: 'call-1', xdt_image_urls: [IMG] }),
        ],
        snap,
      );
      expect(items.some((it) => it.type === 'ghost_card')).toBe(false);
      expect(items.some((it) => it.type === 'tool_media')).toBe(false);
    }
  });

  it('无 xdt_card_id → 逐像素今日行为(有媒体出 tool_media)', () => {
    const items = itemsOf(
      [mkGhostCall('g1'), mkResult('r1', 'tu-g1', { ok: true, xdt_image_urls: [IMG] })],
      snapshot({}),
    );
    expect(items.some((it) => it.type === 'ghost_card')).toBe(false);
    expect(items.some((it) => it.type === 'tool_media')).toBe(true);
  });

  it('同段其它工具的媒体不受供卡调用抑制影响', () => {
    const other: ChatMessage = {
      clientId: 'o1',
      role: 'tool_use',
      content: '',
      toolUseId: 'tu-o1',
      toolName: 'mcp__lizi_art__call_tool',
      toolInput: {},
    };
    const otherImg = `cindy-media://blobs/${'b'.repeat(64)}.png`;
    const items = itemsOf(
      [
        mkGhostCall('g1'),
        mkResult('r1', 'tu-g1', { ok: true, xdt_card_id: 'call-1', xdt_image_urls: [IMG] }),
        other,
        mkResult('r2', 'tu-o1', { ok: true, xdt_image_urls: [otherImg] }),
      ],
      snapshot({ 'call-1': readyEntry() }),
    );
    const media = items.find((it) => it.type === 'tool_media');
    expect(media && media.type === 'tool_media' ? media.items.map((m) => m.url) : []).toEqual([
      otherImg,
    ]);
    expect(items.some((it) => it.type === 'ghost_card')).toBe(true);
  });
});

describe('ghost_card · in-flight 锚定', () => {
  const live = (callId: string, over: Partial<GhostLiveCard> = {}): GhostLiveCard => ({
    callId,
    ghostId: 'cindy-art',
    toolUseId: null,
    receivedAt: 1,
    ...over,
  });

  it('renders a Pi card before its tool returns and restores the settled card from old history', () => {
    const sessionId = 'pi-card-regression';
    const content = { toolUseId: 'tu-pi', toolName: 'cindy_mcp_call_tool', input: {
      server: 'cindy', tool: 'ghost_call', args: { ghost_id: 'cindy-art', tool: 'show_card' },
    } };
    try {
      makerChatStore.__applyStreamEventForTest(sessionId, { sessionId, type: 'tool_use', data: content });
      const messages = makerChatStore.getSnapshot(sessionId).messages;
      const snap = snapshot({ 'call-pi': readyEntry() }, [live('call-pi')]);
      expect(itemsOf(messages, snap).find(item => item.type === 'ghost_card')).toMatchObject({
        callId: 'call-pi', tool: 'show_card', settled: false,
      });
      const history = makerChatStore.__mapServerMessagesForTest([{
        id: 'persisted-pi', clientId: 'persisted-pi', sessionId, role: 'tool_use', content,
        toolUseId: null, agentMeta: null,
        createdAt: '2026-09-08T00:00:00.000Z',
      }]);
      expect(itemsOf([...history, mkResult('result-pi', 'tu-pi', { xdt_card_id: 'call-pi' })], snap)
        .find(item => item.type === 'ghost_card')).toMatchObject({ callId: 'call-pi', settled: true });
    } finally { makerChatStore.purgeSession(sessionId); }
  });

  it('claude:活卡带 toolUseId 时精确锚到对应行', () => {
    const items = itemsOf(
      [mkGhostCall('g1'), mkGhostCall('g2')],
      snapshot(
        { 'call-2': readyEntry() },
        [live('call-2', { toolUseId: 'tu-g2' })],
      ),
    );
    const card = items.find((it) => it.type === 'ghost_card');
    expect(card).toMatchObject({ key: 'ghostcard-g2', callId: 'call-2', settled: false });
  });

  it('codex:无 toolUseId 的活卡按同 ghostId 最早未认领行按序认领', () => {
    const items = itemsOf(
      [mkGhostCall('g1'), mkGhostCall('g2')],
      snapshot(
        { 'call-1': readyEntry(), 'call-2': readyEntry() },
        [live('call-1'), live('call-2')],
      ),
    );
    const cards = items.filter((it) => it.type === 'ghost_card');
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({ key: 'ghostcard-g1', callId: 'call-1' });
    expect(cards[1]).toMatchObject({ key: 'ghostcard-g2', callId: 'call-2' });
  });

  it('ghostId 不同的活卡不被启发式误领', () => {
    const items = itemsOf(
      [mkGhostCall('g1', 'other-ghost')],
      snapshot({ 'call-1': readyEntry() }, [live('call-1')]),
    );
    expect(items.some((it) => it.type === 'ghost_card')).toBe(false);
  });

  it('已被 tool_result 认领(settled)的卡不再被活卡锚定', () => {
    const items = itemsOf(
      [
        mkGhostCall('g1'),
        mkResult('r1', 'tu-g1', { ok: true, xdt_card_id: 'call-1' }),
        mkGhostCall('g2'),
      ],
      snapshot({ 'call-1': readyEntry() }, [live('call-1')]),
    );
    const cards = items.filter((it) => it.type === 'ghost_card');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ key: 'ghostcard-g1', settled: true });
  });

  it('无快照(store 未初始化)零影响', () => {
    const items = itemsOf([
      mkGhostCall('g1'),
      mkResult('r1', 'tu-g1', { ok: true, xdt_card_id: 'call-1', xdt_image_urls: [IMG] }),
    ]);
    expect(items.some((it) => it.type === 'ghost_card')).toBe(false);
    expect(items.some((it) => it.type === 'tool_media')).toBe(true);
  });
});

describe('ghost_card · 媒体回锚(xdt_anchor_card_id)', () => {
  const VIDEO = `cindy-media://blobs/${'c'.repeat(64)}.mp4`;
  // 提交调用(开卡)+ 轮询调用(出媒体带锚)的标准两段式消息流。
  const submitAndPoll = (pollBody: Record<string, unknown>, pollGhostId = 'xd-mivo') => [
    mkGhostCall('g1', 'xd-mivo', 'submit_gen_video'),
    mkResult('r1', 'tu-g1', { ok: true, xdt_card_id: 'call-1' }),
    mkGhostCall('g2', pollGhostId, 'poll_result'),
    mkResult('r2', 'tu-g2', pollBody),
  ];

  it('锚到同 ghost 已上屏卡 → 媒体挂卡 item,不出 tool_media', () => {
    const items = itemsOf(
      submitAndPoll({ ok: true, xdt_anchor_card_id: 'call-1', xdt_video_urls: [VIDEO] }),
      snapshot({ 'call-1': readyEntry('xd-mivo') }),
    );
    const card = items.find((it) => it.type === 'ghost_card');
    expect(card && card.type === 'ghost_card' ? card.media?.map((m) => m.url) : []).toEqual([
      VIDEO,
    ]);
    expect(items.some((it) => it.type === 'tool_media')).toBe(false);
  });

  it('锚指向未上屏的卡 → 回退轮询位置 tool_media', () => {
    const items = itemsOf(
      submitAndPoll({ ok: true, xdt_anchor_card_id: 'call-unknown', xdt_video_urls: [VIDEO] }),
      snapshot({ 'call-1': readyEntry('xd-mivo') }),
    );
    const card = items.find((it) => it.type === 'ghost_card');
    expect(card && card.type === 'ghost_card' ? card.media : undefined).toBeUndefined();
    const media = items.find((it) => it.type === 'tool_media');
    expect(media && media.type === 'tool_media' ? media.items.map((m) => m.url) : []).toEqual([
      VIDEO,
    ]);
  });

  it('异 ghost 伪锚(轮询调用 ghost_id 与卡不符)→ 回退 tool_media', () => {
    const items = itemsOf(
      submitAndPoll(
        { ok: true, xdt_anchor_card_id: 'call-1', xdt_video_urls: [VIDEO] },
        'evil-ghost',
      ),
      snapshot({ 'call-1': readyEntry('xd-mivo') }),
    );
    const card = items.find((it) => it.type === 'ghost_card');
    expect(card && card.type === 'ghost_card' ? card.media : undefined).toBeUndefined();
    expect(items.some((it) => it.type === 'tool_media')).toBe(true);
  });

  it('重复轮询同一任务 → 同 URL 去重,卡下只挂一份', () => {
    const items = itemsOf(
      [
        ...submitAndPoll({ ok: true, xdt_anchor_card_id: 'call-1', xdt_video_urls: [VIDEO] }),
        mkGhostCall('g3', 'xd-mivo', 'poll_result'),
        mkResult('r3', 'tu-g3', { ok: true, xdt_anchor_card_id: 'call-1', xdt_video_urls: [VIDEO] }),
      ],
      snapshot({ 'call-1': readyEntry('xd-mivo') }),
    );
    const card = items.find((it) => it.type === 'ghost_card');
    expect(card && card.type === 'ghost_card' ? card.media?.map((m) => m.url) : []).toEqual([
      VIDEO,
    ]);
    expect(items.some((it) => it.type === 'tool_media')).toBe(false);
  });

  it('非 ghost_call 工具带锚字段 → 不采纳,走 generic tool_media', () => {
    const other: ChatMessage = {
      clientId: 'o1',
      role: 'tool_use',
      content: '',
      toolUseId: 'tu-o1',
      toolName: 'mcp__lizi_art__call_tool',
      toolInput: {},
    };
    const items = itemsOf(
      [
        mkGhostCall('g1', 'xd-mivo', 'submit_gen_video'),
        mkResult('r1', 'tu-g1', { ok: true, xdt_card_id: 'call-1' }),
        other,
        mkResult('r2', 'tu-o1', { ok: true, xdt_anchor_card_id: 'call-1', xdt_video_urls: [VIDEO] }),
      ],
      snapshot({ 'call-1': readyEntry('xd-mivo') }),
    );
    const card = items.find((it) => it.type === 'ghost_card');
    expect(card && card.type === 'ghost_card' ? card.media : undefined).toBeUndefined();
    expect(items.some((it) => it.type === 'tool_media')).toBe(true);
  });

  it('活卡(in-flight)同样可被回锚(极端时序:媒体先于 settle 到达)', () => {
    const items = itemsOf(
      [
        mkGhostCall('g1', 'xd-mivo', 'submit_gen_video'),
        mkGhostCall('g2', 'xd-mivo', 'poll_result'),
        mkResult('r2', 'tu-g2', { ok: true, xdt_anchor_card_id: 'call-1', xdt_video_urls: [VIDEO] }),
      ],
      snapshot({ 'call-1': readyEntry('xd-mivo') }, [
        { callId: 'call-1', ghostId: 'xd-mivo', toolUseId: 'tu-g1', receivedAt: 1 },
      ]),
    );
    const card = items.find((it) => it.type === 'ghost_card');
    expect(card && card.type === 'ghost_card' ? card.media?.map((m) => m.url) : []).toEqual([
      VIDEO,
    ]);
    expect(items.some((it) => it.type === 'tool_media')).toBe(false);
  });
});

describe('ghost_card · 音频入卡令牌(xdt_audio_in_card,验证后才压基座)', () => {
  const AUDIO = `cindy-media://blobs/${'d'.repeat(64)}.mp3`;
  const pollWithAudio = (pollGhostId = 'xd-mivo') => [
    mkGhostCall('g1', 'xd-mivo', 'submit_gen_music'),
    mkResult('r1', 'tu-g1', { ok: true, xdt_card_id: 'call-1' }),
    mkGhostCall('g2', pollGhostId, 'poll_result'),
    mkResult('r2', 'tu-g2', {
      ok: true,
      xdt_audio_in_card: true,
      xdt_anchor_card_id: 'call-1',
      xdt_audio_tracks: [{ kind: 'music', xdt_audio_url: AUDIO, title: '歌' }],
    }),
  ];
  const cardWithSlot = (ghostId = 'xd-mivo'): GhostCardEntry => ({
    status: 'ready',
    ghostId,
    html: `<div><div data-ghost-audio="${AUDIO}"></div></div>`,
    height: 240,
  });

  it('锚到的同 ghost 卡真含对应插槽 → 基座音频卡被压(卡内播放器是唯一出口)', () => {
    const items = itemsOf(pollWithAudio(), snapshot({ 'call-1': cardWithSlot() }));
    const card = items.find((it) => it.type === 'ghost_card');
    expect(card && card.type === 'ghost_card' ? card.media : undefined).toBeUndefined();
    expect(items.some((it) => it.type === 'tool_media')).toBe(false);
  });

  it('卡 html 不含对应插槽(card-update 被拒等)→ 音频保留,挂卡下渲染', () => {
    const items = itemsOf(pollWithAudio(), snapshot({ 'call-1': readyEntry('xd-mivo') }));
    const card = items.find((it) => it.type === 'ghost_card');
    expect(card && card.type === 'ghost_card' ? card.media?.map((m) => m.url) : []).toEqual([
      AUDIO,
    ]);
  });

  it('无卡可锚(远程控制端看不到卡)→ 音频保留在轮询位置 tool_media', () => {
    const items = itemsOf(pollWithAudio(), snapshot({}));
    const media = items.find((it) => it.type === 'tool_media');
    expect(media && media.type === 'tool_media' ? media.items.map((m) => m.url) : []).toEqual([
      AUDIO,
    ]);
  });

  it('异 ghost 伪锚 + 令牌 → 不压不挂,回退轮询位置渲染', () => {
    const items = itemsOf(pollWithAudio('evil-ghost'), snapshot({ 'call-1': cardWithSlot() }));
    expect(items.some((it) => it.type === 'tool_media')).toBe(true);
    const card = items.find((it) => it.type === 'ghost_card');
    expect(card && card.type === 'ghost_card' ? card.media : undefined).toBeUndefined();
  });
});

describe('ghost_card · 行合并(卡片是该次调用的唯一呈现)', () => {
  it('settled + ready:该 ghost_call 不进 tool_segment(独占段时段消失)', () => {
    const items = itemsOf(
      [mkGhostCall('g1'), mkResult('r1', 'tu-g1', { ok: true, xdt_card_id: 'call-1' })],
      snapshot({ 'call-1': readyEntry() }),
    );
    expect(items.some((it) => it.type === 'tool_segment')).toBe(false);
    expect(items.some((it) => it.type === 'ghost_card')).toBe(true);
  });

  it('missing:回退今日渲染,工具行照旧', () => {
    const items = itemsOf(
      [mkGhostCall('g1'), mkResult('r1', 'tu-g1', { ok: true, xdt_card_id: 'call-1' })],
      snapshot({ 'call-1': { status: 'missing' } }),
    );
    expect(items.some((it) => it.type === 'tool_segment')).toBe(true);
    expect(items.some((it) => it.type === 'ghost_card')).toBe(false);
  });

  it('同段其它工具行保留,仅供卡的 ghost_call 隐身', () => {
    const other: ChatMessage = {
      clientId: 'o1',
      role: 'tool_use',
      content: '',
      toolUseId: 'tu-o1',
      toolName: 'Read',
      toolInput: {},
    };
    const items = itemsOf(
      [
        mkGhostCall('g1'),
        mkResult('r1', 'tu-g1', { ok: true, xdt_card_id: 'call-1' }),
        other,
        mkResult('r2', 'tu-o1', { ok: true }),
      ],
      snapshot({ 'call-1': readyEntry() }),
    );
    const seg = items.find((it) => it.type === 'tool_segment');
    expect(seg && seg.type === 'tool_segment' ? seg.toolCalls.map((c) => c.clientId) : []).toEqual(
      ['o1'],
    );
    expect(items.some((it) => it.type === 'ghost_card')).toBe(true);
  });

  it('ghost_card item 携带原始 tool_use(头带展开区数据源)', () => {
    const items = itemsOf(
      [mkGhostCall('g1'), mkResult('r1', 'tu-g1', { ok: true, xdt_card_id: 'call-1' })],
      snapshot({ 'call-1': readyEntry() }),
    );
    const card = items.find((it) => it.type === 'ghost_card');
    expect(card && card.type === 'ghost_card' ? card.toolCall.clientId : null).toBe('g1');
  });
});

describe('ghost_card · 图片入卡令牌(xdt_images_in_card,验证后才压基座)', () => {
  const IMG = `cindy-media://blobs/${'f'.repeat(64)}.png`;
  const pollWithImage = (pollGhostId = 'xd-mivo') => [
    mkGhostCall('g1', 'xd-mivo', 'submit_gen_image'),
    mkResult('r1', 'tu-g1', { ok: true, xdt_card_id: 'call-1' }),
    mkGhostCall('g2', pollGhostId, 'poll_result'),
    mkResult('r2', 'tu-g2', {
      ok: true,
      xdt_images_in_card: true,
      xdt_anchor_card_id: 'call-1',
      xdt_image_urls: [IMG],
    }),
  ];
  const cardWithImg = (ghostId = 'xd-mivo'): GhostCardEntry => ({
    status: 'ready',
    ghostId,
    html: `<div><img src="${IMG}"></div>`,
    height: 300,
  });

  it('锚到的同 ghost 卡真含对应图片 → 基座图卡被压(卡内图是唯一出口)', () => {
    const items = itemsOf(pollWithImage(), snapshot({ 'call-1': cardWithImg() }));
    const card = items.find((it) => it.type === 'ghost_card');
    expect(card && card.type === 'ghost_card' ? card.media : undefined).toBeUndefined();
    expect(items.some((it) => it.type === 'tool_media')).toBe(false);
  });

  it('卡 html 不含对应图片(card-update 被拒等)→ 图片保留,挂卡下渲染', () => {
    const items = itemsOf(pollWithImage(), snapshot({ 'call-1': readyEntry('xd-mivo') }));
    const card = items.find((it) => it.type === 'ghost_card');
    expect(card && card.type === 'ghost_card' ? card.media?.map((m) => m.url) : []).toEqual([
      IMG,
    ]);
  });

  it('无卡可锚(远程控制端看不到卡)→ 图片保留在轮询位置 tool_media', () => {
    const items = itemsOf(pollWithImage(), snapshot({}));
    const media = items.find((it) => it.type === 'tool_media');
    expect(media && media.type === 'tool_media' ? media.items.map((m) => m.url) : []).toEqual([
      IMG,
    ]);
  });

  it('异 ghost 伪锚(别的意识拿到 callId)→ 不压,图片照常渲染', () => {
    const items = itemsOf(pollWithImage('cindy-art'), snapshot({ 'call-1': cardWithImg() }));
    const hasImage =
      items.some((it) => it.type === 'tool_media' && it.items.some((m) => m.url === IMG)) ||
      items.some(
        (it) => it.type === 'ghost_card' && (it.media ?? []).some((m) => m.url === IMG),
      );
    expect(hasImage).toBe(true);
  });
});
