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

  it('does not register a memory-only pending payload for ordinary local text', () => {
    const localSend = source.indexOf('const sendPromise = makerChatStore.sendMessage(', localFence);
    const pendingAfterSend = source.indexOf('setPending(newSession.id', localSend);
    expect(source).toContain('setPending(remoteSessionId, {');
    expect(pendingSource).toContain('本机新建不走这里:草稿路由 createSession 后直接 sendMessage');
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
    expect(catchRestore).toBeGreaterThan(fifoRestore);
    expect(falseRestore).toBeGreaterThan(fifoRestore);
    expect(falseRestore).not.toBe(catchRestore);
  });

  it('dispatches local /review from the draft route and keeps other desktop commands on SessionView', () => {
    const reviewStart = source.indexOf('window.electronAPI.maker.startReview({', localFence);
    const desktopPending = source.indexOf(
      "if (hit?.kind === 'desktop') {",
      localFence,
    );
    const pendingHandoff = source.indexOf('setPending(newSession.id, {', desktopPending);

    expect(reviewStart).toBeGreaterThan(localFence);
    expect(desktopPending).toBeGreaterThan(localFence);
    expect(pendingHandoff).toBeGreaterThan(desktopPending);
    expect(sessionViewSource).toContain('const pending = consumePending(sessionId);');
    expect(sessionViewSource).toContain('本机新建已在');
  });
});
