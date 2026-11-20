// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { expect, it } from 'vitest';

import { loadTaskInfoFields, TASK_INFO_KEY } from '@/features/cc-agent/hooks/helpers/sidebarFilterCore';
import { useTaskInfoFields } from '@/features/cc-agent/hooks/useTaskInfoFields';
import { loadSidebarMainViewMode, useSidebarMainViewMode } from '../useSidebarCardMode';
import { useTaskListMode } from '../useTaskListMode';

it('restores the row style and ordered fields of each sidebar mode across edits and reloads', () => {
  localStorage.setItem('sidebar.mainListMode', 'text');
  localStorage.setItem(TASK_INFO_KEY, '["cost","time"]');
  const menu = renderHook(() => ({
    list: useTaskListMode(), style: useSidebarMainViewMode(), info: useTaskInfoFields(),
  }));
  const row = renderHook(() => ({ style: useSidebarMainViewMode(), info: useTaskInfoFields() }));
  const shown = () => [row.result.current.style.mode, row.result.current.info.fields];
  expect(shown()).toEqual(['text', ['cost', 'time']]);

  act(() => menu.result.current.list.setMode('inbox'));
  expect(shown()).toEqual(['list', ['time']]);
  act(() => {
    menu.result.current.info.toggleField('time');
    menu.result.current.info.toggleField('pr');
    menu.result.current.style.setMode('text');
  });
  act(() => menu.result.current.list.setMode('tasks'));
  expect(shown()).toEqual(['text', ['cost', 'time']]);
  act(() => {
    menu.result.current.style.setMode('list');
    menu.result.current.info.toggleField('cost');
    menu.result.current.info.toggleField('time');
  });
  act(() => menu.result.current.list.setMode('inbox'));
  expect(shown()).toEqual(['text', ['pr']]);
  menu.unmount();
  row.unmount();

  // Read from durable storage, bypassing both hooks' in-memory snapshots.
  expect(loadSidebarMainViewMode('tasks')).toBe('list');
  expect(loadTaskInfoFields('tasks')).toEqual([]);
  expect(loadSidebarMainViewMode('inbox')).toBe('text');
  expect(loadTaskInfoFields('inbox')).toEqual(['pr']);
});
