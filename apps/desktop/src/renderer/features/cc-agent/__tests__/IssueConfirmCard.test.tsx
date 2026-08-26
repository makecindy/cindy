// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { IssueConfirmCard } from '../IssueConfirmCard';
import { clearIssueConfirmDraftsForSession } from '@/lib/issueConfirmDraftStore';
import type { PendingIssueConfirm } from '@/lib/makerChatStore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'zh-CN' },
  }),
}));

const initialPending: PendingIssueConfirm = {
  requestId: 'issue-request-a',
  draft: {
    title: '原始标题',
    body: '原始正文',
    type: 'bug',
  },
  env: {
    appVersion: '0.1.18',
    platform: 'win32',
    arch: 'x64',
    osVersion: '10.0',
  },
  submissionIdentity: {
    kind: 'platform',
    login: 'cindy-issue',
  },
  githubUserIdentity: { kind: 'github-user', login: 'tester' },
  suggestedPublicName: '当前昵称',
};

const platformPending: PendingIssueConfirm = {
  ...initialPending,
  githubUserIdentity: undefined,
};

const legacyGithubPending: PendingIssueConfirm = {
  ...initialPending,
  requestId: 'issue-request-legacy-github',
  submissionIdentity: { kind: 'github-user', login: 'legacy-user' },
  githubUserIdentity: undefined,
  suggestedPublicName: undefined,
};

function Harness() {
  const [visible, setVisible] = useState(true);

  return (
    <>
      <button type="button" onClick={() => setVisible((current) => !current)}>
        switch session
      </button>
      {visible ? (
        <IssueConfirmCard sessionId="session-a" pending={initialPending} onRespond={vi.fn()} />
      ) : null}
    </>
  );
}

function confirmPublicContent() {
  fireEvent.click(screen.getByRole('checkbox', { name: 'issueAgent.confirm.privacyConfirm' }));
}

afterEach(() => {
  cleanup();
  clearIssueConfirmDraftsForSession('session-a');
  clearIssueConfirmDraftsForSession('session-b');
});

describe('IssueConfirmCard draft persistence', () => {
  it('restores title, body and type after a session-switch remount', () => {
    render(<Harness />);

    fireEvent.change(screen.getByLabelText('issueAgent.confirm.titleLabel'), {
      target: { value: '编辑后的标题' },
    });
    fireEvent.change(screen.getByLabelText('issueAgent.confirm.bodyLabel'), {
      target: { value: '编辑后的正文' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'issueAgent.confirm.typeFeature' }));

    fireEvent.click(screen.getByRole('button', { name: 'switch session' }));
    expect(screen.queryByLabelText('issueAgent.confirm.titleLabel')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'switch session' }));
    expect((screen.getByLabelText('issueAgent.confirm.titleLabel') as HTMLInputElement).value).toBe(
      '编辑后的标题',
    );
    expect(
      (screen.getByLabelText('issueAgent.confirm.bodyLabel') as HTMLTextAreaElement).value,
    ).toBe('编辑后的正文');
    expect(
      screen
        .getByRole('button', { name: 'issueAgent.confirm.typeFeature' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('isolates drafts by both sessionId and requestId', () => {
    const onRespond = vi.fn();
    const { rerender } = render(
      <IssueConfirmCard
        key="session-a:issue-request-a"
        sessionId="session-a"
        pending={initialPending}
        onRespond={onRespond}
      />,
    );

    fireEvent.change(screen.getByLabelText('issueAgent.confirm.titleLabel'), {
      target: { value: '会话 A 的编辑' },
    });

    rerender(
      <IssueConfirmCard
        key="session-b:issue-request-a"
        sessionId="session-b"
        pending={initialPending}
        onRespond={onRespond}
      />,
    );
    expect((screen.getByLabelText('issueAgent.confirm.titleLabel') as HTMLInputElement).value).toBe(
      '原始标题',
    );

    rerender(
      <IssueConfirmCard
        key="session-a:issue-request-b"
        sessionId="session-a"
        pending={{ ...initialPending, requestId: 'issue-request-b' }}
        onRespond={onRespond}
      />,
    );
    expect((screen.getByLabelText('issueAgent.confirm.titleLabel') as HTMLInputElement).value).toBe(
      '原始标题',
    );

    rerender(
      <IssueConfirmCard
        key="session-a:issue-request-a"
        sessionId="session-a"
        pending={initialPending}
        onRespond={onRespond}
      />,
    );
    expect((screen.getByLabelText('issueAgent.confirm.titleLabel') as HTMLInputElement).value).toBe(
      '会话 A 的编辑',
    );
  });

  it('restores the platform public name after a session-switch remount', () => {
    function PlatformHarness() {
      const [visible, setVisible] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setVisible((current) => !current)}>
            switch platform session
          </button>
          {visible ? (
            <IssueConfirmCard sessionId="session-a" pending={platformPending} onRespond={vi.fn()} />
          ) : null}
        </>
      );
    }

    render(<PlatformHarness />);
    fireEvent.change(screen.getByLabelText('issueAgent.confirm.publicNameLabel'), {
      target: { value: '编辑后的昵称' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'switch platform session' }));
    fireEvent.click(screen.getByRole('button', { name: 'switch platform session' }));
    expect(
      (screen.getByLabelText('issueAgent.confirm.publicNameLabel') as HTMLInputElement).value,
    ).toBe('编辑后的昵称');
  });
});

describe('IssueConfirmCard submission identity', () => {
  it('defaults to the platform bot and offers a verified GitHub account as an extra option', () => {
    const onRespond = vi.fn();
    render(
      <IssueConfirmCard sessionId="session-a" pending={initialPending} onRespond={onRespond} />,
    );

    expect(
      screen
        .getByRole('button', { name: 'issueAgent.confirm.identityPlatform' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    expect(screen.getByText('issueAgent.confirm.privacyHint')).not.toBeNull();
    expect(screen.getByText('issueAgent.confirm.identityPlatformHint')).not.toBeNull();
    expect(screen.getByLabelText('issueAgent.confirm.publicNameLabel')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'issueAgent.confirm.identityGithubUser' }));
    expect(screen.getByText('issueAgent.confirm.identityGithubUserHint')).not.toBeNull();
    expect(screen.queryByLabelText('issueAgent.confirm.publicNameLabel')).toBeNull();
    confirmPublicContent();
    fireEvent.click(screen.getByRole('button', { name: /issueAgent\.confirm\.submit/ }));
    expect(onRespond).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmed: true,
        submissionIdentity: { kind: 'github-user', login: 'tester' },
      }),
    );
  });

  it('does not show a GitHub account option when none is currently available', () => {
    render(
      <IssueConfirmCard sessionId="session-a" pending={platformPending} onRespond={vi.fn()} />,
    );
    expect(
      screen.getByRole('button', { name: 'issueAgent.confirm.identityPlatform' }),
    ).not.toBeNull();
    expect(
      screen.queryByRole('button', { name: 'issueAgent.confirm.identityGithubUser' }),
    ).toBeNull();
  });

  it('keeps an old-Main GitHub identity fixed instead of dropping or mislabeling the card', () => {
    const onRespond = vi.fn();
    render(
      <IssueConfirmCard
        sessionId="session-a"
        pending={legacyGithubPending}
        onRespond={onRespond}
      />,
    );

    expect(
      screen
        .getByRole('button', { name: 'issueAgent.confirm.identityGithubUser' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      screen.queryByRole('button', { name: 'issueAgent.confirm.identityPlatform' }),
    ).toBeNull();
    expect(screen.getByText('issueAgent.confirm.identityGithubUserHint')).not.toBeNull();
    expect(screen.queryByLabelText('issueAgent.confirm.publicNameLabel')).toBeNull();

    confirmPublicContent();
    fireEvent.click(screen.getByRole('button', { name: /issueAgent\.confirm\.submit/ }));
    expect(onRespond).toHaveBeenCalledWith({
      confirmed: true,
      title: '原始标题',
      body: '原始正文',
      type: 'bug',
      submissionIdentity: { kind: 'github-user', login: 'legacy-user' },
      uiLanguage: 'zh-CN',
    });
  });

  it('platform publishing submits the edited public name', () => {
    const onRespond = vi.fn();
    render(
      <IssueConfirmCard sessionId="session-a" pending={platformPending} onRespond={onRespond} />,
    );
    const input = screen.getByLabelText('issueAgent.confirm.publicNameLabel') as HTMLInputElement;
    expect(input.value).toBe('当前昵称');
    fireEvent.change(input, { target: { value: '  公开昵称  ' } });
    confirmPublicContent();
    fireEvent.click(screen.getByRole('button', { name: /issueAgent\.confirm\.submit/ }));
    expect(onRespond).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmed: true,
        submissionIdentity: { kind: 'platform', login: 'cindy-issue' },
        publicName: '公开昵称',
      }),
    );
  });

  it('platform publishing can switch to the localized anonymous attribution', () => {
    const onRespond = vi.fn();
    render(
      <IssueConfirmCard
        sessionId="session-a"
        pending={{ ...platformPending, requestId: 'issue-request-anonymous' }}
        onRespond={onRespond}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'issueAgent.confirm.useAnonymous' }));
    expect(
      (screen.getByLabelText('issueAgent.confirm.publicNameLabel') as HTMLInputElement).value,
    ).toBe('issueAgent.confirm.anonymous');
    confirmPublicContent();
    fireEvent.click(screen.getByRole('button', { name: /issueAgent\.confirm\.submit/ }));
    expect(onRespond).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmed: true,
        submissionIdentity: { kind: 'platform', login: 'cindy-issue' },
        publicName: 'issueAgent.confirm.anonymous',
      }),
    );
  });

  it('platform publishing rejects empty public names and constrains the input', () => {
    render(
      <IssueConfirmCard
        sessionId="session-a"
        pending={{ ...platformPending, requestId: 'issue-request-invalid' }}
        onRespond={vi.fn()}
      />,
    );
    const input = screen.getByLabelText('issueAgent.confirm.publicNameLabel');
    const submit = screen.getByRole('button', { name: /issueAgent\.confirm\.submit/ });
    fireEvent.change(input, { target: { value: '' } });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    expect((input as HTMLInputElement).type).toBe('text');
    expect((input as HTMLInputElement).maxLength).toBe(100);
  });

  it('requires explicit public-content confirmation and resets it after edits', () => {
    const onRespond = vi.fn();
    render(
      <IssueConfirmCard sessionId="session-a" pending={platformPending} onRespond={onRespond} />,
    );

    const submit = screen.getByRole('button', { name: /issueAgent\.confirm\.submit/ });
    const confirmation = screen.getByRole('checkbox', {
      name: 'issueAgent.confirm.privacyConfirm',
    });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    expect((confirmation as HTMLInputElement).checked).toBe(false);

    confirmPublicContent();
    expect((submit as HTMLButtonElement).disabled).toBe(false);

    fireEvent.change(screen.getByLabelText('issueAgent.confirm.bodyLabel'), {
      target: { value: '重新编辑后的正文' },
    });
    expect((confirmation as HTMLInputElement).checked).toBe(false);
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    confirmPublicContent();
    fireEvent.click(submit);
    expect(onRespond).toHaveBeenCalledWith(expect.objectContaining({ body: '重新编辑后的正文' }));
  });
});
