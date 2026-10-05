// @vitest-environment jsdom
import { cleanup, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { GhostCardLinkConfirm, GhostCardPromptPanel } from '../GhostCardHostPrompts';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

afterEach(cleanup);

/** 点遮罩:mousedown 必须被 preventDefault(保住焦点),且不触发任何关闭回调。 */
function pressScrim(): boolean {
  const scrim = screen.getByTestId('ghost-card-scrim');
  const down = createEvent.mouseDown(scrim);
  fireEvent(scrim, down);
  fireEvent.mouseUp(scrim);
  fireEvent.click(scrim);
  return down.defaultPrevented;
}

it('prompt panel keeps typed text when the scrim is clicked and closes only via Cancel or Escape', () => {
  const onCancel = vi.fn();
  const onSubmit = vi.fn();
  render(
    <GhostCardPromptPanel
      top={0}
      left={0}
      placeholder=""
      text="draft prompt"
      onTextChange={() => {}}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />,
  );
  const textarea = screen.getByPlaceholderText('chat.mivoAction.promptPlaceholder');
  expect(pressScrim()).toBe(true);
  expect(onCancel).not.toHaveBeenCalled();
  expect(onSubmit).not.toHaveBeenCalled();
  expect((textarea as HTMLTextAreaElement).value).toBe('draft prompt');

  fireEvent.keyDown(textarea, { key: 'Escape' });
  expect(onCancel).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'chat.mivoAction.promptCancel' }));
  expect(onCancel).toHaveBeenCalledTimes(2);
  fireEvent.keyDown(textarea, { key: 'Enter' });
  expect(onSubmit).toHaveBeenCalledTimes(1);
});

it.each(['Escape', 'Cancel', 'Open'])('link confirmation ignores scrim clicks and handles %s once', async (action) => {
  const onCancel = vi.fn();
  const onConfirm = vi.fn();
  render(<GhostCardLinkConfirm url="https://example.com/path" host="example.com" onConfirm={onConfirm} onCancel={onCancel} />);
  expect(pressScrim()).toBe(true);
  expect(onCancel).not.toHaveBeenCalled();
  expect(onConfirm).not.toHaveBeenCalled();
  if (action === 'Escape') fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  else fireEvent.click(screen.getByRole('button', { name: action === 'Cancel' ? 'chat.ghostCall.linkConfirmCancel' : 'chat.ghostCall.linkConfirmOpen' }));
  await waitFor(() => expect(action === 'Open' ? onConfirm : onCancel).toHaveBeenCalledOnce());
  expect(action === 'Open' ? onCancel : onConfirm).not.toHaveBeenCalled();
  expect(screen.queryByRole('alertdialog')).toBeNull();
});

it('focuses Cancel, traps Tab in both directions, and restores the link opener', async () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return <><button onClick={() => setOpen(true)}>Open link</button>{open && <GhostCardLinkConfirm url="https://example.com" host="example.com" onConfirm={() => setOpen(false)} onCancel={() => setOpen(false)} />}</>;
  }
  const user = userEvent.setup();
  render(<Harness />);
  const opener = screen.getByRole('button', { name: 'Open link' });
  await user.click(opener);
  const cancel = screen.getByRole('button', { name: 'chat.ghostCall.linkConfirmCancel' });
  const confirm = screen.getByRole('button', { name: 'chat.ghostCall.linkConfirmOpen' });
  expect(document.activeElement).toBe(cancel);
  await user.tab({ shift: true });
  expect(document.activeElement).toBe(confirm);
  await user.tab();
  expect(document.activeElement).toBe(cancel);
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(opener));
});
