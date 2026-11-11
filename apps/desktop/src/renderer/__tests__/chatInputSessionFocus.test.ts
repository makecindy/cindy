import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { WORKLOUDER_CREATOR_LIT_TASK_KEY_COUNT } from '../../shared/workLouderCodex';

const chatInputSource = readFileSync(
  resolve(__dirname, '..', 'components', 'new-chat', 'ChatInput.tsx'),
  'utf8',
).replace(/\r\n?/g, '\n');

const sessionViewSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'CCAgentSessionView.tsx'),
  'utf8',
).replace(/\r\n?/g, '\n');

const messageStreamSource = readFileSync(
  resolve(__dirname, '..', 'components', 'chat', 'MessageStream.tsx'),
  'utf8',
).replace(/\r\n?/g, '\n');

const mainLayoutSource = readFileSync(
  resolve(__dirname, '..', 'components', 'layout', 'MainLayout.tsx'),
  'utf8',
).replace(/\r\n?/g, '\n');

const newMakerDraftRouteSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'NewMakerDraftRoute.tsx'),
  'utf8',
).replace(/\r\n?/g, '\n');

const sidebarUpperSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'CCAgentSidebarUpper.tsx'),
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
    expect(sessionViewSource).toContain('focusOnStorageKeyChange={ownsRoute || focusComposerOnOpen}');
    expect(sessionViewSource).toContain(
      'ownsHardwareComposerActions={ownsHardwareTaskActions && !voiceModeOpen}',
    );
    expect(chatInputSource).toContain('workLouderVoiceGestureRef.current?.cancelHeldPress();');
    expect(sessionViewSource).toContain(
      'ownsHardwareScrollActions={ownsHardwareTaskActions}',
    );
    expect(sessionViewSource).toContain("navigationMode !== 'split-pane'");
    expect(sessionViewSource).toContain("action.commandId === 'toggleTaskPin'");
    expect(sessionViewSource).toContain("action.commandId === 'archiveTask'");
    expect(sessionViewSource).toContain('void togglePin();');
    expect(sessionViewSource).toContain('void archive();');
    expect(messageStreamSource).toContain('ownsHardwareScrollActions?: boolean;');
    expect(messageStreamSource).toContain('if (!ownsHardwareScrollActions) return false;');
    expect(mainLayoutSource).toContain("const reviewTab = bucket.tabs.find((tab) => tab.kind === 'review');");
    expect(mainLayoutSource).toContain("routeSidebarCommand({ type: 'toggle-review-tab', sessionId })");
    expect(mainLayoutSource).toContain('if (reviewIsActive && reviewTab) {');
    expect(mainLayoutSource).toContain('await closeTab(sessionId, reviewTab.id);');
    expect(mainLayoutSource).toContain(
      "navigate('/cc-agent/new', { state: makeFolderPickerNewMakerRouteState() })",
    );
    expect(newMakerDraftRouteSource).toContain('readNewMakerFolderPickerRequest(location.state)');
    expect(newMakerDraftRouteSource).toContain('setFolderPickerOpen(true)');
    expect(sidebarUpperSource).toContain('catalogEligible: false');
    expect(sidebarUpperSource).toContain(
      'const remainingCatalogSlots = Math.max(0, 100 - visibleProjection.length);',
    );
    expect(sidebarUpperSource).toContain('WORKLOUDER_CREATOR_LIT_TASK_KEY_COUNT');
    expect(sidebarUpperSource).toContain('.slice(0, WORKLOUDER_CREATOR_LIT_TASK_KEY_COUNT)');
    expect(sidebarUpperSource).not.toContain(
      '[...visibleSessionsWithRemote, ...remoteProjectSessions]',
    );
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
      '// Local/SSH lock the live composer only while the click-time document',
      'try {\n        let serializedContent',
    );

    expect(chatInputSource).toContain(
      'const captureSendFocusForRestore = useComposerSendFocusRestore(',
    );
    const focusRestoreCall = extractBetween(
      chatInputSource,
      'const captureSendFocusForRestore = useComposerSendFocusRestore(',
      'const { settings: voiceInputSettings }',
    );
    expect(focusRestoreCall).toContain('composerTypingLocked');
    expect(focusRestoreCall).not.toContain('composerMutationLocked');
    expect(focusRestoreCall).not.toContain('sendDispatchInFlight');
    expect(localSendLockBlock).toContain('captureSendFocusForRestore();');
    expect(localSendLockBlock.indexOf('captureSendFocusForRestore();')).toBeLessThan(
      localSendLockBlock.indexOf('setSendDispatchInFlight(true);'),
    );
  });

  it('reuses composer entry paths for Plugin commands', () => {
    const capabilitySelectionBlock = extractBetween(
      chatInputSource,
      'const insertAtResource = useCallback(',
      'const handleComposerSuggestionSelect = useCallback(',
    );

    expect(pluginPageSource).toContain('pendingGhostId: installedGhostStoragePart(ghost)');
    expect(pluginPageSource.match(/focusAtEnd: true/g)).toHaveLength(1);
    expect(
      chatInputSource.match(/placeGhostAtComposerStart\(editor, ghost, ghostsForCommand\)/g),
    ).toHaveLength(1);
    expect(
      chatInputSource.match(
        /placeGhostAtComposerStart\(editor, ghost, composerGhostsRef\.current\)/g,
      ),
    ).toHaveLength(1);
    expect(chatInputSource).toContain('pendingGhostId: undefined');

    expect(capabilitySelectionBlock).toContain("selectedItem.type === 'plugin-command'");
    expect(capabilitySelectionBlock).toContain('!ghost?.enabled');
    expect(capabilitySelectionBlock).toContain('findInstalledGhostByInstanceId(');
    expect(capabilitySelectionBlock).toContain('composerGhostsRef.current,');
    expect(capabilitySelectionBlock).toContain(
      'placeGhostAtComposerStart(editor, ghost, composerGhostsRef.current);',
    );
    expect(capabilitySelectionBlock).toContain('closeAtPanel();');
    expect(capabilitySelectionBlock).not.toContain('focusIOSSimulatorPanel');
    expect(chatInputSource).toContain('focusComposerEndNextFrame(editor);');
  });

  it('records recent Plugin usage only after a successful direct or deferred send', () => {
    const successfulSendBlock = extractBetween(
      chatInputSource,
      'if (result === false) {',
      'finishAgentSendDispatch();',
    );
    const worktreeSendBlock = extractBetween(
      newMakerDraftRouteSource,
      'const accepted = await makerChatStore.sendMessage(',
      'worktreeCreationStore.clear(newSession.id);',
    );

    expect(chatInputSource).toContain('findGhostByCommand(eligibleGhosts, ghostCommandToken.word, ghostCommandToken.namespace)');
    expect(chatInputSource).toContain('onAccepted: markRecentPluginUsage');
    expect(successfulSendBlock).toContain('markRecentPluginUsage();');
    // 本机首条 / worktree 首条 / 远程普通首条直接发送 / 远程视图交接 四处受理点。
    expect(newMakerDraftRouteSource.match(/opts\?\.onAccepted\?\.\(\);/g)).toHaveLength(4);
    expect(worktreeSendBlock).toContain('if (accepted) {');
    expect(worktreeSendBlock).toContain('opts?.onAccepted?.();');
    expect(worktreeSendBlock).toContain(
      'dispatchDeferredUiAssignment(newSession.id, deferredUiAssignment)',
    );
  });

  it('clears the live composer before awaiting local or remote send', () => {
    const optimisticClear = chatInputSource.indexOf(
      '// Click-time composer must disappear before any await that can surface',
    );
    const clearCall = chatInputSource.indexOf('clearSentComposer();', optimisticClear);
    const onSend = chatInputSource.indexOf('result = await onSend(', optimisticClear);
    const failedRestore = chatInputSource.indexOf('restoreRemoteComposerAndRelease();', onSend);

    expect(optimisticClear).toBeGreaterThanOrEqual(0);
    expect(clearCall).toBeGreaterThan(optimisticClear);
    expect(onSend).toBeGreaterThan(clearCall);
    expect(failedRestore).toBeGreaterThan(onSend);
    expect(chatInputSource).not.toContain(
      'if (!optimisticallyClearRemoteComposer) clearSentComposer();',
    );
  });

  it('keeps send and settings locked after optimistic clear while allowing typing', () => {
    const unlockAfterClear = extractBetween(
      chatInputSource,
      '// Click-time composer must disappear before any await that can surface',
      'result = await onSend(',
    );
    expect(unlockAfterClear).toContain('dispatchSendClearedKeysRef.current.add(sendInFlightKey);');
    expect(unlockAfterClear).toContain('setAllowTypeDuringSend(true);');
    expect(unlockAfterClear.indexOf('dispatchSendClearedKeysRef.current.add(sendInFlightKey);')).toBeLessThan(
      unlockAfterClear.indexOf('setAllowTypeDuringSend(true);'),
    );
    expect(unlockAfterClear).not.toContain('setSendDispatchInFlight(false);');
    expect(chatInputSource).toContain(
      'disabled || waitingForFolders || (sendDispatchInFlight && !allowTypeDuringSend)',
    );
    expect(chatInputSource).toContain('sendDispatchInFlight ||');
    expect(chatInputSource).toContain('setSendDispatchInFlight(nextSendInFlight);');
    expect(chatInputSource).toContain(
      'setAllowTypeDuringSend(nextSendInFlight && nextSendCleared);',
    );
    expect(chatInputSource).toContain(
      'documentBeforeOptimisticClear = plainTextToComposerDocument(serializedContent.text);',
    );
    const settleLockBlock = extractBetween(
      chatInputSource,
      'dispatchSendInFlightKeysRef.current.delete(sendInFlightKey);',
      'finishAgentSendDispatch();',
    );
    expect(settleLockBlock).toContain(
      'dispatchSendClearedKeysRef.current.delete(sendInFlightKey);',
    );
    expect(settleLockBlock).toContain(
      'storageKeyForDraftRef.current === sourceStorageKey',
    );
    expect(settleLockBlock).toContain('setAllowTypeDuringSend(false);');
    expect(settleLockBlock.indexOf('storageKeyForDraftRef.current === sourceStorageKey')).toBeLessThan(
      settleLockBlock.indexOf('setAllowTypeDuringSend(false);'),
    );
  });

  it('snapshots the source restore payload instead of a reused destination editor', () => {
    const snapshotBlock = extractBetween(
      chatInputSource,
      'const editorOwnsSourceAtStart = editorOwnsSourceDraft({',
      'const dataOwnerAtOptimisticClear = getDataOwnerGeneration();',
    );

    expect(snapshotBlock).toContain(
      'optimisticallyClearRemoteComposer && editorOwnsSourceAtStart',
    );
    expect(snapshotBlock).toContain('getComposerDraft(sourceStorageKey)');
    expect(snapshotBlock).toContain('frozenVoiceSendRef.current?.sourceStorageKey === sourceStorageKey');
    expect(snapshotBlock).toContain('editorOwnsSourceAtStart\n        ? editor.getJSON()');
    expect(snapshotBlock.indexOf('editorOwnsSourceAtStart')).toBeLessThan(
      snapshotBlock.indexOf('editor.getJSON()'),
    );
  });

  it('refreshes the local restore snapshot only while the editor still owns the source draft', () => {
    const refreshBlock = extractBetween(
      chatInputSource,
      'const sendSnapshot = captureComposerSendSnapshot(',
      'let recentUsageMarked = false;',
    );

    expect(refreshBlock).toContain('!optimisticallyClearRemoteComposer');
    expect(refreshBlock).toContain('editorOwnsSourceDraft({');
    expect(refreshBlock).toContain('documentBeforeOptimisticClear = editor.getJSON();');
    expect(refreshBlock.indexOf('editorOwnsSourceDraft({')).toBeLessThan(
      refreshBlock.indexOf('documentBeforeOptimisticClear = editor.getJSON();'),
    );
  });

  it('optimistically clears device-link composer state before awaiting send and restores without dropping newer input', () => {
    const transitionBegin = chatInputSource.indexOf(
      'makerChatStore.beginRemoteOptimisticComposerTransition(',
    );
    const optimisticClear = chatInputSource.indexOf(
      '// Click-time composer must disappear before any await that can surface',
    );
    const frozenReferenceHydration = chatInputSource.search(
      /agentReferences\s*=\s*await resolveSerializedSessionMessageReferencesForSend\(agentReferences\);/,
    );
    const onSend = chatInputSource.indexOf('result = await onSend(', optimisticClear);
    const failedRestore = chatInputSource.indexOf('restoreRemoteComposerAndRelease();', onSend);
    const restoreAndReleaseBlock = extractBetween(
      chatInputSource,
      'const restoreRemoteComposerAndRelease = () => {',
      '// Click-time composer must disappear before any await that can surface',
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
      'latestStorageKeyRef.current === sourceStorageKey && editorOwnsSource',
    );
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
    expect(chatInputSource).toContain('if (!isDataOwnerIdCurrent(dataOwnerAtEffect))');
    expect(chatInputSource).toContain(
      'if (!isDataOwnerIdCurrent(dataOwnerAtSubscription)) return;',
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
    expect(chatInputSource).toContain(
      'if ((pendingStopAndSend || voiceInputBusyRef.current) && prevEditorKey && voiceOwnerKey)',
    );
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

it.each([
  [100, 36, 0, '', 64, 36],
  [100, 10, 0, '', 90, 10],
  [10, 100, 0, '', 10, 90],
  [120, 0, 0, '', 100, 0],
  [0, 120, 0, '', 0, 100],
  [100, 36, 13, '', 51, 36],
  [100, 36, 0, 'local-70', 64, 36],
  [100, 37, 0, 'duplicate-id', 64, 36],
  [100, 36, 0, 'duplicate-first', 65, 35],
] as const)(
  'publishes keyboard candidates for %i local / %i remote / %i archived / %s',
  (local, remote, archived, special, expectedLocal, expectedRemote) => {
    const makeRows = (count: number, prefix: string, status = 'active') =>
      Array.from({ length: count }, (_, index) => ({
        id: `${prefix}-${index}`,
        title: `${prefix}-${index}`,
        status,
        deviceLinkDeviceId: prefix === 'remote' ? 'other-device' : undefined,
      }));
    const remoteRows = makeRows(remote, 'remote');
    if (special === 'duplicate-id') remoteRows[remoteRows.length - 1].id = 'local-0';
    if (special === 'duplicate-first') remoteRows[0].id = 'local-0';
    const visible = makeRows(archived, 'archived', 'archived');
    const publishTasks = vi.fn().mockResolvedValue(undefined);
    // 编译并执行真实发布回调，隔离侧栏组件依赖，检查实际传给 publishTasks 的载荷。
    const callback = extractBetween(
      sidebarUpperSource,
      'const publishSidebarTasks = useCallback(',
      '  useEffect(() => {',
    );
    runInNewContext(
      ts.transpileModule(`${callback}\npublishSidebarTasks();`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      }).outputText,
      {
        sessionsWithRemote: [...makeRows(local, 'local'), ...remoteRows, ...visible],
        visibleSessionsWithRemote: visible,
        getVisibleSidebarSessionIds: () =>
          special === 'duplicate-first'
            ? makeRows(13, 'local').map((row) => row.id)
            : special.startsWith('local-')
              ? [special]
              : visible.map((row) => row.id),
        isSecondaryWindow: () => false,
        useCallback: (publish: () => void) => publish,
        publishedTaskKeyRef: { current: '' },
        WORKLOUDER_CREATOR_LIT_TASK_KEY_COUNT,
        window: { electronAPI: { workLouderCodex: { publishTasks } } },
      },
    );
    const rows = publishTasks.mock.calls[0][0] as Array<{
      id: string;
      title: string;
      sidebarOrder?: number;
    }>;
    expect(rows).toHaveLength(100);
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
    expect(rows.filter((row) => row.title.startsWith('local-'))).toHaveLength(expectedLocal);
    expect(rows.filter((row) => row.title.startsWith('remote-'))).toHaveLength(expectedRemote);
    if (special.startsWith('local-')) {
      expect(rows.find((row) => row.id === special)?.sidebarOrder).toBe(0);
    }
  },
);

function extractBetween(sourceBlock: string, startNeedle: string, endNeedle: string): string {
  const start = sourceBlock.indexOf(startNeedle);
  const end = sourceBlock.indexOf(endNeedle, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return sourceBlock.slice(start, end);
}
