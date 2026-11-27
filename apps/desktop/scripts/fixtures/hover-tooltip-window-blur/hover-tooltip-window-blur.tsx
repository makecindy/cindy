import { useState } from 'react';
import { mountPage } from '../../ui-page/harness';
import { SessionTooltip } from '../../../src/renderer/features/cc-agent/sidebar/SessionTooltip';
import type { SessionPrRef } from '../../../src/renderer/lib/gitContext.types';

const prRefs: SessionPrRef[] = [
  { id: 'a', owner: 'taptap', repo: 'android-sdk', prNumber: 8123, pinned: false },
  { id: 'b', owner: 'taptap', repo: 'io-maker', prNumber: 446, pinned: false },
  { id: 'c', owner: 'taptap', repo: 'sdk-samples', prNumber: 91, pinned: false },
];

function Row() {
  const [open, setOpen] = useState(false);
  return (
    <SessionTooltip
      sessionId="fixture-session"
      prRefs={prRefs}
      controlledOpen={open}
      onOpenChange={setOpen}
    >
      <div
        data-hover-row
        role="button"
        tabIndex={0}
        onPointerOver={() => setOpen(true)}
        onPointerLeave={() => setOpen(false)}
        className="mx-3 mt-3 flex h-8 items-center rounded-lg bg-sidebar-accent px-2 text-13 text-sidebar-foreground"
      >
        检查 translated 行与上游改动
      </div>
    </SessionTooltip>
  );
}

mountPage({
  cases: ['default'],
  render: () => (
    <div className="flex h-screen w-full bg-sidebar">
      <aside className="w-[260px] shrink-0 border-r border-sidebar-border">
        <Row />
      </aside>
      <div className="flex-1 p-4 text-12 text-text-secondary">
        悬停左边的行会弹出 PR 浮层；指针离开行、或窗口失活（指针没离开行）时都应消失。
      </div>
    </div>
  ),
});
