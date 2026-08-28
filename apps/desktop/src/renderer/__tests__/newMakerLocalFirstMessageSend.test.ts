import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const source = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'NewMakerDraftRoute.tsx'),
  'utf8',
);

const pendingSource = readFileSync(
  resolve(__dirname, '..', 'state', 'pendingFirstMessage.ts'),
  'utf8',
);

const sessionViewSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'CCAgentSessionView.tsx'),
  'utf8',
);

describe('NewMakerDraftRoute local first-message send', () => {
  const localFence = source.indexOf(
    '本机首条消息在草稿路由发出,不把发送绑在 SessionView hydrate 上。',
  );

  it('sends the local first message from the draft route before navigating', () => {
    const sendMessage = source.indexOf(
      'const sendPromise = makerChatStore.sendMessage(',
      localFence,
    );
    const navigate = source.indexOf('navigateToSession();', sendMessage);

    expect(localFence).toBeGreaterThan(-1);
    expect(sendMessage).toBeGreaterThan(localFence);
    expect(navigate).toBeGreaterThan(sendMessage);
  });

  it('seeds remoteHostId into chat store before the draft-route first send', () => {
    const seed = source.indexOf(
      'makerChatStore.setSessionRuntime(newSession.id, {',
      source.indexOf("workspaceKind: workingDir ? 'project' : 'dialogue'"),
    );
    const seedBlock = source.slice(seed, source.indexOf('});', seed) + 3);

    expect(seed).toBeGreaterThan(-1);
    expect(seed).toBeLessThan(localFence);
    expect(seedBlock).toContain('remoteHostId: workingDir ? (effectiveRemoteHostId ?? null) : null');
  });

  it('does not register a memory-only pending payload for ordinary local text', () => {
    const localSend = source.indexOf('const sendPromise = makerChatStore.sendMessage(', localFence);
    const pendingAfterSend = source.indexOf('setPending(newSession.id', localSend);
    expect(source).toContain('setPending(remoteSessionId, {');
    expect(pendingSource).toContain(
      '本机新建的普通文本不走这里:草稿路由 createSession 后直接 sendMessage',
    );
    expect(pendingAfterSend).toBe(-1);
  });

  it('restores a rejected or thrown first send onto the created task without clobbering newer input', () => {
    const localSend = source.indexOf('const sendWorkingDir = workingDir ?? newSession.workingDir;');
    const restore = source.indexOf('const restoreFirstMessageDraft = () => {', localSend);
    const fifoRestore = source.indexOf('restoreRemoteOptimisticDraft(newSession.id, {', restore);
    const saveDraft = source.indexOf('saveComposerDraft(newSession.id, {', restore);
    const catchRestore = source.indexOf(
      'restoreFirstMessageDraft();',
      source.indexOf("log.error('[draft send]', err);", localFence),
    );
    const falseRestore = source.indexOf(
      'restoreFirstMessageDraft();',
      source.indexOf('} else {', source.indexOf('(accepted) => {', localFence)),
    );

    expect(restore).toBeGreaterThan(localSend);
    expect(fifoRestore).toBeGreaterThan(restore);
    expect(fifoRestore).toBeLessThan(catchRestore);
    expect(saveDraft).toBe(-1);
    expect(source.slice(localSend, fifoRestore)).toContain(
      'rewriteBrowserCommentsFromRehomedFiles(',
    );
    expect(source.slice(fifoRestore, catchRestore)).toContain(
      'excludeCommentScreenshots(rehydratedFiles, preNavBrowserComments)',
    );
    expect(source.slice(fifoRestore, catchRestore)).toContain(
      'browserComments: preNavBrowserComments',
    );
    expect(source.slice(fifoRestore, catchRestore)).not.toContain('browserComments: []');
    expect(catchRestore).toBeGreaterThan(fifoRestore);
    expect(falseRestore).toBeGreaterThan(fifoRestore);
    expect(falseRestore).not.toBe(catchRestore);
  });

  it('hands slash-looking first messages to SessionView instead of copying desktop dispatch', () => {
    const slashMatch = source.indexOf('const slashMatch = message.match(', localFence);
    const leading = source.indexOf('leadingSlashInvocation(message)', slashMatch);
    const pendingHandoff = source.indexOf('setPending(newSession.id, {', slashMatch);
    const sendPromise = source.indexOf(
      'const sendPromise = makerChatStore.sendMessage(',
      localFence,
    );
    const reviewStart = source.indexOf('window.electronAPI.maker.startReview({', localFence);

    expect(slashMatch).toBeGreaterThan(localFence);
    expect(leading).toBeGreaterThan(slashMatch);
    expect(leading).toBeLessThan(pendingHandoff);
    expect(pendingHandoff).toBeGreaterThan(slashMatch);
    expect(pendingHandoff).toBeLessThan(sendPromise);
    expect(reviewStart).toBe(-1);
    expect(source.slice(slashMatch, pendingHandoff)).toContain("capabilityAgentKind === 'pi'");
    expect(sessionViewSource).toContain('const pending = consumePending(sessionId);');
    expect(sessionViewSource).toContain('maybeDispatchDesktopSlashCommand');
    expect(sessionViewSource).toContain('leadingSlashInvocation(message)');
    expect(sessionViewSource).toContain('本机普通文本已在草稿路由发出');
  });
});
