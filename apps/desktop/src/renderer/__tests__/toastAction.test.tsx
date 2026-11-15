// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Toast } from '../components/ui/toast/Toast';
import { QuotaResetConfetti } from '../components/status/QuotaResetConfetti';
import { getToastSnapshot, toast } from '../lib/toast';
import { showGithubStarPrompt } from '../lib/githubStarPrompt';

vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }));

const confettiMock = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('canvas-confetti', () => ({ default: { create: confettiMock.create } }));

afterEach(() => {
  cleanup();
  toast.dismissAll();
  if (vi.isFakeTimers()) vi.runOnlyPendingTimers();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('Toast action', () => {
  it.each(['pointer', 'keyboard'])('captures the %s activation point before updating the toast', mode => {
    const onClick = vi.fn();
    render(<Toast item={{ id: 'point', variant: 'info', message: 'Star', duration: 0, createdAt: 0, exiting: false,
      action: { label: 'Star', onClick, keepOpen: true } }} />);
    const button = screen.getByRole('button', { name: 'Star' });
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({ left: 100, top: 60, width: 120, height: 40 } as DOMRect);
    fireEvent.click(button, mode === 'pointer' ? { detail: 1, clientX: 115, clientY: 75 } : { detail: 0 });
    expect(onClick).toHaveBeenCalledWith(mode === 'pointer' ? { x: 115, y: 75 } : { x: 160, y: 80 });
  });
  it.each(['mouse-first', 'focus-first'])('waits for both pause reasons to clear (%s)', (order) => {
    vi.useFakeTimers();
    const id = toast.error('Connection lost', { action: { label: 'Recover', onClick: vi.fn() } });
    const item = getToastSnapshot().find(candidate => candidate.id === id)!;
    render(<Toast item={item} />);
    const panel = screen.getByRole('alert');
    const action = screen.getByRole('button', { name: 'Recover' });
    if (order === 'mouse-first') { fireEvent.mouseEnter(panel); fireEvent.focus(action); }
    else { fireEvent.focus(action); fireEvent.mouseEnter(panel); }
    vi.advanceTimersByTime(9000);
    expect(getToastSnapshot().find(candidate => candidate.id === id)?.exiting).toBe(false);
    if (order === 'mouse-first') fireEvent.mouseLeave(panel);
    else fireEvent.blur(action, { relatedTarget: document.body });
    vi.advanceTimersByTime(9000);
    expect(getToastSnapshot().find(candidate => candidate.id === id)?.exiting).toBe(false);
    if (order === 'mouse-first') fireEvent.blur(action, { relatedTarget: document.body });
    else fireEvent.mouseLeave(panel);
    vi.advanceTimersByTime(8000);
    expect(getToastSnapshot().find(candidate => candidate.id === id)?.exiting).toBe(true);
  });
  // Persistent invitation extends the existing action contract: async click stays open,
  // both explicit close controls dismiss, and completion can replace the same notification.
  it.each(['button', 'icon'])('keeps async actions open and dismisses with the %s', (kind) => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const id = toast.info('Support the project', {
      title: 'Enjoying Cindy?', icon: 'star', duration: 0, dismissLabel: 'Dismiss', onClose,
      action: { label: 'Star', keepOpen: true, onClick: vi.fn() },
    });
    render(<Toast item={getToastSnapshot().find(item => item.id === id)!} />);
    fireEvent.click(screen.getByRole('button', { name: 'Star' }));
    expect(getToastSnapshot().find(item => item.id === id)?.exiting).toBe(false);
    fireEvent.click(screen.getAllByRole('button', { name: 'Dismiss' })[kind === 'icon' ? 0 : 1]);
    vi.advanceTimersByTime(300);
    expect(onClose).toHaveBeenCalledOnce();
  });
  it('updates the same notification and starts its completion timeout', () => {
    vi.useFakeTimers();
    const id = toast.info('Invitation', { duration: 0 });
    toast.update(id, 'Thanks', { variant: 'success', duration: 5000 });
    vi.advanceTimersByTime(4999);
    expect(getToastSnapshot().find(item => item.id === id)?.exiting).toBe(false);
    vi.advanceTimersByTime(1);
    expect(getToastSnapshot().find(item => item.id === id)?.exiting).toBe(true);
  });
  it('renders one action, runs it, and dismisses the toast', () => {
    const onClick = vi.fn();
    const id = toast.error('Model not switched', {
      action: { label: 'Open Settings', onClick },
    });
    const item = getToastSnapshot().find((candidate) => candidate.id === id);
    expect(item?.action?.label).toBe('Open Settings');

    render(<Toast item={item!} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }));

    expect(onClick).toHaveBeenCalledOnce();
    expect(getToastSnapshot().find((candidate) => candidate.id === id)?.exiting).toBe(true);
  });
});

// Verify the real Toast lifecycle with the canvas engine boundary mocked.
describe('Toast celebration', () => {
  let finish: () => void;
  let fire: ReturnType<typeof vi.fn> & { reset: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    confettiMock.create.mockReset();
    fire = Object.assign(vi.fn(() => new Promise<void>(resolve => { finish = resolve; })), { reset: vi.fn() });
    confettiMock.create.mockReturnValue(fire);
  });
  afterEach(() => { vi.unstubAllGlobals(); });
  // Unit regression: the real Star success must expire even when hovered. Existing
  // timer-only coverage never delivered hover events to the success component.
  it('dismisses the Star acknowledgement after five seconds despite hovering', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    const close = showGithubStarPrompt(() => {}, () => true, {
      star: async () => true, open: async () => ({ success: true }),
    });
    const invitation = getToastSnapshot().find(item => item.icon === 'star')!;
    const view = render(<Toast item={invitation} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'githubStar.action' })); });
    view.rerender(<Toast item={getToastSnapshot().find(item => item.id === invitation.id)!} />);
    const panel = screen.getByRole('status');
    fireEvent.mouseEnter(panel);
    vi.advanceTimersByTime(2500);
    fireEvent.mouseLeave(panel);
    fireEvent.mouseEnter(panel);
    vi.advanceTimersByTime(2499);
    expect(getToastSnapshot().find(item => item.id === invitation.id)?.exiting).toBe(false);
    vi.advanceTimersByTime(1);
    expect(getToastSnapshot().find(item => item.id === invitation.id)?.exiting).toBe(true);
    vi.advanceTimersByTime(300);
    expect(getToastSnapshot().some(item => item.id === invitation.id)).toBe(false);
    close();
  });
  it.each([false, true])('celebrates an explicit success once, respecting reduced motion (%s)', async reduced => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: reduced })));
    const item = { id: 'burst', variant: 'success' as const, message: 'Thanks', duration: 0, createdAt: 0, exiting: false };
    const view = render(<Toast item={item} />);
    expect(document.querySelector('[data-confetti-burst]')).toBeNull();
    view.rerender(<Toast item={{ ...item, celebrate: true }} />);
    if (reduced) {
      await act(async () => {});
      expect(confettiMock.create).not.toHaveBeenCalled();
      expect(document.querySelector('[data-confetti-burst]')).toBeNull();
      return;
    }
    await waitFor(() => expect(fire).toHaveBeenCalledOnce());
    expect(confettiMock.create).toHaveBeenCalledWith(expect.any(HTMLCanvasElement), { resize: true, useWorker: false });
    expect(fire).toHaveBeenCalledWith(expect.objectContaining({ particleCount: 160, spread: 360, disableForReducedMotion: true }));
    await act(async () => { finish(); });
    expect(document.querySelector('[data-confetti-burst]')).toBeNull();
    view.rerender(<Toast item={{ ...item, message: 'Still thanks', celebrate: true }} />);
    expect(fire).toHaveBeenCalledOnce();
  });
  it('cancels and removes an in-flight burst when the toast is dismissed', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
    const item = { id: 'burst', variant: 'success' as const, message: 'Thanks', duration: 0, createdAt: 0, exiting: false, celebrate: true };
    const view = render(<Toast item={item} />);
    await waitFor(() => expect(fire).toHaveBeenCalledOnce());
    view.rerender(<Toast item={{ ...item, exiting: true }} />);
    expect(document.querySelector('[data-confetti-burst]')).toBeNull();
    expect(fire.reset).toHaveBeenCalledOnce();
    await act(async () => { finish(); });
    expect(document.querySelector('[data-confetti-burst]')).toBeNull();
  });
  it('does not start a late-loading animation after unmount', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
    const view = render(<Toast item={{ id: 'late', variant: 'success', message: 'Thanks', duration: 0, createdAt: 0, exiting: false, celebrate: true }} />);
    view.unmount();
    await act(async () => {});
    expect(confettiMock.create).not.toHaveBeenCalled();
    expect(document.querySelector('[data-confetti-burst]')).toBeNull();
  });
  it.each([{ x: 210, y: 100, expected: { x: 0.25, y: 0.2 } }, { x: 1500, y: -100, expected: { x: 1, y: 0 } }])(
    'maps the saved click to the actual canvas and clamps after resize ($x, $y)', async ({ x, y, expected }) => {
      vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
      const rect = vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 20, width: 800, height: 400 } as DOMRect);
      try {
        render(<Toast item={{ id: 'origin', variant: 'success', message: 'Thanks', duration: 0, createdAt: 0,
          exiting: false, celebrate: true, celebrationOrigin: { x, y } }} />);
        await waitFor(() => expect(fire).toHaveBeenCalledOnce());
        expect(fire).toHaveBeenCalledWith(expect.objectContaining({ origin: expected }));
      } finally { rect.mockRestore(); }
    },
  );
  it.each([false, true])('shares the quota engine while keeping its small themed burst (%s)', async reduced => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: reduced })));
    const tokens = ['--card-status-done', '--card-status-awaiting', '--warning-accent', '--card-status-error'];
    const colors = ['#2aae5b', '#19d2c1', '#ea6b17', '#d91f37'];
    const previous = tokens.map(token => document.documentElement.style.getPropertyValue(token));
    tokens.forEach((token, index) => document.documentElement.style.setProperty(token, colors[index]!));
    const anchor = document.createElement('span');
    document.body.append(anchor);
    vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue({ left: 40, top: 200, width: 80, height: 20 } as DOMRect);
    const onDone = vi.fn();
    try {
      render(<QuotaResetConfetti anchor={anchor} onDone={onDone} />);
      if (reduced) {
        await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
        expect(fire).not.toHaveBeenCalled();
      } else {
        await waitFor(() => expect(fire).toHaveBeenCalledOnce());
        expect(fire).toHaveBeenCalledWith(expect.objectContaining({
          particleCount: 18, spread: 80, colors,
          origin: { x: 80 / window.innerWidth, y: 210 / window.innerHeight },
        }));
        await act(async () => { finish(); });
        expect(onDone).toHaveBeenCalledOnce();
      }
    } finally {
      anchor.remove();
      tokens.forEach((token, index) => previous[index]
        ? document.documentElement.style.setProperty(token, previous[index]!)
        : document.documentElement.style.removeProperty(token));
    }
  });
});
