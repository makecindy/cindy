import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import { describe, expect, it, vi } from 'vitest';
import type { Element, Root } from 'hast';
import { unified, type Plugin } from 'unified';

const calls = vi.hoisted(() => ({ highlighted: 0 }));
vi.mock('rehype-highlight', async (importOriginal) => {
  const original = await importOriginal<typeof import('rehype-highlight')>();
  return {
    default: () => {
      const transform = original.default();
      return (...args: Parameters<typeof transform>) => {
        const visit = (node: Root | Element) => {
          if (
            node.type === 'element' &&
            node.tagName === 'code' &&
            !node.properties.className?.toString().includes('no-highlight')
          )
            calls.highlighted++;
          for (const child of node.children) if (child.type === 'element') visit(child);
        };
        visit(args[0]);
        return transform(...args);
      };
    },
  };
});

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

  // Unit: full-document streaming reparses stable code; the upstream highlighter
  // must not repeat that work, and downstream AST mutations must remain isolated.
  it('reuses stable code while keeping downstream mutations out of future documents', () => {
    const code = '```ts\nconst cachedValue = 123;\n```';
    const before = calls.highlighted;
    const mutate: Plugin<[], Root> = () => (tree) => {
      const pre = tree.children.find(
        (node) => node.type === 'element' && node.tagName === 'pre',
      ) as Element;
      (pre.children[0] as Element).children = [{ type: 'text', value: 'mutated downstream' }];
    };
    renderToStaticMarkup(
      createElement(ReactMarkdown, { rehypePlugins: [rehypeHighlightShared, mutate] }, code),
    );
    const html = render(code + '\n\nstreaming tail');
    expect(html).toContain('cachedValue');
    expect(html).not.toContain('mutated downstream');
    expect(calls.highlighted - before).toBe(1);
    expect(render('```ts\nconst cachedValue = 456;\n```')).toContain('456');
    expect(calls.highlighted - before).toBe(2);
  });

  it('preserves unknown-language diagnostics and explicit opt-outs on repeated documents', () => {
    for (let i = 0; i < 2; i++) {
      const node: Element = {
        type: 'element',
        tagName: 'code',
        properties: { className: ['language-not-a-language'] },
        children: [{ type: 'text', value: 'sample' }],
      };
      const tree: Root = {
        type: 'root',
        children: [{ type: 'element', tagName: 'pre', properties: {}, children: [node] }],
      };
      const file = unified()
        .use(function () {
          this.parser = () => tree;
          this.compiler = () => '';
        })
        .use(rehypeHighlightShared)
        .processSync('');
      expect(file.messages).toHaveLength(1);
      expect(node.children).toEqual([{ type: 'text', value: 'sample' }]);
    }
    expect(render('```no-highlight\nconst a = 1;\n```')).not.toContain('hljs-keyword');
  });

  it('does not reuse results across languages or retain oversized blocks', () => {
    const source = 'const languageSpecificValue = true;';
    expect(render('```ts\n' + source + '\n```')).toContain('hljs-keyword');
    expect(render('```plaintext\n' + source + '\n```')).not.toContain('hljs-keyword');
    const large = '```plaintext\n' + 'x'.repeat(70_000) + '\n```';
    const before = calls.highlighted;
    render(large);
    render(large);
    expect(calls.highlighted - before).toBe(2);
  });
});
