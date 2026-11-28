import { mountPage } from '../../ui-page/harness';
import { MarkdownRenderer } from '../../../src/renderer/components/chat/MarkdownRenderer';
import { UserMessageUrlLink } from '../../../src/renderer/components/chat/UserMessageUrlLink';
import { ToastContainer } from '../../../src/renderer/components/ui/toast/ToastContainer';

const PR_URL = 'https://github.com/makecindy/cindy/pull/9261';
const MR_URL = 'https://git.example.com/team/sub/repo/-/merge_requests/42/diffs';

mountPage({
  route: '/sessions/fixture',
  host: () => ({}),
  render: (ctx) => (
    <main style={{ padding: '40px 24px 24px', maxWidth: 620, margin: '0 auto' }}>
      {ctx.case === 'gitlab' ? (
        <div className="space-y-3 text-14 text-[var(--text-primary)]">
          <p>用户消息中的 GitLab MR 链接：</p>
          <UserMessageUrlLink url={MR_URL} sessionId="fixture-session" />
        </div>
      ) : (
        <MarkdownRenderer
          workingDir="/fixture"
          currentSessionId="fixture-session"
          content={`请查看 [PR #9261](${PR_URL}/files) 的检查与评审进度。`}
        />
      )}
      <ToastContainer />
    </main>
  ),
});
