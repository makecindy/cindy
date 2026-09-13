import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const userMessageSource = fs.readFileSync(
  path.resolve(__dirname, '../components/chat/UserMessage.tsx'),
  'utf8',
);

describe('Cindy hook source attachments', () => {
  it('places the shared attachment nodes in both the hook and ordinary message branches', () => {
    const hookBranch = userMessageSource.indexOf(') : hookSource && !editing ? (');
    expect(hookBranch).toBeGreaterThan(0);
    const ordinaryBranch = userMessageSource.indexOf(') : (', hookBranch + 1);
    const hookImages = userMessageSource.indexOf('{imageAttachmentNodes}', hookBranch);
    const hookFiles = userMessageSource.indexOf('{fileAttachmentNodes}', hookImages);
    const ordinaryImages = userMessageSource.indexOf('{imageAttachmentNodes}', ordinaryBranch);
    const ordinaryFiles = userMessageSource.indexOf('{fileAttachmentNodes}', ordinaryImages);

    expect(hookImages).toBeGreaterThan(hookBranch);
    expect(hookFiles).toBeGreaterThan(hookImages);
    expect(ordinaryImages).toBeGreaterThan(ordinaryBranch);
    expect(ordinaryFiles).toBeGreaterThan(ordinaryImages);
  });

  it('keeps a single shared file renderer so hook cards cannot silently hide attachments', () => {
    expect(userMessageSource.match(/files\.map\(\(f, idx\) =>/g)).toHaveLength(1);
    expect(userMessageSource.match(/\{fileAttachmentNodes\}/g)).toHaveLength(2);
  });

  it('shares the existing action bar with clean IM content and keeps the edit box reachable', () => {
    const hookBranch = userMessageSource.indexOf(') : hookSource && !editing ? (');
    const ordinaryBranch = userMessageSource.indexOf(') : (', hookBranch + 1);
    const hookBody = userMessageSource.slice(hookBranch, ordinaryBranch);
    expect(userMessageSource.match(/<MessageActionBar\b/g)).toHaveLength(1);
    expect(hookBody).toContain('{!hasEmbeddedImPrompt(hookSource) && messageActions}');
    expect(userMessageSource.slice(ordinaryBranch)).toContain('{messageActions}');
    expect(userMessageSource.slice(ordinaryBranch)).toContain('<UserMessageEditBox');
    expect(userMessageSource).toContain('onEdit={canEdit ? handleEdit : undefined}');
    expect(userMessageSource).toContain('onRewind={!isBlocked && canRewind ? handleRewind : undefined}');
    expect(userMessageSource).toContain('onFork={!isBlocked && canFork ? handleFork : undefined}');
  });
});
