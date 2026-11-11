// @vitest-environment jsdom
// Tier: unit. Actual card decisions and saved drafts; Markdown layout is covered by ui:check.
// Dash's redesign replaces the old checkbox/form with preview -> edit -> preview -> public submit.
// Minimal regression: Cmd+Enter while editing must return to review without publishing.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IssueConfirmCard } from '../IssueConfirmCard';
import { clearIssueConfirmDraftsForSession } from '@/lib/issueConfirmDraftStore';
import type { PendingIssueConfirm } from '@/lib/makerChatStore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh-CN' } }),
}));
vi.mock('@/components/chat/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <p>{content}</p>,
}));
const pending: PendingIssueConfirm = {
  requestId: 'issue-a',
  draft: { title: '原始标题', body: '原始正文', type: 'bug' },
  env: {
    appVersion: '1',
    platform: 'darwin',
    arch: 'arm64',
    osVersion: 'macOS',
    harness: 'Codex',
    modelId: 'test',
    region: 'cn',
  },
  submissionIdentity: { kind: 'platform', login: 'cindy-bot' },
  githubUserIdentity: { kind: 'github-user', login: 'tester' },
  suggestedPublicName: '当前昵称',
};
const button = (key: string) =>
  screen.getByRole('button', { name: new RegExp(`issueAgent.confirm.${key}`) });
const edit = () => fireEvent.click(button('edit'));
const done = () =>
  fireEvent.click(
    screen.getAllByRole('button', { name: 'issueAgent.confirm.doneEditing' }).at(-1)!,
  );
const identity = () => fireEvent.click(screen.getByText('issueAgent.confirm.identitySettings'));
afterEach(() => {
  cleanup();
  clearIssueConfirmDraftsForSession('a');
  clearIssueConfirmDraftsForSession('b');
});

describe('feedback preview and publication', () => {
  // PR #9764: a window listener let editing A publish preview B in split view.
  // Existing single-card coverage missed ownership. Real cards + focused DOM key
  // events must return only A to preview, then publish/cancel only the focused card.
  it.each(['ctrlKey', 'metaKey'] as const)(
    'scopes %s shortcuts to the focused split-view card',
    (modifier) => {
      const respondA = vi.fn();
      const respondB = vi.fn();
      render(
        <>
          <section aria-label="pane A">
            <IssueConfirmCard sessionId="a" pending={pending} onRespond={respondA} />
          </section>
          <section aria-label="pane B">
            <IssueConfirmCard
              sessionId="b"
              pending={{ ...pending, requestId: 'issue-b' }}
              onRespond={respondB}
            />
          </section>
          <input aria-label="other composer" />
        </>,
      );
      const paneA = within(screen.getByRole('region', { name: 'pane A' }));
      const paneB = within(screen.getByRole('region', { name: 'pane B' }));
      fireEvent.click(paneA.getByRole('button', { name: 'issueAgent.confirm.edit' }));
      const body = paneA.getByLabelText('issueAgent.confirm.bodyLabel');
      body.focus();
      fireEvent.keyDown(body, { key: 'Enter', [modifier]: true });
      expect(respondA).not.toHaveBeenCalled();
      expect(respondB).not.toHaveBeenCalled();
      expect(paneA.getByRole('heading', { name: '原始标题' })).not.toBeNull();
      fireEvent.keyDown(document.activeElement!, { key: 'Enter', [modifier]: true });
      expect(respondA).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ confirmed: true }),
      );
      expect(respondB).not.toHaveBeenCalled();
      const otherComposer = screen.getByRole('textbox', { name: 'other composer' });
      otherComposer.focus();
      fireEvent.keyDown(otherComposer, { key: 'Escape' });
      fireEvent.keyDown(otherComposer, { key: 'Enter', [modifier]: true });
      expect(respondA).toHaveBeenCalledTimes(1);
      expect(respondB).not.toHaveBeenCalled();
      const submitB = paneB.getByRole('button', { name: 'issueAgent.confirm.publicSubmit' });
      submitB.focus();
      fireEvent.keyDown(submitB, { key: 'Escape' });
      expect(respondB).toHaveBeenCalledExactlyOnceWith({ confirmed: false });
      expect(respondA).toHaveBeenCalledTimes(1);
    },
  );
  it('shows a reviewable draft and publishes only through the explicit public action', () => {
    const onRespond = vi.fn();
    render(<IssueConfirmCard sessionId="a" pending={pending} onRespond={onRespond} />);
    expect(screen.getByRole('heading', { name: '原始标题' })).not.toBeNull();
    expect(screen.getByText('原始正文')).not.toBeNull();
    expect(screen.queryByLabelText('issueAgent.confirm.titleLabel')).toBeNull();
    expect(screen.getByText('issueAgent.confirm.identitySettings').closest('details')!.open).toBe(
      false,
    );
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByText('issueAgent.confirm.publicationNotice')).not.toBeNull();
    expect(onRespond).not.toHaveBeenCalled();
    fireEvent.click(button('publicSubmit'));
    expect(onRespond).toHaveBeenCalledExactlyOnceWith({
      confirmed: true,
      ...pending.draft,
      submissionIdentity: pending.submissionIdentity,
      publicName: '当前昵称',
      uiLanguage: 'zh-CN',
    });
  });
  it('returns edited content to preview before keyboard publication', () => {
    const onRespond = vi.fn();
    render(<IssueConfirmCard sessionId="a" pending={pending} onRespond={onRespond} />);
    edit();
    fireEvent.change(screen.getByLabelText('issueAgent.confirm.titleLabel'), {
      target: { value: ' 已修改 ' },
    });
    fireEvent.change(screen.getByLabelText('issueAgent.confirm.bodyLabel'), {
      target: { value: ' 新正文 ' },
    });
    fireEvent.click(screen.getByRole('radio', { name: 'issueAgent.confirm.typeFeature' }));
    expect(screen.queryByRole('button', { name: /publicSubmit/ })).toBeNull();
    const body = screen.getByLabelText('issueAgent.confirm.bodyLabel');
    body.focus();
    fireEvent.keyDown(body, { key: 'Enter', metaKey: true });
    expect(onRespond).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: '已修改' })).not.toBeNull();
    fireEvent.keyDown(document.activeElement!, { key: 'Enter', metaKey: true, repeat: true });
    expect(onRespond).not.toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement!, { key: 'Enter', metaKey: true });
    expect(onRespond).toHaveBeenCalledWith(
      expect.objectContaining({ title: '已修改', body: '新正文', type: 'feature' }),
    );
  });
  it('Escape leaves editing first; cancellation never needs a valid draft', () => {
    const onRespond = vi.fn();
    render(<IssueConfirmCard sessionId="a" pending={pending} onRespond={onRespond} />);
    edit();
    fireEvent.change(screen.getByLabelText('issueAgent.confirm.titleLabel'), {
      target: { value: '' },
    });
    const title = screen.getByLabelText('issueAgent.confirm.titleLabel');
    title.focus();
    fireEvent.keyDown(title, { key: 'Escape' });
    expect(onRespond).not.toHaveBeenCalled();
    expect((button('publicSubmit') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(onRespond).toHaveBeenCalledExactlyOnceWith({ confirmed: false });
  });
  it('restores edits after remount and isolates both request and session', () => {
    const view = (sessionId: string, requestId: string) => (
      <IssueConfirmCard
        key={`${sessionId}:${requestId}`}
        sessionId={sessionId}
        pending={{ ...pending, requestId }}
        onRespond={vi.fn()}
      />
    );
    const { rerender } = render(view('a', 'one'));
    edit();
    fireEvent.change(screen.getByLabelText('issueAgent.confirm.titleLabel'), {
      target: { value: '已修改' },
    });
    fireEvent.change(screen.getByLabelText('issueAgent.confirm.bodyLabel'), {
      target: { value: '已补充正文' },
    });
    fireEvent.click(screen.getByRole('radio', { name: 'issueAgent.confirm.typeFeature' }));
    identity();
    fireEvent.change(screen.getByLabelText('issueAgent.confirm.publicNameLabel'), {
      target: { value: '新昵称' },
    });
    for (const [session, request] of [
      ['b', 'one'],
      ['a', 'two'],
    ]) {
      rerender(view(session, request));
      expect(screen.getByRole('heading', { name: '原始标题' })).not.toBeNull();
    }
    rerender(view('a', 'one'));
    expect(screen.getByRole('heading', { name: '已修改' })).not.toBeNull();
    expect(screen.getByText('已补充正文')).not.toBeNull();
    identity();
    expect(
      (screen.getByLabelText('issueAgent.confirm.publicNameLabel') as HTMLInputElement).value,
    ).toBe('新昵称');
    edit();
    expect(
      screen
        .getByRole('radio', { name: 'issueAgent.confirm.typeFeature' })
        .getAttribute('aria-checked'),
    ).toBe('true');
    done();
  });
  it('keeps system details available without requiring them to be expanded', () => {
    render(<IssueConfirmCard sessionId="a" pending={pending} onRespond={vi.fn()} />);
    const summary = screen.getByText('issueAgent.confirm.environment');
    expect(summary.closest('details')!.open).toBe(false);
    fireEvent.click(summary);
    expect(summary.closest('details')!.open).toBe(true);
    expect(screen.getByText('issueAgent.confirm.runtimeLine')).not.toBeNull();
    expect(screen.getByText('issueAgent.confirm.regionLine')).not.toBeNull();
  });
});

describe('public identity', () => {
  it('offers the connected GitHub account and omits platform attribution for it', () => {
    const onRespond = vi.fn();
    render(<IssueConfirmCard sessionId="a" pending={pending} onRespond={onRespond} />);
    identity();
    fireEvent.click(button('identityGithubUser'));
    expect(screen.queryByLabelText('issueAgent.confirm.publicNameLabel')).toBeNull();
    fireEvent.click(button('publicSubmit'));
    expect(onRespond).toHaveBeenCalledWith(
      expect.objectContaining({ submissionIdentity: pending.githubUserIdentity }),
    );
    expect(onRespond.mock.calls[0][0]).not.toHaveProperty('publicName');
  });
  it('does not offer an unavailable account', () => {
    render(
      <IssueConfirmCard
        sessionId="a"
        pending={{ ...pending, githubUserIdentity: undefined }}
        onRespond={vi.fn()}
      />,
    );
    identity();
    expect(
      screen.queryByRole('button', { name: 'issueAgent.confirm.identityGithubUser' }),
    ).toBeNull();
  });
  it('honors an old host that fixed the GitHub identity', () => {
    const onRespond = vi.fn();
    render(
      <IssueConfirmCard
        sessionId="a"
        pending={{
          ...pending,
          submissionIdentity: { kind: 'github-user', login: 'legacy' },
          githubUserIdentity: undefined,
        }}
        onRespond={onRespond}
      />,
    );
    identity();
    expect(
      screen.queryByRole('button', { name: 'issueAgent.confirm.identityPlatform' }),
    ).toBeNull();
    fireEvent.click(button('publicSubmit'));
    expect(onRespond).toHaveBeenCalledWith(
      expect.objectContaining({ submissionIdentity: { kind: 'github-user', login: 'legacy' } }),
    );
  });
  it.each(['', 'name\u0001'])(
    'blocks invalid attribution %j and allows anonymous recovery',
    (invalid) => {
      const onRespond = vi.fn();
      render(<IssueConfirmCard sessionId="a" pending={pending} onRespond={onRespond} />);
      identity();
      fireEvent.change(screen.getByLabelText('issueAgent.confirm.publicNameLabel'), {
        target: { value: invalid },
      });
      expect((button('publicSubmit') as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(button('useAnonymous'));
      fireEvent.click(button('publicSubmit'));
      expect(onRespond).toHaveBeenCalledWith(
        expect.objectContaining({ publicName: 'issueAgent.confirm.anonymous' }),
      );
    },
  );
  it('submits a trimmed custom public name', () => {
    const onRespond = vi.fn();
    render(<IssueConfirmCard sessionId="a" pending={pending} onRespond={onRespond} />);
    identity();
    fireEvent.change(screen.getByLabelText('issueAgent.confirm.publicNameLabel'), {
      target: { value: '  公开昵称  ' },
    });
    fireEvent.click(button('publicSubmit'));
    expect(onRespond).toHaveBeenCalledWith(expect.objectContaining({ publicName: '公开昵称' }));
  });
});
