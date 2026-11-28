/**
 * Tests for Windows global voice-input overlay parity:
 * - UIA text context normalization & strict password-field exclusion
 * - Win32 physical-pixel -> DIP focused window frame conversion for multi-monitor placement
 * - Focus verification & clipboard rollback/restore guards before/after Ctrl+V
 * - Resident helper restart-once recovery after unexpected process exit
 *
 * Tier: unit (< 100ms, injected transport & clipboard port, zero PowerShell spawn).
 */
import { describe, expect, it, vi } from 'vitest';
import type { Rectangle } from 'electron';

import {
  WindowsTextInsertionClient,
  executeWindowsGuardedPaste,
  normalizeWindowsFocusedFrame,
  normalizeWindowsPasteContext,
  type WindowsHelperTransport,
} from '../windowsTextInsertion.js';

function createFakeTransport(
  handler: (payload: unknown, timeoutMs: number) => Promise<Record<string, unknown>>,
  options?: { aliveAfterError?: boolean },
): WindowsHelperTransport & { sendMock: ReturnType<typeof vi.fn>; stopMock: ReturnType<typeof vi.fn> } {
  let alive = true;
  const sendMock = vi.fn(async (payload, timeoutMs) => {
    try {
      return await handler(payload, timeoutMs);
    } catch (error) {
      if (options?.aliveAfterError === false) alive = false;
      throw error;
    }
  });
  const stopMock = vi.fn(() => {
    alive = false;
  });
  return {
    get isAlive() {
      return alive;
    },
    start: vi.fn(async () => {
      alive = true;
    }),
    send: sendMock,
    stop: stopMock,
    sendMock,
    stopMock,
  };
}

describe('normalizeWindowsPasteContext', () => {
  it('redacts password controls completely even if text fields are present', () => {
    const context = normalizeWindowsPasteContext({
      isPassword: true,
      selectionBefore: 'hunter2',
      selectedText: 'secret',
      selectionAfter: '!',
      focusedRole: 'ControlType.Edit',
      contextSource: 'uia-value-pattern',
    });
    expect(context).toBeNull();
  });

  it('clamps selectionBefore (tail), selectedText (head), and selectionAfter (head)', () => {
    const before = `HEAD_${'a'.repeat(550)}_TAIL`;
    const selected = `SEL_${'b'.repeat(1100)}_END`;
    const after = `AFT_${'c'.repeat(550)}_END`;
    const context = normalizeWindowsPasteContext({
      selectionBefore: before,
      selectedText: selected,
      selectionAfter: after,
      focusedRole: 'ControlType.Edit',
      contextSource: 'uia-text-pattern',
    });
    expect(context).not.toBeNull();
    expect(context?.selectionBefore.length).toBe(500);
    expect(context?.selectionBefore.endsWith('_TAIL')).toBe(true);
    expect(context?.selectedText.length).toBe(1000);
    expect(context?.selectedText.startsWith('SEL_')).toBe(true);
    expect(context?.selectionAfter.length).toBe(500);
    expect(context?.selectionAfter.startsWith('AFT_')).toBe(true);
    expect(context?.contextSource).toBe('uia-text-pattern');
  });

  it('returns null when all text fields are empty', () => {
    expect(normalizeWindowsPasteContext({
      selectionBefore: '',
      selectedText: '',
      selectionAfter: '',
    })).toBeNull();
  });
});

describe('normalizeWindowsFocusedFrame', () => {
  it('converts Win32 physical pixels into DIP via provided converter', () => {
    const dip = normalizeWindowsFocusedFrame(
      { x: 2880, y: 120, width: 1920, height: 1080 },
      (rect: Rectangle) => ({
        x: Math.round(rect.x / 1.5),
        y: Math.round(rect.y / 1.5),
        width: Math.round(rect.width / 1.5),
        height: Math.round(rect.height / 1.5),
      }),
    );
    expect(dip).toEqual({ x: 1920, y: 80, width: 1280, height: 720 });
  });

  it('rejects degenerate zero-area frames', () => {
    expect(normalizeWindowsFocusedFrame({ x: 0, y: 0, width: 0, height: 500 })).toBeNull();
  });
});

describe('WindowsTextInsertionClient', () => {
  it('captures foreground target, UIA context, and DIP window frame', async () => {
    const transport = createFakeTransport(async () => ({
      id: 1,
      ok: true,
      target: { processName: 'Code', pid: 4321, hwnd: '1314520' },
      frame: { x: 1920, y: 0, width: 1200, height: 900 },
      context: {
        selectionBefore: 'const x = ',
        selectedText: 'oldVal',
        selectionAfter: ';',
        focusedRole: 'ControlType.Document',
        contextSource: 'uia-text-pattern',
      },
    }));
    const client = new WindowsTextInsertionClient(transport);
    const captured = await client.captureTarget({
      withFocusedFrame: true,
      physicalToDip: (rect) => ({ ...rect, x: rect.x / 2, width: rect.width / 2 }),
    });
    expect(captured).toEqual({
      target: { processName: 'Code', bundleId: 'Code', pid: 4321, hwnd: '1314520' },
      context: {
        selectionBefore: 'const x = ',
        selectedText: 'oldVal',
        selectionAfter: ';',
        focusedRole: 'ControlType.Document',
        contextSource: 'uia-text-pattern',
      },
      frame: { x: 960, y: 0, width: 600, height: 900 },
    });
  });

  it('retries capture when the helper exits, but never replays an ambiguous paste', async () => {
    let calls = 0;
    const transport = createFakeTransport(async () => {
      calls += 1;
      if (calls === 1) throw new Error('helper exited');
      return {
        id: 2,
        ok: true,
        outcome: 'command_issued',
        commandIssued: true,
        currentProcessName: 'notepad',
      };
    }, { aliveAfterError: false });

    const client = new WindowsTextInsertionClient(transport);
    await expect(client.pasteVerified({ processName: 'notepad', bundleId: 'notepad', pid: 100, hwnd: '999' }))
      .rejects.toThrow('helper exited');
    expect(calls).toBe(1);
    const result = await client.captureTarget();
    expect(calls).toBe(2);
    expect(result).toBeNull();
  });
});

describe('executeWindowsGuardedPaste', () => {
  it('restores clipboard synchronously and aborts when target focus changed', async () => {
    let clipboardText = 'user-original';
    const restoreSync = vi.fn((snapshot: { text: string }, expected: string) => {
      if (clipboardText === expected) clipboardText = snapshot.text;
    });
    const scheduleRestore = vi.fn();

    const result = await executeWindowsGuardedPaste({
      text: 'dictated text',
      target: { processName: 'Code', bundleId: 'Code', pid: 123, hwnd: '555' },
      client: {
        pasteVerified: vi.fn(async () => ({
          ok: false,
          outcome: 'target_changed' as const,
          reason: 'focus_not_on_target',
          commandIssued: false,
        })),
      },
      clipboard: {
        writeText: (value) => { clipboardText = value; },
        readText: () => clipboardText,
        clear: () => { clipboardText = ''; },
      },
      captureSnapshot: () => ({ text: 'user-original' }),
      restoreSnapshotSync: restoreSync,
      scheduleSnapshotRestore: scheduleRestore,
    });

    expect(result).toMatchObject({ ok: false, code: 'unavailable', detail: 'focus_not_on_target' });
    expect(restoreSync).toHaveBeenCalledTimes(1);
    expect(scheduleRestore).not.toHaveBeenCalled();
    expect(clipboardText).toBe('user-original');
  });

  it('aborts without issuing paste when clipboard read-back does not match written text', async () => {
    const pasteVerified = vi.fn();
    let cleared = false;
    const result = await executeWindowsGuardedPaste({
      text: 'dictated text',
      target: { processName: 'Code', bundleId: 'Code', pid: 123, hwnd: '555' },
      client: { pasteVerified },
      clipboard: {
        writeText: () => undefined,
        readText: () => 'interfered-by-other-app',
        clear: () => { cleared = true; },
      },
      captureSnapshot: () => null,
      restoreSnapshotSync: vi.fn(),
      scheduleSnapshotRestore: vi.fn(),
    });

    expect(result).toMatchObject({ ok: false, code: 'unavailable', detail: 'clipboard_readback_mismatch' });
    expect(pasteVerified).not.toHaveBeenCalled();
    // Must not clear clipboard because another app owns the current text.
    expect(cleared).toBe(false);
  });

  it('schedules delayed clipboard restore on verified paste success', async () => {
    let clipboardText = 'user-original';
    const scheduleRestore = vi.fn();
    const result = await executeWindowsGuardedPaste({
      text: 'dictated text',
      target: { processName: 'Code', bundleId: 'Code', pid: 123, hwnd: '555' },
      client: {
        pasteVerified: vi.fn(async () => ({
          ok: true,
          outcome: 'command_issued' as const,
          reason: 'send_input_ok',
          commandIssued: true,
          currentProcessName: 'Code',
        })),
      },
      clipboard: {
        writeText: (value) => { clipboardText = value; },
        readText: () => clipboardText,
        clear: () => { clipboardText = ''; },
      },
      captureSnapshot: () => ({ text: 'user-original' }),
      restoreSnapshotSync: vi.fn(),
      scheduleSnapshotRestore: scheduleRestore,
    });

    expect(result).toEqual({ ok: true, currentProcessName: 'Code' });
    expect(scheduleRestore).toHaveBeenCalledWith({ text: 'user-original' }, 'dictated text');
  });
});
