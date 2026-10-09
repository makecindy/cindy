import { EditorView } from '@codemirror/view';
import { markdownMermaidDecorationField } from '../../../src/renderer/components/markdown/markdownMermaidLivePreview';
import '../../../src/renderer/themes/colors';
import { ThemeService } from '../../../src/renderer/themes/theme-service';
import { cindyLight } from '../../../src/renderer/themes/builtin/cindy-light';
import { cindyDark } from '../../../src/renderer/themes/builtin/cindy-dark';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { AssistantMessage } from '../../../src/renderer/components/chat/AssistantMessage';
import { Tooltip } from '../../../src/renderer/components/ui/tooltip';
import { ConfirmDialogProvider } from '../../../src/renderer/components/ui/confirm-dialog-provider';
import { ChatSessionFileProvider } from '../../../src/renderer/components/chat/ChatSessionFileContext';
import { svgToPngBlob } from '../../../src/renderer/lib/rasterizeToImage';
import { i18n } from '../../../src/renderer/i18n';
import { getToastSnapshot, toast } from '../../../src/renderer/lib/toast';
import { useDisableContextMenu } from '../../../src/renderer/hooks/useDisableContextMenu';

// Synthetic labels, preserving HTML line breaks, Unicode and entity escaping.
const source =
  'flowchart TB\n A["入口一、入口二<br/>第一行 & 第二行"] <--> B["中间节点<br/>带换行的标签"]\n B <--> C["处理节点"]\n C <--> D["输出一"]\n C <--> E["输出二"]';
const copies: Array<{ png: number[]; plainText?: string }> = [];
const logs: unknown[][] = [];
let rejectCopy = false;
const root = createRoot(document.getElementById('root')!);
let generation = 0;
let editor: EditorView | undefined;
const decode = HTMLImageElement.prototype.decode;
function Message({ raw, simplified }: { raw: string; simplified: boolean }) {
  useDisableContextMenu();
  return (
    <AssistantMessage
      content={'```mermaid\n' + raw + '\n```'}
      simplifiedBotConversation={simplified}
    />
  );
}
const fixture = {
  source,
  copies,
  logs,
  svgToPngBlob,
  getToastSnapshot,
  label: (key: string) => i18n.t(key),
  setRejectCopy: (value: boolean) => {
    rejectCopy = value;
  },
  setDecodeFailure(value: boolean) {
    HTMLImageElement.prototype.decode = value
      ? () => Promise.reject(new DOMException('Synthetic decode failure', 'EncodingError'))
      : decode;
  },
  renderEditor(raw = source) {
    editor?.destroy();
    const host = document.getElementById('editor')!;
    editor = new EditorView({
      doc: '```mermaid\n' + raw + '\n```',
      extensions: [markdownMermaidDecorationField],
      parent: host,
    });
  },
  async render(raw = source, simplified = false, dark = false, locale = 'zh-CN') {
    editor?.destroy();
    editor = undefined;
    copies.length = 0;
    logs.length = 0;
    toast.dismissAll();
    rejectCopy = false;
    new ThemeService().applyTheme(dark ? cindyDark : cindyLight);
    document.documentElement.classList.toggle('dark', dark);
    await i18n.changeLanguage(locale);
    root.render(
      <MemoryRouter key={++generation}>
        <Tooltip.Provider>
          <ConfirmDialogProvider>
            <ChatSessionFileProvider
              value={{
                sessionId: 'fixture-session',
                workingDir: '/fixture',
                origin: { kind: 'local' },
              }}
            >
              <Message raw={raw} simplified={simplified} />
            </ChatSessionFileProvider>
          </ConfirmDialogProvider>
        </Tooltip.Provider>
      </MemoryRouter>,
    );
  },
};
Object.assign(window, {
  electronAPI: {
    copyPngToClipboard: async ({ png, plainText }: { png: ArrayBuffer; plainText?: string }) => {
      if (rejectCopy) throw new Error('[INTERNAL] fixture copy rejection');
      copies.push({ png: Array.from(new Uint8Array(png)), plainText });
    },
    logToMain: (...args: unknown[]) => logs.push(args),
  },
  fixture,
});
Object.defineProperty(navigator, 'clipboard', {
  value: {
    write: () => {
      throw new Error('Browser clipboard must not be accessed');
    },
    writeText: () => {
      throw new Error('Browser clipboard must not be accessed');
    },
  },
});
await fixture.render();
