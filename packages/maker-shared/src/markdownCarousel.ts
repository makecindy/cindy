/**
 * markdownCarousel — shared parser for ````carousel fenced blocks.
 *
 * Slides inside a `carousel` fence are separated by standalone `<!-- slide -->`
 * HTML comment lines. Nested fenced code blocks (e.g. a ```html block inside a
 * 4-backtick ````carousel) are tracked so a literal `<!-- slide -->` example
 * inside code never splits the outer carousel.
 */

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const SLIDE_SEPARATOR_RE = /^\s*<!--\s*slide\s*-->\s*$/i;

function isFenceClose(line: string, fenceChar: string, fenceLen: number): boolean {
  let i = 0;
  let spaces = 0;
  while (i < line.length && line[i] === ' ' && spaces < 3) {
    i += 1;
    spaces += 1;
  }
  let run = 0;
  while (i < line.length && line[i] === fenceChar) {
    i += 1;
    run += 1;
  }
  if (run < fenceLen) return false;
  while (i < line.length) {
    const ch = line[i];
    if (ch !== ' ' && ch !== '\t') return false;
    i += 1;
  }
  return true;
}

/** True when a fenced code block's info string names the `carousel` language. */
export function isCarouselFenceLanguage(lang: string | undefined | null): boolean {
  if (!lang) return false;
  const trimmed = lang.trim();
  if (!trimmed) return false;
  const firstToken = trimmed.split(/\s+/, 1)[0];
  return firstToken.toLowerCase() === 'carousel';
}

/**
 * Split the raw body of a ````carousel block into non-empty slide markdown
 * strings, respecting nested fenced code blocks.
 */
export function splitCarouselSlides(raw: string): string[] {
  if (!raw) return [];
  const normalized = raw.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const slides: string[] = [];
  let current: string[] = [];
  let activeFence: { char: string; len: number } | null = null;

  const flush = () => {
    const joined = current.join('\n').trim();
    if (joined) slides.push(joined);
    current = [];
  };

  for (const line of lines) {
    if (activeFence) {
      current.push(line);
      if (isFenceClose(line, activeFence.char, activeFence.len)) {
        activeFence = null;
      }
      continue;
    }

    if (SLIDE_SEPARATOR_RE.test(line)) {
      flush();
      continue;
    }

    const fence = FENCE_OPEN_RE.exec(line);
    if (fence) {
      const marker = fence[1];
      const info = fence[2] ?? '';
      // Per CommonMark, backtick fence info strings cannot contain backticks.
      if (marker[0] !== '`' || !info.includes('`')) {
        activeFence = { char: marker[0], len: marker.length };
      }
    }
    current.push(line);
  }

  flush();
  return slides;
}
