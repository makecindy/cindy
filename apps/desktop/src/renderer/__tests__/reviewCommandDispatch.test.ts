import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const sessionViewSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'CCAgentSessionView.tsx'),
  'utf8',
).replace(/\r\n/g, '\n');
const dispatchStart = sessionViewSource.indexOf('const maybeDispatchDesktopSlashCommand');
const dispatchEnd = sessionViewSource.indexOf('const maybeShowContextUsage', dispatchStart);
const dispatchSource = sessionViewSource.slice(dispatchStart, dispatchEnd);
const handleSendStart = sessionViewSource.indexOf('const handleSend = useCallback');
const handleSendEnd = sessionViewSource.indexOf('const handleStopSession', handleSendStart);
const handleSendSource = sessionViewSource.slice(handleSendStart, handleSendEnd);

describe('/review command dispatch', () => {
  it('crosses the Main boundary with this invocation attachment snapshot before returning', () => {
    expect(dispatchSource).toContain("if (hit.name === 'review')");
    expect(dispatchSource).toContain('serializeAttachedFiles(files)');
    expect(dispatchSource).toContain('.startReview({');
    expect(dispatchSource).toContain('await window.electronAPI.maker.startReview({');
    expect(dispatchSource).toContain('return { handled: true, accepted: true, message }');
    expect(dispatchSource).toContain('return { handled: true, accepted: false, message }');
    expect(sessionViewSource).toContain('if (slashDispatch.handled) {');
    expect(sessionViewSource).toContain('waitForLeadHistory: false');
    expect(dispatchSource.indexOf('.startReview({')).toBeLessThan(
      dispatchSource.indexOf('void dispatchCommand(hit'),
    );
  });

  it('does not hand Review attachments through a shared mutable ref or renderer event', () => {
    expect(sessionViewSource).not.toContain('pendingReviewFilesRef');
    expect(sessionViewSource).not.toContain("payload.command !== 'review'");
  });

  it('does not surface coded Main Review failures as untranslated internal messages', () => {
    expect(dispatchSource).toMatch(/ipcError\s+\? t\('review\.toast\.failed'\)/);
    expect(dispatchSource).not.toContain('ipcError?.message ||');
  });

  it('restores a rejected pending first Review with both text and attachments', () => {
    expect(sessionViewSource).toContain('if (!slashDispatch.accepted)');
    expect(sessionViewSource).toContain('restoreRemoteOptimisticDraft(sessionId, {');
    expect(sessionViewSource).toContain('text: plainTextToTiptapDoc(pending.text)');
    expect(sessionViewSource).toContain('attachments: pending.files ?? []');
  });

  it('consumes the handoff copy after a rejected Review is restored to the composer', () => {
    const pendingReviewBranch = sessionViewSource.slice(
      sessionViewSource.indexOf(
        'if (slashDispatch.handled) {',
        sessionViewSource.indexOf('const pending = consumePending(sessionId);'),
      ),
      sessionViewSource.indexOf(
        'const pendingAgentReferences',
        sessionViewSource.indexOf('const pending = consumePending(sessionId);'),
      ),
    );

    expect(pendingReviewBranch).toContain('restoreRemoteOptimisticDraft(sessionId, {');
    expect(pendingReviewBranch).toContain(
      'await deliverRecoverableHandoff(sessionId, () => true);',
    );
    expect(pendingReviewBranch).not.toContain('() => slashDispatch.accepted');
  });

  it('only clears a deferred composer after Main accepts the Review', () => {
    expect(dispatchSource).toContain('if (slashDispatch.accepted) {');
    expect(dispatchSource).toContain('pending.onDeferredAccepted?.();');
    expect(dispatchSource).toContain('waitForLeadHistory: false');
  });

  it('re-consumes an accepted desktop command without overwriting newer input', () => {
    expect(handleSendSource).toMatch(
      /if \(slashDispatch\.handled\) \{\s+if \(slashDispatch\.accepted\) \{\s+\/\/ Desktop commands[\s\S]*?opts\?\.onDeferredAccepted\?\.\(\);/,
    );
    expect(handleSendSource.indexOf('opts?.onDeferredAccepted?.();')).toBeLessThan(
      handleSendSource.indexOf('return slashDispatch.accepted;'),
    );
  });
});
