import { memo, useLayoutEffect, useMemo } from 'react';
import ReactMarkdown, { type Components, type UrlTransform } from 'react-markdown';
import type { Element, Root } from 'hast';
import type { Plugin, PluggableList } from 'unified';

import {
  commitWordFadeCandidate,
  createWordFadeCandidate,
  createWholeDocumentWordFadeCandidate,
  getOrCreateWordFadeSourceState,
  rehypeStreamWordFade,
  retainOnlyWordFadeSourceState,
  type WordFadeState,
} from './rehypeStreamWordFade';
import { StreamFadeListItem, StreamFadeSpan } from './StreamFadeSpan';
import { createStreamingMarkdownBlockCache, withStreamingMarkdownBlocks } from './streamingMarkdownBlocks';

interface StreamingMarkdownChunkProps {
  sourceKey: string;
  content: string;
  remarkPlugins: PluggableList;
  rehypePlugins: PluggableList;
  components: Components;
  urlTransform?: UrlTransform;
  wordFadeState: WordFadeState | null;
  emitSourceLines: boolean;
  wholeDocument?: boolean;
  /** 前序分片的标题文本（JSON 数组），见 StreamingMarkdownChunk.headingSeed。 */
  headingSeed?: string;
}

const HEADING_SEED = 'cindyHeadingSeed';

/**
 * 在分片 hast 开头插入前序标题的占位 h1，让紧随其后的 rehype-slug 用同一个
 * slugger 先为它们计数：本分片的标题 id 因而与整篇解析的去重结果一致。
 * 占位节点在全部 rehype 插件之后、淡入与块缓存之前移除，不进入 DOM。
 */
function rehypeSeedHeadingSlugs(texts: readonly string[]): Plugin<[], Root> {
  return () => (tree) => {
    tree.children.unshift(
      ...texts.map((text): Element => ({
        type: 'element',
        tagName: 'h1',
        properties: {},
        data: { [HEADING_SEED]: true } as Element['data'],
        children: [{ type: 'text', value: text }],
      })),
    );
  };
}

const rehypeRemoveHeadingSeeds: Plugin<[], Root> = () => (tree) => {
  tree.children = tree.children.filter(
    (node) =>
      !(node.type === 'element' && (node.data as Record<string, unknown> | undefined)?.[HEADING_SEED]),
  );
};

function sourceLineAttr(node?: Element): { 'data-source-line'?: number } {
  const line = node?.position?.start.line;
  return typeof line === 'number' ? { 'data-source-line': line } : {};
}

/**
 * 单个流式 Markdown 分片。React.memo 让内容不再变化的前缀保留解析结果和 DOM，
 * 只有最后一个增长分片会随 token 到达重新进入 Markdown 处理链。
 */
export const StreamingMarkdownChunk = memo(function StreamingMarkdownChunk({
  sourceKey,
  content,
  remarkPlugins,
  rehypePlugins,
  components,
  urlTransform,
  wordFadeState,
  emitSourceLines,
  wholeDocument = false,
  headingSeed,
}: StreamingMarkdownChunkProps) {
  const seededRehypePlugins = useMemo<PluggableList>(() => {
    if (!headingSeed) return rehypePlugins;
    const texts = JSON.parse(headingSeed) as string[];
    return [rehypeSeedHeadingSlugs(texts), ...rehypePlugins, rehypeRemoveHeadingSeeds];
  }, [headingSeed, rehypePlugins]);
  const sourceWordFadeState = useMemo(
    () =>
      wordFadeState ? getOrCreateWordFadeSourceState(wordFadeState, sourceKey) : null,
    [sourceKey, wordFadeState],
  );
  const wordFade = useMemo(() => {
    if (!sourceWordFadeState) return null;
    const candidate =
      wholeDocument && wordFadeState
        ? createWholeDocumentWordFadeCandidate(wordFadeState, sourceWordFadeState)
        : createWordFadeCandidate(sourceWordFadeState);
    const blocks = createStreamingMarkdownBlockCache();
    return {
      candidate,
      plugins: [
        ...seededRehypePlugins,
        blocks.capture,
        [rehypeStreamWordFade, candidate],
        blocks.wrap,
      ] as PluggableList,
    };
  }, [content, seededRehypePlugins, sourceWordFadeState, wholeDocument, wordFadeState]);

  useLayoutEffect(() => {
    if (sourceWordFadeState && wordFade) {
      commitWordFadeCandidate(sourceWordFadeState, wordFade.candidate);
      if (wholeDocument && wordFadeState) {
        retainOnlyWordFadeSourceState(wordFadeState, sourceKey);
      }
    }
  }, [sourceKey, sourceWordFadeState, wholeDocument, wordFade, wordFadeState]);

  const chunkComponents = useMemo<Components>(() => {
    if (!sourceWordFadeState) return components;
    return {
      ...components,
      span: (props) => (
        <StreamFadeSpan {...props} wordFadeState={sourceWordFadeState} />
      ),
      li: ({ node, ...props }) => (
        <StreamFadeListItem
          {...props}
          {...(emitSourceLines ? sourceLineAttr(node) : {})}
          node={node}
          wordFadeState={sourceWordFadeState}
        />
      ),
    };
  }, [components, emitSourceLines, sourceWordFadeState]);

  const cachedComponents = useMemo(
    () => sourceWordFadeState ? withStreamingMarkdownBlocks(chunkComponents, urlTransform) : chunkComponents,
    [chunkComponents, sourceWordFadeState, urlTransform],
  );

  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={wordFade?.plugins ?? seededRehypePlugins}
      components={cachedComponents}
      urlTransform={urlTransform}
      skipHtml
    >
      {content}
    </ReactMarkdown>
  );
});
