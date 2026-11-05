// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Tooltip } from '@/components/ui/tooltip';

/* A tool's detail view needs its own read-only binding; its existing toolbar and
 * original result must remain available. Minimal input: one local tool result.
 * Tier: DOM. */
const read = vi.hoisted(() => vi.fn());
vi.mock('../usePluginUiContributions', () => ({ usePluginUiContributions: read }));
vi.mock('../ghostUnreadStore', () => ({ useElementVisible: () => ({ ref: () => {}, visible: true }) }));
vi.mock('../PluginUiControls', () => ({ PluginUiControls: () => <div>Plugin detail</div> }));
vi.mock('react-i18next', async (original) => ({
  ...(await original<typeof import('react-i18next')>()), useTranslation: () => ({ t: (key: string) => key }),
}));
import { ToolPayloadLightbox } from '@/components/chat/ToolPayloadLightbox';

afterEach(() => { cleanup(); vi.clearAllMocks(); });
it('binds a detail to the original tool and retains the host toolbar and result', () => {
  read.mockReturnValue({ views: [{ viewId: 'detail', revision: '1' }],
    renderer: { selected: { instanceId: 'plugin', contributionId: 'detail' }, candidates: [] },
    pending: new Set(), disabled: true, invoke: vi.fn(), chooseRenderer: vi.fn() });
  render(<Tooltip.Provider><ToolPayloadLightbox
    payload={{ kind: 'json', title: 'Tool', toolInput: { id: 1 }, toolResult: 'Original result' }}
    renderer={{ sessionId: 'task', toolUseId: 'tool-1' }} onClose={() => {}} />
  </Tooltip.Provider>);
  expect(read).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'task', point: 'tool.body',
    target: { kind: 'tool', id: 'tool-1' }, readOnly: true }));
  expect(screen.getByText('Plugin detail')).toBeTruthy();
  expect(screen.getByText('Original result').closest('details')).toBeTruthy();
  expect(screen.getByLabelText('chat.lightbox.copyContent')).toBeTruthy();
});
