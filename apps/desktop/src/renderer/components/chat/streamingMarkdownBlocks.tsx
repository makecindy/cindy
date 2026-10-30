import { memo, useMemo } from 'react';
import ReactMarkdown, { type Components, type UrlTransform } from 'react-markdown';
import type { Element, Root } from 'hast';
import type { Plugin, PluggableList } from 'unified';

const BLOCK_TAG = 'cindy-stream-block';

interface BlockSnapshot {
  signature: string;
  tree: Root;
}

interface BlockElement extends Element {
  data: NonNullable<Element['data']> & { streamBlock: BlockSnapshot };
}

interface BlockProps extends BlockSnapshot {
  components: Components;
  urlTransform?: UrlTransform;
}

/**
 * Keep the already-committed React subtree (including active animation refs and
 * selection anchors). The signature is taken AFTER document-wide plugins but
 * BEFORE word-fade timing, so late references/slug changes invalidate it while
 * the passage of time does not.
 */
const StreamingMarkdownBlock = memo(function StreamingMarkdownBlock({
  tree,
  components,
  urlTransform,
}: BlockProps) {
  const plugins = useMemo<PluggableList>(() => [
    // ReactMarkdown's post-processing mutates URL properties. Keep the source
    // intact so a later URL policy/components change starts from original URLs.
    (() => () => structuredClone(tree)) as Plugin<[], Root>,
  ], [tree]);
  // Reuse ReactMarkdown's own HTML skipping and URL filtering, rather than
  // creating a parallel HAST-to-DOM policy for cached blocks. No source is
  // reparsed: the plugin supplies the block from the full-document parse.
  return (
    <ReactMarkdown rehypePlugins={plugins} components={components} urlTransform={urlTransform} skipHtml>
      {''}
    </ReactMarkdown>
  );
}, (previous, next) =>
  previous.signature === next.signature &&
  previous.components === next.components &&
  previous.urlTransform === next.urlTransform,
);

/** Candidate-local only; React.memo, not a mutable module cache, publishes reuse. */
export function createStreamingMarkdownBlockCache() {
  const signatures = new WeakMap<Element, string>();
  const capture: Plugin<[], Root> = () => (tree) => {
    for (const node of tree.children) {
      if (node.type === 'element') signatures.set(node, JSON.stringify(node));
    }
  };
  const wrap: Plugin<[], Root> = () => (tree) => {
    tree.children = tree.children.map((node) => {
      if (node.type !== 'element') return node;
      const signature = signatures.get(node);
      if (signature === undefined) return node;
      // Content can move when earlier Markdown changes structure. Equal prose
      // alone must not reuse a DOM tree whose logical fade identities changed.
      const keys: string[] = [];
      const collectKeys = (element: Element) => {
        const key = element.properties.dataWfKey;
        if (typeof key === 'string') keys.push(key);
        for (const child of element.children) {
          if (child.type === 'element') collectKeys(child);
        }
      };
      collectKeys(node);
      const block: BlockElement = {
        type: 'element',
        tagName: BLOCK_TAG,
        properties: {},
        children: [],
        data: { streamBlock: {
          signature: `${signature}\n${JSON.stringify(keys)}`,
          tree: { type: 'root', children: [node] },
        } },
      };
      return block;
    });
  };
  return { capture, wrap };
}

export function withStreamingMarkdownBlocks(
  components: Components,
  urlTransform?: UrlTransform,
): Components {
  const blockComponents = {
    [BLOCK_TAG]: ({ node }: { node: BlockElement }) => (
      <StreamingMarkdownBlock
        {...node.data.streamBlock}
        components={components}
        urlTransform={urlTransform}
      />
    ),
  };
  return { ...components, ...blockComponents };
}
