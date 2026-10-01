// @vitest-environment jsdom
import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';
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

it('link confirmation ignores scrim clicks and closes only via Cancel or Escape', () => {
  const onCancel = vi.fn();
  const onConfirm = vi.fn();
  render(
    <GhostCardLinkConfirm
      url="https://example.com/path"
      host="example.com"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />,
  );
  expect(pressScrim()).toBe(true);
  expect(onCancel).not.toHaveBeenCalled();
  expect(onConfirm).not.toHaveBeenCalled();

  fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
  expect(onCancel).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'chat.ghostCall.linkConfirmCancel' }));
  expect(onCancel).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole('button', { name: 'chat.ghostCall.linkConfirmOpen' }));
  expect(onConfirm).toHaveBeenCalledTimes(1);
});
