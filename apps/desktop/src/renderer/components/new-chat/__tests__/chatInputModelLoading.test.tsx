// @vitest-environment jsdom
import { h, props } from './chatInputTestHarness';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useState, type ComponentProps } from 'react';
import { sshNativeCodexProvider, sshModel } from '@/features/cc-agent/__tests__/sshModelFixtures';
import { ChatInput } from '../ChatInput';
import * as providerMemory from '@/state/providerModelMemory';
import * as draftMemory from '@/state/newMakerDraft';

const queuedMessage = {
  clientId: 'queue-edit-test',
  text: 'Queued message',
  persistedContent: 'Queued message',
  model: 'gpt-6-astra',
  effort: 'medium',
  permissionMode: 'default',
  workingDir: '/workspace',
  chatMessage: { clientId: 'queue-edit-test', role: 'user' as const, content: 'Queued message' },
  createOpts: {
    agentKind: 'codex' as const,
    model: 'gpt-6-astra',
    effort: 'medium',
    permissionMode: 'default',
    workingDir: '/workspace',
  },
} as NonNullable<ComponentProps<typeof ChatInput>['pendingQueue']>[number];

function QueueEditHarness({
  onCancel,
  onRemove,
  onSubmit = async () => true,
}: {
  onCancel: () => void;
  onRemove: () => void;
  onSubmit?: NonNullable<ComponentProps<typeof ChatInput>['onQueueEditSubmit']>;
}) {
  const [editingClientId, setEditingClientId] = useState<string | null>(queuedMessage.clientId);

  return (
    <ChatInput
      {...props}
      onSend={() => undefined}
      pendingQueue={[queuedMessage]}
      queueExpanded={false}
      onQueueExpandedChange={vi.fn()}
      onQueueRemove={onRemove}
      queueEditingClientId={editingClientId}
      onQueueEditBegin={vi.fn()}
      onQueueEditSubmit={onSubmit}
      onQueueEditCancel={() => {
        onCancel();
        setEditingClientId(null);
      }}
    />
  );
}

it('lets a new SSH task with no window report reach main on model selection and retry', async () => {
  const remember = vi.spyOn(providerMemory, 'setProviderModelChoice');
  const draft = vi.spyOn(draftMemory, 'patchVendorPrefs');
  const effortPrefs = vi.spyOn(draftMemory, 'setEffortForModel');
  h.remoteProviders = [sshNativeCodexProvider([sshModel('old'), sshModel('remote-new')])];
  h.setModel.mockRejectedValueOnce(new Error('test host rejected selection')).mockResolvedValue({ deferred: false });
  render(<ChatInput {...props} sessionId="ssh-empty" deviceLinkDeviceId={null} remoteHostId="builder"
    initialModel="old" initialProviderId="openai" initialEffort="low" hideRuntimeControls={false} onSend={vi.fn()} />);
  await waitFor(() => expect(h.selectModel).toBeTypeOf('function'));
  await act(async () => { await h.selectModel!('remote-new'); });
  // Failed optimistic selection restores the previous model through the same IPC.
  expect(h.setModel).toHaveBeenCalledTimes(2);
  expect(h.setModel.mock.calls[0].slice(0, 2)).toEqual(['ssh-empty', 'remote-new']);
  expect(h.setModel.mock.calls[1].slice(0, 2)).toEqual(['ssh-empty', 'old']);
  await act(async () => { await h.selectModel!('remote-new'); });
  expect(h.setModel).toHaveBeenCalledTimes(3);
  expect(h.setModel.mock.calls[2].slice(0, 2)).toEqual(['ssh-empty', 'remote-new']);
  expect(remember).not.toHaveBeenCalled();
  expect(draft).not.toHaveBeenCalled();
  expect(effortPrefs).not.toHaveBeenCalled();
});

it('sends a remote-only Codex model when the controller has no connected providers', async () => {
  h.remoteProviders = [sshNativeCodexProvider([sshModel('remote-only')])];
  const onSend = vi.fn().mockResolvedValue(true);
  const view = render(<ChatInput {...props} sessionId="ssh-send" deviceLinkDeviceId={null} remoteHostId="builder"
    initialModel="remote-only" initialProviderId="openai" initialEffort="low" onSend={onSend} />);
  await waitFor(() => expect(view.container.querySelector('[contenteditable]')).not.toBeNull());
  await act(async () => { h.editor!.commands.setContent('<p>Hello remote</p>'); });
  const send = screen.getByRole('button', { name: 'newChat.sendButton.send' }) as HTMLButtonElement;
  expect(send.disabled).toBe(false);
  await act(async () => { fireEvent.click(send); });
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  expect(onSend.mock.calls[0][1]).toBe('remote-only');
  expect(onSend.mock.calls[0][6]).toEqual(expect.objectContaining({ providerId: 'openai' }));
});

it.each([
  ['button', 'openai'], ['Enter', 'openai'], ['button', null], ['Enter', null],
] as const)('sends a hidden existing SSH model through %s with provider %s', async (entry, providerId) => {
  h.remoteProviders = [sshNativeCodexProvider([sshModel('remote-new')])];
  const onSend = vi.fn().mockResolvedValue(true);
  const view = render(<ChatInput {...props} sessionId="ssh-hidden" deviceLinkDeviceId={null} remoteHostId="builder"
    initialModel="remote-old" initialProviderId={providerId} initialEffort="low" onSend={onSend} />);
  await waitFor(() => expect(view.container.querySelector('[contenteditable]')).not.toBeNull());
  await act(async () => { h.editor!.commands.setContent('<p>Continue old task</p>'); });
  const send = screen.getByRole('button', { name: 'newChat.sendButton.send' }) as HTMLButtonElement;
  expect(send.disabled).toBe(false);
  await act(async () => {
    if (entry === 'button') fireEvent.click(send);
    else fireEvent.keyDown(view.container.querySelector('[contenteditable]')!, { key: 'Enter', code: 'Enter' });
  });
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  expect(onSend.mock.calls[0][1]).toBe('remote-old');
  expect(onSend.mock.calls[0][6]).toEqual(expect.objectContaining({ providerId }));
  expect(h.confirm).not.toHaveBeenCalled();
});

it.each(['loading', 'error'] as const)('keeps SSH catalog %s blocked for an existing hidden model', async (status) => {
  h.remoteStatus = status;
  const onSend = vi.fn();
  const view = render(<ChatInput {...props} sessionId="ssh-hidden" deviceLinkDeviceId={null} remoteHostId="builder"
    initialModel="remote-old" initialProviderId="openai" initialEffort="low" onSend={onSend} />);
  await waitFor(() => expect(view.container.querySelector('[contenteditable]')).not.toBeNull());
  await act(async () => { h.editor!.commands.setContent('<p>Continue old task</p>'); });
  expect((screen.getByRole('button', { name: 'newChat.sendButton.send' }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => {
    fireEvent.keyDown(view.container.querySelector('[contenteditable]')!, { key: 'Enter', code: 'Enter' });
  });
  expect(onSend).not.toHaveBeenCalled();
});

it.each(['draft', 'other-provider'] as const)('does not exempt a hidden SSH model for %s', async (kind) => {
  h.remoteProviders = [sshNativeCodexProvider([sshModel('remote-new')])];
  const onSend = vi.fn();
  const view = render(<ChatInput {...props} sessionId={kind === 'draft' ? undefined : 'ssh-hidden'}
    deviceLinkDeviceId={null} remoteHostId="builder" initialModel="remote-old"
    initialProviderId={kind === 'draft' ? 'openai' : 'custom'} initialEffort="low" onSend={onSend} />);
  await waitFor(() => expect(view.container.querySelector('[contenteditable]')).not.toBeNull());
  await act(async () => { h.editor!.commands.setContent('<p>New route</p>'); });
  expect((screen.getByRole('button', { name: 'newChat.sendButton.send' }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => {
    fireEvent.keyDown(view.container.querySelector('[contenteditable]')!, { key: 'Enter', code: 'Enter' });
  });
  expect(onSend).not.toHaveBeenCalled();
});

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

it('hides queue removal while editing and exits editing from the composer cancel button', async () => {
  const onCancel = vi.fn();
  const onRemove = vi.fn();
  render(<QueueEditHarness onCancel={onCancel} onRemove={onRemove} />);

  const cancel = await screen.findByRole('button', {
    name: 'newChat.pendingQueue.editCancelAria',
  });
  expect(screen.getByRole('listitem')).toBeTruthy();
  expect(
    screen.queryByRole('button', { name: 'newChat.pendingQueue.removeAria' }),
  ).toBeNull();

  fireEvent.click(cancel);

  await waitFor(() => {
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole('button', { name: 'newChat.pendingQueue.editCancelAria' }),
    ).toBeNull();
  });
  fireEvent.mouseEnter(screen.getByRole('listitem'));
  expect(screen.getByRole('button', { name: 'newChat.pendingQueue.removeAria' })).toBeTruthy();
  expect(onRemove).not.toHaveBeenCalled();
});

it('blocks queue edit saves while voice capture is active', async () => {
  h.listening = true;
  const onSubmit = vi.fn().mockResolvedValue(true);
  render(<QueueEditHarness onCancel={vi.fn()} onRemove={vi.fn()} onSubmit={onSubmit} />);

  const save = (await screen.findByRole('button', {
    name: 'newChat.pendingQueue.editSaveAria',
  })) as HTMLButtonElement;
  expect(save.disabled).toBe(true);

  fireEvent.click(save);
  expect(onSubmit).not.toHaveBeenCalled();
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
  if (narrowToolbar) {
    expect(slot.className).toBe(geometry);
  } else {
    // Loaded wide toolbars must not inherit the loading placeholder's width.
    expect(slot.classList.contains('w-[148px]')).toBe(false);
    expect(slot.classList.contains('h-[30px]')).toBe(true);
    expect(slot.classList.contains('min-w-0')).toBe(true);
  }
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
