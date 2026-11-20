/**
 * Bug: a remote device-link failure surfaced as two identical toasts reading
 * "Error invoking remote method 'device-link:invoke': Error: [DEVICE_LINK_DEVICE_UNRESPONSIVE]
 * target device <64 hex> is unresponsive (circuit open)". Callers pass err.message straight
 * to toast.error, so the rewrite and de-duplication live at the toast entry. Unit tier.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/i18n', () => ({ i18n: { exists: () => false, t: (key: string) => key } }));

import { formatIpcErrorToastText } from '../ipcErrorToastText';
import { getToastSnapshot, setToastAlertTextFormatter, toast } from '../toast';

const RAW =
  "Error invoking remote method 'device-link:invoke': Error: [DEVICE_LINK_DEVICE_UNRESPONSIVE] " +
  `target device ${'a'.repeat(64)} is unresponsive (circuit open)`;
const translate = (key: string) =>
  key === 'ipcError.DEVICE_LINK_DEVICE_UNRESPONSIVE' ? 'Device not responding' : null;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  setToastAlertTextFormatter(null);
  toast.dismissAll();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe('alert toasts for raw IPC errors', () => {
  it('shows one translated toast for repeated raw device-link failures', () => {
    setToastAlertTextFormatter((message) => formatIpcErrorToastText(message, translate));
    const first = toast.error(RAW);
    const second = toast.error(RAW);
    expect(second).toBe(first);
    expect(getToastSnapshot().map((item) => item.message)).toEqual(['Device not responding']);
    // A toast with its own action is never merged into another one.
    toast.error(RAW, { action: { label: 'Retry', onClick: () => {} } });
    expect(getToastSnapshot()).toHaveLength(2);
  });

  it('keeps context and only strips the Electron wrapper for other codes', () => {
    expect(
      formatIpcErrorToastText(
        "Save failed: Error invoking remote method 'x:y': Error: [NOT_FOUND] file missing",
        translate,
      ),
    ).toBe('Save failed: [NOT_FOUND] file missing');
    expect(formatIpcErrorToastText('Plain message', translate)).toBe('Plain message');
  });
});

// Shared decoder contract: unknown codes must keep their original diagnostic text.
// Existing tests only exercised registered codes; the minimal failure is a wrapped
// unknown DEVICE_LINK_* code with a matching translation. Unit tier, no extra I/O.
it('preserves unknown codes even when a translation happens to exist', () => {
  const raw = "Context: Error invoking remote method 'x:y': Error: [DEVICE_LINK_FUTURE_ERROR] details";
  const translator = vi.fn(() => 'should not replace diagnostics');
  expect(formatIpcErrorToastText(raw, translator)).toBe('Context: [DEVICE_LINK_FUTURE_ERROR] details');
  expect(translator).not.toHaveBeenCalled();
});
