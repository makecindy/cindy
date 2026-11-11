// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog-provider';
import zhCN from '@/i18n/locales/zh-CN/common.json';
import en from '@/i18n/locales/en/common.json';
import zhTW from '@/i18n/locales/zh-TW/common.json';
import ja from '@/i18n/locales/ja/common.json';
import ko from '@/i18n/locales/ko/common.json';
import { CindyMakeStorageCard, CindyMakeStorageRow } from '../CindyMakePersonalRemote';
import type { CindyMakePersonalRemoteState } from '../../../../shared/cindyMakePersonalRemote';

vi.mock('@/features/cc-agent/GithubSetupDialog', () => ({
  GithubSetupDialog: () => <div role="dialog">github-setup</div>,
}));

const copy = zhCN.cindyMake.storage;

async function i18nFor(locale: string, resource: object) {
  const i18n = createInstance();
  // Mirror the app: React escapes rendered text, so i18next must not escape again.
  await i18n.init({
    lng: locale,
    fallbackLng: false,
    interpolation: { escapeValue: false },
    resources: { [locale]: { translation: resource } },
  });
  return i18n;
}

async function renderRow(state: CindyMakePersonalRemoteState, act = vi.fn(async () => {})) {
  const onOffer = vi.fn();
  render(
    <I18nextProvider i18n={await i18nFor('zh-CN', zhCN)}>
      <ConfirmDialogProvider>
        <CindyMakeStorageRow state={state} act={act} onOffer={onOffer} />
      </ConfirmDialogProvider>
    </I18nextProvider>,
  );
  return { act, onOffer };
}

beforeEach(() => {
  vi.stubGlobal('electronAPI', { openExternal: vi.fn(async () => ({ success: true })) });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('CindyMakeStorageRow', () => {
  const bound: CindyMakePersonalRemoteState = {
    github: 'connected',
    githubLogin: 'octo',
    choice: 'github',
    login: 'octo',
    repository: 'octo/cindy',
    sync: 'needsMerge',
    offerMigration: false,
  };

  it('points to the single Sync when both computers changed the same place', async () => {
    const { act } = await renderRow(bound);
    expect(screen.getByRole('status').textContent).toContain(copy.status.needsMerge);
    expect(screen.getByRole('status').textContent).toContain(copy.needsMergeHint);
    // The row has no sync or combine button of its own; Sync above does both.
    expect(screen.queryByRole('button', { name: copy.actions.syncNow })).toBeNull();
    expect(act).not.toHaveBeenCalled();
  });

  it('asks to generate first when this computer’s side of a combine is not generated', async () => {
    await renderRow({ ...bound, sync: 'buildFirst' });
    expect(screen.getByRole('status').textContent).toContain(copy.status.buildFirst);
    expect(screen.getByRole('status').textContent).toContain(copy.buildFirstHint);
  });

  it('saves to a new repository, with consent again, when the old one is gone', async () => {
    const { act, onOffer } = await renderRow({ ...bound, sync: 'synced', error: 'forkMissing' });
    expect(screen.getByRole('status').textContent).toContain(copy.errors.forkMissing);
    fireEvent.click(screen.getByRole('button', { name: copy.actions.saveAgain }));
    await waitFor(() => expect(onOffer).toHaveBeenCalledOnce());
    expect(act).toHaveBeenCalledExactlyOnceWith('disconnect');
  });

  it('offers reconnecting when GitHub is connected as another account', async () => {
    await renderRow({ ...bound, sync: 'synced', githubLogin: 'other', error: 'account' });
    fireEvent.click(screen.getByRole('button', { name: copy.actions.reconnect }));
    expect(screen.getByRole('dialog').textContent).toBe('github-setup');
  });

  it('explains the local-only limitation and offers to connect GitHub', async () => {
    await renderRow({ github: 'missing', offerMigration: false });
    expect(screen.getByRole('status').textContent).toContain(copy.localOnly);
    expect(screen.getByRole('status').textContent).toContain(copy.localOnlyHint);
    fireEvent.click(screen.getByRole('button', { name: copy.actions.connect }));
    expect(screen.getByRole('dialog').textContent).toBe('github-setup');
  });

  it('lets a user who kept the version local reopen the GitHub consent', async () => {
    const { onOffer, act } = await renderRow({
      github: 'connected',
      githubLogin: 'octo',
      choice: 'local',
      offerMigration: false,
    });
    expect(screen.getByRole('status').textContent).toContain(copy.localChosenHint);
    fireEvent.click(screen.getByRole('button', { name: copy.actions.save }));
    expect(onOffer).toHaveBeenCalledOnce();
    expect(act).not.toHaveBeenCalled();
  });

  it('asks for consent again before retrying a failed save', async () => {
    const { act, onOffer } = await renderRow({
      github: 'connected',
      githubLogin: 'octo',
      error: 'network',
      offerMigration: false,
    });
    expect(screen.getByRole('status').textContent).toContain(copy.errors.network);
    fireEvent.click(screen.getByRole('button', { name: copy.actions.retry }));
    expect(onOffer).toHaveBeenCalledOnce();
    expect(act).not.toHaveBeenCalled();
  });

  it('offers reconnecting after a rejected authorization; Sync then retries', async () => {
    const { act } = await renderRow({
      github: 'connected',
      githubLogin: 'octo',
      login: 'octo',
      repository: 'octo/cindy',
      sync: 'pending',
      error: 'workflowScope',
      offerMigration: false,
    });
    expect(screen.getByRole('status').textContent).toContain(copy.errors.workflowScope);
    expect(screen.getByRole('button', { name: copy.actions.reconnect })).toBeTruthy();
    expect(screen.queryByRole('button', { name: copy.actions.syncNow })).toBeNull();
    expect(act).not.toHaveBeenCalled();
  });

  it('shows a synced repository and stops syncing only after confirmation', async () => {
    const { act } = await renderRow({
      github: 'connected',
      githubLogin: 'octo',
      choice: 'github',
      login: 'octo',
      repository: 'octo/cindy',
      sync: 'synced',
      offerMigration: false,
    });
    expect(screen.getByRole('status').textContent).toContain('你的 GitHub · octo/cindy');
    expect(screen.getByRole('status').textContent).toContain(copy.status.synced);
    // Checking for changes from another computer is the single Sync above, not a row button.
    expect(screen.queryByRole('button', { name: copy.actions.syncNow })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: copy.actions.view }));
    expect(window.electronAPI.openExternal).toHaveBeenCalledWith(
      'https://github.com/octo/cindy/tree/cindy-personal',
    );
    fireEvent.click(screen.getByRole('button', { name: copy.actions.stop }));
    expect(act).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: copy.stopConfirm.confirm }));
    await waitFor(() => expect(act).toHaveBeenCalledWith('disconnect'));
  });

  it('pauses on an account mismatch without offering to upload', async () => {
    await renderRow({
      github: 'connected',
      githubLogin: 'someone',
      choice: 'github',
      login: 'octo',
      repository: 'octo/cindy',
      sync: 'synced',
      error: 'account',
      offerMigration: false,
    });
    expect(screen.getByRole('status').textContent).toContain(
      copy.status.account.replace('{{login}}', 'someone'),
    );
    expect(screen.queryByRole('button', { name: copy.actions.syncNow })).toBeNull();
  });

  it('shows running progress without actions that could race it', async () => {
    await renderRow({
      github: 'connected',
      githubLogin: 'octo',
      running: 'save',
      step: 'fork',
      offerMigration: false,
    });
    expect(screen.getByRole('status').textContent).toContain(copy.running.save);
    expect(screen.getByRole('status').textContent).toContain(copy.step.fork);
    expect(screen.queryAllByRole('button')).toEqual([]);
  });
});

describe('CindyMakeStorageCard', () => {
  it.each([
    ['zh-CN', zhCN],
    ['zh-TW', zhTW],
    ['en', en],
    ['ja', ja],
    ['ko', ko],
  ] as const)(
    'states that the fork is public and stays until a choice in %s',
    async (locale, resource) => {
      const onSave = vi.fn();
      const onKeepLocal = vi.fn();
      render(
        <I18nextProvider i18n={await i18nFor(locale, resource)}>
          <CindyMakeStorageCard
            state={{
              github: 'connected',
              githubLogin: 'octo',
              offerMigration: true,
              sourceReady: true,
            }}
            onSave={onSave}
            onKeepLocal={onKeepLocal}
          />
        </I18nextProvider>,
      );
      const strings = resource.cindyMake.storage;
      expect(screen.getByRole('heading').textContent).toBe(strings.card.title);
      expect(document.body.textContent).toContain(
        strings.card.public.replace('{{repository}}', 'octo/cindy'),
      );
      // No "not now": the offer only ends by binding or an explicit local-only choice.
      expect(screen.getAllByRole('button')).toHaveLength(2);
      fireEvent.click(screen.getByRole('button', { name: strings.actions.save }));
      fireEvent.click(screen.getByRole('button', { name: strings.actions.keepLocal }));
      expect([onSave, onKeepLocal].map((fn) => fn.mock.calls.length)).toEqual([1, 1]);
    },
  );

  it('offers a new computer the personal version already on GitHub', async () => {
    const onSave = vi.fn();
    render(
      <I18nextProvider i18n={await i18nFor('zh-CN', zhCN)}>
        <CindyMakeStorageCard
          state={{
            github: 'connected',
            githubLogin: 'octo',
            existingPersonal: 'octo/cindy-1',
            sourceReady: false,
            error: 'network',
            offerMigration: true,
          }}
          onSave={onSave}
          onKeepLocal={vi.fn()}
        />
      </I18nextProvider>,
    );
    expect(screen.getByRole('heading').textContent).toBe(copy.card.existingTitle);
    expect(document.body.textContent).toContain(copy.card.existingKeeps);
    expect(document.body.textContent).toContain(copy.card.prepareFirst);
    expect(screen.getByRole('status').textContent).toBe(copy.errors.network);
    fireEvent.click(screen.getByRole('button', { name: copy.actions.useExisting }));
    expect(onSave).toHaveBeenCalledOnce();
  });

  it('keeps both choices disabled while the source is prepared before saving', async () => {
    render(
      <I18nextProvider i18n={await i18nFor('zh-CN', zhCN)}>
        <CindyMakeStorageCard
          state={{
            github: 'connected',
            githubLogin: 'octo',
            offerMigration: true,
            sourceReady: false,
          }}
          preparing
          onSave={vi.fn()}
          onKeepLocal={vi.fn()}
        />
      </I18nextProvider>,
    );
    for (const button of screen.getAllByRole('button'))
      expect(button).toHaveProperty('disabled', true);
  });
});
