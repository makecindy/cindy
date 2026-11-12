// @vitest-environment jsdom
import { act, createElement, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  MessageListVisibility, MessageListVisibilityContext, ScrollViewMessageVisibility, useMessageListItemVisible,
} from '@/session/messageListVisibility';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let store: MessageListVisibility;
let output: HTMLDivElement;
let renders: boolean[];
const visible = (key: string) => ({ key, isViewable: true });

function Row({ itemKey }: { itemKey: string }) {
  const active = useMessageListItemVisible(itemKey);
  renders.push(active);
  return createElement('span', null, String(active));
}

function render(itemKey = 'a') {
  act(() => root.render(createElement(MessageListVisibilityContext.Provider, { value: store },
    createElement(Row, { itemKey }))));
}

beforeEach(() => {
  store = new MessageListVisibility(); renders = [];
  output = document.createElement('div'); root = createRoot(output);
});
afterEach(() => act(() => root.unmount()));

it('catches the initial notification between row render and passive subscription', () => {
  function FirstLayout() {
    useLayoutEffect(() => store.update([visible('a')]), []);
    return createElement(Row, { itemKey: 'a' });
  }
  act(() => root.render(createElement(MessageListVisibilityContext.Provider, { value: store },
    createElement(FirstLayout))));
  expect(renders[0]).toBe(false);
  expect(output.textContent).toBe('true');
});

it('reads already published visibility on mount and remount without another list notification', () => {
  store.update([visible('a')]);
  render(); expect(output.textContent).toBe('true');
  act(() => root.render(null));
  render(); expect(output.textContent).toBe('true');
});

it('only rerenders the affected row, and deactivates it when it leaves the viewport', () => {
  render(); const initialRenders = renders.length;
  act(() => store.update([visible('b')]));
  expect(renders).toHaveLength(initialRenders);
  act(() => store.update([visible('a'), visible('b')]));
  expect(output.textContent).toBe('true');
  const activeRenders = renders.length;
  act(() => store.update([visible('b'), visible('a')]));
  expect(renders).toHaveLength(activeRenders);
  act(() => store.update([visible('b')]));
  expect(output.textContent).toBe('false');
});

it('does not reuse visibility after a row key or list scope changes', () => {
  store.update([visible('a')]);
  render(); expect(output.textContent).toBe('true');
  render('b'); expect(output.textContent).toBe('false');
  act(() => store.update([]));
  act(() => store.update([visible('a')]));
  expect(output.textContent).toBe('false');
  act(() => store.update([visible('b')]));
  expect(output.textContent).toBe('true');
  const oldStore = store;
  store = new MessageListVisibility();
  render('b'); expect(output.textContent).toBe('false');
  act(() => oldStore.update([]));
  act(() => oldStore.update([visible('b')]));
  expect(output.textContent).toBe('false');
  act(() => store.update([visible('b')]));
  expect(output.textContent).toBe('true');
});

it('removes subscriptions and clears visibility absent from the current list snapshot', () => {
  const listener = vi.fn();
  const unsubscribe = store.subscribe('a', listener);
  store.update([visible('a')]); expect(listener).toHaveBeenCalledTimes(1);
  unsubscribe();
  store.update([]);
  expect(store.isVisible('a')).toBe(false);
  expect(listener).toHaveBeenCalledTimes(1);
  store.update([{ key: 'a', isViewable: false }]);
  expect(store.isVisible('a')).toBe(false);
});

// PR #7145: native ScrollView layout/scroll events must gate mounted history rows.
// Existing LegendList tests only published visibility directly, without geometry.
it('tracks ScrollView intersections through scroll, resize, history prepend and removal', () => {
  const scroll = new ScrollViewMessageVisibility();
  scroll.setLayout('a', { y: 0, height: 200 });
  scroll.setLayout('b', { y: 800, height: 200 });
  expect(scroll.isVisible('a')).toBe(false); // no measured viewport yet
  scroll.setViewport(0, 500);
  expect(scroll.isVisible('a')).toBe(true);
  expect(scroll.isVisible('b')).toBe(false);
  scroll.setViewport(500, 300); // b is exactly outside the bottom edge
  expect(scroll.isVisible('a')).toBe(false);
  expect(scroll.isVisible('b')).toBe(false);
  scroll.setHeight(301);
  expect(scroll.isVisible('b')).toBe(true);
  scroll.setLayout('b', { y: 1200, height: 200 }); // prepended history moves content
  expect(scroll.isVisible('b')).toBe(false);
  scroll.setViewport(1200, 500);
  expect(scroll.isVisible('b')).toBe(true);
  scroll.retain(['a']);
  expect(scroll.isVisible('b')).toBe(false);
});
