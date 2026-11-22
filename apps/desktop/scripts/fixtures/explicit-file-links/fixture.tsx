import { mountPage, forbid, subscription } from '../../ui-page/harness';
import { MarkdownRenderer } from '../../../src/renderer/components/chat/MarkdownRenderer';
import { ChatSessionFileProvider } from '../../../src/renderer/components/chat/ChatSessionFileContext';
import { ToastContainer } from '../../../src/renderer/components/ui/toast/ToastContainer';

// Exercise the real Markdown/render/click chain; only filesystem responses are
// simulated. Restoring a file must work even with a cached negative result.
let restored = false;
const content = '[查看报告](/fixture/report.html)\n\n[下载 PDF](/fixture/report.pdf)\n\n自动识别：/fixture/missing.txt\n\n行内代码：`/fixture/missing.txt`';
const htmlShortcutContent = '[demo.html](documents/demo.html)';
const htmlShortcutSessionId = 'fixture';

mountPage({
  route: '/sessions/fixture',
  host: ctx => ({
    resolvePath: ctx.case === 'remote' ? forbid('resolvePath on remote file') : async ({ href, refresh }: { href: string; refresh?: boolean }) => {
      const path = ctx.case === 'html-shortcut' && href === 'documents/demo.html'
        ? '/fixture/documents/demo.html'
        : href.endsWith('.pdf') ? href : undefined;
      return refresh && restored && path
        ? { status: 'unique', candidates: [path], kind: 'file' }
        : { status: 'none', candidates: [] };
    },
    openFileInBrowser: async (path: string) => {
      document.documentElement.dataset.openedInBrowser = path;
      return { success: true };
    },
    openPath: async (path: string) => {
      document.documentElement.dataset.openedFile = path;
      return { success: true };
    },
    fileBrowser: {
      chatStat: async () => ({ verdict: 'nonfile' }),
      readFile: async () => ({ ok: false, code: 'BINARY_FILE', message: 'binary' }),
      stat: async ({ relPath }: { relPath: string }) => ({ relPath, type: 'file', size: 128, mtimeMs: 1 }),
      onEvent: subscription('file-browser'),
    },
  }),
  render: ctx => {
    const htmlShortcut = ctx.case === 'html-shortcut';
    const sessionId = htmlShortcut ? htmlShortcutSessionId : undefined;
    return <main style={{ padding: '120px 24px 24px', maxWidth: 560, margin: '0 auto' }}>
      <ChatSessionFileProvider value={{ sessionId, workingDir: '/fixture', origin: ctx.case === 'remote' ? { kind: 'device', deviceId: 'fixture-device' } : { kind: 'local' } }}>
        <MarkdownRenderer
          content={htmlShortcut ? htmlShortcutContent : content}
          workingDir="/fixture"
          currentSessionId={sessionId}
          allowPrivilegedLinks={ctx.case !== 'untrusted'}
        />
      </ChatSessionFileProvider>
      <button data-testid="restore-file" data-ui-page-control onClick={() => { restored = true; }}>恢复测试文件</button>
      <ToastContainer />
    </main>;
  },
});
