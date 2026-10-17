// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/lib/ccAgent.types';
import { CCAgentIndexRedirect } from '../CCAgentIndexRedirect';

const state = vi.hoisted(() => ({ sessions: [] as Session[], navigate: vi.fn() }));
vi.mock('@/hooks/useCCSessions', () => ({ useCCSessions: () => ({ sessions: state.sessions, isLoading: false }) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => state.navigate }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../lib/lastViewStore', () => ({ loadLastChatView: () => ({ kind: 'session', sessionId: 'make' }) }));
vi.mock('@/lib/makerTransport', () => ({ getSessionFor: vi.fn(), orcaWorkflowsFor: vi.fn() }));
afterEach(cleanup);
beforeEach(() => { state.sessions = []; state.navigate.mockReset(); });

describe('startup after hiding Cindy Make', () => {
  it('skips the last Make task and hidden cached rows when restoring a task', async () => {
    state.sessions = [
      { id: 'make', source: 'cindy-make' },
      { id: 'merge', source: 'cindy-make-merge' },
      { id: 'ordinary', source: 'desktop' },
    ] as Session[];
    render(<CCAgentIndexRedirect />);
    await waitFor(() => expect(state.navigate).toHaveBeenCalledWith('/cc-agent/ordinary', { replace: true }));
    expect(state.navigate).toHaveBeenCalledTimes(1);
  });

  it('opens a draft when all cached tasks belong to Cindy Make', async () => {
    state.sessions = [{ id: 'make', source: 'cindy-make' }] as Session[];
    render(<CCAgentIndexRedirect />);
    await waitFor(() => expect(state.navigate).toHaveBeenCalledWith('/cc-agent/new', { replace: true }));
    expect(state.navigate).toHaveBeenCalledTimes(1);
  });
});
