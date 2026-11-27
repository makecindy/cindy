import { useState } from 'react';
import { mountPage } from '../../ui-page/harness';
import { BotGroupQuoteBlock } from '../../../src/renderer/features/bots/BotGroupQuote';
import { copyChatSelection } from '../../../src/renderer/components/chat/chatSelectionClipboard';

function QuoteSelection() {
  const [jumps, setJumps] = useState(0);
  return (
    <main className="p-6">
      <div onCopy={copyChatSelection}>
        <BotGroupQuoteBlock
          display={{ state: 'live', authorName: 'Ada', excerpt: '周六早上 Android 发版', attachmentCount: 0, attachmentName: null }}
          onLocate={() => setJumps(count => count + 1)}
        />
      </div>
      <textarea aria-label="Paste" />
      <output>{jumps}</output>
    </main>
  );
}

mountPage({ render: () => <QuoteSelection /> });
