import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const chatInputSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/components/new-chat/ChatInput.tsx'),
  'utf8',
).replace(/\r\n?/g, '\n');

describe('effort runtime send guard', () => {
  it('only locks composer mutations during the bounded effort preflight', () => {
    expect(chatInputSource).toContain(
      'const composerEditorLocked = disabled || sendDispatchInFlight;',
    );
    expect(chatInputSource).toContain(
      'const composerMutationLocked = composerEditorLocked || voiceBusyOnCurrentComposer;',
    );
    expect(chatInputSource).toContain('editable: !composerEditorLocked');
    expect(chatInputSource).toContain('if (composerMutationLockedRef.current) return true;');
    expect(chatInputSource).toContain("trigger.kind !== 'slash' || composerMutationLockedRef.current");
    expect(chatInputSource).toContain('if (composerMutationLocked) return;');
    expect(chatInputSource).toContain("id: 'attach-files'");
    expect(chatInputSource).toContain(
      'disabled: composerMutationLocked,\n        run: () => suggestionFileInputRef.current?.click(),',
    );
    expect(chatInputSource).toContain('ref={suggestionFileInputRef}');
    expect(chatInputSource).toContain('disabled={composerMutationLocked}');
    expect(chatInputSource).toContain('setSendDispatchInFlight(true);');
    expect(chatInputSource).toContain('setSendDispatchInFlight(false);');
    expect(chatInputSource).not.toContain('coordinator.markRuntimeDirty(sessionId)');
  });
});
