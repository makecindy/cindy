import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const routeSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'NewMakerDraftRoute.tsx'),
  'utf8',
);
const quickStartsSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'NewMakerQuickStarts.tsx'),
  'utf8',
);
const sessionViewSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'CCAgentSessionView.tsx'),
  'utf8',
);
const zhLocale = JSON.parse(
  readFileSync(resolve(__dirname, '..', 'i18n', 'locales', 'zh-CN', 'common.json'), 'utf8'),
) as {
  newChat: {
    createAgent: {
      quickStarts: Record<string, unknown>;
    };
  };
};

function expectInOrder(source: string, values: readonly string[]): void {
  let cursor = -1;
  for (const value of values) {
    const next = source.indexOf(value, cursor + 1);
    expect(next, `${value} should appear after the previous quick start`).toBeGreaterThan(cursor);
    cursor = next;
  }
}

describe('contextual New Task quick starts', () => {
  it('keeps the approved Dialogue and Project intent order', () => {
    expectInOrder(quickStartsSource, [
      "key: 'appsAndTools'",
      "key: 'docsAndData'",
      "key: 'designAndImages'",
      "key: 'webSearch'",
    ]);
    expectInOrder(quickStartsSource, [
      "key: 'exploreProject'",
      "key: 'buildFeature'",
      "key: 'reviewCode'",
      "key: 'fixIssue'",
    ]);
  });

  it('switches from the exact workspace truth and hides cards for real drafts', () => {
    expect(routeSource).toContain("workspaceKind={effectiveWorkingDir ? 'project' : 'dialogue'}");
    expect(routeSource).toContain('!showProviderOnboardingCard && !hasComposerDraft');
    expect(routeSource).toContain('useComposerDraftPresence(NEW_MAKER_DRAFT_KEY)');
  });

  it('keeps visible kickoff copy natural instead of exposing prompt meta-instructions', () => {
    const quickStarts = zhLocale.newChat.createAgent.quickStarts as {
      dialogue: Record<string, { kickoff: string }>;
      project: Record<string, { kickoff: string }>;
    };
    const kickoffs = [
      ...Object.values(quickStarts.dialogue),
      ...Object.values(quickStarts.project),
    ].map((entry) => entry.kickoff);
    expect(kickoffs).toHaveLength(8);
    for (const kickoff of kickoffs) {
      expect(kickoff.startsWith('Hi Cindy! ')).toBe(true);
    }
    const copy = JSON.stringify(quickStarts);
    expect(copy).toContain('先陪我把需求聊清楚吧');
    expect(copy).toContain('先带我熟悉一下这个项目吧');
    expect(copy).not.toContain('最多 3 个');
    expect(copy).not.toContain('不要重复询问');
    expect(copy).not.toContain('快捷开始：');
  });

  it('starts the existing send pipeline instead of prefilling the composer', () => {
    expect(routeSource).toContain('t(item.kickoffKey)');
    expect(routeSource).toContain('draftInitialModel');
    expect(routeSource).toContain('draftInitialEffort');
    expect(routeSource).toContain('chatInitialPermissionMode');
    expect(routeSource).toContain('providerId: chatInitialProviderId');
    expect(routeSource).toContain('onSettled');
    expect(routeSource).not.toContain('quickStartTextToTiptapDoc');
  });

  it('guards duplicate clicks and exposes an accessible busy state', () => {
    expect(routeSource).toContain('quickStartBusyKey !== null');
    expect(quickStartsSource).toContain('disabled={disabled}');
    expect(quickStartsSource).toContain('aria-busy={isBusy || undefined}');
    expect(quickStartsSource).toContain("t('newChat.createAgent.quickStarts.starting')");
  });

  it('labels the managed Dialogue directory as a task space with an open action', () => {
    expect(sessionViewSource).toContain("t('ccAgent.layout.taskWorkspaceLabel')");
    expect(sessionViewSource).toContain("'ccAgent.layout.openTaskWorkspaceAria'");
    expect(sessionViewSource).toContain('<FolderOpen');
    expect(sessionViewSource).toContain('onClick={handleOpenWorkingDir}');
  });
});
