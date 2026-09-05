/**
 * markdownFloatingToolbar.test.ts
 * ---------------------------------------------------------------------------
 * Structural regression guard for Markdown block toolbars. The toolbar must
 * use a full-height sticky row overlapped by the block content so long messages
 * keep their existing copy / image actions visible without crossing the block.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const componentPaths = {
  code: resolve(__dirname, '..', 'components', 'chat', 'MarkdownRenderer.tsx'),
  copyableBlock: resolve(__dirname, '..', 'components', 'chat', 'CopyAsImageBlock.tsx'),
  mermaid: resolve(__dirname, '..', 'components', 'chat', 'MarkdownMermaidBlock.tsx'),
} as const;

const sources = Object.fromEntries(
  Object.entries(componentPaths).map(([name, path]) => [name, readFileSync(path, 'utf8')]),
) as Record<keyof typeof componentPaths, string>;

describe('Markdown block floating toolbars', () => {
  it.each(Object.entries(sources))(
    '%s uses a sticky, layout-neutral toolbar row',
    (_name, source) => {
      expect(source).toContain('sticky top-0 z-10 flex h-9 items-end');
      expect(source).toContain('-mt-9');
      expect(source).not.toContain('-mb-9');
      expect(source).toContain('group-hover:opacity-100 focus-within:opacity-100');
      expect(source).toContain('pointer-events-auto');
      expect(source).not.toContain('absolute right-2 top-2');
    },
  );

  it('places the toolbar before the code block content', () => {
    const source = sources.code;
    expect(source.indexOf('pointer-events-none sticky top-0')).toBeLessThan(
      source.indexOf('ref={preRef}'),
    );
    expect(source).toContain('<div className="-mt-9">');
    expect(source).not.toContain("'-mt-9 rounded-[12px]'");
  });

  it('keeps the copy-as-image toolbar outside its horizontal overflow node', () => {
    const source = sources.copyableBlock;
    expect(source).toContain("cn('group relative flex flex-col', className)");
    expect(source).toContain('<div className="-mt-9">');
    expect(source).toContain('ref={contentRef} className={contentClassName}');
    expect(source).not.toContain("cn('-mt-9', contentClassName)");
    expect(source).toContain('pointer-events-none order-first sticky top-0');
  });

  it('orders the Mermaid toolbar before the rendered diagram or source view', () => {
    const source = sources.mermaid;
    expect(source).toContain('group relative my-3 flex flex-col');
    expect(source).toContain('pointer-events-none order-first sticky top-0');
    expect(source.match(/<div className="-mt-9">/g)).toHaveLength(1);
  });
});
