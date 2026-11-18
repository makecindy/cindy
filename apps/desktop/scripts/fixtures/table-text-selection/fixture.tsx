import { useEffect, useRef, useState } from 'react';
import { mountPage, subscription } from '../../ui-page/harness';
import { MarkdownRenderer } from '../../../src/renderer/components/chat/MarkdownRenderer';
import { MessageActionBar } from '../../../src/renderer/components/chat/MessageActionBar';
import { SelectionQuoteButton } from '../../../src/renderer/components/chat/SelectionQuoteButton';
import { copyChatSelection } from '../../../src/renderer/components/chat/chatSelectionClipboard';
import { handleAssistantCopy } from '../../../src/renderer/lib/assistantSelectionCopy';
import { getDraft, subscribeDraftContent } from '../../../src/renderer/lib/composerDraftStore';
import { EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES } from '../../../src/renderer/cindy-brain/PluginUiContributions';

function Fixture({ content }: { content: string }) {
  const container = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState('');
  useEffect(() => subscribeDraftContent('table-selection', () => {
    setDraft(JSON.stringify(getDraft('table-selection')?.text) ?? '');
  }), []);
  return <main className="p-6">
    <div ref={container} onCopy={copyChatSelection} data-scroll-container>
      <div onCopy={handleAssistantCopy}>
        <MarkdownRenderer content={content} allowPrivilegedLinks={false} />
      </div>
      <MessageActionBar pluginUi={EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES} copyText={content} align="left" hovered />
    </div>
    <SelectionQuoteButton sessionId="table-selection" containerRef={container} />
    <textarea aria-label="Paste target" data-ui-page-control />
    <output data-ui-page-control data-quote-draft>{draft}</output>
  </main>;
}

mountPage({
  host: { onSelectionContextMenuAddToChat: subscription('selection-context-menu.add-to-chat') },
  render: ctx => <Fixture content={ctx.data.content} />,
});
