import { useRef } from 'react';

import { forbid, mountPage } from '../../ui-page/harness';
import { MemoryEntriesPanel } from '../../../src/renderer/components/settings/MemoryEntriesPanel';
import { BotLearningFooter } from '../../../src/renderer/features/bots/BotLearningFooter';
import { setMakerMemoryEnabled } from '../../../src/renderer/lib/memorySettingsStore';
import type { BotMemoryDetail, BotMemorySummary } from '../../../src/shared/botMemory';
import type {
  MakerMemoryScopeSummary,
  MakerMemoryTaskLocation,
  MakerMemoryTidyRun,
} from '../../../src/shared/makerMemoryEntries';

const PROJECT = '/Users/chris/Projects/cindy';
const scopes: MakerMemoryScopeSummary[] = [
  { scopeKey: 'user:account', kind: 'user', count: 0 },
  { scopeKey: PROJECT, kind: 'project', count: 4, name: 'cindy', path: PROJECT },
  { scopeKey: 'ssh:build-box:/srv/apps/storefront-with-a-rather-long-folder-name', kind: 'project', count: 12, name: 'storefront-with-a-rather-long-folder-name', path: '/srv/apps/storefront-with-a-rather-long-folder-name', host: 'build-box' },
];
const details: BotMemoryDetail[] = [
  { filename: 'feedback_use-pnpm.md', type: 'feedback', title: 'Use pnpm in this repository', body: 'Install and run scripts with pnpm, never npm or yarn.\n\n- `pnpm install` after switching branches\n- `pnpm test:unit:related` before a commit', updatedAt: '2026-11-09T09:35:33.152Z' },
  { filename: 'feedback_small-prs.md', type: 'feedback', title: '改动拆成小的 PR', body: '一个 PR 只做一件事，说明里写清楚怎么验证。超过 400 行先拆。', updatedAt: '2026-11-02T05:01:04.387Z' },
  { filename: 'project_release-train.md', type: 'project', title: 'Release train', body: 'Desktop ships every Tuesday; the branch is cut on Monday evening. Mobile follows one day later.', updatedAt: '2026-10-28T12:00:00.000Z' },
  { filename: 'reference_design-rules.md', type: 'reference', title: 'Design rules live in docs/design-rules', body: 'Read the routing table at the top of DESIGN.md before changing any interface.', updatedAt: '2026-10-11T08:20:00.000Z' },
];
// 整理记录：一次自动整理（合并 + 移除），一次已撤销的手动整理。
const runs: MakerMemoryTidyRun[] = [
  {
    id: 'run-2',
    at: '2026-11-09T21:40:00.000Z',
    trigger: 'auto',
    undone: false,
    count: 3,
    changes: [
      { kind: 'merged', title: 'Use pnpm in this repository', mergedTitles: ['Use pnpm in this repository', 'Never run npm install here'], reason: 'Both say to use pnpm; the newer one also covers scripts.' },
      { kind: 'removed', title: 'Release train leaves on Wednesday', mergedTitles: [], reason: 'Superseded by “Release train”, which was updated later and says Tuesday.' },
    ],
  },
  {
    id: 'run-1',
    at: '2026-10-30T08:05:00.000Z',
    trigger: 'manual',
    undone: true,
    count: 2,
    changes: [
      { kind: 'merged', title: '改动拆成小的 PR', mergedTitles: ['改动拆成小的 PR', 'PR 不超过 400 行'], reason: '两条都在说 PR 的大小，合成一条。' },
    ],
  },
];
const summary = ({ body, ...rest }: BotMemoryDetail): BotMemorySummary => ({ ...rest, preview: body.replace(/\s+/g, ' ') });

function Panel({ initialTask }: { initialTask: MakerMemoryTaskLocation | null }) {
  const backRef = useRef<(() => Promise<boolean>) | null>(null);
  const leaveRef = useRef<(() => Promise<boolean>) | null>(null);
  return (
    <div className="mx-auto max-w-[920px] bg-[var(--settings-bg)] px-6 py-7">
      <MemoryEntriesPanel
        initialTask={initialTask}
        onBack={() => void backRef.current?.()}
        backRef={backRef}
        leaveRef={leaveRef}
      />
    </div>
  );
}

mountPage({
  route: '/settings?tab=personalization&openPanel=memory',
  host: (ctx) => {
    setMakerMemoryEnabled(ctx.case !== 'off');
    return {
      maker: {
        memoryEntries: {
          // 带了任务位置就指向它的项目（保存回执点开）；否则落在「关于你」。
          scopes: async (task?: MakerMemoryTaskLocation) => ({ scopes, taskScopeKey: task ? PROJECT : null }),
          list: async (scopeKey: string) => (scopeKey === PROJECT ? details.map(summary) : []),
          read: async (_scopeKey: string, filename: string) => details.find((entry) => entry.filename === filename)!,
          update: forbid('maker.memoryEntries.update'),
          delete: forbid('maker.memoryEntries.delete'),
          tidy: forbid('maker.memoryEntries.tidy'),
          tidyRuns: async (scopeKey: string) => (ctx.case === 'records' && scopeKey === PROJECT ? runs : []),
          tidyUndo: forbid('maker.memoryEntries.tidyUndo'),
        },
      },
    };
  },
  render: (ctx) =>
    ctx.case === 'receipt' ? (
      <div className="flex flex-col gap-6 p-6 text-14 text-[var(--text-primary)]">
        {(['task', 'task-readonly'] as const).map((surface) => (
          <div key={surface}>
            <p>Got it — I'll use pnpm in this repository from now on.</p>
            <BotLearningFooter
              surface={surface}
              task={{ workingDir: PROJECT }}
              receipts={[{ kind: 'memory', key: 'feedback_use-pnpm.md', title: 'Use pnpm in this repository', action: 'created', scope: 'project' }]}
            />
          </div>
        ))}
      </div>
    ) : (
      <Panel initialTask={ctx.case === 'empty' ? null : { workingDir: PROJECT }} />
    ),
});
