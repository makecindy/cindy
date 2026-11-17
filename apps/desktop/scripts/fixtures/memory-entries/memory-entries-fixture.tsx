import { useRef } from 'react';

import { forbid, mountPage } from '../../ui-page/harness';
import { MemoryEntriesPanel } from '../../../src/renderer/components/settings/MemoryEntriesPanel';
import { BotLearningFooter } from '../../../src/renderer/features/bots/BotLearningFooter';
import { setMakerMemoryEnabled } from '../../../src/renderer/lib/memorySettingsStore';
import type { BotMemoryDetail, BotMemorySummary } from '../../../src/shared/botMemory';
import type {
  MakerMemoryScopeSummary,
  MakerMemoryTaskLocation,
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
