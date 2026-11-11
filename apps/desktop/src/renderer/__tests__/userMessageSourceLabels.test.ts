import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Privacy contract (engineering-conventions §3.2): shareConversationImage tests
// strip a hand-built DOM, and MessageSourceLabels tests only its child component.
// Neither catches UserMessage dropping the actual author/plugin stripping marks.
// Keep these two cross-file contracts in required guard, separate from jsdom
// behavior tests. Minimal regression: remove either mark and exported shares
// expose a shared-task identity or retain a plugin-only bubble.
const source = fs.readFileSync(
  path.resolve(__dirname, '../components/chat/UserMessage.tsx'),
  'utf8',
);

describe('UserMessage share-image privacy boundary', () => {
  it('marks the shared-task author line for stripping from share images', () => {
    expect(source).toMatch(
      /\{sharedAuthorName && \(\s*<span\s+\{\.\.\.\{ \[SHARE_SOURCE_ATTR\]: '' \}\}/,
    );
  });

  // A teammate DM bubble that also holds attachments is content, not an annotation;
  // HookTaskCard.test.tsx covers that share-image path through the real component.
  it('marks a bubble containing only a plugin annotation for stripping', () => {
    expect(source).toMatch(
      /\{\.\.\.\(inlineQuoteCount === 0 && !displayBubbleBody\.trim\(\) && !attachmentsInBubble\s*\? \{ \[SHARE_SOURCE_ATTR\]: '' \}\s*: \{\}\)\}/,
    );
  });
});
