import { mountPage, forbid, subscription } from '../../ui-page/harness';
import { MarkdownRenderer } from '../../../src/renderer/components/chat/MarkdownRenderer';
import { ChatSessionFileProvider } from '../../../src/renderer/components/chat/ChatSessionFileContext';
import { ToastContainer } from '../../../src/renderer/components/ui/toast/ToastContainer';

// Exercise the real Markdown/render/click chain; only filesystem responses are
// simulated. Restoring a file must work even with a cached negative result.
// Same self-contained blank PDF shape as the URL-worker runner selftest:
// valid xref, one page, no fonts, scripts or network resources.
const pdfBytes = Uint8Array.from(atob('JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAyMDAgMTAwXSAvUmVzb3VyY2VzIDw8ID4+ID4+CmVuZG9iagp4cmVmCjAgNAowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCnRyYWlsZXIKPDwgL1NpemUgNCAvUm9vdCAxIDAgUiA+PgpzdGFydHhyZWYKMjAzCiUlRU9GCg=='), char => char.charCodeAt(0));
let restored = false;
const content = '[查看报告](/fixture/report.html)\n\n[下载 PDF](/fixture/report.pdf)\n\n自动识别：/fixture/missing.txt\n\n行内代码：`/fixture/missing.txt`';

mountPage({
  route: '/sessions/fixture',
  host: ctx => ({
    resolvePath: ctx.case === 'remote' ? forbid('resolvePath on remote file') : async ({ href, refresh }: { href: string; refresh?: boolean }) => ({
      status: refresh && restored && href.endsWith('.pdf') ? 'unique' : 'none',
      candidates: refresh && restored && href.endsWith('.pdf') ? [href] : [],
      kind: 'file',
    }),
    openPath: forbid('openPath'),
    readFileBytes: ctx.case !== 'default' ? forbid('readFileBytes on nonlocal content') : async ({ filePath }: { filePath: string }) => {
      document.documentElement.dataset.previewedFile = filePath;
      return { bytes: pdfBytes.slice() };
    },
    fileBrowser: {
      chatStat: async () => ({ verdict: 'nonfile' }),
      onEvent: subscription('fixture-file-browser'),
      readFile: ctx.case !== 'default' ? forbid('local file read on nonlocal content') : async () => ({ ok: false, code: 'BINARY_FILE', message: 'fixture PDF' }),
      stat: ctx.case !== 'default' ? forbid('local file stat on nonlocal content') : async ({ relPath }: { relPath: string }) => ({
        relPath, size: pdfBytes.length, mtimeMs: 1, isDirectory: false,
      }),
    },
  }),
  render: ctx => <main style={{ padding: '120px 24px 24px', maxWidth: 560, margin: '0 auto' }}>
    <ChatSessionFileProvider value={{ sessionId: undefined, workingDir: '/fixture', origin: ctx.case === 'remote' ? { kind: 'device', deviceId: 'fixture-device' } : { kind: 'local' } }}>
      <MarkdownRenderer content={content} workingDir="/fixture" allowPrivilegedLinks={ctx.case !== 'untrusted'} />
    </ChatSessionFileProvider>
    <button data-testid="restore-file" onClick={() => { restored = true; }}>恢复测试文件</button>
    <ToastContainer />
  </main>,
});
