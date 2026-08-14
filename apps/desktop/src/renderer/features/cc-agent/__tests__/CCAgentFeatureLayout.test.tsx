// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CCAgentFeatureLayout } from '../CCAgentFeatureLayout';

const registerSidebar = vi.fn();

vi.mock('../useRegisterCCAgentSidebar', () => ({
  useRegisterCCAgentSidebar: () => registerSidebar(),
}));

vi.mock('../SplitGroup', () => ({
  SplitGroup: ({ activeSessionId }: { activeSessionId?: string }) => (
    <div data-testid="split-group" data-active-session-id={activeSessionId} />
  ),
}));

describe('CCAgentFeatureLayout', () => {
  beforeEach(() => {
    registerSidebar.mockClear();
    localStorage.clear();
  });

  it('持久分屏不渲染子 Outlet 时仍先注册任务侧栏', () => {
    render(
      <MemoryRouter initialEntries={['/cc-agent/session-a']}>
        <Routes>
          <Route path="/cc-agent" element={<CCAgentFeatureLayout />}>
            <Route path=":sessionId" element={<div data-testid="session-outlet" />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(registerSidebar).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('split-group').dataset.activeSessionId).toBe('session-a');
    expect(screen.queryByTestId('session-outlet')).toBeNull();
  });
});
