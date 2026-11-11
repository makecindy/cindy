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
import { getPublishErrorCopy } from '../lib/publishErrorMap';

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

const skillFixture: PublishDialogProps['skill'] = {
  id: 'review-helper', urlKey: 'review-helper', engine: 'claude-code', linkedEngines: [],
  kind: 'skill', scope: 'global', mdPath: '/fixture/review-helper/SKILL.md', files: [], registryEntry: null,
  name: 'review-helper', absolutePath: '/fixture/review-helper', frontmatter: { version: '1.0.1' },
};

function mountPublication(overrides: Partial<PublishDialogProps> = {}) {
  const onScanResult = vi.fn();
  const onOpenChange = vi.fn();
  const onLocalRenamed = vi.fn();
  const props: PublishDialogProps = {
    open: true, onOpenChange, onScanResult, onLocalRenamed, isFirstPublish: false, latestVersion: '1.0.0', skill: skillFixture,
    ...overrides,
  };
  const view = render(<PublishDialog {...props} />);
  if (props.isFirstPublish && props.autoCleanName) {
    fireEvent.change(screen.getByPlaceholderText('skillhub.publishDialog.skillNamePlaceholder'), { target: { value: 'renamed-helper' } });
  } else if (!props.isFirstPublish) {
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
  it.each([true, false])('lets the user rename after deletion when first publication is %s', async (isFirstPublish) => {
    mocks.publish.mockResolvedValueOnce({ success: false, errorCode: 'SKILL_DELETED', error: '同名技能已删除' });
    await startPublication({ isFirstPublish });
    const renameAction = getPublishErrorCopy('SKILL_DELETED').primaryAction.label;
    fireEvent.click(await screen.findByRole('button', { name: renameAction }));
    fireEvent.change(screen.getByPlaceholderText('skillhub.publishDialog.skillNamePlaceholder'), { target: { value: 'renamed-helper' } });
    fireEvent.click(screen.getByRole('button', { name: 'skillhub.publishDialog.startPublish' }));
    await waitFor(() => expect(mocks.renameLocal).toHaveBeenCalledWith({ absolutePath: '/fixture/review-helper', newName: 'renamed-helper' }));
    await waitFor(() => expect(mocks.publish).toHaveBeenCalledTimes(2));
    expect(mocks.publish.mock.calls[1][0]).toMatchObject({
      name: 'renamed-helper', absolutePath: '/fixture/renamed-helper', isFirstPublish: true,
    });
  });

  it('checks the discovered path on the first rename and the current path on a subsequent rename', async () => {
    mocks.publish.mockResolvedValueOnce({ success: false, errorCode: 'SKILL_DELETED', error: '同名技能已删除' });
    await startPublication({ isFirstPublish: true, autoCleanName: true,
      skill: { ...skillFixture, discoveredPath: '/fixture/link-helper' } });
    expect(mocks.renameLocal).toHaveBeenNthCalledWith(1, {
      absolutePath: '/fixture/link-helper', newName: 'renamed-helper',
    });
    expect(mocks.publish.mock.calls[0][0]).toMatchObject({ absolutePath: '/fixture/renamed-helper' });

    mocks.renameLocal.mockResolvedValueOnce({ success: true, newAbsolutePath: '/fixture/final-helper' });
    fireEvent.click(await screen.findByRole('button', { name: getPublishErrorCopy('SKILL_DELETED').primaryAction.label }));
    fireEvent.change(screen.getByPlaceholderText('skillhub.publishDialog.skillNamePlaceholder'), { target: { value: 'final-helper' } });
    fireEvent.click(screen.getByRole('button', { name: 'skillhub.publishDialog.startPublish' }));
    await waitFor(() => expect(mocks.renameLocal).toHaveBeenNthCalledWith(2, {
      absolutePath: '/fixture/renamed-helper', newName: 'final-helper',
    }));
    await waitFor(() => expect(mocks.publish).toHaveBeenCalledTimes(2));
    expect(mocks.publish.mock.calls[1][0]).toMatchObject({
      name: 'final-helper', absolutePath: '/fixture/final-helper', isFirstPublish: true,
    });
  });

  it('shows a short validation reason delivered through the IPC result fallback', async () => {
    mocks.publish.mockResolvedValue({ success: false, errorCode: 'INVALID_PARAMS', error: '标签不存在' });
    await startPublication();
    expect(await screen.findByText('标签不存在')).toBeTruthy();
  });

  it('uses localized recovery copy when local visibility validation has no server detail', async () => {
    await startPublication();
    act(() => progress({ phase: 'failed', name: 'review-helper', errorCode: 'INVALID_VISIBILITY', message: '',
      ownerStamp: { dataOwnerId: 'owner-a', ownerGeneration: 1 } }));
    expect(await screen.findByText(getPublishErrorCopy('INVALID_VISIBILITY').message)).toBeTruthy();
    expect(screen.queryByText('Organization skills only support public or organization visibility')).toBeNull();
    expect(screen.queryByText('Personal skills only support public or private visibility')).toBeNull();
  });

  it.each(['PERMISSION_DENIED', 'NOT_AUTHOR', 'API_KEY_MISSING', 'SKILL_HUB_READ_ONLY', 'OSS_PUT_EXPIRED', 'OSS_OBJECT_NOT_FOUND'] as const)('does not expose %s diagnostics or offer to edit the request', async (errorCode) => {
    mocks.publish.mockResolvedValue({ success: false, errorCode, error: 'private diagnostic' });
    await startPublication();
    expect(await screen.findByText(getPublishErrorCopy(errorCode).title)).toBeTruthy();
    expect(screen.queryByText('private diagnostic')).toBeNull();
    expect(screen.queryByRole('button', { name: getPublishErrorCopy('INVALID_PARAMS').primaryAction.label })).toBeNull();
  });

  it('shows a short reason from a failed progress event', async () => {
    await startPublication();
    act(() => progress({ phase: 'failed', name: 'review-helper', errorCode: 'MANIFEST_INVALID', message: '缺少 description',
      ownerStamp: { dataOwnerId: 'owner-a', ownerGeneration: 1 } }));
    expect(await screen.findByText('缺少 description')).toBeTruthy();
  });

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
