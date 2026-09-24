import { Lexer, type Tokens, type Token } from 'marked';

/** Parse Markdown before shortening it: punctuation in ordinary text/code is content. */
export function notificationPlainText(markdown: string): string {
  const render = (tokens: Token[]): string => tokens.map((token): string => {
    switch (token.type) {
      case 'space': case 'br': return ' ';
      case 'html': case 'image': case 'def': case 'hr': return '';
      case 'code': case 'codespan': return token.text;
      case 'list': return (token as Tokens.List).items.map((item) => render(item.tokens)).join(' ');
      case 'table': return [(token as Tokens.Table).header, ...(token as Tokens.Table).rows]
        .map((row) => row.map((cell) => render(cell.tokens)).join(' ')).join(' ');
      default: {
        const value = token as Token & { tokens?: Token[]; text?: string };
        const text = value.tokens ? render(value.tokens) : (value.text ?? '');
        return ['paragraph', 'heading', 'blockquote', 'list_item'].includes(token.type)
          ? ` ${text} ` : text;
      }
    }
  }).join('');
  return render(Lexer.lex(markdown)).replace(/\s+/gu, ' ').trim();
}

export function notificationPreview(markdown: string, limit = 240): string {
  // The notify protocol measures JS string length (UTF-16), not code points.
  let preview = '';
  for (const character of notificationPlainText(markdown)) {
    if (preview.length + character.length > limit) break;
    preview += character;
  }
  return preview;
}
