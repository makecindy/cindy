import { mountPage } from '../../ui-page/harness';
import { HostConnectionBanner } from '../../../src/renderer/components/HostConnectionNotice';

mountPage({
  render: ctx => <HostConnectionBanner
    view={{ connection: 1, recovery: 1, failed: false, restoring: false, ...ctx.data }}
    onRetry={() => { document.documentElement.dataset.retried = 'true'; }}
  />,
});
