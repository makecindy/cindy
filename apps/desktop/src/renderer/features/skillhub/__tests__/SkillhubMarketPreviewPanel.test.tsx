// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDataOwnerGeneration, setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ dataOwnerId: getDataOwnerGeneration().dataOwnerId }),
}));

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  const t = (key: string) => key;
  return { ...actual, useTranslation: () => ({ t }) };
});
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/components/chat/MarkdownRenderer', () => ({ MarkdownRenderer: () => null }));
vi.mock('@/features/cc-agent/NewMakerDraftRoute', () => ({ NEW_MAKER_DRAFT_KEY: 'draft' }));
vi.mock('@/lib/composerDraftStore', () => ({ plainTextToTiptapDoc: vi.fn(), saveDraft: vi.fn() }));
vi.mock('@/state/newMakerDraft', () => ({ resetDraftWorkspaceTargets: vi.fn() }));
vi.mock('../components/MarketCard', () => ({ ManageMenu: () => null }));
vi.mock('../components/MarketLocalSkills', () => ({ MarketLocalSkills: () => null }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));

import { SkillhubMarketPreviewPanel } from '../SkillhubMarketPreviewPanel';
import type { MarketSkill } from '../hooks/useMarketList';

const getScanStatus = vi.fn();
const skill: MarketSkill = {
  name: 'review-example', displayName: 'Review example', description: '',
  authorName: 'Publisher', authorId: 'publisher', authorAvatarUrl: null, avatarInitial: 'P',
  isMine: true, canManage: true, latestVersion: '1.0.0', moderationStatus: 'approved',
  pendingVersion: { version: '1.0.1', status: 'rejected' }, visibility: 'PUBLIC',
  visibleDeptIds: [], categories: [], tags: [], githubUrl: null,
  publishedAt: '2026-09-08T00:00:00.000Z', relativeTime: '', downloads: 0,
  installedLocally: false, installedVersion: null, installedAbsolutePath: null,
  hasAnyInstall: false, latestPublishedFromDeviceId: null, cardState: 'not-installed',
};
const feedback = {
  success: true, status: 'rejected', rejectionReason: 'Remove private organization notes.',
  gates: [{ name: 'security-scan', status: 'passed' }],
};

beforeEach(() => {
  setDataOwnerGeneration('owner-a', 1);
  getScanStatus.mockReset();
  vi.stubGlobal('electronAPI', { skillhub: {
    getPublishedFiles: vi.fn().mockResolvedValue({ success: true, files: [] }),
    getScanStatus,
  } });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('published Skill rejection feedback', () => {
  it.each(['first publication', 'updated version'])('opens the reason for a rejected %s', async (scenario) => {
    getScanStatus.mockResolvedValue(feedback);
    const publishedSkill = scenario === 'first publication'
      ? { ...skill, latestVersion: '1.0.1', moderationStatus: 'rejected', pendingVersion: undefined }
      : skill;
    render(<SkillhubMarketPreviewPanel skill={publishedSkill} open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'skillhub.publishedStatus.rejected' }));
    expect(await screen.findByText(feedback.rejectionReason)).toBeTruthy();
    expect(getScanStatus).toHaveBeenCalledWith({ slug: skill.name, version: '1.0.1', catalogScope: undefined });
  });

  it.each(['skill', 'version', 'close', 'approved', 'permission'])('discards a late review response after %s changes', async (change) => {
    let resolve!: (value: typeof feedback) => void;
    getScanStatus.mockReturnValue(new Promise<typeof feedback>((done) => { resolve = done; }));
    const onClose = vi.fn();
    const { rerender } = render(<SkillhubMarketPreviewPanel skill={skill} open onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'skillhub.publishedStatus.rejected' }));
    const nextSkill = change === 'skill' ? { ...skill, name: 'another-skill' }
      : change === 'version' ? { ...skill, pendingVersion: { version: '1.0.2', status: 'rejected' } }
        : change === 'approved' ? { ...skill, latestVersion: '1.0.1', pendingVersion: undefined }
          : change === 'permission' ? { ...skill, canManage: false }
            : skill;
    rerender(<SkillhubMarketPreviewPanel skill={nextSkill} open={change !== 'close'} onClose={onClose} />);
    await act(async () => { resolve(feedback); });
    expect(screen.queryByText(feedback.rejectionReason)).toBeNull();
    expect(screen.queryByRole('heading', { name: 'skillhub.scanResult.rejectedTitle' })).toBeNull();
  });

  it.each(['response', 'exception'])('shows unavailable feedback when the scan request fails with a %s', async (failure) => {
    if (failure === 'response') getScanStatus.mockResolvedValue({ success: false });
    else getScanStatus.mockRejectedValue(new Error('Request failed'));
    render(<SkillhubMarketPreviewPanel skill={skill} open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'skillhub.publishedStatus.rejected' }));
    expect(await screen.findByRole('dialog', { name: 'skillhub.scanResult.failedTitle' })).toBeTruthy();
    expect(screen.getByText('skillhub.scanResult.statusLabel.unavailable')).toBeTruthy();
    expect(screen.queryByText(feedback.rejectionReason)).toBeNull();
  });

  it.each(['response', 'exception'])('drops a previous account %s before the panel rerenders', async (outcome) => {
    let resolve!: (value: typeof feedback) => void;
    let reject!: (error: Error) => void;
    getScanStatus.mockReturnValue(new Promise<typeof feedback>((done, fail) => { resolve = done; reject = fail; }));
    render(<SkillhubMarketPreviewPanel skill={skill} open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'skillhub.publishedStatus.rejected' }));
    setDataOwnerGeneration('owner-b', 2);
    setDataOwnerGeneration('owner-a', 3);
    await act(async () => {
      if (outcome === 'response') resolve(feedback);
      else reject(new Error('Old account request failed'));
    });
    expect(screen.queryByText(feedback.rejectionReason)).toBeNull();
    expect(screen.queryByRole('heading', { name: 'skillhub.scanResult.rejectedTitle' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'skillhub.scanResult.failedTitle' })).toBeNull();
  });

  it.each(['owner-b', 'owner-a'])('closes visible feedback when the owner generation changes to %s', async (nextOwner) => {
    getScanStatus.mockResolvedValue(feedback);
    const onClose = vi.fn();
    const { rerender } = render(<SkillhubMarketPreviewPanel skill={skill} open onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'skillhub.publishedStatus.rejected' }));
    expect(await screen.findByText(feedback.rejectionReason)).toBeTruthy();
    setDataOwnerGeneration(nextOwner, 2);
    rerender(<SkillhubMarketPreviewPanel skill={skill} open onClose={onClose} />);
    expect(screen.queryByText(feedback.rejectionReason)).toBeNull();
  });

  it.each(['team', 'market'] as const)('reads a managed rejected version from the native record for %s', async (catalogScope) => {
    // Match the server boundary: scoped catalog reads cannot expose unapproved versions.
    getScanStatus.mockImplementation(async (request) => request.catalogScope
      ? { success: false } : feedback);
    render(<SkillhubMarketPreviewPanel skill={{ ...skill, catalogScope }} open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'skillhub.publishedStatus.rejected' }));
    expect(await screen.findByText(feedback.rejectionReason)).toBeTruthy();
    expect(getScanStatus).toHaveBeenCalledWith({ slug: skill.name, version: '1.0.1', catalogScope: undefined });
  });

  it.each(['pending', 'rejected'] as const)('preserves the team scope for an ordinary %s catalog read', async (status) => {
    getScanStatus.mockResolvedValue({ success: true, status, gates: [] });
    const record = { ...skill, canManage: status !== 'rejected', catalogScope: 'team' as const, pendingVersion: { version: '1.0.1', status } };
    render(<SkillhubMarketPreviewPanel skill={record} open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: status === 'pending' ? 'skillhub.publishedStatus.waitingReview' : 'skillhub.publishedStatus.rejected' }));
    await act(async () => {});
    expect(getScanStatus).toHaveBeenCalledWith({ slug: skill.name, version: '1.0.1', catalogScope: 'team' });
  });

  it.each([
    ['team', 'failed'], ['team', 'blocked'], ['market', 'failed'], ['market', 'blocked'],
  ] as const)('reads managed %s/%s failure details natively without presenting a manual rejection', async (catalogScope, status) => {
    getScanStatus.mockImplementation(async (request) => request.catalogScope ? { success: false } : {
      success: true, status, gates: [{ name: 'internal-error', status: 'failed',
        issues: [{ severity: 'error', message: 'Unable to process archive' }] }],
    });
    render(<SkillhubMarketPreviewPanel skill={{ ...skill, catalogScope, pendingVersion: { version: '1.0.1', status } }} open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'skillhub.publishedStatus.rejected' }));
    expect(await screen.findByRole('heading', { name: 'skillhub.scanResult.processingFailedTitle' })).toBeTruthy();
    expect(screen.getByText('Unable to process archive')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'skillhub.scanResult.rejectedTitle' })).toBeNull();
    expect(getScanStatus).toHaveBeenCalledWith({ slug: skill.name, version: '1.0.1', catalogScope: undefined });
  });
});
