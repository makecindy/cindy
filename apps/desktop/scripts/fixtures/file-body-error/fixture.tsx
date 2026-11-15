import { mountPage, subscription } from '../../ui-page/harness';
import { FileBodyView } from '../../../src/renderer/features/cc-agent/workdir-browse/FileBodyView';

mountPage({
  host: ctx => ({
    appShortcuts: {
      getState: () => ({ platform: ctx.platform, overrides: {}, globalFailures: [] }),
      onChanged: subscription('shortcuts'),
    },
  }),
  render: ctx => (
    <div className="flex h-screen min-w-0 flex-col overflow-hidden" data-error-viewport>
      <FileBodyView
        workdir="/fixture"
        relPath="missing.txt"
        content={{ kind: 'error', message: String(ctx.data.message) }}
      />
    </div>
  ),
});
