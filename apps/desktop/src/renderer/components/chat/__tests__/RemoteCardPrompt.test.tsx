// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RemoteCardModelRequest, useRemoteCardPromptFor } from '../RemoteCardPrompt';
import type { RemoteCardPrompt } from '@/cindy-brain/ghostCardActions';

const mocks = vi.hoisted(() => ({ answer: vi.fn(), claim: vi.fn(), prompt: undefined as unknown }));
vi.mock('@/cindy-brain/ghostCardActions', () => ({
  answerRemoteCardModel: mocks.answer, claimRemoteCardPrompt: mocks.claim,
  answerRemoteCardConfirm: vi.fn(), getRemoteCardPrompt: () => mocks.prompt,
  subscribeRemoteCardPrompts: () => () => {}, routeForPicker: () => null,
}));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useOptionalConfirmDialog: () => undefined }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));
vi.mock('../GhostCardModelSelect', () => ({
  GhostCardModelSelect: ({ onSelect, onClose }: { onSelect: (route: unknown) => void; onClose: () => void }) =>
    <button onClick={() => { onSelect({ agentKind: 'codex', model: 'm' }); onClose(); }}>Pick</button>,
}));
const prompt: Extract<RemoteCardPrompt, { kind: 'model' }> = {
  kind: 'model', callId: 'call', remote: { deviceId: 'host' },
  request: { requestId: 'request', expiresAt: 123456789 } as Extract<RemoteCardPrompt, { kind: 'model' }>['request'],
};
beforeEach(() => { mocks.answer.mockReset(); mocks.claim.mockReturnValue(true); mocks.prompt = prompt; });
afterEach(cleanup);

// #10734 UI regressions, unit tier: actual prompt view/hook; mock only picker and host transport.
// Prior store tests never mounted the view. Minimal inputs: host rejects selection; owner unmounts.
// Protect observable outcomes: another choice remains possible; host request is cancelled on close.
it('reopens the picker after the host rejects a choice', async () => {
  mocks.answer.mockResolvedValueOnce({ handled: true, accepted: false })
    .mockResolvedValueOnce({ handled: true, accepted: true });
  render(<RemoteCardModelRequest prompt={prompt} />);
  fireEvent.click(screen.getByText('Pick'));
  await waitFor(() => expect(screen.getByText('Pick')).toBeTruthy());
  fireEvent.click(screen.getByText('Pick'));
  await waitFor(() => expect(mocks.answer).toHaveBeenCalledTimes(2));
});
it('cancels the claimed request when its view unmounts', async () => {
  function Owner() { useRemoteCardPromptFor('call'); return null; }
  mocks.answer.mockResolvedValue({ handled: true, accepted: true });
  const view = render(<Owner />);
  await act(async () => view.unmount());
  expect(mocks.answer).toHaveBeenCalledWith(prompt, null);
});
