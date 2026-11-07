// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';

const state = vi.hoisted(() => ({
  mode: null as 'auto' | 'bypassPermissions' | null,
  save: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/state/newMakerDraft', () => ({
  useNewMakerDraft: () => ({ newChatDefaultPermissionMode: state.mode }),
  setNewChatDefaultPermissionMode: state.save,
}));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: state.confirm }),
}));
vi.mock('@/hooks/useAgentCapabilities', () => ({ useAgentCapabilities: () => ({
  capabilities: { permissionModes: [
    { id: 'auto', displayName: 'Auto-review' },
    { id: 'bypassPermissions', displayName: 'Full access' },
  ] },
}) }));

import { NewChatDefaultPermissionSection } from '../NewChatDefaultPermissionSection';

beforeEach(() => {
  vi.clearAllMocks();
  state.mode = null;
  setDataOwnerGeneration('owner-a', 1);
});
afterEach(cleanup);

function select(mode: 'auto' | 'bypassPermissions') {
  fireEvent.click(screen.getByRole('button', { name: /settings.newChatDefaults.title/ }));
  fireEvent.click(screen.getByRole('option', {
    name: `newChat.permissionSelector.modes.claude-code.${mode}.label`,
  }));
}

// Unit regression #7839: the actual settings picker must retain its value until the shared
// Full-access confirmation resolves. Store tests cannot exercise this UI authorization boundary.
it.each([false, true])('saves full access only when confirmation resolves %s', async (accepted) => {
  let answer!: (value: boolean) => void;
  state.confirm.mockImplementation(() => new Promise<boolean>(resolve => { answer = resolve; }));
  render(<NewChatDefaultPermissionSection />);
  select('bypassPermissions');
  expect(state.confirm).toHaveBeenCalledOnce();
  expect(state.save).not.toHaveBeenCalled();
  const options = state.confirm.mock.calls[0][0];
  expect(options.describeContent).toBe(true);
  const content = render(options.content);
  for (const kind of ['files', 'commands', 'network']) {
    expect(screen.getByText(`newChat.chatInput.fullAccessConfirmation.items.${kind}.description`)).toBeTruthy();
  }
  content.unmount();
  await act(async () => answer(accepted));
  if (accepted) expect(state.save).toHaveBeenCalledExactlyOnceWith('bypassPermissions');
  else expect(state.save).not.toHaveBeenCalled();
});

it('saves a downgrade and reset without an upgrade confirmation', () => {
  state.mode = 'bypassPermissions';
  render(<NewChatDefaultPermissionSection />);
  select('auto');
  expect(state.save).toHaveBeenCalledWith('auto');
  fireEvent.click(screen.getByRole('button', { name: 'settings.defaults.restore' }));
  expect(state.save).toHaveBeenLastCalledWith(null);
  expect(state.confirm).not.toHaveBeenCalled();
});

it('does not apply an old owner’s confirmation to the newly active owner', async () => {
  let answer!: (value: boolean) => void;
  state.confirm.mockImplementation(() => new Promise<boolean>(resolve => { answer = resolve; }));
  render(<NewChatDefaultPermissionSection />);
  select('bypassPermissions');
  setDataOwnerGeneration('owner-b', 2);
  await act(async () => answer(true));
  expect(state.save).not.toHaveBeenCalled();
});
