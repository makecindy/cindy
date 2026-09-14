import { describe, expect, it } from 'vitest';

import {
  isPassingScanStatus,
  isPendingManualReviewStatus,
  isScanStatusUnavailable,
  isTerminalScanStatus,
  normalizeScanStatus,
} from '../scanStatus';

describe('scan status helpers', () => {
  it('treats Hub scan status "pass" as a passing terminal state', () => {
    expect(isTerminalScanStatus('pass')).toBe(true);
    expect(isPassingScanStatus('pass')).toBe(true);
  });

  it('keeps legacy published/quarantine/rejected statuses terminal', () => {
    expect(isTerminalScanStatus('published')).toBe(true);
    expect(isPassingScanStatus('published')).toBe(true);

    expect(isTerminalScanStatus('quarantine')).toBe(true);
    expect(isPassingScanStatus('quarantine')).toBe(false);

    expect(isTerminalScanStatus('rejected')).toBe(true);
    expect(isPassingScanStatus('rejected')).toBe(false);

    expect(isTerminalScanStatus('blocked')).toBe(true);
    expect(isPassingScanStatus('blocked')).toBe(false);
  });

  it('treats the server approved release status as a passing terminal state', () => {
    expect(isTerminalScanStatus('approved')).toBe(true);
    expect(isPassingScanStatus('approved')).toBe(true);
  });

  it('distinguishes pending manual review from an active machine scan', () => {
    expect(isPendingManualReviewStatus(' Pending ')).toBe(true);
    expect(isPendingManualReviewStatus('scanning')).toBe(false);
    expect(isTerminalScanStatus('pending')).toBe(false);
  });

  it('normalizes whitespace and case from API responses', () => {
    expect(normalizeScanStatus(' Pass ')).toBe('pass');
    expect(isTerminalScanStatus(' Pass ')).toBe(true);
    expect(isPassingScanStatus(' Pass ')).toBe(true);
  });

  it('keeps in-progress and unknown states non-terminal', () => {
    expect(isTerminalScanStatus('scanning')).toBe(false);
    expect(isTerminalScanStatus('unknown')).toBe(false);
  });

  it('stops waiting after repeated scan status lookup failures', () => {
    expect(isScanStatusUnavailable(2, 3)).toBe(false);
    expect(isScanStatusUnavailable(3, 3)).toBe(true);
  });
});
