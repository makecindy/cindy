import { Lexer, type Token, type Tokens } from 'marked';

/** Parse unfinished Markdown as prose, keeping incomplete inline constructs out
 * of speech. The same projection is used at completion so closing a code fence
 * or link cannot make already queued text appear twice.
 */
export function streamingSpeechText(markdown: string, complete: boolean): string {
  let held = false;
  const prose = (tokens: readonly Token[]): string =>
    tokens
      .map((token): string => {
        if (held) return '';
        switch (token.type) {
          case 'code':
          case 'image':
          case 'html':
          case 'def':
            return '';
          case 'space':
          case 'br':
          case 'hr':
            return '\n';
          case 'list':
            return (token as Tokens.List).items.map((item) => prose(item.tokens)).join('\n');
          case 'table':
            return [(token as Tokens.Table).header, ...(token as Tokens.Table).rows]
              .map((row) => row.map((cell) => prose(cell.tokens)).join(' '))
              .join('\n');
          case 'link':
            if (/^https?:\/\//.test(token.text)) return '';
            return prose(token.tokens ?? []);
          default: {
            if ('tokens' in token && token.tokens) {
              const text = prose(token.tokens);
              return ['paragraph', 'heading', 'blockquote'].includes(token.type)
                ? `${text}\n`
                : text;
            }
            let text = 'text' in token ? token.text : '';
            if (!complete && token.type === 'text') {
              // Closed links/code are separate lexer tokens. A remaining opener may
              // acquire a destination or fence later; do not read its temporary text.
              const opener = /(?<!\\)[[<`]/.exec(text);
              if (opener) {
                text = text.slice(0, opener.index).replace(/!$/, '');
                held = true;
              }
            }
            return text;
          }
        }
      })
      .join('');
  return prose(Lexer.lex(markdown))
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Choose a stable sentence prefix. Latin periods need following whitespace so
 * decimals/URLs split across deltas do not become premature sentence endings.
 * A long unpunctuated sentence can use a word/clause boundary, never half a word.
 */
export function completeSpeechPrefix(text: string): string {
  let end = 0;
  const punctuation = /[。！？!?]+[”’"'）)】]*|\.+[”’"'）)】]*(?=\s)/g;
  for (const match of text.matchAll(punctuation)) {
    const before = text.slice(0, match.index);
    if (
      match[0].startsWith('.') &&
      /(?:\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc)|\b[A-Z]|e\.g|i\.e)$/i.test(before)
    )
      continue;
    end = match.index + match[0].length;
  }
  if (!end && text.length > 500) {
    const prefix = text.slice(0, 500);
    end = Math.max(
      prefix.lastIndexOf(' '),
      prefix.lastIndexOf('，') + 1,
      prefix.lastIndexOf('、') + 1,
    );
  }
  return end > 0 ? text.slice(0, end) : '';
}
