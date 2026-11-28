import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ComposerSuggestionEntry } from '../../../src/renderer/lib/composerSuggestion';
import { AtMentionPanel } from '../../../src/renderer/components/new-chat/AtMentionPanel';
import { ExtraDirsButton } from '../../../src/renderer/components/new-chat/ExtraDirsButton';
import { ctx, mountPage } from '../../ui-page/harness';

function Fixture() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(0);
  const entries: ComposerSuggestionEntry[] = Array.from({ length: 24 }, (_, i) => ({
    kind: 'resource' as const,
    item: { type: 'file' as const, name: `notes-${i}.md`, relPath: `notes-${i}.md` },
  })).filter(entry => entry.item.name.includes(query));
  if (ctx.case === 'new-task' && !query) {
    entries.push(
      { kind: 'action', action: { id: 'add-extra-dir', label: t('extraDirs.add'), run: () => {} } },
      { kind: 'action', action: { id: 'project-settings', label: t('projectSettings.title'), run: () => {} } },
    );
  }
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
