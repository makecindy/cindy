import { useState, useSyncExternalStore } from 'react';
import { getDraft, subscribeDraft } from '../../../src/renderer/lib/composerDraftStore';
import { Route, Routes } from 'react-router-dom';
import { AppFrame, mountPage, subscription } from '../../ui-page/harness';
import { BotDirectMessageView } from '../../../src/renderer/features/bots/BotDirectMessageView';
import { BotDirectMessageCard } from '../../../src/renderer/features/bots/BotDirectMessageCard';
import { UserMessage } from '../../../src/renderer/components/chat/UserMessage';
import { formatForwardedRequest } from '../../../src/shared/forwardedRequest';
import { BotChatQuoteProvider } from '../../../src/renderer/features/bots/botChatQuoteContext';
import { BotChatQuoteComposerPreview, BotChatQuoteInBubble } from '../../../src/renderer/features/bots/BotChatQuoteViews';
import { SearchResultsBody } from '../../../src/renderer/features/cc-agent/sidebar/ConversationSearchBox';
import { mergeConversationSearchResults, normalizeConversationContentPreview } from '../../../src/main/localDb/conversationSearch.pure';
import type { ChatMessage } from '../../../src/renderer/lib/makerChatStore';
import type { ChatReplyQuote } from '../../../src/shared/chatReplyQuote';
import type { SupportedLocale } from '../../../src/shared/locale';

const original = '请检查消息中的换行，保留代码和路径。';
const supplement = '第一段：消息现在正常换行。\n\n1. 保留段落与列表\n2. 保留有意书写的转义\n\n```js\nconst newline = "\\n";\nconst path = "C:\\\\new\\\\test";\n```\n\n最后一段：只检查，不发布。';

function DraftProbe({ sessionId, content }: { sessionId: string; content: string }) {
  const draft = useSyncExternalStore(callback => subscribeDraft(sessionId, callback), () => getDraft(sessionId));
  return <><pre hidden data-ui-draft>{JSON.stringify(draft?.text)}</pre><pre hidden data-ui-original>{content}</pre></>;
}

function QuoteScenario({ content }: { content: string }) {
  const [quote, setQuote] = useState<ChatReplyQuote | null>(null);
  const [loaded, setLoaded] = useState(true);
  const message = { clientId: 'quoted-user', role: 'user', content,
    automationOrigin: { kind: 'session', senderSessionId: 'sender' } } as ChatMessage;
  const context = { sessionId: 'quote-task', names: { owner: 'Chris', companion: 'Cindy' },
    getMessage: () => loaded ? message : undefined, isFirstReplyFor: () => false,
    showReplyTargets: false, quote: setQuote, locate: () => {} };
  return <div className="p-4 space-y-4" data-ui-page-subject><BotChatQuoteProvider value={context}>
    <UserMessage workingDir="" sessionId="quote-task" messageClientId={message.clientId}
      content={content} automationOrigin={message.automationOrigin} simplifiedBotConversation />
    {quote && <div data-ui-quote-preview>
      <BotChatQuoteComposerPreview sessionId="quote-task" quote={quote} getMessage={context.getMessage} names={context.names} />
      <BotChatQuoteInBubble quote={quote} context={context} />
      <pre hidden data-ui-quote-snapshot>{quote.excerpt}</pre>
    </div>}
    <button data-ui-unload onClick={() => setLoaded(false)}>Unload original (fixture)</button>
  </BotChatQuoteProvider></div>;
}

function SearchScenario({ content }: { content: string }) {
  const query = '最后一段';
  const preview = normalizeConversationContentPreview('user', content, query, 180, JSON.stringify({ origin: { kind: 'session' } }));
  const date = new Date(1792629000000).toISOString();
  const results = mergeConversationSearchResults({ titleMatches: [], limit: 10, contentHits: [{
    session: { id: 'search-task', title: '消息格式检查', workingDir: null, workspaceKind: 'dialogue',
      agentKind: 'cc', status: 'active', createdAt: date, updatedAt: date, userSendAt: date, _count: { messages: 3 } },
    hit: { messageId: 'search-message', messageClientId: 'search-user', role: 'user', createdAt: date,
      preview: preview.preview, snippet: preview.snippet, score: 1, ftsRank: 1, vectorRank: null },
  }] });
  return <div className="p-4" data-ui-page-subject><SearchResultsBody trimmed={query} status="done" results={results} onSelect={() => {}} /></div>;
}

void mountPage({
  route: '/bots/bot-a/direct/thread',
  host: (ctx) => {
    const content = formatForwardedRequest({ userText: original }, supplement, ctx.locale as SupportedLocale);
    return { maker: {
      getBotDirectMessageThread: async () => ({ ok: true, thread: {
        id: 'thread', botAId: 'bot-a', botAName: 'Cindy', botBId: 'bot-b', botBName: 'Filo',
        status: 'active', closeReason: null, messageCount: 1, maxMessages: 12,
        messages: [{ id: 'message', sequence: 1, senderBotId: 'bot-a', senderBotName: 'Cindy',
          recipientBotId: 'bot-b', recipientBotName: 'Filo', content, createdAt: 1792629000000 }],
      } }),
      onBotDirectMessageChanged: subscription('directMessageChanged'),
      getCapabilities: async () => ({ availableModels: [], effortLevels: [], permissionModes: [], fork: { supported: true }, rewind: { supported: true } }),
      fork: async () => ({ id: 'forwarded-fork', updatedAt: new Date().toISOString() }),
      rewindPreview: async () => ({ canRewind: true, filesChanged: [], conversationOnly: true }),
      rewindCommit: async () => ({ id: 'forwarded-task', updatedAt: new Date().toISOString() }),
    } };
  },
  render: (ctx) => {
    const content = formatForwardedRequest({ userText: original }, supplement, ctx.locale as SupportedLocale);
    if (ctx.case === 'quote') return <QuoteScenario content={content} />;
    if (ctx.case === 'search') return <SearchScenario content={content} />;
    if (['task', 'fork', 'rewind'].includes(ctx.case)) return <div className="p-4" data-ui-page-subject>
      <DraftProbe sessionId={ctx.case === 'fork' ? 'forwarded-fork' : 'forwarded-task'} content={content} />
      <UserMessage workingDir="" sessionId="forwarded-task" messageClientId="forwarded-user-2" agentKind="cc" content={content} automationOrigin={{ kind: 'session', senderSessionId: 'sender', senderBotName: 'Cindy', senderBotId: 'bot-a' }} />
    </div>;
    if (ctx.case === 'card') return <div className="p-4" data-ui-page-subject>
      <BotDirectMessageCard data={{ v: 1, threadId: 'thread', viewerBotId: 'bot-a', peerBotId: 'bot-b', peerBotName: 'Filo', direction: 'sent', sequence: 1, preview: content.slice(0, 400) }} />
    </div>;
    return <AppFrame sidebarWidth={0}><Routes><Route path="/bots/:botId/direct/:threadId" element={<BotDirectMessageView />} /></Routes></AppFrame>;
  },
});
