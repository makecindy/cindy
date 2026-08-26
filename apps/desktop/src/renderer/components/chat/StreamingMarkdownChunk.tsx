import { memo, useLayoutEffect, useMemo } from 'react';
import ReactMarkdown, { type Components, type UrlTransform } from 'react-markdown';
import type { Element } from 'hast';
import type { PluggableList } from 'unified';

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
}

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
}: StreamingMarkdownChunkProps) {
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
    return {
      candidate,
      plugins: [...rehypePlugins, [rehypeStreamWordFade, candidate]] as PluggableList,
    };
  }, [content, rehypePlugins, sourceWordFadeState, wholeDocument, wordFadeState]);

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

  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={wordFade?.plugins ?? rehypePlugins}
      components={chunkComponents}
      urlTransform={urlTransform}
      skipHtml
    >
      {content}
    </ReactMarkdown>
  );
});
