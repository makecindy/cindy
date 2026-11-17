import { mountPage, subscription } from '../../ui-page/harness';
import { FileBodyView } from '../../../src/renderer/features/cc-agent/workdir-browse/FileBodyView';

mountPage({
  host: ctx => ({
    onSelectionContextMenuAddToChat: subscription('selectionContextMenu'),
    fileBrowser: { writeFile: async () => ({ ok: false, message: 'FILE_TARGET_CHANGED' }) },
    appShortcuts: {
      getState: () => ({ platform: ctx.platform, overrides: {}, globalFailures: [] }),
      onChanged: subscription('shortcuts'),
    },
  }),
  render: ctx => (
    <div className="flex h-screen min-w-0 flex-col overflow-hidden" data-error-viewport>
      <FileBodyView
        workdir="/fixture"
        relPath={ctx.case === 'target-changed' ? 'alias/note.txt' : 'missing.txt'}
        content={ctx.case === 'target-changed'
          ? { kind: 'text', relPath: 'alias/note.txt', content: 'Original text', size: 13, mtimeMs: 0, truncated: false, resolvedPath: 'a/note.txt' }
          : { kind: 'error', message: String(ctx.data.message) }}
      />
    </div>
  ),
});
