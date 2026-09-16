import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const composer = readFileSync(resolve(__dirname, '../components/new-chat/ChatInput.tsx'), 'utf8');

describe('Cindy Make composer presentation', () => {
  it('has no modal state or overlay for the preparation workflow', () => {
    expect(composer).not.toContain('CindyMakeCommandDialog');
    expect(composer).not.toContain('makeDialogSessionId');
  });

  it('navigates only a newly created container and retains the existing task route', () => {
    const start = composer.indexOf("if (makeResult.kind === 'started')");
    expect(start).toBeGreaterThan(-1);
    const accepted = composer.slice(start, composer.indexOf('\n        }', start));
    expect(accepted).toContain('clearComposerDraft(sourceStorageKey)');
    expect(accepted).toMatch(
      /if\s*\(makeResult\.sessionId !== sourceSessionId\)\s*\{\s*navigate\('\/cc-agent\/' \+ makeResult\.sessionId\);\s*\}/,
    );
    expect(
      composer.indexOf("if (!isMakeSourceCurrent() || makeResult.kind === 'stale') return;"),
    ).toBeLessThan(start);
  });
});
