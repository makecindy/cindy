// @vitest-environment jsdom
// 2026-10-30: real editor focus + teaching component, fake timers/geometry only.
// Prior hover tests missed repeat teaching, pending work and shared daily limits.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EditorContent, useEditor } from '@tiptap/react';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ComposerVoiceGuidance } from '../ComposerVoiceGuidance';
import { markComposerVoiceGuidanceLearned } from '../composerVoiceGuidanceHistory';

const state = vi.hoisted(() => ({ busy: false }));
vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: {
    subscribe: () => () => {},
    getLightSnapshot: () => ({ agentStatus: { isRunning: state.busy }, pendingQueue: [] }),
  },
}));
function Fixture({ eligible = true, sessionId = 'one', recommendationPending = false }) {
  const editor = useEditor({ extensions: [Document, Paragraph, Text], content: '<p></p>' });
  return (
    <div data-split-group-composer-drop-target>
      <EditorContent editor={editor} />
      <div>
        <div data-left />
        <ComposerVoiceGuidance
          editor={editor}
          sessionId={sessionId}
          eligible={eligible}
          recommendationPending={recommendationPending}
          text="Hold to speak"
        />
        <div data-right />
      </div>
    </div>
  );
}
let room = true;
beforeEach(() => {
  localStorage.clear();
  state.busy = false;
  room = true;
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 30, 12));
  vi.stubGlobal('PointerEvent', MouseEvent);
  vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const left = this.hasAttribute('data-right') ? (room ? 400 : 100) : 0;
    const width = this.hasAttribute('data-left') ? 80 : 150;
    return {
      x: left,
      y: 0,
      left,
      right: left + width,
      top: 0,
      bottom: 30,
      width,
      height: 30,
      toJSON() {},
    };
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const shown = () => screen.getByTestId('composer-voice-guidance').dataset.visible === 'true';
async function wait(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
function intend() {
  const dom = document.querySelector<HTMLElement>('.tiptap')!;
  act(() => {
    dom.focus();
    fireEvent.pointerUp(dom, { button: 0 });
  });
}
it('ignores hover and autofocus, shows after deliberate idle focus, stays through mouse movement then expires', async () => {
  render(<Fixture />);
  const dom = document.querySelector<HTMLElement>('.tiptap')!;
  act(() => dom.focus());
  fireEvent.pointerOver(dom);
  await wait(2500);
  expect(shown()).toBe(false);
  intend();
  await wait(1999);
  expect(shown()).toBe(false);
  await wait(1);
  expect(shown()).toBe(true);
  fireEvent.pointerOut(dom);
  expect(shown()).toBe(true);
  await wait(5000);
  expect(shown()).toBe(false);
  intend();
  await wait(2500);
  expect(shown()).toBe(false);
});
it('yields to recommendation or other work immediately and does not reappear when it goes away', async () => {
  const view = render(<Fixture />);
  intend();
  await wait(2000);
  expect(shown()).toBe(true);
  view.rerender(<Fixture eligible={false} />);
  expect(shown()).toBe(false);
  view.rerender(<Fixture />);
  await wait(2500);
  expect(shown()).toBe(false);
});
it.each(['busy', 'recommendation', 'narrow'] as const)(
  'does not teach or spend budget when %s',
  async (reason) => {
    state.busy = reason === 'busy';
    room = reason !== 'narrow';
    render(<Fixture eligible={reason !== 'recommendation'} />);
    intend();
    await wait(2500);
    expect(shown()).toBe(false);
    expect(localStorage.getItem('cindy.composer-voice-guidance.v1')).toBeNull();
  },
);
it('supports keyboard focus, dismisses at the first input and retains the limit across task/remount/day', async () => {
  const view = render(<Fixture />);
  fireEvent.keyDown(window, { key: 'Tab' });
  act(() => document.querySelector<HTMLElement>('.tiptap')!.focus());
  await wait(2000);
  expect(shown()).toBe(true);
  fireEvent.keyDown(document.querySelector('.tiptap')!, { key: 'a' });
  expect(shown()).toBe(false);
  view.unmount();
  render(<Fixture sessionId="two" />);
  intend();
  await wait(2000);
  expect(shown()).toBe(false);
  for (let day = 31; day <= 33; day++) {
    cleanup();
    vi.setSystemTime(new Date(2026, 9, day, 12));
    render(<Fixture />);
    intend();
    await wait(2000);
    expect(shown()).toBe(day < 33);
  }
});
it('permanently retires teaching after a successful long press, including an already visible hint', async () => {
  render(<Fixture />);
  intend();
  await wait(2000);
  expect(shown()).toBe(true);
  act(() => markComposerVoiceGuidanceLearned());
  expect(shown()).toBe(false);
  cleanup();
  vi.setSystemTime(new Date(2026, 10, 3, 12));
  render(<Fixture />);
  intend();
  await wait(2000);
  expect(shown()).toBe(false);
});

it('waits for pending recommendations to settle before teaching, without competing during prediction', async () => {
  const view = render(<Fixture recommendationPending />);
  intend();
  await wait(3000);
  expect(shown()).toBe(false);
  view.rerender(<Fixture />);
  await wait(2000);
  expect(shown()).toBe(true);
});

it.each([false, true])(
  'requires a fresh click after work interrupts the teaching delay (prediction pending: %s)',
  async (recommendationPending) => {
    const view = render(<Fixture recommendationPending={recommendationPending} />);
    intend();
    await wait(1000);
    state.busy = true;
    view.rerender(<Fixture recommendationPending={recommendationPending} />);
    state.busy = false;
    view.rerender(<Fixture />);
    await wait(2500);
    expect(shown()).toBe(false);
    expect(localStorage.getItem('cindy.composer-voice-guidance.v1')).toBeNull();
    intend();
    await wait(2000);
    expect(shown()).toBe(true);
  },
);
