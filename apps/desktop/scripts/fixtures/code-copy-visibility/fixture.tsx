import { mountPage } from '../../ui-page/harness';
import { MarkdownRenderer } from '../../../src/renderer/components/chat/MarkdownRenderer';

const fence = '```';

mountPage({
  render: (ctx) => (
    <main style={{ padding: 24 }}>
      <MarkdownRenderer
        content={[fence + (ctx.data.language ?? ''), ctx.data.code, fence].join('\n')}
        allowPrivilegedLinks={false}
      />
    </main>
  ),
});
