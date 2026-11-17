import { forbid, mountPage, subscription } from '../../ui-page/harness';
import { FileBodyView } from '../../../src/renderer/features/cc-agent/workdir-browse/FileBodyView';
import { useFileContent } from '../../../src/renderer/features/cc-agent/workdir-browse/hooks/useFileContent';

function RemotePreview() {
  const { content } = useFileContent('/fixture', 'alias/note.txt', 'fixture-host');
  return <FileBodyView workdir="/fixture" relPath="alias/note.txt" remoteHostId="fixture-host" content={content} />;
}

mountPage({
  host: ctx => {
    let reads = 0;
    return {
      onSelectionContextMenuAddToChat: subscription('selectionContextMenu'),
      fileBrowser: {
        onEvent: subscription('file-event'),
        readFile: async () => ({ ok: true, data: ++reads === 1
          ? { relPath: 'alias/note.txt', content: 'Original text', size: 13, mtimeMs: 0, truncated: false, resolvedPath: 'a/note.txt' }
          : { relPath: 'alias/note.txt', content: 'Large target', size: 3 * 1024 * 1024, mtimeMs: 1, truncated: true, resolvedPath: 'b/note.txt' } }),
        cachePut: async () => ({ ok: true }),
        fetchRemote: forbid('fetchRemote while preserving the draft'),
        writeFile: async () => ({ ok: false, message: 'FILE_TARGET_CHANGED' }),
      },
      appShortcuts: {
        getState: () => ({ platform: ctx.platform, overrides: {}, globalFailures: [] }),
        onChanged: subscription('shortcuts'),
      },
    };
  },
  render: ctx => (
    <div className="flex h-screen min-w-0 flex-col overflow-hidden" data-error-viewport>
      {ctx.case === 'target-changed' ? <RemotePreview /> : <FileBodyView
        workdir="/fixture"
        relPath="missing.txt"
        content={{ kind: 'error', message: String(ctx.data.message) }}
      />}
    </div>
  ),
});
