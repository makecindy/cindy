// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn() },
}));

import { ScanResultDialog } from '../ScanResultDialog';

afterEach(cleanup);

describe('ScanResultDialog pending review presentation', () => {
  it('presents passed machine checks as success instead of failure', () => {
    render(
      <ScanResultDialog
        open
        onClose={vi.fn()}
        result={{
          status: 'pending',
          gates: [
            { name: 'archive-safety', status: 'passed' },
            { name: 'manifest', status: 'passed' },
          ],
        }}
      />,
    );

    expect(document.querySelector('.lucide-shield-check')).not.toBeNull();
    expect(document.querySelector('.lucide-clock-3')).toBeNull();
    expect(document.querySelector('.lucide-triangle-alert')).toBeNull();
    expect(document.body.textContent).not.toContain('archive-safety');
    expect(document.body.textContent).not.toContain('manifest');
  });
});
