// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn() },
}));

import { ScanResultDialog } from '../ScanResultDialog';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ScanResultDialog pending review presentation', () => {
  it('shows manual feedback even when every machine check passed, and copies the full reason', async () => {
    const reason = 'Remove private project notes.\n<script>do not execute</script>';
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    render(<ScanResultDialog open onClose={vi.fn()} result={{
      status: 'rejected', rejectionReason: reason,
      gates: [{ name: 'security-scan', status: 'passed' }],
    }} />);
    expect(screen.getByRole('heading', { name: 'skillhub.scanResult.rejectedTitle' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'skillhub.scanResult.rejectionReason' })).toBeTruthy();
    expect(document.body.textContent).toContain(reason);
    expect(document.querySelector('script')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'skillhub.scanResult.copyReviewResult' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining(reason)));
    expect(document.body.textContent).not.toContain('skillhub.scanResult.failedDesc');
  });

  it('shows manual feedback together with failed machine-check details', () => {
    render(<ScanResultDialog open onClose={vi.fn()} result={{
      status: 'rejected', rejectionReason: 'Remove the private archive',
      gates: [{ name: 'archive-safety', status: 'failed', issues: [{ severity: 'error', message: 'Unsafe archive path' }] }],
    }} />);
    expect(document.body.textContent).toContain('Remove the private archive');
    expect(document.body.textContent).toContain('Unsafe archive path');
  });

  it.each([undefined, '', '  '])('keeps legacy rejection results usable when the reason is %s', (rejectionReason) => {
    render(<ScanResultDialog open onClose={vi.fn()} result={{ status: 'rejected', rejectionReason, gates: [] }} />);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'skillhub.scanResult.rejectionReason' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'skillhub.scanResult.rejectedTitle' })).toBeTruthy();
    expect(document.body.textContent).toContain('skillhub.scanResult.rejectionReasonUnavailable');
    expect(document.body.textContent).not.toContain('skillhub.scanResult.failedDesc');
    expect(screen.getByRole('button', { name: 'skillhub.scanResult.dismiss' })).toBeTruthy();
  });

  it('identifies missing manual feedback even when failed scan findings are available', () => {
    render(<ScanResultDialog open onClose={vi.fn()} result={{
      status: 'rejected', gates: [{ name: 'archive-safety', status: 'failed',
        issues: [{ severity: 'error', message: 'Unsafe archive path' }] }],
    }} />);
    expect(screen.getByText('skillhub.scanResult.rejectionReasonUnavailable')).toBeTruthy();
    expect(screen.getByText('Unsafe archive path')).toBeTruthy();
    expect(screen.queryByText('skillhub.scanResult.rejectedDesc')).toBeNull();
  });

  it.each(['approved', 'pending', 'failed', 'blocked'])('does not display stale rejection feedback for %s', (status) => {
    render(<ScanResultDialog open onClose={vi.fn()} result={{
      status, rejectionReason: 'Stale private notes', gates: [],
    }} />);
    expect(document.body.textContent).not.toContain('Stale private notes');
  });

  it('presents a lookup failure as unavailable without inventing a rejection or missing reason', () => {
    render(<ScanResultDialog open onClose={vi.fn()} result={{
      status: 'scan_status_unavailable', gates: [{ name: 'scan-status', status: 'unavailable' }],
    }} />);
    expect(screen.queryByRole('heading', { name: 'skillhub.scanResult.rejectedTitle' })).toBeNull();
    expect(screen.queryByText('skillhub.scanResult.rejectionReasonUnavailable')).toBeNull();
    expect(document.body.textContent).toContain('skillhub.scanResult.statusLabel.unavailable');
  });

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
