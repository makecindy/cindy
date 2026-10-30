// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { SkillhubDiffPanel } from '../SkillhubDiffPanel';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translate }) }));
function translate(key: string, params?: { version?: string }) { return params?.version ? key + ':' + params.version : key; }
vi.mock('@/components/diff-panel/DiffPanelShell', () => ({
  DiffPanelShell: ({ title, children }: { title: string; children: React.ReactNode }) => <div><h1>{title}</h1>{children}</div>,
}));
vi.mock('@/components/diff-panel/FileChangeGroup', () => ({
  FileChangeGroup: ({ change, summaryOnly }: { change: { path: string; oldContent: string }; summaryOnly: boolean }) =>
    <li>{change.path}:{summaryOnly ? 'summary' : change.oldContent}</li>,
}));
const comparePublished = vi.fn();
const getSnapshotDiff = vi.fn();
beforeEach(() => {
  comparePublished.mockReset();
  getSnapshotDiff.mockReset();
  setDataOwnerGeneration('owner-a', 1);
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { skillhub: { comparePublished, getSnapshotDiff } } });
});
afterEach(cleanup);
const props = { open: true, onClose: vi.fn(), skillName: 'demo', skillId: 'skill:demo', absolutePath: '/skills/demo', published: true };

it('shows the exact remote version and file content, without falling back to a local snapshot', async () => {
  comparePublished.mockResolvedValue({ status: 'different', version: '2.1.0', pending: true, changes: [
    { path: 'SKILL.md', kind: 'modified', isBinary: false, oldContent: 'online content', newContent: 'local', oldSize: 14, newSize: 5 },
    { path: 'large.bin', kind: 'added', isBinary: true, oldContent: '', newContent: '', oldSize: 0, newSize: 20 },
  ] });
  render(<SkillhubDiffPanel {...props} />);
  await screen.findByText('skillhub.publishComparison.diffTitle:2.1.0');
  expect(screen.getByText('SKILL.md:online content')).toBeTruthy();
  expect(screen.getByText('large.bin:summary')).toBeTruthy();
  expect(comparePublished).toHaveBeenCalledWith({ absolutePath: '/skills/demo', skillId: 'skill:demo', includeDiff: true });
  expect(getSnapshotDiff).not.toHaveBeenCalled();
});

it('reports unavailable instead of a clean comparison when remote contents cannot be read', async () => {
  comparePublished.mockResolvedValue({ status: 'unavailable' });
  render(<SkillhubDiffPanel {...props} />);
  await screen.findByText('skillhub.publishComparison.unavailable');
  expect(screen.queryByText('skillhub.diffPanel.cleanTitle')).toBeNull();
  expect(getSnapshotDiff).not.toHaveBeenCalled();
});

it('discards private preview data returned after switching accounts', async () => {
  let resolve!: (value: unknown) => void;
  comparePublished.mockImplementation(() => new Promise((done) => { resolve = done; }));
  render(<SkillhubDiffPanel {...props} />);
  await waitFor(() => expect(comparePublished).toHaveBeenCalledTimes(1));
  setDataOwnerGeneration('owner-b', 2);
  await act(async () => resolve({ status: 'different', version: 'private-version', changes: [] }));
  expect(screen.queryByText('skillhub.publishComparison.diffTitle:private-version')).toBeNull();
});
