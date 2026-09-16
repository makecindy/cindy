// @vitest-environment jsdom
import { h, props } from './chatInputTestHarness';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ChatInput } from '../ChatInput';

it.each(['button', 'Enter', 'voice'] as const)(
  'blocks %s while metadata is absent, retains input, and sends Astra when metadata arrives', async (entry) => {
    const onSend = vi.fn().mockResolvedValue(true);
    const view = render(<ChatInput {...props} onSend={onSend} />);
    await waitFor(() => expect(view.container.querySelector('[contenteditable]')).not.toBeNull());
    await act(async () => { h.editor!.commands.setContent('<p>Continue the task</p>'); });
    const editor = view.container.querySelector('[contenteditable]') as HTMLElement;
    const send = () => screen.getByRole('button', { name: 'newChat.sendButton.send' }) as HTMLButtonElement;
    if (entry === 'voice') {
      h.listening = true;
      view.rerender(<ChatInput {...props} onSend={onSend} />);
    }
    const trigger = async () => {
      await act(async () => {
        if (entry === 'button') fireEvent.click(send());
        else fireEvent.keyDown(editor, { key: 'Enter', code: 'Enter' });
      });
    };
    expect(screen.getByTestId('permission-selector')).toBeTruthy();
    expect(screen.queryByTestId('model-selector')).toBeNull();
    expect(send().disabled).toBe(true);
    await trigger();
    expect(onSend).not.toHaveBeenCalled();
    expect(h.editor!.getText()).toBe('Continue the task');
    view.rerender(<ChatInput {...props} onSend={onSend}
      initialModel="gpt-6-astra" initialProviderId="openai" initialEffort="medium" />);
    await waitFor(() => expect(send().disabled).toBe(false));
    await trigger();
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    if (entry === 'voice') expect(h.stop).toHaveBeenCalled();
    expect(onSend.mock.calls[0][0]).toBe('Continue the task');
    expect(onSend.mock.calls[0][1]).toBe('gpt-6-astra');
    expect(onSend.mock.calls[0][2]).toBe('medium');
    expect(onSend.mock.calls[0][6]).toEqual(expect.objectContaining({ providerId: 'openai' }));
  },
);

it('hides a missing existing model, recovers from the effective runtime, and preserves new-draft defaults', async () => {
  const onSend = vi.fn();
  const view = render(<ChatInput {...props} hideRuntimeControls={false} onSend={onSend} />);
  expect(screen.queryByTestId('model-selector')).toBeNull();
  view.rerender(<ChatInput {...props} hideRuntimeControls={false} onSend={onSend}
    runtimeEffective={{ agentKind: 'codex', model: 'gpt-6-astra', providerId: 'openai', effort: 'medium', fastMode: false }} />);
  expect(screen.getByTestId('model-selector').textContent).toBe('gpt-6-astra');
  view.rerender(<ChatInput {...props} hideRuntimeControls={false} onSend={onSend} />);
  expect(screen.queryByTestId('model-selector')).toBeNull();
  expect((screen.getByRole('button', { name: 'newChat.sendButton.send' }) as HTMLButtonElement).disabled).toBe(true);
  view.rerender(<ChatInput {...props} sessionId={undefined} hideRuntimeControls={false} onSend={onSend} />);
  expect(screen.getByTestId('model-selector').textContent).toBe('claude-fable-5-1');
  await act(async () => {});
  expect(onSend).not.toHaveBeenCalled();
});

// The slot survives missing metadata; only the model control is withheld.
it.each([320, 480, 800])('preserves the model slot across hydration (width=%s)', async (width) => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(width);
  const narrowToolbar = width < 600;
  const onSend = vi.fn();
  const inputProps = { ...props, hideRuntimeControls: false, narrowToolbar, onSend };
  const view = render(<ChatInput {...inputProps} />);
  const slot = view.container.querySelector('[data-session-model-slot]') as HTMLElement;
  expect(slot).not.toBeNull();
  const geometry = slot.className;
  expect(slot.textContent).toBe('');
  expect(slot.querySelector('button, [tabindex]')).toBeNull();
  expect(screen.queryByTestId('model-selector')).toBeNull();
  view.rerender(<ChatInput {...inputProps} initialModel="gpt-6-astra" />);
  expect(view.container.querySelector('[data-session-model-slot]')).toBe(slot);
  expect(slot.className).toBe(geometry);
  expect(slot.contains(screen.getByTestId('model-selector'))).toBe(true);
  view.rerender(<ChatInput {...inputProps} />);
  expect(view.container.querySelector('[data-session-model-slot]')).toBe(slot);
  expect(slot.className).toBe(geometry);
  expect(slot.textContent).toBe('');
  view.rerender(<ChatInput {...inputProps} hideRuntimeControls />);
  expect(view.container.querySelector('[data-session-model-slot]')).toBeNull();
  expect(screen.getByTestId('permission-selector')).toBeTruthy();
  await act(async () => {});
  expect(onSend).not.toHaveBeenCalled();
});
