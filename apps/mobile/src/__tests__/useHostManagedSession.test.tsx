// @vitest-environment jsdom
import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useHostManagedSession } from '@/session/hostManagedSession';

let container: HTMLDivElement;
let root: Root;
function Controls({ scope, session, pendingValue }: { scope: string; session: { source?: string } | null; pendingValue?: boolean }) {
  const managed = useHostManagedSession(scope, session, pendingValue);
  return createElement('div', null, managed ? 'companion controls' : 'task controls');
}
const render = (scope: string, session: { source?: string } | null, pendingValue?: boolean) => {
  act(() => root.render(createElement(StrictMode, null, createElement(Controls, { scope, session, pendingValue }))));
  return container.textContent;
};
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

describe('mobile companion control lifetime', () => {
  it('does not flash task controls during first load, runtime refresh or reconnect', () => {
    expect(render('owner/device/bot', null)).toBe('companion controls');
    expect(render('owner/device/bot', { source: 'bot' })).toBe('companion controls');
    expect(render('owner/device/bot', null)).toBe('companion controls');
    expect(render('owner/device/bot', {})).toBe('companion controls');
    expect(render('owner/device/bot', { source: 'bot' })).toBe('companion controls');
  });
  it('restores ordinary controls and does not carry ownership across task/device/account changes', () => {
    for (const scope of ['owner/device/a', 'owner/device/b', 'owner/other/b', 'other/other/b']) {
      expect(render(scope, { source: 'desktop' })).toBe('task controls');
      expect(render(scope, null)).toBe('task controls');
      expect(render(scope, { source: 'bot' })).toBe('companion controls');
    }
  });
});

it('filters a confirmed companion opened without resource params and retains it through refresh', () => {
  expect(render('owner/host/chat', null, false)).toBe('task controls');
  expect(render('owner/host/chat', { source: 'bot' }, false)).toBe('companion controls');
  expect(render('owner/host/chat', null, false)).toBe('companion controls');
  expect(render('owner/host/chat', {}, false)).toBe('companion controls');
  for (const scope of ['owner/host/other', 'owner/other/chat', 'other/host/chat']) {
    expect(render(scope, null, false)).toBe('task controls');
    expect(render(scope, { source: 'desktop' }, false)).toBe('task controls');
  }
});
