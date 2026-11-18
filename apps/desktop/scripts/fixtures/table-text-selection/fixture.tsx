import { useEffect, useRef, useState } from 'react';
import { mountPage, subscription } from '../../ui-page/harness';
import { AssistantMessage } from '../../../src/renderer/components/chat/AssistantMessage';
import { SelectionQuoteButton } from '../../../src/renderer/components/chat/SelectionQuoteButton';
import { copyChatSelection } from '../../../src/renderer/components/chat/chatSelectionClipboard';
import { getDraft, subscribeDraftContent } from '../../../src/renderer/lib/composerDraftStore';
import { EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES } from '../../../src/renderer/cindy-brain/PluginUiContributions';

function Fixture({ content, multiple }: { content: string; multiple: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState('');
  useEffect(() => subscribeDraftContent('table-selection', () => {
    setDraft(JSON.stringify(getDraft('table-selection')?.text) ?? '');
  }), []);
  const messages = multiple ? ['上一条消息正文：跨消息起点。', content, '下一条消息正文：跨消息终点。'] : [content];
  return <main className="p-6">
    <div ref={container} onCopy={copyChatSelection} data-scroll-container className="space-y-3">
      {messages.map((body, index) => <section key={index} data-copy-message={body === content ? 'table' : index === 0 ? 'previous' : 'next'}>
        <AssistantMessage pluginUi={EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES} workingDir="/project"
          currentSessionId="table-selection" messageClientId={`table-selection-${index}`}
          content={body} agentKind="cc" showActionBar allowPrivilegedLinks={false} />
      </section>)}
    </div>
    <SelectionQuoteButton sessionId="table-selection" containerRef={container} />
    <textarea aria-label="Paste target" data-ui-page-control />
    <output data-ui-page-control data-quote-draft>{draft}</output>
  </main>;
}

mountPage({
  route: '/cc-agent/table-selection',
  host: {
    onSelectionContextMenuAddToChat: subscription('selection-context-menu.add-to-chat'),
    maker: { getCapabilities: async () => ({ availableModels: [], fork: { supported: false }, rewind: { supported: false } }) },
    // Adapt only the preload transport: the production table exports PNG + TSV,
    // then this isolated test host writes both real clipboard formats.
    copyPngToClipboard: async ({ png, plainText }: { png: ArrayBuffer; plainText?: string }) => {
      await navigator.clipboard.write([new ClipboardItem({
        'image/png': new Blob([png], { type: 'image/png' }),
        'text/plain': new Blob([plainText ?? ''], { type: 'text/plain' }),
      })]);
    },
  },
  render: ctx => <Fixture content={ctx.data.content} multiple={ctx.case === 'multiple-messages'} />,
});
