// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

const ICON_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0XQAAAAASUVORK5CYII=';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) =>
      key === 'orca.split.leadLabel' && params?.agent ? `Lead (${params.agent})` : key,
  }),
}));

vi.mock('@/hooks/useCCSessions', () => ({
  useCCSessions: () => ({
    sessions: [
      {
        id: 'acp-lead-1',
        agentKind: 'acp',
        providerId: 'acp-plugin:agy-acp:agy',
        orcaRole: 'lead',
        model: 'gemini-pro-orchestrator-neon',
        status: 'active',
        workingDir: '/repo',
      },
    ],
  }),
}));

vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  useRemoteProjectSessions: () => [],
}));

vi.mock('@/hooks/usePluginEngines', () => ({
  usePluginEngineIdentity: (providerId?: string | null) =>
    providerId === 'acp-plugin:agy-acp:agy'
      ? { name: 'Antigravity', iconDataUrl: ICON_DATA_URL }
      : { name: 'Plugin Engine' },
}));

vi.mock('@/hooks/useAgentIslandSettings', () => ({
  isAgentIslandSupported: () => false,
}));

vi.mock('../hooks/useStopOrcaCollab', () => ({
  useStopOrcaCollabWithoutNavigation: () => ({ requestStop: vi.fn() }),
}));

vi.mock('../hooks/useOrcaWorkerSelection', () => ({
  useOrcaWorkerSelection: () => ({
    selectedWorkerRecord: null,
    selectedWorkerId: null,
    workerSessionId: null,
  }),
}));

vi.mock('../lib/workerAttentionStore', () => ({
  clearWorkerAttention: vi.fn(),
  useWorkerAttentionSnapshot: () => ({}),
}));

vi.mock('../CCAgentSessionView', () => ({
  CCAgentSessionView: ({ sessionId }: { sessionId?: string }) => (
    <div data-testid="mock-session-view">{sessionId}</div>
  ),
}));

vi.mock('@/components/sidebar/VendorIcon', () => ({
  VendorIcon: ({ vendor, iconDataUrl }: { vendor: string; iconDataUrl?: string }) => (
    <span data-testid="lead-vendor-icon" data-vendor={vendor} data-icon={iconDataUrl ?? ''} />
  ),
}));

// Keep Lucide mock lightweight and deterministic in jsdom.
vi.mock('lucide-react', () => ({
  X: (): ReactNode => <span data-testid="close-icon" />,
}));

import { OrcaSplitView } from '../OrcaSplitView';

describe('OrcaSplitView ACP Lead identity', () => {
  it('renders the plugin engine display name and icon instead of falling back to Claude', () => {
    render(<OrcaSplitView leadSessionId="acp-lead-1" reportAgentIslandVisibility={false} />);
    expect(screen.getByText('Lead (Antigravity)')).toBeTruthy();
    expect(screen.queryByText('Lead (Claude)')).toBeNull();
    const icon = screen.getByTestId('lead-vendor-icon');
    expect(icon.getAttribute('data-vendor')).toBe('acp');
    expect(icon.getAttribute('data-icon')).toBe(ICON_DATA_URL);
  });
});
