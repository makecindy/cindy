import { describe, expect, it, vi } from 'vitest';

import { TELEGRAM_PERSONAL_CAPABILITIES } from '@cindy/im';
import type { AgentEvent } from '@cindy/maker-core';

import {
  composeProgressView,
  createProgressEmitter,
  createTurnPresenter,
  DEFAULT_PRESENTER_POLICY,
  PERSONAL_DRIVER_CAPABILITIES,
  PROGRESS_SNAPSHOT_MAX_CHARS,
  PROGRESS_THROTTLE_MS,
  progressDedupeBaseline,
  shouldEmitProgressFrame,
} from '../turnPresenter';

/** 造一个 text 事件(带可选 source / agentMeta), 保持与 translator 透出的形状一致。 */
function text(
  body: string,
  isFinal: boolean,
  extra: { source?: string; agentMeta?: { uuid?: string; requestId?: string } } = {},
): AgentEvent {
  return { type: 'text', data: { text: body, isFinal }, ...extra } as unknown as AgentEvent;
}

function toolUse(toolName: string, toolUseId: string): AgentEvent {
  return { type: 'tool_use', data: { toolName, toolUseId, input: {} } } as unknown as AgentEvent;
}

describe('composeProgressView — 过程区/正文合成骨架(两侧共用)', () => {
  it('有过程区时过程区在上、正文在下', () => {
    expect(composeProgressView('⚙️ 工作中', '答案')).toBe('⚙️ 工作中\n\n答案');
  });
  it('无过程区时只留正文', () => {
    expect(composeProgressView('', '答案')).toBe('答案');
  });
  it('有过程区、无正文时只留过程区', () => {
    expect(composeProgressView('⚙️ 工作中', '')).toBe('⚙️ 工作中');
  });
});

describe('createTurnPresenter — buffer-replace 策略(个人 IM 渠道现有行为)', () => {
  it('isFinal 用该条全文整体替换缓冲, 流式增量追加', () => {
    const p = createTurnPresenter({ mode: 'buffer-replace' });
    p.applyText(text('前半', false));
    p.applyText(text('前半后半', true));
    p.applyText(text('，继续', false));
    expect(p.wholeText()).toBe('前半后半，继续');
    // buffer 模式下 finalText / progressBody 都是整段缓冲。
    expect(p.finalText()).toBe('前半后半，继续');
    expect(p.progressBody()).toBe('前半后半，继续');
  });

  it('applyText 对非字符串 text 返回 false, 不落正文', () => {
    const p = createTurnPresenter({ mode: 'buffer-replace' });
    expect(p.applyText({ type: 'text', data: {} } as unknown as AgentEvent)).toBe(false);
    expect(p.wholeText()).toBe('');
  });

  it('replaceBody 整体替换(本地图片物化回写 / 收口重置)', () => {
    const p = createTurnPresenter({ mode: 'buffer-replace' });
    p.applyText(text('原文', true));
    p.replaceBody('物化后的文本');
    expect(p.wholeText()).toBe('物化后的文本');
    p.replaceBody('');
    expect(p.wholeText()).toBe('');
  });

  it('seal / markInteractionBoundary 在 buffer 模式下不改变正文(无消息边界切分)', () => {
    const p = createTurnPresenter({ mode: 'buffer-replace' });
    p.applyText(text('结论', true));
    // buffer 模式没有定稿段/render 投影, seal 与交互边界都是正文层面的 no-op。
    p.seal();
    p.markInteractionBoundary();
    expect(p.wholeText()).toBe('结论');
    expect(p.finalText()).toBe('结论');
    // 注: turnRunner 的事件分发对 thinking 直接 return, 从不把 thinking 路由给
    // presenter —— 故 buffer 模式的正文永远不受 thinking 影响。
  });
});

describe('createTurnPresenter — finalized-segments 策略(官方 bot 现有行为)', () => {
  it('isFinal 逐条追加进已定稿段, 不整体替换; 多消息 turn 的正文全部保留', () => {
    const p = createTurnPresenter({ mode: 'finalized-segments' });
    p.applyText(text('先回一句。', true, { source: 'codex' }));
    p.applyText(text('最终结论。', true, { source: 'codex' }));
    // wholeText 保留两段(整段拼接), 不会只剩最后一条。
    expect(p.wholeText()).toBe('先回一句。\n\n最终结论。');
  });

  it('progressBody 只展示当前 / 最后一条消息, 而非整轮', () => {
    const p = createTurnPresenter({ mode: 'finalized-segments' });
    p.applyText(text('第一段。', true, { source: 'codex' }));
    p.applyText(text('第二段。', true, { source: 'codex' }));
    expect(p.progressBody()).toBe('第二段。');
  });

  it('progressBodyMode=whole 时进度发射器展示整轮累计正文', () => {
    vi.useFakeTimers();
    try {
      const frames: string[] = [];
      const p = createTurnPresenter({
        mode: 'finalized-segments',
        progressBodyMode: 'whole',
        onProgress: (frame) => void frames.push(frame),
      });
      p.applyText(text('第一段。', true, { source: 'codex' }));
      p.scheduleProgress();
      vi.advanceTimersByTime(0);
      p.applyText(text('第二段。', true, { source: 'codex' }));
      p.flushProgress();

      expect(frames.at(-1)).toContain('第一段。\n\n第二段。');
      p.stopProgress();
    } finally {
      vi.useRealTimers();
    }
  });

  it('whole 累计视图超过单帧上限时退回当前消息，不把最新答案截在末尾', () => {
    vi.useFakeTimers();
    try {
      const frames: string[] = [];
      const p = createTurnPresenter({
        mode: 'finalized-segments',
        progressBodyMode: 'whole',
        onProgress: (frame) => void frames.push(frame),
        policy: { ...DEFAULT_PRESENTER_POLICY, intermediateMaxRenderedChars: 12 },
      });
      p.applyText(text('很长的第一段内容。', true, { source: 'codex' }));
      p.applyText(text('最新答案。', true, { source: 'codex' }));
      p.flushProgress();

      expect(frames.at(-1)).toContain('最新答案。');
      expect(frames.at(-1)).not.toContain('很长的第一段内容。');
      p.stopProgress();
    } finally {
      vi.useRealTimers();
    }
  });

  it('claude 同一条消息(同 uuid)的相邻文本块连拼, 不同消息空行分隔', () => {
    const p = createTurnPresenter({ mode: 'finalized-segments' });
    p.applyText(text('前半', true, { source: 'claude-code', agentMeta: { uuid: 'm1' } }));
    p.applyText(text('后半。', true, { source: 'claude-code', agentMeta: { uuid: 'm1' } }));
    p.applyText(text('第二条。', true, { source: 'claude-code', agentMeta: { uuid: 'm2' } }));
    p.seal();
    expect(p.finalText()).toBe('前半后半。\n\n第二条。');
  });

  it('envelope 缺 uuid 时按 requestId 认消息边界', () => {
    const p = createTurnPresenter({ mode: 'finalized-segments' });
    p.applyText(text('结论: 分两块。', true, { source: 'claude-code', agentMeta: { requestId: 'msg_b' } }));
    p.applyText(text('第二块同一条。', true, { source: 'claude-code', agentMeta: { requestId: 'msg_b' } }));
    p.seal();
    // 同 requestId → 同一条消息, 两块连拼成一段。
    expect(p.wholeText()).toBe('结论: 分两块。第二块同一条。');
  });

  it('claude result 的 fallbackTail(无 agentMeta)与已流增量原样接上, 不误判前缀', () => {
    const p = createTurnPresenter({ mode: 'finalized-segments' });
    p.applyText(text('最终答案是 4', false)); // 流式增量
    p.applyText(text('2。', true, { source: 'claude-code' })); // fallbackTail: 只含缺失尾段
    p.seal();
    expect(p.wholeText()).toContain('最终答案是 42。');
    expect(p.wholeText()).not.toContain('4\n\n2');
  });

  it('finalText 按桌面消息流折叠动作前的短旁白, 保留动作后的正式答复', () => {
    const p = createTurnPresenter({ mode: 'finalized-segments' });
    p.applyText(text('我先看看这个链接。', true, { source: 'claude-code', agentMeta: { uuid: 'a' } }));
    p.applyToolUse(toolUse('WebFetch', 'u1'));
    p.applyText(text('结论: 已停止维护。', true, { source: 'claude-code', agentMeta: { uuid: 'b' } }));
    p.seal();
    expect(p.finalText()).toBe('结论: 已停止维护。');
    // wholeText 仍是整轮(出站引用扫描范围, 与"发什么"无关)。
    expect(p.wholeText()).toContain('我先看看这个链接。');
  });

  it('replaceBody 在 finalized-segments 下不受支持, 显式失败', () => {
    const p = createTurnPresenter({ mode: 'finalized-segments' });
    expect(() => p.replaceBody('x')).toThrow(/does not support replaceBody/);
  });
});

describe('createProgressEmitter — trailing-edge 1.5s 节流骨架', () => {
  it('密集事件按 1.5s trailing-edge 合帧, 相同快照不重复发', () => {
    vi.useFakeTimers();
    try {
      const frames: string[] = [];
      let body = '';
      const emitter = createProgressEmitter(
        (t) => void frames.push(t),
        () => body,
      );
      body = 'a';
      emitter.schedule();
      body = 'ab';
      emitter.schedule(); // 节流窗口内, 不额外排帧
      vi.advanceTimersByTime(1500);
      expect(frames).toEqual(['ab']); // 只发一帧, 取窗口末的最新内容

      // 内容未变时 ticker 触发也不重复发。
      emitter.ensureTicker();
      vi.advanceTimersByTime(5000);
      expect(frames).toEqual(['ab']);

      body = 'abc';
      emitter.schedule();
      vi.advanceTimersByTime(1500);
      expect(frames).toEqual(['ab', 'abc']);

      emitter.stop();
      body = 'abcd';
      emitter.schedule();
      vi.advanceTimersByTime(5000);
      expect(frames).toEqual(['ab', 'abc']); // stop 后不再发射
    } finally {
      vi.useRealTimers();
    }
  });

  it('空快照不发帧', () => {
    vi.useFakeTimers();
    try {
      const frames: string[] = [];
      const emitter = createProgressEmitter(
        (t) => void frames.push(t),
        () => '',
      );
      emitter.schedule();
      vi.advanceTimersByTime(1500);
      expect(frames).toEqual([]);
      emitter.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('flush 跳过剩余节流窗口并取消原 trailing timer', () => {
    vi.useFakeTimers();
    try {
      const frames: string[] = [];
      let body = '第一帧';
      const emitter = createProgressEmitter((t) => void frames.push(t), () => body);
      emitter.schedule();
      vi.advanceTimersByTime(0);
      expect(frames).toEqual(['第一帧']);

      body = '最后一帧';
      emitter.schedule();
      vi.advanceTimersByTime(100);
      expect(frames).toEqual(['第一帧']);
      emitter.flush();
      expect(frames).toEqual(['第一帧', '最后一帧']);

      vi.advanceTimersByTime(PROGRESS_THROTTLE_MS);
      expect(frames).toEqual(['第一帧', '最后一帧']);
      emitter.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('DEFAULT_PRESENTER_POLICY — 两侧单一出处默认', () => {
  it('默认值 = 现有常量(零行为变化): 1500 trailing / 3800 max / lazy', () => {
    expect(DEFAULT_PRESENTER_POLICY.intermediateThrottleMs).toBe(PROGRESS_THROTTLE_MS);
    expect(DEFAULT_PRESENTER_POLICY.intermediateThrottleMs).toBe(1500);
    expect(DEFAULT_PRESENTER_POLICY.intermediateMaxRenderedChars).toBe(PROGRESS_SNAPSHOT_MAX_CHARS);
    expect(DEFAULT_PRESENTER_POLICY.intermediateMaxRenderedChars).toBe(3800);
    expect(DEFAULT_PRESENTER_POLICY.lazyPlaceholder).toBe(true);
  });
});

describe('PERSONAL_DRIVER_CAPABILITIES — 个人车道能力基线契约锚定', () => {
  it('声明个人车道现值(非官方默认, 车道差异见字段 TODO)', () => {
    expect(PERSONAL_DRIVER_CAPABILITIES).toEqual({
      progressSilent: true,
      typingKeepaliveMs: 4500,
      typingKeepaliveMaxMs: 5 * 60_000,
      linkPreviewDisabled: true,
      noReplyScope: 'all-turns',
      messageEffectIdSupported: false,
      threadIdDualSemantics: true,
      laneModel: 'per-chat',
    });
  });

  it('是 @cindy/im 的 re-export(单一出处, 不是复制的字面量)', () => {
    // 同一引用 → desktop 侧与 driver 侧读到的是同一份契约, 无第二真相源。
    expect(PERSONAL_DRIVER_CAPABILITIES).toBe(TELEGRAM_PERSONAL_CAPABILITIES);
  });

  it('NO_REPLY 生效范围为 all-turns(哨兵在任何轮次都静默)', () => {
    expect(PERSONAL_DRIVER_CAPABILITIES.noReplyScope).toBe('all-turns');
  });

  it('typing 保活 4.5s 重发 / 5min 上限', () => {
    expect(PERSONAL_DRIVER_CAPABILITIES.typingKeepaliveMs).toBe(4500);
    expect(PERSONAL_DRIVER_CAPABILITIES.typingKeepaliveMaxMs).toBe(300_000);
  });
});

describe('progress 三槽去重基线 — pending ?? sending ?? lastSent(严格顺序)', () => {
  it('baseline 严格按 pending → sending → lastSent 取', () => {
    expect(progressDedupeBaseline({ pending: 'p', sending: 's', lastSent: 'l' })).toBe('p');
    expect(progressDedupeBaseline({ sending: 's', lastSent: 'l' })).toBe('s');
    expect(progressDedupeBaseline({ lastSent: 'l' })).toBe('l');
    expect(progressDedupeBaseline({})).toBeUndefined();
  });

  it('只完全相等才判重复(不发); 其余一律发', () => {
    expect(shouldEmitProgressFrame('ab', { lastSent: 'ab' })).toBe(false);
    expect(shouldEmitProgressFrame('abc', { lastSent: 'ab' })).toBe(true);
  });

  it('绝无前缀判据: 候选是基线前缀 / 基线是候选前缀都必须发', () => {
    // 候选是基线的前缀
    expect(shouldEmitProgressFrame('ab', { lastSent: 'abc' })).toBe(true);
    // 基线是候选的前缀(流式增量的常见形态)
    expect(shouldEmitProgressFrame('abc', { lastSent: 'ab' })).toBe(true);
  });

  it('去重比对的是 pending 槽而非 lastSent(基线优先级生效)', () => {
    // pending 与候选相等 → 不发, 即便 lastSent 不同
    expect(shouldEmitProgressFrame('x', { pending: 'x', lastSent: 'y' })).toBe(false);
    // pending 与候选不同 → 发, 即便候选等于 lastSent
    expect(shouldEmitProgressFrame('y', { pending: 'x', lastSent: 'y' })).toBe(true);
  });
});

describe('createProgressEmitter — 自定义 policy(节流/上限/惰性)', () => {
  it('自定义 throttle 生效(第二帧受 500ms 窗口约束)', () => {
    vi.useFakeTimers();
    try {
      const frames: string[] = [];
      let body = '';
      const emitter = createProgressEmitter((t) => void frames.push(t), () => body, {
        ...DEFAULT_PRESENTER_POLICY,
        intermediateThrottleMs: 500,
      });
      // 首帧总是立即起飞(lastEmitAt=0), 借它把节流基准点拉到"现在"。
      body = 'a';
      emitter.schedule();
      vi.advanceTimersByTime(0);
      expect(frames).toEqual(['a']);
      // 第二帧受 500ms 窗口约束: 499ms 未到不发, 500ms 发。
      body = 'ab';
      emitter.schedule();
      vi.advanceTimersByTime(499);
      expect(frames).toEqual(['a']);
      vi.advanceTimersByTime(1);
      expect(frames).toEqual(['a', 'ab']);
      emitter.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('自定义 max 头部截断加省略号', () => {
    vi.useFakeTimers();
    try {
      const frames: string[] = [];
      let body = '';
      const emitter = createProgressEmitter((t) => void frames.push(t), () => body, {
        ...DEFAULT_PRESENTER_POLICY,
        intermediateMaxRenderedChars: 5,
      });
      body = 'abcdefgh';
      emitter.schedule();
      vi.advanceTimersByTime(1500);
      expect(frames).toEqual(['abcd…']); // slice(0, 4) + …
      emitter.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('lazyPlaceholder=false 时正文清空会发空帧(lazy=true 则不发)', () => {
    vi.useFakeTimers();
    try {
      // lazy=false: 先发 'a', 正文清空后空帧不再被惰性拦截 → 发 '' 清屏。
      const eager: string[] = [];
      let eagerBody = 'a';
      const eagerEmitter = createProgressEmitter((t) => void eager.push(t), () => eagerBody, {
        ...DEFAULT_PRESENTER_POLICY,
        lazyPlaceholder: false,
      });
      eagerEmitter.schedule();
      vi.advanceTimersByTime(1500);
      eagerBody = '';
      eagerEmitter.schedule();
      vi.advanceTimersByTime(1500);
      expect(eager).toEqual(['a', '']);
      eagerEmitter.stop();

      // lazy=true(默认): 同样序列下空帧被惰性拦截, 只保留 'a'。
      const lazy: string[] = [];
      let lazyBody = 'a';
      const lazyEmitter = createProgressEmitter((t) => void lazy.push(t), () => lazyBody);
      lazyEmitter.schedule();
      vi.advanceTimersByTime(1500);
      lazyBody = '';
      lazyEmitter.schedule();
      vi.advanceTimersByTime(1500);
      expect(lazy).toEqual(['a']);
      lazyEmitter.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createProgressEmitter — 异步 sink 的真实三槽(pending/sending/lastSent)', () => {
  /** 手动控制 settle 的异步 emit sink: 记录每次 emit 的文本与它的 resolver。 */
  function asyncSink() {
    const emitted: string[] = [];
    const resolvers: Array<() => void> = [];
    const emit = (t: string): Promise<void> => {
      emitted.push(t);
      return new Promise<void>((resolve) => resolvers.push(() => resolve()));
    };
    return { emit, emitted, resolvers };
  }

  it('in-flight 期间到来的多帧压 pending 并只保留最新, settle 后提升发出', async () => {
    vi.useFakeTimers();
    try {
      const sink = asyncSink();
      let body = '';
      const emitter = createProgressEmitter(sink.emit, () => body, {
        ...DEFAULT_PRESENTER_POLICY,
        intermediateThrottleMs: 100,
      });

      // 首帧 F1 起飞(wait=0), sending='F1' 且尚未 settle。
      body = 'F1';
      emitter.schedule();
      vi.advanceTimersByTime(0);
      expect(sink.emitted).toEqual(['F1']);

      // in-flight 期间连来两帧 → 压 pending, 只保留最新 F3, 不额外 emit。
      body = 'F2';
      emitter.schedule();
      vi.advanceTimersByTime(100);
      body = 'F3';
      emitter.schedule();
      vi.advanceTimersByTime(100);
      expect(sink.emitted).toEqual(['F1']); // 仍只发了 F1

      // F1 settle → 提升 lastSent='F1', 冲刷 pending → 发最新的 F3(跳过被覆盖的 F2)。
      sink.resolvers[0]();
      await Promise.resolve();
      expect(sink.emitted).toEqual(['F1', 'F3']);
      emitter.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('pending 与基线相等则不重发(三槽去重贯穿 in-flight)', async () => {
    vi.useFakeTimers();
    try {
      const sink = asyncSink();
      let body = '';
      const emitter = createProgressEmitter(sink.emit, () => body, {
        ...DEFAULT_PRESENTER_POLICY,
        intermediateThrottleMs: 100,
      });
      body = 'X';
      emitter.schedule();
      vi.advanceTimersByTime(0);
      expect(sink.emitted).toEqual(['X']); // sending='X'

      // in-flight 期间内容没变(仍 'X') → 去重命中 sending, 不压 pending。
      emitter.schedule();
      vi.advanceTimersByTime(100);
      sink.resolvers[0]();
      await Promise.resolve();
      // 没有 pending 需要冲刷, 依旧只发过一帧。
      expect(sink.emitted).toEqual(['X']);
      emitter.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop 后 in-flight settle 不再冲刷 pending(收口丢弃迟到帧)', async () => {
    vi.useFakeTimers();
    try {
      const sink = asyncSink();
      let body = '';
      const emitter = createProgressEmitter(sink.emit, () => body, {
        ...DEFAULT_PRESENTER_POLICY,
        intermediateThrottleMs: 100,
      });
      body = 'A';
      emitter.schedule();
      vi.advanceTimersByTime(0);
      body = 'B';
      emitter.schedule();
      vi.advanceTimersByTime(100); // B 压 pending(A 仍 in-flight)

      emitter.stop(); // 收口: 丢弃 pending
      sink.resolvers[0]();
      await Promise.resolve();
      expect(sink.emitted).toEqual(['A']); // B 不再发出
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createProgressEmitter — async emit 失败/重试状态机(P2: reject 不污染 lastSent)', () => {
  /** 可分别 resolve / reject 每次出站的异步 sink。 */
  function controllableSink() {
    const emitted: string[] = [];
    const settlers: Array<{ resolve: () => void; reject: () => void }> = [];
    const emit = (t: string): Promise<void> => {
      emitted.push(t);
      return new Promise<void>((resolve, reject) => {
        settlers.push({ resolve: () => resolve(), reject: () => reject(new Error('emit failed')) });
      });
    };
    return { emit, emitted, settlers };
  }
  /** 冲刷 .then(onReject) 这层微任务(reject 已被第二参数处理, 不产生 unhandledRejection)。 */
  const flush = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  };

  it('reject 不把失败帧记入 lastSent, 相同快照可重试(核心 P2)', async () => {
    vi.useFakeTimers();
    try {
      const sink = controllableSink();
      let body = 'F1';
      const emitter = createProgressEmitter(sink.emit, () => body, {
        ...DEFAULT_PRESENTER_POLICY,
        intermediateThrottleMs: 100,
      });
      emitter.schedule();
      vi.advanceTimersByTime(0);
      expect(sink.emitted).toEqual(['F1']); // sending='F1' in-flight

      // 出站失败: 清 in-flight、保留 lastSent(仍 undefined), 不把 F1 记作已送达。
      sink.settlers[0].reject();
      await flush();

      // 内容未变仍是 F1 → 下一次 schedule 判为"与基线不等"(F1 !== lastSent)重新起飞。
      emitter.schedule();
      vi.advanceTimersByTime(100);
      expect(sink.emitted).toEqual(['F1', 'F1']); // 同一帧成功重试, 未被去重吞掉
      sink.settlers[1].resolve();
      await flush();
      emitter.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('成功送达后相同快照被去重(与失败重试相反, 证明 lastSent 是去重支点)', async () => {
    vi.useFakeTimers();
    try {
      const sink = controllableSink();
      let body = 'X';
      const emitter = createProgressEmitter(sink.emit, () => body, {
        ...DEFAULT_PRESENTER_POLICY,
        intermediateThrottleMs: 100,
      });
      emitter.schedule();
      vi.advanceTimersByTime(0);
      sink.settlers[0].resolve(); // 成功 → lastSent='X'
      await flush();

      // 相同内容再次 schedule → 命中 lastSent 去重, 不重发。
      emitter.schedule();
      vi.advanceTimersByTime(100);
      expect(sink.emitted).toEqual(['X']);
      emitter.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reject 时仍冲刷 in-flight 期间压入的 pending(更新帧发出, 不残留孤儿)', async () => {
    vi.useFakeTimers();
    try {
      const sink = controllableSink();
      let body = 'A';
      const emitter = createProgressEmitter(sink.emit, () => body, {
        ...DEFAULT_PRESENTER_POLICY,
        intermediateThrottleMs: 100,
      });
      emitter.schedule();
      vi.advanceTimersByTime(0);
      expect(sink.emitted).toEqual(['A']); // sending='A'

      body = 'B';
      emitter.schedule();
      vi.advanceTimersByTime(100); // 'B' 压 pending(A 仍 in-flight)

      // A 失败: 不记 lastSent, 但要冲刷 pending → 发更新的 B。
      sink.settlers[0].reject();
      await flush();
      expect(sink.emitted).toEqual(['A', 'B']);
      sink.settlers[1].resolve();
      await flush();
      emitter.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop 后 in-flight reject 不冲刷 pending、不重试(收口丢弃)', async () => {
    vi.useFakeTimers();
    try {
      const sink = controllableSink();
      let body = 'A';
      const emitter = createProgressEmitter(sink.emit, () => body, {
        ...DEFAULT_PRESENTER_POLICY,
        intermediateThrottleMs: 100,
      });
      emitter.schedule();
      vi.advanceTimersByTime(0);
      body = 'B';
      emitter.schedule();
      vi.advanceTimersByTime(100); // pending='B'

      emitter.stop();
      sink.settlers[0].reject(); // 收口后失败: 既不发 B, 也不重试 A
      await flush();
      expect(sink.emitted).toEqual(['A']);
    } finally {
      vi.useRealTimers();
    }
  });
});
