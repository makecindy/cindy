import { mountPage } from '../../ui-page/harness';
import { IssueConfirmCard } from '../../../src/renderer/features/cc-agent/IssueConfirmCard';

void mountPage({
  render: () => (
    <main className="mx-auto max-w-[760px] p-6">
      <IssueConfirmCard
        sessionId="issue-preview"
        onRespond={() => {}}
        pending={{
          requestId: 'issue-preview',
          draft: {
            title: '手机无法完成问题反馈确认',
            type: 'bug',
            body: '## 问题描述\n在 iPhone 上反馈问题时，确认卡提示只能回电脑处理。\n\n## 预期行为\n可以直接在手机上检查内容、确认并提交反馈。',
          },
          env: {
            appVersion: '开发预览',
            platform: 'darwin',
            arch: 'arm64',
            osVersion: 'macOS',
            harness: 'Claude Code',
            modelId: 'claude-sonnet-5',
            region: 'global',
          },
          submissionIdentity: { kind: 'platform', login: 'cindy-bot' },
          githubUserIdentity: { kind: 'github-user', login: 'demo-user' },
          suggestedPublicName: '匿名用户',
        }}
      />
    </main>
  ),
});
