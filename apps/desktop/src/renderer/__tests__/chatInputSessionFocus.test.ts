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
    expect(chatInputSource).toContain(
      'const focusOnStorageKeyChangeRef = useRef(focusOnStorageKeyChange);',
    );
    expect(chatInputSource).toContain(
      'focusOnStorageKeyChangeRef.current = focusOnStorageKeyChange;',
    );
    expect(chatInputSource).toContain('const storageKeyFocusAnchor = document.activeElement;');
    expect(restoreNextDraftBlock).toContain('if (!focusOnStorageKeyChangeRef.current) return;');
    expect(restoreNextDraftBlock).toContain(
      'if (disableAutofocusRef.current || disabledRef.current) return;',
    );
    expect(restoreNextDraftBlock).toContain('if (!isCurrentTransition()) return;');
    expect(restoreNextDraftBlock).toContain(
      'if (hasFocusMovedToInteractiveElement(storageKeyFocusAnchor, editor.view.dom)) return;',
    );
    expect(restoreNextDraftBlock).toContain("editor.commands.focus('end');");
    expect(firstMountHydrationBlock).toContain('focusOnStorageKeyChangeRef.current');
    expect(firstMountHydrationBlock).toContain("editor.commands.focus('end');");
  });

  it('enables storageKey refocus for routed session and new-draft views', () => {
    expect(sessionViewSource).toContain(
      'const ownsRoute = routeOwner ?? (!sessionIdProp && !isCompactRail && !isOrcaMode);',
    );
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
    expect(chatInputSource).toContain("autofocus: !disableAutofocus && !disabled ? 'end' : false");
  });

  it('guards delayed storageKey focus against stealing from another focused control', () => {
    expect(chatInputSource).toContain(
      'hasFocusMovedToInteractiveElement(storageKeyFocusAnchor, editor.view.dom)',
    );
  });

  it('wires local send locking through the behavior-tested focus restore hook', () => {
    const localSendLockBlock = extractBetween(
      chatInputSource,
      '// Local/SSH sends keep the live composer while references and runtime',
      'try {\n        let serializedContent',
    );

    expect(chatInputSource).toContain(
      'const captureSendFocusForRestore = useComposerSendFocusRestore(',
    );
    expect(localSendLockBlock).toContain('captureSendFocusForRestore();');
    expect(localSendLockBlock.indexOf('captureSendFocusForRestore();')).toBeLessThan(
      localSendLockBlock.indexOf('setSendDispatchInFlight(true);'),
    );
  });

  it('reuses composer entry paths for Plugin commands and Host capabilities', () => {
    const capabilitySelectionBlock = extractBetween(
      chatInputSource,
      'const insertAtResource = useCallback(',
      'const handleComposerSuggestionSelect = useCallback(',
    );

    expect(pluginPageSource).toContain('pendingGhostId: ghost.manifest.id');
    expect(pluginPageSource).toContain('pendingHostCapabilityGhostId: ghost.manifest.id');
    expect(pluginPageSource.match(/focusAtEnd: true/g)).toHaveLength(1);
    expect(
      chatInputSource.match(/placeGhostAtComposerStart\(editor, ghost, installedGhosts\)/g),
    ).toHaveLength(1);
    expect(
      chatInputSource.match(
        /placeGhostAtComposerStart\(editor, ghost, installedGhostsRef\.current\)/g,
      ),
    ).toHaveLength(1);
    expect(chatInputSource).toContain('pendingGhostId: undefined');
    expect(chatInputSource).toContain('pendingHostCapabilityGhostId: undefined');
    expect(
      chatInputSource.match(
        /placeHostCapabilityAtComposerStart\(editor, ghost, installedGhosts\)/g,
      ),
    ).toHaveLength(1);
    expect(capabilitySelectionBlock).toContain("selectedItem.type === 'plugin-command'");
    expect(capabilitySelectionBlock).toContain('if (ghost.manifest.command) {');
    expect(capabilitySelectionBlock).toContain(
      'placeGhostAtComposerStart(editor, ghost, installedGhostsRef.current);',
    );
    expect(capabilitySelectionBlock).toContain(
      'placeHostCapabilityAtComposerStart(editor, ghost, installedGhostsRef.current);',
    );
    expect(capabilitySelectionBlock).toContain('!remoteHostId');
    expect(capabilitySelectionBlock).toContain('!deviceLinkDeviceId');
    expect(capabilitySelectionBlock).not.toContain('focusIOSSimulatorPanel');
    expect(chatInputSource).toContain('focusComposerEndNextFrame(editor);');
  });

  it('records recent Plugin usage only after a successful direct or deferred send', () => {
    const successfulSendBlock = extractBetween(
      chatInputSource,
      'if (result === false) {',
      'if (!optimisticallyClearRemoteComposer) clearSentComposer();',
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

  it('optimistically clears device-link composer state before awaiting send and restores without dropping newer input', () => {
    const transitionBegin = chatInputSource.indexOf(
      'makerChatStore.beginRemoteOptimisticComposerTransition(',
    );
    const optimisticClear = chatInputSource.indexOf('if (optimisticallyClearRemoteComposer) {');
    const frozenReferenceHydration = chatInputSource.search(
      /agentReferences\s*=\s*await resolveSerializedSessionMessageReferencesForSend\(agentReferences\);/,
    );
    const onSend = chatInputSource.indexOf('result = await onSend(', optimisticClear);
    const failedRestore = chatInputSource.indexOf('restoreRemoteComposerAndRelease();', onSend);
    const restoreAndReleaseBlock = extractBetween(
      chatInputSource,
      'const restoreRemoteComposerAndRelease = () => {',
      'if (optimisticallyClearRemoteComposer) {',
    );

    expect(chatInputSource).toContain('deviceLinkDeviceId && sourceSessionId');
    expect(transitionBegin).toBeGreaterThanOrEqual(0);
    expect(optimisticClear).toBeGreaterThanOrEqual(0);
    expect(transitionBegin).toBeLessThan(optimisticClear);
    expect(frozenReferenceHydration).toBeGreaterThan(optimisticClear);
    expect(frozenReferenceHydration).toBeLessThan(onSend);
    expect(onSend).toBeGreaterThan(optimisticClear);
    expect(failedRestore).toBeGreaterThan(onSend);
    expect(chatInputSource).toContain('sourceSessionId,\n                filesToSend,');
    expect(restoreAndReleaseBlock.indexOf('restoreOptimisticallyClearedComposer();')).toBeLessThan(
      restoreAndReleaseBlock.indexOf('releaseRemoteComposerTransition();'),
    );
    expect(chatInputSource).toContain('let optimisticComposerRestored = false;');
    expect(chatInputSource).toContain('restoreRemoteOptimisticDraft(');
    expect(chatInputSource).toContain('text: isEditorEmpty(editor) ? null : editor.getJSON()');
    expect(chatInputSource).toContain('attachments: latestAttachmentsRef.current');
    expect(chatInputSource).toContain('browserComments: browserCommentsRef.current');
    expect(chatInputSource).toContain("editor.commands.focus('end');");
    expect(chatInputSource).toContain('restoreFiles(restored.attachments);');
    expect(chatInputSource).toContain(
      'latestStorageKeyRef.current === sourceStorageKey &&\n            storageKeyForDraftRef.current === sourceStorageKey',
    );
    expect(chatInputSource).toContain(
      'restoreRemoteOptimisticDraft(\n            sourceStorageKey,',
    );
    expect(chatInputSource).toContain('!isDataOwnerGenerationCurrent(dataOwnerAtOptimisticClear)');
    expect(chatInputSource).toContain('restoreOptimisticallyClearedComposer(clientId, {');
    expect(chatInputSource).toContain('isRemoteOptimisticDataOwnerBoundaryError(error)');
    expect(chatInputSource).toContain('isRemoteOptimisticSessionPurgedError(error)');
    expect(chatInputSource).toContain('optimisticComposerRestored = true;');
    expect(chatInputSource).toContain('isRemoteOptimisticComposerTransitionActive(');
    expect(chatInputSource).toContain('updateLive: !isDataOwnerBoundary');
    expect(chatInputSource).toContain('recoveryBatch: error as object');
    expect(chatInputSource).toContain('recoveryBatch ? { recoveryBatch } : undefined');
    expect(chatInputSource).toContain('if (!updateLive || !isCurrentComposer) return;');
    expect(chatInputSource).toContain('if (!isDataOwnerGenerationCurrent(dataOwnerAtEffect))');
    expect(chatInputSource).toContain(
      'if (!isDataOwnerGenerationCurrent(dataOwnerAtSubscription)) return;',
    );
    expect(chatInputSource).toContain('browserCommentsRef.current = nextBrowserComments;');
    expect(chatInputSource).toContain('browserCommentsRef.current = restoredComments;');
    expect(chatInputSource).not.toContain('mergeComposerDocumentsForRestore(');
  });

  it('reuses the original voice-session recovery checkpoint until the editor owner switches', () => {
    expect(chatInputSource).toContain('useRef<RemoteOptimisticTransitionCheckpoint | null>(null)');
    expect(chatInputSource).toContain('getOrCreateRemoteOptimisticTransitionCheckpoint(');
    expect(chatInputSource).toContain('saveComposerTextAfterAsyncTransition(');
    expect(chatInputSource).toContain('recoveryCheckpoint!');
    expect(chatInputSource).toContain('if (pendingStopAndSend || voiceInputBusyRef.current)');
    expect(chatInputSource).toContain('}, [editor, storageKey]);');
    expect(chatInputSource).not.toContain('}, [editor, storageKey, voiceInput.isBusy]);');
    expect(chatInputSource.match(/storageKeyTransitionRecoveryRef\.current = null;/g)).toHaveLength(
      2,
    );
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
    // Ranking runs over the (searched) installed set, not the raw ghost list, and feeds
    // recent-use + unread signals into the shared pure sorter.
    expect(pluginPageSource).toMatch(/sortInstalledForDisplay\(searchedInstalledItems, \{/);
    expect(pluginPageSource).toContain('recentIds: recentGhostIds');
    expect(pluginPageSource).not.toContain('sortInstalledForDisplay(ghosts');
    expect(pluginPageSource).not.toContain('sortInstalledForDisplay(installedItems');
  });
});

function extractBetween(sourceBlock: string, startNeedle: string, endNeedle: string): string {
  const start = sourceBlock.indexOf(startNeedle);
  const end = sourceBlock.indexOf(endNeedle, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return sourceBlock.slice(start, end);
}
