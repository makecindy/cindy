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
    `来源：${excerpt(event.channelName, 40)} · ${excerpt(source?.chatName ?? event.chatId, 100)}`,
    ...(source?.threadName ? [`话题：${excerpt(source.threadName, 80)}`] : []),
    ...(source?.senderName || event.speaker?.name
      ? [`发起人：${excerpt(source?.senderName ?? event.speaker?.name, 80)}`]
      : []),
    event.protectedContent
      ? '原消息：受保护内容'
      : `原消息：${excerpt(event.text, 200) || '（无文字内容）'}`,
  ];
  // Only transport-produced HTTP links may appear here; never copy model URLs.
  if (source?.messageUrl && /^https:\/\/[^\s<>]+$/.test(source.messageUrl)) {
    lines.push(`查看原消息：${source.messageUrl}`);
  }
  return lines.join('\n');
}
