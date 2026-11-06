import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { PluginUiBlock } from '@cindy/maker-shared';

/** Read-only Markdown uses the existing parser; markup cannot acquire file,
 * network, navigation or executable privileges. Managed media has its own block. */
export function PluginUiBlocks({ blocks, fallback }: { blocks: PluginUiBlock[]; fallback?: string }) {
  if (!blocks.length && !fallback) return null;
  return <div className="w-full min-w-0 break-words text-13 text-[var(--text-secondary)]">
    {(blocks.length ? blocks.map(b => ({ id: b.id, text: b.text })) : fallback ? [{ id: 'fallback', text: fallback }] : []).map(block =>
      <ReactMarkdown key={block.id} remarkPlugins={[remarkGfm]} skipHtml
        components={{ a: ({ children }) => <span>{children}</span>, img: ({ alt }) => <span>{alt}</span> }}>{block.text}</ReactMarkdown>)}
  </div>;
}
