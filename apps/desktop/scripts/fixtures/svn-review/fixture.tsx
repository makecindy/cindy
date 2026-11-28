import { useState } from 'react';
import { mountPage } from '../../ui-page/harness';
import { parseGitDiff } from '../../../src/main/git-review/diffParser';
import { ReviewTabBody } from '../../../src/renderer/features/right-sidebar/plugins/review/ReviewTabBody';
import type { ReviewState } from '../../../src/renderer/features/right-sidebar/plugins/review';

const file = parseGitDiff('@@ -1 +1 @@\n-WalkSpeed = 4\n+WalkSpeed = 6\n', {
  source: 'unstaged',
  pathHint: 'Config/Movement.ini',
  unifiedOnly: true,
});
const data = {
  scope: { vcs: 'svn', repoRoot: '/game', aheadBehind: { ahead: 0, behind: 0 } },
  status: { stagedCount: 0, unstagedCount: 1, writeDisabledReasons: ['svn'] },
  diffs: { staged: [], unstaged: [{ ...file, status: 'modified' }] },
  summary: { dirty: true },
};

function Fixture() {
  const [state, setState] = useState<ReviewState>({
    descriptor: { kind: 'unstaged' },
    messageSnapshot: null,
    jumpTarget: null,
    diffsExpanded: true,
    diffViewMode: 'unified',
    fileTreeVisible: false,
    wordWrap: false,
    wordDiff: false,
    hideWhitespace: false,
    richMarkdownPreview: true,
    branchBaseRef: null,
  });
  return (
    <main className="flex h-screen flex-col">
      <ReviewTabBody
        state={state}
        ctx={{
          tabId: 'review',
          sessionId: 'fixture',
          workdir: '/game',
          remoteHostId: null,
          deviceLinkDeviceId: null,
          patchState: (patch) => setState((current) => ({ ...current, ...(patch as Partial<ReviewState>) })),
          onVisibilityChange: () => {},
          setCloseInterceptor: () => () => {},
        }}
      />
    </main>
  );
}

void mountPage({
  host: { gitReview: { get: async () => data, commits: async () => ({ commits: [] }) } },
  render: () => <Fixture />,
});
