import { imText } from './imText';
import type { IMMessageEvent } from '@cindy/im';

function excerpt(value: string | undefined, max: number): string {
  const text = (value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    // Display an excerpt as text, not user-controlled Markdown or an @all ping.
    .replace(/[\\`*_[\]<>@]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 0xfee0))
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Transport metadata + the exact admitted message, never the latest chat message. */
export function describeInteractionSource(
  event: Pick<
    IMMessageEvent,
    'channelName' | 'chatId' | 'text' | 'interactionSource' | 'speaker' | 'protectedContent'
  >,
): string {
  const source = event.interactionSource;
  const lines = [
    imText('imBot.text.shared.source.origin', {
      channel: excerpt(event.channelName, 40),
      chat: excerpt(source?.chatName ?? event.chatId, 100),
    }),
    ...(source?.threadName
      ? [imText('imBot.text.shared.source.thread', { thread: excerpt(source.threadName, 80) })]
      : []),
    ...(source?.senderName || event.speaker?.name
      ? [imText('imBot.text.shared.source.sender', { sender: excerpt(source?.senderName ?? event.speaker?.name, 80) })]
      : []),
    event.protectedContent
      ? imText('imBot.text.shared.source.messageProtected')
      : imText('imBot.text.shared.source.message', {
        text: excerpt(event.text, 200) || imText('imBot.text.shared.source.noText'),
      }),
  ];
  // Only transport-produced HTTP links may appear here; never copy model URLs.
  if (source?.messageUrl && /^https:\/\/[^\s<>]+$/.test(source.messageUrl)) {
    lines.push(imText('imBot.text.shared.source.viewMessage', { url: source.messageUrl }));
  }
  return lines.join('\n');
}
