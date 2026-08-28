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
    const pendingHandoff = source.indexOf('setPending(newSession.id', localFence);

    expect(localFence).toBeGreaterThan(-1);
    expect(sendMessage).toBeGreaterThan(localFence);
    expect(navigate).toBeGreaterThan(sendMessage);
    expect(pendingHandoff).toBe(-1);
  });

  it('does not register a memory-only pending payload for local new tasks', () => {
    expect(source).toContain('setPending(remoteSessionId, {');
    expect(source).not.toContain('setPending(newSession.id');
    expect(pendingSource).toContain('本机新建不走这里:草稿路由 createSession 后直接 sendMessage');
  });

  it('restores the first-message draft onto the created task if send throws', () => {
    const localSend = source.indexOf('const sendWorkingDir = workingDir ?? newSession.workingDir;');
    const restore = source.indexOf('const restoreFirstMessageDraft = () => {', localSend);
    const saveDraft = source.indexOf('saveComposerDraft(newSession.id, {', restore);
    const catchRestore = source.indexOf(
      'restoreFirstMessageDraft();',
      source.indexOf("log.error('[draft send]', err);", localFence),
    );

    expect(restore).toBeGreaterThan(localSend);
    expect(saveDraft).toBeGreaterThan(restore);
    expect(catchRestore).toBeGreaterThan(saveDraft);
  });

  it('keeps remote delayed-create consumption on SessionView', () => {
    expect(sessionViewSource).toContain('const pending = consumePending(sessionId);');
    expect(sessionViewSource).toContain('本机新建已在');
  });
});
