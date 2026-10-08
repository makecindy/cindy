export const MAX_MESSAGE_LEN = 2000;
export const SPLIT_THRESHOLD = 1900;

export function chunkDiscordText(text: string, limit = MAX_MESSAGE_LEN): string[] {
  if (limit <= 0) {
    throw new Error('discord chunk limit must be positive');
  }
  if (text.length <= limit) {
    return [text];
  }

  const chunks: string[] = [];
  const tokens = splitPreservingNewlines(text);
  let current = '';
  let inFence = false;
  let fenceLang = '';

  const reopenFence = () => `\`\`\`${fenceLang}\n`;
  const closeFence = () => (current.endsWith('\n') ? '```' : '\n```');

  const flush = () => {
    if (current.length === 0) return;
    const rendered = inFence ? `${current}${closeFence()}` : current;
    chunks.push(rendered);
    current = inFence ? reopenFence() : '';
  };

  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
    let token = tokens[tokenIndex];

    while (token.length > 0) {
      const nextState = stateAfterToken(token, inFence, fenceLang);
      const closeReserve = nextState.inFence ? closeFenceLengthAfter(current, token) : 0;

      if (current.length + token.length + closeReserve <= limit) {
        current += token;
        inFence = nextState.inFence;
        fenceLang = nextState.fenceLang;
        token = '';
        continue;
      }

      if (current.length > (inFence ? reopenFence().length : 0)) {
        flush();
        continue;
      }

      const reserve = inFence ? 4 : 0;
      let take = Math.max(0, limit - current.length - reserve);
      const whitespace = /\s+\S*$/u.exec(token.slice(0, take));
      if (whitespace && whitespace.index > 0) {
        take = whitespace.index + whitespace[0].length - whitespace[0].trimStart().length;
      }
      // Hard fallback is necessary for a long word/code line, but must not
      // split a UTF-16 surrogate pair (Telegram shares this splitter).
      if (
        take < token.length &&
        /[\uD800-\uDBFF]/.test(token[take - 1] ?? '') &&
        /[\uDC00-\uDFFF]/.test(token[take] ?? '')
      )
        take--;
      if (take === 0) throw new RangeError('chunk limit cannot fit a code point with its fence');
      current += token.slice(0, take);
      token = token.slice(take);
      flush();
    }
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

function splitPreservingNewlines(text: string): string[] {
  const matches = text.match(/[^\n]*\n|[^\n]+/g);
  return matches ?? [''];
}

function stateAfterToken(
  token: string,
  inFence: boolean,
  fenceLang: string,
): { inFence: boolean; fenceLang: string } {
  const fence = token.match(/^```([^`\n]*)\n?$/);
  if (!fence) {
    return { inFence, fenceLang };
  }

  if (inFence) {
    return { inFence: false, fenceLang: '' };
  }

  return { inFence: true, fenceLang: fence[1] ?? '' };
}

function closeFenceLengthAfter(current: string, token: string): number {
  return `${current}${token}`.endsWith('\n') ? 3 : 4;
}
