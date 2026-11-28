// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskExportDirectoryState } from '../../../../shared/taskExportDirectory';

const { t, owner } = vi.hoisted(() => ({ t: (key: string) => key, owner: { generation: 1 } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/contexts/AuthContext', () => ({ useOptionalDataOwnerGeneration: () => owner.generation }));

import { TaskExportDirectorySection } from '../TaskExportDirectorySection';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); owner.generation = 1; });

// Unit, #12461 review (P1): the export folder is per account. Production entry is the
// real settings row with a stubbed preload API. The sibling directory rows have no
// owner-switch coverage. Minimum input: one account's path is shown (or its read is
// still in flight) when the data owner generation changes while the view stays open.
// A separate file because it needs jsdom; the export logic tests run in node.
describe('TaskExportDirectorySection', () => {
  it('drops the previous account\'s path on an owner switch, including a late response', async () => {
    const first: { resolve?: (value: TaskExportDirectoryState) => void } = {};
    const api = {
      get: vi.fn(() => new Promise<TaskExportDirectoryState>((resolve) => { first.resolve = resolve; })),
      choose: vi.fn(),
      reset: vi.fn(),
    };
    vi.stubGlobal('electronAPI', { taskExportDirectory: api });
    const view = render(<TaskExportDirectorySection />);

    // Account B signs in before account A's read returns.
    owner.generation = 2;
    api.get.mockResolvedValueOnce({ path: null, exists: false, unreadable: false });
    view.rerender(<TaskExportDirectorySection />);
    await screen.findByText('settings.about.storage.taskExportDirectoryUnset');
    await act(async () => { first.resolve?.({ path: 'C:\\account-a\\exports', exists: true, unreadable: false }); });
    expect(screen.queryByText('C:\\account-a\\exports')).toBeNull();

    // A path shown for B disappears as soon as another owner takes over.
    api.get.mockResolvedValueOnce({ path: 'C:\\account-b\\exports', exists: true, unreadable: false });
    owner.generation = 3;
    view.rerender(<TaskExportDirectorySection />);
    await screen.findByText('C:\\account-b\\exports');
    api.get.mockReturnValueOnce(new Promise<TaskExportDirectoryState>(() => {}));
    owner.generation = 4;
    view.rerender(<TaskExportDirectorySection />);
    expect(screen.queryByText('C:\\account-b\\exports')).toBeNull();
    expect(api.get).toHaveBeenCalledTimes(4);
  });
});
