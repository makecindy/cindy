import { redactSensitiveText } from '@cindy/maker-shared/error-redaction';
import type { TFunction } from 'i18next';
import { activateMessageUrl } from './messageLinkActions';
import { findLinkifyMatches } from './userMessageLinkify';
import { providerErrorExplanation } from '@/utils/streamInterruptError';

export function renderProviderErrorExplanation(error: string, summary: string, t: TFunction) {
  const message = providerErrorExplanation(error);
  if (!message) return null;
  const text = redactSensitiveText(message).replace(/(https?:\/\/)[^/\s?#]+@/gi, '$1[REDACTED]@');
  if (text === summary) return null;

  const parts = [];
  let cursor = 0;
  for (const match of findLinkifyMatches(text)) {
    if (match.kind !== 'url' || !URL.canParse(match.text)) continue;
    const url = new URL(match.text);
    if (url.username || url.password || match.text.includes('[REDACTED')) continue;
    parts.push(text.slice(cursor, match.index),
      <a key={match.index} className="break-all underline" href={url.href}
        target="_blank" rel="noopener noreferrer"
        onClick={(event) => void activateMessageUrl(event, undefined, url.href, t)}>{match.text}</a>);
    cursor = match.index + match.length;
  }
  return <span className="whitespace-pre-wrap">{parts}{text.slice(cursor)}</span>;
}
