// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { CindyMakeEditingActions } from '../CindyMakeEditingActions';
import { getCindyMakePendingTest, getCindyMakeTestRecovery } from '@/lib/cindyMakeComposer';
import type { ChatMessage } from '@/lib/makerChatStore';
import type { CindyMakeMergeState } from '../../../../shared/cindyMakeMerge';

const h = vi.hoisted(() => ({
  api: vi.fn(),
  merge: undefined as CindyMakeMergeState | undefined,
  remote: undefined as string | undefined,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/cindyMakeState', () => ({ useCindyMakeState: () => ({ upstreamMerge: h.merge }) }));
vi.mock('@/features/device-link/stickySessionOrigin', () => ({
  getStickySessionDeviceId: () => h.remote,
}));
beforeEach(() => {
  vi.resetAllMocks();
  h.merge = undefined;
  h.remote = undefined;
  setDataOwnerGeneration('make-owner');
  vi.stubGlobal('electronAPI', { cindyMakeTest: h.api });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const button = (action = 'start') =>
  screen.getByRole('button', {
    name: action === 'start' ? 'cindyMake.test.start' : 'cindyMake.personal.generate',
  });
const actions = (key = 'task') => (
  <CindyMakeEditingActions key={key} sessionId={key} messageId="result" />
);

describe('on-demand Cindy Make checks', () => {
  it.each(['start', 'build'] as const)(
    'checks only when %s is clicked, coalesces double clicks and allows retry',
    async (action) => {
      let fail!: (error: Error) => void;
      h.api
        .mockImplementationOnce(
          () =>
            new Promise((_resolve, reject) => {
              fail = reject;
            }),
        )
        .mockResolvedValue({});
      render(actions());
      expect(h.api).not.toHaveBeenCalled();
      fireEvent.click(button(action));
      fireEvent.click(button(action));
      fireEvent.click(button(action === 'start' ? 'build' : 'start'));
      expect(h.api).toHaveBeenCalledExactlyOnceWith('task', 'result', 'resume-' + action);
      await act(async () => fail(new Error('failed')));
      expect(screen.getByRole('alert').textContent).toBe('cindyMake.test.errors.unavailable');
      fireEvent.click(button(action));
      await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
      expect(h.api).toHaveBeenCalledTimes(2);
    },
  );
  it.each(['owner', 'remote'])('rejects an old action after switching %s', (change) => {
    render(actions());
    if (change === 'owner') setDataOwnerGeneration('another-owner');
    else h.remote = 'another-device';
    fireEvent.click(button());
    expect(h.api).not.toHaveBeenCalled();
  });
  it('does not put a late failure onto the next task', async () => {
    let fail!: (error: Error) => void;
    h.api.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    const view = render(actions('old-task'));
    fireEvent.click(button());
    view.rerender(actions('new-task'));
    await act(async () => fail(new Error('late')));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(button().hasAttribute('disabled')).toBe(false);
  });
  it('blocks generation during a source conflict while retaining isolated testing', async () => {
    h.merge = {
      id: 'merge',
      status: 'conflict',
      ref: 'main',
      upstreamCommit: 'a'.repeat(40),
      hasWorkspace: true,
    };
    render(actions());
    expect(button('build').hasAttribute('disabled')).toBe(true);
    fireEvent.click(button('build'));
    expect(h.api).not.toHaveBeenCalled();
    fireEvent.click(button());
    await waitFor(() => expect(h.api).toHaveBeenCalledWith('task', 'result', 'resume-start'));
  });
});

describe('continued editing retains input', () => {
  const session = {
    id: 'make-task',
    source: 'cindy-make' as const,
    status: 'active' as const,
    clearedAt: null,
  };
  const continued: ChatMessage = {
    clientId: 'done',
    role: 'assistant',
    content: '',
    systemCardType: 'cindy-make-complete',
    systemCardData: { reportedAt: 1, continuedAt: 2 },
  };
  function Composer({ messages }: { messages: ChatMessage[] }) {
    const pending = getCindyMakePendingTest({ session, messages, busy: false });
    const recoveryId = getCindyMakeTestRecovery({
      session,
      messages,
      busy: false,
      historyLoaded: true,
    });
    return pending ? (
      <div>completion</div>
    ) : (
      <>
        {recoveryId && (
          <CindyMakeEditingActions key={recoveryId} sessionId={session.id} messageId={recoveryId} />
        )}
        <textarea aria-label="editor" />
      </>
    );
  }
  it('allows typing immediately, after reopening, and after a reply without a completion report', () => {
    const view = render(<Composer messages={[continued]} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Keep editing' } });
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Keep editing');
    expect(screen.queryByText('cindyMake.test.resume.action')).toBeNull();
    expect(button()).toBeDefined();
    view.unmount();
    const reopened = render(<Composer messages={[continued]} />);
    expect(screen.getByRole('textbox')).toBeDefined();
    reopened.rerender(
      <Composer
        messages={[
          continued,
          { clientId: 'user', role: 'user', content: 'Edit' },
          { clientId: 'reply', role: 'assistant', content: 'Done', turnCompleted: true },
        ]}
      />,
    );
    expect(screen.getByRole('textbox')).toBeDefined();
    expect(button()).toBeDefined();
    expect(h.api).not.toHaveBeenCalled();
  });
});
