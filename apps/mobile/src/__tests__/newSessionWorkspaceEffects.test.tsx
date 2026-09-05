// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_NEW_SESSION_DRAFT,
  buildRecentWorkspaceOptions,
  pickInitialNewSessionWorkspace,
  pickNewSessionDefaultDevice,
  type NewSessionDraft,
  type NewSessionStoredPreferences,
  type NewSessionWorkspaceKind,
} from '@/session/newSession';

// Mount the page's actual workspace hooks in source order, without loading its unrelated
// voice/media/native UI. Extract AST statements, not copies of the guards under test.
const source = ts.createSourceFile('new.tsx', readFileSync(
  resolve(process.cwd(), 'app/sessions/new.tsx'), 'utf8',
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const page = source.statements.find((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'NewRemoteSessionScreen');
if (!page?.body) throw new Error('NewRemoteSessionScreen not found');
const declarations = new Set([
  'selectedDeviceId', 'selectedDeviceName', 'newSessionPreferences', 'newSessionPreferencesLoaded',
  'preferredDefaultDevice', 'recentWorkspaces', 'draft', 'initialWorkspaceKeyRef',
  'appliedDefaultDeviceKeyRef', 'userTouchedDeviceRef', 'userTouchedWorkspaceRef',
  'patchDraft', 'selectWorkingDir', 'selectDialogueWorkspace', 'selectRecentProject', 'openProjectBrowse',
]);
const effectMarkers = new Set([
  'drainStashedNewSessionDraft', 'readNewSessionPreferences',
  'appliedDefaultDeviceKeyRef', 'pickInitialNewSessionWorkspace',
]);
function identifiers(node: ts.Node): Set<string> {
  const names = new Set<string>();
  function visit(child: ts.Node) {
    if (ts.isIdentifier(child)) names.add(child.text);
    ts.forEachChild(child, visit);
  }
  visit(node);
  return names;
}
const selected = page.body.statements.filter((statement) => {
  if (ts.isVariableStatement(statement)) {
    const names = statement.declarationList.declarations.flatMap((declaration) =>
      [...identifiers(declaration.name)]);
    return names.some((name) => declarations.has(name));
  }
  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)
    || statement.expression.expression.getText(source) !== 'useEffect') return false;
  return [...identifiers(statement)].some((name) => effectMarkers.has(name));
});
// Fail visibly if a refactor moves/removes a hook; never silently stop exercising it.
for (const name of [...declarations, ...effectMarkers]) {
  const matches = selected.filter((node) => ts.isVariableStatement(node)
    ? node.declarationList.declarations.some((declaration) => identifiers(declaration.name).has(name))
    : !declarations.has(name) && identifiers(node).has(name));
  if (matches.length !== 1) throw new Error(`Expected one workspace statement for ${name}`);
}

interface WorkspaceState {
  draft: NewSessionDraft;
  selectedDeviceId: string;
  newSessionPreferencesLoaded: boolean;
  selectDialogueWorkspace(): void;
  selectRecentProject(path: string): void;
  openProjectBrowse(): void;
}
const bindingNames = [
  'useState', 'useRef', 'useMemo', 'useEffect', 'useCallback', 'DEFAULT_NEW_SESSION_DRAFT',
  'pickNewSessionDefaultDevice', 'buildRecentWorkspaceOptions', 'pickInitialNewSessionWorkspace',
  'routeDeviceId', 'routeDeviceName', 'routeDeviceFallback', 'routeDeviceExplicit', 'deviceOptions',
  'initialWorkingDir', 'visualInitialDraft', 'sessions', 'readNewSessionPreferences',
  'saveNewSessionPreferences', 'drainStashedNewSessionDraft', 'loadBrowsePath', 'setDevicePickerOpen',
  'setAttachments', 'setAttachmentError', 'setBrowseOpen', 'setBrowseError',
  'setShowHiddenDirectories', 'setWorkspacePickerOpen',
];
const compiled = ts.transpileModule(`function usePageWorkspace(bindings) {
  const { ${bindingNames.join(', ')} } = bindings;
  ${selected.map((statement) => statement.getText(source)).join('\n')}
  return { draft, selectedDeviceId, newSessionPreferencesLoaded,
    selectDialogueWorkspace, selectRecentProject, openProjectBrowse };
}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const usePageWorkspace = new Function(`${compiled}; return usePageWorkspace;`)() as
  (bindings: Record<string, unknown>) => WorkspaceState;

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; });

function mountWorkspace(options: { initialWorkingDir?: string; restoredKind?: NewSessionWorkspaceKind } = {}) {
  let resolveRead!: (value: NewSessionStoredPreferences) => void;
  const pendingRead = new Promise<NewSessionStoredPreferences>((resolve) => { resolveRead = resolve; });
  const deviceOptions = [{ deviceId: 'a', name: 'A' }, { deviceId: 'b', name: 'B' }];
  const initialWorkingDir = options.initialWorkingDir ?? null;
  const bindings = {
    useState, useRef, useMemo, useEffect, useCallback, DEFAULT_NEW_SESSION_DRAFT,
    pickNewSessionDefaultDevice, buildRecentWorkspaceOptions,
    pickInitialNewSessionWorkspace: vi.fn(pickInitialNewSessionWorkspace),
    routeDeviceId: 'a', routeDeviceName: 'A', routeDeviceFallback: deviceOptions[0],
    routeDeviceExplicit: !!initialWorkingDir, deviceOptions, initialWorkingDir, visualInitialDraft: null,
    sessions: deviceOptions.map(({ deviceId }) => ({
      deviceLinkDeviceId: deviceId, workingDir: `/projects/${deviceId}`, workspaceKind: 'project',
      status: 'active', updatedAt: '2026-09-01T00:00:00Z',
    })),
    readNewSessionPreferences: vi.fn(() => pendingRead),
    saveNewSessionPreferences: vi.fn(async () => {}),
    drainStashedNewSessionDraft: vi.fn(() => options.restoredKind ? {
      draft: { ...DEFAULT_NEW_SESSION_DRAFT, workspaceKind: options.restoredKind,
        workingDir: options.restoredKind === 'project' ? '/restored/project' : '' },
      attachments: [], deviceId: 'a', deviceName: 'A',
    } : null),
    loadBrowsePath: vi.fn(async () => {}), setDevicePickerOpen: vi.fn(),
    setAttachments: vi.fn(), setAttachmentError: vi.fn(), setBrowseOpen: vi.fn(),
    setBrowseError: vi.fn(), setShowHiddenDirectories: vi.fn(), setWorkspacePickerOpen: vi.fn(),
  };
  let current!: WorkspaceState;
  const commits: Array<{ device: string; kind: NewSessionWorkspaceKind; path: string }> = [];
  function Harness() {
    current = usePageWorkspace(bindings);
    useEffect(() => {
      commits.push({ device: current.selectedDeviceId, kind: current.draft.workspaceKind,
        path: current.draft.workingDir });
    });
    return null;
  }
  root = createRoot(document.createElement('div'));
  act(() => root!.render(createElement(Harness)));
  return {
    bindings, commits, get current() { return current; },
    async resolvePreferences(kind: NewSessionWorkspaceKind | null, deviceId = 'a') {
      await act(async () => {
        resolveRead({ workspaceKind: kind, device: { deviceId, name: deviceId },
          agentKind: null, permissionModeByAgent: {} });
        await pendingRead;
      });
    },
  };
}

describe('new session workspace page effects', () => {
  it('keeps an explicit project entry when a different preference arrives late', async () => {
    const page = mountWorkspace({ initialWorkingDir: '/explicit/project' });
    await page.resolvePreferences('dialogue', 'b');
    expect(page.current.draft).toMatchObject({ workspaceKind: 'project', workingDir: '/explicit/project' });
    expect(page.current.selectedDeviceId).toBe('a');
    expect(page.bindings.loadBrowsePath).not.toHaveBeenCalled();
  });

  it.each(['project', 'dialogue'] as const)('preserves a restored %s draft over a late default', async (kind) => {
    const page = mountWorkspace({ restoredKind: kind });
    await page.resolvePreferences(kind === 'project' ? 'dialogue' : 'project', 'b');
    expect(page.current.draft).toMatchObject({ workspaceKind: kind,
      workingDir: kind === 'project' ? '/restored/project' : '' });
    expect(page.current.selectedDeviceId).toBe('a');
    expect(page.bindings.pickInitialNewSessionWorkspace).not.toHaveBeenCalled();
  });

  it.each(['project', 'dialogue'] as const)('preserves a manual %s choice made during the read', async (kind) => {
    const page = mountWorkspace();
    act(() => kind === 'project'
      ? page.current.selectRecentProject('/manual/project')
      : page.current.selectDialogueWorkspace());
    await page.resolvePreferences(kind === 'project' ? 'dialogue' : 'project');
    expect(page.current.draft).toMatchObject({ workspaceKind: kind,
      workingDir: kind === 'project' ? '/manual/project' : '' });
    expect(page.bindings.saveNewSessionPreferences).toHaveBeenCalledWith({ workspaceKind: kind });
  });

  it('keeps an explicitly opened project browser open after a late dialogue preference', async () => {
    const page = mountWorkspace();
    act(() => page.current.openProjectBrowse());
    await page.resolvePreferences('dialogue');
    expect(page.current.draft).toMatchObject({ workspaceKind: 'project', workingDir: '' });
    expect(page.bindings.setBrowseOpen).toHaveBeenLastCalledWith(true);
    expect(page.bindings.loadBrowsePath).toHaveBeenCalledExactlyOnceWith('~');
  });

  it('waits for the remembered device before choosing a project, including intermediate commits', async () => {
    const page = mountWorkspace();
    expect(page.current.newSessionPreferencesLoaded).toBe(false);
    expect(page.bindings.pickInitialNewSessionWorkspace).not.toHaveBeenCalled();
    await page.resolvePreferences('project', 'b');
    expect(page.current.selectedDeviceId).toBe('b');
    expect(page.current.draft.workingDir).toBe('/projects/b');
    expect(page.bindings.pickInitialNewSessionWorkspace).toHaveBeenCalledTimes(1);
    expect(page.commits.filter(({ path }) => path)).toEqual([
      { device: 'b', kind: 'project', path: '/projects/b' },
    ]);
    expect(page.bindings.loadBrowsePath).not.toHaveBeenCalled();
  });

  it('keeps the existing default when storage has no remembered mode', async () => {
    const page = mountWorkspace();
    await page.resolvePreferences(null);
    expect(page.current.draft).toMatchObject({ workspaceKind: 'dialogue', workingDir: '' });
    expect(page.bindings.pickInitialNewSessionWorkspace).not.toHaveBeenCalled();
  });
});
