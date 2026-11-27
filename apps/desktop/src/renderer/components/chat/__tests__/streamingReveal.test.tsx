// @vitest-environment jsdom
/**
 * 流式正文匀速放出的回归（DESIGN.md §14.4 Stream pacing）。
 *
 * 测试价值
 * - 生产入口与可观察结果：StreamingRevealBuffer（放出算法）与真实 MarkdownRenderer
 *   （isStreaming=true）——用户看到的正文是逐帧、按词边界增长，而不是成块跳出；
 *   结束、改写、关闭动效时立即显示全文。
 * - Bug／规则依据：2026-11-25 黑盒基准（apps/desktop/scripts/streaming-smoothness.e2e.mjs）
 *   测得改动前固定 100ms 节流 + 无缓冲：匀速流约 9 次/秒、突发流一次跳出 309 字；
 *   历史上这条链路多次因性能调整被改回固定节流（MarkdownRenderer useStreamingThrottle）。
 * - 现有覆盖缺口：streamingMarkdownChunks / rehypeStreamWordFade 只覆盖解析与淡入时间线，
 *   不覆盖「每次渲染放出多少字、多久一次」。
 * - 最小失败输入：同一帧到达 320 字；恢复固定 100ms 节流或去掉缓冲，下面的
 *   「突发被摊平」与「不被压回 10Hz」两条用例会失败。
 * - tier：unit（jsdom + fake timers，无真实等待）。
 */
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'test-owner' } }) }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { MarkdownRenderer } from '../MarkdownRenderer';
import {
  alignRevealBoundary,
  STREAM_REVEAL,
  STREAM_REVEAL_END_DRAIN_MS,
  StreamingRevealBuffer,
  streamingRevealPublishInterval,
} from '../streamingReveal';
import { _resetStreamFadePreferenceForTests } from '@/hooks/useStreamFadePreference';
import {
  __resetComposerTypingActivityForTest,
  markComposerTypingActivity,
} from '@/lib/composerTypingActivity';

const FRAME_MS = 1000 / 60;
const PROSE =
  'The layout engine measures the sidebar once during mount and caches the width. ' +
  'When the window shrinks below the breakpoint the cached value stays, so the content ' +
  'column overflows by exactly the stale delta. 侧栏宽度在窗口变化时没有重新计算，导致' +
  '主内容区被挤出视口。修复后分屏模式和系统缩放都表现正常，发送按钮重新可见。';

/** 按固定帧推进纯算法，返回每帧可见长度。 */
function simulate(
  arrivals: Array<{ at: number; text: string }>,
  untilMs: number,
): { lengths: number[]; texts: string[] } {
  const buffer = new StreamingRevealBuffer('');
  const lengths: number[] = [];
  const texts: string[] = [];
  let next = 0;
  for (let now = 0; now <= untilMs; now += FRAME_MS) {
    while (next < arrivals.length && arrivals[next].at <= now) buffer.update(arrivals[next++].text, now);
    buffer.tick(now);
    lengths.push(buffer.text.length);
    texts.push(buffer.text);
  }
  return { lengths, texts };
}

function increments(lengths: number[]): number[] {
  return lengths.slice(1).map((value, index) => value - lengths[index]);
}

describe('StreamingRevealBuffer', () => {
  it('同一帧到达的大段文字被摊到多帧放出，并在到达间隔内放完', () => {
    const burst = PROSE.slice(0, 320);
    const { lengths } = simulate([{ at: 0, text: '' }, { at: FRAME_MS, text: burst }], 1500);
    const steps = increments(lengths).filter((n) => n > 0);
    // 不再同帧跳出整段；最大单帧放出量远小于到达量。
    expect(Math.max(...steps)).toBeLessThan(burst.length / 4);
    expect(steps.length).toBeGreaterThan(8);
    // 不丢字、不超前：最终等于原文，且始终是原文前缀。
    expect(lengths.at(-1)).toBe(burst.length);
    // 积压按目标延迟收敛，不会拖成慢速打字。
    const doneFrame = lengths.findIndex((length) => length === burst.length);
    expect(doneFrame * FRAME_MS).toBeLessThan(1000);
  });

  it('间隔到达的突发流在两批之间持续放出，不出现长时间停顿', () => {
    const arrivals = [];
    for (let i = 1; i <= 6; i++) arrivals.push({ at: i * 450, text: PROSE.repeat(4).slice(0, i * 160) });
    const { lengths } = simulate(arrivals, 3600);
    // 第一批之后还不知道到达节奏；从第二批起（学到间隔后）应当连续放出。
    const start = Math.ceil(900 / FRAME_MS);
    const end = lengths.findIndex((length) => length === 960);
    const active = increments(lengths.slice(start, end + 1));
    // 连续不变的帧数（停顿）不超过约 120ms。
    let idle = 0;
    let longestIdle = 0;
    for (const step of active) {
      idle = step > 0 ? 0 : idle + 1;
      longestIdle = Math.max(longestIdle, idle);
    }
    expect(longestIdle * FRAME_MS).toBeLessThanOrEqual(120);
    expect(Math.max(...active)).toBeLessThan(80);
  });

  it('匀速小块流的显示延迟保持在目标下限附近', () => {
    const arrivals = [];
    for (let at = 25, length = 4; length <= PROSE.length; at += 25, length += 4) {
      arrivals.push({ at, text: PROSE.slice(0, length) });
    }
    const buffer = new StreamingRevealBuffer('');
    let worstLagChars = 0;
    let next = 0;
    for (let now = 0; now <= 25 * arrivals.length; now += FRAME_MS) {
      while (next < arrivals.length && arrivals[next].at <= now) buffer.update(arrivals[next++].text, now);
      buffer.tick(now);
      worstLagChars = Math.max(worstLagChars, buffer.backlog);
    }
    // 160 字/秒 × 目标延迟上限（含边界对齐余量）——不会把匀速流也拖出半秒延迟。
    expect(worstLagChars).toBeLessThanOrEqual(Math.ceil((160 * 250) / 1000) + STREAM_REVEAL.boundaryLookahead);
  });

  // 黑盒基准 turbo（~4000 字/秒，32ms 批）：只按固定 600 字/秒摊开时积压被拉到
  // 600ms 上限，结束时一次跳出上千字。持续高速时摊开速度应跟随实测到达速度。
  it('持续高速输出时显示延迟保持在约 200ms 内，而不是被拉到上限', () => {
    const text = PROSE.repeat(60);
    const arrivals = [];
    for (let at = 32, length = 128; length <= text.length; at += 32, length += 128) {
      arrivals.push({ at, text: text.slice(0, length) });
    }
    const buffer = new StreamingRevealBuffer('');
    let next = 0;
    let worstLagMs = 0;
    for (let now = 0; now <= 32 * arrivals.length; now += FRAME_MS) {
      while (next < arrivals.length && arrivals[next].at <= now) buffer.update(arrivals[next++].text, now);
      buffer.tick(now);
      if (now > 1000) worstLagMs = Math.max(worstLagMs, (buffer.backlog / 4000) * 1000);
    }
    expect(worstLagMs).toBeLessThanOrEqual(200);
  });

  it('只在词边界、CJK 字或表格行尾截断，不逐字打字', () => {
    const markdown = `${PROSE}\n\n| a | b |\n| --- | --- |\n| one | two |\n\n${PROSE}`;
    const { texts } = simulate([{ at: 0, text: '' }, { at: FRAME_MS, text: markdown }], 2000);
    for (const text of new Set(texts)) {
      if (text.length === 0 || text.length === markdown.length) continue;
      const next = markdown[text.length];
      const last = text[text.length - 1];
      const atBoundary =
        /\s/.test(next) || /[\s.,;:!?)\]，。；：！？、）]/.test(last) || /[\u3000-鿿]/.test(last + next);
      expect(atBoundary, JSON.stringify(text.slice(-12) + '|' + markdown.slice(text.length, text.length + 6))).toBe(true);
      const lineStart = text.lastIndexOf('\n') + 1;
      expect(text.slice(lineStart).startsWith('|'), 'table row cut mid-line').toBe(false);
    }
    expect(alignRevealBoundary('abc', 1)).toBe(3);
  });

  it('挂载时已有的正文直接可见；非追加改写立即整段显示', () => {
    const buffer = new StreamingRevealBuffer(PROSE);
    expect(buffer.text).toBe(PROSE);
    buffer.update(`${PROSE} more words arrive`, 0);
    expect(buffer.pending).toBe(true);
    buffer.update('Rewritten answer', 10);
    expect(buffer.text).toBe('Rewritten answer');
    expect(buffer.pending).toBe(false);
  });
});

// 黑盒基准 fast（~1500 字/秒）：消息列表等的高频刷新已占满主线程时，仍逐帧发布
// 会叠出 100ms+ 的长任务。退避必须同时看自身渲染耗时和主线程繁忙程度，而不是
// 回到按文本长度猜的固定节流。
describe('streamingRevealPublishInterval', () => {
  it('空闲时按帧级节奏；渲染变贵或主线程繁忙时退避，并有上限', () => {
    const idle = streamingRevealPublishInterval(2, false, FRAME_MS);
    expect(idle).toBeLessThanOrEqual(40);
    expect(streamingRevealPublishInterval(30, false, FRAME_MS)).toBeGreaterThan(idle * 2);
    expect(streamingRevealPublishInterval(2, false, 60)).toBeGreaterThan(idle * 2);
    expect(streamingRevealPublishInterval(500, false, 500)).toBeLessThanOrEqual(STREAM_REVEAL.maxPublishMs);
    expect(streamingRevealPublishInterval(2, true, FRAME_MS)).toBeGreaterThanOrEqual(STREAM_REVEAL.typingPublishMs);
  });
});

type HiddenGateWindow = Window & { __xdtHiddenAnimationGateLastHidden?: boolean };

describe('MarkdownRenderer 流式放出', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'Date'],
    });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    localStorage.removeItem('chat.streamFadePreference');
    _resetStreamFadePreferenceForTests();
    __resetComposerTypingActivityForTest();
    delete (window as HiddenGateWindow).__xdtHiddenAnimationGateLastHidden;
  });

  const visibleText = (container: HTMLElement) => container.querySelector('.msg-markdown')?.textContent ?? '';
  const reply = (content: string, isStreaming: boolean) => (
    <MarkdownRenderer workingDir="/task" content={content} isStreaming={isStreaming} streamFadeKey="reveal-test" />
  );

  function advanceFrames(count: number, onFrame?: () => void) {
    for (let i = 0; i < count; i++) {
      act(() => {
        vi.advanceTimersByTime(FRAME_MS);
      });
      onFrame?.();
    }
  }

  it('突发到达的正文逐帧增长，并且按帧刷新而不是固定 100ms 节流', () => {
    const head = 'Intro sentence.';
    const view = render(reply(head, true));
    expect(visibleText(view.container)).toBe(head);

    const full = `${head} ${PROSE}`;
    view.rerender(reply(full, true));
    const samples: number[] = [];
    advanceFrames(90, () => samples.push(visibleText(view.container).length));

    const steps = increments([head.length, ...samples]).filter((n) => n > 0);
    // 首次可见增长不晚于约 2 帧（旧实现首批之后要等满 100ms）。
    const firstGrowth = samples.findIndex((length) => length > head.length);
    expect(firstGrowth).toBeGreaterThanOrEqual(0);
    expect(firstGrowth).toBeLessThanOrEqual(2);
    // 同一批 ~280 字：至少 12 次可见增长、单次不超过 ~40 字（约 600 字/秒 × 33ms
    // 加词边界余量）。固定 100ms 节流或去掉缓冲时这批会一次全部出现。
    expect(steps.length).toBeGreaterThanOrEqual(12);
    expect(Math.max(...steps)).toBeLessThanOrEqual(40);
    expect(samples.at(-1)).toBe(full.length);
  });

  // 黑盒基准 bursty 场景：最后一批到达后流立刻结束，旧实现（以及只做「结束即
  // 全量」的实现）会让剩余 ~200 字在最后一帧整段出现。
  it('流式结束时剩余积压在收尾窗口内分帧放完，然后切回无包装的终版', () => {
    const full = `Intro. ${PROSE}`;
    const view = render(reply('Intro.', true));
    view.rerender(reply(full, true));
    advanceFrames(2);
    const atEnd = visibleText(view.container).length;
    expect(atEnd).toBeLessThan(full.length);
    view.rerender(reply(full, false));
    const samples = [visibleText(view.container).length];
    advanceFrames(Math.ceil(STREAM_REVEAL_END_DRAIN_MS / FRAME_MS) + 2, () =>
      samples.push(visibleText(view.container).length),
    );
    const steps = increments([atEnd, ...samples]).filter((n) => n > 0);
    expect(steps.length).toBeGreaterThanOrEqual(4);
    expect(Math.max(...steps)).toBeLessThan(full.length - atEnd);
    expect(visibleText(view.container)).toBe(full);
    expect(view.container.querySelector('.stream-word')).toBeNull();
  });

  it('关闭回复动效时流式结束立即显示全文', () => {
    localStorage.setItem('chat.streamFadePreference', 'off');
    _resetStreamFadePreferenceForTests();
    const full = `Intro. ${PROSE}`;
    const view = render(reply('Intro.', true));
    view.rerender(reply(full, false));
    expect(visibleText(view.container)).toBe(full);
  });

  it('关闭回复动效时不缓冲，下一帧即显示全部已收到的正文', () => {
    localStorage.setItem('chat.streamFadePreference', 'off');
    _resetStreamFadePreferenceForTests();
    const view = render(reply('Intro. ', true));
    view.rerender(reply(`Intro. ${PROSE}`, true));
    advanceFrames(3);
    expect(visibleText(view.container)).toBe(`Intro. ${PROSE}`);
  });

  it('输入框打字期间放慢发布节奏，但仍持续放出（typing-first）', () => {
    const full = `Intro. ${PROSE.repeat(3)}`;
    const publishesIn = (typing: boolean) => {
      const view = render(reply('Intro.', true));
      view.rerender(reply(full, true));
      const samples: number[] = [];
      advanceFrames(24, () => {
        if (typing) markComposerTypingActivity();
        samples.push(visibleText(view.container).length);
      });
      advanceFrames(120);
      const done = visibleText(view.container) === full;
      view.unmount();
      __resetComposerTypingActivityForTest();
      return { changes: increments(samples).filter((n) => n > 0).length, done };
    };
    const idle = publishesIn(false);
    const typing = publishesIn(true);
    // 400ms 窗口：打字时 ≥50ms 一次（composerTypingActivity 的 typing-first 约定），
    // 不打字时按帧级节奏；两种情况最终都放完全部正文。
    expect(typing.changes).toBeLessThanOrEqual(Math.ceil(400 / STREAM_REVEAL.typingPublishMs) + 1);
    expect(typing.changes).toBeGreaterThanOrEqual(4);
    expect(idle.changes).toBeGreaterThan(typing.changes);
    expect(typing.done && idle.done).toBe(true);
  });

  // 回归（PR #12892 review）：改写还没显示出来的尾部时，buffer 直接换成新全文，
  // 曾经只和「本帧开始前的 buffer」比较，判定没有变化而不发布；已显示的前缀仍是
  // 新全文的前缀，界面停在旧前缀上，直到下一次追加。
  it('改写尚未显示的尾部后，新正文在下一帧显示，不必等下一次追加', () => {
    const full = `Intro. ${PROSE}`;
    const view = render(reply('Intro.', true));
    view.rerender(reply(full, true));
    advanceFrames(2);
    const cut = full.length - 60;
    expect(visibleText(view.container).length).toBeLessThan(cut);

    const rewritten = `${full.slice(0, cut)} REWRITTEN ending.`;
    view.rerender(reply(rewritten, true));
    advanceFrames(2);
    expect(visibleText(view.container)).toBe(rewritten);
  });

  // 回归（PR #12892 review）：主线程繁忙时发布退避走定时器（可达数百毫秒）。流式
  // 结束进入收尾时若沿用这个定时器，150ms 收尾窗口在等待中耗尽，剩余积压一次跳出。
  it('主线程繁忙时流式结束，收尾立即按帧放出，不被流式期的退避定时器拖住', () => {
    // 模拟繁忙主线程：每次动画帧回调都晚到 60ms，发布间隔因此退避到约 160ms：
    // 发布后先等一帧，再挂一个长定时器。
    const BUSY_FRAME_MS = 60;
    window.requestAnimationFrame = (callback) =>
      setTimeout(() => callback(performance.now()), BUSY_FRAME_MS) as unknown as number;
    window.cancelAnimationFrame = (handle) => clearTimeout(handle);
    const STEP_MS = 5;
    const step = () =>
      act(() => {
        vi.advanceTimersByTime(STEP_MS);
      });

    const source = PROSE.repeat(6);
    let length = 60;
    const view = render(reply(source.slice(0, length), true));
    // 约 600 字/秒持续到达；预热 800ms 让繁忙信号收敛，等到一次发布后再过一帧多，
    // 在下一次发布正挂在退避定时器上时结束流式。
    let shown = visibleText(view.container).length;
    for (let elapsed = 0; elapsed < 2000; elapsed += STEP_MS) {
      if (elapsed % 50 === 0) {
        length += 30;
        view.rerender(reply(source.slice(0, length), true));
      }
      step();
      const now = visibleText(view.container).length;
      if (elapsed >= 800 && now !== shown) break;
      shown = now;
    }
    for (let waited = 0; waited < BUSY_FRAME_MS + 10; waited += STEP_MS) step();
    const atEnd = visibleText(view.container).length;
    const final = source.slice(0, length);
    expect(atEnd).toBeLessThan(final.length);
    view.rerender(reply(final, false));

    const samples: Array<{ at: number; length: number }> = [];
    for (let at = STEP_MS; at <= STREAM_REVEAL_END_DRAIN_MS + 2 * BUSY_FRAME_MS; at += STEP_MS) {
      step();
      samples.push({ at, length: visibleText(view.container).length });
    }
    const firstGrowth = samples.find((sample) => sample.length > atEnd);
    expect(firstGrowth?.at).toBeLessThanOrEqual(BUSY_FRAME_MS + 2 * STEP_MS);
    // 收尾分多步放出，而不是窗口耗尽后一次跳出。
    const partial = new Set(samples.map((sample) => sample.length).filter((n) => n > atEnd && n < final.length));
    expect(partial.size).toBeGreaterThanOrEqual(1);
    expect(visibleText(view.container)).toBe(final);
  });

  // 回归（PR #12892 review）：有运行中的回复时 main 关掉了后台节流，窗口最小化后
  // visibilityState 仍是 'visible'，只认它会在隐藏窗口里继续按帧渲染。必须同时认
  // main 广播的隐藏信号（hiddenAnimationGate），退回约 100ms 一次、不做匀速放出。
  it('窗口被最小化（main 广播隐藏）时不按帧渲染，按约 100ms 一次直接显示已收到的正文', () => {
    (window as HiddenGateWindow).__xdtHiddenAnimationGateLastHidden = true;
    expect(document.visibilityState).toBe('visible');
    const source = PROSE.repeat(4);
    let length = 20;
    const view = render(reply(source.slice(0, length), true));
    const samples: number[] = [];
    for (let frame = 0; frame < 60; frame++) {
      length = Math.min(source.length, length + 12);
      view.rerender(reply(source.slice(0, length), true));
      advanceFrames(1, () => samples.push(visibleText(view.container).length));
    }
    const changes = increments(samples).filter((n) => n > 0).length;
    // 1 秒内最多约 10 次发布（逐帧渲染会接近 60 次）。
    expect(changes).toBeLessThanOrEqual(Math.ceil(1000 / 100) + 1);
    expect(changes).toBeGreaterThanOrEqual(5);
    view.rerender(reply(source.slice(0, length), false));
    expect(visibleText(view.container)).toBe(source.slice(0, length));
  });
});
