import { useState } from 'react';
import {
  BranchBaseDropdown,
  ReviewDiffListHeader,
} from '../../../src/renderer/features/right-sidebar/plugins/review/ReviewTabBody';
import { mountPage } from '../../ui-page/harness';

const prefix = 'feature/shared-long-prefix-for-review-comparison-';
const candidates = [
  'origin/main',
  `${prefix}first`,
  `${prefix}second`,
  ...Array.from({ length: 20 }, (_, i) => `feature/branch-${i}`),
].map((refName) => ({
  refName,
  shortName: refName,
  kind: 'local' as const,
  remote: null,
  oid: 'a'.repeat(40),
}));

function Fixture({ width }: { width: number }) {
  const [selected, setSelected] = useState(candidates[1].refName);
  return (
    <div
      className="ml-auto h-screen border-l border-[var(--border-default)] bg-[var(--surface)]"
      style={{ width }}
    >
      <ReviewDiffListHeader
        fileCount={5}
        branchBaseControl={
          <BranchBaseDropdown
            candidates={candidates}
            selectedBaseRef={selected}
            onSelectBase={setSelected}
          />
        }
        refreshPending={false}
        onRefresh={() => {}}
        viewMode="split"
        onViewModeChange={() => {}}
        richMarkdownPreview
        onRichMarkdownPreviewChange={() => {}}
      />
    </div>
  );
}

mountPage({ render: (ctx) => <Fixture width={Number(ctx.data.width)} /> });
