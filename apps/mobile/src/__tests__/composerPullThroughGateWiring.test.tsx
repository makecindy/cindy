// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComposerPullThroughBridge } from '@/session/composerPullThrough';

// 门控接线测试：armed/busy 翻转 → reaction → setAttach → .enabled 的完整链路。
// 守护的不变量：接手进行中（busy）即使 armed 翻 false 也必须保持 enabled，
// 否则 tracker 的 end() 不跑，被 setFrozen(true) 冻住的列表滚动无法恢复。
const runtime = vi.hoisted(() => ({
  reactions: new Set<() => void>(),
  enabledLog: new Array<{ gesture: string; enabled: boolean }>(),
}));

vi.mock('react-native', () => ({
  Animated: { ScrollView: function AnimatedScrollView() { return null; } },
  Platform: { OS: 'android' },
}));

// 真 reanimated 的 reaction 在输入 shared value 每次被写时都跑 react worklet
// （不比较 mapper 返回值，见 lib/module/mappers.js），previous 靠第二参传入。
// mock 按同语义实现：每次 flush 都调 react，previous 为上次值（首次 undefined）。
vi.mock('react-native-reanimated', async () => {
  const { useRef } = await import('react');
  return {
    measure: () => null,
    runOnJS: (fn: unknown) => fn,
    useAnimatedReaction: (prepare: () => unknown, react: (value: unknown, previous: unknown) => void) => {
      const latest = useRef({ prepare, react, previous: undefined as unknown, started: false, job: null as (() => void) | null });
      latest.current.prepare = prepare;
      latest.current.react = react;
      if (!latest.current.job) {
        const state = latest.current;
        state.job = () => {
          const value = state.prepare();
          const previous = state.started ? state.previous : undefined;
          state.started = true;
          state.previous = value;
          state.react(value, previous);
        };
        runtime.reactions.add(state.job);
      }
    },
    useAnimatedRef: () => ({ current: null }),
    useSharedValue: (initial: unknown) => useRef({ value: initial }).current,
  };
});

vi.mock('@/platform/gestureHandler', () => {
  const makeGesture = (name: string) => {
    const gesture: Record<string, unknown> = {
      enabled(enabled: boolean) {
        runtime.enabledLog.push({ gesture: name, enabled });
        return gesture;
      },
    };
    for (const method of ['onTouchesDown', 'onTouchesMove', 'onTouchesUp', 'onTouchesCancelled', 'onFinalize']) {
      gesture[method] = () => gesture;
    }
    return gesture;
  };
  return {
    Gesture: {
      Manual: () => makeGesture('manual'),
      Native: () => makeGesture('native'),
      Simultaneous: (...gestures: unknown[]) => ({ gestures }),
    },
    GestureDetector: ({ children }: { children: React.ReactNode }) => children,
  };
});

import { ComposerPullThroughScrollView, useComposerPullThroughBridge } from '@/session/composerPullThrough';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
const bridgeRef: { current: ComposerPullThroughBridge | null } = { current: null };
const flushFrame = () => act(() => { for (const job of [...runtime.reactions]) job(); });
const enabledSequence = () => runtime.enabledLog.map(({ gesture, enabled }) => `${gesture}:${enabled ? 1 : 0}`);

beforeEach(() => {
  runtime.reactions.clear();
  runtime.enabledLog.length = 0;
  root = createRoot(document.createElement('div'));
});
afterEach(() => act(() => root.unmount()));

function Harness() {
  const bridge = useComposerPullThroughBridge();
  bridgeRef.current = bridge;
  return <ComposerPullThroughScrollView bridge={bridge} />;
}

describe('composer pull-through gesture gate wiring', () => {
  it('keeps the gesture enabled through a mid-handoff collapse and only releases it when the handoff settles', () => {
    act(() => root.render(<Harness />));
    // 初始（android idle）：手势构造成 disabled。
    expect(enabledSequence()).toEqual(['manual:0', 'native:0']);
    // 首帧 reaction 同值：不触发重建。
    flushFrame();
    expect(enabledSequence()).toEqual(['manual:0', 'native:0']);

    // 展开卡片态：armed → enabled。
    act(() => { bridgeRef.current!.armed.value = true; });
    flushFrame();
    expect(enabledSequence()).toEqual(['manual:0', 'native:0', 'manual:1', 'native:1']);

    // 接手进行中收起输入框：armed 翻 false 但 busy=true，必须保持 enabled。
    act(() => {
      bridgeRef.current!.armed.value = false;
      bridgeRef.current!.event.value = { id: 1, active: true, startY: 800, y: 900, successful: false };
    });
    flushFrame();
    expect(enabledSequence()).toEqual(['manual:0', 'native:0', 'manual:1', 'native:1']);

    // 接手收尾（end() 已在同帧解冻滚动）：busy 落 false 才允许摘除。
    act(() => {
      bridgeRef.current!.event.value = { id: 1, active: false, startY: 800, y: 900, successful: true };
    });
    flushFrame();
    expect(enabledSequence()).toEqual(['manual:0', 'native:0', 'manual:1', 'native:1', 'manual:0', 'native:0']);
  });
});
