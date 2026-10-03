// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import zhCN from '@/i18n/locales/zh-CN/common.json';
import en from '@/i18n/locales/en/common.json';
import zhTW from '@/i18n/locales/zh-TW/common.json';
import ja from '@/i18n/locales/ja/common.json';
import ko from '@/i18n/locales/ko/common.json';
import {
  CindyMakeContributionDialog,
  CindyMakeContributionStatus,
  contributionActionKey,
} from '../CindyMakeContribution';
import {
  CINDY_MAKE_CONTRIBUTION_ERRORS,
  type CindyMakeContributionDraft,
} from '../../../../shared/cindyMakeContribution';

vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const copy = zhCN.cindyMake.contribution;

async function i18nFor(locale: string, resource: object) {
  const i18n = createInstance();
  await i18n.init({
    lng: locale,
    fallbackLng: false,
    interpolation: { escapeValue: false },
    resources: { [locale]: { translation: resource } },
  });
  return i18n;
}

const draft: CindyMakeContributionDraft = {
  runId: 'run-1',
  title: 'feat: 加一个按钮',
  body: '## 这次改了什么',
  name: 'Ada',
  email: '',
  files: ['apps/desktop/src/renderer/x.tsx'],
  touchesUi: true,
  repository: 'octo/cindy',
};

async function renderDialog(invoke: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('electronAPI', {
    cindyMakeContribution: invoke,
    openExternal: vi.fn(async () => ({ success: true })),
  });
  const onOpenChange = vi.fn();
  const onSubmitted = vi.fn();
  render(
    <I18nextProvider i18n={await i18nFor('zh-CN', zhCN)}>
      <CindyMakeContributionDialog
        runId="run-1"
        onOpenChange={onOpenChange}
        onSubmitted={onSubmitted}
      />
    </I18nextProvider>,
  );
  return { onOpenChange, onSubmitted };
}

beforeEach(() => {
  vi.stubGlobal('electronAPI', { openExternal: vi.fn(async () => ({ success: true })) });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('CindyMakeContributionDialog', () => {
  it('submits only after the author fills in a real email and confirms the DCO sign-off', async () => {
    const view = {
      runId: 'run-1',
      number: 12,
      url: 'https://github.com/makecindy/cindy/pull/12',
      state: 'open' as const,
      submittedAt: 1,
    };
    const invoke = vi.fn(async (request: { action: string }) =>
      request.action === 'draft' ? draft : view,
    );
    const { onSubmitted, onOpenChange } = await renderDialog(invoke);
    await screen.findByDisplayValue(draft.title);
    expect(screen.getByText(copy.dialog.uiNote)).toBeTruthy();
    expect(
      screen.getByText(copy.dialog.public.replace('{{repository}}', 'octo/cindy')),
    ).toBeTruthy();
    const submit = screen.getByRole('button', { name: copy.dialog.submit });
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(new RegExp(copy.dialog.email)), {
      target: { value: 'ada@example.com' },
    });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('checkbox').closest('label')?.textContent).toContain(
      'Ada <ada@example.com>',
    );
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledWith(view));
    expect(invoke).toHaveBeenLastCalledWith({
      action: 'submit',
      runId: 'run-1',
      title: draft.title,
      body: draft.body,
      name: 'Ada',
      email: 'ada@example.com',
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('explains why a change cannot be submitted instead of showing the form', async () => {
    const invoke = vi.fn(async () => {
      throw new Error('[PRECONDITION_FAILED] notBound');
    });
    await renderDialog(invoke);
    expect((await screen.findByRole('alert')).textContent).toBe(copy.errors.notBound);
    expect(screen.queryByRole('button', { name: copy.dialog.submit })).toBeNull();
  });

  it('keeps the form open with the reason when GitHub refuses the submission', async () => {
    const invoke = vi.fn(async (request: { action: string }) => {
      if (request.action === 'draft') return { ...draft, email: 'ada@example.com' };
      throw new Error('[PRECONDITION_FAILED] conflict');
    });
    const { onOpenChange } = await renderDialog(invoke);
    await screen.findByDisplayValue(draft.title);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: copy.dialog.submit }));
    expect((await screen.findByRole('alert')).textContent).toBe(copy.errors.conflict);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('asks to confirm the sign-off again after the name or email changes', async () => {
    const invoke = vi.fn(async () => ({ ...draft, email: 'ada@example.com' }));
    await renderDialog(invoke);
    await screen.findByDisplayValue(draft.title);
    const checkbox = screen.getByRole('checkbox') as HTMLInputElement;
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);
    fireEvent.change(screen.getByLabelText(new RegExp(copy.dialog.email)), {
      target: { value: 'ada@other.example' },
    });
    expect(checkbox.checked).toBe(false);
    expect(
      (screen.getByRole('button', { name: copy.dialog.submit }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('opens a new pull request when the earlier one was closed', async () => {
    const invoke = vi.fn(async () => ({
      ...draft,
      existing: {
        runId: 'run-1',
        number: 3,
        url: 'https://github.com/makecindy/cindy/pull/3',
        state: 'closed' as const,
        submittedAt: 1,
      },
    }));
    await renderDialog(invoke);
    await screen.findByText(copy.dialog.reopen.replace('{{number}}', '3'));
    expect(screen.getByRole('button', { name: copy.dialog.submit })).toBeTruthy();
  });

  it('says a resubmission updates the open pull request', async () => {
    const invoke = vi.fn(async () => ({
      ...draft,
      existing: {
        runId: 'run-1',
        number: 3,
        url: 'https://github.com/makecindy/cindy/pull/3',
        submittedAt: 1,
      },
    }));
    await renderDialog(invoke);
    await screen.findByText(copy.dialog.existing.replace('{{number}}', '3'));
    expect(screen.getByRole('button', { name: copy.dialog.update })).toBeTruthy();
  });
});

describe('CindyMakeContributionStatus', () => {
  it('shows the review state in plain words and opens the pull request', async () => {
    const openExternal = vi.fn(async () => ({ success: true }));
    vi.stubGlobal('electronAPI', { openExternal });
    const url = 'https://github.com/makecindy/cindy/pull/9';
    render(
      <I18nextProvider i18n={await i18nFor('zh-CN', zhCN)}>
        <CindyMakeContributionStatus
          view={{ runId: 'r', number: 9, url, state: 'merged', submittedAt: 1 }}
        />
      </I18nextProvider>,
    );
    expect(screen.getByText(copy.state.merged.replace('{{number}}', '9'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: copy.view }));
    expect(openExternal).toHaveBeenCalledWith(url);
  });

  it('offers no new submission once the change is accepted', () => {
    const view = { runId: 'r', number: 1, url: '', submittedAt: 1 };
    expect(contributionActionKey()).toBe('cindyMake.contribution.action');
    expect(contributionActionKey({ ...view, state: 'open' })).toBe('cindyMake.contribution.update');
    expect(contributionActionKey({ ...view, state: 'closed' })).toBe(
      'cindyMake.contribution.resubmit',
    );
    expect(contributionActionKey({ ...view, state: 'merged' })).toBeUndefined();
  });
});

describe('contribution copy', () => {
  it.each([
    ['zh-CN', zhCN],
    ['zh-TW', zhTW],
    ['en', en],
    ['ja', ja],
    ['ko', ko],
  ] as const)('covers every error and state in %s', (_locale, resource) => {
    const strings = resource.cindyMake.contribution;
    for (const code of CINDY_MAKE_CONTRIBUTION_ERRORS)
      expect(strings.errors[code], code).toBeTruthy();
    for (const state of ['submitted', 'open', 'merged', 'closed'] as const)
      expect(strings.state[state]).toContain('{{number}}');
  });
});
