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
    kind: 'github-user',
    login: 'tester',
  },
};

const platformPending: PendingIssueConfirm = {
  ...initialPending,
  submissionIdentity: {
    kind: 'platform',
    login: 'cindy-issue',
  },
  suggestedPublicName: '当前昵称',
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
  it('GitHub direct publishing only shows the selected account', () => {
    render(<IssueConfirmCard sessionId="session-a" pending={initialPending} onRespond={vi.fn()} />);
    expect(screen.getByText('issueAgent.confirm.identityGithubUser')).not.toBeNull();
    expect(screen.getByText('issueAgent.confirm.identityGithubUserHint')).not.toBeNull();
    expect(screen.queryByLabelText('issueAgent.confirm.publicNameLabel')).toBeNull();
  });

  it('platform publishing submits the edited public name', () => {
    const onRespond = vi.fn();
    render(
      <IssueConfirmCard sessionId="session-a" pending={platformPending} onRespond={onRespond} />,
    );
    const input = screen.getByLabelText('issueAgent.confirm.publicNameLabel') as HTMLInputElement;
    expect(input.value).toBe('当前昵称');
    fireEvent.change(input, { target: { value: '  公开昵称  ' } });
    fireEvent.click(screen.getByRole('button', { name: /issueAgent\.confirm\.submit/ }));
    expect(onRespond).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmed: true,
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
    fireEvent.click(screen.getByRole('button', { name: /issueAgent\.confirm\.submit/ }));
    expect(onRespond).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmed: true,
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
});
