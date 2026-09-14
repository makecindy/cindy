// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(), refresh: vi.fn(), sync: vi.fn(), publish: vi.fn(), cancelPublish: vi.fn(),
  renameLocal: vi.fn(), listCategories: vi.fn(),
}));
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { membershipKind: 'personal', orgSlug: null } }) }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => ({ confirm: mocks.confirm }) }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));
vi.mock('../hooks/useSkillhub', () => ({ refresh: mocks.refresh }));
vi.mock('../hooks/useSkillSync', () => ({ triggerIncrementalSync: mocks.sync }));
vi.mock('../hooks/useSkillFolderHash', () => ({ invalidateHash: vi.fn() }));
vi.mock('../components/PlatformTagSelector', () => ({ PlatformTagSelector: () => null }));

import { PublishDialog, type PublishDialogProps } from '../PublishDialog';

let progress!: (event: SkillhubPublishProgressEvent) => void;
const feedback: SkillhubPublishProgressEvent = {
  phase: 'scan-result', name: 'review-helper', version: '1.0.1', status: 'rejected',
  rejectionReason: 'Private owner feedback', gates: [],
  ownerStamp: { dataOwnerId: 'owner-a', ownerGeneration: 1 },
};

beforeEach(() => {
  vi.clearAllMocks();
  setDataOwnerGeneration('owner-a', 1);
  mocks.refresh.mockReset().mockResolvedValue([]);
  mocks.confirm.mockResolvedValue(true);
  mocks.publish.mockResolvedValue({ success: true, result: { name: 'review-helper', version: '1.0.1' } });
  mocks.renameLocal.mockReset().mockResolvedValue({ success: true, newAbsolutePath: '/fixture/renamed-helper' });
  mocks.listCategories.mockResolvedValue({ success: true, categories: [] });
  vi.stubGlobal('electronAPI', { skillhub: {
    publish: mocks.publish,
    cancelPublish: mocks.cancelPublish,
    renameLocal: mocks.renameLocal,
    listCategories: mocks.listCategories,
    onPublishProgress: (listener: typeof progress) => { progress = listener; return () => {}; },
  } });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function mountPublication(overrides: Partial<PublishDialogProps> = {}) {
  const onScanResult = vi.fn();
  const onOpenChange = vi.fn();
  const onLocalRenamed = vi.fn();
  const props: PublishDialogProps = {
    open: true, onOpenChange, onScanResult, onLocalRenamed, isFirstPublish: false, latestVersion: '1.0.0', skill: {
      id: 'review-helper', urlKey: 'review-helper', engine: 'claude-code', linkedEngines: [],
      kind: 'skill', scope: 'global', mdPath: '/fixture/review-helper/SKILL.md', files: [], registryEntry: null,
      name: 'review-helper', absolutePath: '/fixture/review-helper', frontmatter: { version: '1.0.1' },
    },
    ...overrides,
  };
  const view = render(<PublishDialog {...props} />);
  if (props.isFirstPublish) {
    fireEvent.change(screen.getByPlaceholderText('skillhub.publishDialog.skillNamePlaceholder'), { target: { value: 'renamed-helper' } });
  } else {
    fireEvent.change(screen.getByPlaceholderText('skillhub.publishDialog.changelogPlaceholder'), { target: { value: 'Improve documentation' } });
  }
  return { onScanResult, onOpenChange, onLocalRenamed, unmount: view.unmount,
    rerender: (open = true) => view.rerender(<PublishDialog {...props} open={open} />) };
}

async function startPublication(overrides: Partial<PublishDialogProps> = {}) {
  const view = mountPublication(overrides);
  fireEvent.click(screen.getByRole('button', { name: 'skillhub.publishDialog.startPublish' }));
  await waitFor(() => expect(mocks.publish).toHaveBeenCalledOnce());
  return view;
}

describe('PublishDialog result delivery', () => {
  it.each(['unchanged', 'different-owner', 'same-owner-new-generation'] as const)(
    'forwards feedback after refresh only when the owner is %s', async (transition) => {
      let finishRefresh!: (value: unknown[]) => void;
      mocks.refresh.mockReturnValueOnce(new Promise((resolve) => { finishRefresh = resolve; }));
      const { onScanResult, onOpenChange } = await startPublication();
      act(() => progress(feedback));
      expect(mocks.refresh).toHaveBeenCalledOnce();
      if (transition === 'different-owner') setDataOwnerGeneration('owner-b', 2);
      if (transition === 'same-owner-new-generation') {
        setDataOwnerGeneration('owner-b', 2);
        setDataOwnerGeneration('owner-a', 3);
      }
      await act(async () => { finishRefresh([]); });
      if (transition === 'unchanged') {
        expect(onScanResult).toHaveBeenCalledWith({ status: 'rejected', gates: [], rejectionReason: 'Private owner feedback' });
        expect(onOpenChange).toHaveBeenCalledWith(false);
        expect(mocks.sync).toHaveBeenCalledWith(['review-helper']);
      } else {
        expect(onScanResult).not.toHaveBeenCalled();
        expect(onOpenChange).not.toHaveBeenCalled();
        expect(mocks.sync).not.toHaveBeenCalled();
      }
    },
  );

  it('ignores an old-owner frame already queued before it reaches the renderer', async () => {
    const { onScanResult } = await startPublication();
    setDataOwnerGeneration('owner-b', 2);
    await act(async () => progress(feedback));
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(onScanResult).not.toHaveBeenCalled();
  });

  it.each(['same-membership-new-realm', 'different-owner'] as const)(
    'closes a scanning dialog on %s without waiting for another poll event', async (transition) => {
      const view = await startPublication();
      expect(screen.getByText('skillhub.publishDialog.phaseScanningWait')).toBeTruthy();
      setDataOwnerGeneration(transition === 'different-owner' ? 'owner-b' : 'owner-a', 2);
      view.rerender();
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(view.onOpenChange).toHaveBeenCalledWith(false);
      expect(view.onScanResult).not.toHaveBeenCalled();
    },
  );

  it.each(['success', 'failure', 'exception'] as const)(
    'ignores the old publication %s after the same membership opens a dialog in a new realm', async (outcome) => {
      let settle!: (value: unknown) => void;
      let reject!: (error: Error) => void;
      mocks.publish
        .mockReturnValueOnce(new Promise((resolve, rejectPromise) => { settle = resolve; reject = rejectPromise; }))
        .mockReturnValueOnce(new Promise(() => {}));
      const view = await startPublication();
      expect(screen.getByText('skillhub.publishDialog.phasePacking')).toBeTruthy();
      setDataOwnerGeneration('owner-a', 2);
      view.rerender();
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(view.onOpenChange).toHaveBeenCalledWith(false);
      view.rerender(false);
      view.rerender(true);
      fireEvent.change(screen.getByPlaceholderText('skillhub.publishDialog.changelogPlaceholder'), { target: { value: 'New realm publication' } });
      fireEvent.click(screen.getByRole('button', { name: 'skillhub.publishDialog.startPublish' }));
      await waitFor(() => expect(mocks.publish).toHaveBeenCalledTimes(2));
      await act(async () => {
        if (outcome === 'exception') reject(new Error('Old realm request failed'));
        else settle(outcome === 'success'
          ? { success: true, result: { name: 'review-helper', version: '1.0.1' } }
          : { success: false, errorCode: 'INTERNAL', error: 'Old realm request failed' });
      });
      expect(screen.getByText('skillhub.publishDialog.phasePacking')).toBeTruthy();
      expect(screen.queryByText('skillhub.publishDialog.phaseScanningWait')).toBeNull();
      expect(view.onOpenChange).toHaveBeenCalledTimes(1);
      expect(view.onScanResult).not.toHaveBeenCalled();
    },
  );

  it('does not submit an old confirmation in the new realm', async () => {
    let finishConfirm!: (confirmed: boolean) => void;
    mocks.confirm.mockReturnValueOnce(new Promise((resolve) => { finishConfirm = resolve; }));
    const view = mountPublication();
    fireEvent.click(screen.getByRole('button', { name: 'skillhub.publishDialog.startPublish' }));
    setDataOwnerGeneration('owner-a', 2);
    view.rerender();
    await act(async () => { finishConfirm(true); });
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not cancel a new-realm publication from an old cancellation confirmation', async () => {
    mocks.publish.mockReturnValueOnce(new Promise(() => {}));
    const view = await startPublication();
    let finishConfirm!: (confirmed: boolean) => void;
    mocks.confirm.mockReturnValueOnce(new Promise((resolve) => { finishConfirm = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: 'skillhub.publishDialog.cancelReview' }));
    setDataOwnerGeneration('owner-a', 2);
    view.rerender();
    await act(async () => { finishConfirm(true); });
    expect(mocks.cancelPublish).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('repairs the same-owner route for a committed rename when closing an old-realm publication', async () => {
    mocks.publish.mockReturnValueOnce(new Promise(() => {}));
    const view = await startPublication({ isFirstPublish: true, autoCleanName: true });
    expect(mocks.renameLocal).toHaveBeenCalledOnce();
    expect(view.onLocalRenamed).not.toHaveBeenCalled();
    setDataOwnerGeneration('owner-a', 2);
    view.rerender();
    expect(view.onLocalRenamed).toHaveBeenCalledExactlyOnceWith('/fixture/renamed-helper', 'renamed-helper');
    expect(view.onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mocks.publish).toHaveBeenCalledOnce();
  });

  it.each(['same-owner', 'different-owner', 'unmounted', 'rename-rejected'] as const)(
    'reconciles a delayed rename reply only for its still-mounted local owner: %s', async (transition) => {
      let finishRename!: (value: unknown) => void;
      mocks.renameLocal.mockReturnValueOnce(new Promise((resolve) => { finishRename = resolve; }));
      const view = mountPublication({ isFirstPublish: true, autoCleanName: true });
      fireEvent.click(screen.getByRole('button', { name: 'skillhub.publishDialog.startPublish' }));
      await waitFor(() => expect(mocks.renameLocal).toHaveBeenCalledOnce());
      setDataOwnerGeneration(transition === 'different-owner' ? 'owner-b' : 'owner-a', 2);
      if (transition === 'unmounted') view.unmount();
      else view.rerender();
      await act(async () => { finishRename(transition === 'rename-rejected'
        ? { success: false, error: 'Skill mutation context changed' }
        : { success: true, newAbsolutePath: '/fixture/renamed-helper' }); });
      if (transition === 'same-owner') {
        expect(view.onLocalRenamed).toHaveBeenCalledExactlyOnceWith('/fixture/renamed-helper', 'renamed-helper');
      } else expect(view.onLocalRenamed).not.toHaveBeenCalled();
      expect(mocks.publish).not.toHaveBeenCalled();
      expect(view.onScanResult).not.toHaveBeenCalled();
    },
  );
});
