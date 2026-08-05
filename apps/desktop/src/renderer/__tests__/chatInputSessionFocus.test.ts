import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const chatInputSource = readFileSync(
  resolve(__dirname, '..', 'components', 'new-chat', 'ChatInput.tsx'),
  'utf8',
).replace(/\r\n?/g, '\n');

const sessionViewSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'CCAgentSessionView.tsx'),
  'utf8',
).replace(/\r\n?/g, '\n');

const newMakerDraftRouteSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'NewMakerDraftRoute.tsx'),
  'utf8',
).replace(/\r\n?/g, '\n');

const pluginPageSource = readFileSync(
  resolve(__dirname, '..', 'features', 'plugin', 'GhostPluginPage.tsx'),
  'utf8',
).replace(/\r\n?/g, '\n');

const useCCAgentChatSource = readFileSync(
  resolve(__dirname, '..', 'hooks', 'useCCAgentChat.ts'),
  'utf8',
).replace(/\r\n?/g, '\n');

describe('ChatInput session switch focus contract', () => {
  it('refocuses the editor after storageKey switches only when requested', () => {
    const restoreNextDraftBlock = extractBetween(
      chatInputSource,
      'const restoreNextDraft = () => {',
      'const pendingStopAndSend = voiceInputStopAndSendPromiseRef.current;',
    );
    const firstMountHydrationBlock = extractBetween(
      chatInputSource,
      'if (prevEditorKey === storageKey) {',
      'const transitionSeq = storageKeyTransitionSeqRef.current + 1;',
    );

    expect(chatInputSource).toContain('focusOnStorageKeyChange?: boolean;');
    expect(chatInputSource).toContain('focusOnStorageKeyChange = false');
    expect(chatInputSource).toContain('const focusOnStorageKeyChangeRef = useRef(focusOnStorageKeyChange);');
    expect(chatInputSource).toContain('focusOnStorageKeyChangeRef.current = focusOnStorageKeyChange;');
    expect(chatInputSource).toContain('const storageKeyFocusAnchor = document.activeElement;');
    expect(restoreNextDraftBlock).toContain('if (!focusOnStorageKeyChangeRef.current) return;');
    expect(restoreNextDraftBlock).toContain('if (disableAutofocusRef.current || disabledRef.current) return;');
    expect(restoreNextDraftBlock).toContain('if (!isCurrentTransition()) return;');
    expect(restoreNextDraftBlock).toContain('if (hasFocusMovedToInteractiveElement(storageKeyFocusAnchor, editor)) return;');
    expect(restoreNextDraftBlock).toContain("editor.commands.focus('end');");
    expect(firstMountHydrationBlock).toContain('focusOnStorageKeyChangeRef.current');
    expect(firstMountHydrationBlock).toContain("editor.commands.focus('end');");
  });

  it('enables storageKey refocus for routed session and new-draft views', () => {
    expect(sessionViewSource).toContain('const ownsRoute = !sessionIdProp && !isCompactRail && !isOrcaMode;');
    expect(sessionViewSource).toContain('focusOnStorageKeyChange={ownsRoute}');
    expect(newMakerDraftRouteSource).toContain('focusOnStorageKeyChange');
  });

  it('lets only the route-owned session update the shared project scope', () => {
    const projectScopeEffect = extractBetween(
      sessionViewSource,
      '// Keep lastWorkingDir in sync',
      '// (订阅 desktop-command-triggered',
    );

    expect(projectScopeEffect).toContain('if (!ownsRoute) return;');
    expect(projectScopeEffect).toContain('setLastWorkingDir(session.workingDir);');
    expect(projectScopeEffect).toContain('setLastWorkingDir(null);');
  });

  it('keeps deferred editor mount autofocus at the draft end', () => {
    expect(chatInputSource).toContain(
      "autofocus: !disableAutofocus && !disabled ? 'end' : false",
    );
  });

  it('guards delayed storageKey focus against stealing from another focused control', () => {
    expect(chatInputSource).toContain('function hasFocusMovedToInteractiveElement(');
    expect(chatInputSource).toContain('if (activeElement === focusAnchor) return false;');
    expect(chatInputSource).toContain('if (editor.view.dom.contains(activeElement)) return false;');
    expect(chatInputSource).toContain('return isInteractiveFocusedElement(activeElement);');
  });

  it('reuses in-composer Plugin placement for routed Use and end-focuses Create with Cindy', () => {
    expect(pluginPageSource).toContain('pendingGhostId: ghost.manifest.id');
    expect(pluginPageSource.match(/focusAtEnd: true/g)).toHaveLength(1);
    expect(
      chatInputSource.match(/placeGhostAtComposerStart\(editor, ghost, installedGhosts\)/g),
    ).toHaveLength(2);
    expect(chatInputSource).toContain('pendingGhostId: undefined');
    expect(chatInputSource).toContain('focusComposerEndNextFrame(editor);');
  });

  it('records recent Plugin usage only after a successful direct or deferred send', () => {
    const successfulSendBlock = extractBetween(
      chatInputSource,
      'if (result === false) return;',
      '// Suppress onUpdate',
    );
    const worktreeSendBlock = extractBetween(
      newMakerDraftRouteSource,
      'const accepted = await makerChatStore.sendMessage(',
      'worktreeCreationStore.clear(newSession.id);',
    );

    expect(chatInputSource).toContain('findGhostByCommand(eligibleGhosts, ghostCommandWord)');
    expect(chatInputSource).toContain('onAccepted: markRecentPluginUsage');
    expect(successfulSendBlock).toContain('markRecentPluginUsage();');
    expect(newMakerDraftRouteSource.match(/opts\?\.onAccepted\?\.\(\);/g)).toHaveLength(3);
    expect(worktreeSendBlock).toContain('if (accepted) opts?.onAccepted?.();');
  });

  it('propagates the existing-session enqueue acceptance promise back to ChatInput', () => {
    const sendMessageBlock = extractBetween(
      useCCAgentChatSource,
      'const sendMessage = useCallback(',
      'const compactSession = useCallback(',
    );

    expect(sendMessageBlock).toContain('): Promise<boolean> => {');
    expect(sendMessageBlock).toContain('return makerChatStore.sendMessage(');
  });

  it('keeps MRU ordering scoped to the installed shortcut row and subscribes to updates', () => {
    expect(pluginPageSource).toContain(
      'window.electronAPI.ghosts.onRecentUsageChanged(({ ids }) => {',
    );
    expect(pluginPageSource).toMatch(
      /sortGhostPluginItemsByRecentUse\(installedItems, recentGhostIds\)/,
    );
    expect(pluginPageSource).not.toContain(
      'sortGhostPluginItemsByRecentUse(\n        ghosts',
    );
  });
});

function extractBetween(sourceBlock: string, startNeedle: string, endNeedle: string): string {
  const start = sourceBlock.indexOf(startNeedle);
  const end = sourceBlock.indexOf(endNeedle, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return sourceBlock.slice(start, end);
}
