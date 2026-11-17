import { mountPage } from '../../ui-page/harness';
import { UserMessageUrlLink } from '../../../src/renderer/components/chat/UserMessageUrlLink';
import { ToastContainer } from '../../../src/renderer/components/ui/toast/ToastContainer';

const PR = 'https://github.com/example/repo/pull/7';
const MR = 'https://git.example.com/group/sub/repo/-/merge_requests/7/diffs';

mountPage({
  route: '/sessions/fixture',
  host: () => ({}),
  render: ctx => (
    <main style={{ padding: '120px 24px 24px', maxWidth: 560, margin: '0 auto' }}>
      <p>消息里的 PR / MR 链接，右键打开「打开方式」菜单。</p>
      <UserMessageUrlLink
        url={ctx.case === 'gitlab' ? MR : `${PR}/files?diff=split`}
        sessionId="fixture-session"
      />
      <ToastContainer />
    </main>
  ),
});
