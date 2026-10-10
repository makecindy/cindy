import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const userMessageSource = fs.readFileSync(
  path.resolve(__dirname, '../components/chat/UserMessage.tsx'),
  'utf8',
);

describe('UserMessage source labels', () => {
  it('renders every source label through MessageSourceLabels (one share-stripped slot)', () => {
    expect(userMessageSource).not.toContain('<AutomationOriginBadge');
    expect(userMessageSource.match(/<MessageSourceLabels\b/g)).toHaveLength(3);
  });

  it('never shows the automation label inside the hook card branch', () => {
    const hookBranch = userMessageSource.indexOf(') : hookSource && !editing ? (');
    const ordinaryBranch = userMessageSource.indexOf(') : (', hookBranch + 1);
    const hookBody = userMessageSource.slice(hookBranch, ordinaryBranch);
    expect(hookBody).toContain('<MessageSourceLabels');
    expect(hookBody).not.toContain('automationOrigin=');
    // 编辑态 / 缺 hookSource 时走普通分支：标签仍按渠道显示。
    expect(userMessageSource.slice(ordinaryBranch)).toContain('hookIm={hookSource?.im}');
  });

  it('marks the shared-task author line as a share-image source', () => {
    expect(userMessageSource).toMatch(
      /\{sharedAuthorName && \(\s*<span\s+\{\.\.\.\{ \[SHARE_SOURCE_ATTR\]: '' \}\}/,
    );
  });

  it('shows the shared-task member id on hover, like the other source labels', () => {
    expect(userMessageSource).toContain(
      "t('chat.userMessage.sourceIds.member', { id: sharedAuthorMemberId })",
    );
  });

  it('names the Worker role in the Orca card title when the host recorded it', () => {
    expect(userMessageSource).toContain(
      "t('chat.userMessage.orcaFromWorkerNamed', { role: orcaWorkerRole })",
    );
    expect(userMessageSource).toContain("t('chat.userMessage.orcaFromLead')");
  });

  it('keeps the 3-line automation collapse for real automations only', () => {
    expect(userMessageSource).toContain(
      'const isScheduledAutomation = isRealAutomationOrigin(automationOrigin);',
    );
  });
});
