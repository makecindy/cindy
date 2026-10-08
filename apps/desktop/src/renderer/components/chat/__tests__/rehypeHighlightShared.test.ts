import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import { describe, expect, it } from 'vitest';

import { rehypeHighlightShared } from '../rehypeHighlightShared';

const render = (markdown: string) =>
  renderToStaticMarkup(
    createElement(ReactMarkdown, { rehypePlugins: [rehypeHighlightShared] }, markdown),
  );

describe('rehypeHighlightShared', () => {
  it('reuses one transformer (one lowlight registry) for every processor', () => {
    expect(rehypeHighlightShared()).toBe(rehypeHighlightShared());
  });

  it('keeps highlighting each render, including unknown languages', () => {
    expect(render('```ts\nconst a = 1;\n```')).toContain('hljs-keyword');
    expect(render('```python\ndef f():\n    return 1\n```')).toContain('hljs-keyword');
    expect(render('```unknown-lang\nx\n```')).toContain(
      '<pre><code class="hljs language-unknown-lang">x',
    );
  });
});
