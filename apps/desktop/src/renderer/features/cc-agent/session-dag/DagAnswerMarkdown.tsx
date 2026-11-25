import { memo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkCjkFriendly from 'remark-cjk-friendly';
import remarkGfm from 'remark-gfm';
import './dagAnswer.css';

// The canvas is a passive reader: use the chat parser, not its media players,
// file previews or session actions. Real user-activated links go through the
// main window's existing window-open policy, never navigate the renderer.
const plugins = [remarkCjkFriendly, remarkGfm];
const components: Components = {
  a: ({ href, children, title }) => {
    if (!href || !URL.canParse(href) || !['https:', 'http:'].includes(new URL(href).protocol)) {
      return <span>{children}</span>;
    }
    return <a href={href} title={title} target="_blank" rel="noopener noreferrer" draggable={false}>{children}</a>;
  },
  img: ({ alt }) => <span>{alt || '图片'}</span>,
  table: ({ children }) => <div className="max-w-full overflow-x-auto"><table>{children}</table></div>,
};

export const DagAnswerMarkdown = memo(function DagAnswerMarkdown({ answer }: { answer: string }) {
  return (
    <div data-dag-answer className="dag-answer min-w-0 shrink-0 cursor-text select-text">
      <ReactMarkdown skipHtml remarkPlugins={plugins} components={components}>{answer}</ReactMarkdown>
    </div>
  );
});
