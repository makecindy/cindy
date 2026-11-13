import { mountPage } from '../../ui-page/harness';
import { MarkdownRenderer } from '../../../src/renderer/components/chat/MarkdownRenderer';
import { ChatSessionFileProvider } from '../../../src/renderer/components/chat/ChatSessionFileContext';

mountPage({
  render: () => (
    <main className="p-6">
      <ChatSessionFileProvider value={{ sessionId: 'table-copy-opacity', workingDir: '', origin: { kind: 'local' } }}>
        <MarkdownRenderer
          content={'| Right-aligned header WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW |\n| ---: |\n| Synthetic table content |'}
          allowPrivilegedLinks={false}
        />
      </ChatSessionFileProvider>
    </main>
  ),
});
