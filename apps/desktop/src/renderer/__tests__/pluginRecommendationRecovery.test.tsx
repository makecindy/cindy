/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useCallback, useEffect, useRef, useState } from 'react';
import { act, renderHook } from '@testing-library/react';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Execute the production callbacks without mounting the unrelated full desktop shell.
function compile(source: string, bindings: Record<string, unknown>) {
  const code = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(bindings), code)(...Object.values(bindings));
}
afterEach(() => vi.unstubAllGlobals());

describe('plugin recommendation recovery', () => {
  it.each(['mail', undefined])(
    'fills the composer with the plugin-bound prompt instead of sending (command=%s)',
    async (command) => {
      const source = readFileSync(
        resolve(__dirname, '../features/cc-agent/NewMakerDraftRoute.tsx'),
        'utf8',
      );
      const block = source.slice(
        source.indexOf('  const runPluginSuggestion ='),
        source.indexOf('  const handlePluginSuggestion ='),
      );
      expect(block).not.toContain('handleSend');
      const suggestion = { id: 'one', pluginId: 'mail', prompt: 'Review my mail' };
      const ghost = { manifest: { id: 'mail', name: 'Mail', command }, enabled: true };
      const fillComposerWithSuggestion = vi.fn();
      vi.stubGlobal('electronAPI', {});
      Object.assign(window, { electronAPI: { ghosts: { listSync: () => ({ ghosts: [ghost] }) } } });
      const run = compile(`${block}\nreturn runPluginSuggestion;`, {
        useCallback: (callback: unknown) => callback,
        sendInFlightRef: { current: false },
        pluginSuggestionFlight: { current: false },
        pluginSuggestionMounted: { current: true },
        currentPluginSuggestionContext: {
          current: { generation: 1, dataOwnerId: 'owner', targetKey: 'local' },
        },
        readPluginRecommendationSnapshot: () => ({ ownerId: 'owner' }),
        buildHomeTaskCatalog: () => [suggestion],
        filterGhostsForWorkdir: (ghosts: unknown[]) => ghosts,
        fillComposerWithSuggestion,
        i18n: { language: 'en' },
        t: () => 'Use plugin mail via ghost_info and ghost_call',
        isRemoteProjectDraft: false,
        isDeviceLinkDraft: false,
        navigate: vi.fn(),
        toast: { error: vi.fn() },
      });
      await run({ suggestion, ownerId: 'owner', targetKey: 'local', workingDir: '/project' });
      expect(fillComposerWithSuggestion).toHaveBeenCalledOnce();
      const [filled] = fillComposerWithSuggestion.mock.calls[0] as [string];
      expect(filled).toContain('Review my mail');
      // $command stays as typed text; ChatInput expands it when the user sends.
      expect(filled).toContain(command ? '$mail ' : 'ghost_info');
    },
  );

  it('loads project overrides on entry and clears them when choosing global scope', () => {
    const source = readFileSync(
      resolve(__dirname, '../features/plugin/GhostPluginPage.tsx'),
      'utf8',
    );
    const block = source.slice(
      source.indexOf('  const [scopeDir, setScopeDir]'),
      source.indexOf('  const [recentGhostIds, setRecentGhostIds]'),
    );
    const workdirPrefsSync = vi.fn(() => ({ disabled: ['mail'] }));
    vi.stubGlobal('electronAPI', { ghosts: { workdirPrefsSync } });
    const useScope = compile(
      `return function useScope() { ${block}\nreturn {scopeDir, projectDisabled, handlePickScope, effectiveEnabled}; }`,
      {
        useState,
        useRef,
        useEffect,
        useCallback,
        recommendation: { nonce: 'one', workingDir: '/project', suggestion: { pluginId: 'mail' } },
        ghosts: [{ manifest: { id: 'mail' }, enabled: true }],
      },
    );
    const { result } = renderHook(() => useScope());
    expect(workdirPrefsSync).toHaveBeenCalledWith('/project');
    expect(result.current.scopeDir).toBe('/project');
    expect(result.current.effectiveEnabled('mail', true)).toBe(false);
    act(() => result.current.handlePickScope(null));
    expect(result.current.projectDisabled.size).toBe(0);
    expect(result.current.effectiveEnabled('mail', true)).toBe(true);
  });
});
