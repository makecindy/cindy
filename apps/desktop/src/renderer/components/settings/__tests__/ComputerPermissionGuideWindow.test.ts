// @vitest-environment jsdom

import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ComputerPermissionGuideWindow,
  PERMISSION_APP_DRAG_UI_FALLBACK_MS,
  PERMISSION_APP_DRAGGED_STORAGE_KEY,
  resolveComputerPermissionGuideInitialAwaitingUser,
  resolveComputerPermissionGuideInteraction,
  resolveComputerPermissionGuideStep,
} from '../ComputerPermissionGuideWindow';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: { permission?: string; current?: number; total?: number }) =>
      ({
        'settings.computerUse.directControl.permissions.accessibilityLabel': 'Accessibility',
        'settings.computerUse.directControl.permissions.screenRecordingLabel': 'Screen Recording',
        'settings.computerUse.directControl.permissionGuide.step': 'Open computer automation',
        'settings.computerUse.directControl.permissionGuide.dragTitle': `Drag Computer Use into ${params?.permission}`,
        'settings.computerUse.directControl.permissionGuide.turnOnAppTitle': `Turn on Computer Use in ${params?.permission}`,
        'settings.computerUse.directControl.permissionGuide.dragHint': 'Drag',
        'settings.computerUse.directControl.permissionGuide.draggingTitle': 'Dragging Computer Use',
        'settings.computerUse.directControl.permissionGuide.draggingHint': `Drop into ${params?.permission}`,
        'settings.computerUse.directControl.permissionGuide.appName': 'Computer Use',
        'settings.computerUse.directControl.permissionGuide.waiting': 'Waiting for you',
        'commonUi.confirmDialog.cancel': 'Cancel',
      })[key] ?? key,
  }),
}));

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('resolveComputerPermissionGuideInteraction', () => {
  it('separates the idle demo, native drag, and user follow-up', () => {
    expect(resolveComputerPermissionGuideInteraction(false, false)).toBe('drag');
    expect(resolveComputerPermissionGuideInteraction(true, false)).toBe('dragging');
    expect(resolveComputerPermissionGuideInteraction(false, true)).toBe('turn-on');
  });

  it('keeps the native drag state authoritative until dragend', () => {
    expect(resolveComputerPermissionGuideInteraction(true, true)).toBe('dragging');
  });
});

describe('resolveComputerPermissionGuideInitialAwaitingUser', () => {
  it('resumes the turn-on flow after the app was already dragged', () => {
    expect(resolveComputerPermissionGuideInitialAwaitingUser('?view=computer-permission-guide&dragged=1')).toBe(true);
    expect(resolveComputerPermissionGuideInitialAwaitingUser('?view=computer-permission-guide')).toBe(false);
    expect(resolveComputerPermissionGuideInitialAwaitingUser(
      '?view=computer-permission-guide',
      '1',
    )).toBe(true);
    expect(PERMISSION_APP_DRAGGED_STORAGE_KEY).toBe('xdmaker.computer-permission-app-dragged');
  });
});

describe('ComputerPermissionGuideWindow native drag fallback', () => {
  it('does not reuse a localStorage drag hint from an earlier guide lifecycle', async () => {
    window.localStorage.setItem(PERMISSION_APP_DRAGGED_STORAGE_KEY, '1');
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        maker: {
          computer: {
            permissionGuideStatus: vi.fn().mockResolvedValue({
              permissionState: {
                platform: 'macos',
                required: true,
                status: 'missing',
                accessibility: 'missing',
                screenRecording: 'missing',
                screenRecordingCapturable: 'missing',
                canGrant: true,
              },
            }),
            driverIcon: vi.fn().mockResolvedValue({ iconDataUrl: null }),
            startPermissionAppDrag: vi.fn(),
            finishPermissionAppDrag: vi.fn(),
            cancelPermissionGrant: vi.fn().mockResolvedValue({ cancelled: true }),
            onPermissionGuideStatusChanged: vi.fn(() => () => undefined),
          },
        },
      },
    });

    render(createElement(ComputerPermissionGuideWindow));

    expect(await screen.findByText('Drag Computer Use into Accessibility')).toBeTruthy();
    expect(screen.queryByText('Turn on Computer Use in Accessibility')).toBeNull();
  });

  it('initializes from the guide preflight snapshot without probing permissions again', async () => {
    const status = vi.fn();
    const permissionGuideStatus = vi.fn().mockResolvedValue({
      permissionState: {
        platform: 'macos',
        required: true,
        status: 'missing',
        accessibility: 'granted',
        screenRecording: 'missing',
        screenRecordingCapturable: 'missing',
        canGrant: true,
      },
    });
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        maker: {
          computer: {
            status,
            permissionGuideStatus,
            driverIcon: vi.fn().mockResolvedValue({ iconDataUrl: null }),
            startPermissionAppDrag: vi.fn(),
            finishPermissionAppDrag: vi.fn(),
            cancelPermissionGrant: vi.fn().mockResolvedValue({ cancelled: true }),
            onPermissionGuideStatusChanged: vi.fn(() => () => undefined),
          },
        },
      },
    });

    render(createElement(ComputerPermissionGuideWindow));

    expect(await screen.findByText('Drag Computer Use into Screen Recording')).toBeTruthy();
    expect(permissionGuideStatus).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();
  });

  it('requires Main to confirm a copied app row before entering the turn-on state', async () => {
    vi.useFakeTimers();
    const startPermissionAppDrag = vi.fn();
    const copiedDragResults = [false, true];
    const finishPermissionAppDrag = vi.fn(async (didCopy: boolean) => (
      didCopy ? copiedDragResults.shift() ?? false : false
    ));
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        maker: {
          computer: {
            permissionGuideStatus: vi.fn(() => new Promise(() => undefined)),
            startPermissionAppDrag,
            finishPermissionAppDrag,
            cancelPermissionGrant: vi.fn().mockResolvedValue({ cancelled: true }),
          },
        },
      },
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,test');

    render(createElement(ComputerPermissionGuideWindow));
    expect(screen.getByText('Open computer automation')).toBeTruthy();
    const image = document.querySelector('img');
    expect(image).not.toBeNull();
    Object.defineProperties(image!, {
      complete: { configurable: true, value: true },
      naturalWidth: { configurable: true, value: 96 },
      naturalHeight: { configurable: true, value: 96 },
    });

    fireEvent.dragStart(screen.getByRole('button', { name: 'Computer Use' }), {
      dataTransfer: { effectAllowed: 'none' },
    });
    expect(startPermissionAppDrag).toHaveBeenCalledOnce();
    expect(screen.getByText('Dragging Computer Use')).toBeTruthy();

    act(() => vi.advanceTimersByTime(PERMISSION_APP_DRAG_UI_FALLBACK_MS));

    expect(screen.queryByText('Dragging Computer Use')).toBeNull();
    expect(screen.getByText('Drag Computer Use into Accessibility')).toBeTruthy();

    const retryButton = screen.getByRole('button', { name: /Computer Use/ });
    expect(retryButton).toHaveProperty('draggable', true);
    fireEvent.dragStart(retryButton, {
      dataTransfer: { effectAllowed: 'none' },
    });

    expect(startPermissionAppDrag).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Dragging Computer Use')).toBeTruthy();

    fireEvent.dragEnd(retryButton, {
      dataTransfer: { dropEffect: 'none' },
    });
    expect(finishPermissionAppDrag).toHaveBeenLastCalledWith(false);
    expect(screen.getByText('Drag Computer Use into Accessibility')).toBeTruthy();

    fireEvent.dragStart(retryButton, {
      dataTransfer: { effectAllowed: 'none' },
    });
    fireEvent.dragEnd(retryButton, {
      dataTransfer: { dropEffect: 'copy' },
    });
    expect(finishPermissionAppDrag).toHaveBeenLastCalledWith(true);
    await act(async () => Promise.resolve());
    expect(screen.getByText('Drag Computer Use into Accessibility')).toBeTruthy();

    fireEvent.dragStart(retryButton, {
      dataTransfer: { effectAllowed: 'none' },
    });
    fireEvent.dragEnd(retryButton, {
      dataTransfer: { dropEffect: 'copy' },
    });
    await act(async () => Promise.resolve());
    expect(screen.getByText('Turn on Computer Use in Accessibility')).toBeTruthy();
  });
});

describe('resolveComputerPermissionGuideStep', () => {
  it('starts with Accessibility', () => {
    expect(resolveComputerPermissionGuideStep({
      platform: 'macos',
      required: true,
      status: 'missing',
      accessibility: 'missing',
      screenRecording: 'missing',
      screenRecordingCapturable: 'missing',
      canGrant: true,
    })).toBe('accessibility');
  });

  it('moves to Screen Recording after Accessibility is granted', () => {
    expect(resolveComputerPermissionGuideStep({
      platform: 'macos',
      required: true,
      status: 'missing',
      accessibility: 'granted',
      screenRecording: 'granted',
      screenRecordingCapturable: 'missing',
      canGrant: true,
    })).toBe('screen-recording');
  });

  it('completes only after both permissions are usable', () => {
    expect(resolveComputerPermissionGuideStep({
      platform: 'macos',
      required: true,
      status: 'granted',
      accessibility: 'granted',
      screenRecording: 'granted',
      screenRecordingCapturable: 'granted',
      canGrant: true,
    })).toBe('complete');
  });
});
