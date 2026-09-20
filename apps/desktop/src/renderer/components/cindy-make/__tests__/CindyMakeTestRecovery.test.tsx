// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { useState } from 'react';
import { CindyMakeTestCard } from '../CindyMakeTestCard';
import { getCindyMakeTestRecovery } from '@/lib/cindyMakeComposer';
import type { ChatMessage } from '@/lib/makerChatStore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/makerChatStore', () => ({ makerChatStore: { updateSystemCardData: vi.fn() } }));
vi.mock('@/features/device-link/stickySessionOrigin', () => ({
  getStickySessionDeviceId: () => undefined,
}));
beforeEach(() => setDataOwnerGeneration('make-owner'));
afterEach(cleanup);
const button = () => screen.getByRole('button', { name: 'cindyMake.test.resume.action' });
const card = (onCheck: () => Promise<boolean | void>, key = 'task') => (
  <CindyMakeTestCard key={key} sessionId={key} recovery={{ onCheck, onContinue: vi.fn() }} />
);

describe('Cindy Make resume checks', () => {
  it('sends one request during repeated clicks and permits retry after rejection', async () => {
    let finish!: (accepted: boolean) => void;
    const resume = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    render(card(resume));
    fireEvent.click(button());
    fireEvent.click(button());
    expect(resume).toHaveBeenCalledOnce();
    expect((button() as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finish(false));
    expect(screen.getByRole('alert').textContent).toBe('cindyMake.test.resume.failed');
    fireEvent.click(button());
    expect(resume).toHaveBeenCalledTimes(2);
    await act(async () => finish(true));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows send failures without losing the recovery action', async () => {
    const resume = vi.fn().mockRejectedValueOnce(new Error('send failed')).mockResolvedValue(true);
    render(card(resume));
    fireEvent.click(button());
    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined());
    fireEvent.click(button());
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(resume).toHaveBeenCalledTimes(2);
  });

  it('does not dispatch an old card after an account switch', () => {
    const resume = vi.fn().mockResolvedValue(true);
    render(card(resume));
    setDataOwnerGeneration('another-owner');
    fireEvent.click(button());
    expect(resume).not.toHaveBeenCalled();
  });

  it('does not put a late failure onto the next task', async () => {
    let finish!: (accepted: boolean) => void;
    const resume = () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      });
    const view = render(card(resume, 'old-task'));
    fireEvent.click(button());
    view.rerender(card(async () => true, 'new-task'));
    await act(async () => finish(false));
    expect(screen.queryByRole('alert')).toBeNull();
    expect((button() as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('recovery uses the existing input-area flow card', () => {
  const session = {
    id: 'make-task',
    source: 'cindy-make' as const,
    status: 'active' as const,
    clearedAt: null,
  };
  const reply = (clientId: string): ChatMessage => ({
    clientId,
    role: 'assistant',
    content: 'Done',
    turnCompleted: true,
  });
  function Composer({ messages }: { messages: ChatMessage[] }) {
    const [dismissedId, dismiss] = useState<string>();
    const recoveryId = getCindyMakeTestRecovery({
      session,
      messages,
      busy: false,
      historyLoaded: true,
      dismissedId,
    });
    return recoveryId ? (
      <CindyMakeTestCard
        sessionId={session.id}
        recovery={{
          onCheck: async () => true,
          onContinue: () => dismiss(recoveryId),
        }}
      />
    ) : (
      <textarea aria-label="editor" />
    );
  }

  it('replaces input, releases it for editing, and restores the same card after the next reply', () => {
    const view = render(<Composer messages={[reply('first')]} />);
    const region = screen.getByRole('region', { name: 'cindyMake.test.title' });
    expect(region.className).toContain('w-full');
    expect(region.className).toContain('bg-[var(--chat-input-bg)]');
    expect(screen.getAllByRole('region')).toHaveLength(1);
    expect(screen.queryByRole('textbox')).toBeNull();
    // No stale snapshot or successful verification is claimed in recovery.
    expect(screen.queryByText(/changedFiles|commit/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'cindyMake.test.start' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.test.continue' }));
    expect(screen.getByRole('textbox')).toBeDefined();
    expect(screen.queryByRole('region')).toBeNull();
    view.rerender(<Composer messages={[reply('first')]} />);
    expect(screen.getByRole('textbox')).toBeDefined();
    view.rerender(<Composer messages={[reply('first'), reply('second')]} />);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('region', { name: 'cindyMake.test.title' })).toBeDefined();
  });
});
