/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useCallback, useEffect, useRef, useState } from 'react';
import { act, renderHook } from '@testing-library/react';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pluginSuggestionComposerText } from '../features/cc-agent/pluginHomeSuggestions';
import {
  findInstalledGhostByInstanceId,
  installedGhostLogicalIdentity,
  installedGhostStoragePart,
} from '../../shared/pluginIdentity';

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
      const fillComposerWithSuggestion = vi.fn((text: string) => text.length > 0);
      const markUsed = vi.fn(async () => ({ ids: ['mail'] }));
      vi.stubGlobal('electronAPI', {});
      Object.assign(window, {
        electronAPI: { ghosts: { listSync: () => ({ ghosts: [ghost] }), markUsed } },
      });
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
        pluginSuggestionComposerText,
        installedGhostStoragePart,
        installedGhostLogicalIdentity,
        runPluginInPlace: vi.fn(),
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
      // Hover preview uses the same helper, so it shows exactly this text.
      expect(filled).toBe(
        pluginSuggestionComposerText(
          suggestion.prompt,
          ghost,
          () => 'Use plugin mail via ghost_info and ghost_call',
        ),
      );
      // Filling counts as using the plugin (plain-text sends cannot identify it later).
      expect(markUsed).toHaveBeenCalledWith('mail');
    },
  );

  // 2026-11-17: a suggestion for a plugin that is not installed installs it right here and
  // then fills the composer, instead of opening the plugin page.
  it('installs a missing plugin in place, then fills the composer', async () => {
    const source = readFileSync(resolve(__dirname, '../features/cc-agent/NewMakerDraftRoute.tsx'), 'utf8');
    const block = source.slice(source.indexOf('  const runPluginSuggestion ='), source.indexOf('  const handlePluginSuggestion ='));
    const suggestion = { id: 'one', pluginId: 'mail', prompt: 'Review my mail' };
    const ghost = { manifest: { id: 'mail', name: 'Mail', command: 'mail' }, dir: '/ghosts/mail', namespace: null, enabled: true };
    let ghosts: unknown[] = [];
    const fillComposerWithSuggestion = vi.fn(() => true);
    const markUsed = vi.fn(async () => ({ ids: ['mail'] }));
    const navigate = vi.fn();
    Object.assign(window, { electronAPI: { ghosts: { listSync: () => ({ ghosts }), markUsed } } });
    const runPluginInPlace = vi.fn(async (_target: unknown, options: { onReady: () => void; isCurrent: () => boolean }) => {
      expect(options.isCurrent()).toBe(true);
      ghosts = [ghost];
      options.onReady();
    });
    const run = compile(block + String.fromCharCode(10) + 'return runPluginSuggestion;', {
      useCallback: (callback: unknown) => callback,
      sendInFlightRef: { current: false },
      pluginSuggestionFlight: { current: false },
      pluginSuggestionMounted: { current: true },
      currentPluginSuggestionContext: { current: { generation: 1, dataOwnerId: 'owner', targetKey: 'local' } },
      readPluginRecommendationSnapshot: () => ({ ownerId: 'owner' }),
      buildHomeTaskCatalog: () => [suggestion],
      filterGhostsForWorkdir: (list: unknown[]) => list,
      fillComposerWithSuggestion,
      pluginSuggestionComposerText,
      installedGhostStoragePart,
      installedGhostLogicalIdentity,
      runPluginInPlace,
      startPendingPluginSuggestion: vi.fn(() => 'nonce'),
      i18n: { language: 'en' },
      t: () => 'Use Mail',
      isRemoteProjectDraft: false,
      isDeviceLinkDraft: false,
      navigate,
      toast: { error: vi.fn() },
    });
    await run({ suggestion, ownerId: 'owner', targetKey: 'local', workingDir: '/project' });
    expect(runPluginInPlace).toHaveBeenCalledWith({ ghostId: 'mail', workingDir: '/project' }, expect.anything());
    expect(fillComposerWithSuggestion).toHaveBeenCalledWith('$mail Review my mail');
    expect(markUsed).toHaveBeenCalledWith('mail');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('fills the selected organization recommendation rather than the same-name root plugin', async () => {
    const source = readFileSync(resolve(__dirname, '../features/cc-agent/NewMakerDraftRoute.tsx'), 'utf8');
    const block = source.slice(source.indexOf('  const runPluginSuggestion ='), source.indexOf('  const handlePluginSuggestion ='));
    const suggestion = { id: 'plugin:_ns__acme__helper:task', pluginId: '_ns__acme__helper', prompt: 'Org task' };
    const root = { manifest: { id: 'helper', name: 'Root', command: 'root' }, dir: '/ghosts/helper', enabled: true };
    const org = { manifest: { id: 'helper', name: 'Org', command: 'org' }, dir: '/ghosts/_ns/acme/helper', namespace: 'acme', enabled: true };
    const fillComposerWithSuggestion = vi.fn(() => true);
    const markUsed = vi.fn(async () => ({ ids: ['_ns__acme__helper'] }));
    Object.assign(window, { electronAPI: { ghosts: { listSync: () => ({ ghosts: [root, org] }), markUsed } } });
    const run = compile(block + String.fromCharCode(10) + 'return runPluginSuggestion;', {
      useCallback: (callback: unknown) => callback,
      sendInFlightRef: { current: false },
      pluginSuggestionFlight: { current: false },
      pluginSuggestionMounted: { current: true },
      currentPluginSuggestionContext: { current: { generation: 1, dataOwnerId: 'owner', targetKey: 'local' } },
      readPluginRecommendationSnapshot: () => ({ ownerId: 'owner' }),
      buildHomeTaskCatalog: () => [suggestion],
      filterGhostsForWorkdir: (ghosts: unknown[]) => ghosts,
      fillComposerWithSuggestion,
      pluginSuggestionComposerText,
      installedGhostStoragePart,
      installedGhostLogicalIdentity,
      runPluginInPlace: vi.fn(),
      i18n: { language: 'en' },
      t: () => 'Use Org',
      isRemoteProjectDraft: false,
      isDeviceLinkDraft: false,
      navigate: vi.fn(),
      toast: { error: vi.fn() },
    });
    await run({ suggestion, ownerId: 'owner', targetKey: 'local', workingDir: '/project' });
    expect(fillComposerWithSuggestion).toHaveBeenCalledWith('$org Org task');
    expect(markUsed).toHaveBeenCalledWith('_ns__acme__helper');
  });

  it('keeps the qualifier when a disabled root plugin shares the selected command', async () => {
    const source = readFileSync(resolve(__dirname, '../features/cc-agent/NewMakerDraftRoute.tsx'), 'utf8');
    const block = source.slice(source.indexOf('  const runPluginSuggestion ='), source.indexOf('  const handlePluginSuggestion ='));
    const suggestion = { id: 'plugin:_ns__acme__helper:task', pluginId: '_ns__acme__helper', prompt: 'Org task' };
    // A disabled sibling cannot be chosen, but re-enabling it before send must not make the fill ambiguous.
    const root = { manifest: { id: 'helper', name: 'Root', command: 'org' }, dir: '/ghosts/helper', namespace: null, enabled: false };
    const org = { manifest: { id: 'helper', name: 'Org', command: 'org' }, dir: '/ghosts/_ns/acme/helper', namespace: 'acme', enabled: true };
    const fillComposerWithSuggestion = vi.fn(() => true);
    const markUsed = vi.fn(async () => ({ ids: ['_ns__acme__helper'] }));
    Object.assign(window, { electronAPI: { ghosts: { listSync: () => ({ ghosts: [root, org] }), markUsed } } });
    const run = compile(block + String.fromCharCode(10) + 'return runPluginSuggestion;', {
      useCallback: (callback: unknown) => callback,
      sendInFlightRef: { current: false },
      pluginSuggestionFlight: { current: false },
      pluginSuggestionMounted: { current: true },
      currentPluginSuggestionContext: { current: { generation: 1, dataOwnerId: 'owner', targetKey: 'local' } },
      readPluginRecommendationSnapshot: () => ({ ownerId: 'owner' }),
      buildHomeTaskCatalog: () => [suggestion],
      filterGhostsForWorkdir: (ghosts: unknown[]) => ghosts,
      fillComposerWithSuggestion,
      pluginSuggestionComposerText,
      installedGhostStoragePart,
      installedGhostLogicalIdentity,
      runPluginInPlace: vi.fn(),
      i18n: { language: 'en' },
      t: () => 'Use Org',
      isRemoteProjectDraft: false,
      isDeviceLinkDraft: false,
      navigate: vi.fn(),
      toast: { error: vi.fn() },
    });
    await run({ suggestion, ownerId: 'owner', targetKey: 'local', workingDir: '/project' });
    expect(fillComposerWithSuggestion).toHaveBeenCalledWith('$org/acme Org task');
    expect(markUsed).toHaveBeenCalledWith('_ns__acme__helper');
  });

  it('retains project scope for the recommended organization alongside its root sibling', () => {
    const source = readFileSync(resolve(__dirname, '../features/plugin/GhostPluginPage.tsx'), 'utf8');
    const block = source.slice(source.indexOf('  const [scopeDir, setScopeDir]'), source.indexOf('  const [recentGhostIds, setRecentGhostIds]'));
    const workdirPrefsSync = vi.fn(() => ({ disabled: ['_ns__acme__helper'] }));
    vi.stubGlobal('electronAPI', { ghosts: { workdirPrefsSync } });
    const useScope = compile('return function useScope() { ' + block + '\nreturn {scopeDir, effectiveEnabled}; }', {
      useState, useRef, useEffect, useCallback, findInstalledGhostByInstanceId,
      recommendation: { nonce: 'org', workingDir: '/project', suggestion: { pluginId: '_ns__acme__helper' } },
      ghosts: [
        { manifest: { id: 'helper' }, dir: '/ghosts/helper', namespace: null, enabled: true },
        { manifest: { id: 'helper' }, dir: '/ghosts/_ns/acme/helper', namespace: 'acme', enabled: true },
      ],
    });
    const { result } = renderHook(() => useScope());
    expect(workdirPrefsSync).toHaveBeenCalledWith('/project');
    expect(result.current.scopeDir).toBe('/project');
    expect(result.current.effectiveEnabled('_ns__acme__helper', true)).toBe(false);
    expect(result.current.effectiveEnabled('helper', true)).toBe(true);
  });

  it('names the organization instance in commandless suggestion previews and composer text', () => {
    const root = { manifest: { id: 'helper', name: 'Root' }, dir: '/ghosts/helper', namespace: null };
    const org = { manifest: { id: 'helper', name: 'Org' }, dir: '/ghosts/_ns/acme/helper', namespace: 'acme' };
    const translate = (_key: string, options?: Record<string, unknown>) => 'Use ' + options?.id;
    expect(pluginSuggestionComposerText('Org task', org, translate)).toBe('Org task\n\nUse helper namespace:acme');
    expect(pluginSuggestionComposerText('Root task', root, translate)).toBe('Root task\n\nUse helper');
  });

  it('uses the logical namespace for a legacy flat organization instance', () => {
    const flatOrg = { manifest: { id: 'helper', name: 'Org' }, dir: '/ghosts/helper', namespace: 'acme' };
    const translate = (_key: string, options?: Record<string, unknown>) => 'Use ' + options?.id;
    expect(pluginSuggestionComposerText('Org task', flatOrg, translate)).toBe(
      'Org task\n\nUse helper namespace:acme',
    );
  });

  it('qualifies a selected root command when a namespaced sibling shares it', () => {
    const root = { manifest: { id: 'helper', name: 'Root', command: 'draw' }, namespace: null };
    const org = { manifest: { id: 'helper', name: 'Org', command: 'draw' }, namespace: 'acme' };
    expect(pluginSuggestionComposerText('Root task', root, () => '', [root, org])).toBe('$draw/@root Root task');
    expect(pluginSuggestionComposerText('Org task', org, () => '', [root, org])).toBe('$draw/acme Org task');
  });

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
        findInstalledGhostByInstanceId,
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
