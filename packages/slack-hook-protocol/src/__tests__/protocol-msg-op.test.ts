/**
 * slack-hook-protocol 阶段 20(msg.op 消息操作动词)测试:
 *   1. 六种动作的构造 → 序列化 → 解析 round-trip
 *   2. 幂等键 opId 与授权锚点 scope.externalKey 缺失即拒收
 *   3. msg.op.result 的 messageId 契约(客户端后续 edit/delete/react 的唯一依据)
 *   4. 能力标识常量 msg-op-v1
 *   5. 老端兼容: 不认识 msg.op 的端按未知类型拒收(丢帧不断连语义)
 */

import { describe, it, expect } from 'vitest';

import {
  HOOK_FEATURE_MESSAGE_OPS,
  HOOK_FEATURE_TELEGRAM_CARD_OPS,
  HOOK_FEATURE_TELEGRAM_COMMANDS,
  HOOK_FEATURE_TELEGRAM_FINAL_OPS,
  HOOK_FEATURE_TELEGRAM_PROGRESS_OPS,
  makeProviderCommandsSet,
  makeTurnEnd,
  MESSAGE_OP_ERROR_OUTCOME_UNKNOWN,
  MESSAGE_OP_ERROR_PROGRESS_UNAVAILABLE,
  makeMessageOp,
  makeMessageOpResult,
  parseHookMessage,
  serializeHookMessage,
  type HookMessage,
  type MessageOpAction,
} from '../index';

function roundTrip(message: HookMessage): HookMessage {
  const parsed = parseHookMessage(serializeHookMessage(message));
  if (!parsed.ok) throw new Error(`parse failed: ${parsed.error}`);
  return parsed.message;
}

const SCOPE = { externalKey: 'telegram:group:bot:−100:111:g1' };

function op(action: MessageOpAction, opId = 'op-1') {
  return makeMessageOp({ opId, requestId: 'req-1', scope: SCOPE, action });
}

describe('msg.op 动词集', () => {
  it('能力标识为 msg-op-v1', () => {
    expect(HOOK_FEATURE_MESSAGE_OPS).toBe('msg-op-v1');
  });

  it('六种动作都能 round-trip 且形态原样保留', () => {
    const actions: MessageOpAction[] = [
      {
        kind: 'send',
        text: '已渲染的最终正文',
        replyToMessageId: '42',
        tier: 'rich',
        buttons: [[{ token: 'cdy:abc', label: '同意' }]],
      },
      { kind: 'edit', messageId: '43', text: '改后的正文', tier: 'html' },
      { kind: 'delete', messageId: '44' },
      { kind: 'react', targetMessageId: '45', emoji: '👍', big: true },
      { kind: 'typing' },
      {
        kind: 'media',
        album: true,
        items: [{ name: 'a.png', mimeType: 'image/png', dataBase64: 'AAAA' }],
      },
    ];
    for (const action of actions) {
      const parsed = roundTrip(op(action));
      expect(parsed.type).toBe('msg.op');
      expect(parsed.payload).toMatchObject({ opId: 'op-1', scope: SCOPE, action });
    }
  });

  it('react 的空 emoji 是撤销语义, 合法', () => {
    const parsed = roundTrip(op({ kind: 'react', targetMessageId: '46', emoji: '' }));
    expect((parsed.payload as { action: { emoji: string } }).action.emoji).toBe('');
  });

  it('scope 携带 chatId / threadId 一律拒收(寻址权不在客户端)', () => {
    // 目标 chat 必须由服务端从 lane 记录里取。允许客户端指定, 一台被攻陷或有
    // bug 的桌面就能越过自己 lane 的边界往任意聊天发消息。
    for (const extra of [{ chatId: '-100999' }, { threadId: '7' }]) {
      const frame = JSON.parse(serializeHookMessage(op({ kind: 'typing' }))) as Record<
        string,
        unknown
      >;
      Object.assign((frame.payload as { scope: Record<string, unknown> }).scope, extra);
      const parsed = parseHookMessage(JSON.stringify(frame));
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain('resolves the target from externalKey');
    }
  });

  it('缺 opId 或 scope.externalKey 一律拒收', () => {
    // opId 是断连重发下不产生重复消息的唯一依据(Telegram 无发送端幂等键),
    // externalKey 是多租户授权锚点 —— 两者都不能让服务端"尽力而为"地猜。
    const base = op({ kind: 'typing' });
    const noOpId = JSON.parse(serializeHookMessage(base)) as Record<string, unknown>;
    (noOpId.payload as Record<string, unknown>).opId = '';
    expect(parseHookMessage(JSON.stringify(noOpId)).ok).toBe(false);

    const noKey = JSON.parse(serializeHookMessage(base)) as Record<string, unknown>;
    (noKey.payload as { scope: Record<string, unknown> }).scope = {};
    expect(parseHookMessage(JSON.stringify(noKey)).ok).toBe(false);
  });

  it('未知动作类型拒收', () => {
    const base = op({ kind: 'typing' });
    const bad = JSON.parse(serializeHookMessage(base)) as Record<string, unknown>;
    (bad.payload as { action: Record<string, unknown> }).action = { kind: 'teleport' };
    const parsed = parseHookMessage(JSON.stringify(bad));
    expect(parsed.ok).toBe(false);
  });

  it('msg.op.result 带 messageId 与相册全量 id, 并支持 retryAfterMs', () => {
    const ok = roundTrip(
      makeMessageOpResult({ opId: 'op-1', ok: true, messageId: '99', messageIds: ['99', '100'] }),
    );
    expect(ok.payload).toMatchObject({ ok: true, messageId: '99', messageIds: ['99', '100'] });

    const failed = roundTrip(
      makeMessageOpResult({ opId: 'op-2', ok: false, error: 'flood', retryAfterMs: 26_000 }),
    );
    // retry_after 全值透传, 不在协议层设上限 —— 固定 clamp 会让重试落回 flood 窗口。
    expect(failed.payload).toMatchObject({ ok: false, retryAfterMs: 26_000 });
  });

  it('老端按未知类型拒收整帧(丢帧不断连)', () => {
    const frame = JSON.parse(serializeHookMessage(op({ kind: 'typing' }))) as Record<
      string,
      unknown
    >;
    frame.type = 'msg.op.future-verb';
    const parsed = parseHookMessage(JSON.stringify(frame));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('unknown message type');
  });
});

/** 拿一帧合法信封换掉 payload(只让 payload 本身决定解析结果)。 */
function withPayload(message: HookMessage, payload: Record<string, unknown>): string {
  const frame = JSON.parse(serializeHookMessage(message)) as Record<string, unknown>;
  frame.payload = payload;
  return JSON.stringify(frame);
}

describe('telegram-progress-ops-v1: 进度消息由客户端渲染、经 msg.op 驱动', () => {
  it('能力标识与服务端同名', () => {
    expect(HOOK_FEATURE_TELEGRAM_PROGRESS_OPS).toBe('telegram-progress-ops-v1');
  });

  it('purpose=turn-progress 的 send / edit 原样 round-trip', () => {
    for (const action of [
      { kind: 'send', text: '<b>x</b>', tier: 'html', silent: true },
      { kind: 'edit', messageId: '9', text: 'x', tier: 'plain' },
    ] as MessageOpAction[]) {
      const parsed = roundTrip(
        makeMessageOp({ opId: 'req-1:progress:x', requestId: 'req-1', scope: SCOPE, action, purpose: 'turn-progress' }),
      );
      expect(parsed.payload).toMatchObject({ purpose: 'turn-progress', requestId: 'req-1', action });
    }
  });

  it('purpose 缺 requestId、用在非 send/edit、或取未知值一律拒收', () => {
    const cases: Array<Record<string, unknown>> = [
      { opId: 'a', scope: SCOPE, purpose: 'turn-progress', action: { kind: 'send', text: 'x' } },
      { opId: 'a', requestId: 'r', scope: SCOPE, purpose: 'turn-progress', action: { kind: 'react', targetMessageId: '1', emoji: '' } },
      { opId: 'a', requestId: 'r', scope: SCOPE, purpose: 'final', action: { kind: 'send', text: 'x' } },
      // 继承属性名不能当成合法 purpose(查表只认自有键), 也不能让解析器抛异常。
      ...['constructor', '__proto__', 'toString', 'hasOwnProperty'].map((purpose) => ({
        opId: 'a',
        requestId: 'r',
        scope: SCOPE,
        purpose,
        action: { kind: 'send', text: 'x' },
      })),
    ];
    for (const payload of cases) {
      const parsed = parseHookMessage(withPayload(op({ kind: 'typing' }), payload));
      expect(parsed.ok).toBe(false);
    }
  });

  it('不带 purpose 的 msg.op 与本能力出现前逐字相同(老帧照常解析)', () => {
    const parsed = roundTrip(op({ kind: 'send', text: 'x' }));
    expect((parsed.payload as { purpose?: unknown }).purpose).toBeUndefined();
  });

  it('msg.op.result 的 errorCode / channelErrorCode 可选; 类型错误拒收', () => {
    const channel = roundTrip(
      makeMessageOpResult({ opId: 'o', ok: false, error: "Bad Request: can't parse entities", channelErrorCode: 400 }),
    );
    expect(channel.payload).toMatchObject({ channelErrorCode: 400 });
    const server = roundTrip(
      makeMessageOpResult({ opId: 'o', ok: false, errorCode: MESSAGE_OP_ERROR_PROGRESS_UNAVAILABLE, channelErrorCode: null }),
    );
    expect(server.payload).toMatchObject({ errorCode: 'PROGRESS_UNAVAILABLE', channelErrorCode: null });
    expect(MESSAGE_OP_ERROR_OUTCOME_UNKNOWN).toBe('OUTCOME_UNKNOWN');
    for (const bad of [{ errorCode: '' }, { errorCode: 3 }, { channelErrorCode: '400' }, { channelErrorCode: 4.5 }]) {
      const parsed = parseHookMessage(
        withPayload(makeMessageOpResult({ opId: 'o', ok: false }), { opId: 'o', ok: false, ...bad }),
      );
      expect(parsed.ok).toBe(false);
    }
  });
});

describe('telegram 终稿 / 卡片 / 命令菜单由客户端发布', () => {
  const parseOp = (payload: Record<string, unknown>) =>
    parseHookMessage(withPayload(op({ kind: 'typing' }), payload));

  it('能力标识与服务端同名', () => {
    expect([
      HOOK_FEATURE_TELEGRAM_FINAL_OPS,
      HOOK_FEATURE_TELEGRAM_CARD_OPS,
      HOOK_FEATURE_TELEGRAM_COMMANDS,
    ]).toEqual(['telegram-final-ops-v1', 'telegram-card-ops-v1', 'telegram-commands-v1']);
  });

  it('turn-final: send / media 带 finalPart round-trip; 缺 finalPart 或用在 edit 拒收', () => {
    const sendFinal = roundTrip(
      makeMessageOp({
        opId: 'r:final:0',
        requestId: 'r',
        scope: SCOPE,
        purpose: 'turn-final',
        finalPart: 0,
        action: { kind: 'send', text: '**答案**', tier: 'rich', effectId: '5107584321108051014' },
      }),
    );
    expect(sendFinal.payload).toMatchObject({ purpose: 'turn-final', finalPart: 0 });
    const media = roundTrip(
      makeMessageOp({
        opId: 'r:final:1',
        requestId: 'r',
        scope: SCOPE,
        purpose: 'turn-final',
        finalPart: 1,
        action: { kind: 'media', album: true, items: [{ name: 'a.png', mimeType: 'image/png', dataBase64: 'AA' }] },
      }),
    );
    expect(media.payload).toMatchObject({ finalPart: 1 });

    for (const payload of [
      { opId: 'a', requestId: 'r', scope: SCOPE, purpose: 'turn-final', action: { kind: 'send', text: 'x' } },
      { opId: 'a', requestId: 'r', scope: SCOPE, purpose: 'turn-final', finalPart: -1, action: { kind: 'send', text: 'x' } },
      { opId: 'a', requestId: 'r', scope: SCOPE, purpose: 'turn-final', finalPart: 0, action: { kind: 'edit', messageId: '1', text: 'x' } },
      { opId: 'a', requestId: 'r', scope: SCOPE, finalPart: 0, action: { kind: 'send', text: 'x' } },
      { opId: 'a', requestId: 'r', scope: SCOPE, purpose: 'turn-progress', finalPart: 0, action: { kind: 'send', text: 'x' } },
      { opId: 'a', requestId: 'r', scope: SCOPE, action: { kind: 'edit', messageId: '1', text: 'x', effectId: 'e' } },
    ]) {
      expect(parseOp(payload).ok).toBe(false);
    }
  });

  it('interaction-card: send 带按钮、收口 edit 清键盘; 缺 interactionId 或错位字段拒收', () => {
    const send = roundTrip(
      makeMessageOp({
        opId: 'r:card:i1:send',
        requestId: 'r',
        scope: SCOPE,
        purpose: 'interaction-card',
        interactionId: 'i1',
        action: {
          kind: 'send',
          text: '<b>🔐 权限请求</b>',
          tier: 'html',
          buttons: [[{ token: 'perm:allow', label: '允许一次' }, { token: 'perm:deny', label: '拒绝' }]],
        },
      }),
    );
    expect(send.payload).toMatchObject({ interactionId: 'i1' });
    const close = roundTrip(
      makeMessageOp({
        opId: 'r:card:i1:close',
        requestId: 'r',
        scope: SCOPE,
        purpose: 'interaction-card',
        interactionId: 'i1',
        interactionClosed: true,
        action: { kind: 'edit', messageId: '9', text: '已拒绝', tier: 'html', buttons: [] },
      }),
    );
    expect(close.payload).toMatchObject({ interactionClosed: true, action: { buttons: [] } });

    for (const payload of [
      { opId: 'a', requestId: 'r', scope: SCOPE, purpose: 'interaction-card', action: { kind: 'send', text: 'x' } },
      { opId: 'a', requestId: 'r', scope: SCOPE, purpose: 'interaction-card', interactionId: 'i', interactionClosed: true, action: { kind: 'send', text: 'x' } },
      { opId: 'a', requestId: 'r', scope: SCOPE, interactionId: 'i', action: { kind: 'send', text: 'x' } },
      { opId: 'a', requestId: 'r', scope: SCOPE, purpose: 'interaction-card', interactionId: 'i', action: { kind: 'send', text: 'x', buttons: [[{ token: '', label: 'x' }]] } },
    ]) {
      expect(parseOp(payload).ok).toBe(false);
    }
  });

  it('turn.end.clientFinal 可选; 形状错误拒收', () => {
    const end = (clientFinal?: unknown) =>
      makeTurnEnd({
        requestId: 'r',
        externalKey: SCOPE.externalKey,
        sessionId: null,
        status: 'ok',
        finalText: 'x',
        errorMessage: null,
        usage: { durationMs: 1 },
        ...(clientFinal !== undefined ? { clientFinal: clientFinal as { complete: boolean } } : {}),
      });
    expect(roundTrip(end({ complete: true })).payload).toMatchObject({ clientFinal: { complete: true } });
    expect((roundTrip(end()).payload as { clientFinal?: unknown }).clientFinal).toBeUndefined();
    expect(parseHookMessage(serializeHookMessage(end({ complete: 'yes' }))).ok).toBe(false);
  });

  it('provider.commands.set: 默认菜单必须有且唯一, 命令名与描述遵守 Telegram 限制', () => {
    const ok = makeProviderCommandsSet({
      provider: 'telegram',
      menus: [
        { languageCode: null, commands: [{ command: 'new', description: 'Create a new task' }] },
        { languageCode: 'zh', commands: [{ command: 'new', description: '新建任务' }] },
      ],
    });
    expect(roundTrip(ok).payload).toEqual(ok.payload);
    for (const menus of [
      [{ languageCode: 'zh', commands: [] }],
      [{ languageCode: null, commands: [] }, { languageCode: null, commands: [] }],
      [{ languageCode: null, commands: [{ command: 'New', description: 'x' }] }],
      [{ languageCode: null, commands: [{ command: 'new', description: '' }] }],
      [{ languageCode: 'zh-CN', commands: [] }, { languageCode: null, commands: [] }],
    ]) {
      expect(parseHookMessage(withPayload(ok, { provider: 'telegram', menus })).ok).toBe(false);
    }
  });
});
