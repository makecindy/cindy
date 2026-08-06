// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

import {
  applyFontSettings,
  clampUiFontSize,
  DEFAULT_CODE_FONT_SIZE,
  DEFAULT_UI_FONT_SIZE,
  FontSettingsProvider,
  getInitialFontSettings,
  type FontSettings,
  useFontSettings,
} from '@/hooks/useFontSettings';

function resetRootStyles() {
  const targets = [document.documentElement, document.body];
  for (const target of targets) {
    target.style.removeProperty('--app-font-ui');
    target.style.removeProperty('--app-font-code');
    target.style.removeProperty('--app-code-font-size');
    target.style.removeProperty('--app-ui-font-size');
    for (const tokenSize of [
      9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28,
    ]) {
      target.style.removeProperty(`--text-${tokenSize}`);
    }
    for (const token of ['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl']) {
      target.style.removeProperty(`--text-${token}`);
      target.style.removeProperty(`--text-${token}-line-height`);
    }
  }
}

describe('font settings', () => {
  beforeEach(() => {
    localStorage.clear();
    resetRootStyles();
  });

  it('reads defaults from empty localStorage', () => {
    expect(getInitialFontSettings()).toEqual({
      uiFamily: '',
      codeFamily: '',
      uiSize: DEFAULT_UI_FONT_SIZE,
      codeSize: DEFAULT_CODE_FONT_SIZE,
    });
  });

  it('ignores legacy renderer storage after the clean cut-over', () => {
    localStorage.setItem('font.uiFamily', '  "Segoe UI"  ');
    localStorage.setItem('font.codeFamily', '  Consolas  ');
    localStorage.setItem('font.uiSize', 'not-a-number');
    localStorage.setItem('font.codeSize', '99');

    expect(getInitialFontSettings()).toEqual({
      uiFamily: '',
      codeFamily: '',
      uiSize: DEFAULT_UI_FONT_SIZE,
      codeSize: DEFAULT_CODE_FONT_SIZE,
    });
  });

  it('clamps UI font size separately from code font size', () => {
    expect(clampUiFontSize(11)).toBe(12);
    expect(clampUiFontSize(12)).toBe(12);
    expect(clampUiFontSize(24)).toBe(24);
    expect(clampUiFontSize(25)).toBe(24);
    expect(clampUiFontSize(Number.NaN)).toBe(DEFAULT_UI_FONT_SIZE);
  });

  it('injects user fonts before default fallback stacks', () => {
    const settings: FontSettings = {
      uiFamily: '  "Segoe UI"  ',
      codeFamily: 'Consolas',
      uiSize: DEFAULT_UI_FONT_SIZE,
      codeSize: 16,
    };

    applyFontSettings(settings);

    const rootStyle = document.documentElement.style;
    expect(rootStyle.getPropertyValue('--app-font-ui')).toBe(
      '"Segoe UI", var(--app-font-ui-default)',
    );
    expect(rootStyle.getPropertyValue('--app-font-code')).toBe(
      'Consolas, var(--app-font-code-default)',
    );
    expect(rootStyle.getPropertyValue('--app-code-font-size')).toBe('16px');
    expect(document.body.style.getPropertyValue('--app-font-ui')).toBe(
      '"Segoe UI", var(--app-font-ui-default)',
    );
    expect(document.body.style.getPropertyValue('--app-code-font-size')).toBe('16px');
  });

  it('writes UI font-size tokens with the default scale', () => {
    const settings: FontSettings = {
      uiFamily: '',
      codeFamily: '',
      uiSize: DEFAULT_UI_FONT_SIZE,
      codeSize: DEFAULT_CODE_FONT_SIZE,
    };

    applyFontSettings(settings);

    const rootStyle = document.documentElement.style;
    expect(rootStyle.getPropertyValue('--app-ui-font-size')).toBe(`${DEFAULT_UI_FONT_SIZE}px`);
    for (const tokenSize of [
      9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28,
    ]) {
      expect(rootStyle.getPropertyValue(`--text-${tokenSize}`)).toBe(`${tokenSize}px`);
    }
    expect(rootStyle.getPropertyValue('--text-sm-line-height')).toBe('20px');
    expect(document.body.style.getPropertyValue('--text-sm-line-height')).toBe('20px');
  });

  it('scales UI font-size tokens from uiSize', () => {
    const settings: FontSettings = {
      uiFamily: '',
      codeFamily: '',
      uiSize: 18,
      codeSize: DEFAULT_CODE_FONT_SIZE,
    };

    applyFontSettings(settings);

    const rootStyle = document.documentElement.style;
    expect(rootStyle.getPropertyValue('--app-ui-font-size')).toBe('18px');
    for (const tokenSize of [
      9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28,
    ]) {
      expect(rootStyle.getPropertyValue(`--text-${tokenSize}`)).toBe(
        `${Math.round((tokenSize * 18) / DEFAULT_UI_FONT_SIZE)}px`,
      );
    }
    expect(rootStyle.getPropertyValue('--text-sm-line-height')).toBe('26px');
    expect(document.body.style.getPropertyValue('--text-sm-line-height')).toBe('26px');
  });

  it('removes font overrides and keeps code size clamped', () => {
    document.documentElement.style.setProperty('--app-font-ui', 'custom');
    document.documentElement.style.setProperty('--app-font-code', 'custom');

    applyFontSettings({
      uiFamily: '',
      codeFamily: '',
      uiSize: DEFAULT_UI_FONT_SIZE,
      codeSize: Number.NaN,
    });

    const rootStyle = document.documentElement.style;
    expect(rootStyle.getPropertyValue('--app-font-ui')).toBe('');
    expect(rootStyle.getPropertyValue('--app-font-code')).toBe('');
    expect(rootStyle.getPropertyValue('--app-code-font-size')).toBe(`${DEFAULT_CODE_FONT_SIZE}px`);
    expect(document.body.style.getPropertyValue('--app-font-ui')).toBe('');
    expect(document.body.style.getPropertyValue('--app-font-code')).toBe('');
  });

  it('resets UI font size to the default', () => {
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(FontSettingsProvider, null, children);
    const { result } = renderHook(() => useFontSettings(), { wrapper });

    act(() => {
      result.current.setUiSize(18);
    });
    expect(result.current.uiSize).toBe(18);
    expect(localStorage.getItem('font.uiSize')).toBeNull();

    act(() => {
      result.current.resetUiSize();
    });

    expect(result.current.uiSize).toBe(DEFAULT_UI_FONT_SIZE);
    expect(localStorage.getItem('font.uiSize')).toBeNull();
  });

  it('keeps newer optimistic font updates when an older main snapshot arrives', async () => {
    let onChanged:
      | ((settings: {
          uiFamily: string;
          codeFamily: string;
          uiSize: number;
          codeSize: number;
          windowZoom: number;
        }) => void)
      | undefined;
    const setPatch = vi.fn(() => new Promise<void>(() => undefined));
    const originalElectronApi = window.electronAPI;
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        appearanceSettings: {
          getSync: () => ({
            uiFamily: '',
            codeFamily: '',
            uiSize: DEFAULT_UI_FONT_SIZE,
            codeSize: DEFAULT_CODE_FONT_SIZE,
            windowZoom: 1,
          }),
          setPatch,
          onChanged: (callback: typeof onChanged) => {
            onChanged = callback;
            return () => undefined;
          },
        },
      },
    });

    try {
      const wrapper = ({ children }: { children: ReactNode }) =>
        createElement(FontSettingsProvider, null, children);
      const { result } = renderHook(() => useFontSettings(), { wrapper });

      act(() => {
        result.current.setUiSize(16);
        result.current.setUiSize(18);
      });
      expect(result.current.uiSize).toBe(18);
      await waitFor(() => expect(setPatch).toHaveBeenCalledTimes(1));

      act(() => {
        onChanged?.({
          uiFamily: '',
          codeFamily: '',
          uiSize: 16,
          codeSize: DEFAULT_CODE_FONT_SIZE,
          windowZoom: 1,
        });
      });
      expect(result.current.uiSize).toBe(18);
    } finally {
      Object.defineProperty(window, 'electronAPI', {
        configurable: true,
        value: originalElectronApi,
      });
    }
  });
});
