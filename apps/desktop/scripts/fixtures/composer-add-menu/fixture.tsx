import { useState } from 'react';
import { AtMentionPanel } from '../../../src/renderer/components/new-chat/AtMentionPanel';
import { ExtraDirsButton } from '../../../src/renderer/components/new-chat/ExtraDirsButton';
import { ctx, mountPage } from '../../ui-page/harness';

function Fixture() {
  const [open, setOpen] = useState(true);
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(0);
  const entries = Array.from({ length: 24 }, (_, i) => ({
    kind: 'resource' as const,
    item: { type: 'file' as const, name: `notes-${i}.md`, relPath: `notes-${i}.md` },
  })).filter(entry => entry.item.name.includes(query));
  return <div style={{ position: 'absolute', bottom: 32, left: 32 }}>
    <ExtraDirsButton extraDirsCount={0} hasReferenceDirs={false} open={open} onOpenChange={setOpen}
      maxContentHeight={ctx.case === 'new-task' ? 240 : undefined}
      panel={<AtMentionPanel embedded query={query} searchValue={query} onSearchChange={setQuery}
        state={{ kind: 'ready', items: [], truncated: false }} entries={entries}
        focusedIndex={focused} onFocusedIndexChange={setFocused} onSelect={() => {}}
        onClose={() => setOpen(false)} onRetry={() => {}} />} />
  </div>;
}
void mountPage({ render: () => <Fixture /> });
