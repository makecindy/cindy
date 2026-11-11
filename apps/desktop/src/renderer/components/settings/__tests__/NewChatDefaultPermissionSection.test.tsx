// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

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
});
afterEach(cleanup);

function select(mode: 'auto' | 'bypassPermissions') {
  fireEvent.click(screen.getByRole('button', { name: /settings.newChatDefaults.title/ }));
  fireEvent.click(screen.getByRole('option', {
    name: `newChat.permissionSelector.modes.claude-code.${mode}.label`,
  }));
}

// Direct selection is the user's authorization; no second dialog delays saving.
it('saves full access immediately without opening a confirmation', () => {
  render(<NewChatDefaultPermissionSection />);
  select('bypassPermissions');
  expect(state.save).toHaveBeenCalledExactlyOnceWith('bypassPermissions');
  expect(state.confirm).not.toHaveBeenCalled();
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
