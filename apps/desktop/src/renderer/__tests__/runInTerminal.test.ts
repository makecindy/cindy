/**
 * runInTerminal.test.ts
 * ---------------------------------------------------------------------------
 * Behavioral tests for runInTerminal.ts:
 *
 *   N1  normalizeCommand: single-line / multi-line / \r\n / \r / trailing
 *       newlines / heredoc — all normalized to \n line endings + exactly one
 *       trailing \n.
 *   N2  runInTerminal happy path: PTY already ready → write called with
 *       normalized command → returns true.
 *   N3  runInTerminal PTY becomes ready via subscribe notification → write
 *       called → returns true.
 *   N4  runInTerminal timeout (PTY never ready) → returns false, write not
 *       called, subscribe unsubscribed (no leak).
 *   N5  runInTerminal tab destroyed mid-wait → returns false immediately
 *       (does not wait for full timeout), write not called.
 *   N6  subscribe unsubscribe called on every exit path (ready / missing /
 *       timeout) — no listener leak.
 *   N7  command normalization flows through to terminal.write: \r stripped,
 *       trailing newlines collapsed.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';

// runInTerminal.ts uses window.setTimeout / window.clearTimeout / window.electronAPI.
// In node env (no jsdom — undici dep incomplete), point window at globalThis so
// those resolve to node globals (which vitest fake timers also instrument).
beforeAll(() => {
  (globalThis as { window: typeof globalThis }).window = globalThis;
});
afterAll(() => {
  delete (globalThis as { window?: unknown }).window;
});

// Mocks must be declared before the import of the module under test. vi.mock
// is hoisted to the top of the file by the transformer.
vi.mock('@/features/right-sidebar/store', () => ({
  ensureHydrated: vi.fn(),
  addOrFocusSingletonTab: vi.fn(),
  getBucket: vi.fn(),
  subscribe: vi.fn(),
}));
vi.mock('@/features/right-sidebar/lib/sidebarCommands', () => ({
  requestRightSidebarVisibility: vi.fn(),
}));

import {
  ensureHydrated,
  addOrFocusSingletonTab,
  getBucket,
  subscribe,
} from '@/features/right-sidebar/store';
import { requestRightSidebarVisibility } from '@/features/right-sidebar/lib/sidebarCommands';
import { runInTerminal, normalizeCommand } from '../components/chat/runInTerminal';

const SESSION_ID = 'session-1';
const TAB_ID = 'tab-1';

function mockTabState(created: boolean) {
  return { id: TAB_ID, kind: 'terminal' as const, state: { created } };
}

function mockBucket(created: boolean | null) {
  // created === null → tab missing from bucket
  return {
    hydrated: true,
    tabs: created === null ? [] : [mockTabState(created)],
    activeTabId: created === null ? null : TAB_ID,
  };
}

describe('N1 — normalizeCommand', () => {
  it('appends \\n to a single-line command without one', () => {
    expect(normalizeCommand('ls -la')).toBe('ls -la\n');
  });

  it('preserves a single trailing \\n', () => {
    expect(normalizeCommand('ls -la\n')).toBe('ls -la\n');
  });

  it('collapses multiple trailing newlines into one', () => {
    expect(normalizeCommand('ls\n\n\n')).toBe('ls\n');
  });

  it('normalizes \\r\\n to \\n', () => {
    expect(normalizeCommand('cd /tmp\r\nls\r\n')).toBe('cd /tmp\nls\n');
  });

  it('normalizes lone \\r to \\n', () => {
    expect(normalizeCommand('echo hello\recho world\r')).toBe('echo hello\necho world\n');
  });

  it('preserves multi-line content (heredoc / for loop)', () => {
    const heredoc = 'cat <<EOF\nhello\nworld\nEOF';
    expect(normalizeCommand(heredoc)).toBe('cat <<EOF\nhello\nworld\nEOF\n');
  });

  it('preserves internal blank lines, only trims trailing', () => {
    expect(normalizeCommand('echo a\n\necho b\n\n')).toBe('echo a\n\necho b\n');
  });

  it('handles empty string', () => {
    expect(normalizeCommand('')).toBe('\n');
  });
});

describe('N2 — runInTerminal happy path (PTY already ready)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ensureHydrated).mockResolvedValue(undefined);
    vi.mocked(addOrFocusSingletonTab).mockResolvedValue(mockTabState(true));
    vi.mocked(getBucket).mockReturnValue(mockBucket(true) as never);
    vi.mocked(subscribe).mockReturnValue(vi.fn());
    vi.mocked(requestRightSidebarVisibility).mockReturnValue(undefined);
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      terminal: { write: vi.fn().mockResolvedValue(undefined) },
    };
  });

  it('calls ensureHydrated, requestRightSidebarVisibility, addOrFocusSingletonTab', async () => {
    await runInTerminal(SESSION_ID, 'ls');
    expect(ensureHydrated).toHaveBeenCalledWith(SESSION_ID);
    expect(requestRightSidebarVisibility).toHaveBeenCalledWith('open', { sessionId: SESSION_ID });
    expect(addOrFocusSingletonTab).toHaveBeenCalledWith(SESSION_ID, 'terminal');
  });

  it('writes normalized command to terminal and returns true', async () => {
    const result = await runInTerminal(SESSION_ID, 'ls -la');
    expect(result).toBe(true);
    expect(window.electronAPI.terminal.write).toHaveBeenCalledWith(TAB_ID, 'ls -la\n');
  });

  it('does not call subscribe (PTY already ready — early return)', async () => {
    await runInTerminal(SESSION_ID, 'ls');
    expect(subscribe).not.toHaveBeenCalled();
  });
});

describe('N3 — runInTerminal PTY becomes ready via subscribe', () => {
  let listener: (() => void) | null = null;
  const mockUnsubscribe = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    listener = null;
    vi.mocked(ensureHydrated).mockResolvedValue(undefined);
    vi.mocked(addOrFocusSingletonTab).mockResolvedValue(mockTabState(false));
    // Initial state: pending
    vi.mocked(getBucket).mockReturnValue(mockBucket(false) as never);
    vi.mocked(subscribe).mockImplementation(((l: () => void) => {
      listener = l;
      return mockUnsubscribe;
    }) as never);
    vi.mocked(requestRightSidebarVisibility).mockReturnValue(undefined);
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      terminal: { write: vi.fn().mockResolvedValue(undefined) },
    };
  });

  it('returns true when PTY becomes ready via subscribe notification', async () => {
    const promise = runInTerminal(SESSION_ID, 'ls');
    // Wait for runInTerminal to reach waitForTerminalReady → subscribe
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalled());
    // Simulate PTY spawn completing
    vi.mocked(getBucket).mockReturnValue(mockBucket(true) as never);
    listener!();
    const result = await promise;
    expect(result).toBe(true);
    expect(window.electronAPI.terminal.write).toHaveBeenCalledWith(TAB_ID, 'ls\n');
  });

  it('unsubscribes after PTY becomes ready (no listener leak)', async () => {
    const promise = runInTerminal(SESSION_ID, 'ls');
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalled());
    vi.mocked(getBucket).mockReturnValue(mockBucket(true) as never);
    listener!();
    await promise;
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe('N4 — runInTerminal timeout (PTY never ready)', () => {
  const mockUnsubscribe = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ensureHydrated).mockResolvedValue(undefined);
    vi.mocked(addOrFocusSingletonTab).mockResolvedValue(mockTabState(false));
    vi.mocked(getBucket).mockReturnValue(mockBucket(false) as never);
    vi.mocked(subscribe).mockImplementation((() => mockUnsubscribe) as never);
    vi.mocked(requestRightSidebarVisibility).mockReturnValue(undefined);
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      terminal: { write: vi.fn().mockResolvedValue(undefined) },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns false after timeout', async () => {
    vi.useFakeTimers();
    const promise = runInTerminal(SESSION_ID, 'ls');
    // Flush microtasks (ensureHydrated + addOrFocusSingletonTab resolves)
    await vi.advanceTimersByTimeAsync(0);
    // Advance past PTY_READY_TIMEOUT_MS (5000ms)
    await vi.advanceTimersByTimeAsync(5001);
    const result = await promise;
    expect(result).toBe(false);
  });

  it('does not call terminal.write on timeout', async () => {
    vi.useFakeTimers();
    const promise = runInTerminal(SESSION_ID, 'ls');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5001);
    await promise;
    expect(window.electronAPI.terminal.write).not.toHaveBeenCalled();
  });

  it('unsubscribes after timeout (no listener leak)', async () => {
    vi.useFakeTimers();
    const promise = runInTerminal(SESSION_ID, 'ls');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5001);
    await promise;
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe('N5 — runInTerminal tab destroyed mid-wait', () => {
  let listener: (() => void) | null = null;
  const mockUnsubscribe = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    listener = null;
    vi.mocked(ensureHydrated).mockResolvedValue(undefined);
    vi.mocked(addOrFocusSingletonTab).mockResolvedValue(mockTabState(false));
    vi.mocked(getBucket).mockReturnValue(mockBucket(false) as never);
    vi.mocked(subscribe).mockImplementation(((l: () => void) => {
      listener = l;
      return mockUnsubscribe;
    }) as never);
    vi.mocked(requestRightSidebarVisibility).mockReturnValue(undefined);
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      terminal: { write: vi.fn().mockResolvedValue(undefined) },
    };
  });

  it('returns false when tab is destroyed (not waiting for timeout)', async () => {
    vi.useFakeTimers();
    const promise = runInTerminal(SESSION_ID, 'ls');
    await vi.advanceTimersByTimeAsync(0);
    // Tab destroyed: getBucket returns empty
    vi.mocked(getBucket).mockReturnValue(mockBucket(null) as never);
    listener!();
    const result = await promise;
    expect(result).toBe(false);
    vi.useRealTimers();
  });

  it('does not call terminal.write when tab destroyed', async () => {
    vi.useFakeTimers();
    const promise = runInTerminal(SESSION_ID, 'ls');
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(getBucket).mockReturnValue(mockBucket(null) as never);
    listener!();
    await promise;
    expect(window.electronAPI.terminal.write).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('unsubscribes when tab destroyed (no listener leak)', async () => {
    vi.useFakeTimers();
    const promise = runInTerminal(SESSION_ID, 'ls');
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(getBucket).mockReturnValue(mockBucket(null) as never);
    listener!();
    await promise;
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe('N7 — command normalization flows through to terminal.write', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ensureHydrated).mockResolvedValue(undefined);
    vi.mocked(addOrFocusSingletonTab).mockResolvedValue(mockTabState(true));
    vi.mocked(getBucket).mockReturnValue(mockBucket(true) as never);
    vi.mocked(subscribe).mockReturnValue(vi.fn());
    vi.mocked(requestRightSidebarVisibility).mockReturnValue(undefined);
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      terminal: { write: vi.fn().mockResolvedValue(undefined) },
    };
  });

  it('strips \\r and collapses trailing newlines before writing', async () => {
    await runInTerminal(SESSION_ID, 'cd /tmp\r\nls\r\n\n');
    expect(window.electronAPI.terminal.write).toHaveBeenCalledWith(TAB_ID, 'cd /tmp\nls\n');
  });

  it('preserves multi-line heredoc content', async () => {
    const cmd = 'cat <<EOF\nhello\nEOF';
    await runInTerminal(SESSION_ID, cmd);
    expect(window.electronAPI.terminal.write).toHaveBeenCalledWith(
      TAB_ID,
      'cat <<EOF\nhello\nEOF\n',
    );
  });
});
