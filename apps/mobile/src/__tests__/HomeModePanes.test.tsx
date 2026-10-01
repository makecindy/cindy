// @vitest-environment jsdom
import { act, createElement, useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
vi.mock('react-native', () => ({ View: ({ children, style, testID }: any) => createElement('div', { style, 'data-testid': testID }, children) }));
import { HomeModePanes } from '@/session/HomeModePanes';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
describe('home mode continuity', () => {
  it('keeps task search, expansion and scroll state mounted through repeated mode switches', () => {
    const mount = vi.fn(); const unmount = vi.fn();
    function Tasks() {
      const [query, setQuery] = useState('');
      const [expanded, setExpanded] = useState(false);
      useEffect(() => { mount(); return unmount; }, []);
      return createElement('div', { 'data-tasks': true },
        createElement('button', { onClick: () => { setQuery('release'); setExpanded(true); } }, 'edit'),
        createElement('span', {}, `${query}:${expanded}`));
    }
    const container = document.createElement('div'); const root = createRoot(container);
    const render = (mode: 'tasks' | 'teammates') => act(() => root.render(createElement(HomeModePanes, { mode, tasks: createElement(Tasks), teammates: createElement('span', {}, 'roster') })));
    try {
      render('tasks'); act(() => container.querySelector('button')!.click());
      const taskElement = container.querySelector('[data-tasks]')!; taskElement.scrollTop = 120;
      for (let i = 0; i < 3; i++) { render('teammates'); render('tasks'); }
      expect(container.querySelector('[data-tasks]')).toBe(taskElement);
      expect(taskElement.textContent).toContain('release:true'); expect(taskElement.scrollTop).toBe(120);
      expect(mount).toHaveBeenCalledTimes(1); expect(unmount).not.toHaveBeenCalled();
    } finally { act(() => root.unmount()); }
  });
});
