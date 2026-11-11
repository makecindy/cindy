import { describe, expect, it, vi } from 'vitest';
import { invokeOpenPath } from '../openPath';
import { shouldShowOpenPathError } from '../../shared/openPathResult';

describe('openPath IPC result boundary', () => {
  it.each([
    { success: true },
    { success: false, error: 'Path must be absolute' },
    { success: false, error: '不允许访问该路径' },
    { success: false, error: 'No application is associated with this file' },
    { success: false, error: 'reply was never sent' },
  ])('preserves main result %j', async (result) => {
    const invoke = vi.fn().mockResolvedValue(result);
    // The preload transports an opaque target; it does not resolve filesystem paths.
    expect(await invokeOpenPath(invoke, 'target')).toBe(result);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('shell:open-path', 'target');
    expect(shouldShowOpenPathError(result)).toBe(!result.success);
  });

  it.each([
    'reply was never sent',
    'Render frame was disposed before WebFrameMain could be accessed',
    "Error invoking remote method 'shell:open-path': reply was never sent",
    "Error invoking remote method 'shell:open-path': Error: Render frame was disposed before WebFrameMain could be accessed",
  ])('keeps lifecycle rejection as failure without a toast: %s', async (message) => {
    const result = await invokeOpenPath(vi.fn().mockRejectedValue(new Error(message)), 'target');
    expect(result).toEqual({ success: false, error: message, failureKind: 'ipc_lifecycle' });
    expect(shouldShowOpenPathError(result)).toBe(false);
  });

  it.each([
    new Error(
      "Error invoking remote method 'shell:open-path': No handler registered for 'shell:open-path'",
    ),
    new Error('Permission denied'),
    new Error('Operation failed: reply was never sent'),
    'non-Error rejection',
  ])('preserves actionable rejection %s', async (cause) => {
    const result = await invokeOpenPath(vi.fn().mockRejectedValue(cause), 'target');
    expect(result).toEqual({
      success: false,
      error: cause instanceof Error ? cause.message : cause,
    });
    expect(shouldShowOpenPathError(result)).toBe(true);
  });
});
